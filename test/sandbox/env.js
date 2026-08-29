/**
 * Sandbox environment helper — every e2e test runs the REAL `node
 * bin/parrot-blackbox.js` CLI inside an isolated fake world:
 *
 *   - fake $HOME with Desktop/Documents/Pictures + git repos
 *   - PBB_STATE_DIR / PBB_CONFIG_FILE inside the sandbox
 *   - PBB_SANDBOX_CLOUD   → local dirs standing in for MEGA / Drive remotes
 *   - PBB_TIMESHIFT_DIR   → fake `/timeshift` for the timeshift stub
 *   - stub binaries (rclone, timeshift, sudo, systemctl, curl) on PATH
 *
 * No real filesystem outside the sandbox is ever touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
export const PKG_ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..', '..');

export function setupSandbox(name) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `pbb-sandbox-${name}-`));
  const home = path.join(root, 'home');
  const cloud = path.join(root, 'cloud');
  const timeshift = path.join(root, 'timeshift');
  const state = path.join(root, 'state');
  const log = path.join(root, 'calls.log');
  for (const d of [home, cloud, timeshift, state]) fs.mkdirSync(d, { recursive: true });

  const env = {
    ...process.env,
    HOME: home,
    PBB_STATE_DIR: state,
    PBB_CONFIG_FILE: path.join(state, 'config.json'),
    PBB_MANIFESTS_DIR: path.join(state, 'manifests'),
    PBB_CHUNK_DIR: path.join(state, 'chunks'),
    PBB_TIMESHIFT_DIR: timeshift,
    PBB_SANDBOX_CLOUD: cloud,
    PBB_SANDBOX_LOG: log,
    PBB_SUDO_DIRECT: '1',
    PATH: `${path.join(PKG_ROOT, 'test', 'sandbox', 'stubs')}:${process.env.PATH}`,
  };
  return { root, home, cloud, timeshift, state, log, env };
}

/** Create a fake cloud remote dir + quota file. quotaGiB default 20 (float ok). */
export function addRemote(env, { remote, quotaGiB = 20 }) {
  const dir = path.join(env.PBB_SANDBOX_CLOUD, remote);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(env.PBB_SANDBOX_CLOUD, `${remote}.quota`), String(Math.round(quotaGiB * 1024 ** 3)));
  return dir;
}

/** Create fake home dirs + files (including a nested git repo). */
export function populateHome(s) {
  const home = s.home;
  const mk = (p) => fs.mkdirSync(path.join(home, p), { recursive: true });
  const file = (p, content) => fs.writeFileSync(path.join(home, p), content);

  mk('Desktop');
  mk('Documents');
  mk('Pictures');
  file('Desktop/wallpaper.png', 'PNGDATA'.repeat(100));
  file('Documents/index.txt', 'important text\n'.repeat(50));
  file('Pictures/photo.jpg', 'JPEGDATA'.repeat(80));
  fs.writeFileSync(path.join(home, '.bashrc'), 'export EDITOR=nano\n');

  // A nested git repo inside Documents — GitHub already owns it, so the
  // backup must NOT contain it.
  mk('Documents/project');
  file('Documents/project/README.md', 'tracked by github\n');
  file('Documents/project/app.js', 'console.log(1)\n');
  runSync('git', ['init', '-q', path.join(home, 'Documents/project')]);
  runSync('git', ['-C', path.join(home, 'Documents/project'), 'config', 'user.email', 't@t']);
  runSync('git', ['-C', path.join(home, 'Documents/project'), 'config', 'user.name', 't']);

  return home;
}

function runSync(cmd, args) {
  try {
    execFile(cmd, args, { stdio: 'ignore' });
  } catch {
    /* git config failures in sandbox are non-fatal */
  }
}

/** Run the real CLI as a subprocess with the sandbox env. */
export async function runCli(args, env, opts = {}) {
  const bin = path.join(PKG_ROOT, 'bin', 'parrot-blackbox.js');
  const childEnv = {
    ...env,
    // Default to the sandbox sudo bypass unless the test explicitly overrides it.
    PBB_SUDO_DIRECT: env.PBB_SUDO_DIRECT === undefined ? '1' : env.PBB_SUDO_DIRECT,
  };
  try {
    const r = await execFileP(process.execPath, [bin, ...args], {
      env: childEnv,
      maxBuffer: 32 * 1024 * 1024,
      timeout: opts.timeout ?? 60_000,
    });
    return { exitCode: 0, stdout: r.stdout, stderr: r.stderr };
  } catch (e) {
    const out = { exitCode: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' };
    if (e.killed || e.signal) out.stderr += `\n[signalled ${e.signal}]`;
    return out;
  }
}

/** Read a manifest mirror from the sandbox state. */
export function readManifest(stateDir, kind, id) {
  const p = path.join(stateDir, 'manifests', `${kind}-${id}.json`);
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

/** Write an artifact manifest + dir directly into the fake cloud (test seeding). */
export function seedCloudManifest(env, remote, kind, id) {
  const dir = path.join(env.PBB_SANDBOX_CLOUD, remote, 'parrot-blackbox', kind, id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest = {
    schema: 1,
    kind,
    id,
    createdAt: `${id}:00`,
    totalSize: 1,
    remoteRoot: 'parrot-blackbox',
    entries: [],
  };
  fs.writeFileSync(path.join(dir, '__MANIFEST__.json'), JSON.stringify(manifest, null, 2));
  return dir;
}

/** Turn the (default-disabled) daily file backup job on for a test. */
export function enableFileBackups(s) {
  const cfgPath = path.join(s.env.PBB_STATE_DIR, 'config.json');
  let cfg = {};
  try {
    cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  } catch { /* first run: defaults must be materialized first */ }
  cfg.jobs = cfg.jobs || {};
  cfg.jobs.files = cfg.jobs.files || {};
  cfg.jobs.files.enabled = true;
  fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
}

/** Recursive file listing under a remote (relative 'a/b' strings). */
export function cloudFiles(env, remote, rel = '') {
  const base = path.join(env.PBB_SANDBOX_CLOUD, remote, rel);
  const out = [];
  if (!fs.existsSync(base)) return out;
  (function walk(d, r) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rr = r ? `${r}/${ent.name}` : ent.name;
      if (ent.isDirectory()) walk(abs, rr);
      else out.push(rr);
    }
  })(base, '');
  return out;
}

/** Recursive dir listing under a remote (relative strings). */
export function cloudDirs(env, remote, rel = '') {
  const base = path.join(env.PBB_SANDBOX_CLOUD, remote, rel);
  const out = [];
  if (!fs.existsSync(base)) return out;
  (function walk(d, r) {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      const rr = r ? `${r}/${ent.name}` : ent.name;
      if (ent.isDirectory()) {
        out.push(rr);
        walk(abs, rr);
      }
    }
  })(base, '');
  return out;
}