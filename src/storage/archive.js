/**
 * Archive operations on top of the allocator: discover manifests, restore an
 * artifact (reassembling byte-range chunks), remove artifacts, list what is
 * stored across the pool.
 */

import fs from 'node:fs';
import path from 'node:path';
import streams from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { execa } from 'execa';
import { catRemote, lsjson, purge, copyToFile } from './rclone.js';
import { MANIFEST_NAME } from './allocator.js';

export { MANIFEST_NAME };

function manifestMirrorPath(kind, id) {
  const dir = process.env.PBB_MANIFESTS_DIR || path.join(process.env.PBB_STATE_DIR || '.', 'manifests');
  return path.join(dir, `${kind}-${id}.json`);
}

/**
 * Find the manifest for an artifact by scanning all accounts.
 * @returns {Promise<object|null>} {account, manifest}
 */
export async function discoverManifest(kind, id, accounts, remoteRoot) {
  for (const acc of accounts || []) {
    const remotePath = `${acc.remote}:${remoteRoot}/${kind}/${id}/${MANIFEST_NAME}`;
    const res = await catRemote(remotePath);
    if (res.ok) {
      try {
        const manifest = JSON.parse(res.stdout);
        if (manifest.kind === kind && manifest.id === id) return { account: acc, manifest };
      } catch {
        /* corrupt manifest — keep scanning */
      }
    }
  }
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
 * @returns {Promise<{files:number, bytes:number}>}
 */
export async function restoreArtifact(manifest, destDir, { onProgress } = {}) {
  let files = 0;
  let bytes = 0;

  for (const entry of manifest.entries || []) {
    const target = path.join(destDir, ...entry.rel.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });

    if (entry.type === 'dir') {
      fs.mkdirSync(target, { recursive: true });
      continue;
    }
    if (entry.loc.length === 1) {
      const { remote, path: rp } = entry.loc[0];
      const res = await copyToFile(`${remote}:${rp}`, target);
      if (!res.ok) throw new Error(`download failed for ${entry.rel}: ${res.error}`);
      files += 1;
      bytes += entry.size;
      if (typeof onProgress === 'function') onProgress({ done: files, text: `restored ${entry.rel}` });
      continue;
    }

    // Reassemble split file from byte-range parts.
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
  const removed = [];
  for (const acc of accounts || []) {
    const res = await purge(`${acc.remote}:${remoteRoot}/${kind}/${id}`);
    if (res.ok) removed.push(acc.remote);
  }
  try {
    fs.rmSync(manifestMirrorPath(kind, id), { force: true });
  } catch {
    /* best effort local cleanup */
  }
  return removed;
}

/**
 * List artifacts of a kind discovered on any account (scans manifests).
 * @returns {Promise<Array>} [{kind, id, createdAt, totalSize, account, manifest}]
 */
export async function listArtifacts(kind, accounts, remoteRoot, onProgress) {
  const out = [];
  for (const acc of accounts || []) {
    const scanPath = `${acc.remote}:${remoteRoot}/${kind}`;
    const res = await lsjson(scanPath, { recursive: true });
    if (!res.ok) continue;
    const manifests = res.entries.filter((e) => !e.IsDir && e.Path.endsWith(`/${MANIFEST_NAME}`));
    if (typeof onProgress === 'function') onProgress({ text: `scanning ${acc.remote}…` });
    for (const m of manifests) {
      const id = m.Path.split('/').slice(0, -1).pop();
      const cat = await catRemote(`${acc.remote}:${remoteRoot}/${kind}/${id}/${MANIFEST_NAME}`);
      if (!cat.ok) continue;
      try {
        const manifest = JSON.parse(cat.stdout);
        out.push({ kind, id, createdAt: manifest.createdAt, totalSize: manifest.totalSize, account: acc.remote, manifest });
      } catch {
        /* skip corrupt */
      }
    }
  }
  return out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}