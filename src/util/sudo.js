/**
 * Privileged execution.
 *
 *  - `sudoInteractive`  — runs `sudo <args>` with the terminal inherited so the
 *    password prompt is visible and Ctrl+C works (the gitswitch/theamify/
 *    warp-wizard pattern: callers stop any spinner FIRST).
 *  - `sudoNonInteractive` — runs `sudo -n <args>`; used by the background daemon
 *    so it can *never* hang waiting on a password. When the sudo timestamp has
 *    lapsed the job is deferred and retried later; a single interactive
 *    `parrot-blackbox snapshot now` (or any sudo use on the box) re-arms it.
 *
 * PBB_SUDO_DIRECT=1 (used by unit tests) bypasses sudo entirely.
 */

import { execa } from 'execa';

function sudoPrefix() {
  return process.env.PBB_SUDO_DIRECT === '1' ? [] : ['sudo'];
}

/** Interactive sudo baseline for injecting PBB_SUDO_DIRECT consistent with the rest. */
export async function sudoInteractive(args, { timeout = 0 } = {}) {
  const full = [...sudoPrefix(), ...args];
  const res = await execa(full[0], full.slice(1), { stdio: 'inherit', reject: false, timeout });
  if (res.exitCode !== 0) {
    throw new Error(`elevated command failed: ${args.join(' ')} (exit ${res.exitCode})`);
  }
  return res;
}

/**
 * Interactive sudo that CAPTURES stdout (needed for `timeshift --list` to feed
 * the parser) while keeping stdin inherited so the password prompt stays
 * usable — like the real sudo, which reads passwords from /dev/tty.
 */
export async function sudoInteractiveCapture(args, { timeout = 0 } = {}) {
  const full = [...sudoPrefix(), ...args];
  const res = await execa(full[0], full.slice(1), { stdin: 'inherit', reject: false, timeout });
  if (res.exitCode !== 0) {
    throw new Error(`elevated command failed: ${args.join(' ')} (exit ${res.exitCode})`);
  }
  return res;
}

/** Non-interactive sudo (daemon-safe). Returns execa result, never hangs. */
export async function sudoNonInteractive(args) {
  const full = process.env.PBB_SUDO_DIRECT === '1' ? args : ['sudo', '-n', ...args];
  const res = await execa(full[0], full.slice(1), { reject: false });
  return res;
}

/** Can the current process currently run privileged commands without a prompt? */
export async function sudoAvailable() {
  const res = await sudoNonInteractive(['true']);
  return res.exitCode === 0;
}