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
import { execa, execaSync } from 'execa';
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
 * Parse `timeshift --list` output into snapshots. Tolerant of multiple formats:
 *
 * Old format (Timeshift 22.x/23.x):
 *   2026-08-29 22:00:01 W 2026-08-29_22-00-01 /timeshift/snapshots/...
 *
 * Table format with header (Timeshift 24.x):
 *   Num     Name                            Tags                Description
 *   0   2026-08-29 22:00:01  W  2026-08-29_22-00-01  parrot-blackbox
 *
 * Current format (Timeshift 24.06+):
 *   Num     Name                 Tags  Description
 *   0    >  2026-09-01_21-22-39  W     parrot-blackbox 2026-09-01T21:22:05
 *
 * @returns {Array<{name:string, date:string, time:string, tags:string, dir:?string}>}
 */
export function parseTimeshiftList(stdout) {
  const out = [];
  for (const line of String(stdout).split('\n')) {
    // Try current format first: Num > NAME Tags Description
    // The NAME field is in YYYY-MM-DD_HH-MM-SS format
    let m = /^\s*\d+\s+>?\s+(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\s+([A-Za-z]{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const [, name, tags, description] = m;
      // Extract date and time from the name (YYYY-MM-DD_HH-MM-SS)
      const date = name.slice(0, 10);  // YYYY-MM-DD
      const time = name.slice(11).replace(/-/g, ':');  // HH:MM:SS
      const dir = findPathInLine(line);
      out.push({ name, date, time, tags, dir, line: `${name} ${tags} ${description}` });
      continue;
    }

    // Try older format: [Num] DATE TIME TAGS NAME [description]
    m = /^\s*(?:\d+\s+)?(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2})\s+([A-Za-z]{1,6})\s+(\S+)(?:\s+(.*))?$/.exec(line);
    if (m) {
      const [, date, time, tags, dirOrName, detail] = m;
      // Prefer the explicit dir-ish token (name contains _HH-MM-SS) over a rebuilt name.
      const name = /^[\w.-]+\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}$/.test(dirOrName)
        ? dirOrName
        : `${date}_${time.replace(/:/g, '-')}`;
      const dir = findPathInLine(line);
      out.push({ name, date, time, tags, dir, line: `${date} ${time} ${tags} ${dirOrName}${detail ? ` ${detail}` : ''}` });
      continue;
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** Extract a created snapshot name from `timeshift --create` output. */
export function extractCreatedName(output) {
  const m = /Created new snapshot[:\s]+([\w.\-]+)/i.exec(String(output || ''));
  return m ? m[1] : null;
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

  let createOut = '';
  if (privileged === 'interactive') {
    const res = await sudoInteractiveCapture(args);
    if (res.exitCode !== 0) throw new Error(`timeshift --create failed (exit ${res.exitCode})`);
    createOut = `${res.stdout || ''} ${res.stderr || ''}`;
  } else {
    const res = await sudoNonInteractive(args);
    if (res.exitCode !== 0) {
      if (/password|authentication|sudo/i.test(res.stderr || '')) throw new SudoDeferredError();
      throw new Error(`timeshift --create failed (exit ${res.exitCode}): ${res.stderr?.trim()}`);
    }
    createOut = `${res.stdout || ''} ${res.stderr || ''}`;
  }

  // Primary: read the exact name from timeshift's own output
  // ("Created new snapshot: 2026-08-31_16-00-01") — the most reliable signal.
  const createdName = extractCreatedName(createOut);
  if (createdName) {
    return { name: createdName, date: createdName.slice(0, 10), time: createdName.slice(11).replace(/-/g, ':'), tags: 'W', dir: null, line: createOut.trim() };
  }

  // Fallback: diff the list before/after.
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
/**
 * Resolve the on-disk directory of a snapshot.
 * 
 * BTRFS mode stores snapshots as subvolumes on the BTRFS partition. Timeshift mounts
 * the root subvolume (subvolid=5) temporarily to /run/timeshift/NNNN/backup when needed.
 * 
 * Strategy:
 * 1. Check if already have a valid dir
 * 2. Check static paths (rsync mode)
 * 3. Mount the BTRFS root subvolume ourselves to access snapshots persistently
 * 4. Fall back to triggering timeshift --list
 */
export function snapshotDirFor(snapshot, { privileged = 'noninteractive' } = {}) {
  if (snapshot.dir && fs.existsSync(snapshot.dir)) return snapshot.dir;
  const base = timeshiftDir();
  const candidates = [
    path.join(base, 'snapshots', snapshot.name),
    path.join(base, snapshot.name),
    `/run/timeshift/backup/${snapshot.name}`,
    `/run/timeshift/backup/timeshift-btrfs/snapshots/${snapshot.name}`,
    `/run/timeshift/backup/@/timeshift-btrfs/snapshots/${snapshot.name}`,
  ];
  const direct = candidates.find((c) => fs.existsSync(c));
  if (direct) return direct;

  // BTRFS mode: Mount the root subvolume to access snapshots
  // Find the BTRFS device (usually the root filesystem)
  try {
    const mountPoint = `/run/parrot-blackbox-btrfs-${Date.now()}`;
    
    // Get the device that contains the root filesystem
    const deviceResult = execaSync('findmnt', ['-n', '-o', 'SOURCE', '/'], { reject: false });
    const device = deviceResult.stdout.trim().split('[')[0];
    
    if (device && deviceResult.exitCode === 0) {
      // Create temporary mount point
      const mkdirCmd = privileged === 'interactive' ? ['sudo', 'mkdir', '-p', mountPoint] : ['sudo', '-n', 'mkdir', '-p', mountPoint];
      execaSync(mkdirCmd[0], mkdirCmd.slice(1), { reject: false });
      
      // Mount BTRFS root subvolume (subvolid=5 contains all subvolumes including snapshots)
      const mountCmd = privileged === 'interactive' 
        ? ['sudo', 'mount', '-o', 'subvolid=5', device, mountPoint]
        : ['sudo', '-n', 'mount', '-o', 'subvolid=5', device, mountPoint];
      
      const mountResult = execaSync(mountCmd[0], mountCmd.slice(1), { reject: false, timeout: 5000 });
      
      if (mountResult.exitCode === 0) {
        // Search for the snapshot in the mounted root subvolume
        const searchPaths = [
          `${mountPoint}/timeshift-btrfs/snapshots/${snapshot.name}`,
          `${mountPoint}/@/timeshift-btrfs/snapshots/${snapshot.name}`,
          `${mountPoint}/@timeshift/snapshots/${snapshot.name}`,
        ];
        
        const found = searchPaths.find((p) => fs.existsSync(p));
        
        if (found) {
          // Store the mount point for cleanup later
          snapshot._tempMount = mountPoint;
          return found;
        }
        
        // Unmount if we didn't find anything
        const umountCmd = privileged === 'interactive' ? ['sudo', 'umount', mountPoint] : ['sudo', '-n', 'umount', mountPoint];
        execaSync(umountCmd[0], umountCmd.slice(1), { reject: false });
        execaSync('sudo', ['-n', 'rmdir', mountPoint], { reject: false });
      }
    }
  } catch {
    /* fall through */
  }
  
  // Last resort: return the most likely path (will fail with ENOENT if it doesn't exist)
  return candidates[0];
}

/** Cleanup temporary BTRFS mount if one was created */
export function cleanupSnapshotMount(snapshot) {
  if (snapshot._tempMount) {
    try {
      execaSync('sudo', ['-n', 'umount', snapshot._tempMount], { reject: false });
      execaSync('sudo', ['-n', 'rmdir', snapshot._tempMount], { reject: false });
      delete snapshot._tempMount;
    } catch {
      /* best effort */
    }
  }
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
    const bin = process.argv[1] || 'parrot-blackbox';
    const outPath = path.join(process.env.PBB_STATE_DIR || '/tmp', `manifest-${created.name}.json`);
    const baseArgs = [process.execPath, bin, '_internal_upload', dir, 'snapshots', created.name, cfg.storage.remoteRoot, String(cfg.storage.chunkSize), outPath];
    const args = process.env.PBB_SUDO_DIRECT === '1' ? baseArgs : ['-E', ...baseArgs];
    
    let res;
    if (privileged === 'interactive') {
      res = await sudoInteractive(args);
    } else {
      res = await sudoNonInteractive(args);
    }
    
    if (res.exitCode !== 0) {
      throw new Error(`upload failed (exit ${res.exitCode})`);
    }
    
    const manifestStr = fs.readFileSync(outPath, 'utf8');
    manifest = JSON.parse(manifestStr);
    try { fs.rmSync(outPath, {force: true}); } catch {}
  } catch (e) {
    // The local snapshot exists and is safe; the cloud upload failed.
    journal('snapshots', `upload failed for ${created.name}: ${e.message}`, 'error');
    cleanupSnapshotMount(created);  // Clean up any temporary BTRFS mount
    throw e;
  } finally {
    // Always cleanup the temporary mount after upload attempt
    cleanupSnapshotMount(created);
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