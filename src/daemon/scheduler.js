/**
 * The scheduler — the crash-proof heart.
 *
 * On every tick (daemon poll, cron run, or manual `run`) it:
 *   1. advances the due window (computing every missed calendar due),
 *   2. if anything is pending but the machine is offline → defer (retry later),
 *   3. otherwise drains pending dues OLDEST FIRST (files before snapshots),
 *   4. prunes old generations (files + snapshots, local & cloud together),
 *   5. persists state atomically after every job.
 * A crash anywhere leaves the journal with an unfinished entry and the pending
 * list intact, so the next tick simply retries. The lock prevents the daemon
 * and a manual `force` from colliding.
 */

import { withLock } from '../core/lock.js';
import { loadConfig, loadState, saveState, journal } from '../core/store.js';
import { iso, clock, advancePending } from '../core/time.js';
import { isOnline } from '../util/network.js';
import { runFilesBackup } from '../backup/workspace.js';
import { runSnapshotBackup, SudoDeferredError } from '../backup/snapshot.js';

/**
 * @param {object} opts
 *  force: bool          run a file backup NOW regardless of the schedule
 *  privileged: 'noninteractive'|'interactive'
 *  onProgress: fn
 * @returns {Promise<object>} {ok, deferred, report}
 */
export async function runDueJobs({ force = false, privileged = 'noninteractive', onProgress } = {}) {
  return withLock(async () => {
    const cfg = loadConfig();
    const state = loadState();
    const now = clock();
    const report = [];

    if (force) {
      // Manual force: run EVERY enabled job now (default = the weekly snapshot).
      const due = iso(now);
      if (cfg.jobs.files.enabled) {
        try {
          const r = await runFilesBackup(cfg, state, { due, onProgress });
          report.push({ type: 'files', due, ok: true, size: r.sizeBytes, pruned: r.pruned });
        } catch (e) {
          journal('files', `force failed due=${due}: ${e.message}`, 'error');
          report.push({ type: 'files', due, ok: false, error: e.message });
        }
      }
      if (cfg.jobs.snapshots.enabled) {
        try {
          const r = await runSnapshotBackup(cfg, state, { due, privileged, onProgress });
          report.push({ type: 'snapshots', due, ok: true, snapshot: r.snapshot, size: r.manifest?.totalSize, pruned: r.pruned });
        } catch (e) {
          const isSudo = e instanceof SudoDeferredError;
          journal('snapshots', `force failed due=${due}: ${e.message}`, isSudo ? 'info' : 'error');
          report.push({ type: 'snapshots', due, ok: isSudo, deferred: isSudo, error: e.message });
        }
      }
      return { ok: true, deferred: false, report };
    }

    // 1. Advance due windows for enabled jobs.
    let advanced = false;
    for (const type of ['files', 'snapshots']) {
      const jc = cfg.jobs[type];
      const js = state.jobs[type];
      if (!jc || !jc.enabled || !js) continue;
      const res = advancePending(js, jc, now);
      if (res.lastDue !== js.lastDue) {
        js.lastDue = res.lastDue;
        advanced = true;
      }
      js.pending = res.pending;
      if (res.dropped > 0) {
        journal(type, `dropped ${res.dropped} stale overdue dues (catch-up limit ${jc.catchUpLimit})`, 'warn');
      }
    }
    if (advanced) saveState(state);

    const pendingFiles = (state?.jobs?.files) ? [...state.jobs.files.pending] : [];
    const pendingSnaps = (state?.jobs?.snapshots) ? [...state.jobs.snapshots.pending] : [];

    if (pendingFiles.length === 0 && pendingSnaps.length === 0) {
      return { ok: true, deferred: false, report };
    }

    // 2. Network gate — defer everything if we are offline.
    if (!(await isOnline())) {
      journal('daemon', `offline — deferring ${pendingFiles.length} file + ${pendingSnaps.length} snapshot due(s)`);
      for (const type of ['files', 'snapshots']) {
        if (state.jobs[type]) {
          state.jobs[type].lastStatus = 'deferred';
          state.jobs[type].lastRunAt = iso(now);
        }
      }
      saveState(state);
      return { ok: true, deferred: true, report };
    }

    // 3. Drain pending files first (oldest → newest), then snapshots.
    for (const due of pendingFiles) {
      try {
        const r = await runFilesBackup(cfg, state, { due, onProgress });
        report.push({ type: 'files', due, ok: true, size: r.sizeBytes, pruned: r.pruned });
      } catch (e) {
        journal('files', `failed due=${due}: ${e.message}`, 'error');
        state.jobs.files.lastStatus = 'error';
        state.jobs.files.lastError = e.message;
        state.jobs.files.lastRunAt = iso(now);
        saveState(state);
        report.push({ type: 'files', due, ok: false, error: e.message });
        break; // stop draining; the rest retry on the next tick
      }
    }

    for (const due of pendingSnaps) {
      try {
        const r = await runSnapshotBackup(cfg, state, { due, privileged, onProgress });
        report.push({ type: 'snapshots', due, ok: true, snapshot: r.snapshot, size: r.manifest?.totalSize, pruned: r.pruned });
      } catch (e) {
        const isSudo = e instanceof SudoDeferredError;
        journal('snapshots', `failed due=${due}: ${e.message}`, isSudo ? 'info' : 'error');
        state.jobs.snapshots.lastStatus = isSudo ? 'deferred' : 'error';
        state.jobs.snapshots.lastError = e.message;
        state.jobs.snapshots.lastRunAt = iso(now);
        saveState(state);
        // A deferred sudo job is NOT a hard failure — it retries later when the
        // sudo timestamp is re-armed (e.g. by an interactive `snapshot now`).
        report.push({ type: 'snapshots', due, ok: isSudo, deferred: isSudo, snapshot: null, error: e.message });
        if (!isSudo) break; // hard errors stop draining; soft deferrals keep going
      }
    }

    return { ok: true, deferred: false, report };
  });
}