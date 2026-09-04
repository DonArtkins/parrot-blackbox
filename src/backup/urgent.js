/**
 * The URGENT backup — a fast, one-off rescue artifact for a fresh install.
 *
 * It bundles the user's real working files (Desktop / Downloads / Documents /
 * Music / Pictures / Programming / Videos / Learning) PLUS the tooling needed
 * to be productive on day one:
 *   - VS Codium data profile + extensions (+ shared storage / user config)
 *   - gitswitch bookkeeping + the SSH keys it manages + git config
 *
 * Design notes (why this is intentionally NOT the daily files job):
 *   - It uses its own fixed source list, so it never depends on the user's
 *     config having the right sources enabled.
 *   - It still honours the golden rule: git-tracked trees are skipped (GitHub
 *     already owns them) and the lean exclude list drops bloat (node_modules,
 *     caches, session noise).
 *   - It uploads through the same smart storage pool under a DISTINCT kind
 *     ('urgent') so it is never confused with — or pruned by — scheduled
 *     backups, and is cleanly restorable via the existing restore flow.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadConfig, loadState, saveState, journal } from '../core/store.js';
import { stagingDir } from '../core/paths.js';
import { iso, clock } from '../core/time.js';
import { refreshAccounts } from '../storage/accounts.js';
import { planAndPlace } from '../storage/allocator.js';
import { collectFiles, stageFiles, sumFiles } from './git-exclude.js';

/** Cloud artifact kind (a distinct bucket from 'files' / 'snapshots'). */
export const KIND = 'urgent';

/** Everything the urgent backup takes from the home directory. */
export const URGENT_SOURCES = [
  // Working files
  '~/Desktop',
  '~/Downloads',
  '~/Documents',
  '~/Learning',
  '~/Music',
  '~/Pictures',
  '~/Programming',
  '~/Videos',
  // VS Codium — data profile + extensions + shared storage + user config
  '~/.vscode-oss',
  '~/.vscode-oss-shared',
  '~/.config/VSCodium/User',
  // gitswitch — accounts/SSH bookkeeping, the SSH keys it manages, git config
  '~/.gitswitch',
  '~/.ssh',
  '~/.gitconfig',
];

/** Lean exclude list — git repos + bloat are out, real files are in. */
export const URGENT_EXCLUDE = [
  '**/.cache/**',
  '**/.git/**',
  '**/node_modules/**',
  '**/__pycache__/**',
  '**/*.tmp',
  '**/*.swp',
  '**/*.log',
  '**/lost+found/**',
  // VS Codium cache / session noise — the profile is what matters, not caches.
  '**/Cache/**',
  '**/CachedData/**',
  '**/CachedExtensionVSIXs/**',
  '**/GPUCache/**',
  '**/blob_storage/**',
  '**/Code Cache/**',
  '**/Crashpad/**',
  '**/Service Worker/**',
  '**/WebStorage/**',
  '**/Local Storage/**',
  '**/Session Storage/**',
];

/**
 * Collect + stage the urgent sources into a fresh bundle dir.
 * @returns {{dir:string, files:Array, sizeBytes:number, skippedRepos:string[], missing:string[], skipped:number}}
 */
export function buildUrgentBundle({ home = process.env.HOME } = {}) {
  const col = collectFiles(URGENT_SOURCES, { exclude: URGENT_EXCLUDE, home });
  const dir = path.join(stagingDir(), `urgent-${Date.now()}-${process.pid}`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  stageFiles(col.files, dir);
  return {
    dir,
    files: col.files,
    sizeBytes: sumFiles(col.files),
    skippedRepos: col.skippedRepos,
    missing: col.missing,
    skipped: col.skipped,
  };
}

/**
 * Run one URGENT backup generation — bundle → stage → upload to the pool.
 * Unlike scheduled backups this does NOT run retention, so the rescue artifact
 * is never auto-deleted.
 * @returns {Promise<{id:string, manifest:object, sizeBytes:number, skippedRepos:string[], missing:string[]}>}
 */
export async function runUrgentBackup(cfg = loadConfig(), state = loadState(), { onProgress } = {}) {
  const now = clock();

  // ── Resume an interrupted upload ─────────────────────────────────────────
  // If a previous urgent upload died mid-transfer (power cut / crash / Ctrl+C),
  // a pending marker was persisted in state BEFORE any long work began. On the
  // next run we REUSE that id so `planAndPlace` writes back into the SAME cloud
  // directory — rclone copy is per-file idempotent, so already-uploaded files
  // are skipped and only the remainder is transferred, then the manifest is
  // rewritten once the last file lands. The bundle itself is regenerated (the
  // staging dir is transient), which is fine because the sources are fixed.
  const resumed = Boolean(state.urgentPending?.id);
  const id = resumed ? state.urgentPending.id : iso(now);
  if (!resumed) {
    state.urgentPending = { id, since: iso(now) };
    saveState(state); // persist the marker before any long work → crash-safe
    journal('urgent', `start id=${id}`);
  } else {
    journal('urgent', `resume id=${id} (previous upload was interrupted)`);
  }

  const bundle = buildUrgentBundle();

  const accounts = await refreshAccounts(cfg);
  if (!accounts.length) {
    fs.rmSync(bundle.dir, { recursive: true, force: true });
    throw new Error('No cloud accounts configured — run `parrot-blackbox account add` (or Guided Setup) first.');
  }

  let manifest;
  try {
    manifest = await planAndPlace(bundle.dir, {
      kind: KIND,
      id,
      accounts,
      remoteRoot: cfg.storage.remoteRoot,
      chunkSize: cfg.storage.chunkSize,
      onProgress,
    });
  } finally {
    fs.rmSync(bundle.dir, { recursive: true, force: true });
  }

  state.manifests[`${KIND}-${manifest.id}`] = {
    kind: KIND,
    id: manifest.id,
    createdAt: manifest.createdAt,
    totalSize: manifest.totalSize,
    entryCount: manifest.entries?.length || 0,
  };
  // Only clear the pending marker once the upload FULLY landed (manifest is on
  // the cloud + mirrored locally). If we crash before this line, the next run
  // resumes the same id — re-copying is a no-op for finished files.
  delete state.urgentPending;
  saveState(state);
  journal('urgent', `done id=${id} bytes=${manifest.totalSize}`);

  return {
    id,
    resumed,
    manifest,
    sizeBytes: manifest.totalSize,
    skippedRepos: bundle.skippedRepos,
    missing: bundle.missing,
  };
}