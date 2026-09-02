/**
 * Smart storage allocator — the brain that keeps the multi-account pool
 * (many MEGA + Google Drive logins) from ever running out of space.
 *
 * Strategy:
 *   0. MEGA accounts are always filled first. Google Drive accounts are only
 *      used once every MEGA account is at capacity for the file being placed.
 *   1. Within each provider tier, every file of an artifact is placed WHOLE on
 *      a single account when it fits. The account is chosen to minimise the
 *      resulting used-percentage (water-filling), then most free, then oldest —
 *      spreading wear evenly across all accounts of the same type.
 *   2. If a single file is bigger than any one account's free space, it is
 *      split into byte-range chunks distributed across several accounts
 *      (first-fit over free space, MEGA-first). A manifest records the exact
 *      ranges so restore reassembles the file byte-perfectly.
 * The manifest is written to the cloud (`<root>/<kind>/<id>/__MANIFEST__.json`)
 * AND mirrored locally, so restore works even from a wiped machine.
 */

import fs from 'node:fs';
import path from 'node:path';
import streams from 'node:stream/promises';
import { createWriteStream } from 'node:fs';
import { copyToFile, copyBatch, mkdirRemote } from './rclone.js';
import { bytesHuman } from '../util/misc.js';

export { bytesHuman };
export const GiB = 1024 ** 3;
export const MANIFEST_NAME = '__MANIFEST__.json';

/** Walk a dir tree returning [{rel, abs, size, isDir}]. Symlinks skipped. */
export function walkFiles(localDir) {
  const out = [];
  const base = path.resolve(localDir);
  function rec(abs, rel) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const eAbs = path.join(abs, ent.name);
      const eRel = rel ? `${rel}/${ent.name}` : ent.name;
      let st;
      try {
        st = fs.statSync(eAbs);
      } catch {
        continue; // dangling symlink / unreadable
      }
      if (ent.isSymbolicLink()) continue;
      if (ent.isDirectory()) {
        out.push({ rel: eRel, abs: eAbs, isDir: true, size: 0 });
        rec(eAbs, eRel);
      } else {
        out.push({ rel: eRel, abs: eAbs, isDir: false, size: st.size });
      }
    }
  }
  rec(base, '');
  return out;
}

/**
 * Choose the best account to store `needed` bytes.
 *
 * Priority:
 *   1. MEGA accounts are always preferred over Google Drive.
 *      Only when ALL MEGA accounts are full (or have insufficient free space)
 *      will Google Drive accounts be used.
 *   2. Within each provider tier the classic water-filling strategy applies:
 *      pick the account that results in the lowest used-percentage after
 *      placing the file (most headroom wins on ties).
 */
export function chooseAccount(needed, accounts) {
  // Tier 0 = mega, Tier 1 = gdrive / everything else.
  const providerTier = (acc) => (acc.provider === 'mega' ? 0 : 1);

  // Find the lowest tier that has at least one account with enough free space.
  const eligible = accounts.filter((a) => a.free >= needed);
  if (eligible.length === 0) return null;

  const bestTier = Math.min(...eligible.map(providerTier));
  const candidates = eligible.filter((a) => providerTier(a) === bestTier);

  // Water-fill within the chosen tier: minimise resulting used-percentage.
  let best = null;
  let bestScore = Infinity;
  for (const acc of candidates) {
    const quota = acc.total || 0;
    const score = quota ? (acc.used + needed) / quota : needed;
    if (score < bestScore || (score === bestScore && acc.free > (best?.free ?? -1))) {
      bestScore = score;
      best = acc;
    }
  }
  return best;
}

/**
 * Place a whole local dir into the pool using two-pass batching for speed.
 */
export async function planAndPlace(localDir, { kind, id, accounts, remoteRoot, chunkSize, onProgress }) {
  if (!accounts || accounts.length === 0) {
    throw new Error('no storage accounts configured — add one with `parrot-blackbox account add`');
  }
  chunkSize = chunkSize || 2 * GiB;

  const entries = walkFiles(localDir).filter((e) => e.isDir || e.size > 0);
  const files = entries.filter((e) => !e.isDir).sort((a, b) => b.size - a.size);
  const totalSize = files.reduce((s, f) => s + f.size, 0);

  const pool = accounts.map((a) => ({ ...a }));
  const consume = (account, bytes) => {
    const a = pool.find((x) => x.id === account.id);
    if (a) a.free -= bytes;
  };

  const basePath = `${remoteRoot}/${kind}/${id}`;
  const manifest = {
    schema: 1,
    kind,
    id,
    createdAt: new Date().toISOString(),
    totalSize,
    remoteRoot,
    entries: [],
  };

  const report = (done, text) => {
    if (typeof onProgress === 'function') onProgress({ done, total: files.length, text });
  };

  // PASS 1: Planning
  report(0, 'planning allocations...');
  const batches = new Map(); // account.remote -> array of relative paths
  const splits = []; // files that need splitting

  for (const acc of pool) {
    batches.set(acc.remote, { acc, files: [] });
  }

  for (const entry of entries) {
    if (entry.isDir) {
      const acc = chooseAccount(0, pool);
      if (!acc) throw outOfSpace();
      manifest.entries.push({ rel: entry.rel, type: 'dir', size: 0, loc: [{ remote: acc.remote, path: `${basePath}/${entry.rel}` }] });
      continue;
    }

    const freeMax = Math.max(0, ...pool.map((a) => a.free));
    if (entry.size <= freeMax) {
      const acc = chooseAccount(entry.size, pool);
      if (!acc) throw outOfSpace();
      consume(acc, entry.size);
      batches.get(acc.remote).files.push(entry.rel);
      manifest.entries.push({
        rel: entry.rel,
        type: 'file',
        size: entry.size,
        loc: [{ remote: acc.remote, path: `${basePath}/${entry.rel}`, start: 0, end: entry.size, size: entry.size }],
      });
    } else {
      splits.push(entry);
    }
  }

  // PASS 2: Batch Uploading (Sequential accounts, but parallel files inside rclone)
  const batchDir = process.env.PBB_STATE_DIR || '/tmp';
  let placed = 0;
  
  for (const [remote, batch] of batches.entries()) {
    if (batch.files.length === 0) continue;
    const batchPath = path.join(batchDir, `batch-${remote.replace(/[^a-z0-9]/gi, '_')}-${Date.now()}.txt`);
    fs.writeFileSync(batchPath, batch.files.join('\n') + '\n');
    
    // Ensure the remote directory exists to prevent "directory not found" errors
    // when rclone tries to list the destination for --files-from checking.
    await mkdirRemote(`${remote}:${basePath}`);
    
    report(placed, `uploading batch of ${batch.files.length} files to ${remote}...`);
    const res = await copyBatch(localDir, `${remote}:${basePath}`, batchPath);
    if (!res.ok) throw new Error(`batch upload failed to ${remote}: ${res.error}`);
    
    fs.unlinkSync(batchPath);
    placed += batch.files.length;
    report(placed, `placed ${placed}/${files.length}`);
  }

  // PASS 3: Split large files
  for (const entry of splits) {
    const rel = entry.rel;
    const destPath = `${basePath}/${rel}`;
    const locs = [];
    let start = 0;
    let partIndex = 0;
    
    report(placed, `splitting huge file ${rel}...`);
    while (start < entry.size) {
      const len = Math.min(chunkSize, entry.size - start);
      const acc = chooseAccount(len, pool);
      if (!acc) throw outOfSpace();
      
      const partAbs = await makePartFile(entry, start, len);
      const partPath = `${destPath}.part-${String(partIndex).padStart(4, '0')}`;
      
      const res = await copyToFile(partAbs, `${acc.remote}:${partPath}`);
      if (!res.ok) throw new Error(`upload failed for ${rel} part on ${acc.remote}: ${res.error}`);
      
      consume(acc, len);
      locs.push({ remote: acc.remote, path: partPath, start, end: start + len, size: len });
      start += len;
      partIndex += 1;
    }
    manifest.entries.push({ rel, type: 'file', size: entry.size, split: true, loc: locs });
    placed += 1;
    report(placed, `placed ${placed}/${files.length}`);
  }

  // Manifest: cloud + local mirror.
  const manifestLocalDir = process.env.PBB_MANIFESTS_DIR || path.join(process.env.PBB_STATE_DIR || '.', 'manifests');
  const manifestLocalPath = path.join(manifestLocalDir, `${kind}-${id}.json`);
  fs.mkdirSync(manifestLocalDir, { recursive: true });
  fs.writeFileSync(manifestLocalPath, JSON.stringify(manifest, null, 2));
  const accForManifest = pool.find((a) => a.free > 0) || pool[0];
  if (accForManifest) {
    const res = await copyToFile(manifestLocalPath, `${accForManifest.remote}:${basePath}/${MANIFEST_NAME}`);
    if (res.ok) manifest.account = accForManifest.remote;
  }
  return manifest;
}

function outOfSpace() {
  return new Error(
    'OUT OF SPACE — the pool has no account with enough free room. Add an account, raise a quota, or prune old backups.',
  );
}

/** Write a byte range of a file to a temp part file; returns its path. */
async function makePartFile(file, start, len) {
  const dir = process.env.PBB_CHUNK_DIR || path.join(process.env.PBB_STATE_DIR || '.', 'chunks');
  const partAbs = path.join(dir, `.part-${process.pid}-${file.rel.replace(/[^a-z0-9_.-]/gi, '_')}`);
  fs.mkdirSync(path.dirname(partAbs), { recursive: true });
  await streams.pipeline(fs.createReadStream(file.abs, { start, end: start + len - 1 }), createWriteStream(partAbs));
  return partAbs;
}