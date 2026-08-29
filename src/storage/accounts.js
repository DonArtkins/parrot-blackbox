/**
 * Storage accounts — the gitswitch-style account manager for the multi-cloud
 * pool. Each account maps to ONE rclone remote (one MEGA or Google Drive
 * login). 5 MEGA + 5 Drive accounts with ~20GiB / ~15GiB each ≈ 175GiB that the
 * allocator can spread backups across so we are never out of space.
 */

import crypto from 'node:crypto';
import { loadConfig, saveConfig } from '../core/store.js';
import { aboutRemote, listRemotes, hasRclone } from './rclone.js';
import { bytesHuman } from '../util/misc.js';

const GiB = 1024 ** 3;

function accountId() {
  return crypto.randomUUID().slice(0, 8);
}

/** Provider defaults (used only when `rclone about` cannot report a quota). */
export function defaultQuota(provider, cfg) {
  const p = cfg.storage.providers[provider];
  return (p?.defaultQuotaGiB ?? 20) * GiB;
}

export function providerLabel(provider) {
  return provider === 'mega' ? 'MEGA' : provider === 'gdrive' ? 'Google Drive' : provider;
}

/**
 * Add an account. `remote` must already exist in rclone's config (created via
 * `rclone config` or by the wizard's interactive `rclone config` call).
 */
export async function addAccount({ provider = 'mega', label = '', remote = '', quotaGiB = null }) {
  const cfg = loadConfig();
  const remotes = await listRemotes();
  if (!remotes.includes(remote)) {
    return { ok: false, error: `rclone remote "${remote}" not found. Create it first with: rclone config` };
  }
  if (cfg.storage.accounts.some((a) => a.remote === remote)) {
    return { ok: false, error: `an account already uses remote "${remote}"` };
  }
  const account = {
    id: accountId(),
    provider,
    label: label || remote,
    remote,
    quotaGiB: quotaGiB && Number(quotaGiB) > 0 ? Number(quotaGiB) : undefined,
    addedAt: new Date().toISOString(),
  };
  cfg.storage.accounts.push(account);
  saveConfig(cfg);
  return { ok: true, account };
}

export function removeAccount(id) {
  const cfg = loadConfig();
  const before = cfg.storage.accounts.length;
  cfg.storage.accounts = cfg.storage.accounts.filter((a) => a.id !== id && a.remote !== id);
  const removed = cfg.storage.accounts.length !== before;
  if (removed) saveConfig(cfg);
  return removed;
}

export function listAccounts() {
  return loadConfig().storage.accounts || [];
}

export function hasAccounts(cfg = loadConfig()) {
  return (cfg.storage.accounts || []).length > 0;
}

/**
 * Refresh live quota data for every account. Falls back to the configured /
 * provider default quota when the backend does not report usage.
 * @returns {Promise<Array>} accounts with {total, used, free} bytes
 */
export async function refreshAccounts(cfg = loadConfig()) {
  const accounts = (cfg.storage.accounts || []).map((a) => ({ ...a }));
  const refreshed = [];
  for (const acc of accounts) {
    const about = await aboutRemote(acc.remote + ':');
    const quota = acc.quotaGiB ? Number(acc.quotaGiB) * GiB : defaultQuota(acc.provider, cfg);
    const total = about.total ?? quota;
    const used = about.used ?? 0;
    const free = about.free ?? Math.max(0, total - used);
    refreshed.push({ ...acc, total, used, free, live: about.free != null });
  }
  return refreshed;
}

/** One-line storage pool summary (for status/doctor). */
export function poolSummary(accounts) {
  const total = accounts.reduce((s, a) => s + (a.total || 0), 0);
  const used = accounts.reduce((s, a) => s + (a.used || 0), 0);
  const free = accounts.reduce((s, a) => s + (a.free || 0), 0);
  return {
    accounts: accounts.length,
    total,
    used,
    free,
    text: `${accounts.length} account(s) — ${bytesHuman(total)} total / ${bytesHuman(used)} used / ${bytesHuman(free)} free`,
  };
}

/** Spaces requirement check for setup. */
export async function storageHealth() {
  const has = await hasRclone();
  if (!has) return { ok: false, reason: 'rclone is not installed' };
  return { ok: true, reason: null };
}