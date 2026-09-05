/**
 * Pure-logic unit tests — no subprocesses, no sandbox. These pin down the
 * scheduler math, the allocator's account-choice, retention and the timeshift
 * parser so the trickier invariants (oldest-first catch-up, chunk tiling,
 * keep-limits) can never silently regress.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { dailyDues, weeklyDues, advancePending, dueDay } from '../src/core/time.js';
import { chooseAccount, walkFiles, MANIFEST_NAME } from '../src/storage/allocator.js';
import { planPrune, pruneOlderThan } from '../src/backup/retention.js';
import { parseTimeshiftList, extractCreatedName } from '../src/backup/snapshot.js';

test('wizard module integrity: runSetup and registration helpers are top-level', async () => {
  const setupMod = await import('../src/commands/setup.js');
  const remoteMod = await import('../src/commands/remote.js');
  assert.equal(typeof setupMod.runSetup, 'function', 'runSetup exported');
  assert.equal(typeof remoteMod.guidedRemoteAdd, 'function', 'guidedRemoteAdd exported');
  assert.equal(typeof remoteMod.registerRemotesAsAccounts, 'function', 'registerRemotesAsAccounts exported');
  assert.equal(typeof remoteMod.deleteRemote, 'function', 'deleteRemote exported');
  // Guard against the published-v1.0.0 bug: the call must be resolvable at module scope.
  assert.ok(!/referenceerror.*not defined/i.test(JSON.stringify(setupMod)), 'no ReferenceError baked in');
});

test('menu wizard + repair + self-update are all exported and parse as ESM', async () => {
  const wizard = await import('../src/commands/wizard.js');
  const manage = await import('../src/commands/manage.js');
  const self = await import('../src/lib/self.js');
  const tools = await import('../src/commands/tools.js');
  assert.equal(typeof wizard.runWizard, 'function', 'menu wizard exported');
  assert.equal(typeof manage.runRepair, 'function', 'repair exported');
  assert.equal(typeof manage.runUninstallWizard, 'function', 'uninstall exported');
  assert.equal(typeof self.runSelfUpdate, 'function', 'update exported');
  assert.equal(typeof self.compareVersions, 'function', 'version compare exported');
  assert.equal(typeof tools.runToolsCheck, 'function', 'tools check exported');
  assert.deepEqual(tools.REQUIRED.map((t) => t.bin), ['rclone', 'timeshift', 'git', 'curl']);
  assert.equal(self.compareVersions('1.0.2', '1.0.1'), 1);
  assert.equal(self.compareVersions('1.0.1', '1.0.2'), -1);
  assert.equal(self.compareVersions('1.0.2', '1.0.2'), 0);
});

const at = { hour: 22, minute: 0 };

test('dailyDues lists every 22:00 slot strictly after from, <= to', () => {
  const from = new Date('2026-08-29T00:00:00');
  const to = new Date('2026-08-31T23:59:59');
  const dues = dailyDues(from, to, at);
  assert.equal(dues.length, 3);
  for (const d of dues) assert.equal(d.getHours(), 22, 'rides at 22:00');
  assert.equal(dues[1].getDate(), dues[0].getDate() + 1, 'consecutive days');
  assert.equal(dues[2].getDate(), dues[0].getDate() + 2, 'consecutive days');
  // strict-after-from: the 22:00 of the from-day itself is excluded when from > 22:00
  const later = dailyDues(new Date('2026-08-29T23:00:00'), new Date('2026-08-30T23:59:59'), at);
  assert.equal(later.length, 1);
  assert.equal(later[0].getDate(), 30);
});

test('weeklyDues lists only matching weekdays (6 = Saturday)', () => {
  const from = new Date('2026-08-29T00:00:00'); // Saturday
  const to = new Date('2026-09-15T23:59:59');
  const dues = weeklyDues(from, to, 6, at);
  assert.equal(dues.length, 3);
  for (const d of dues) assert.equal(d.getDay(), 6, 'only Saturdays');
  assert.equal(dues[1].getTime() - dues[0].getTime(), 7 * 86_400_000);
  assert.equal(dues[2].getTime() - dues[1].getTime(), 7 * 86_400_000);
});

test('advancePending keeps only the newest missed dues when the window is huge', () => {
  const jobState = {
    since: '2026-01-01T10:00:00',
    lastDue: null,
    pending: [],
    completed: [],
  };
  const jobCfg = {
    schedule: { kind: 'daily', at },
    catchUpLimit: 3,
  };
  const res = advancePending(jobState, jobCfg, new Date('2026-08-20T12:00:00'));
  assert.equal(res.pending.length, 3, 'only the 3 most recent missed dues are kept');
  assert.ok(res.dropped > 0, `a huge backlog means many dropped stale dues (got ${res.dropped})`);
  assert.equal(res.pending[0] < res.pending[1] && res.pending[1] < res.pending[2], true, 'ascending');
  assert.equal(res.lastDue, '2026-08-19T22:00:00', 'window advances to the latest due before now');
});

test('advancePending never re-queues completed or already-pending dues', () => {
  const jobState = {
    since: '2026-08-01T00:00:00',
    lastDue: '2026-08-10T22:00:00',
    pending: ['2026-08-11T22:00:00'],
    completed: [{ due: '2026-08-09T22:00:00', at: '2026-08-09T22:01:00' }],
  };
  const jobCfg = { schedule: { kind: 'daily', at }, catchUpLimit: 3 };
  const res = advancePending(jobState, jobCfg, new Date('2026-08-12T00:00:00'));
  assert.ok(!res.pending.includes('2026-08-09T22:00:00'), 'completed dues never re-queued');
  assert.ok(res.pending.includes('2026-08-11T22:00:00'), 'existing pending kept');
});

test('dueDay extracts the calendar day', () => {
  assert.equal(dueDay('2026-08-29T22:00:00'), '2026-08-29');
});

test('chooseAccount spreads small files onto the least-full account', () => {
  const accounts = [
    { id: 'a', provider: 'mega',   remote: 'm1', total: 100, used: 90, free: 10 },
    { id: 'b', provider: 'mega',   remote: 'm2', total: 100, used: 20, free: 80 },
  ];
  // m2 has room for 5, m1 does not.
  assert.equal(chooseAccount(5, accounts).remote, 'm2');
  // With both full-ish, pick the one with the highest relative headroom.
  const almost = [
    { id: 'a', provider: 'mega', remote: 'm1', total: 100, used: 80, free: 20 },
    { id: 'b', provider: 'mega', remote: 'm2', total: 100, used: 75, free: 25 },
  ];
  assert.equal(chooseAccount(10, almost).remote, 'm2');

  // MEGA-first: even if gdrive has way more free space, pick mega while it fits.
  const mixed = [
    { id: 'c', provider: 'gdrive', remote: 'gd1', total: 15 * 1024 ** 3, used: 0,           free: 15 * 1024 ** 3 },
    { id: 'd', provider: 'mega',   remote: 'mg1', total: 20 * 1024 ** 3, used: 18 * 1024 ** 3, free: 2 * 1024 ** 3 },
  ];
  // mega has 2 GiB free, gdrive has 15 GiB free — still pick mega.
  assert.equal(chooseAccount(1 * 1024 ** 3, mixed).remote, 'mg1', 'mega preferred over gdrive');

  // Fallback to gdrive only when ALL mega accounts cannot fit the file.
  const megaFull = [
    { id: 'e', provider: 'mega',   remote: 'mg2', total: 20 * 1024 ** 3, used: 20 * 1024 ** 3, free: 0 },
    { id: 'f', provider: 'gdrive', remote: 'gd2', total: 15 * 1024 ** 3, used: 0,             free: 15 * 1024 ** 3 },
  ];
  assert.equal(chooseAccount(1 * 1024 ** 3, megaFull).remote, 'gd2', 'falls back to gdrive when mega full');
});

test('chooseAccount ignores near-empty usage noise and refills in account order', () => {
  // Three identical MEGA accounts. rclone `about` reports phantom usage on the
  // first (tens of MiB) — this must NOT make the allocator skip it / start
  // somewhere random. An all-empty pool is filled mega-1 → mega-2 → … .
  const MB = 1024 * 1024;
  const accounts = [
    { id: 'a', provider: 'mega', remote: 'mega-1', total: 20 * 1024 ** 3, used: 41 * MB, free: 20 * 1024 ** 3 - 41 * MB },
    { id: 'b', provider: 'mega', remote: 'mega-2', total: 20 * 1024 ** 3, used: 0,       free: 20 * 1024 ** 3 },
    { id: 'c', provider: 'mega', remote: 'mega-3', total: 20 * 1024 ** 3, used: 0,       free: 20 * 1024 ** 3 },
  ];
  const pool = accounts.map((a) => ({ ...a }));
  const pick = (need) => {
    const acc = chooseAccount(need, pool);
    const hit = pool.find((x) => x.id === acc.id);
    hit.used += need;
    hit.free -= need;
    return acc.remote;
  };
  assert.equal(pick(200 * MB), 'mega-1', 'phantom usage on mega-1 is ignored → starts with mega-1');
  assert.equal(pick(200 * MB), 'mega-2', 'once mega-1 is meaningfully fuller, mega-2 is next');
  assert.equal(pick(200 * MB), 'mega-3', 'then mega-3 — accounts fill in pool order');
  // mega-1 is only ~0.2% fuller than mega-2/3 → still within the 0.5% noise
  // band → treated as a tie → earliest account (mega-1) wins again.
  assert.equal(pick(200 * MB), 'mega-1', 'small differences still count as a tie → order wins');
});

test('walkFiles returns files + dirs with sane sizes, skipping symlinks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-walk-'));
  fs.mkdirSync(path.join(dir, 'sub'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello');
  try {
    fs.symlinkSync(path.join(dir, 'a.txt'), path.join(dir, 'link'));
  } catch { /* filesystem may not allow */ }
  const entries = walkFiles(dir);
  assert.ok(entries.some((e) => e.rel === 'a.txt' && e.isDir === false && e.size === 5));
  assert.ok(entries.some((e) => e.rel === 'sub' && e.isDir));
  assert.ok(!entries.some((e) => e.rel === 'link'), 'symlinks are not walked');
});

test('planPrune keeps the newest N and marks the rest', () => {
  const ids = ['2026-08-01T22:00:00', '2026-08-02T22:00:00', '2026-08-03T22:00:00', '2026-08-04T22:00:00'];
  const { keep, prune } = planPrune(ids, 3);
  assert.deepEqual(keep, ids.slice(1), 'newest 3 kept');
  assert.deepEqual(prune, [ids[0]], 'oldest pruned');
  assert.deepEqual(planPrune(ids, 99).prune, []);
  assert.deepEqual(planPrune(ids.slice(0, 2), 3).prune, []);
});

test('pruneOlderThan drops artifacts older than the age limit', () => {
  const now = Date.now();
  const artifacts = [
    { id: 'old', createdAt: new Date(now - 5 * 86_400_000).toISOString() },
    { id: 'fresh', createdAt: new Date(now - 86_400_000).toISOString() },
  ];
  const pruned = pruneOlderThan(artifacts, 3);
  assert.deepEqual(pruned.map((a) => a.id), ['old']);
});

test('parseTimeshiftList parses real timeshift --list output', () => {
  // Old-style plain rows (no header / no Num column).
  const oldOut = [
    '2026-08-29 22:00:01 W 2026-08-29_22-00-01 /timeshift/snapshots/2026-08-29_22-00-01',
    '2026-07-15 09:15:00 O 2026-07-15_09-15-00 /timeshift/snapshots/2026-07-15_09-15-00',
    'junk line that must be ignored',
  ].join('\n');
  const snaps = parseTimeshiftList(oldOut);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].name, '2026-07-15_09-15-00');
  assert.equal(snaps[1].name, '2026-08-29_22-00-01');
  assert.equal(snaps[1].tags, 'W');
  assert.ok(snaps[1].dir.endsWith('2026-08-29_22-00-01'));
});

test('parseTimeshiftList parses Timeshift 24.x table format (header + Num column)', () => {
  const out = [
    'Next run: disabled',
    'Num     Name                            Tags                Description',
    '0   2026-08-29 22:00:01  W  2026-08-29_22-00-01  parrot-blackbox',
    '1   2026-07-15 09:15:00  O  2026-07-15_09-15-00  parrot-blackbox',
  ].join('\n');
  const snaps = parseTimeshiftList(out);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].name, '2026-07-15_09-15-00', 'sorted oldest first');
  assert.equal(snaps[1].name, '2026-08-29_22-00-01');
  assert.equal(snaps[1].date, '2026-08-29');
  assert.equal(snaps[1].tags, 'W');
});

test('extractCreatedName reads the snapshot name from timeshift --create output', () => {
  assert.equal(
    extractCreatedName('Created new snapshot: 2026-08-31_16-00-01'),
    '2026-08-31_16-00-01',
  );
  assert.equal(
    extractCreatedName('\nCreated new snapshot: 2026-08-31_16-00-01\nsome log'),
    '2026-08-31_16-00-01',
  );
  assert.equal(extractCreatedName('nothing here'), null);
  assert.equal(extractCreatedName(''), null);
});

test('BTRFS stream manifests: tiny phantom sends are rejected, real streams accepted', async () => {
  const { isValidBtrfsStreamManifest, MIN_VALID_STREAM_BYTES } = await import('../src/backup/btrfs-send.js');
  const phantom = {
    schema: 2,
    kind: 'snapshots',
    id: 'x',
    entries: [{ rel: 'btrfs.stream', type: 'file', size: 13, split: true, loc: [{ remote: 'm', path: 'p' }] }],
  };
  const real = {
    schema: 2,
    kind: 'snapshots',
    id: 'y',
    entries: [{ rel: 'btrfs.stream', type: 'file', size: MIN_VALID_STREAM_BYTES, split: true, loc: [{ remote: 'm', path: 'p' }] }],
  };
  assert.equal(isValidBtrfsStreamManifest(null), false);
  assert.equal(isValidBtrfsStreamManifest({ schema: 2, entries: [] }), false);
  assert.equal(isValidBtrfsStreamManifest(phantom), false, '13-byte failed-send manifest is a phantom');
  assert.equal(isValidBtrfsStreamManifest(real), true, '>= 1 MiB stream is a real backup');
});

test('findLastUploadedSnapshot ignores phantom manifests and missing local snapshots', async () => {
  const { findLastUploadedSnapshot, MIN_VALID_STREAM_BYTES } = await import('../src/backup/btrfs-send.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-manifests-'));
  const write = (name, manifest) => fs.writeFileSync(path.join(dir, `snapshots-${name}.json`), JSON.stringify(manifest));

  const phantom = (name) => ({
    schema: 2,
    kind: 'snapshots',
    id: name,
    entries: [{ rel: 'btrfs.stream', type: 'file', size: 13, split: true, loc: [{ remote: 'm', path: name }] }],
  });
  const real = (name) => ({
    schema: 2,
    kind: 'snapshots',
    id: name,
    entries: [{ rel: 'btrfs.stream', type: 'file', size: MIN_VALID_STREAM_BYTES, split: true, loc: [{ remote: 'm', path: name }] }],
  });

  write('2026-09-03_11-15-41', phantom('2026-09-03_11-15-41'));
  // Not local → must be skipped even if valid.
  write('2026-09-03_11-53-43', real('2026-09-03_11-53-43'));
  write('2026-09-03_12-08-44', real('2026-09-03_12-08-44'));

  const locals = [
    { name: '2026-09-03_11-15-41', tags: 'W' },
    { name: '2026-09-03_12-08-44', tags: 'W' },
  ];

  // Newest *valid* + local → current snapshot.
  assert.equal(findLastUploadedSnapshot(dir, locals), '2026-09-03_12-08-44');
  // The phantom (2026-09-03_11-15-41) must never be selected even though it is local.
  const onlyPhantom = [{ name: '2026-09-03_11-15-41', tags: 'W' }];
  assert.equal(findLastUploadedSnapshot(dir, onlyPhantom), null, 'phantom alone yields null (full send)');
  assert.equal(findLastUploadedSnapshot('/definitely/not/a/dir', locals), null);
});

test('nextSnapshotUploadMode flags a FULL baseline vs incremental BEFORE creating', async () => {
  const { nextSnapshotUploadMode } = await import('../src/backup/snapshot.js');
  const { MIN_VALID_STREAM_BYTES } = await import('../src/backup/btrfs-send.js');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-mode-'));
  const cfg = { jobs: { snapshots: { btrfs: { enabled: true, incremental: true } } } };

  // Zero snapshots → the wizard MUST warn about a full baseline.
  assert.deepEqual(
    await nextSnapshotUploadMode({ cfg, localSnaps: [], manifestsDirOverride: dir }),
    { full: true, parent: null, reason: 'no fully-uploaded parent snapshot on disk' },
  );

  // A valid, still-present parent manifest → incremental (no warning needed).
  const real = {
    schema: 2,
    kind: 'snapshots',
    id: '2026-09-03_12-08-44',
    entries: [{ rel: 'btrfs.stream', type: 'file', size: MIN_VALID_STREAM_BYTES, split: true, loc: [{ remote: 'm', path: 'p' }] }],
  };
  fs.writeFileSync(path.join(dir, 'snapshots-2026-09-03_12-08-44.json'), JSON.stringify(real));
  assert.deepEqual(
    await nextSnapshotUploadMode({ cfg, localSnaps: [{ name: '2026-09-03_12-08-44', tags: 'W' }], manifestsDirOverride: dir }),
    { full: false, parent: '2026-09-03_12-08-44', reason: null },
  );

  // BTRFS disabled → no full-stream warning (file-copy mode instead).
  const cfgOff = { jobs: { snapshots: { btrfs: { enabled: false, incremental: true } } } };
  assert.equal((await nextSnapshotUploadMode({ cfg: cfgOff, localSnaps: [], manifestsDirOverride: dir })).full, false);

  // incremental disabled in config → full sends are user-intended, don't warn.
  const cfgNoInc = { jobs: { snapshots: { btrfs: { enabled: true, incremental: false } } } };
  assert.equal((await nextSnapshotUploadMode({ cfg: cfgNoInc, localSnaps: [], manifestsDirOverride: dir })).full, false);
});

test('snapshotEpochFromName parses Timeshift names and falls back to now', async () => {
  const { snapshotEpochFromName } = await import('../src/backup/restore.js');
  const got = snapshotEpochFromName('2026-09-03_12-08-44');
  const d = new Date(got * 1000);
  assert.equal(d.getFullYear(), 2026);
  assert.equal(d.getMonth(), 8); // September (0-based)
  assert.equal(d.getDate(), 3);
  assert.equal(d.getHours(), 12);
  assert.equal(d.getMinutes(), 8);
  // Garbage falls back to the current time (no crash, no NaN).
  const fb = snapshotEpochFromName('not-a-snapshot');
  assert.ok(Number.isFinite(fb) && fb > 1_500_000_000);
});

test('collectFiles backs up bare-file sources verbatim, skips git repos and missing sources', async () => {
  const { collectFiles } = await import('../src/backup/git-exclude.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-collect-'));
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Programming'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Desktop', 'note.txt'), 'hi');
  fs.writeFileSync(path.join(home, '.gitconfig'), '[user]\n\tname = T\n');
  fs.writeFileSync(path.join(home, 'Programming', 'plain.txt'), 'x');
  fs.mkdirSync(path.join(home, 'Programming', 'gitproj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Programming', 'gitproj', 'tracked.txt'), 'y');

  const col = collectFiles(['~/Desktop', '~/.gitconfig', '~/Programming', '~/DoesNotExist'], {
    exclude: ['**/.cache/**', '**/node_modules/**'],
    home,
  });

  const rels = col.files.map((f) => f.rel).sort();
  assert.ok(rels.includes('Desktop/note.txt'), 'folder source is walked');
  assert.ok(rels.includes('.gitconfig'), 'bare-file source is backed up verbatim');
  assert.ok(rels.includes('Programming/plain.txt'), 'plain nested file included');
  assert.ok(!rels.includes('Programming/gitproj/tracked.txt'), 'nested git repo is skipped (GitHub owns it)');
  assert.ok(col.skippedRepos.includes(path.join(home, 'Programming', 'gitproj')), 'nested git repo reported');
  assert.deepEqual(col.missing, ['~/DoesNotExist'], 'missing source reported, not fatal');
});

test('urgent module exposes the rescue source list, lean excludes and helper functions', async () => {
  const urgent = await import('../src/backup/urgent.js');
  assert.equal(urgent.KIND, 'urgent');
  assert.equal(typeof urgent.runUrgentBackup, 'function');
  assert.equal(typeof urgent.buildUrgentBundle, 'function');

  for (const d of ['Desktop', 'Downloads', 'Documents', 'Learning', 'Music', 'Pictures', 'Programming', 'Videos']) {
    assert.ok(urgent.URGENT_SOURCES.includes(`~/${d}`), `working source ~/${d}`);
  }
  for (const d of ['~/.vscode-oss', '~/.vscode-oss-shared', '~/.config/VSCodium/User', '~/.gitswitch', '~/.ssh', '~/.gitconfig']) {
    assert.ok(urgent.URGENT_SOURCES.includes(d), `tooling source ${d}`);
  }
  // Bloat / cache noise must be excluded, never uploaded.
  for (const p of ['**/node_modules/**', '**/.git/**', '**/.cache/**', '**/Cache/**', '**/Code Cache/**', '**/GPUCache/**']) {
    assert.ok(urgent.URGENT_EXCLUDE.includes(p), `lean exclude ${p}`);
  }
});

test('urgent sources collect correctly in a sandbox home (git repos skipped, files verbatim)', async () => {
  const { collectFiles } = await import('../src/backup/git-exclude.js');
  const { URGENT_SOURCES, URGENT_EXCLUDE } = await import('../src/backup/urgent.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-urgent-'));
  fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Pictures'), { recursive: true });
  fs.mkdirSync(path.join(home, 'Music'), { recursive: true });
  fs.mkdirSync(path.join(home, '.ssh'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Desktop', 'note.txt'), 'hi');
  fs.writeFileSync(path.join(home, 'Pictures', 'img.bin'), 'xx');
  fs.writeFileSync(path.join(home, '.gitconfig'), 'cfg');
  fs.writeFileSync(path.join(home, '.ssh', 'config'), '# ssh');
  fs.mkdirSync(path.join(home, 'Music', 'gitproj', '.git'), { recursive: true });
  fs.writeFileSync(path.join(home, 'Music', 'gitproj', 'tracked.txt'), 'z');

  const col = collectFiles(URGENT_SOURCES, { exclude: URGENT_EXCLUDE, home });
  const rels = col.files.map((f) => f.rel);
  assert.ok(rels.includes('Desktop/note.txt'), 'Desktop walked');
  assert.ok(rels.includes('Pictures/img.bin'), 'Pictures walked');
  assert.ok(rels.includes('.gitconfig'), '.gitconfig backed up verbatim');
  assert.ok(rels.includes('.ssh/config'), '.ssh walked');
  assert.ok(!rels.some((r) => r.includes('gitproj')), 'nested git repo skipped');
  assert.ok(col.skippedRepos.some((r) => r.endsWith('gitproj')), 'git repo reported as skipped');
  // Sources absent from the sandbox (e.g. no VSCodium install) are tolerated.
  assert.ok(Array.isArray(col.missing), 'missing sources tolerated');
});
test('lsjson args must NEVER include --json (real rclone rejects that flag)', async () => {
  const { lsjsonArgs } = await import('../src/storage/rclone.js');
  const rec = lsjsonArgs('mega-1:parrot-blackbox/urgent', { recursive: true });
  assert.deepEqual(rec, ['lsjson', 'mega-1:parrot-blackbox/urgent', '--recursive'], 'recursive args');
  assert.ok(!rec.includes('--json'), 'recursive must not carry --json');
  const flat = lsjsonArgs('mega-1:root', { recursive: false });
  assert.deepEqual(flat, ['lsjson', 'mega-1:root'], 'non-recursive args');
  assert.ok(!flat.includes('--json'), 'non-recursive must not carry --json');
});

test('manifest mirror resolves to the canonical state dir, never CWD ./manifests', async () => {
  const { manifestMirrorPath } = await import('../src/storage/archive.js');
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'pbb-mirror-'));
  const prevHome = process.env.HOME;
  const prevState = process.env.PBB_STATE_DIR;
  try {
    process.env.HOME = tmpHome;
    delete process.env.PBB_STATE_DIR;
    delete process.env.PBB_MANIFESTS_DIR;
    // When run from any CWD, the mirror must live under the user state dir.
    const p = manifestMirrorPath('urgent', '2026-09-04T19:44:39');
    assert.ok(p.startsWith(path.join(tmpHome, '.local', 'state', 'parrot-blackbox', 'manifests')),
      `expected canonical state path, got ${p}`);
    assert.ok(!p.startsWith(path.resolve('.')), 'must never be CWD-relative');
  } finally {
    process.env.HOME = prevHome;
    if (prevState === undefined) delete process.env.PBB_STATE_DIR; else process.env.PBB_STATE_DIR = prevState;
    fs.rmSync(tmpHome, { recursive: true, force: true });
  }
});

test('parseTransferFrame reads rclone byte progress but ignores the file-count frame', async () => {
  const { parseTransferFrame } = await import('../src/storage/rclone.js');
  const MB = 1024 * 1024;
  const byteFrame = 'Transferred:   \t    4.082 MiB / 20 MiB, 20%, 0 B/s, ETA -';
  assert.deepEqual(
    parseTransferFrame(byteFrame),
    { done: Math.round(4.082 * MB), total: 20 * MB },
    'parses the BYTE frame',
  );
  // The separate file-count progress line must NOT be mistaken for bytes.
  assert.equal(parseTransferFrame('Transferred:            0 / 2, 0%'), null, 'file-count frame ignored');
  assert.equal(parseTransferFrame('Checks:                 0 / 0, -, Listed 2'), null, 'non-Transferred line ignored');
  assert.equal(parseTransferFrame(''), null, 'empty frame ignored');
  // Final 100% frame.
  const finalFrame = 'Transferred:   	       12 MiB / 12 MiB, 100%, 3.018 MiB/s, ETA 0s';
  assert.deepEqual(parseTransferFrame(finalFrame), { done: 12 * MB, total: 12 * MB }, 'parses final 100% frame');
});