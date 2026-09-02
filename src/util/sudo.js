/**
 * Privileged execution.
 *
 *  - `ensureSudo`          — prompts the user for their sudo password once,
 *    arming the sudo timestamp so all subsequent calls in the same session
 *    work without re-prompting (unless the timestamp expires after ~15 min).
 *    Call this EARLY (e.g. at wizard launch, before any privileged menu item).
 *  - `sudoExec`            — the ONE wrapper every caller should use. It picks
 *    interactive vs non-interactive automatically based on TTY, and pre-prompts
 *    for the password if the timestamp has lapsed.
 *  - `sudoInteractive`     — runs `sudo <args>` with the terminal inherited so the
 *    password prompt is visible and Ctrl+C works (the gitswitch/theamify/
 *    warp-wizard pattern: callers stop any spinner FIRST).
 *  - `sudoInteractiveCapture` — same but captures stdout (for `timeshift --list`).
 *  - `sudoNonInteractive`  — runs `sudo -n <args>`; used by the background daemon
 *    so it can *never* hang waiting on a password.
 *
 * PBB_SUDO_DIRECT=1 (used by unit tests) bypasses sudo entirely.
 */

import { execa, execaSync } from 'execa';

function sudoPrefix() {
  return process.env.PBB_SUDO_DIRECT === '1' ? [] : ['sudo'];
}

/**
 * Prompt the user for their sudo password (if needed) to arm the sudo
 * timestamp for this session. This is a no-op when:
 *  - already root (UID 0)
 *  - PBB_SUDO_DIRECT=1 (test mode)
 *  - sudo timestamp is already valid
 *
 * Safe to call multiple times — it checks `sudo -n true` first, and only
 * prompts when the timestamp has actually lapsed.
 */
export async function ensureSudo() {
  if (process.env.PBB_SUDO_DIRECT === '1') return true;
  if (process.getuid && process.getuid() === 0) return true;

  // Check if sudo timestamp is already valid (no prompt needed).
  const check = await execa('sudo', ['-n', 'true'], { reject: false });
  if (check.exitCode === 0) return true;

  // Timestamp lapsed — prompt the user for their password.
  // stdio: 'inherit' keeps the terminal so the user can type the password.
  console.log('\n🔐 Root privileges required — please enter your sudo password:\n');
  const res = await execa('sudo', ['-v'], { stdio: 'inherit', reject: false });
  if (res.exitCode !== 0) {
    throw new Error('sudo authentication failed — cannot continue without root privileges');
  }
  return true;
}

/**
 * Synchronous version of ensureSudo for use in sync code paths.
 * Returns true if sudo is available (timestamp valid or we're root).
 * Does NOT prompt — use ensureSudo() for that.
 */
export function isSudoArmed() {
  if (process.env.PBB_SUDO_DIRECT === '1') return true;
  if (process.getuid && process.getuid() === 0) return true;
  try {
    const res = execaSync('sudo', ['-n', 'true'], { reject: false });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Smart sudo wrapper — the preferred entry point for ALL privileged calls
 * from interactive (TTY) code paths. It:
 *  1. Checks if sudo is armed
 *  2. If not, prompts the user for password (if TTY)
 *  3. Then runs the command with sudo
 *
 * For daemon/non-interactive use, pass { interactive: false } — it will use
 * `sudo -n` and never hang on a prompt.
 */
export async function sudoExec(args, { interactive = true, capture = false, timeout = 0, env = {} } = {}) {
  if (interactive && process.stdin.isTTY) {
    // Ensure the sudo timestamp is armed before running the command.
    await ensureSudo();
    if (capture) {
      return sudoInteractiveCapture(args, { timeout, env });
    }
    return sudoInteractive(args, { timeout, env });
  }
  return sudoNonInteractive(args, { env });
}

/**
 * Synchronous sudo execution for code paths that MUST be sync (e.g. snapshotDirFor).
 * Requires that ensureSudo() was called earlier in the session.
 * Falls back to non-interactive sudo; if that fails, falls back to direct execution.
 */
export function sudoExecSync(args, { reject = false, env = {} } = {}) {
  if (process.env.PBB_SUDO_DIRECT === '1') {
    return execaSync(args[0], args.slice(1), { reject, env: { ...process.env, ...env } });
  }
  // Try with sudo (timestamp should be armed from earlier ensureSudo call)
  const full = ['sudo', '-n', ...args];
  const res = execaSync(full[0], full.slice(1), { reject: false, env: { ...process.env, ...env } });
  if (res.exitCode === 0) return res;
  // If sudo -n fails, try sudo with inherited stdio (will prompt if TTY available)
  if (process.stdin?.isTTY) {
    return execaSync('sudo', args, { reject, stdio: 'inherit', env: { ...process.env, ...env } });
  }
  // Last resort: try without sudo (some operations work unprivileged)
  return execaSync(args[0], args.slice(1), { reject: false, env: { ...process.env, ...env } });
}

/** Interactive sudo baseline for injecting PBB_SUDO_DIRECT consistent with the rest. */
export async function sudoInteractive(args, { timeout = 0, env = {} } = {}) {
  const full = [...sudoPrefix(), ...args];
  const res = await execa(full[0], full.slice(1), { stdio: 'inherit', reject: false, timeout, env: { ...process.env, ...env } });
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
export async function sudoInteractiveCapture(args, { timeout = 0, env = {} } = {}) {
  const full = [...sudoPrefix(), ...args];
  const res = await execa(full[0], full.slice(1), { stdin: 'inherit', reject: false, timeout, env: { ...process.env, ...env } });
  if (res.exitCode !== 0) {
    throw new Error(`elevated command failed: ${args.join(' ')} (exit ${res.exitCode})`);
  }
  return res;
}

/** Non-interactive sudo (daemon-safe). Returns execa result, never hangs. */
export async function sudoNonInteractive(args, { env = {} } = {}) {
  const full = process.env.PBB_SUDO_DIRECT === '1' ? args : ['sudo', '-n', ...args];
  const res = await execa(full[0], full.slice(1), { reject: false, env: { ...process.env, ...env } });
  return res;
}

/** Can the current process currently run privileged commands without a prompt? */
export async function sudoAvailable() {
  const res = await sudoNonInteractive(['true']);
  return res.exitCode === 0;
}