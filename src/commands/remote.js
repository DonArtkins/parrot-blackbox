/**
 * Remote (cloud account) management — the streamlined path that creates the
 * rclone remote FOR you (no 68-option rclone menu) and registers it in the
 * parrot-blackbox pool in one step.
 *
 *   - `remote add`   → `rclone config create` / `reconnect`, then `addAccount`
 *   - `remote list`  → rclone remotes + which are registered
 *   - `remote remove` → `rclone config delete` + drop from the pool
 *   - `remote config` → the full manual rclone config editor (advanced)
 */

import * as p from '@clack/prompts';
import pc from 'picocolors';
import { execa } from 'execa';
import { listRemotes } from '../storage/rclone.js';
import { addAccount, removeAccount, listAccounts } from '../storage/accounts.js';

/** Create a MEGA remote non-interactively (password obscured, OAuth-free). */
export async function createMegaRemote({ name, user, pass, twofa = '' }) {
  const obscured = await execa('rclone', ['obscure', pass], { reject: false });
  if (obscured.exitCode !== 0) throw new Error('could not obscure the MEGA password');
  const enc = obscured.stdout.trim();
  const args = ['config', 'create', name, 'mega', 'user', user, 'pass', enc, 'use_https', 'true'];
  if (twofa) args.push('2fa', twofa);
  const res = await execa('rclone', args, { reject: false });
  if (res.exitCode !== 0) throw new Error(`rclone config create failed: ${res.stderr?.trim()}`);
  return true;
}

/** Create a Google Drive remote non-interactively, then trigger the OAuth browser flow. */
export async function createGdriveRemote(name) {
  const c = await execa('rclone', ['config', 'create', name, 'drive', 'scope', 'drive'], { reject: false });
  if (c.exitCode !== 0) throw new Error(`rclone config create failed: ${c.stderr?.trim()}`);
  p.log.step('Open the browser to authorize Google Drive when it appears…');
  const r = await execa('rclone', ['config', 'reconnect', `${name}:`], { stdio: 'inherit', reject: false });
  if (r.exitCode !== 0) throw new Error(`Google Drive authorization failed: ${r.stderr?.trim()}`);
  return true;
}

/** Delete an rclone remote and drop it from the pool. */
export async function deleteRemote(name) {
  const res = await execa('rclone', ['config', 'delete', name], { reject: false });
  if (res.exitCode !== 0) {
    throw new Error(`rclone config delete failed: ${res.stderr?.trim()}`);
  }
  removeAccount(name);
  return true;
}

/**
 * Guided account add (used by `remote add` and the wizard).
 * When stdin is not a TTY, reads credentials from args/env so it can be scripted.
 */
export async function guidedRemoteAdd({ provider, name, userArg, passArg }) {
  if (!['mega', 'gdrive'].includes(provider)) {
    return { ok: false, cancelled: false, error: `unknown provider "${provider}" — use mega or gdrive` };
  }
  if (!name) {
    const existing = listAccounts().length;
    const n = provider === 'mega' ? `mega-${existing + 1}` : `gdrive-${existing + 1}`;
    name = process.stdin.isTTY ? await p.text({ message: `rclone remote name (${provider}):`, initialValue: n }) : n;
    if (p.isCancel(name)) return { ok: false, cancelled: true };
  }

  if (provider === 'mega') {
    const user = userArg || (process.stdin.isTTY ? await p.text({ message: 'MEGA account email:', initialValue: '' }) : process.env.PBB_MEGA_USER);
    if (!user) return { ok: false, cancelled: false, error: 'a MEGA email is required (pass it as an argument or run interactively)' };
    if (p.isCancel(user)) return { ok: false, cancelled: true };
    const pass = passArg || (process.stdin.isTTY ? await p.password({ message: 'MEGA password:' }) : process.env.PBB_MEGA_PASS);
    if (!pass) return { ok: false, cancelled: false, error: 'a MEGA password is required' };
    if (p.isCancel(pass)) return { ok: false, cancelled: true };
    let twofa = process.env.PBB_MEGA_2FA || '';
    if (!twofa && process.stdin.isTTY) {
      const t = await p.text({ message: 'MEGA 2FA code (leave empty if none):', initialValue: '' });
      if (p.isCancel(t)) return { ok: false, cancelled: true };
      twofa = t || '';
    }
    await createMegaRemote({ name, user, pass, twofa });
  } else {
    await createGdriveRemote(name);
  }

  const res = await addAccount({ provider, remote: name });
  if (!res.ok) {
    // Remote exists in rclone but could not be registered — say why (e.g. dup).
    return { ok: false, cancelled: false, error: res.error };
  }
  return { ok: true, cancelled: false, name, provider };
}

/** Register rclone remotes that already exist as pool accounts (wizard multiselect). */
export async function registerRemotesAsAccounts() {
  const remotes = await listRemotes();
  if (remotes.length === 0) {
    p.log.warn('No rclone remotes found yet. Create one with `parrot-blackbox remote add`, `rclone config`, then re-run setup.');
    return;
  }
  const existing = new Set(listAccounts().map((a) => a.remote));
  const candidates = remotes.filter((r) => !existing.has(r));
  if (candidates.length === 0) {
    p.log.message(pc.dim('All existing remotes are already registered in the pool.'));
    return;
  }
  const toAdd = await p.multiselect({
    message: 'Select remotes to add to the backup pool:',
    options: candidates.map((r) => ({ value: r, label: r })),
    required: false,
  });
  if (p.isCancel(toAdd) || toAdd.length === 0) {
    p.log.message(pc.dim('No remotes added.'));
    return;
  }
  for (const remote of toAdd) {
    const provider = await p.select({
      message: `Provider for "${remote}"?`,
      options: [
        { value: 'mega', label: 'MEGA (20 GB free tier)' },
        { value: 'gdrive', label: 'Google Drive (15 GB free tier)' },
      ],
    });
    if (p.isCancel(provider)) continue;
    const res = await addAccount({ provider, remote });
    if (res.ok) p.log.success(`Added ${pc.cyan(remote)} (${provider}).`);
    else p.log.warn(res.error);
  }
}

/** Remotes we know about + registration status. */
export async function remoteStatus() {
  const remotes = await listRemotes();
  const accounts = listAccounts();
  return remotes.map((r) => ({
    name: r,
    provider: accounts.find((a) => a.remote === r)?.provider || '—',
    registered: accounts.some((a) => a.remote === r),
  }));
}