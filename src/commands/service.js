/**
 * Always-on integration. Preferred: a systemd USER unit that keeps the daemon
 * running (Restart=always, starts on login). Fallback for systems without
 * systemd: a cron line that runs `parrot-blackbox run` every 15 minutes (the
 * run itself defers when offline and catches up later, so it never hangs).
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { serviceFile, daemonLogFile } from '../core/paths.js';
import { loadConfig, journal, hasCommandSync } from '../core/store.js';

function findCliBin() {
  // npm-installed global binary (preferred) or our own bin entry.
  const candidates = [
    process.env.PBB_BIN,
    // This module lives in src/commands/ → ../../bin/parrot-blackbox.js
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'bin', 'parrot-blackbox.js'),
    path.join(path.dirname(process.argv[1] || ''), 'parrot-blackbox.js'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || 'parrot-blackbox';
}

export function serviceBackend() {
  if (process.env.PBB_SERVICE_BACKEND) return process.env.PBB_SERVICE_BACKEND;
  if (hasCommandSync('systemctl')) return 'systemd';
  if (hasCommandSync('crontab')) return 'cron';
  return 'none';
}

/** Install the systemd user unit (or cron fallback). Returns detected backend. */
export async function installService() {
  const backend = serviceBackend();
  if (backend === 'systemd') {
    const bin = findCliBin();
    const unit = [
      '[Unit]',
      'Description=parrot-blackbox — crash-proof backup daemon',
      'After=network-online.target',
      'Wants=network-online.target',
      '',
      '[Service]',
      'Type=simple',
      `ExecStart=${process.execPath} ${bin} daemon foreground`,
      'Restart=always',
      'RestartSec=60',
      `StandardOutput=append:${daemonLogFile()}`,
      `StandardError=append:${daemonLogFile()}`,
      '',
      '[Install]',
      'WantedBy=default.target',
      '',
    ].join('\n');
    fs.mkdirSync(path.dirname(serviceFile()), { recursive: true });
    fs.writeFileSync(serviceFile(), unit);
    journal('service', `systemd unit written: ${serviceFile()}`);
    for (const cmd of [
      ['systemctl', '--user', 'daemon-reload'],
      ['systemctl', '--user', 'enable', '--now', 'parrot-blackbox.service'],
    ]) {
      const res = await execa(cmd[0], cmd.slice(1), { reject: false });
      if (res.exitCode !== 0) {
        journal('service', `systemctl ${cmd.slice(2).join(' ')} failed: ${res.stderr?.trim()}`, 'warn');
      }
    }
    return 'systemd';
  }
  if (backend === 'cron') {
    await installCron();
    return 'cron';
  }
  return 'none';
}

function cronLinesFor() {
  const bin = findCliBin();
  const marker = '# parrot-blackbox automatic backup schedule';
  const line = `*/15 * * * * "${process.execPath}" ${bin} run >> ${daemonLogFile()} 2>&1`;
  return { marker, line };
}

async function installCron() {
  const { marker, line } = cronLinesFor();
  const existing = await execa('crontab', ['-l'], { reject: false });
  const body = existing.exitCode === 0 ? existing.stdout : '';
  const lines = body.split('\n').filter((l) => !l.includes(marker));
  lines.push(marker);
  lines.push(line);
  lines.push('');
  const write = await execa('crontab', ['-'], { reject: false, input: lines.join('\n') });
  journal('service', write.exitCode === 0 ? 'cron line installed' : `crontab failed: ${write.stderr?.trim()}`, write.exitCode === 0 ? 'info' : 'warn');
}

async function removeCron() {
  const { marker } = cronLinesFor();
  const existing = await execa('crontab', ['-l'], { reject: false });
  if (existing.exitCode !== 0) return;
  const lines = existing.stdout.split('\n').filter((l) => !l.includes(marker));
  await execa('crontab', ['-'], { reject: false, input: lines.join('\n') + '\n' });
  journal('service', 'cron line removed');
}

export async function removeService() {
  const backend = serviceBackend();
  if (backend === 'systemd') {
    for (const cmd of [
      ['systemctl', '--user', 'stop', 'parrot-blackbox.service'],
      ['systemctl', '--user', 'disable', 'parrot-blackbox.service'],
    ]) {
      const res = await execa(cmd[0], cmd.slice(1), { reject: false });
      if (res.exitCode !== 0) journal('service', `${cmd.join(' ')} failed`, 'warn');
    }
    try {
      fs.rmSync(serviceFile(), { force: true });
    } catch { /* best effort */ }
    return 'systemd';
  }
  if (backend === 'cron') {
    await removeCron();
    return 'cron';
  }
  return 'none';
}