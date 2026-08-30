import { defineCommand, runMain } from 'citty';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { createRequire } from 'node:module';
import { runSetup } from './commands/setup.js';
import { runWizard } from './commands/wizard.js';
import { runRepair } from './commands/manage.js';
import { runSelfUpdate } from './lib/self.js';
import { guidedRemoteAdd, deleteRemote, registerRemotesAsAccounts, remoteStatus } from './commands/remote.js';
import { runDoctor, runStatus, runUninstallWizard } from './commands/manage.js';
import { installService, removeService } from './commands/service.js';
import { runDueJobs } from './daemon/scheduler.js';
import { startDaemon, stopDaemon, daemonRunning } from './daemon/daemon.js';
import { runSnapshotNow, listLocalSnapshots, pruneSnapshots } from './backup/snapshot.js';
import { restoreSnapshot, restoreFiles } from './backup/restore.js';
import { listAccounts, addAccount, removeAccount, refreshAccounts, poolSummary } from './storage/accounts.js';
import { listArtifacts } from './storage/archive.js';
import { loadConfig, loadState, saveConfig } from './core/store.js';
import { configFile, stateDir } from './core/paths.js';
import { bytesHuman } from './util/misc.js';
import { isOnline } from './util/network.js';

const require = createRequire(import.meta.url);
const pkg = require('../package.json');

/** Terminal safety net (same as gitswitch/theamify/warp-wizard). */
function terminateAndRestore(code) {
  try {
    if (process.stdout.isTTY) process.stdout.write('\x1b[?25h\n\r');
  } catch { /* best effort */ }
  process.exit(code);
}
if (process.platform !== 'win32') process.on('SIGTSTP', () => terminateAndRestore(130));
process.on('SIGINT', () => terminateAndRestore(130));
process.on('SIGTERM', () => terminateAndRestore(143));

function printUsage() {
  console.log(`
${pc.bold('parrot-blackbox')} ${pc.dim(`v${pkg.version}`)} — crash-proof multi-cloud backup & recovery for Parrot OS

${pc.bold('Usage:')}
  parrot-blackbox                     ⭐ Menu wizard (all features; auto-update check on launch)
  parrot-blackbox install             Same as the menu wizard
  parrot-blackbox repair [--yes]      Fix a broken install (tools, config, service, pool)
  parrot-blackbox update [--force]    Check npm & update to the latest version
  parrot-blackbox setup               Guided full setup (tools, accounts, schedule, service)
  parrot-blackbox run                 Run any due / pending backups now (safe for cron)
  parrot-blackbox force               ⭐ Run every enabled backup NOW (default = weekly snapshot)  ${pc.dim('[sudo]')}
  parrot-blackbox snapshot now        Create a weekly snapshot + upload it now  ${pc.dim('[sudo]')}
  parrot-blackbox snapshot list       List local & cloud snapshots
  parrot-blackbox snapshot prune      Delete snapshots beyond the keep limit  ${pc.dim('[sudo]')}
  parrot-blackbox list [files]        List cloud file backups
  parrot-blackbox restore             Restore a snapshot or file backup       ${pc.dim('[sudo]')}
  parrot-blackbox account add         Add a MEGA / Google Drive account (remote must already exist)
  parrot-blackbox account list        Show the storage pool & usage
  parrot-blackbox account remove <id> Remove an account from the pool
  parrot-blackbox account quota <id> <GiB>  Override an account quota
  parrot-blackbox remote add <mega|gdrive> [name]  ⭐ Add a cloud account (sets up rclone FOR you)
  parrot-blackbox remote list         Show rclone remotes + pool status
  parrot-blackbox remote remove <name>  Delete a remote AND drop it from the pool
  parrot-blackbox remote config       Open the full rclone config editor (advanced)
  parrot-blackbox daemon start|stop|status   Background automation
  parrot-blackbox schedule install|remove    systemd / cron always-on setup
  parrot-blackbox doctor              Full diagnostics
  parrot-blackbox status              Quick status
  parrot-blackbox uninstall           Remove everything (cloud data kept)
  parrot-blackbox version | help
`);
}

async function invokeRun(privileged) {
  const res = await runDueJobs({ privileged });
  const report = res.report || [];
  if (report.length === 0) {
    console.log(pc.dim('Nothing due right now — the default schedule is the weekly snapshot (Saturday 22:00).'));
    return 0;
  }
  for (const r of report) {
    if (r.ok) {
      if (r.deferred) {
        console.log(`${pc.yellow('⏸')} ${r.type} ${r.due} deferred (sudo needed) — will retry automatically when the sudo timestamp is re-armed.`);
        continue;
      }
      const extra = r.pruned?.length ? ` (pruned ${r.pruned.join(', ')})` : '';
      const sizeLabel = r.size ? ` (${bytesHuman(r.size)})` : '';
      console.log(`${pc.green('✔')} ${r.type} ${r.due} ${r.snapshot ? `snapshot=${r.snapshot}` : 'stored'}${sizeLabel}${extra}`);
    } else {
      console.log(`${pc.red('✖')} ${r.type} ${r.due} failed: ${r.error}`);
    }
  }
  if (res.deferred) console.log(pc.yellow('Deferred (offline or sudo needed) — will catch up automatically when possible.'));
  return report.some((r) => !r.ok) ? 1 : 0;
}

async function snapshotList() {
  const cfg = loadConfig();
  const accs = listAccounts();
  console.log(`${pc.bold('\nLocal snapshots (Timeshift):')}`);
  try {
    const local = await listLocalSnapshots({ privileged: 'noninteractive' });
    if (local.length === 0) console.log(`  ${pc.dim('none')}`);
    for (const s of local) console.log(`  - ${pc.cyan(s.name)}  ${pc.dim(s.tags)}`);
  } catch (e) {
    console.log(`  ${pc.yellow(e.message)}`);
  }
  if (accs.length) {
    const cloud = await listArtifacts('snapshots', accs, cfg.storage.remoteRoot);
    console.log(`\nCloud snapshots:`);
    if (cloud.length === 0) console.log(`  ${pc.dim('none')}`);
    for (const c of cloud) {
      console.log(`  - ${pc.cyan(c.id)}  ${bytesHuman(c.totalSize)}  ${pc.dim(c.account)}`);
    }
  } else {
    console.log(`\n${pc.yellow('No accounts configured — run `parrot-blackbox account add` or setup.')}`);
  }
  console.log();
}

async function listFiles() {
  const cfg = loadConfig();
  const accs = listAccounts();
  if (!accs.length) {
    console.log(pc.yellow('No accounts configured yet.'));
    return;
  }
  const artifacts = await listArtifacts('files', accs, cfg.storage.remoteRoot);
  console.log(`\n${pc.bold('Cloud file backups:')}`);
  if (artifacts.length === 0) console.log(`  ${pc.dim('none yet — run `parrot-blackbox force`')}`);
  for (const a of artifacts) {
    console.log(`  - ${pc.cyan(a.id)}  ${bytesHuman(a.totalSize)}  ${pc.dim(a.account)}`);
  }
  console.log();
}

async function accountAddFlow(args) {
  const provider = args[0] || (await p.select({
    message: 'Provider?',
    options: [
      { value: 'mega', label: 'MEGA' },
      { value: 'gdrive', label: 'Google Drive' },
    ],
  }));
  if (p.isCancel(provider)) return;
  const remote = args[1] || (await p.text({ message: 'rclone remote name (create it first with `rclone config`):' }));
  if (!remote) return;
  const res = await addAccount({ provider, remote });
  if (res.ok) console.log(pc.green(`✔ Added ${res.account.label} (${res.account.provider}).`));
  else p.log.warn(res.error);
}
async function restoreFlow(rest) {
  const cfg = loadConfig();
  const accs = listAccounts();
  if (accs.length === 0) {
    p.log.warn('No accounts configured — cannot reach the cloud backups. Run `parrot-blackbox account add` first.');
    return;
  }
  const kind = rest[0] || (await p.select({
    message: 'Restore what?',
    options: [
      { value: 'snapshot', label: 'System snapshot (Timeshift) — overwrites the whole system', hint: '[sudo]' },
      { value: 'files', label: 'File backup — recover fonts/images/docs into a folder' },
    ],
  }));
  if (p.isCancel(kind)) return;

  if (kind === 'files') {
    const artifacts = await listArtifacts('files', accs, cfg.storage.remoteRoot);
    if (artifacts.length === 0) { p.log.warn('No file backups found.'); return; }
    const id = rest[1] || (await p.select({
      message: 'Pick a backup generation:',
      options: artifacts.map((a) => ({ value: a.id, label: `${a.id}  (${bytesHuman(a.totalSize)})` })),
    }));
    if (p.isCancel(id)) return;
    const toDir = rest[2] || (await p.text({
      message: 'Restore to which directory?',
      initialValue: `./restored-${id}`,
    }));
    const s = p.spinner();
    s.start('Restoring…');
    try {
      const res = await restoreFiles({ id, toDir, accounts: accs, cfg });
      s.stop(`✔ Restored ${res.files} file(s), ${bytesHuman(res.bytes)} into ${toDir}`);
    } catch (e) {
      s.stop('✖ Restore failed.');
      p.log.warn(e.message);
    }
    return;
  }

  // System snapshot restore — Level 5.
  if (!rest[1]) {
    // Interactive picker requires a terminal.
    const cloud0 = await listArtifacts('snapshots', accs, cfg.storage.remoteRoot);
    if (cloud0.length === 0) { p.log.warn('No cloud snapshots found.'); return; }
    const pick = await p.select({
      message: 'Pick a snapshot to restore:',
      options: cloud0.map((c) => ({ value: c.id, label: `${c.id}  (${bytesHuman(c.totalSize)})` })),
    });
    if (p.isCancel(pick)) return;
    rest[1] = pick;
  }
  const id = rest[1];
  if (!rest.includes('--yes') && !process.stdin.isTTY) {
    console.log(pc.yellow('Restore aborted — snapshot restore overwrites the whole system. Pass --yes to confirm in non-interactive mode.'));
    return;
  }
  const confirm = rest.includes('--yes') || (await p.confirm({
    message: pc.red(`This OVERWRITES the entire running system with snapshot ${id}. Continue?`),
    initialValue: false,
  }));
  if (p.isCancel(confirm)) { p.cancel('Aborted.'); return; }
  if (!confirm) { p.log.message(pc.dim('Restore aborted — nothing was touched.')); return; }

  const s = p.spinner();
  s.start('Preparing restore…');
  s.stop('');
  try {
    await restoreSnapshot({ id, accounts: accs, cfg, confirm: true, privileged: 'interactive' });
  } catch (e) {
    p.log.warn(e.message);
  }
}

async function accountCommands(rest) {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'list':
    case 'ls': {
      const cfg = loadConfig();
      const accs = listAccounts();
      if (!accs.length) { console.log(pc.yellow('No accounts yet.')); return; }
      const pool = poolSummary(await refreshAccounts(cfg));
      console.log(`\n${pc.bold('Storage pool:')} ${pool.text}\n`);
      for (const a of await refreshAccounts(cfg)) {
        console.log(`  - ${pc.bold(a.label)}  ${a.provider}  remote=${a.remote}  ${bytesHuman(a.free)} free / ${bytesHuman(a.total)}`);
      }
      console.log();
      return;
    }
    case 'add':
      await accountAddFlow(args);
      return;
    case 'remove':
    case 'rm': {
      if (!args[0]) { console.log(pc.yellow('Usage: parrot-blackbox account remove <id-or-remote>')); return; }
      console.log(removeAccount(args[0]) ? pc.green(`✔ Removed account ${args[0]}.`) : pc.yellow(`No account matched ${args[0]}.`));
      return;
    }
    case 'quota': {
      const [id, giB] = args;
      if (!id || !giB) { console.log(pc.yellow('Usage: parrot-blackbox account quota <id-or-remote> <GiB>')); return; }
      const cfg = loadConfig();
      const acc = (cfg.storage.accounts || []).find((a) => a.id === id || a.remote === id);
      if (!acc) { console.log(pc.yellow(`No account matched ${id}.`)); return; }
      acc.quotaGiB = Number(giB);
      writeConfigQuiet(cfg);
      console.log(pc.green(`✔ ${acc.label} quota set to ${giB} GiB.`));
      return;
    }
    default:
      console.log(pc.yellow('account subcommands: add | list | remove <id> | quota <id> <GiB>'));
  }
}

/** Manage rclone remotes (the cloud logins) + their pool registration. */
async function remoteCommands(rest) {
  const [sub, ...args] = rest;
  switch (sub) {
    case 'list':
    case 'ls': {
      const statuses = await remoteStatus();
      if (statuses.length === 0) {
        console.log(pc.yellow('\nNo rclone remotes configured yet. Add one with: parrot-blackbox remote add <mega|gdrive>\n'));
        return;
      }
      console.log(`\n${pc.bold('rclone remotes:')}`);
      for (const s of statuses) {
        console.log(`  - ${pc.bold(s.name)}${s.registered ? pc.green('  ✔ registered in pool') : pc.dim(`  not registered (provider: ${s.provider})`)}`);
      }
      console.log();
      return;
    }
    case 'add': {
      const provider = args[0];
      if (provider && !['mega', 'gdrive'].includes(provider)) {
        console.log(pc.yellow('provider must be mega or gdrive'));
        return;
      }
      let res;
      if (!provider) {
        // Interactive provider pick.
        const choice = await p.select({
          message: 'Provider?',
          options: [
            { value: 'mega', label: 'MEGA (20 GB free tier)' },
            { value: 'gdrive', label: 'Google Drive (15 GB free tier)' },
          ],
        });
        if (p.isCancel(choice)) return;
        res = await guidedRemoteAdd({ provider: choice, name: args[1], userArg: process.env.PBB_MEGA_USER || args[2], passArg: process.env.PBB_MEGA_PASS });
      } else {
        res = await guidedRemoteAdd({ provider, name: args[1], userArg: process.env.PBB_MEGA_USER || args[2], passArg: process.env.PBB_MEGA_PASS });
      }
      if (res.ok) console.log(pc.green(`✔ Added ${pc.bold(res.name)} (${res.provider}) — connected & registered.`));
      else if (res.cancelled) console.log(pc.dim('Cancelled — nothing changed.'));
      else console.log(pc.red(`✖ ${res.error}`));
      return;
    }
    case 'remove':
    case 'rm': {
      if (!args[0]) { console.log(pc.yellow('Usage: parrot-blackbox remote remove <remote-name>')); return; }
      try {
        await deleteRemote(args[0]);
        console.log(pc.green(`✔ Removed remote ${args[0]} (rclone config + pool).`));
      } catch (e) {
        console.log(pc.red(`✖ ${e.message}`));
      }
      return;
    }
    case 'config':
      console.log(pc.dim('Opening rclone config — pick a remote, then e) Edit, d) Delete, r) Rename, c) Copy.'));
      await import('execa').then(({ execa }) => execa('rclone', ['config'], { stdio: 'inherit' }));
      return;
    case 'register': {
      // Hook so the wizard's multiselect is also reachable standalone.
      console.log(pc.dim('Registering existing remotes into the pool…'));
      if (!process.stdin.isTTY) console.log(pc.yellow('No interactive terminal — use `parrot-blackbox account add <provider> <remote>` instead.'));
      else registerRemotesAsAccounts();
      return;
    }
    default:
      console.log(pc.yellow('remote subcommands: add <mega|gdrive> [name] | list | remove <name> | config | register'));
  }
}

function writeConfigQuiet(cfg) {
  saveConfig(cfg);
}

const main = defineCommand({
  meta: {
    name: 'parrot-blackbox',
    version: pkg.version,
    description: 'crash-proof multi-cloud backup & recovery automation for Parrot OS',
  },
  async run({ args }) {
    const [cmd, ...rest] = args._;

    if (process.platform !== 'linux') {
      console.error(pc.red('parrot-blackbox is Linux-only: it orchestrates Timeshift snapshots, which only exist on Linux.'));
      process.exitCode = 1;
      return;
    }
    if (args.V) {
      console.log(`parrot-blackbox v${pkg.version}`);
      return;
    }

    if (!cmd) return runWizard();

    switch (cmd) {
      case 'setup':
        // Guided full setup — a distinct, deeper flow (still menu-accessible).
        return runSetup();

      case 'wizard':
      case 'menu':
      case 'install':
        return runWizard();

      case 'repair':
      case 'fix':
        return runRepair({ auto: process.argv.includes('--yes') });

      case 'update':
      case 'self-update':
      case 'selfupdate':
      case 'upgrade':
        return runSelfUpdate({ force: process.argv.includes('--force') });

      case 'run':
        process.exitCode = await invokeRun('noninteractive');
        return;

      case 'force':
      case 'backup': {
        // Runs every ENABLED job right now (default = the weekly snapshot).
        const res = await runDueJobs({ force: true, privileged: 'interactive' });
        const report = res.report || [];
        if (report.length === 0) console.log(pc.dim('No enabled backup jobs — run `parrot-blackbox` to set up the schedule.'));
        for (const r of report) {
          if (r.ok) {
            const sizeLabel = r.size ? ` (${bytesHuman(r.size)})` : '';
            const label = r.snapshot ? `Snapshot ${r.snapshot}` : `File backup ${r.due}`;
            console.log(`${pc.green('✔')} ${label} created & uploaded${sizeLabel}.`);
          } else if (r.deferred) {
            console.log(`${pc.yellow('⏸')} Snapshot deferred (sudo needed) — run \`parrot-blackbox snapshot now\` once to authenticate.`);
          } else {
            console.log(`${pc.red('✖')} Backup failed: ${r.error}`);
            process.exitCode = 1;
          }
        }
        return;
      }

      case 'snapshot': {
        const [sub, ...args] = rest;
        if (sub === 'now' || sub === 'create' || sub === 'force') {
          try {
            const r = await runSnapshotNow();
            console.log(`${pc.green('✔')} Snapshot ${r.snapshot} created & uploaded (${bytesHuman(r.manifest.totalSize)}).`);
            if (r.pruned?.length) console.log(pc.dim(`Pruned: ${r.pruned.join(', ')}`));
          } catch (e) {
            console.error(pc.red(`✖ ${e.message}`));
            process.exitCode = 1;
          }
          return;
        }
        if (sub === 'list' || sub === 'ls') return snapshotList();
        if (sub === 'prune') {
          const cfg = loadConfig();
          try {
            const pruned = await pruneSnapshots(cfg, loadState(), listAccounts(), { privileged: 'interactive' });
            if (pruned.length) console.log(pc.green(`✔ Pruned: ${pruned.join(', ')} (local + cloud).`));
            else console.log(pc.dim('Nothing to prune.'));
          } catch (e) {
            console.error(pc.red(`✖ ${e.message}`));
            process.exitCode = 1;
          }
          return;
        }
        console.log(pc.yellow('snapshot subcommands: now | list | prune'));
        return;
      }

      case 'list':
      case 'ls':
      case 'files':
        return listFiles();

      case 'restore':
      case 'recover':
        return restoreFlow(rest);

      case 'account':
      case 'accounts':
        return accountCommands(rest);

      case 'remote':
      case 'remotes':
        return remoteCommands(rest);

      case 'daemon': {
        const [sub] = rest;
        if (sub === 'start') {
          const res = await startDaemon();
          console.log(res.started ? pc.green(`✔ Daemon started (pid ${res.pid}).`) : pc.yellow(`Daemon ${res.reason || 'already running'}.`));
          return;
        }
        if (sub === 'stop') {
          const res = await stopDaemon();
          console.log(res.stopped ? pc.green(`✔ Daemon stopped.`) : pc.yellow(`Daemon ${res.reason || 'not running'}.`));
          return;
        }
        if (sub === 'status') {
          console.log(`Daemon: ${daemonRunning() ? pc.green('running') : pc.yellow('not running')}`);
          return;
        }
        if (sub === 'foreground') {
          const { daemonForeground } = await import('./daemon/daemon.js');
          await daemonForeground();
          return;
        }
        console.log(pc.yellow('daemon subcommands: start | stop | status | foreground'));
        return;
      }

      case 'schedule': {
        const [sub] = rest;
        if (sub === 'install' || sub === 'on') {
          const backend = await installService();
          console.log(pc.green(`✔ Always-on schedule installed (${backend}).`));
          return;
        }
        if (sub === 'remove' || sub === 'off') {
          await removeService();
          console.log(pc.green('✔ Schedule removed.'));
          return;
        }
        console.log(pc.yellow('schedule subcommands: install | remove'));
        return;
      }

      case 'doctor':
        return runDoctor().then(() => undefined);

      case 'status':
        return runStatus();

      case 'uninstall':
        return runUninstallWizard();

      case 'config':
        console.log(`config: ${configFile()}`);
        console.log(`state : ${stateDir()}`);
        return;

      case 'version':
      case '-v':
      case '-V':
      case '--version':
        console.log(`parrot-blackbox v${pkg.version}`);
        return;

      case 'help':
      case '-h':
      case '--help':
      default:
        if (['help', '-h', '--help'].includes(cmd)) { printUsage(); return; }
        console.error(pc.red(`Unknown command: ${cmd}`));
        printUsage();
        process.exitCode = 1;
    }
  },
});

runMain(main);