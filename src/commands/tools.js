/**
 * System tools needed for snapshot backup & restore — detection + auto-install
 * (the gitswitch/theamify companion-tool pattern). Shared by the wizard menu,
 * the guided setup and the CLI.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { hasCommandSync } from '../core/store.js';

export const REQUIRED = [
  { bin: 'rclone', pkg: 'rclone', why: 'talks to MEGA / Google Drive (cloud storage)' },
  { bin: 'timeshift', pkg: 'timeshift', why: 'system snapshots — create AND restore' },
  { bin: 'git', pkg: 'git', why: 'skip GitHub-tracked files' },
  { bin: 'curl', pkg: 'curl', why: 'connectivity checks' },
];

/** Detect the distro package manager (apt/dnf/yum/pacman/zypper/apk). */
export function detectPackageManager() {
  const order = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'];
  return order.find((name) => hasCommandSync(name)) || null;
}

/** Tools that are missing on the system right now. */
export function missingTools() {
  return REQUIRED.filter((t) => !hasCommandSync(t.bin));
}

/**
 * Auto-install the tools the system needs. Prompts per missing tool, then runs
 * the package-manager install with an interactive sudo prompt (spinner released
 * first, Ctrl+C safe). Returns the freshly installed tool names.
 */
export async function ensureSystemTools() {
  const missing = missingTools();
  if (missing.length === 0) return [];

  const pm = detectPackageManager();
  if (!pm) {
    p.log.warn('No supported package manager detected (apt/dnf/yum/pacman/zypper/apk).');
    p.log.message(pc.dim(`Install manually, then re-run: sudo apt install ${missing.map((m) => m.pkg).join(' ')}`));
    return [];
  }

  const installed = [];
  for (const tool of missing) {
    const want = await p.confirm({
      message: `${pc.cyan(tool.bin)} is missing. Install it now? (needed for ${tool.why})`,
      initialValue: true,
    });
    if (p.isCancel(want) || !want) {
      p.log.warn(`Skipped ${pc.cyan(tool.bin)} — snapshot backup/restore may not work without it.`);
      continue;
    }
    p.log.step(`Installing ${pc.cyan(tool.bin)}…`);
    const s = p.spinner();
    s.start(`Installing ${tool.bin}…`);
    s.stop(''); // release the terminal first so the sudo password prompt is usable
    try {
      const args = pm === 'pacman' ? ['-S', '--noconfirm', tool.pkg] : [pm, 'install', '-y', tool.pkg];
      const res = await execa('sudo', args, { stdio: 'inherit', reject: false });
      if (res.exitCode === 0 && hasCommandSync(tool.bin)) {
        p.log.success(`${pc.cyan(tool.bin)} installed.`);
        installed.push(tool.bin);
      } else {
        p.log.warn(`Could not install ${pc.cyan(tool.bin)} — run: sudo ${args.join(' ')}`);
      }
    } catch (e) {
      p.log.warn(`${pc.cyan(tool.bin)} install failed: ${e.message}`);
    }
    s.stop('');
  }
  return installed;
}

/** Check & install; reports status. Returns still-missing tools. */
export async function runToolsCheck() {
  const missing = missingTools();
  if (missing.length === 0) {
    p.log.success(`All tools present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
    return [];
  }
  const installed = await ensureSystemTools();
  const still = missingTools();
  if (installed.length) p.log.success(`Installed: ${installed.join(', ')}`);
  if (still.length) p.log.warn(`Still missing: ${still.map((m) => m.bin).join(', ')}`);
  else p.log.success(`All required tools now present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
  if (still.includes('timeshift')) {
    p.log.message(pc.dim('Timeshift missing = snapshot backup & restore are unavailable. Install it before relying on snapshots.'));
  }
  return still;
}