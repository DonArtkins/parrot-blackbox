/**
 * parrot-blackbox — paths & environment.
 *
 * Every mutable location is overridable so the whole tool can run inside a
 * sandbox (fake HOME / fake cloud / fake timeshift) without ever touching the
 * real filesystem or cloud accounts.
 */

import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const PKG_NAME = 'parrot-blackbox';

export function sandboxMode() {
  return process.env.PBB_SANDBOX === '1';
}

/** Root of all runtime state (journal, state, staging, manifests, logs). */
export function stateDir() {
  return (
    process.env.PBB_STATE_DIR ||
    path.join(process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state'), PKG_NAME)
  );
}

/** User-editable config file. */
export function configFile() {
  return (
    process.env.PBB_CONFIG_FILE ||
    path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), PKG_NAME, 'config.json')
  );
}

export function journalFile() {
  return path.join(stateDir(), 'journal.log');
}

export function lockFile() {
  return path.join(stateDir(), 'lock.json');
}

export function stateFile() {
  return path.join(stateDir(), 'state.json');
}

export function stagingDir() {
  return path.join(stateDir(), 'staging');
}

export function chunkDir() {
  return path.join(stateDir(), 'chunks');
}

export function manifestsDir() {
  return path.join(stateDir(), 'manifests');
}

export function daemonPidFile() {
  return path.join(stateDir(), 'daemon.pid');
}

export function daemonLogFile() {
  return path.join(stateDir(), 'daemon.log');
}

export function serviceFile() {
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'),
    'systemd',
    'user',
    `${PKG_NAME}.service`,
  );
}

/** Timeshift snapshot directory (used by the real tool and by sandbox stubs). */
export function timeshiftDir() {
  return process.env.PBB_TIMESHIFT_DIR || '/timeshift';
}

export function ensureStateDirs() {
  for (const dir of [
    stateDir(),
    configFileDir(configFile()),
    stagingDir(),
    chunkDir(),
    manifestsDir(),
  ]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function configFileDir(file) {
  return path.dirname(file);
}