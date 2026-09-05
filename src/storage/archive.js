/**
 * Archive operations on top of the allocator: discover manifests, restore an
 * artifact (reassembling byte-range chunks), remove artifacts, list what is
 * stored across the pool.
 *
 * v1.0.14: Batch-parallel downloads (restoreArtifact), parallel manifest
 * scanning (discoverManifest), parallel artifact listing (listArtifacts).
 */

import fs from 'node:fs';
import path from 'node:path';
import streams from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execa } from 'execa';
import { catRemote, lsjson, purge, copyToFile, downloadBatch } from './rclone.js';
import { MANIFEST_NAME } from './allocator.js';
import { isValidBtrfsStreamManifest } from '../backup/btrfs-send.js';
import { manifestsDir } from '../core/paths.js';

export { MANIFEST_NAME };

/**
 * A schema-2 snapshot manifest whose stream never made it (failed `btrfs send`
 * leaves a dozens-of-bytes phantom) is garbage: it must not be listed, offered
 * for restore, or used as an incremental parent. Schema-1 (legacy file-tree)
 * backups are always kept.
 */
function isPhantom(kind, manifest) {
  return kind === 'snapshots' && manifest.schema === 2 && !isValidBtrfsStreamManifest(manifest);
}

export function manifestMirrorPath(kind, id) {
  // Canonical state dir, NOT a CWD-relative `./manifests` (which would land in
  // the user's home as stray junk and break the mirror fallback).
  const dir = process.env.PBB_MANIFESTS_DIR || manifestsDir();
  return path.join(dir, `${kind}-${id}.json`);
}

/**
 * Find the manifest for an artifact by scanning all accounts IN PARALLEL.
 * The first account that returns a valid manifest wins.
 * @returns {Promise<object|null>} {account, manifest}
 */
export async function discoverManifest(kind, id, accounts, remoteRoot) {
  // Fire all account probes concurrently — first valid result wins.
  const probes = (accounts || []).map(async (acc) => {
    const remotePath = `${acc.remote}:${remoteRoot}/${kind}/${id}/${MANIFEST_NAME}`;
    const res = await catRemote(remotePath);
    if (res.ok) {
      try {
        const manifest = JSON.parse(res.stdout);
        if (manifest.kind === kind && manifest.id === id && !isPhantom(kind, manifest)) {
          return { account: acc, manifest };
        }
      } catch {
        /* corrupt manifest — skip */
      }
    }
    return null;
  });

  const results = await Promise.all(probes);
  const found = results.find((r) => r !== null);
  if (found) return found;

  // Local mirror fallback.
  try {
    const local = JSON.parse(fs.readFileSync(manifestMirrorPath(kind, id), 'utf8'));
    return { account: null, manifest: local };
  } catch {
    return null;
  }
}

/**
 * Restore an artifact from its manifest into destDir.
 *
 * Optimised path (v1.0.14): whole files are grouped by remote and downloaded
 * in a single `rclone copy --files-from --transfers=16` batch per remote —
 * the same parallelism strategy used for uploads. Split files (byte-range
 * chunks) still use the streaming reassembly path since their parts live on
 * different accounts.
 *
 * @returns {Promise<{files:number, bytes:number}>}
 */
export async function restoreArtifact(manifest, destDir, { onProgress } = {}) {
  let files = 0;
  let bytes = 0;
  const entries = manifest.entries || [];

  // ── Step 1: Create all directories up-front ──
  for (const entry of entries) {
    const target = path.join(destDir, ...entry.rel.split('/'));
    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
    } else {
      fs.mkdirSync(path.dirname(target), { recursive: true });
    }
  }

  // ── Step 2: Separate whole files (batchable) from split files ──
  const wholeFiles = [];    // single-location entries → batched download
  const splitFiles = [];    // multi-location entries → streaming reassembly

  for (const entry of entries) {
    if (entry.type === 'dir') continue;
    if (entry.loc.length === 1) {
      wholeFiles.push(entry);
    } else {
      splitFiles.push(entry);
    }
  }

  // ── Step 3: Batch-download whole files grouped by remote ──
  //
  // Group files by {remote, basePath} so each batch targets one rclone remote
  // and uses `--files-from` for internal parallelism.
  const batches = new Map(); // key: "remote:basePath" → { remote, basePath, entries[] }

  for (const entry of wholeFiles) {
    const loc = entry.loc[0];
    // loc.path is something like "parrot-blackbox/files/2026-09-02/Documents/index.txt"
    // We need the basePath (everything up to the artifact root) and the
    // relative tail so rclone can resolve --files-from entries.
    const remoteFull = `${loc.remote}:${loc.path}`;
    // Find the relative portion that matches entry.rel within loc.path
    const relInPath = entry.rel;
    const idx = loc.path.lastIndexOf(relInPath);
    const basePath = idx > 0 ? loc.path.slice(0, idx) : path.dirname(loc.path) + '/';
    const key = `${loc.remote}:${basePath}`;
    if (!batches.has(key)) {
      batches.set(key, { remote: loc.remote, basePath, entries: [] });
    }
    batches.get(key).entries.push(entry);
  }

  const batchDir = process.env.PBB_STATE_DIR || '/tmp';

  for (const [key, batch] of batches.entries()) {
    const filesList = batch.entries.map((e) => e.rel);
    const batchPath = path.join(batchDir, `dl-batch-${batch.remote.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.txt`);
    fs.mkdirSync(path.dirname(batchPath), { recursive: true });
    fs.writeFileSync(batchPath, filesList.join('\n') + '\n');

    const remoteSrc = `${batch.remote}:${batch.basePath}`;
    const res = await downloadBatch(remoteSrc, destDir, batchPath);

    // Clean up the batch file.
    try { fs.unlinkSync(batchPath); } catch { /* best effort */ }

    if (!res.ok) {
      // Fall back to one-by-one downloads for this batch on failure.
      for (const entry of batch.entries) {
        const target = path.join(destDir, ...entry.rel.split('/'));
        const loc = entry.loc[0];
        const r = await copyToFile(`${loc.remote}:${loc.path}`, target, { force: true });
        if (!r.ok) throw new Error(`download failed for ${entry.rel}: ${r.error}`);
        files += 1;
        bytes += entry.size;
        if (typeof onProgress === 'function') onProgress({ done: files, text: `restored ${entry.rel}` });
      }
    } else {
      for (const entry of batch.entries) {
        files += 1;
        bytes += entry.size;
        if (typeof onProgress === 'function') onProgress({ done: files, text: `restored ${entry.rel}` });
      }
    }
  }

  // ── Step 4: Streaming reassembly for split files ──
  for (const entry of splitFiles) {
    const target = path.join(destDir, ...entry.rel.split('/'));
    const partAbs = `${target}.assembling-${process.pid}`;
    const out = createWriteStream(partAbs);
    const sorted = [...entry.loc].sort((a, b) => a.start - b.start);
    for (const loc of sorted) {
      const src = `${loc.remote}:${loc.path}`;
      const child = execa('rclone', ['cat', src], { reject: false });
      child.stdout.on('error', () => {});
      await streams.pipeline(child.stdout, out, { end: false }).catch(() => {});
      const res = await child; // wait for the process to exit and get its code
      if (res.exitCode !== 0) throw new Error(`chunk download failed for ${entry.rel} (exit ${res.exitCode})`);
    }
    if (out.writableEnded === false) {
      out.end();
      await streams.finished(out);
    }
    fs.renameSync(partAbs, target);
    files += 1;
    bytes += entry.size;
    if (typeof onProgress === 'function') onProgress({ done: files, text: `restored ${entry.rel}` });
  }

  return { files, bytes };
}

/** Purge an artifact from every account that hosts it (+ local mirror). */
export async function removeArtifact(kind, id, accounts, remoteRoot) {
  // Purge all accounts in parallel.
  const results = await Promise.all(
    (accounts || []).map(async (acc) => {
      const res = await purge(`${acc.remote}:${remoteRoot}/${kind}/${id}`);
      return res.ok ? acc.remote : null;
    }),
  );
  const removed = results.filter(Boolean);
  try {
    fs.rmSync(manifestMirrorPath(kind, id), { force: true });
  } catch {
    /* best effort local cleanup */
  }
  return removed;
}

/**
 * List artifacts of a kind discovered on any account (scans manifests).
 * Accounts are scanned IN PARALLEL for speed.
 * @returns {Promise<Array>} [{kind, id, createdAt, totalSize, account, manifest}]
 */
export async function listArtifacts(kind, accounts, remoteRoot, onProgress) {
  const perAccount = await Promise.all(
    (accounts || []).map(async (acc) => {
      const scanPath = `${acc.remote}:${remoteRoot}/${kind}`;
      const res = await lsjson(scanPath, { recursive: true });
      if (!res.ok) return [];
      const manifests = res.entries.filter((e) => !e.IsDir && e.Path.endsWith(`/${MANIFEST_NAME}`));
      if (typeof onProgress === 'function') onProgress({ text: `scanning ${acc.remote}…` });
      const items = await Promise.all(
        manifests.map(async (m) => {
          const id = m.Path.split('/').slice(0, -1).pop();
          const cat = await catRemote(`${acc.remote}:${remoteRoot}/${kind}/${id}/${MANIFEST_NAME}`);
          if (!cat.ok) return null;
          try {
            const manifest = JSON.parse(cat.stdout);
            if (isPhantom(kind, manifest)) return null;
            return { kind, id, createdAt: manifest.createdAt, totalSize: manifest.totalSize, account: acc.remote, manifest };
          } catch {
            return null;
          }
        }),
      );
      return items.filter(Boolean);
    }),
  );
  return perAccount.flat().sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}