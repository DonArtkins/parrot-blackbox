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

  // Is it already on local disk?
  const localSnaps = await listLocalSnapshots({ privileged }).catch(() => []);
  const localSnap = localSnaps.find((s) => s.name === id);

  if (!localSnap) {
    // Download to a staging dir first, then move into the Timeshift folder.
    const tmpRoot = path.join(stateDir(), 'restore', id);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    fs.mkdirSync(tmpRoot, { recursive: true });
    const res = await restoreArtifact(found.manifest, tmpRoot, { onProgress });
    journal('restore', `snapshot id=${id} downloaded ${res.bytes} bytes`);
    await placeIntoTimeshift(id, tmpRoot, cfg, privileged);
    fs.rmSync(tmpRoot, { recursive: true, force: true });
    console.log(`✔ Downloaded snapshot ${bytesHuman(res.bytes)} and registered it with Timeshift.`);
  }

  // Run the actual restore (interactive sudo → the password prompt is visible).
  console.log(`\nRestoring snapshot ${id} over the current system…\n`);
  await ensureSudo();
  const res = await sudoInteractive(['timeshift', '--restore', '--snapshot', id, '--yes']);
  if (res.exitCode !== 0) throw new Error(`timeshift --restore failed (exit ${res.exitCode})`);
  journal('restore', `snapshot id=${id} RESTORED`);
  console.log(`\n✔ Restore complete. REBOOT now to boot into the restored system.\n`);
  return { id };
}

/** Move a downloaded snapshot tree into the Timeshift snapshot folder (root-owned). */
async function placeIntoTimeshift(id, tmpRoot, cfg, privileged) {
  const base = determineSnapshotBase();
  const target = path.join(base, id);
  const cmd = `mkdir -p ${shq(base)} && rm -rf ${shq(target)} && cp -a ${shq(tmpRoot)}/. ${shq(target)}/ && chown -R root:root ${shq(target)}`;
  await ensureSudo();
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