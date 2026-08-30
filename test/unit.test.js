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
import { parseTimeshiftList } from '../src/backup/snapshot.js';

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
    { id: 'a', remote: 'm1', total: 100, used: 90, free: 10 },
    { id: 'b', remote: 'm2', total: 100, used: 20, free: 80 },
  ];
  // m2 has room for 5, m1 does not.
  assert.equal(chooseAccount(5, accounts).remote, 'm2');
  // With both full-ish, pick the one with the highest relative headroom.
  const almost = [
    { id: 'a', remote: 'm1', total: 100, used: 80, free: 20 },
    { id: 'b', remote: 'm2', total: 100, used: 75, free: 25 },
  ];
  assert.equal(chooseAccount(10, almost).remote, 'm2');
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
  const out = [
    '2026-08-29 22:00:01 W 2026-08-29_22-00-01 /timeshift/snapshots/2026-08-29_22-00-01',
    '2026-07-15 09:15:00 O 2026-07-15_09-15-00 /timeshift/snapshots/2026-07-15_09-15-00',
    'junk line that must be ignored',
  ].join('\n');
  const snaps = parseTimeshiftList(out);
  assert.equal(snaps.length, 2);
  assert.equal(snaps[0].name, '2026-07-15_09-15-00');
  assert.equal(snaps[1].name, '2026-08-29_22-00-01');
  assert.equal(snaps[1].tags, 'W');
  assert.ok(snaps[1].dir.endsWith('2026-08-29_22-00-01'));
});