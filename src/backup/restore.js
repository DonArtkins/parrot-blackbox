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

  // Let Timeshift mount its own repo — our temporary subvolid=5 mount is no
  // longer needed and must not linger.
  await cleanupRestoreMount();

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
  const { path: base } = await resolveTimeshiftSnapshotRepo({ privileged });
  const snapDir = path.join(base, snapId);

  // Ensure the per-snapshot container directory exists (root-owned on real setups).
  const mk = await runPrivileged(['mkdir', '-p', snapDir], privileged);
  if (mk.exitCode !== 0) throw new Error(`could not create snapshot dir ${snapDir} (exit ${mk.exitCode})`);

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

  // Stage 4: BTRFS receive — into the per-snapshot container dir so the
  // received subvolume lands at <snapDir>/@ (Timeshift's BTRFS layout).
  console.log(`   💾 Receiving into ${snapDir}...`);
  const recvArgs = process.env.PBB_SUDO_DIRECT === '1'
    ? ['btrfs', 'receive', snapDir]
    : ((privileged === 'interactive' ? ['sudo', '-E', 'btrfs', 'receive', snapDir] : ['sudo', '-n', 'btrfs', 'receive', snapDir]));
  const receive = spawn(recvArgs[0], recvArgs.slice(1), {
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

  await registerSnapshotWithTimeshift({ snapDir, snapId, privileged });
  journal('restore', `btrfs receive completed for ${snapId}`);
}

/* ------------------------------------------------------------------ */
/* Timeshift BTRFS repository resolution + snapshot registration       */
/* ------------------------------------------------------------------ */

let _restoreMountPoint = null;

/** Run a privileged command honoring the interactive/non-interactive mode. */
async function runPrivileged(args, privileged) {
  const { sudoExec } = await import('../util/sudo.js');
  return sudoExec(args, { interactive: privileged === 'interactive' });
}

/**
 * Resolve where Timeshift stores BTRFS snapshots on THIS machine.
 *
 * On a classic BTRFS install the snapshot repo lives at
 * `<root-subvolume>/timeshift-btrfs/snapshots`, reachable only after mounting
 * the top-level subvolume (subvolid=5) — the same shape snapshotDirFor() uses
 * on the upload side. Static paths cover rsync-mode and sandbox setups.
 *
 * @returns {Promise<{path: string, unmount: string|null}>}
 */
async function resolveTimeshiftSnapshotRepo({ privileged }) {
  const staticPaths = [
    path.join(timeshiftDir(), 'snapshots'),                 // rsync mode & sandbox stub
    path.join(timeshiftDir(), 'timeshift-btrfs', 'snapshots'),
    '/run/timeshift/backup/timeshift-btrfs/snapshots',
  ];
  for (const p of staticPaths) {
    if (fs.existsSync(p)) return { path: p, unmount: null };
  }

  // BTRFS mode: mount the top-level subvolume where Timeshift keeps repos.
  if (!_restoreMountPoint) {
    const mountPoint = `/run/parrot-blackbox-restore-${Date.now()}`;
    const { execaSync } = await import('execa');
    const findmnt = execaSync('findmnt', ['-n', '-o', 'SOURCE', '/'], { reject: false });
    const device = findmnt.stdout?.trim().split('[')[0];
    if (device && findmnt.exitCode === 0) {
      const mk = await runPrivileged(['mkdir', '-p', mountPoint], privileged);
      if (mk.exitCode === 0) {
        const mnt = await runPrivileged(['mount', '-o', 'subvolid=5', device, mountPoint], privileged);
        if (mnt.exitCode === 0) {
          const repo = path.join(mountPoint, 'timeshift-btrfs', 'snapshots');
          if (fs.existsSync(repo)) {
            _restoreMountPoint = mountPoint;
            return { path: repo, unmount: mountPoint };
          }
          await runPrivileged(['umount', mountPoint], privileged).catch(() => null);
        }
        await runPrivileged(['rmdir', mountPoint], privileged).catch(() => null);
      }
    }
  } else {
    const repo = path.join(_restoreMountPoint, 'timeshift-btrfs', 'snapshots');
    if (fs.existsSync(repo)) return { path: repo, unmount: null };
  }

  // Last resort — will produce a clear failure if it's not a real repo path.
  return { path: path.join(timeshiftDir(), 'snapshots'), unmount: null };
}

/** Unmount the temporary subvolid=5 mount (best effort), when one was made. */
export async function cleanupRestoreMount() {
  const mountPoint = _restoreMountPoint;
  _restoreMountPoint = null;
  if (!mountPoint) return;
  await runPrivileged(['umount', mountPoint], 'interactive').catch(() => null);
  await runPrivileged(['rmdir', mountPoint], 'interactive').catch(() => null);
}

/** Parse a Timeshift snapshot name "2026-09-03_12-08-44" into local epoch seconds. */
export function snapshotEpochFromName(name) {
  const m = /^(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$/.exec(String(name || '').trim());
  if (m) {
    const t = new Date(`${m[1].replace(/-/g, '/')} ${m[2].replace(/-/g, ':')}`);
    if (!Number.isNaN(t.getTime())) return Math.floor(t.getTime() / 1000);
  }
  return Math.floor(Date.now() / 1000);
}

/**
 * Register a freshly received BTRFS subvolume with Timeshift so
 * `timeshift --list` / `timeshift --restore --snapshot <id>` recognize it.
 *
 * Timeshift validates a BTRFS snapshot by the control file `info.json` inside
 * the container directory and the read-only "@" subvolume — exactly the shape
 * `btrfs receive <snapDir>` produced.
 */
async function registerSnapshotWithTimeshift({ snapDir, snapId, privileged }) {
  const receivedSubvol = path.join(snapDir, '@');
  if (!fs.existsSync(receivedSubvol)) {
    throw new Error(`btrfs receive did not create ${receivedSubvol} — stream name did not match "@"?`);
  }

  const ctl = {
    created: String(snapshotEpochFromName(snapId)),
    'sys-uuid': '',
    'sys-distro': '',
    'app-version': '24.06.4',
    file_count: '0',
    tags: 'O',
    comments: 'restored via parrot-blackbox',
    live: 'false',
    type: 'btrfs',
  };
  const ctlPath = path.join(snapDir, 'info.json');
  const tmpCtl = path.join(stateDir(), `.ts-info-${snapId}-${process.pid}.json`);
  fs.writeFileSync(tmpCtl, JSON.stringify(ctl, null, 2) + '\n');
  try {
    const cp = await runPrivileged(['cp', tmpCtl, ctlPath], privileged);
    if (cp.exitCode !== 0) throw new Error(`could not write Timeshift control file (exit ${cp.exitCode})`);
    await runPrivileged(['chown', 'root:root', ctlPath], privileged).catch(() => null);
    // Timeshift BTR snapshots are read-only; receive produces writable subvols.
    await runPrivileged(['btrfs', 'property', 'set', '-ts', receivedSubvol, 'ro', 'true'], privileged).catch(() => null);
    console.log(`   ✅ Registered snapshot ${snapId} with Timeshift`);
  } finally {
    try { fs.rmSync(tmpCtl, { force: true }); } catch { /* best effort */ }
  }
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