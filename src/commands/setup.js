/**
 * Interactive setup wizard (default command, like gitswitch/theamify).
 * Walks: dependency check + AUTO-INSTALL → rclone remotes (accounts) →
 * schedule overview → always-on service install → optional first backup.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { loadConfig, journal, hasCommandSync } from '../core/store.js';
import { listRemotes } from '../storage/rclone.js';
import { addAccount, listAccounts, refreshAccounts, poolSummary } from '../storage/accounts.js';
import { installService } from './service.js';
import { runDueJobs } from '../daemon/scheduler.js';
import { isOnline } from '../util/network.js';
import { bytesHuman } from '../util/misc.js';

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

/**
 * Auto-install the tools the system needs for snapshot backup & restore.
 * Prompts per missing tool, then runs the package-manager install with an
 * interactive sudo prompt (spinner released first, Ctrl+C safe).
 * @returns {Promise<string[]>} tools that were freshly installed
 */
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
    // Release the spinner FIRST so the sudo password prompt is visible & interruptible.
    s.stop('');
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
export async function runSetup() {
  p.intro(pc.bgYellow(pc.black(' parrot-blackbox setup ')));

  // 1. Dependencies — check the system and INSTALL anything needed for the
  //    snapshot to be created, uploaded and (later) RESTORED.
  p.note('Checking & installing the tools needed for snapshot backup + restore…', 'Step 1/5 — tools');
  const missing = REQUIRED.filter((t) => !hasCommandSync(t.bin));
  if (missing.length === 0) {
    p.log.success(`All tools present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
  } else {
    const installed = await ensureSystemTools();
    const stillMissing = REQUIRED.filter((t) => !hasCommandSync(t.bin));
    if (installed.length) p.log.success(`Installed: ${installed.join(', ')}`);
    if (stillMissing.length) {
      p.log.warn(`Still missing: ${stillMissing.map((m) => m.bin).join(', ')}`);
    } else {
      p.log.success(`All required tools now present: ${REQUIRED.map((r) => r.bin).join(', ')}`);
    }
  }
  if (!hasCommandSync('timeshift')) {
    p.log.message(pc.dim('Timeshift missing = snapshot backup & restore are unavailable. Run `parrot-blackbox` again after installing it.'));
  }

  // 2. Accounts
  p.note('Accounts are rclone remotes — one per MEGA or Google Drive login.', 'Step 2/5 — storage pool');
  const existing = listAccounts();
  const needMore = await p.confirm({
    message: existing.length
      ? `You already have ${existing.length} account(s). Add or authorize another cloud login?`
      : 'No accounts yet — add a MEGA or Google Drive account now?',
    initialValue: true,
  });
  if (p.isCancel(needMore)) { p.cancel('Aborted.'); process.exit(0); }

  if (needMore) {
    const want = await p.select({
      message: 'How do you want to add the account?',
      options: [
        { value: 'wizard', label: 'Run `rclone config` (recommended — handles MEGA + Google OAuth)', hint: 'authenticates in your browser' },
        { value: 'manual', label: 'I already created the rclone remote myself' },
      ],
    });
    if (p.isCancel(want)) { p.cancel('Aborted.'); process.exit(0); }

    if (want === 'wizard') {
      p.log.step('Starting rclone config — follow its prompts, then come back.');
      await execa('rclone', ['config'], { stdio: 'inherit' });
    }
    await registerAccountsFlow();
  }

  // 3. Schedule overview — snapshot ONLY by default (storage-conscious).
  const cfg = loadConfig();
  p.note(
    `   Snapshot backup: ${pc.bold('every Saturday at 22:00')} (keep ${cfg.jobs.snapshots.keep}, local + cloud)\n` +
    `   File backups   : ${cfg.jobs.files.enabled ? pc.bold('daily 22:00 (enabled)') + ` (keep ${cfg.jobs.files.keep})` : pc.dim('disabled by default — opt-in, storage-conscious')}\n` +
    `   Missed backups : caught up automatically in order when WiFi returns`,
    'Step 3/5 — schedule',
  );

  // 4. Always-on service
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

  // 5. First snapshot now?
  const first = await p.confirm({
    message: 'Run the FIRST snapshot backup right now? (recommended before a fresh install)',
    initialValue: true,
  });
  if (p.isCancel(first)) { p.cancel('Aborted.'); process.exit(0); }
  if (first) {
/** Register discovered rclone remotes as accounts (multi-select). */
async function registerAccountsFlow() {
  const remotes = await listRemotes();
  if (remotes.length === 0) {
    p.log.warn('No rclone remotes found yet. Create one with `rclone config` or re-run setup.');
    return;
  }
  const toAdd = await p.multiselect({
    message: 'Select which rclone remotes to add to the backup pool (one per account):',
    options: remotes.map((r) => ({ value: r, label: r })),
    required: false,
  });
  if (p.isCancel(toAdd) || toAdd.length === 0) {
    p.log.message(pc.dim('No accounts added.'));
    return;
  }
  for (const remote of toAdd) {
    const provider = await p.select({
      message: `Provider for "${remote}"?`,
      options: [
        { value: 'mega', label: 'MEGA (20 GB free tier)' },
        { value: 'gdrive', label: 'Google Drive (10 GB free tier)' },
      ],
    });
    if (p.isCancel(provider)) continue;
    const res = await addAccount({ provider, remote });
    if (res.ok) p.log.success(`Added ${pc.cyan(remote)} (${provider}).`);
    else p.log.warn(res.error);
  }
  const accounts = await refreshAccounts();
  p.log.success(poolSummary(accounts).text);
  journal('setup', `accounts registered: ${accounts.map((a) => a.remote).join(',')}`);
}
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

  p.outro(pc.green('Setup complete. Run `parrot-blackbox status` to see everything, or `parrot-blackbox help` for all commands.'));
}