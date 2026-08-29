/**
 * The daily workspace backup — user data (Desktop / Documents / Pictures /
 * custom sources) with git-tracked files excluded, shipped through the smart
 * storage pool, then pruned so only the latest `keep` generations survive.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState, saveState, journal } from '../core/store.js';
import { stagingDir } from '../core/paths.js';
import { iso, clock, dueDay } from '../core/time.js';
import { refreshAccounts } from '../storage/accounts.js';
import { planAndPlace } from '../storage/allocator.js';
import { listArtifacts, removeArtifact } from '../storage/archive.js';
import { collectFiles, stageFiles, sumFiles } from './git-exclude.js';
import { planPrune } from './retention.js';

/** Stage the collected sources into a fresh bundle dir. */
export function buildBundle(cfg, due, { home = process.env.HOME } = {}) {
  const col = collectFiles(cfg.jobs.files.sources, {
    exclude: cfg.jobs.files.exclude,
    home,
  });
  const dir = path.join(stagingDir(), `files-${dueDay(due)}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  stageFiles(col.files, dir);
  return {
    dir,
    files: col.files,
    sizeBytes: sumFiles(col.files),
    skippedRepos: col.skippedRepos,
    missing: col.missing,
  };
}
/**
 * Run one file-backup generation for `due`.
 * Assumes the caller holds the scheduler lock.
 * @returns {Promise<object>} summary
 */
export async function runFilesBackup(cfg, state, { due, onProgress } = {}) {
  const now = clock();
  journal('files', `start due=${due}`);
  const bundle = buildBundle(cfg, due);
  const accounts = await refreshAccounts(cfg);

  let manifest;
  try {
    manifest = await planAndPlace(bundle.dir, {
      kind: 'files',
      id: due,
      accounts,
      remoteRoot: cfg.storage.remoteRoot,
      chunkSize: cfg.storage.chunkSize,
      onProgress,
    });
  } finally {
    fs.rmSync(bundle.dir, { recursive: true, force: true });
  }

  // Retention: keep the newest `keep` generations, drop the rest (cloud).
  let pruned = [];
  try {
    const cloud = await listArtifacts('files', accounts, cfg.storage.remoteRoot);
    const { prune } = planPrune(cloud.map((a) => a.id), cfg.jobs.files.keep);
    for (const id of prune) {
      const removed = await removeArtifact('files', id, accounts, cfg.storage.remoteRoot);
      journal('files', `pruned=${id} from=${removed.join(',')}`, 'warn');
      pruned.push(id);
    }
  } catch (e) {
    journal('files', `prune failed: ${e.message}`, 'warn');
  }

  const j = state.jobs.files;
  j.lastCompletedDue = due;
  j.lastRunAt = iso(now);
  j.lastStatus = 'ok';
  j.lastError = null;
  j.pending = (j.pending || []).filter((d) => d !== due);
  j.completed = [...(j.completed || []), { due, at: iso(now) }].slice(-(cfg.jobs.files.keep * 2));
  state.manifests[`files-${manifest.id}`] = {
    kind: 'files',
    id: manifest.id,
    createdAt: manifest.createdAt,
    totalSize: manifest.totalSize,
    entryCount: manifest.entries?.length || 0,
  };
  saveState(state);
  journal('files', `done due=${due} bytes=${manifest.totalSize}`);

  return {
    due,
    manifest,
    sizeBytes: manifest.totalSize,
    skippedRepos: bundle.skippedRepos,
    missing: bundle.missing,
    pruned,
  };
}

/** Alias used by the CLI `force` command. */
export async function runForceBackup(cfg = loadConfig(), state = loadState(), opts = {}) {
  const due = iso(clock());
  return runFilesBackup(cfg, state, { due, ...opts });
}