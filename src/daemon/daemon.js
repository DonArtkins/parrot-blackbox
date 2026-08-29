/**
 * Background daemon. Runs a detached process that polls the scheduler every
 * `pollIntervalSeconds`, and — the catch-up magic — watches for the
 * offline→online transition so any missed backups fire immediately once WiFi
 * returns, in order.
 *
 * `daemon start` spawns a detached process; `systemctl --user` integration
 * (`schedule install`) is the recommended always-on wrapper.
 */

import fs from 'node:fs';
import { execa } from 'execa';
import { loadConfig, journal, readJsonSafe } from '../core/store.js';
import { daemonLogFile, daemonPidFile, stateDir } from '../core/paths.js';
import { isOnline } from '../util/network.js';
import { runDueJobs } from './scheduler.js';

export function readDaemonPid() {
  const rec = readJsonSafe(daemonPidFile(), {});
  return rec.pid && Number.isInteger(rec.pid) ? rec.pid : null;
}

export function daemonRunning() {
  const pid = readDaemonPid();
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function startDaemon() {
  if (daemonRunning()) return { started: false, reason: 'already running' };
  const entry = process.argv[1];
  fs.mkdirSync(stateDir(), { recursive: true });
  const logFd = fs.openSync(daemonLogFile(), 'a');
  const child = execa(process.execPath, [entry, 'daemon', 'foreground'], {
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: process.env,
  });
  child.unref();
  fs.writeFileSync(daemonPidFile(), JSON.stringify({ pid: child.pid, at: Date.now() }));
  journal('daemon', `started pid=${child.pid}`);
  return { started: true, pid: child.pid };
}

export async function stopDaemon() {
  const pid = readDaemonPid();
  if (!pid) {
    fs.rmSync(daemonPidFile(), { force: true });
    return { stopped: false, reason: 'not running' };
  }
  try {
    process.kill(pid, 'SIGTERM');
    for (let i = 0; i < 20; i += 1) {
      if (!daemonRunning()) break;
      await sleep(150);
    }
  } catch {
    /* already gone */
  }
  fs.rmSync(daemonPidFile(), { force: true });
  journal('daemon', 'stopped');
  return { stopped: true, pid };
}

/** Long-running foreground loop (used by daemon and the systemd unit). */
export async function daemonForeground() {
  const ignore = () => {};
  process.on('SIGTERM', () => process.exit(0));
  process.on('SIGINT', () => process.exit(0));

  const cfg = loadConfig();
  const intervalMs = (cfg.daemon.pollIntervalSeconds || 60) * 1000;
  journal('daemon', `foreground loop started (poll ${intervalMs}ms)`);

  let online = await isOnline();
  journal('daemon', online ? 'network: online' : 'network: offline');

  for (;;) {
    const sleepPromise = sleep(intervalMs);
    try {
      await runDueJobs({ privileged: 'noninteractive', onProgress: ignore });
    } catch (e) {
      journal('daemon', `run error: ${e.message}`, 'error');
    }
    await sleepPromise;

    const nowOnline = await isOnline();
    if (!online && nowOnline) {
      journal('daemon', 'network came online — draining pending backups');
      try {
        await runDueJobs({ privileged: 'noninteractive', onProgress: ignore });
      } catch (e) {
        journal('daemon', `catch-up run error: ${e.message}`, 'error');
      }
    }
    online = nowOnline;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}