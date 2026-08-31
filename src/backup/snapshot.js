/**
 * Timeshift integration — weekly system snapshots that are ALSO shipped into
 * the cloud pool, so a dead SSD can never take the recovery ability with it.
 *
 * Snapshot pruning is the "remove both at the same time" guarantee: snapshots
 * beyond `keep` are deleted from local disk (timeshift --delete) and from the
 * cloud pool in the same pass.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execa } from 'execa';
import { loadConfig, loadState, saveState, journal, hasCommandSync } from '../core/store.js';
import { timeshiftDir } from '../core/paths.js';
import { iso, clock } from '../core/time.js';
import { refreshAccounts } from '../storage/accounts.js';
import { planAndPlace } from '../storage/allocator.js';
import { listArtifacts, removeArtifact } from '../storage/archive.js';
import { planPrune } from './retention.js';
import { sudoInteractive, sudoNonInteractive, sudoInteractiveCapture } from '../util/sudo.js';

export class SudoDeferredError extends Error {
  constructor() {
    super('sudo authentication required — run `parrot-blackbox snapshot now` once to re-arm the sudo timestamp');
  }
}

/**
 * Parse `timeshift --list` output into snapshots.
 * @returns {Array<{name:string, date:string, time:string, tags:string, dir:?string}>}
 */
export function parseTimeshiftList(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    const m = /^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([A-Z])\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (!m) continue;
    const [, date, time, tags, dirOrSize, detail] = m;
    const name = `${date}_${time.replace(/:/g, '-')}`;
    const dir = findPathInLine(line);
    out.push({ name, date, time, tags, dir, line: `${date} ${time} ${tags} ${dirOrSize}${detail ? ` ${detail}` : ''}` });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Extract the snapshot directory path from a list line if present. */
function findPathInLine(line) {
  const dirs = line.match(/\/[^\s]+\/[A-Za-z0-9._-]+/g) || [];
  return dirs.find((d) => /snapshots|timeshift/i.test(d)) ||
    dirs.find((d) => /\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}/.test(d)) ||
    null;
}

/**
 * `timeshift --list` needs admin on most installs — run it with sudo.
 * Interactive: capture stdout while keeping stdin (so the sudo password
 * prompt works). Non-interactive: `sudo -n`, falling back to a direct call
 * for the few builds that allow unprivileged listing.
 */
async function runTimeshiftList({ privileged = 'noninteractive' } = {}) {
  if (privileged === 'interactive') {
    try {
      const res = await sudoInteractiveCapture(['timeshift', '--list']);
      return (res.exitCode === 0 ? res.stdout : res.stdout || res.stderr) || '';
    } catch {
      return '';
    }
  }
  try {
    const res = await sudoNonInteractive(['timeshift', '--list']);
    if (res.exitCode === 0) return res.stdout || '';
    const direct = await execa('timeshift', ['--list'], { reject: false });
    return (direct.exitCode === 0 ? direct.stdout : direct.stdout || direct.stderr) || '';
  } catch {
    return '';
  }
}

export async function listLocalSnapshots({ privileged = 'noninteractive' } = {}) {
  const text = await runTimeshiftList({ privileged });
  return parseTimeshiftList(text);
}

/** Create a snapshot; returns the created snapshot record. */
export async function createSnapshot({ comment, privileged = 'noninteractive' } = {}) {
  const before = new Set((await listLocalSnapshots({ privileged })).map((s) => s.name));
  const args = ['timeshift', '--create', '--comments', comment || 'parrot-blackbox', '--tags', 'W'];

  if (privileged === 'interactive') {
    const res = await sudoInteractive(args);
    if (res.exitCode !== 0) throw new Error(`timeshift --create failed (exit ${res.exitCode})`);
  } else {
    const res = await sudoNonInteractive(args);
    if (res.exitCode !== 0) {
      if (/password|authentication|sudo/i.test(res.stderr || '')) throw new SudoDeferredError();
      throw new Error(`timeshift --create failed (exit ${res.exitCode}): ${res.stderr?.trim()}`);
    }
  }

  // Find which snapshot appeared.
  const after = await listLocalSnapshots({ privileged });
  const created = after.find((s) => !before.has(s.name)) || after[after.length - 1];
  if (!created) throw new Error('timeshift reported success but no snapshot was found');
  return created;
}

/** Delete a single snapshot from local disk. */
export async function deleteSnapshot(name, { privileged = 'noninteractive' } = {}) {
  const args = ['timeshift', '--delete', '--snapshot', name];
  if (privileged === 'interactive') {
    const res = await sudoInteractive(args);
    if (res.exitCode !== 0) throw new Error(`timeshift --delete ${name} failed (exit ${res.exitCode})`);
    return true;
  }
  const res = await sudoNonInteractive(args);
  if (res.exitCode !== 0) {
    if (/password|authentication|sudo/i.test(res.stderr || '')) throw new SudoDeferredError();
    throw new Error(`timeshift --delete ${name} failed (exit ${res.exitCode})`);
  }
  return true;
}
/** Resolve the on-disk directory of a snapshot. */
export function snapshotDirFor(snapshot, { privileged = 'noninteractive' } = {}) {
  if (snapshot.dir && fs.existsSync(snapshot.dir)) return snapshot.dir;
  const base = timeshiftDir();
  const candidates = [
    path.join(base, 'snapshots', snapshot.name),
    path.join(base, snapshot.name),
  ];
  return candidates.find((c) => fs.existsSync(c)) || candidates[0];
}

/**
 * Run one snapshot generation: create → upload to the pool → prune old ones
 * BOTH locally and in the cloud.
 * Assumes the caller holds the scheduler lock.
 */
export async function runSnapshotBackup(cfg, state, { due, privileged = 'noninteractive', onProgress } = {}) {
  journal('snapshots', `start due=${due} privileged=${privileged}`);
  const accounts = await refreshAccounts(cfg);

  const created = await createSnapshot({ comment: `parrot-blackbox ${due}`, privileged });
  const dir = snapshotDirFor(created, { privileged });

  let manifest;
  try {
    manifest = await planAndPlace(dir, {
      kind: 'snapshots',
      id: created.name,
      accounts,
      remoteRoot: cfg.storage.remoteRoot,
      chunkSize: cfg.storage.chunkSize,
      onProgress,
    });
  } catch (e) {
    // The local snapshot exists and is safe; the cloud upload failed.
    journal('snapshots', `upload failed for ${created.name}: ${e.message}`, 'error');
    throw e;
  }
  manifest.due = due;
  manifest.snapshot = created.name;

  // Prune OLD snapshots — local + cloud in the same pass.
  const pruned = await pruneSnapshots(cfg, accounts, { privileged });

  const j = state.jobs.snapshots;
  j.lastCompletedDue = due;
  j.lastRunAt = iso(clock());
  j.lastStatus = 'ok';
  j.lastError = null;
  j.pending = (j.pending || []).filter((d) => d !== due);
  j.completed = [...(j.completed || []), { due, at: iso(clock()) }].slice(-(cfg.jobs.snapshots.keep * 2));
  state.manifests[`snapshots-${created.name}`] = {
    kind: 'snapshots',
    id: created.name,
    due,
    createdAt: manifest.createdAt,
    totalSize: manifest.totalSize,
  };
  saveState(state);
  journal('snapshots', `done due=${due} snapshot=${created.name} bytes=${manifest.totalSize}`);

  return { due, snapshot: created.name, manifest, pruned };
}

/**
 * Enforce the snapshot retention limit across local disk AND cloud.
 * Returns the list of snapshot names pruned.
 */
export async function pruneSnapshots(cfg, accounts, { privileged = 'noninteractive' } = {}) {
  const local = await listLocalSnapshots({ privileged }).catch(() => []);
  const cloud = await listArtifacts('snapshots', accounts, cfg.storage.remoteRoot);

  const localNames = local.map((s) => s.name);
  const cloudNames = cloud.map((c) => c.id);
  const union = [...new Set([...localNames, ...cloudNames])];

  const { prune } = planPrune(union, cfg.jobs.snapshots.keep);
  const pruned = [];
  for (const name of prune) {
    // Cloud first, then local — if one fails the other still gets cleaned.
    try {
      await removeArtifact('snapshots', name, accounts, cfg.storage.remoteRoot);
      journal('snapshots', `pruned cloud=${name}`, 'warn');
    } catch (e) {
      journal('snapshots', `cloud prune failed for ${name}: ${e.message}`, 'error');
    }
    if (localNames.includes(name)) {
      try {
        await deleteSnapshot(name, { privileged });
        journal('snapshots', `pruned local=${name}`, 'warn');
      } catch (e) {
        if (e instanceof SudoDeferredError) throw e;
        journal('snapshots', `local prune failed for ${name}: ${e.message}`, 'error');
      }
    }
    pruned.push(name);
  }
  return pruned;
}

/** Manual `snapshot now` — works with an interactive sudo prompt. */
export async function runSnapshotNow(cfg = loadConfig(), state = loadState(), opts = {}) {
  const due = iso(clock());
  return runSnapshotBackup(cfg, state, { due, privileged: 'interactive', ...opts });
}

export function timeshiftAvailable() {
  return hasCommandSync('timeshift');
}