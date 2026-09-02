/**
 * Interactive setup wizard (default command, like gitswitch/theamify).
 * Walks: tools check + AUTO-INSTALL → storage pool (guided MEGA/Drive remote
 * creation, no raw 68-option rclone menus) → schedule → always-on service →
 * optional first snapshot.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { loadConfig, journal, hasCommandSync } from '../core/store.js';
import { ensureSudo, sudoInteractive } from '../util/sudo.js';
import { listAccounts, refreshAccounts, poolSummary } from '../storage/accounts.js';
import { installService } from './service.js';
import { runDueJobs } from '../daemon/scheduler.js';
import { isOnline } from '../util/network.js';
import { bytesHuman } from '../util/misc.js';
import { guidedRemoteAdd, registerRemotesAsAccounts } from './remote.js';

const REQUIRED = [
  { bin: 'rclone', pkg: 'rclone', why: 'talks to MEGA / Google Drive (cloud storage)' },
  { bin: 'timeshift', pkg: 'timeshift', why: 'system snapshots — create AND restore' },
  { bin: 'git', pkg: 'git', why: 'skip GitHub-tracked files' },
  { bin: 'curl', pkg: 'curl', why: 'connectivity checks' },
];

/** Detect the distro package manager (apt/dnf/yum/pacman/zypper/apk). */
function detectPackageManager() {
  const order = ['apt-get', 'dnf', 'yum', 'pacman', 'zypper', 'apk'];
  return order.find((name) => hasCommandSync(name)) || null;
}

/** Auto-install the tools needed for snapshot backup & restore (theamify-style). */
async function ensureSystemTools() {
  const missing = REQUIRED.filter((t) => !hasCommandSync(t.bin));
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
    if (p.isCancel(want)) { p.cancel('Aborted.'); process.exit(0); }
    if (!want) {
      p.log.warn(`Skipped ${pc.cyan(tool.bin)} — snapshot backup/restore may not work without it.`);
      continue;
    }
    p.log.step(`Installing ${pc.cyan(tool.bin)}…`);
    const s = p.spinner();
    s.start(`Installing ${tool.bin}…`);
    s.stop('');
    try {
      const args = pm === 'pacman' ? ['-S', '--noconfirm', tool.pkg] : [pm, 'install', '-y', tool.pkg];
      await ensureSudo();
      const res = await sudoInteractive([pm, ...args.slice(1)]);
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

/** Wizard step: connect cloud accounts (guided or manual). */
async function storagePoolStep() {
  const existing = listAccounts();
  p.note(
    'One MEGA or Google Drive login = one rclone remote = one pool account.',
    'Step 2/5 — storage pool',
  );
  const action = await p.select({
    message: existing.length
      ? `You already have ${existing.length} account(s). What next?`
      : 'No accounts yet — how do you want to add your first cloud account?',
    options: [
      { value: 'guided', label: 'Add a cloud account (guided — parrot-blackbox sets up rclone for you)', hint: 'recommended' },
      { value: 'manual', label: 'Configure rclone myself, then register the remote' },
      existing.length ? { value: 'skip', label: 'Skip — accounts look fine' } : { value: 'skip', label: 'Skip for now' },
    ],
  });
  if (p.isCancel(action)) { p.cancel('Aborted.'); process.exit(0); }

  if (action === 'guided') {
    const wantMore = true;
    while (wantMore) {
      const provider = await p.select({
        message: 'Which provider?',
        options: [
          { value: 'mega', label: 'MEGA (20 GB free tier)' },
          { value: 'gdrive', label: 'Google Drive (15 GB free tier)' },
        ],
      });
      if (p.isCancel(provider)) break;
      const res = await guidedRemoteAdd({ provider });
      if (res.ok) p.log.success(`✔ ${pc.bold(res.name)} (${res.provider}) added to the pool.`);
      else if (res.error) p.log.warn(res.error);
      if (res.cancelled) break;
      const another = await p.confirm({ message: 'Add another account?', initialValue: true });
      if (p.isCancel(another) || !another) break;
    }
  } else if (action === 'manual') {
    p.log.step('Starting rclone config — choose 39 (Mega) or 24 (Google Drive). Then come back.');
    await execa('rclone', ['config'], { stdio: 'inherit' });
    await registerRemotesAsAccounts();
  } else {
    p.log.message(pc.dim('Carrying on with the accounts you have.'));
  }
}

/** Wizard step: schedule overview. */
async function scheduleStep() {
  const cfg = loadConfig();
  p.note(
    `   Snapshot backup: ${pc.bold('every Saturday at 22:00')} (keep ${cfg.jobs.snapshots.keep}, local + cloud)\n` +
    `   File backups   : ${cfg.jobs.files.enabled ? pc.bold('daily 22:00 (enabled)') + ` (keep ${cfg.jobs.files.keep})` : pc.dim('disabled by default — opt-in, storage-conscious')}\n` +
    `   Missed backups : caught up automatically in order when WiFi returns`,
    'Step 3/5 — schedule',
  );
}

/** Wizard step: install the always-on service. */
async function serviceStep() {
  const install = await p.confirm({
    message: 'Install the always-on background service (systemd / cron fallback)?',
    initialValue: true,
  });
  if (p.isCancel(install)) { p.cancel('Aborted.'); process.exit(0); }
  if (install) {
    const backend = await installService();
    p.log.success(`Always-on service installed via ${pc.cyan(backend)}.`);
    p.log.message(pc.dim('It survives reboots — a missed Saturday 22:00 run fires as soon as the machine is back online.'));
  }
}

/** Wizard step: first snapshot now? */
async function firstBackupStep() {
  const first = await p.confirm({
    message: 'Run the FIRST snapshot backup right now? (recommended before a fresh install)',
    initialValue: true,
  });
  if (p.isCancel(first)) { p.cancel('Aborted.'); process.exit(0); }
  if (first) {
    if (!(await isOnline())) {
      p.log.warn('Offline right now — the backup stays pending and will run automatically when online.');
    } else {
      const s = p.spinner();
      s.start('Creating snapshot…');
      s.stop('');
      try {
        const res = await runDueJobs({ force: true, privileged: 'interactive' });
        for (const r of res.report) {
          if (r.ok) p.log.success(r.snapshot
            ? `Snapshot ${r.snapshot} created & uploaded${r.size ? ` (${pc.cyan(bytesHuman(r.size))})` : ''}.`
            : `Backup ${r.due} stored.`);
          else if (r.deferred) p.log.warn(`Snapshot deferred (sudo needed) — run \`parrot-blackbox snapshot now\`.`);
          else p.log.warn(`Backup failed: ${r.error}`);
        }
      } catch (e) {
        p.log.warn(`Backup failed: ${e.message}`);
      }
    }
  }
}

export async function runSetup() {
  p.intro(pc.bgYellow(pc.black(' parrot-blackbox setup ')));

  // 1. Dependencies — check the system and INSTALL anything missing.
  p.note('Checking & installing the tools needed for snapshot backup + restore…', 'Step 1/5 — tools');
  const missing = REQUIRED.filter((t) => !hasCommandSync(t.bin));
  if (missing.length === 0) {
    p.log.success(`All tools present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
  } else {
    const installed = await ensureSystemTools();
    const stillMissing = REQUIRED.filter((t) => !hasCommandSync(t.bin));
    if (installed.length) p.log.success(`Installed: ${installed.join(', ')}`);
    p.log[stillMissing.length ? 'warn' : 'success'](stillMissing.length
      ? `Still missing: ${stillMissing.map((m) => m.bin).join(', ')}`
      : `All required tools now present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
  }

  // 2. Storage pool (guided remote creation or manual registration).
  await storagePoolStep();
  const accs = await refreshAccounts();
  if (accs.length) p.log.success(poolSummary(accs).text);

  // 3–5. Schedule, service, first backup.
  await scheduleStep();
  await serviceStep();
  await firstBackupStep();

  journal('setup', 'wizard completed');
  p.outro(pc.green('Setup complete. Run `parrot-blackbox status` next, and `parrot-blackbox remote list` to manage accounts.'));
}
