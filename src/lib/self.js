/**
 * Self-update — mirrors the gitswitch/theamify/warp-wizard pattern.
 *
 * The LATEST version always comes from the npm registry (`npm view`), never
 * from local state, so stale installs are caught and updated on launch.
 */

import { execa } from 'execa';
import pc from 'picocolors';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

export const NPM_NAME = pkg.name; // parrot-blackbox

export function compareVersions(a, b) {
  const pa = String(a || '').split('.').map((n) => parseInt(n, 10) || 0);
  const pb = String(b || '').split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] || 0) - (pb[i] || 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/** Query npm for the latest published version of this package (network). */
export async function getLatestVersion() {
  try {
    const res = await execa('npm', ['view', NPM_NAME, 'version'], { reject: false });
    const v = (res.stdout || '').trim();
    return /^\d+\.\d+\.\d+/.test(v) ? v : null;
  } catch {
    return null; // offline / npm missing — never crash the wizard on this
  }
}

/** Compare the running local version to the latest published one. */
export async function checkForUpdate() {
  const latest = await getLatestVersion();
  if (!latest) return { outdated: false, latest: null, current: pkg.version };
  return { outdated: compareVersions(latest, pkg.version) > 0, latest, current: pkg.version };
}

/**
 * Offer to self-update via `npm install -g`. Returns true when updated.
 * Interactive; nothing happens when not on a TTY.
 */
export async function promptSelfUpdate() {
  const { outdated, latest, current } = await checkForUpdate();
  if (!outdated || !latest) return false;

  const p = await import('@clack/prompts');
  if (!process.stdin.isTTY) {
    p.log.message(pc.dim(`Update available: v${latest} (you have v${current}). Run: npm install -g ${NPM_NAME}@latest`));
    return false;
  }
  const want = await p.confirm({
    message: `A new version (${pc.cyan('v' + latest)}) is available — you have ${pc.dim('v' + current)}. Update now?`,
    initialValue: true,
  });
  if (p.isCancel(want) || !want) {
    p.log.message(pc.dim(`Keeping v${current} — update later with: npm install -g ${NPM_NAME}@latest`));
    return false;
  }

  // Release the terminal so npm's progress & any prompts are visible/interruptible.
  console.log();
  const res = await execa('npm', ['install', '-g', `${NPM_NAME}@latest`], { stdio: 'inherit', reject: false });
  if (res.exitCode !== 0) {
    p.log.warn('Update failed. You can retry with: npm install -g ' + NPM_NAME + '@latest');
    return false;
  }
  p.log.success(`Updated to v${latest}. ` + 'Run `parrot-blackbox` again to use the new version.');
  return true;
}

/**
 * `update` command — always check npm and report, prompt to install when
 * outdated (or when `force` is set even if already current).
 */
export async function runSelfUpdate({ force = false } = {}) {
  const p = await import('@clack/prompts');
  const { latest, current } = await checkForUpdate();
  if (!latest) {
    p.log.warn(`Could not reach the npm registry — you are on v${current}. Try: npm install -g ${NPM_NAME}@latest`);
    return false;
  }
  const outdated = compareVersions(latest, current) > 0;
  if (!outdated && !force) p.log.success(`You are on the latest version (v${current}).`);
  if (!outdated && !force) return false;
  if (outdated) p.log.info(`${pc.cyan('v' + latest)} available — you have ${pc.dim('v' + current)}.`);
  if (!process.stdin.isTTY) {
    p.log.message(outdated
      ? pc.dim(`Update to v${latest} with: npm install -g ${NPM_NAME}@latest`)
      : pc.dim(`You are on v${current}. Run: npm install -g ${NPM_NAME}@latest --force to reinstall`));
    return false;
  }
  const want = await p.confirm({ message: `Update parrot-blackbox to v${latest} now?`, initialValue: true });
  if (p.isCancel(want) || !want) { p.log.message(pc.dim('Update skipped.')); return false; }
  console.log();
  const res = await execa('npm', ['install', '-g', `${NPM_NAME}@latest`], { stdio: 'inherit', reject: false });
  if (res.exitCode !== 0) {
    p.log.warn('Update failed. You can retry with: npm install -g ' + NPM_NAME + '@latest');
    return false;
  }
  p.log.success(`Updated to v${latest}. Restart parrot-blackbox to use the new version.`);
  return true;
}

/** Fully remove the npm package (used by uninstall). */
export async function selfUninstall() {
  const p = await import('@clack/prompts');
  console.log();
  const res = await execa('npm', ['uninstall', '-g', NPM_NAME], { stdio: 'inherit', reject: false });
  if (res.exitCode === 0) {
    p.log.success(`${NPM_NAME} removed. The parrot-blackbox command is no longer available.`);
    return true;
  }
  p.log.warn(`Could not uninstall ${NPM_NAME} automatically. Run: npm uninstall -g ${NPM_NAME}`);
  return false;
}