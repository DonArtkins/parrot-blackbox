/**
 * Crash-proof persistence: config, state and append-only journal.
 *
 * State writes are atomic (tmp + rename) so a crash mid-write can never leave
 * a truncated file. Every job opens a journal entry on start and only closes
 * it on success, so interrupted runs are always discoverable and retried.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execaSync } from 'execa';
import { configFile, ensureStateDirs, journalFile, stateFile } from './paths.js';
import { iso, clock } from './time.js';
import deepMerge from '../util/misc.js';

const GiB = 1024 ** 3;

/** Factory defaults — safe, conservative, self-documenting. */
export function defaultConfig() {
  return {
    version: 1,
    jobs: {
      // The weekly snapshot is THE default backup. Daily file backups are an
      // OPT-IN (enabled:true) so cloud + local storage are respected by default
      // — a full system snapshot already contains your data.
      files: {
        enabled: false,
        schedule: { kind: 'daily', at: { hour: 22, minute: 0 } },
        keep: 3, // latest + 2 previous days
        catchUpLimit: 3,
        sources: ['~/Desktop', '~/Documents', '~/Pictures'],
        exclude: [
          '**/.cache/**',
          '**/.git/**',
          '**/node_modules/**',
          '**/__pycache__/**',
          '**/*.tmp',
          '**/*.swp',
          '**/lost+found/**',
        ],
      },
      snapshots: {
        enabled: true, // default: one weekly system snapshot keeps storage sane
        schedule: { kind: 'weekly', on: 6, at: { hour: 22, minute: 0 } }, // Saturday 22:00
        keep: 3, // latest + 2 previous (the middle one is the sanity safety net)
        catchUpLimit: 3,
        chunkSize: 2 * GiB,
      },
    },
    storage: {
      remoteRoot: 'parrot-blackbox',
      chunkSize: 2 * GiB,
      providers: {
        mega: { defaultQuotaGiB: 20 },
        gdrive: { defaultQuotaGiB: 10 },
      },
      accounts: [], // {id, provider, label, remote, quotaGiB?}
    },
    network: {
      pingHost: 'https://api.mega.nz',
      retryEveryMinutes: 15,
    },
    daemon: {
      pollIntervalSeconds: 60,
    },
  };
}

export function readJsonSafe(file, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** Atomic JSON write: tmp + rename. Never yields a half-written file. */
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function loadConfig() {
  const cfg = deepMerge(defaultConfig(), readJsonSafe(configFile(), {}));
  if (!Array.isArray(cfg.storage.accounts)) cfg.storage.accounts = [];
  return cfg;
}

export function saveConfig(cfg) {
  writeJsonAtomic(configFile(), cfg);
}

export function defaultState() {
  const now = iso(clock());
  return {
    version: 1,
    createdAt: now,
    jobs: {
      files: { since: now, lastDue: null, lastCompletedDue: null, lastRunAt: null, lastStatus: null, lastError: null, completed: [], pending: [] },
      snapshots: { since: now, lastDue: null, lastCompletedDue: null, lastRunAt: null, lastStatus: null, lastError: null, completed: [], pending: [] },
    },
    manifests: {},
    storage: { lastRefreshAt: null },
  };
}

export function loadState() {
  const file = stateFile();
  if (!fs.existsSync(file)) {
    // Persist the initial defaults so the "since" anchor survives across
    // separate process runs (daemon, cron, force) — otherwise every fresh CLI
    // invocation would re-anchor the schedule to *its* now and never see dues.
    const fresh = defaultState();
    saveState(fresh);
    return fresh;
  }
  return deepMerge(defaultState(), readJsonSafe(file, {}));
}

export function saveState(st) {
  writeJsonAtomic(stateFile(), st);
}

/* ------------------------------------------------------------------ */
/* Journal                                                             */
/* ------------------------------------------------------------------ */

/**
 * Append one event to the journal. Lines look like:
 *   `2026-08-29T22:00:01|info|files|started due=2026-08-29T22:00:00`
 */
export function journal(event, detail = '', level = 'info') {
  try {
    fs.mkdirSync(path.dirname(journalFile()), { recursive: true });
    const line = `${iso(clock())}|${level}|${event}|${String(detail).replace(/\n/g, ' ').slice(0, 400)}\n`;
    fs.appendFileSync(journalFile(), line);
  } catch {
    /* journaling must never take the tool down */
  }
}

/** Read the last n journal lines, optionally filtering by substring. */
export function lastJournal(n = 20, filter = '') {
  try {
    const lines = fs.existsSync(journalFile()) ? fs.readFileSync(journalFile(), 'utf8').split('\n').filter(Boolean) : [];
    return lines.filter((l) => !filter || l.includes(filter)).slice(-n);
  } catch {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* Runtime helpers used by setup / service / daemon control            */
/* ------------------------------------------------------------------ */

export function currentTimeIso() {
  return iso(clock());
}

export function hasCommandSync(name) {
  try {
    const res = execaSync('bash', ['-c', `command -v "${name}"`], { reject: false });
    return Boolean(res.stdout.trim());
  } catch {
    return false;
  }
}

export function setStateDirs() {
  ensureStateDirs();
}