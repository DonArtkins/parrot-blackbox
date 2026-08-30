/**
 * Diagnostics & lifecycle: `doctor`, `status`, `uninstall`.
 */

import fs from 'node:fs';
import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { loadConfig, loadState, journal, hasCommandSync, lastJournal } from '../core/store.js';
import { configFile, stateDir } from '../core/paths.js';
import { bytesHuman } from '../util/misc.js';
import { listAccounts, refreshAccounts, poolSummary } from '../storage/accounts.js';
import { listArtifacts } from '../storage/archive.js';
import { rcloneVersion } from '../storage/rclone.js';
import { listLocalSnapshots, timeshiftAvailable } from '../backup/snapshot.js';
import { daemonRunning } from '../daemon/daemon.js';
import { serviceBackend } from './service.js';
import { isOnline } from '../util/network.js';

export async function runDoctor() {
  const cfg = loadConfig();
  const state = loadState();

  p.intro(pc.bold('🩺 parrot-blackbox doctor'));
  console.log(`\n  Tooling:`);
  const tools = [
    ['node', () => process.version],
    ['rclone', rcloneVersion],
    ['timeshift', () => (timeshiftAvailable() ? 'present' : 'MISSING')],
    ['git', () => (hasCommandSync('git') ? 'present' : 'MISSING')],
    ['systemd', () => (serviceBackend() === 'systemd' ? 'available' : serviceBackend())],
  ];
  for (const [name, fn] of tools) {
    let v;
    try { v = await fn(); } catch { v = 'error'; }
    console.log(`    - ${pc.cyan(name.padEnd(10))} ${v}`);
  }

  console.log(`\n  Network : ${(await isOnline()) ? pc.green('online') : pc.yellow('offline')}`);
  console.log(`  Daemon  : ${daemonRunning() ? pc.green('running') : pc.yellow('stopped')}`);
  console.log(`  Config  : ${configFile()}`);
  console.log(`  State   : ${stateDir()}`);

  console.log(`\n  Storage accounts:`);
  const accs = listAccounts();
  if (accs.length === 0) {
    console.log(`    ${pc.yellow('none — run `parrot-blackbox setup`')}`);
  } else {
    const refreshed = await refreshAccounts(cfg);
    for (const a of refreshed) {
      console.log(`    - ${pc.bold(a.label)} (${a.provider}, ${a.remote})  ${bytesHuman(a.free)} free / ${bytesHuman(a.total)}`);
    }
    console.log(`    ${pc.dim(poolSummary(refreshed).text)}`);
  }

  console.log(`\n  Recent journal:`);
  for (const line of lastJournal(8)) console.log(`    ${pc.dim(line)}`);

  console.log(`\n  Schedule state:`);
  for (const type of ['files', 'snapshots']) {
    const j = state.jobs[type];
    const icfg = cfg.jobs[type];
    console.log(
      `    - ${pc.bold(type)}  ${icfg?.schedule?.kind} ${icfg?.enabled ? '' : pc.yellow('(disabled)')}` +
        `  last=${j.lastCompletedDue || '—'}  pending=${(j.pending || []).join(',') || '—'}  status=${j.lastStatus || '—'}`,
    );
  }
}

export async function runStatus() {
  const cfg = loadConfig();
  const state = loadState();
  const accs = listAccounts();

  console.log(pc.bold(`\n🧠 parrot-blackbox status\n`));
  if (accs.length) {
    const pool = poolSummary(await refreshAccounts(cfg));
    console.log(`  Pool      : ${pool.text}`);
  } else {
    console.log(`  Pool      : ${pc.yellow('no accounts — run `parrot-blackbox setup`')}`);
  }
  console.log(`  Network   : ${(await isOnline()) ? pc.green('online') : pc.yellow('offline — backups will defer & catch up later')}`);
  console.log(`  Daemon    : ${daemonRunning() ? pc.green('running') : pc.yellow('stopped')}`);

  for (const type of ['files', 'snapshots']) {
    const j = state.jobs[type] || {};
    const icfg = cfg.jobs[type] || {};
    console.log(`\n  ${pc.bold(type)} (${icfg.schedule?.kind ?? '?'}, keep ${icfg.keep})`);
    console.log(`    Last done : ${j.lastCompletedDue || pc.dim('never')}`);
    console.log(`    Pending   : ${(j.pending || []).join(', ') || pc.dim('none')}`);
    if (j.lastError) console.log(`    Last error: ${pc.red(j.lastError.slice(0, 160))}`);
  }

  const clouds = await listArtifacts('snapshots', accs, cfg.storage.remoteRoot).catch(() => []);
  if (clouds.length) {
    console.log(`\n  Cloud snapshots: ${clouds.map((c) => `${c.id} (${bytesHuman(c.totalSize)})`).join(', ')}`);
  }
  console.log();
}

export async function runUninstallWizard() {
  p.intro(pc.bgRed(pc.black(' parrot-blackbox uninstaller ')));

  const confirm = await p.confirm({
    message:
      'Uninstall parrot-blackbox completely? This stops the daemon, removes the systemd/cron schedule, deletes the local config & journal (~/.config/parrot-blackbox, ~/.local/state/parrot-blackbox) and the npm package. CLOUD BACKUPS ARE NOT DELETED.',
    initialValue: false,
  });
  if (p.isCancel(confirm)) { p.cancel('Aborted.'); process.exit(0); }
  if (!confirm) { p.outro('Nothing was removed.'); return; }

  // Stop daemon & remove service
  try { await execa('bash', ['-c', `"${process.execPath}" "${process.argv[1]}" daemon stop`], { reject: false }); } catch { /* best effort */ }
  try { await execa('bash', ['-c', `"${process.execPath}" "${process.argv[1]}" schedule remove`], { reject: false }); } catch { /* best effort */ }

  const removed = [];
  for (const dir of [configFile(), stateDir()]) {
    if (fs.existsSync(dir)) {
      if (fs.statSync(dir).isDirectory() && dir.includes('parrot-blackbox')) fs.rmSync(dir, { recursive: true, force: true });
      else fs.rmSync(dir, { force: true });
      removed.push(dir);
    }
  }
  if (removed.length) p.log.success(`Removed local data: ${removed.join(', ')}`);
  else p.log.message(pc.dim('No local parrot-blackbox data found.'));

  // Remove the npm package too, exactly like gitswitch/theamify.
  const { selfUninstall } = await import('../lib/self.js');
  const pkgRemoved = await selfUninstall();

  p.outro(pc.green(
    `Uninstalled. Cloud backups remain safe in your accounts.${pkgRemoved ? ' The parrot-blackbox command is gone from PATH.' : ''}`,
  ));
}

/**
 * `repair` — fix a broken/partial install. Re-runs every integrity probe:
 *   - system tools (rclone / timeshift / git / curl) checked + auto-installed
 *   - config + state dirs recreated if missing / regenerated if corrupt
 *   - always-on service (systemd / cron) re-installed if missing
 *   - storage pool entries cross-checked against rclone remotes (stale removed)
 *   - optional npm reinstall when the data dir is healthy but the CLI is broken
 * When `auto` is true it runs in non-interactive / repair-and-summary mode.
 */
export async function runRepair({ auto = false } = {}) {
  const { runToolsCheck } = await import('./tools.js');
  const { installService } = await import('./service.js');
  const { listRemotes } = await import('../storage/rclone.js');
  const { listAccounts, removeAccount } = await import('../storage/accounts.js');

  p.intro(pc.bgGreen(pc.black(' 🛠 parrot-blackbox repair ')));
  const fixed = [];

  // 1. Tools
  const stillMissing = await runToolsCheck();
  if (stillMissing.length === 0) p.log.success('Tools OK.');
  else { p.log.warn('Some tools are still missing — snapshot backup/restore may be unavailable.'); }

  // 2. Config & state
  let cfgPath;
  const { configFile, ensureStateDirs } = await import('../core/paths.js');
  const { loadConfig } = await import('../core/store.js');
  try {
    cfgPath = configFile();
    ensureStateDirs();
    loadConfig(); // throws if corrupt JSON
    p.log.success('Config & state OK.');
  } catch (e) {
    p.log.warn(`Config/state issue: ${e.message}`);
    // Regenerate a fresh config if absent or corrupt.
    try {
      const { defaultConfig, saveConfig } = await import('../core/store.js');
      let cfg = null;
      try { cfg = loadConfig(); } catch { cfg = null; }
      if (!cfg) {
        saveConfig(defaultConfig());
        fixed.push('config');
        p.log.success('Config recreated.');
      }
    } catch (e2) {
      p.log.warn(`Could not recreate config: ${e2.message}`);
    }
  }

  // 3. Service
  try {
    const { serviceFile, daemonLogFile } = await import('../core/paths.js');
    const { serviceBackend } = await import('./service.js');
    const fsMod = await import('node:fs');
    if (serviceBackend() === 'systemd' && !fsMod.existsSync(serviceFile())) {
      const backend = await installService();
      p.log.success(`Always-on service re-installed via ${backend}.`);
      fixed.push('service');
    } else {
      p.log.success('Service OK.');
    }
  } catch (e) {
    p.log.warn(`Service check failed: ${e.message}`);
  }

  // 4. Pool ↔ rclone cross-check
  try {
    const remotes = await listRemotes();
    const accs = listAccounts();
    let stale = 0;
    for (const a of accs) {
      if (!remotes.includes(a.remote)) {
        removeAccount(a.remote);
        stale += 1;
      }
    }
    if (stale) { p.log.success(`Removed ${stale} stale pool entry(ies) whose rclone remote no longer exists.`); fixed.push(`pool(${stale})`); }
    else p.log.success(`Pool OK (${accs.length} account(s), ${remotes.length} rclone remote(s)).`);
  } catch (e) {
    p.log.warn(`Pool check failed: ${e.message}`);
  }

  // 5. Optional npm reinstall (repair a broken CLI install)
  if (!auto) {
    const want = await p.confirm({
      message: 'Reinstall parrot-blackbox from npm to repair the executable?',
      initialValue: false,
    });
    if (!p.isCancel(want) && want) {
      const { runSelfUpdate } = await import('../lib/self.js');
      p.log.step('Reinstalling from npm…');
      const did = await runSelfUpdate({ force: true });
      if (did) fixed.push('npm');
    }
  }

  p.outro(pc.green(fixed.length ? `Repair complete — fixed: ${fixed.join(', ')}.` : 'Nothing to repair — everything looks healthy.'));
}