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

  p.outro(pc.green('Uninstalled. Cloud backups remain safe in your accounts.'));
}