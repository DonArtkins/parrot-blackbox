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

/** Build args for `rclone lsjson`. IMPORTANT: lsjson outputs JSON natively and
 *  has NO `--json` flag — passing one makes real rclone fail with
 *  "unknown flag: --json", which silently emptied every cloud listing. */
export function lsjsonArgs(remotePath, { recursive = true } = {}) {
  const args = ['lsjson', remotePath];
  if (recursive) args.push('--recursive');
  return args;
}

/** Recursive JSON listing of a remote path. */
export async function lsjson(remotePath, { recursive = true } = {}) {
  const res = await rejectFalse(lsjsonArgs(remotePath, { recursive }));
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
export async function copyToFile(localFile, remotePath, { ignoreExisting = false, force = false } = {}) {
  const args = ['copyto', localFile, remotePath];
  if (ignoreExisting) args.push('--ignore-existing');
  if (force) args.push('--ignore-times'); // overwrite even a "newer" destination
  const res = await rejectFalse(args);
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Copy a batch of files using --files-from. When `onProgress` is supplied we
 *  ask rclone for live transfer stats and parse its `Transferred: X / Y` frames
 *  so the caller receives byte-level progress as `{ done, total }` (bytes). */
export async function copyBatch(localDir, remotePath, filesFromPath, { onProgress } = {}) {
  const args = [
    'copy', localDir, remotePath,
    '--files-from', filesFromPath,
    '--transfers=16',
    '--checkers=16',
    '--fast-list',
  ];
  if (typeof onProgress === 'function') {
    // rclone emits periodic frames even when stdout is not a TTY (pipelines).
    args.push('--progress', '--stats=1s');
  }
  const child = rejectFalse(args);
  if (typeof onProgress === 'function') {
    await consumeProgress(child, onProgress);
  }
  const res = await child;
  return { ok: res.exitCode === 0, exitCode: res.exitCode, error: res.stderr?.trim() };
}

/** Consume rclone's --progress stdout, emitting parsed byte counts per frame. */
async function consumeProgress(child, onProgress) {
  let buf = '';
  for await (const chunk of child.stdout) {
    buf += chunk;
    const frames = buf.split(/[\r\n]+/);
    buf = frames.pop(); // keep a partial trailing frame for the next chunk
    for (const frame of frames) {
      const p = parseTransferFrame(frame);
      if (p) onProgress(p);
    }
  }
  const tail = parseTransferFrame(buf);
  if (tail) onProgress(tail);
}

/**
 * Extract the BYTE `Transferred: <done> / <total>` from an rclone progress
 * frame. This deliberately requires a size unit (KiB/MiB/GiB/…) so the separate
 * FILE-count `Transferred: 3 / 5` line is never mistaken for bytes.
 * @returns {{done:number,total:number}|null}
 */
export function parseTransferFrame(frame) {
  const m = /\bTransferred:\s+([\d.]+\s*(?:[kmgt]i?)?b)\s*\/\s*([\d.]+\s*(?:[kmgt]i?)?b)/i.exec(frame);
  if (!m) return null;
  const done = parseBytes(m[1]);
  const total = parseBytes(m[2]);
  return done !== null && total !== null ? { done, total } : null;
}

/** Download a batch of files using --files-from (reverse of copyBatch). */
export async function downloadBatch(remotePath, localDir, filesFromPath) {
  const args = [
    'copy', remotePath, localDir,
    '--files-from', filesFromPath,
    '--transfers=16',
    '--checkers=16',
    '--fast-list',
    // Restore MUST reproduce the artifact exactly. rclone's default skips a
    // destination file whose mtime looks newer (exactly what fresh-install
    // default files are), which silently leaves "conflicts" — your backed-up
    // version never comes back. --ignore-times forces the overwrite.
    '--ignore-times',
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