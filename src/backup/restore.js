/**
 * Recovery. Two paths:
 *  - `restore snapshot` — pull a cloud snapshot onto local disk, register it
 *    with Timeshift, then run the interactive restore (overwrites the running
 *    system's root files, exactly what you want over a fresh install). sudo
 *    password is prompted interactively, the same way gitswitch/theamify do.
 *  - `restore files`   — download one file-backup generation to a local
 *    directory so specific lost files (fonts, images…) come back without
 *    touching the system.
 *
 * Restoring a snapshot is Level-5 destructive: requires an explicit
 * confirmation (or `--yes`) before anything is overwritten.
 */

import fs from 'node:fs';
import path from 'node:path';
import { journal } from '../core/store.js';
import { stateDir, timeshiftDir } from '../core/paths.js';
import { refreshAccounts } from '../storage/accounts.js';
import { discoverManifest, restoreArtifact } from '../storage/archive.js';
import { listLocalSnapshots } from './snapshot.js';
import { ensureSudo, sudoInteractive } from '../util/sudo.js';
import { bytesHuman } from '../util/misc.js';

/** Restore a file backup generation into a writable local directory. */
export async function restoreFiles({ id, toDir, accounts, cfg, onProgress }) {
  const found = await discoverManifest('files', id, accounts, cfg.storage.remoteRoot);
  if (!found) {
    // Fall back to scanning every account for the artifact id.
    throw new Error(`no file backup found for id "${id}" — check with \`parrot-blackbox list\``);
  }
  fs.mkdirSync(toDir, { recursive: true });
  const res = await restoreArtifact(found.manifest, toDir, { onProgress });
  journal('restore', `files id=${id} -> ${toDir} files=${res.files} bytes=${res.bytes}`);
  return { id, toDir, ...res, manifest: found.manifest };
}

/**
 * Restore a system snapshot.
 * V2: Handles BTRFS streams (schema 2) with reverse pipeline: download -> decrypt -> decompress -> btrfs receive
 * Applies incremental snapshots in correct parent-chain order.
 * @param {object} opts {id, accounts, cfg, toDir?, confirm, privileged?, onProgress}
 */
export async function restoreSnapshot({ id, accounts, cfg, toDir, confirm = false, privileged = 'interactive', onProgress }) {
  if (!confirm) {
    throw new Error('Refusing without confirmation — pass `--yes` (or confirm interactively). This overwrites the whole system.');
  }

  const found = await discoverManifest('snapshots', id, accounts, cfg.storage.remoteRoot);
  if (!found) {
    throw new Error(`no snapshot backup found for id "${id}" — check with \`parrot-blackbox snapshot list\``);
  }

  // Build the parent chain (if incremental)
  const chain = await buildParentChain(id, accounts, cfg.storage.remoteRoot);
  console.log(`\n📦 Snapshot restore chain: ${chain.join(' ← ')}`);

  // Is it already on local disk?
  const localSnaps = await listLocalSnapshots({ privileged }).catch(() => []);
  const missingFromChain = chain.filter(snapId => !localSnaps.some(s => s.name === snapId));

  if (missingFromChain.length === 0) {
    console.log(`✓ All snapshots already present locally.`);
  } else {
    // Download and receive each missing snapshot in order (oldest to newest)
    console.log(`\n⬇ Downloading ${missingFromChain.length} snapshot(s)...`);
    for (const snapId of missingFromChain) {
      await downloadAndReceiveSnapshot({ snapId, accounts, cfg, privileged, onProgress });
    }
  }

  // Run the actual restore (interactive sudo → the password prompt is visible).
  console.log(`\n🔄 Restoring snapshot ${id} over the current system…\n`);
  await ensureSudo();
  const res = await sudoInteractive(['timeshift', '--restore', '--snapshot', id, '--yes']);
  if (res.exitCode !== 0) throw new Error(`timeshift --restore failed (exit ${res.exitCode})`);
  journal('restore', `snapshot id=${id} RESTORED`);
  
  console.log(`\n✔ Restore complete!\n`);
  console.log(`⚠️  IMPORTANT: Update hardware-specific UUIDs before rebooting:`);
  console.log(`    1. Check new disk UUIDs: sudo blkid`);
  console.log(`    2. Update /etc/fstab with new BTRFS filesystem UUID`);
  console.log(`    3. Update /etc/crypttab with new LUKS container UUID (if encrypted)`);
  console.log(`    4. Update /etc/default/grub if it references UUIDs directly`);
  console.log(`    5. Run: sudo update-grub && sudo grub-install /dev/sdX\n`);
  console.log(`After fixing UUIDs, REBOOT to boot into the restored system.\n`);
  
  return { id };
}

/**
 * Build the parent chain for a snapshot (from oldest ancestor to target).
 * @returns {string[]} - Array of snapshot IDs in order [oldest_parent, ..., target]
 */
async function buildParentChain(id, accounts, remoteRoot) {
  const chain = [];
  let current = id;
  const visited = new Set();

  // Walk backwards to find all ancestors
  while (current && !visited.has(current)) {
    visited.add(current);
    chain.unshift(current);
    const manifest = await discoverManifest('snapshots', current, accounts, remoteRoot);
    if (!manifest || !manifest.manifest.parent) break;
    current = manifest.manifest.parent;
  }

  return chain;
}

/**
 * Download a BTRFS snapshot stream and receive it into Timeshift.
 */
async function downloadAndReceiveSnapshot({ snapId, accounts, cfg, privileged, onProgress }) {
  const found = await discoverManifest('snapshots', snapId, accounts, cfg.storage.remoteRoot);
  if (!found) throw new Error(`Snapshot ${snapId} not found in cloud`);

  const manifest = found.manifest;
  console.log(`\n📥 Downloading snapshot ${snapId}...`);

  // Check if it's a v2 BTRFS stream or v1 file tree
  const isBtrfsStream = manifest.schema === 2 && manifest.entries?.some(e => e.rel === 'btrfs.stream');

  if (isBtrfsStream) {
    // V2 BTRFS stream restore: download -> decrypt -> decompress -> btrfs receive
    await restoreBtrfsStream({ manifest, snapId, cfg, privileged, onProgress });
  } else {
    // V1/V2 file-tree restore: download to temp dir, then move into Timeshift
    const tmpRoot = path.join(stateDir(), 'restore', snapId);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const res = await restoreArtifact(manifest, tmpRoot, { onProgress });
    journal('restore', `snapshot id=${snapId} downloaded ${res.bytes} bytes`);
    await placeIntoTimeshift(snapId, tmpRoot, cfg, privileged, manifest);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  console.log(`✓ Snapshot ${snapId} restored to Timeshift`);
}

/**
 * Restore a BTRFS stream directly via btrfs receive.
 * Pipeline: rclone cat (chunked) -> [openssl dec] -> [zstd -d] -> btrfs receive
 */
async function restoreBtrfsStream({ manifest, snapId, cfg, privileged, onProgress }) {
  const entry = manifest.entries.find(e => e.rel === 'btrfs.stream');
  if (!entry || !entry.loc || entry.loc.length === 0) {
    throw new Error(`Invalid BTRFS stream manifest for ${snapId}`);
  }

  const btrfsCfg = cfg.jobs.snapshots.btrfs || {};
  const base = determineSnapshotBase();
  
  // Ensure base directory exists
  await ensureSudo();
  await sudoInteractive(['mkdir', '-p', base]);

  // Build reverse pipeline
  const { spawn } = await import('node:child_process');
  const pipeline = [];

  // Stage 1: Download all chunks in order via rclone cat
  // For multi-chunk files, we need to download each part and concatenate
  const { createReadStream } = await import('node:fs');
  const { Readable } = await import('node:stream');
  
  // Create a readable stream that downloads each chunk sequentially
  const downloadStream = new Readable({
    async read() {
      if (this._downloading) return;
      this._downloading = true;
      this._currentChunk = this._currentChunk || 0;
      
      if (this._currentChunk >= entry.loc.length) {
        this.push(null); // End of stream
        return;
      }

      const loc = entry.loc[this._currentChunk];
      const rclone = spawn(process.env.PBB_RCLONE || 'rclone', ['cat', `${loc.remote}:${loc.path}`], {
        stdio: ['ignore', 'pipe', 'inherit']
      });

      rclone.stdout.on('data', (chunk) => {
        if (!this.push(chunk)) {
          rclone.stdout.pause();
        }
      });

      rclone.stdout.on('end', () => {
        this._currentChunk++;
        this._downloading = false;
        this.read(); // Try next chunk
      });

      rclone.on('error', (err) => this.destroy(err));
    }
  });

  let currentStream = downloadStream;

  // Stage 2: Decryption (if enabled)
  if (btrfsCfg.encryption && cfg.storage.encryptionPassphrase) {
    console.log(`   🔓 Decrypting stream...`);
    const openssl = spawn('openssl', ['enc', '-d', '-aes256', '-pbkdf2', '-pass', `pass:${cfg.storage.encryptionPassphrase}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    currentStream.pipe(openssl.stdin);
    pipeline.push(openssl);
    currentStream = openssl.stdout;
  }

  // Stage 3: Decompression (if enabled)
  if (btrfsCfg.compression !== false) {
    console.log(`   📦 Decompressing stream...`);
    const zstd = spawn('zstd', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
    currentStream.pipe(zstd.stdin);
    pipeline.push(zstd);
    currentStream = zstd.stdout;
  }

  // Stage 4: BTRFS receive
  console.log(`   💾 Receiving into ${base}...`);
  const sudoArgs = privileged === 'interactive' 
    ? ['sudo', '-E', 'btrfs', 'receive', base]
    : ['sudo', '-n', 'btrfs', 'receive', base];
  const receive = spawn(sudoArgs[0], sudoArgs.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  currentStream.pipe(receive.stdin);
  pipeline.push(receive);

  // Wait for pipeline to complete
  await new Promise((resolve, reject) => {
    const last = pipeline[pipeline.length - 1];
    last.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Restore pipeline failed with exit code ${code}`));
    });
    last.on('error', reject);
  });
  
  journal('restore', `btrfs receive completed for ${snapId}`);
}

/** Move a downloaded snapshot tree into the Timeshift snapshot folder (root-owned). */
async function placeIntoTimeshift(id, tmpRoot, cfg, privileged, manifest) {
  const base = determineSnapshotBase();
  await ensureSudo();
  
  // If it's a BTRFS stream (schema 2), use btrfs receive
  if (manifest && manifest.schema === 2) {
    const streamFile = path.join(tmpRoot, 'btrfs.stream');
    if (fs.existsSync(streamFile)) {
      const btrfsCfg = cfg.jobs.snapshots.btrfs || {};
      const passphrase = cfg.storage.encryptionPassphrase;
      let cmd = `mkdir -p ${shq(base)} && cat ${shq(streamFile)}`;
      
      if (btrfsCfg.encryption && passphrase) {
        cmd += ` | openssl enc -d -aes256 -pbkdf2 -pass "pass:${passphrase}"`;
      }
      if (btrfsCfg.compression !== false) {
        cmd += ` | zstd -d -c`;
      }
      cmd += ` | btrfs receive ${shq(base)}`;
      
      const res = await sudoInteractive(['bash', '-c', cmd]);
      if (res.exitCode !== 0) throw new Error(`could not receive BTRFS stream into ${base} (exit ${res.exitCode})`);
      return path.join(base, id);
    }
  }

  // Fallback for v1 file-copy snapshots
  const target = path.join(base, id);
  const cmd = `mkdir -p ${shq(base)} && rm -rf ${shq(target)} && cp -a ${shq(tmpRoot)}/. ${shq(target)}/ && chown -R root:root ${shq(target)}`;
  const res = await sudoInteractive(['bash', '-c', cmd]);
  if (res.exitCode !== 0) throw new Error(`could not move snapshot into ${base} (exit ${res.exitCode})`);
  return target;
}

function determineSnapshotBase() {
  return path.join(timeshiftDir(), 'snapshots');
}

function shq(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}