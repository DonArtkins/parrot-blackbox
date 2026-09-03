/**
 * BTRFS send/receive primitives for incremental snapshot backups.
 *
 * Key concepts from research:
 * - `btrfs send <snapshot>` generates a binary stream of the entire subvolume (full send)
 * - `btrfs send -p <parent> <snapshot>` generates only the block-level differences (incremental)
 * - Both sender and receiver must have the parent snapshot in read-only state
 * - The stream can be piped through compression (zstd) and encryption (openssl)
 * - `btrfs receive <path>` reconstructs the subvolume from the stream
 *
 * Pipeline architecture:
 *   Backup:  btrfs send [-p parent] snapshot | zstd | openssl enc | rclone rcat remote:path
 *   Restore: rclone cat remote:path | openssl dec | zstd -d | btrfs receive destination
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { execa, execaSync } from 'execa';
import { hasCommandSync } from '../core/store.js';
import { sudoExec, sudoExecSync, sudoNonInteractive } from '../util/sudo.js';

/**
 * Minimum size (bytes) a stored BTRFS stream must have to be considered a
 * real backup. Failed sends still splice a few dozen bytes through the pipe
 * before exiting 1, and those phantom streams must never be used as an
 * incremental parent or offered for restore. A real system snapshot stream
 * is orders of magnitude larger than 1 MiB, so this threshold is safe.
 */
export const MIN_VALID_STREAM_BYTES = 1024 * 1024;

/**
 * Check if BTRFS tools are available on the system.
 */
export function hasBtrfs() {
  return hasCommandSync('btrfs');
}

/**
 * Validate a schema-2 snapshot manifest: does it describe a real BTRFS stream
 * big enough to be an actual backup (not a failed few-byte send)?
 * @param {object} manifest
 * @returns {boolean}
 */
export function isValidBtrfsStreamManifest(manifest) {
  if (!manifest || manifest.schema !== 2) return false;
  const entry = (manifest.entries || []).find((e) => e.rel === 'btrfs.stream');
  return Boolean(entry && entry.size >= MIN_VALID_STREAM_BYTES && Array.isArray(entry.loc) && entry.loc.length > 0);
}

/**
 * Check if a given path is on a BTRFS filesystem.
 * @param {string} dirPath - Path to check (e.g., '/' for root filesystem)
 * @returns {Promise<boolean>}
 */
export async function isBtrfsFilesystem(dirPath) {
  try {
    const res = await execa('stat', ['-f', '-c', '%T', dirPath], { reject: false });
    return res.exitCode === 0 && res.stdout.trim().toLowerCase() === 'btrfs';
  } catch {
    return false;
  }
}

/**
 * Get the BTRFS device for a given mount point.
 * @param {string} mountPoint - e.g., '/'
 * @returns {Promise<string|null>} - Device path like '/dev/mapper/luks-xxx' or null
 */
export async function getBtrfsDevice(mountPoint = '/') {
  try {
    const res = await execa('findmnt', ['-n', '-o', 'SOURCE', mountPoint], { reject: false });
    if (res.exitCode !== 0) return null;
    // Remove subvolume notation like [/@] to get the raw device
    const device = res.stdout.trim().split('[')[0].trim();
    return device || null;
  } catch {
    return null;
  }
}

/**
 * Check if a path is actually a BTRFS subvolume (not just a directory on BTRFS).
 * @param {string} subvolPath
 * @param {object} opts - {privileged: 'interactive'|'noninteractive'}
 * @returns {Promise<boolean>}
 */
export async function isSubvolume(subvolPath, { privileged = 'noninteractive' } = {}) {
  if (!subvolPath || !fs.existsSync(subvolPath)) return false;
  try {
    const args = ['btrfs', 'subvolume', 'show', subvolPath];
    const res = process.env.PBB_SUDO_DIRECT === '1'
      ? await execa('btrfs', ['subvolume', 'show', subvolPath], { reject: false })
      : await sudoNonInteractive(args);
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Set a BTRFS subvolume to read-only mode (required for send).
 * @param {string} subvolPath - Path to the subvolume
 * @param {boolean} readOnly - true to set read-only, false to set writable
 * @param {object} opts - {privileged: 'interactive'|'noninteractive'}
 * @returns {Promise<void>}
 */
export async function setSubvolumeReadOnly(subvolPath, readOnly = true, { privileged = 'noninteractive' } = {}) {
  // First verify it's actually a subvolume
  const isSubvol = await isSubvolume(subvolPath);
  if (!isSubvol) {
    throw new Error(`${subvolPath} is not a BTRFS subvolume`);
  }
  
  const roValue = readOnly ? 'true' : 'false';
  const args = ['btrfs', 'property', 'set', '-ts', subvolPath, 'ro', roValue];
  const res = await sudoExec(args, { privileged });
  if (res.exitCode !== 0) {
    throw new Error(`Failed to set ${subvolPath} read-only=${readOnly}: ${res.stderr}`);
  }
}

/**
 * Check if a subvolume is read-only.
 * @param {string} subvolPath
 * @param {object} opts - {privileged: 'interactive'|'noninteractive'}
 * @returns {Promise<boolean>}
 */
export async function isSubvolumeReadOnly(subvolPath, { privileged = 'noninteractive' } = {}) {
  try {
    if (process.env.PBB_SUDO_DIRECT === '1') {
      const res = await execa('btrfs', ['property', 'get', '-ts', subvolPath, 'ro'], { reject: false });
      return res.exitCode === 0 && res.stdout.includes('ro=true');
    }
    const res = await sudoNonInteractive(['btrfs', 'property', 'get', '-ts', subvolPath, 'ro']);
    return res.exitCode === 0 && res.stdout.includes('ro=true');
  } catch {
    return false;
  }
}

/**
 * Resolve the actual BTRFS subvolume inside a Timeshift snapshot directory.
 *
 * Timeshift (BTRFS mode) stores every snapshot as:
 *   <snapshots>/<name>/@          <- read-only snapshot subvolume of "@"
 *   <snapshots>/<name>/info.json  <- control file
 *
 * Running `btrfs send` on the *container directory* fails with
 * "failed to get flags for subvolume ... Invalid argument" — the directory is
 * NOT a subvolume, only the inner "@" is. Some older/exotic layouts put the
 * snapshot content directly in a subvolume at the container path itself, so
 * both shapes are resolved here.
 *
 * @param {string} snapDir - Snapshot directory (container) already on disk
 * @param {object} opts - {privileged}
 * @returns {Promise<string|null>} - The subvolume path to send, or null when
 *   the snapshot is not backed by a subvolume at all (e.g. Timeshift rsync mode).
 */
export async function findSnapshotSubvolume(snapDir, { privileged = 'noninteractive' } = {}) {
  if (!snapDir || !fs.existsSync(snapDir)) return null;
  if (await isSubvolume(snapDir, { privileged })) return snapDir;
  const nested = path.join(snapDir, '@');
  if (fs.existsSync(nested) && (await isSubvolume(nested, { privileged }))) return nested;
  return null;
}

/**
 * Find the most recent successfully uploaded snapshot that can serve as a parent.
 * Looks for manifest files in the local manifests directory.
 *
 * A manifest is only trusted when it describes a REAL BTRFS stream: the send
 * must have completed and uploaded a stream at least MIN_VALID_STREAM_BYTES
 * in size. Failed sends (e.g. "not a subvolume") leave behind byte-sized
 * phantom manifests that would otherwise corrupt the incremental chain.
 *
 * @param {string} manifestsDir - Path to the manifests directory
 * @param {Array<{name:string}>} localSnapshots - List of local snapshots from timeshift
 * @returns {string|null} - The snapshot name to use as parent, or null for full send
 */
export function findLastUploadedSnapshot(manifestsDir, localSnapshots) {
  if (!fs.existsSync(manifestsDir)) return null;

  const manifestFiles = fs.readdirSync(manifestsDir)
    .filter(f => f.startsWith('snapshots-') && f.endsWith('.json'))
    .map(f => {
      const name = f.replace('snapshots-', '').replace('.json', '');
      return { name, file: f };
    })
    // Sort by name (which is timestamp-based) descending
    .sort((a, b) => b.name.localeCompare(a.name));

  // Find the most recent valid manifest whose snapshot still exists locally
  for (const { name, file } of manifestFiles) {
    const existsLocally = localSnapshots.some(s => s.name === name);
    if (!existsLocally) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(manifestsDir, file), 'utf8'));
      if (!isValidBtrfsStreamManifest(manifest)) continue;
    } catch {
      continue;
    }
    return name;
  }

  return null;
}

/**
 * Get the parent snapshot for an incremental send.
 * Reads the manifest to extract the parent reference.
 * @param {string} manifestPath
 * @returns {string|null}
 */
export function getSnapshotParent(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return manifest.parent || null;
  } catch {
    return null;
  }
}

/**
 * Create a BTRFS send stream.
 * @param {string} subvolPath - Path to the snapshot subvolume
 * @param {object} opts - {parent: string|null, privileged: 'interactive'|'noninteractive'}
 * @returns {Promise<{stream: ReadableStream, child: ChildProcess}>}
 */
export async function createSendStream(subvolPath, { parent = null, privileged = 'noninteractive' } = {}) {
  const args = ['btrfs', 'send'];
  if (parent) {
    args.push('-p', parent, subvolPath);
  } else {
    args.push(subvolPath);
  }

  // Spawn via sudo, return the stdout stream and the child process so callers
  // can detect errors (btrfs send exits non-zero when the path is not a subvolume).
  const sudoArgs = process.env.PBB_SUDO_DIRECT === '1'
    ? args
    : (privileged === 'interactive' ? ['sudo', '-E', ...args] : ['sudo', '-n', ...args]);

  const child = spawn(sudoArgs[0], sudoArgs.slice(1), {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return { stream: child.stdout, child };
}

/**
 * Estimate the size of a BTRFS send stream.
 * This is approximate because we can't know the exact compressed size beforehand.
 * We use `btrfs qgroup show` or fall back to `du` on the subvolume.
 * @param {string} subvolPath
 * @param {object} opts - {parent: string|null}
 * @returns {Promise<number>} - Estimated size in bytes
 */
export async function estimateSendSize(subvolPath, { parent = null } = {}) {
  try {
    // Try qgroup first for accurate size
    const res = await execa('sudo', ['btrfs', 'qgroup', 'show', '-r', '--raw', subvolPath], { reject: false });
    if (res.exitCode === 0) {
      // Parse output: columns are like "qgroupid referenced exclusive"
      const lines = res.stdout.trim().split('\n').slice(1); // skip header
      if (lines.length > 0) {
        const parts = lines[0].trim().split(/\s+/);
        if (parts.length >= 2) {
          const referenced = parseInt(parts[1], 10);
          if (!isNaN(referenced)) {
            // If there's a parent, estimate it's much smaller (just the diff)
            // This is a rough heuristic: real diff size varies widely
            return parent ? Math.floor(referenced * 0.1) : referenced;
          }
        }
      }
    }
  } catch {}

  // Fallback: use du (will be inaccurate for COW snapshots)
  try {
    const res = await execa('sudo', ['du', '-sb', subvolPath], { reject: false });
    if (res.exitCode === 0) {
      const size = parseInt(res.stdout.split('\t')[0], 10);
      if (!isNaN(size)) {
        return parent ? Math.floor(size * 0.1) : size;
      }
    }
  } catch {}

  // Ultimate fallback
  return parent ? 100 * 1024 * 1024 : 10 * 1024 * 1024 * 1024; // 100MB for incremental, 10GB for full
}

/**
 * Build the full compression + encryption + upload pipeline.
 * Returns a writable stream that accepts the raw btrfs send output.
 * @param {ReadableStream} sendStream - The btrfs send stdout
 * @param {object} opts - {compression, encryption, passphrase, remote, remotePath}
 * @returns {Promise<{child: ChildProcess, promise: Promise}>}
 */
export function createUploadPipeline(sendStream, { compression = true, encryption = false, passphrase = '', remote, remotePath }) {
  const pipeline = [];
  
  // Stage 1: Compression (zstd)
  if (compression) {
    const zstd = spawn('zstd', ['-T0', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
    pipeline.push(zstd);
  }

  // Stage 2: Encryption (openssl)
  if (encryption && passphrase) {
    const openssl = spawn('openssl', ['enc', '-e', '-aes256', '-pbkdf2', '-pass', `pass:${passphrase}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    pipeline.push(openssl);
  }

  // Stage 3: Upload (rclone rcat)
  const rclone = spawn(process.env.PBB_RCLONE || 'rclone', ['rcat', `${remote}:${remotePath}`], {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  pipeline.push(rclone);

  // Wire the pipeline: sendStream -> zstd -> openssl -> rclone
  let current = sendStream;
  for (const stage of pipeline) {
    current.pipe(stage.stdin);
    current = stage.stdout;
  }

  // Return a promise that resolves when the final stage completes
  const promise = new Promise((resolve, reject) => {
    const last = pipeline[pipeline.length - 1];
    last.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Pipeline failed with exit code ${code}`));
    });
    last.on('error', reject);
  });

  return { child: pipeline[pipeline.length - 1], promise };
}

/**
 * Build the reverse pipeline for restore: download -> decrypt -> decompress -> btrfs receive
 * @param {string} remote - Remote name
 * @param {string} remotePath - Path on the remote
 * @param {object} opts - {encryption, passphrase, compression, receiveDir, privileged}
 * @returns {Promise<void>}
 */
export async function createRestorePipeline({ remote, remotePath, encryption = false, passphrase = '', compression = true, receiveDir, privileged = 'noninteractive' }) {
  const pipeline = [];

  // Stage 1: Download (rclone cat)
  const rclone = spawn(process.env.PBB_RCLONE || 'rclone', ['cat', `${remote}:${remotePath}`], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  pipeline.push(rclone);

  // Stage 2: Decryption (openssl dec)
  if (encryption && passphrase) {
    const openssl = spawn('openssl', ['enc', '-d', '-aes256', '-pbkdf2', '-pass', `pass:${passphrase}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    pipeline.push(openssl);
  }

  // Stage 3: Decompression (zstd -d)
  if (compression) {
    const zstd = spawn('zstd', ['-d', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
    pipeline.push(zstd);
  }

  // Stage 4: btrfs receive (needs sudo)
  const sudoArgs = privileged === 'interactive' 
    ? ['sudo', '-E', 'btrfs', 'receive', receiveDir]
    : ['sudo', '-n', 'btrfs', 'receive', receiveDir];
  const receive = spawn(sudoArgs[0], sudoArgs.slice(1), {
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  pipeline.push(receive);

  // Wire the pipeline
  for (let i = 0; i < pipeline.length - 1; i++) {
    pipeline[i].stdout.pipe(pipeline[i + 1].stdin);
  }

  // Return a promise that resolves when receive completes
  return new Promise((resolve, reject) => {
    const last = pipeline[pipeline.length - 1];
    last.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Restore pipeline failed with exit code ${code}`));
    });
    last.on('error', reject);
  });
}
