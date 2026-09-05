import { defineCommand, runMain } from 'citty';
import pc from 'picocolors';
import * as p from '@clack/prompts';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from './commands/setup.js';
import { runWizard } from './commands/wizard.js';
import { runRepair } from './commands/manage.js';
import { runSelfUpdate } from './lib/self.js';
import { guidedRemoteAdd, deleteRemote, registerRemotesAsAccounts, remoteStatus } from './commands/remote.js';
import { runDoctor, runStatus, runUninstallWizard } from './commands/manage.js';
import { installService, removeService } from './commands/service.js';
import { runDueJobs } from './daemon/scheduler.js';
import { startDaemon, stopDaemon, daemonRunning } from './daemon/daemon.js';
import { runSnapshotNow, listLocalSnapshots, pruneSnapshots, deleteSnapshot, deleteAllSnapshots } from './backup/snapshot.js';
import { runUrgentBackup } from './backup/urgent.js';
import { restoreSnapshot, restoreFiles } from './backup/restore.js';
import { listAccounts, addAccount, removeAccount, refreshAccounts, poolSummary } from './storage/accounts.js';
import { listArtifacts } from './storage/archive.js';
import { loadConfig, loadState, saveConfig } from './core/store.js';
import { configFile, stateDir } from './core/paths.js';
import { bytesHuman, makeProgressRenderer } from './util/misc.js';
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
  parrot-blackbox snapshot delete [<name>|--all]  Delete one or all local snapshots  ${pc.dim('[sudo]')}
  parrot-blackbox snapshot prune      Delete snapshots beyond the keep limit  ${pc.dim('[sudo]')}
  parrot-blackbox urgent              ⚡ One-off rescue backup: working files + VS Codium + gitswitch/SSH data
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
    const local = await listLocalSnapshots({ privileged: process.stdin.isTTY ? 'interactive' : 'noninteractive' });
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
  const urgent = await listArtifacts('urgent', accs, cfg.storage.remoteRoot);
  console.log(`\n${pc.bold('Cloud urgent backups:')}`);
  if (urgent.length === 0) console.log(`  ${pc.dim('none yet — run `parrot-blackbox urgent`')}`);
  for (const a of urgent) {
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
  // Rescue paths first: System Snapshot and Urgent backup. The daily "Files"
  // flow shows only when that job is enabled, keeping this a clean two-option
  // restore for the default setup.
  const kind = rest[0] || (await p.select({
    message: 'Restore what?',
    options: [
      { value: 'snapshot', label: 'System snapshot (Timeshift) — overwrites the whole system', hint: '[sudo]' },
      { value: 'urgent', label: 'Urgent backup — user files + tool profiles (fresh install)' },
      ...(cfg.jobs?.files?.enabled
        ? [{ value: 'files', label: 'File backup — recover fonts/images/docs into a folder' }]
        : []),
    ],
  }));
  if (p.isCancel(kind)) return;

  if (kind === 'files' || kind === 'urgent') {
    const artifacts = await listArtifacts(kind, accs, cfg.storage.remoteRoot);
    if (artifacts.length === 0) { p.log.warn(`No ${kind === 'urgent' ? 'urgent' : 'file'} backups found.`); return; }
    const id = rest[1] || (await p.select({
      message: 'Pick a backup generation:',
      options: artifacts.map((a) => ({ value: a.id, label: `${a.id}  (${bytesHuman(a.totalSize)})` })),
    }));
    if (p.isCancel(id)) return;
    const toDir = rest[2] || (await p.text({
      message: 'Restore to which directory?',
      // Urgent backups restore your home (Desktop, .ssh, .gitconfig, …) — an
      // identical machine reports "nothing changed", a fresh install overwrites.
      initialValue: kind === 'urgent' ? (process.env.HOME || `./restored-${id}`) : `./restored-${id}`,
    }));
    const s = p.spinner();
    s.start('Restoring…');
    try {
      const res = await restoreFiles({ id, toDir, accounts: accs, cfg, kind });
      if (res.identical) {
        s.stop(`✔ Nothing to restore — ${kind} backup already matches ${toDir} (${res.unchanged} file(s) identical).`);
      } else {
        const skip = res.unchanged ? `  (${res.unchanged} already up-to-date)` : '';
        s.stop(`✔ Restored ${res.files} file(s), ${bytesHuman(res.bytes)} into ${toDir}${skip}`);
      }
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
        process.exitCode = await invokeRun(process.stdin.isTTY ? 'interactive' : 'noninteractive');
        return;

      case 'force':
      case 'backup': {
        // Runs every ENABLED job right now (default = the weekly snapshot).
        const progress = makeProgressRenderer();
        const res = await runDueJobs({ force: true, privileged: 'interactive', onProgress: progress });
        progress.stop();
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

      case 'urgent': {
        // One-off rescue backup — working files + VS Codium + gitswitch/SSH data.
        const progress = makeProgressRenderer();
        try {
          const r = await runUrgentBackup(undefined, undefined, { onProgress: progress });
          progress.stop();
          console.log(`${pc.green('✔')} Urgent backup ${r.resumed ? 'resumed & ' : ''}stored (${bytesHuman(r.sizeBytes)}). Restore with: \`parrot-blackbox restore urgent\`.`);
          if (r.skippedRepos?.length) console.log(pc.dim(`Skipped ${r.skippedRepos.length} git-tracked folder(s).`));
          if (r.missing?.length) console.log(pc.dim(`Source(s) not present, skipped: ${r.missing.join(', ')}.`));
        } catch (e) {
          progress.stop();
          console.error(pc.red(`✖ ${e.message}`));
          process.exitCode = 1;
        }
        return;
      }

      case 'snapshot': {
        const [sub, ...args] = rest;
        if (sub === 'now' || sub === 'create' || sub === 'force') {
          try {
            const progress = makeProgressRenderer();
            const r = await runSnapshotNow(undefined, undefined, { onProgress: progress });
            progress.stop();
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
            const pruned = await pruneSnapshots(cfg, listAccounts(), { privileged: 'interactive' });
            if (pruned.length) console.log(pc.green(`✔ Pruned: ${pruned.join(', ')} (local + cloud).`));
            else console.log(pc.dim('Nothing to prune.'));
          } catch (e) {
            console.error(pc.red(`✖ ${e.message}`));
            process.exitCode = 1;
          }
          return;
        }
        // snapshot delete [<name>|--all]
        if (sub === 'delete' || sub === 'rm' || sub === 'remove') {
          const target = args[0];
          const deleteAll = target === '--all' || !target;

          if (deleteAll && !target) {
            // No name and no --all: list snapshots and bail with usage hint.
            const local = await listLocalSnapshots({ privileged: 'interactive' }).catch(() => []);
            if (local.length === 0) {
              console.log(pc.dim('No local snapshots found.'));
              return;
            }
            console.log(pc.bold('\nLocal snapshots:'));
            for (const sn of local) console.log(`  - ${pc.cyan(sn.name)}`);
            console.log(pc.yellow('\nUsage:'));
            console.log('  parrot-blackbox snapshot delete <name>   — delete one snapshot');
            console.log('  parrot-blackbox snapshot delete --all     — delete all (runs btrfs quota rescan first)');
            console.log();
            return;
          }

          if (target === '--all') {
            // Confirm unless stdin is non-interactive.
            if (process.stdin.isTTY) {
              const local = await listLocalSnapshots({ privileged: 'interactive' }).catch(() => []);
              if (local.length === 0) { console.log(pc.dim('No local snapshots found.')); return; }
              const { confirm } = await import('@clack/prompts');
              const ok = await confirm({
                message: pc.red(`Delete ALL ${local.length} local snapshot(s)? This cannot be undone.`),
                initialValue: false,
              });
              const { isCancel } = await import('@clack/prompts');
              if (isCancel(ok) || !ok) { console.log(pc.dim('Aborted — nothing deleted.')); return; }
            }
            console.log(pc.dim('Running btrfs quota rescan first…'));
            try {
              const result = await deleteAllSnapshots({
                privileged: 'interactive',
                onProgress: (msg) => console.log(pc.dim(`  ${msg}`)),
              });
              console.log(pc.green(`✔ Deleted ${result.deleted.length} snapshot(s).`));
            } catch (e) {
              if (e.deleted?.length) console.log(pc.green(`✔ Deleted: ${e.deleted.join(', ')}`));
              if (e.failed?.length) {
                console.error(pc.red(`✖ Failed: ${e.failed.map((f) => `${f.name} (${f.error})`).join(', ')}`));
                console.log(pc.dim('  Try running again — qgroup rescan may need a second pass.'));
                process.exitCode = 1;
              } else {
                console.error(pc.red(`✖ ${e.message}`));
                process.exitCode = 1;
              }
            }
            return;
          }

          // Delete a single named snapshot.
          try {
            await deleteSnapshot(target, { privileged: 'interactive' });
            console.log(pc.green(`✔ Snapshot ${target} deleted.`));
          } catch (e) {
            console.error(pc.red(`✖ ${e.message}`));
            process.exitCode = 1;
          }
          return;
        }
        console.log(pc.yellow('snapshot subcommands: now | list | delete [<name>|--all] | prune'));
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

      case '_internal_upload': {
        const localDir = rest[0];
        const kind = rest[1];
        const id = rest[2];
        const remoteRoot = rest[3];
        const chunkSize = parseInt(rest[4], 10);
        const outPath = rest[5];
        const { planAndPlace, planAndPlaceStream } = await import('./storage/allocator.js');
        const s = p.spinner();
        s.start(`Uploading ${kind} ${id}...`);
        const cfg = loadConfig();
        const accs = await refreshAccounts(cfg);
        try {
          let manifest;
          if (kind === 'snapshots') {
            const btrfsCfg = cfg.jobs.snapshots.btrfs || {};
            let useBtrfs = btrfsCfg.enabled !== false && !process.env.PBB_DISABLE_BTRFS;
            
            if (useBtrfs) {
              // V2 BTRFS send/receive path
              const { hasBtrfs, isBtrfsFilesystem } = await import('./backup/btrfs-send.js');
              const canUseBtrfs = hasBtrfs() && await isBtrfsFilesystem('/');
              
              if (canUseBtrfs) {
                const { spawn } = await import('node:child_process');
                const parentDir = process.env.PBB_PARENT_DIR;
                
                // Build BTRFS send command with sudo
                const sendArgs = ['sudo', '-n', 'btrfs', 'send'];
                if (parentDir) {
                  sendArgs.push('-p', parentDir, localDir);
                } else {
                  sendArgs.push(localDir);
                }
                
                const btrfs = spawn(sendArgs[0], sendArgs.slice(1), { stdio: ['ignore', 'pipe', 'inherit'] });
                let finalStream = btrfs.stdout;
                const pipeline = [btrfs];
                
                // Stage 1: Compression
                if (btrfsCfg.compression !== false) {
                  const zstd = spawn('zstd', ['-T0', '-c'], { stdio: ['pipe', 'pipe', 'inherit'] });
                  finalStream.pipe(zstd.stdin);
                  pipeline.push(zstd);
                  finalStream = zstd.stdout;
                }
                
                // Stage 2: Encryption
                const passphrase = cfg.storage.encryptionPassphrase;
                if (btrfsCfg.encryption && passphrase) {
                  const openssl = spawn('openssl', ['enc', '-e', '-aes256', '-pbkdf2', '-pass', `pass:${passphrase}`], {
                    stdio: ['pipe', 'pipe', 'inherit']
                  });
                  finalStream.pipe(openssl.stdin);
                  pipeline.push(openssl);
                  finalStream = openssl.stdout;
                }
                
                manifest = await planAndPlaceStream(finalStream, {
                  kind, id, accounts: accs, remoteRoot, chunkSize,
                  onProgress: (prog) => s.message(prog.text)
                });
                
                // Wait for pipeline to complete
                await Promise.all(pipeline.map(proc => new Promise((resolve, reject) => {
                  proc.on('close', code => code === 0 ? resolve() : reject(new Error(`Pipeline stage failed: exit ${code}`)));
                  proc.on('error', reject);
                })));
              } else {
                // Fallback to file-copy mode
                manifest = await planAndPlace(localDir, { 
                  kind, id, accounts: accs, remoteRoot, chunkSize,
                  onProgress: (prog) => s.message(prog.text)
                });
              }
            } else {
              // File-copy mode (v2 fallback)
              manifest = await planAndPlace(localDir, { 
                kind, id, accounts: accs, remoteRoot, chunkSize,
                onProgress: (prog) => s.message(prog.text)
              });
            }
          } else {
            manifest = await planAndPlace(localDir, { 
              kind, id, accounts: accs, remoteRoot, chunkSize,
              onProgress: (prog) => s.message(prog.text)
            });
          }
          s.stop('✔ Upload complete');
          fs.writeFileSync(outPath, JSON.stringify(manifest));
          process.exitCode = 0;
        } catch (e) {
          s.stop('✖ Upload failed');
          console.error(`_internal_upload failed: ${e.message}`);
          process.exitCode = 1;
        } finally {
          // If we are running as root via sudo, rclone might have refreshed OAuth tokens
          // and rewritten rclone.conf as root:root. Restore ownership to the real user.
          if (process.getuid && process.getuid() === 0 && process.env.SUDO_UID && process.env.SUDO_GID) {
            const confPath = path.join(process.env.HOME, '.config', 'rclone', 'rclone.conf');
            if (fs.existsSync(confPath)) {
              try {
                fs.chownSync(confPath, parseInt(process.env.SUDO_UID, 10), parseInt(process.env.SUDO_GID, 10));
              } catch { /* best effort */ }
            }
          }
        }
        return;
      }

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

runMain(main).then(() => {
  // Force the process to exit cleanly regardless of any open file descriptors or
  // kernel mounts left by subvolid=5 bind-mounts created in snapshotDirFor.
  // process.on('exit') in snapshot.js will unmount them before we terminate.
  process.exit(process.exitCode ?? 0);
});
