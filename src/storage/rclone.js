/**
 * Minimal rclone wrapper. Deliberately thin: every call goes through the
 * `rclone` binary (works for MEGA and Google Drive alike, and is trivially
 * stubbed inside the sandbox tests).
 */

import { execa, execaSync } from 'execa';
import { parseBytes } from '../util/misc.js';

const RCLONE = process.env.PBB_RCLONE || 'rclone';

function rejectFalse(args, opts = {}) {
  return execa(RCLONE, args, { reject: false, ...opts });
}

export async function hasRclone() {
  try {
    const res = await execa('bash', ['-c', `command -v ${RCLONE}`], { reject: false });
    return Boolean(res.stdout.trim());
  } catch {
    return false;
  }
}

/** `rclone about remote:` → {total, used, free} bytes (nulls when unknown). */
export async function aboutRemote(remote) {
  const res = await rejectFalse(['about', ...remote.split(' '), '--json']);
  if (res.exitCode !== 0) {
    return { total: null, used: null, free: null, error: res.stderr?.trim() || `exit ${res.exitCode}` };
  }
  try {
    const j = JSON.parse(res.stdout);
    const toNum = (v) => (typeof v === 'number' ? v : parseBytes(v));
    return { total: toNum(j.total), used: toNum(j.used), free: toNum(j.free) };
  } catch {
    return { total: null, used: null, free: null, error: 'unparsable about output' };
  }
}

/** List remote names. */
export async function listRemotes() {
  const res = await rejectFalse(['listremotes']);
  return res.stdout.split('\n').map((l) => l.trim().replace(/:$/, '')).filter(Boolean);
}

/** Recursive JSON listing of a remote path. */
export async function lsjson(remotePath, { recursive = true } = {}) {
  const args = ['lsjson', remotePath];
  if (recursive) args.push('--recursive');
  args.push('--json');
  const res = await rejectFalse(args);
  if (res.exitCode !== 0) return { ok: false, entries: [], error: res.stderr?.trim() };
  try {
    return { ok: true, entries: JSON.parse(res.stdout), error: null };
  } catch {
    return { ok: false, entries: [], error: 'unparsable lsjson output' };
  }
}

/** Copy a local dir tree into `remote:path` (path created implicitly). */
export async function copyDir(localDir, remotePath) {
  const res = await rejectFalse(['copy', localDir, remotePath]);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Copy a single local file to an exact remote path. */
export async function copyToFile(localFile, remotePath, { ignoreExisting = false } = {}) {
  const args = ['copyto', localFile, remotePath];
  if (ignoreExisting) args.push('--ignore-existing');
  const res = await rejectFalse(args);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Copy a batch of files using --files-from. */
export async function copyBatch(localDir, remotePath, filesFromPath) {
  const args = [
    'copy', localDir, remotePath,
    '--files-from', filesFromPath,
    '--transfers=16',
    '--checkers=16',
    '--fast-list'
  ];
  const res = await rejectFalse(args);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Create a remote directory. */
export async function mkdirRemote(remotePath) {
  const res = await rejectFalse(['mkdir', remotePath]);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Permanently delete a remote path. */
export async function purge(remotePath) {
  const res = await rejectFalse(['purge', remotePath]);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Fetch a small remote file's contents. */
export async function catRemote(remotePath) {
  const res = await rejectFalse(['cat', remotePath]);
  return { ok: res.exitCode === 0, stdout: res.stdout, error: res.stderr?.trim() };
}

/** Number of files (recursive) under a remote path; -1 on error. */
export async function remoteFileCount(remotePath) {
  const res = await lsjson(remotePath, { recursive: true });
  if (!res.ok) return -1;
  return res.entries.filter((e) => !e.IsDir).length;
}

export function rcloneVersion() {
  try {
    const res = execaSync(RCLONE, ['version'], { reject: false });
    return (res.stdout || res.stderr || '').trim();
  } catch {
    return null;
  }
}