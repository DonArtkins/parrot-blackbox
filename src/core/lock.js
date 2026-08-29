/**
 * Scheduler lock — prevents a manual `force` from colliding with the daemon.
 * Locks are reclaimed automatically when their PID is dead or the TTL passed.
 */

import fs from 'node:fs';
import { lockFile, ensureStateDirs } from './paths.js';
import { readJsonSafe } from './store.js';

export class LockError extends Error {}

export function releaseLock() {
  try {
    fs.rmSync(lockFile(), { force: true });
  } catch {
    /* best effort */
  }
}

function pidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Acquire the lock. Throws LockError when another live run holds it. */
export function acquireLock({ ttlMs = Number(process.env.PBB_LOCK_TTL_MS || 6 * 3_600_000) } = {}) {
  ensureStateDirs();
  let attempts = 0;
  while (attempts < 2) {
    attempts += 1;
    try {
      const fd = fs.openSync(lockFile(), 'wx');
      const record = { pid: process.pid, at: Date.now(), host: process.env.HOSTNAME || 'localhost' };
      fs.writeFileSync(fd, JSON.stringify(record));
      fs.closeSync(fd);
      return record;
    } catch (err) {
      if (err.code !== 'EEXIST') throw new LockError(`cannot create lock: ${err.message}`);
      const existing = readJsonSafe(lockFile(), {});
      const stale =
        !existing.pid || !pidAlive(existing.pid) || Number(existing.at) + ttlMs < Date.now();
      if (stale) {
        fs.rmSync(lockFile(), { force: true });
        continue; // one reclaim attempt
      }
      throw new LockError(
        `another run is already in progress (pid ${existing.pid} since ${new Date(existing.at).toISOString()})`,
      );
    }
  }
  throw new LockError('could not acquire lock');
}

/** Run `fn` inside the lock; always releases afterwards. */
export async function withLock(fn, opts) {
  const lock = acquireLock(opts);
  try {
    return await fn(lock);
  } finally {
    releaseLock();
  }
}