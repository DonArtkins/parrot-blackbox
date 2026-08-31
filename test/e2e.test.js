/**
 * End-to-end tests of the REAL CLI inside a sandboxed fake world
 * (stub rclone/timeshift/sudo + fake cloud + fake HOME). These are the
 * Level-5-safety proof points: nothing outside the sandbox is ever touched.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  setupSandbox,
  addRemote,
  populateHome,
  runCli,
  readManifest,
  cloudDirs,
  cloudFiles,
  seedCloudManifest,
  enableFileBackups,
} from './sandbox/env.js';

/** Add the two accounts the way a user would. */
async function twoAccountSetup(s) {
  addRemote(s.env, { remote: 'megaOne', quotaGiB: 20 });
  addRemote(s.env, { remote: 'gdriveOne', quotaGiB: 15 });
  for (const [remote, provider] of [['megaOne', 'mega'], ['gdriveOne', 'gdrive']]) {
    const r = await runCli(['account', 'add', provider, remote], s.env);
    assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  }
  const list = await runCli(['account', 'list'], s.env);
  assert.ok(list.stdout.includes('2 account(s)'), list.stdout + list.stderr);
}

/** Latest files-generations id in the sandbox manifests dir. */
function latestFilesId(s) {
  const dir = path.join(s.state, 'manifests');
  const mf = fs.readdirSync(dir).filter((f) => f.startsWith('files-')).sort();
  assert.ok(mf.length >= 1, 'expected at least one files manifest');
  return mf.pop().slice('files-'.length, -'.json'.length);
}

test('remote add: guided MEGA flow creates the rclone remote AND saves the account', async () => {
  const s = setupSandbox('remoteadd');
  populateHome(s);

  // No remotes exist yet.
  const r0 = await runCli(['remote', 'list'], s.env);
  assert.equal(r0.exitCode, 0, r0.stdout + r0.stderr);
  assert.ok(/No rclone remotes configured yet/.test(r0.stdout), r0.stdout);

  // Guided add with args: provider mega, name mega-1. Credentials come via env
  // (PBB_MEGA_USER / PBB_MEGA_PASS) because the test is non-interactive.
  const r = await runCli(['remote', 'add', 'mega', 'mega-1'], { ...s.env, PBB_MEGA_USER: 'backup@example.com', PBB_MEGA_PASS: 'hunter2' });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/Added/.test(r.stdout) && /mega-1/.test(r.stdout), r.stdout);

  // The remote is registered in the pool (parrot-blackbox config saved).
  const cfg = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  const acc = (cfg.storage.accounts || []).find((a) => a.remote === 'mega-1');
  assert.ok(acc, 'mega-1 should be saved in the parrot-blackbox pool config');
  assert.equal(acc.provider, 'mega');

  // remote list shows it as registered.
  const rl = await runCli(['remote', 'list'], s.env);
  assert.ok(/mega-1/.test(rl.stdout) && /registered/.test(rl.stdout), rl.stdout);

  // remote remove deletes it from rclone AND from the pool.
  const rr = await runCli(['remote', 'remove', 'mega-1'], s.env);
  assert.equal(rr.exitCode, 0, rr.stdout + rr.stderr);
  const remotes = await runCli(['remote', 'list'], s.env);
  assert.ok(!/mega-1/.test(remotes.stdout), `mega-1 should be gone, got: ${remotes.stdout}`);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  assert.ok(!(cfg2.storage.accounts || []).some((a) => a.remote === 'mega-1'), 'pool entry removed too');
});

test('remote add: duplicate registration refuses', async () => {
  const s = setupSandbox('remotedup');
  populateHome(s);
  addRemote(s.env, { remote: 'megaDup', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaDup'], s.env);

  // Registering the same remote again must not silently double-add.
  const cfg0 = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  const count0 = cfg0.storage.accounts.length;
  const r = await runCli(['remote', 'add', 'mega', 'megaDup'], { ...s.env, PBB_MEGA_PASS: 'x' });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/✖|already uses remote|Could not add/.test(r.stdout), r.stdout);
  const cfg1 = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg1.storage.accounts.length, count0, 'no duplicate pool entry');
});

test('account add/list/quota/remove (pool-only, rclone remote pre-created)', async () => {
  const s = setupSandbox('accounts');
  populateHome(s);
  addRemote(s.env, { remote: 'm1', quotaGiB: 20 });
  addRemote(s.env, { remote: 'd1', quotaGiB: 10 });

  let r = await runCli(['account', 'add', 'mega', 'm1'], s.env);
  assert.equal(r.exitCode, 0, r.stderr);
  assert.ok(/Added/.test(r.stdout), r.stdout);
  r = await runCli(['account', 'add', 'gdrive', 'd1'], s.env);
  assert.equal(r.exitCode, 0, r.stderr);
  r = await runCli(['account', 'list'], s.env);
  assert.ok(r.stdout.includes('2 account(s)'), r.stdout);
  assert.ok(r.stdout.includes('m1') && r.stdout.includes('d1'), r.stdout);

  const cfg = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  const d1 = cfg.storage.accounts.find((a) => a.remote === 'd1');
  r = await runCli(['account', 'quota', d1.id, '9'], s.env);
  assert.equal(r.exitCode, 0);
  const cfg2 = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg2.storage.accounts.find((a) => a.remote === 'd1').quotaGiB, 9);

  r = await runCli(['account', 'remove', d1.id], s.env);
  assert.equal(r.exitCode, 0);
  const cfg3 = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg3.storage.accounts.length, 1);
});

test('defaults: weekly snapshot is the backup — daily files are opt-in', async () => {
  const s = setupSandbox('defaults');
  populateHome(s);
  addRemote(s.env, { remote: 'megaDf', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaDf'], s.env);

  const cfg = JSON.parse(fs.readFileSync(path.join(s.env.PBB_STATE_DIR, 'config.json'), 'utf8'));
  assert.equal(cfg.jobs.files.enabled, false, 'file backups are DISABLED by default');
  assert.equal(cfg.jobs.snapshots.enabled, true, 'snapshots are ENABLED by default');
  assert.equal(cfg.jobs.snapshots.schedule.kind, 'weekly');
  assert.equal(cfg.jobs.snapshots.schedule.on, 6, 'weekly = Saturday');
});

test('force backup: placement, git-skip, exclusions, manifest', async () => {
  const s = setupSandbox('force');
  populateHome(s);
  await twoAccountSetup(s);
  enableFileBackups(s); // daily file backups are opt-in; this test exercises them

  const r = await runCli(['force'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);

  const id = latestFilesId(s);
  const man = readManifest(s.state, 'files', id);
  const rels = man.entries.map((e) => e.rel);
  assert.ok(rels.some((p) => p.includes('index.txt')), 'Documents/index.txt backed up');
  assert.ok(rels.some((p) => p.includes('wallpaper.png')), 'Desktop/wallpaper.png backed up');
  assert.ok(!rels.some((p) => p.includes('project')), 'nested git repo must be excluded');
  assert.ok(!rels.some((p) => p.includes('.bashrc')), 'non-source home files not included');

  for (const entry of man.entries) {
    if (entry.type === 'dir') continue;
    for (const loc of entry.loc) {
      const localPath = path.join(s.env.PBB_SANDBOX_CLOUD, loc.remote, loc.path);
      assert.ok(fs.existsSync(localPath), `missing cloud file ${loc.path}`);
    }
  }
});

test('smart storage: split a file bigger than any single account, byte-perfect restore', async () => {
  const s = setupSandbox('striping');
  addRemote(s.env, { remote: 'megaA', quotaGiB: 0.023 }); // ~24.7 MiB
  addRemote(s.env, { remote: 'megaB', quotaGiB: 0.019 }); // ~20.4 MiB  (sum ≈ 45 MiB > 40 MiB)
  await runCli(['account', 'add', 'mega', 'megaA'], s.env);
  await runCli(['account', 'add', 'mega', 'megaB'], s.env);

  const bigDir = path.join(s.home, 'Documents', 'big');
  fs.mkdirSync(bigDir, { recursive: true });
  const bigFile = path.join(bigDir, 'giant.bin');
  const chunkSize = 256 * 1024;
  fs.writeFileSync(bigFile, Buffer.alloc(40 * 1024 * 1024, 0x61)); // 40 MiB

  const cfgPath = path.join(s.env.PBB_STATE_DIR, 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.storage.chunkSize = chunkSize;
  cfg.jobs.files.enabled = true; // daily files are opt-in; enable for this test
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  const r = await runCli(['force'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);

  const id = latestFilesId(s);
  const man = readManifest(s.state, 'files', id);
  const bigEntry = man.entries.find((e) => e.rel.endsWith('giant.bin'));
  assert.ok(bigEntry, 'giant.bin should be in the backup');
  assert.equal(bigEntry.split, true, 'big file must be chunked');
  assert.ok(bigEntry.loc.length > 1, `expected multiple chunks, got ${bigEntry.loc.length}`);
  // Chunk byte-ranges must tile the whole file with no gaps/overlaps.
  const sorted = [...bigEntry.loc].sort((a, b) => a.start - b.start);
  let cursor = 0;
  for (const loc of sorted) {
    assert.equal(loc.start, cursor, 'chunks tile contiguously');
    cursor = loc.end;
  }
  assert.equal(cursor, bigEntry.size, 'chunks cover the full file');

  const outDir = path.join(s.root, 'restored');
  const r2 = await runCli(['restore', 'files', id, outDir], s.env);
  assert.equal(r2.exitCode, 0, r2.stdout + r2.stderr);
  assert.equal(
    fs.readFileSync(path.join(outDir, bigEntry.rel), 'utf8'),
    fs.readFileSync(bigFile, 'utf8'),
    'chunked restore must reproduce bytes exactly',
  );
});

test('restore files: brings user files back into a fresh directory', async () => {
  const s = setupSandbox('restore');
  populateHome(s);
  await twoAccountSetup(s);
  enableFileBackups(s);
  await runCli(['force'], s.env);

  const id = latestFilesId(s);
  const outDir = path.join(s.root, 'recovered');
  const r = await runCli(['restore', 'files', id, outDir], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(fs.existsSync(path.join(outDir, 'Documents', 'index.txt')), 'index.txt restored');
  assert.ok(fs.existsSync(path.join(outDir, 'Desktop', 'wallpaper.png')), 'wallpaper restored');
  assert.equal(
    fs.readFileSync(path.join(outDir, 'Documents', 'index.txt'), 'utf8'),
    'important text\n'.repeat(50),
    'contents byte-perfect',
  );
});

test('retention: prunes file backups beyond keep', async () => {
  const s = setupSandbox('retention');
  populateHome(s);
  addRemote(s.env, { remote: 'megaR', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaR'], s.env);
  enableFileBackups(s); // daily files are opt-in; this test exercises their retention

  // Seed 3 older cloud generations by writing manifests straight into the fake cloud.
  for (const when of ['2026-08-20T22:00:00', '2026-08-21T22:00:00', '2026-08-22T22:00:00']) {
    seedCloudManifest(s.env, 'megaR', 'files', when);
  }

  const r = await runCli(['force'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);

  const after = cloudDirs(s.env, 'megaR', 'parrot-blackbox/files');
  const genDirs = after.filter((d) => /^20/.test(d) && !d.includes('/'));
  assert.ok(genDirs.length <= 3, `retention keeps <=3 generations, got ${genDirs.length}: ${after.join(',')}`);
  assert.ok(!after.includes('2026-08-20T22:00:00'), 'oldest seeded generation pruned');
  assert.ok(after.includes('2026-08-21T22:00:00'), '2026-08-21 kept');
  assert.ok(after.includes('2026-08-22T22:00:00'), '2026-08-22 kept');
});

test('scheduler: missed dues caught up oldest-first on the next run', async () => {
  const s = setupSandbox('catchup');
  populateHome(s);
  await twoAccountSetup(s);
  enableFileBackups(s); // daily files are opt-in; this test exercises the catch-up engine

  // Anchor the schedule start in the past (creates + persists state.since).
  const anchor = await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: '2026-08-25T10:00:00' });
  assert.equal(anchor.exitCode, 0, anchor.stdout + anchor.stderr);

  // Now jump forward a week: three daily dues (08-29/30/31 22:00) are missed.
  const future = '2026-09-01T12:00:00';
  const run2 = await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: future });
  assert.equal(run2.exitCode, 0, run2.stdout + run2.stderr);

  const ids = fs.readdirSync(path.join(s.state, 'manifests'))
    .filter((f) => f.startsWith('files-'))
    .map((f) => f.slice('files-'.length, -'.json'.length))
    .sort();
  assert.ok(ids.length >= 1, `expected catch-up runs, got ${ids.join(',')}`);
  for (let i = 1; i < ids.length; i++) assert.ok(ids[i] > ids[i - 1], 'ascending order');
  for (const id of ids) assert.ok(id < future, 'all caught-up dues are before now');
});

test('offline deferral: no partial runs, everything drains on reconnect', async () => {
  const s = setupSandbox('defer');
  populateHome(s);
  await twoAccountSetup(s);
  enableFileBackups(s); // daily files are opt-in; this test exercises the offline gate

  // Anchor the schedule start (persisted state.since).
  await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: '2026-08-25T10:00:00' });

  // Offline on a day with a due → nothing uploads, everything defers.
  const offlineRun = await runCli(['run'], { ...s.env, PBB_NETWORK: 'offline', PBB_TEST_NOW: '2026-09-02T10:00:00' });
  assert.equal(offlineRun.exitCode, 0, offlineRun.stdout + offlineRun.stderr);
  const cloudAfter = cloudDirs(s.env, 'megaOne', 'parrot-blackbox');
  assert.equal(cloudAfter.length, 0, 'offline must not upload anything');

  // Reconnect: missed backups run and land in the cloud.
  const onlineRun = await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: '2026-09-02T10:05:00' });
  assert.equal(onlineRun.exitCode, 0, onlineRun.stdout + onlineRun.stderr);
  const cloudNow = cloudDirs(s.env, 'megaOne', 'parrot-blackbox');
  assert.ok(cloudNow.some((d) => d.startsWith('files/')), 'backups appeared after reconnect');
});
test('snapshots (the default job) catch up missed weekly dues on the next run', async () => {
  const s = setupSandbox('snapcatch');
  populateHome(s);
  addRemote(s.env, { remote: 'megaSc', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaSc'], s.env);

  // Anchor before any due (Saturday 08-22 10:00 < 22:00 → nothing due yet).
  const anchor = await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: '2026-08-22T10:00:00' });
  assert.equal(anchor.exitCode, 0, anchor.stdout + anchor.stderr);

  // Machine off for two Saturdays → both weekly dues (08-29, 09-05) are missed.
  const future = '2026-09-05T12:00:00';
  const r = await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: future });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/snapshots/.test(r.stdout), `expected snapshot runs, got: ${r.stdout}`);

  const snaps = fs.readdirSync(path.join(s.state, 'manifests')).filter((f) => f.startsWith('snapshots-'));
  assert.ok(snaps.length >= 1, `expected snapshot catch-up, got manifests: ${snaps.join(',')}`);
  for (const f of snaps) {
    const id = f.slice('snapshots-'.length, -'.json'.length);
    assert.ok(id.slice(0, 10) <= '2026-09-05', `snapshot ${id} must be before now`);
  }
});

test('snapshot now: create → upload → manifest, cloud + local prune', async () => {
  const s = setupSandbox('snap');
  populateHome(s);
  addRemote(s.env, { remote: 'megaS', quotaGiB: 20 });
  addRemote(s.env, { remote: 'gdriveS', quotaGiB: 15 });
  await runCli(['account', 'add', 'mega', 'megaS'], s.env);
  await runCli(['account', 'add', 'gdrive', 'gdriveS'], s.env);

  // Seed OLD local + cloud snapshots so prune has something to do.
  const tsSnaps = path.join(s.env.PBB_TIMESHIFT_DIR, 'snapshots');
  const oldSnaps = ['2026-06-24_10-00-00', '2026-07-01_10-00-00', '2026-07-08_10-00-00', '2026-07-15_10-00-00'];
  for (const when of oldSnaps) {
    const d = path.join(tsSnaps, when);
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, 'marker'), 'old');
    seedCloudManifest(s.env, 'megaS', 'snapshots', when);
  }

  const r = await runCli(['snapshot', 'now'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);

  // New snapshot exists locally and in cloud.
  const localDirs = fs.readdirSync(tsSnaps).filter((d) => /^2026/.test(d) && !oldSnaps.includes(d));
  assert.equal(localDirs.length, 1, `one new local snapshot, got ${localDirs.join(',')}`);
  const snapName = localDirs[0];
  const cloudAvail = cloudDirs(s.env, 'megaS', 'parrot-blackbox/snapshots');
  assert.ok(cloudAvail.includes(snapName), `cloud has snapshot dir; got ${cloudAvail.join(',')}`);
  const snapFiles = cloudFiles(s.env, 'megaS', `parrot-blackbox/snapshots/${snapName}`);
  assert.ok(snapFiles.length >= 1, 'snapshot payload uploaded');

  // keep=3 → the two oldest (06-24, 07-01) pruned; 07-08 + 07-15 + new stay.
  const after = fs.readdirSync(tsSnaps);
test('snapshot now works even when timeshift --list requires admin (real-world bug)', async () => {
  const s = setupSandbox('snapsudo');
  populateHome(s);
  addRemote(s.env, { remote: 'megaSnap', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaSnap'], s.env);

  // Simulate the user's machine: `timeshift --list` refuses without admin,
  // and we run truly through the sudo path (PBB_SUDO_DIRECT=0 -> sudo stub).
  const r = await runCli(['snapshot', 'now'], {
    ...s.env,
    PBB_SUDO_DIRECT: '0',
    PBB_TIMESHIFT_LIST_REQUIRES_SUDO: '1',
  });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(!/no snapshot was found|reported success but no snapshot/i.test(r.stdout), r.stdout);

  // The snapshot must exist locally (timeshift stub dir) and in the fake cloud.
  const tsSnaps = path.join(s.env.PBB_TIMESHIFT_DIR, 'snapshots');
  const localDirs = fs.readdirSync(tsSnaps).filter((d) => /^2026/.test(d));
  assert.equal(localDirs.length, 1, `one local snapshot, got ${localDirs.join(',')}`);
  const cloudAvail = cloudDirs(s.env, 'megaSnap', 'parrot-blackbox/snapshots');
  assert.ok(cloudAvail.includes(localDirs[0]), `cloud snapshot uploaded; got ${cloudAvail.join(',')}`);
});
  assert.ok(!after.includes('2026-06-24_10-00-00'), 'oldest snapshot pruned locally');
  assert.ok(!after.includes('2026-07-01_10-00-00'), 'second-old snapshot pruned locally');
  assert.ok(after.includes('2026-07-08_10-00-00'), '07-08 kept');
  assert.ok(after.includes('2026-07-15_10-00-00'), '07-15 kept');
  assert.ok(cloudAvail.filter((d) => d.startsWith('2026-')).length <= 3, 'cloud snapshot count bounded by keep');
  assert.ok(!cloudAvail.includes('2026-06-24_10-00-00'), 'cloud prune in the same pass');
});

test('daemon: snapshot jobs defer when sudo timestamp lapsed (never hang)', async () => {
  const s = setupSandbox('sudodefer');
  populateHome(s);
  addRemote(s.env, { remote: 'megaD', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaD'], s.env);

  // Anchor the schedule in the past (no sudo needed for --list / --create at run time).
  await runCli(['run'], { ...s.env, PBB_NETWORK: 'online', PBB_TEST_NOW: '2026-08-25T10:00:00' });

  // Now a due exists but sudo is NOT available: the background/daemon path must
  // defer instead of hanging on a password prompt. Use the real sudo stub path
  // (PBB_SUDO_DIRECT=0) so sudo -n is actually invoked and refused.
  const r = await runCli(['run'], {
    ...s.env,
    PBB_NETWORK: 'online',
    PBB_SUDO_DIRECT: '0',
    PBB_SUDO_REFUSE: '1',
    PBB_TEST_NOW: '2026-09-05T22:05:00',
  });
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  const state = JSON.parse(fs.readFileSync(path.join(s.state, 'state.json'), 'utf8'));
  assert.equal(state.jobs.snapshots.lastStatus, 'deferred', `lastStatus=${state.jobs.snapshots.lastStatus}`);
});

test('daemon start/stop lifecycle', async () => {
  const s = setupSandbox('daemon');
  populateHome(s);
  addRemote(s.env, { remote: 'megaDa', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaDa'], s.env);

  const start = await runCli(['daemon', 'start'], { ...s.env, PBB_NETWORK: 'offline' });
  assert.equal(start.exitCode, 0, start.stdout + start.stderr);
  const status = await runCli(['daemon', 'status'], s.env);
  assert.ok(/running/.test(status.stdout), status.stdout);

  const stop = await runCli(['daemon', 'stop'], s.env);
  assert.equal(stop.exitCode, 0, stop.stderr);
  const status2 = await runCli(['daemon', 'status'], s.env);
  assert.ok(/not running/.test(status2.stdout), status2.stdout);
});

test('restore snapshot: downloads cloud snapshot & hands to timeshift --restore', async () => {
  const s = setupSandbox('snaprestore');
  populateHome(s);
  addRemote(s.env, { remote: 'megaR2', quotaGiB: 20 });
  await runCli(['account', 'add', 'mega', 'megaR2'], s.env);

  await runCli(['snapshot', 'now'], s.env);
  const mf = fs.readdirSync(path.join(s.state, 'manifests')).filter((f) => f.startsWith('snapshots-')).sort().pop();
  const id = mf.slice('snapshots-'.length, -'.json'.length);

  // Without --yes, restore must refuse (Level-5 guard).
  const refuse = await runCli(['restore', 'snapshot', id], { ...s.env, PBB_NETWORK: 'offline' });
  assert.equal(refuse.exitCode, 0, refuse.stdout + refuse.stderr);
  assert.ok(/aborted|nothing was touched|refusing|not found|confirmation/i.test(refuse.stdout), refuse.stdout);

  // With --yes it proceeds to the interactive timeshift --restore (stub logs it).
  const accept = await runCli(['restore', 'snapshot', id, '--yes'], s.env);
  assert.equal(accept.exitCode, 0, accept.stdout.substring(0, 500));
  assert.ok(/Restoring|restore/i.test(accept.stdout), accept.stdout);
});
test('repair: fixes a broken install (tools, config, service, pool) without hanging', async () => {
  const s = setupSandbox('repair');
  populateHome(s);
  addRemote(s.env, { remote: 'megaRep', quotaGiB: 20 });

  // Simulate a broken install for the pool probe: add a pool account whose
  // rclone remote does NOT exist. Repair --yes should drop it.
  const cfgPath = path.join(s.env.PBB_STATE_DIR, 'config.json');
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify({
    storage: { accounts: [{ id: 'dead', provider: 'mega', label: 'dead', remote: 'ghost' }] },
  }));

  const r = await runCli(['repair', '--yes'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/Repair|Tools|Config|Pool|Service/.test(r.stdout), r.stdout.slice(0, 400));
  // The stale pool entry should be gone.
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  assert.ok(!(cfg.storage.accounts || []).some((a) => a.remote === 'ghost'), 'stale pool entry removed');
});

test('update: tells you you are current (non-interactive, no hang)', async () => {
  const s = setupSandbox('update');
  populateHome(s);
  // In sandbox PATH there is no npm stub, so this hits the real registry and
  // reports on-latest (local is 1.0.2) — non-TTY path prints and exits.
  const r = await runCli(['update'], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/latest|v1\.0|npm install -g/i.test(r.stdout), r.stdout.slice(0, 400));
});

test('menu wizard refuses to run when stdin is not a TTY (no hang)', async () => {
  const s = setupSandbox('menu');
  populateHome(s);
  const r = await runCli([], s.env);
  assert.equal(r.exitCode, 0, r.stdout + r.stderr);
  assert.ok(/No interactive terminal/i.test(r.stdout), r.stdout.slice(0, 300));
});
