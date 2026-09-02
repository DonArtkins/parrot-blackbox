/**
 * The gitswitch-style menu wizard (default command).
 *
 *  - CARRIES OUT AN AUTOMATIC UPDATE CHECK on launch (latest from the npm
 *    registry, never from local state) and offers to install it.
 *  - Then shows a menu with EVERY feature; choosing an action runs it and
 *    RETURNS TO THE MENU. Saying "No" to a prompt never kicks you out — only
 *    Exit / Ctrl+C leaves the wizard.
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { runToolsCheck } from './tools.js';
import { guidedRemoteAdd } from './remote.js';
import { listAccounts, refreshAccounts, poolSummary, addAccount, removeAccount } from '../storage/accounts.js';
import { loadConfig, saveConfig } from '../core/store.js';
import { runDueJobs } from '../daemon/scheduler.js';
import { runSnapshotNow, listLocalSnapshots } from '../backup/snapshot.js';
import { listArtifacts } from '../storage/archive.js';
import { restoreFiles, restoreSnapshot } from '../backup/restore.js';
import { installService, removeService } from './service.js';
import { startDaemon, stopDaemon, daemonRunning } from '../daemon/daemon.js';
import { runDoctor, runStatus, runUninstallWizard } from './manage.js';
import { runSetup } from './setup.js';
import { bytesHuman } from '../util/misc.js';

const require = createRequire(import.meta.url);
const pkg = require('../../package.json');

async function importSelf() {
  return import('../lib/self.js');
}

/** Launch-time upgrade check — latest is always fetched from npm. */
async function autoUpdateCheck() {
  const { checkForUpdate, promptSelfUpdate } = await importSelf();
  try {
    const { outdated } = await checkForUpdate();
    if (outdated) await promptSelfUpdate();
  } catch {
    /* offline / npm missing — never block the wizard on the update check */
  }
}

/** Add one (or more) cloud accounts, guided. */
async function addAccountAction() {
  for (;;) {
    const provider = await p.select({
      message: '☁️  Add cloud account',
      options: [
        { value: 'mega', label: 'MEGA', hint: '20 GB free' },
        { value: 'gdrive', label: 'Google Drive', hint: '15 GB free' },
        { value: 'back', label: '← Back' },
      ],
    });
    if (p.isCancel(provider) || provider === 'back') return;
    const res = await guidedRemoteAdd({ provider });
    if (res.ok) p.log.success(`✔ ${pc.bold(res.name)} added to pool.`);
    else if (res.error) p.log.warn(res.error);
    else if (res.cancelled) { p.log.message(pc.dim('Cancelled.')); return; }
    const again = await p.confirm({ message: 'Add another account?', initialValue: false });
    if (p.isCancel(again) || !again) return;
  }
}

/** Storage pool sub-menu: list / add / remove / quota. */
async function accountsMenu() {
  const sub = await p.select({
    message: '🗂 Storage Pool',
    options: [
      { value: 'list', label: '📊 Show accounts', hint: 'quotas and usage' },
      { value: 'add', label: '➕ Add account', hint: 'existing rclone remote' },
      { value: 'remove', label: '➖ Remove account', hint: 'from pool only' },
      { value: 'quota', label: '📐 Set quota', hint: 'override account limit' },
      { value: 'back', label: '← Back' },
    ],
  });
  if (p.isCancel(sub) || sub === 'back') return;

  if (sub === 'list') {
    const accs = listAccounts();
    const cfg = loadConfig();
    if (!accs.length) { p.log.message(pc.dim('No accounts yet — choose “Add account”.')); return; }
    const refreshed = await refreshAccounts(cfg);
    p.log.message(poolSummary(refreshed).text);
    for (const a of refreshed) {
      p.log.message(`  - ${pc.bold(a.label)}  ${a.provider}  remote=${a.remote}  ${bytesHuman(a.free)} free / ${bytesHuman(a.total)}`);
    }
    return;
  }
  if (sub === 'add') {
    const provider = await p.select({
      message: 'Provider of the remote you already created (via rclone config / remote add)?',
      options: [
        { value: 'mega', label: 'MEGA' },
        { value: 'gdrive', label: 'Google Drive' },
      ],
    });
    if (p.isCancel(provider)) return;
    const name = await p.text({ message: 'rclone remote name (e.g. mega, mega-account-1):' });
    if (p.isCancel(name) || !name) return;
    const res = await addAccount({ provider, remote: name });
    if (res.ok) p.log.success(`✔ ${res.account.label} added.`);
    else p.log.warn(res.error);
    return;
  }
  if (sub === 'remove') {
    const accs = listAccounts();
    if (!accs.length) { p.log.message(pc.dim('No accounts to remove.')); return; }
    const pick = await p.select({
      message: 'Remove which account?',
      options: accs.map((a) => ({ value: a.remote, label: `${a.remote} (${a.provider})` })).concat([{ value: '__back', label: '← Back' }]),
    });
    if (p.isCancel(pick) || pick === '__back') return;
    if (removeAccount(pick)) p.log.success(`✔ Removed ${pc.bold(pick)} from the pool.`);
    else p.log.warn(`Could not remove ${pick}.`);
    return;
  }
  if (sub === 'quota') {
    const accs = listAccounts();
    if (!accs.length) { p.log.message(pc.dim('No accounts yet.')); return; }
    const pick = await p.select({
      message: 'Which account?',
      options: accs.map((a) => ({ value: a.remote, label: `${a.remote} (${a.provider})` })).concat([{ value: '__back', label: '← Back' }]),
    });
    if (p.isCancel(pick) || pick === '__back') return;
    const giB = await p.text({ message: `Quota in GiB for ${pick}:`, initialValue: '20' });
    if (p.isCancel(giB) || !giB) return;
    const cfg = loadConfig();
    const acc = (cfg.storage.accounts || []).find((a) => a.remote === pick);
    if (!acc) { p.log.warn(`No account matched ${pick}.`); return; }
    acc.quotaGiB = Number(giB);
    saveConfig(cfg);
    p.log.success(`✔ ${pick} quota set to ${giB} GiB.`);
  }
}

/** Run every enabled backup right now. */
async function backupNowAction() {
  const s = p.spinner();
  s.start('Running backup…');
  s.stop('');
  const res = await runDueJobs({ force: true, privileged: 'interactive' });
  const report = res.report || [];
  if (report.length === 0) { p.log.message(pc.dim('No enabled backup jobs.')); return; }
  for (const r of report) {
    if (r.ok) {
      const size = r.size ? ` (${bytesHuman(r.size)})` : '';
      p.log.success(r.snapshot
        ? `✔ Snapshot ${r.snapshot} created & uploaded${size}.`
        : `✔ File backup ${r.due} stored${size}.`);
      if (r.pruned?.length) p.log.message(pc.dim(`Pruned: ${r.pruned.join(', ')}`));
    } else if (r.deferred) {
      p.log.warn(`⏸ Snapshot deferred (sudo needed) — run \`parrot-blackbox snapshot now\` once to authenticate.`);
    } else {
      p.log.warn(`✖ ${r.type} ${r.due} failed: ${r.error}`);
    }
  }
}

/** Create + upload a snapshot immediately. */
async function snapshotNowAction() {
  try {
    const r = await runSnapshotNow();
    p.log.success(`✔ Snapshot ${r.snapshot} created & uploaded (${bytesHuman(r.manifest?.totalSize ?? 0)}).`);
    if (r.pruned?.length) p.log.message(pc.dim(`Pruned: ${r.pruned.join(', ')}`));
  } catch (e) {
    p.log.warn(`✖ ${e.message}`);
  }
}

/** List local + cloud snapshots and file backups. */
async function listBackupsAction() {
  const cfg = loadConfig();
  const accs = listAccounts();
  p.log.message(pc.bold('Local snapshots (Timeshift):'));
  try {
    const local = await listLocalSnapshots({ privileged: 'interactive' });
    if (!local.length) p.log.message(pc.dim('  none'));
    for (const sn of local) p.log.message(`  - ${pc.cyan(sn.name)}`);
  } catch (e) {
    p.log.message(pc.dim(`  ${e.message}`));
  }
  if (accs.length) {
    p.log.message(pc.bold('Cloud snapshots:'));
    const cloudSnaps = await listArtifacts('snapshots', accs, cfg.storage.remoteRoot);
    if (!cloudSnaps.length) p.log.message(pc.dim('  none'));
    for (const c of cloudSnaps) p.log.message(`  - ${pc.cyan(c.id)}  ${bytesHuman(c.totalSize)}`);
    p.log.message(pc.bold('Cloud file backups:'));
    const files = await listArtifacts('files', accs, cfg.storage.remoteRoot);
    if (!files.length) p.log.message(pc.dim('  none'));
    for (const f of files) p.log.message(`  - ${pc.cyan(f.id)}  ${bytesHuman(f.totalSize)}`);
  } else {
    p.log.message(pc.dim('No accounts configured — add one from the menu.'));
  }
}
/** Restore files or a system snapshot. */
async function restoreMenu() {
  const accs = listAccounts();
  if (!accs.length) { p.log.warn('No cloud accounts configured yet.'); return; }
  const cfg = loadConfig();
  const kind = await p.select({
    message: '♻️  Restore backup',
    options: [
      { value: 'files', label: '📄 Files', hint: 'recover documents, images, etc.' },
      { value: 'snapshot', label: '💽 System snapshot', hint: 'full system restore [sudo]' },
      { value: 'back', label: '← Back' },
    ],
  });
  if (p.isCancel(kind) || kind === 'back') return;

  if (kind === 'files') {
    const artifacts = await listArtifacts('files', accs, cfg.storage.remoteRoot);
    if (!artifacts.length) { p.log.warn('No file backups found.'); return; }
    const id = await p.select({
      message: 'Pick a backup generation:',
      options: artifacts.map((a) => ({ value: a.id, label: `${a.id}  (${bytesHuman(a.totalSize)})` })).concat([{ value: '__back', label: '← Back' }]),
    });
    if (p.isCancel(id) || id === '__back') return;
    const toDir = await p.text({ message: 'Restore into which directory?', initialValue: `./restored-${id}` });
    if (p.isCancel(toDir) || !toDir) return;
    fs.mkdirSync(toDir, { recursive: true });
    try {
      const res = await restoreFiles({ id, toDir, accounts: accs, cfg });
      p.log.success(`✔ Restored ${res.files} file(s), ${bytesHuman(res.bytes)} into ${toDir}`);
    } catch (e) {
      p.log.warn(`✖ ${e.message}`);
    }
    return;
  }

  const cloud = await listArtifacts('snapshots', accs, cfg.storage.remoteRoot);
  if (!cloud.length) { p.log.warn('No cloud snapshots found.'); return; }
  const id = await p.select({
    message: 'Pick a snapshot to restore:',
    options: cloud.map((c) => ({ value: c.id, label: `${c.id}  (${bytesHuman(c.totalSize)})` })).concat([{ value: '__back', label: '← Back' }]),
  });
  if (p.isCancel(id) || id === '__back') return;
  const confirm = await p.confirm({
    message: pc.red(`This OVERWRITES the running system with snapshot ${id}. Continue?`),
    initialValue: false,
  });
  if (p.isCancel(confirm) || !confirm) { p.log.message(pc.dim('Restore aborted — nothing was touched.')); return; }
  const s = p.spinner();
  s.start('Preparing restore…');
  s.stop('');
  try {
    await restoreSnapshot({ id, accounts: accs, cfg, confirm: true, privileged: 'interactive' });
  } catch (e) {
    p.log.warn(`✖ ${e.message}`);
  }
}

/** Always-on service sub-menu. */
async function serviceMenu() {
  const sub = await p.select({
    message: '⏱ Schedule Service',
    options: [
      { value: 'install', label: '✅ Enable', hint: 'auto-backup on schedule' },
      { value: 'remove', label: '❌ Disable', hint: 'stop auto-backup' },
      { value: 'back', label: '← Back' },
    ],
  });
  if (p.isCancel(sub) || sub === 'back') return;
  if (sub === 'install') {
    const backend = await installService();
    p.log.success(`✔ Always-on service installed via ${pc.cyan(backend)}.`);
  } else {
    await removeService();
    p.log.success('✔ Service removed.');
  }
}

/** Daemon sub-menu. */
async function daemonMenu() {
  const running = daemonRunning();
  const sub = await p.select({
    message: `🤖 Daemon ${running ? pc.green('●') : pc.yellow('○')} ${running ? 'running' : 'stopped'}`,
    options: [
      { value: 'start', label: '▶️  Start' },
      { value: 'stop', label: '⏹️  Stop' },
      { value: 'status', label: '📊 Status' },
      { value: 'back', label: '← Back' },
    ],
  });
  if (p.isCancel(sub) || sub === 'back') return;
  if (sub === 'start') {
    const res = await startDaemon();
    if (res.started) p.log.success(`✔ Daemon started (pid ${res.pid}).`);
    else p.log.message(pc.yellow(`Daemon ${res.reason || 'already running'}.`));
  } else if (sub === 'stop') {
    const res = await stopDaemon();
    if (res.stopped) p.log.success('✔ Daemon stopped.');
    else p.log.message(pc.yellow(`Daemon ${res.reason || 'not running'}.`));
  } else {
    p.log.message(`Daemon: ${daemonRunning() ? pc.green('running') : pc.yellow('not running')}`);
  }
}
/**
 * Main wizard — menu loop. Only Exit / Ctrl+C leaves it; saying "No" to any
 * prompt just returns you to this menu.
 */
export async function runWizard() {
  p.intro(`🦜 ${pc.bold('parrot-blackbox')} ${pc.dim(`v${pkg.version}`)}`);

  if (!process.stdin.isTTY) {
    p.log.warn('No interactive terminal detected — run subcommands directly: `parrot-blackbox help`');
    p.outro('Bye! 👋');
    return;
  }

  // Automatic update check (latest always fetched from npm).
  await autoUpdateCheck();

  for (;;) {
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'snapshot', label: '📸 Create snapshot', hint: 'backup your system now' },
        { value: 'resume', label: '⏳ Resume upload', hint: 'resume incomplete backup uploads' },
        { value: 'backup', label: '💾 Run all backups', hint: 'snapshots + file backups' },
        { value: 'restore', label: '♻️  Restore backup', hint: 'files or system snapshot' },
        { value: 'list', label: '📋 List backups', hint: 'see what\'s saved' },
        { value: 'add', label: '☁️  Add cloud account', hint: 'MEGA or Google Drive' },
        { value: 'accounts', label: '🗂  Manage storage', hint: 'pool, quotas, accounts' },
        { value: 'setup', label: '🚀 Guided setup', hint: 'first-time configuration' },
        { value: 'tools', label: '🔧 Check tools', hint: 'install missing dependencies' },
        { value: 'service', label: '⏱  Schedule service', hint: 'auto-backup setup' },
        { value: 'daemon', label: '🤖 Daemon control', hint: 'start / stop / status' },
        { value: 'status', label: '📊 Status', hint: 'quick health check' },
        { value: 'doctor', label: '🩺 Doctor', hint: 'full diagnostics' },
        { value: 'repair', label: '🛠️  Repair', hint: 'fix broken installation' },
        { value: 'update', label: '⬆️  Update', hint: 'check for new version' },
        { value: 'uninstall', label: '🗑️  Uninstall', hint: 'remove parrot-blackbox' },
        { value: 'exit', label: '👋 Exit' },
      ],
    });

    if (p.isCancel(action) || action === 'exit') {
      p.outro('👋 See you later!');
      return;
    }

    try {
      switch (action) {
        case 'add': await addAccountAction(); break;
        case 'accounts': await accountsMenu(); break;
        case 'tools': await runToolsCheck(); break;
        case 'snapshot': await snapshotNowAction(); break;
        case 'resume': await snapshotNowAction(); break;
        case 'backup': await backupNowAction(); break;
        case 'list': await listBackupsAction(); break;
        case 'restore': await restoreMenu(); break;
        case 'service': await serviceMenu(); break;
        case 'daemon': await daemonMenu(); break;
        case 'setup': await runSetup(); break;
        case 'status': await runStatus(); break;
        case 'doctor': await runDoctor(); break;
        case 'repair': { const { runRepair } = await import('./manage.js'); await runRepair(); break; }
        case 'update': { const { runSelfUpdate } = await import('../lib/self.js'); await runSelfUpdate(); break; }
        case 'uninstall': await runUninstallWizard(); p.outro('parrot-blackbox removed — cloud backups are safe.'); return;
        default: break;
      }
    } catch (e) {
      p.log.warn(`✖ ${e.message}`);
    }
    p.log.message('');
  }
}