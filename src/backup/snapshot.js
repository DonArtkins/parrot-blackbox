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
import { timeshiftDir, stateDir, configFile, manifestsDir } from '../core/paths.js';
import { iso, clock } from '../core/time.js';
import { refreshAccounts } from '../storage/accounts.js';
import { planAndPlace } from '../storage/allocator.js';
import { listArtifacts, removeArtifact } from '../storage/archive.js';
import { planPrune } from './retention.js';
import { sudoInteractive, sudoNonInteractive, sudoInteractiveCapture, sudoExecSync, ensureSudo } from '../util/sudo.js';

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
      await ensureSudo();
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
    await ensureSudo();
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
    await ensureSudo();
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
      sudoExecSync(['mkdir', '-p', mountPoint]);
      
      // Mount BTRFS root subvolume (subvolid=5 contains all subvolumes including snapshots)
      const mountResult = sudoExecSync(['mount', '-o', 'subvolid=5', device, mountPoint]);
      
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
        sudoExecSync(['umount', mountPoint]);
        sudoExecSync(['rmdir', mountPoint]);
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
      sudoExecSync(['umount', snapshot._tempMount]);
      sudoExecSync(['rmdir', snapshot._tempMount]);
      delete snapshot._tempMount;
    } catch {
      /* best effort */
    }
  }
}

/**
 * Run one snapshot generation: create → upload to the pool → prune old ones
 * BOTH locally and in the cloud.
 * 
 * V2.0 BTRFS send/receive pipeline:
 * 1. Check if root is on BTRFS
 * 2. Create read-only snapshot via Timeshift
 * 3. Find the most recent fully uploaded snapshot to use as parent (incremental)
 * 4. Generate BTRFS send stream (full or incremental)
 * 5. Pipe through zstd compression + optional encryption
 * 6. Stream directly to cloud via rclone rcat (chunked across accounts)
 * 7. Save manifest with parent chain tracking
 * 
 * Assumes the caller holds the scheduler lock.
 */
export async function runSnapshotBackup(cfg, state, { due, privileged = 'noninteractive', onProgress } = {}) {
  journal('snapshots', `start due=${due} privileged=${privileged} btrfs=${cfg.jobs.snapshots.btrfs?.enabled}`);
  const accounts = await refreshAccounts(cfg);
  
  if (accounts.length === 0) {
    throw new Error('no storage accounts configured — add one with `parrot-blackbox account add`');
  }

  const btrfsCfg = cfg.jobs.snapshots.btrfs || {};
  let useBtrfs = btrfsCfg.enabled !== false && !process.env.PBB_DISABLE_BTRFS;

  // Check for BTRFS if enabled
  if (useBtrfs) {
    const { hasBtrfs, isBtrfsFilesystem } = await import('./btrfs-send.js');
    if (!hasBtrfs()) {
      console.log('⚠ BTRFS tools not found — falling back to file-copy mode');
      useBtrfs = false;
    } else {
      const isBtrfs = await isBtrfsFilesystem('/');
      if (!isBtrfs) {
        console.log('⚠ Root filesystem is not BTRFS — falling back to file-copy mode');
        useBtrfs = false;
      }
    }
  }

  let created = null;
  const localSnaps = await listLocalSnapshots({ privileged });
  
  // Find the most recent fully uploaded snapshot to use as parent for incremental send
  let parentSnap = null;
  if (useBtrfs && btrfsCfg.incremental !== false) {
    const { findLastUploadedSnapshot } = await import('./btrfs-send.js');
    const parentName = findLastUploadedSnapshot(manifestsDir(), localSnaps);
    if (parentName) {
      parentSnap = localSnaps.find(s => s.name === parentName);
      if (parentSnap) {
        journal('snapshots', `found parent snapshot ${parentName} for incremental send`);
        console.log(`\n📊 Using incremental backup (parent: ${parentName})`);
      }
    }
  }
  
  // Check for incomplete uploads to resume
  for (let i = localSnaps.length - 1; i >= 0; i--) {
    const s = localSnaps[i];
    if (s.tags.includes('W') || (s.line && s.line.includes('parrot-blackbox'))) {
      const manifestFile = path.join(manifestsDir(), `snapshots-${s.name}.json`);
      const isUploaded = fs.existsSync(manifestFile);
      if (!isUploaded && !created) {
        created = s;
        journal('snapshots', `resuming upload for incomplete snapshot ${s.name}`);
        console.log(`\n⏳ Resuming incomplete upload for snapshot ${s.name}...`);
        break;
      }
    }
  }

  if (!created) {
    created = await createSnapshot({ comment: `parrot-blackbox ${due}`, privileged });
    console.log(`\n✓ Created snapshot ${created.name}`);
  }

  const dir = snapshotDirFor(created, { privileged });
  const parentDir = parentSnap ? snapshotDirFor(parentSnap, { privileged }) : null;

  let manifest;
  try {
    if (useBtrfs) {
      // V2 BTRFS send/receive path
      manifest = await uploadViaBtrfsSend({
        snapshot: created,
        snapshotDir: dir,
        parentSnapshot: parentSnap,
        parentDir,
        accounts,
        cfg,
        due,
        privileged,
        onProgress,
      });
    } else {
      // Legacy file-copy fallback (v2 behavior)
      manifest = await uploadViaFileCopy({
        snapshot: created,
        snapshotDir: dir,
        parentDir,
        accounts,
        cfg,
        due,
        privileged,
        onProgress,
      });
    }
  } catch (e) {
    // The local snapshot exists and is safe; the cloud upload failed.
    journal('snapshots', `upload failed for ${created.name}: ${e.message}`, 'error');
    cleanupSnapshotMount(created);
    throw e;
  } finally {
    cleanupSnapshotMount(created);
  }

  manifest.due = due;
  manifest.snapshot = created.name;
  manifest.parent = parentSnap?.name || null;

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
    parent: manifest.parent,
    createdAt: manifest.createdAt,
    totalSize: manifest.totalSize,
    originalSize: manifest.originalSize,
  };
  saveState(state);
  journal('snapshots', `done due=${due} snapshot=${created.name} bytes=${manifest.totalSize} parent=${manifest.parent || 'null'}`);

  return { due, snapshot: created.name, manifest, pruned };
}

/**
 * Upload a snapshot using BTRFS send/receive streaming.
 * Creates: btrfs send [-p parent] | zstd | [openssl] | rclone rcat (chunked)
 *
 * Uses the path resolved by snapshotDirFor() (which mounts the BTRFS root subvolume
 * at a temporary mount point) so that `btrfs send` receives an actual subvolume path,
 * not a directory inside a regular mount.
 */
async function uploadViaBtrfsSend({ snapshot, snapshotDir, parentSnapshot, parentDir, accounts, cfg, due, privileged, onProgress }) {
  const { createSendStream, estimateSendSize } = await import('./btrfs-send.js');
  const { planAndPlaceStream } = await import('../storage/allocator.js');

  // snapshotDir was resolved by snapshotDirFor() — it is the real subvolume path
  // (e.g. /run/parrot-blackbox-btrfs-<ts>/timeshift-btrfs/snapshots/<name>).
  // Use it directly; do NOT fall back to a hardcoded absolute path.
  const subvolPath = snapshotDir;
  const parentSubvolPath = parentDir || null;

  journal('snapshots', `btrfs send subvolPath=${subvolPath} parent=${parentSubvolPath || 'null'}`);

  // Estimate size for progress reporting
  const estimatedSize = await estimateSendSize(subvolPath, { parent: parentSubvolPath });
  const btrfsCfg = cfg.jobs.snapshots.btrfs || {};

  console.log(`\n📤 Uploading ${parentSubvolPath ? 'incremental' : 'full'} BTRFS stream...`);
  console.log(`   Estimated size: ${(estimatedSize / (1024 ** 3)).toFixed(2)} GiB`);
  if (btrfsCfg.compression !== false) console.log(`   Compression: zstd enabled`);
  if (btrfsCfg.encryption && cfg.storage?.encryptionPassphrase) console.log(`   Encryption: AES-256 enabled`);

  // Create the BTRFS send stream — returns {stream, child} so we can detect errors
  const { stream: sendStream, child: sendChild } = await createSendStream(subvolPath, {
    parent: parentSubvolPath,
    privileged,
  });

  // Collect any stderr from btrfs send for better error messages
  const sendStderr = [];
  sendChild.stderr?.on('data', (d) => sendStderr.push(d));

  // Build compression / encryption pipeline
  const { spawn } = await import('node:child_process');
  const pipeline = [sendChild]; // include send process so we wait on its exit too
  let currentStream = sendStream;

  // Stage 1: Compression
  if (btrfsCfg.compression !== false) {
    const zstd = spawn('zstd', ['-T0', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
    currentStream.pipe(zstd.stdin);
    pipeline.push(zstd);
    currentStream = zstd.stdout;
  }

  // Stage 2: Encryption
  if (btrfsCfg.encryption && cfg.storage?.encryptionPassphrase) {
    const openssl = spawn('openssl', ['enc', '-e', '-aes256', '-pbkdf2', '-pass', `pass:${cfg.storage.encryptionPassphrase}`], {
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    currentStream.pipe(openssl.stdin);
    pipeline.push(openssl);
    currentStream = openssl.stdout;
  }

  // Stage 3: Stream to cloud via allocator's planAndPlaceStream (handles chunking across accounts)
  const manifestPromise = planAndPlaceStream(currentStream, {
    kind: 'snapshots',
    id: snapshot.name,
    accounts,
    remoteRoot: cfg.storage.remoteRoot,
    chunkSize: cfg.storage.chunkSize,
    onProgress,
    originalSize: estimatedSize,
  });

  // Wait for all pipeline stages (including btrfs send itself) to exit cleanly
  await Promise.all(pipeline.map((proc) =>
    new Promise((resolve, reject) => {
      proc.on('close', (code) => {
        if (code === 0 || code === null) {
          resolve();
        } else {
          const stderr = Buffer.concat(sendStderr).toString().trim();
          reject(new Error(
            proc === sendChild
              ? `btrfs send failed (exit ${code})${stderr ? ': ' + stderr : ''} — is ${subvolPath} a BTRFS subvolume?`
              : `Pipeline stage failed (exit ${code})`
          ));
        }
      });
      proc.on('error', reject);
    })
  ));

  const manifest = await manifestPromise;

  // Save manifest locally
  const manifestPath = path.join(manifestsDir(), `snapshots-${snapshot.name}.json`);
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

  console.log(`\n✓ Uploaded ${(manifest.totalSize / (1024 ** 3)).toFixed(2)} GiB to cloud`);
  return manifest;
}

/**
 * Legacy file-copy upload (v2 fallback for non-BTRFS systems).
 */
async function uploadViaFileCopy({ snapshot, snapshotDir, parentDir, accounts, cfg, due, privileged, onProgress }) {
  console.log(`\n📤 Uploading snapshot via file copy (legacy mode)...`);
  
  const bin = process.argv[1] || 'parrot-blackbox';
  const outPath = path.join(stateDir(), `manifest-${snapshot.name}.json`);
  const envVars = {
    HOME: process.env.HOME,
    PBB_STATE_DIR: stateDir(),
    PBB_CONFIG_FILE: configFile(),
    PBB_PARENT_DIR: parentDir || '',
  };
  const cmdArgs = [process.execPath, bin, '_internal_upload', snapshotDir, 'snapshots', snapshot.name, cfg.storage.remoteRoot, String(cfg.storage.chunkSize), outPath];
  const args = process.env.PBB_SUDO_DIRECT === '1' ? cmdArgs : ['-E', ...cmdArgs];
  
  let res;
  if (privileged === 'interactive') {
    await ensureSudo();
    res = await sudoInteractive(args, { env: envVars });
  } else {
    res = await sudoNonInteractive(args, { env: envVars });
  }
  
  if (res.exitCode !== 0) {
    throw new Error(`upload failed (exit ${res.exitCode})`);
  }
  
  const manifestStr = fs.readFileSync(outPath, 'utf8');
  const manifest = JSON.parse(manifestStr);
  try { fs.rmSync(outPath, {force: true}); } catch {}
  
  return manifest;
}

/**
 * Enforce the snapshot retention limit across local disk AND cloud.
 * V2 parent-chain awareness: don't delete a snapshot if it's the parent of a newer one still in the keep window.
 * Returns the list of snapshot names pruned.
 */
export async function pruneSnapshots(cfg, accounts, { privileged = 'noninteractive' } = {}) {
  const local = await listLocalSnapshots({ privileged }).catch(() => []);
  const cloud = await listArtifacts('snapshots', accounts, cfg.storage.remoteRoot);

  const localNames = local.map((s) => s.name);
  const cloudNames = cloud.map((c) => c.id);
  const union = [...new Set([...localNames, ...cloudNames])];

  // Build parent chain map from manifests
  const parentMap = new Map(); // snapshot -> parent
  const manifestDir = manifestsDir();
  if (fs.existsSync(manifestDir)) {
    for (const file of fs.readdirSync(manifestDir)) {
      if (file.startsWith('snapshots-') && file.endsWith('.json')) {
        try {
          const manifest = JSON.parse(fs.readFileSync(path.join(manifestDir, file), 'utf8'));
          if (manifest.snapshot && manifest.parent) {
            parentMap.set(manifest.snapshot, manifest.parent);
          }
        } catch {}
      }
    }
  }

  const { prune } = planPrune(union, cfg.jobs.snapshots.keep);
  
  // Filter out snapshots that are parents of kept snapshots
  const keptSet = new Set(union.filter(name => !prune.includes(name)));
  const protectedParents = new Set();
  for (const kept of keptSet) {
    let current = kept;
    while (current) {
      const parent = parentMap.get(current);
      if (parent && union.includes(parent)) {
        protectedParents.add(parent);
        current = parent;
      } else {
        break;
      }
    }
  }

  const safeToPrune = prune.filter(name => !protectedParents.has(name));
  const pruned = [];
  
  for (const name of safeToPrune) {
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
  
  if (protectedParents.size > 0) {
    journal('snapshots', `protected ${protectedParents.size} parent snapshots from pruning`, 'info');
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