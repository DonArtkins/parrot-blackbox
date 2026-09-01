/**
 * Connectivity check. The offline/online edge is what triggers catch-up: when
 * the daemon observes the laptop coming back online, pending backups run
 * immediately in order.
 *
 * Probes MULTIPLE hosts — if any answers, we are online. On some networks a
 * specific host (e.g. api.mega.nz) fails to resolve even though the internet
 * works, so a single-host probe falsely reports "offline" and defers every
 * backup forever.
 *
 * Overridable in tests via PBB_NETWORK=offline|online.
 */

import { execa } from 'execa';
import { loadConfig } from '../core/store.js';

const FALLBACK_HOSTS = [
  'https://api.github.com',
  'https://www.google.com',
  'https://api.mega.nz',
];

export async function isOnline() {
  if (process.env.PBB_NETWORK === 'offline') return false;
  if (process.env.PBB_NETWORK === 'online') return true;

  const cfg = loadConfig();
  const hosts = [
    cfg.network.pingHost,
    ...(Array.isArray(cfg.network.pingHosts) ? cfg.network.pingHosts : []),
    ...FALLBACK_HOSTS,
  ].filter(Boolean);
  const unique = [...new Set(hosts)];

  for (const host of unique) {
    try {
      // `-f`/fail-on-HTTP-error is WRONG here: reachable hosts legitimately
      // return 403/404/5xx (e.g. api.github.com HEAD is frequently 403). Any
      // HTTP response proves DNS+connect+internet — that is all we need.
      const res = await execa('curl', ['-sS', '-o', '/dev/null', '--connect-timeout', '4', '--max-time', '6', host], {
        reject: false,
      });
      if (res.exitCode === 0) return true;
      // Also treat any HTTP response line as online even if curl -sS -o returned
      // non-zero (some proxies set code but curl reports 8/18/52).
    } catch {
      /* try next host */
    }
  }
  // Last resort: a bare TCP connect to a well-known IP proves L3 connectivity.
  try {
    const res = await execa('curl', ['-sS', '-o', '/dev/null', '--connect-timeout', '3', '--max-time', '5', 'http://1.1.1.1'], {
      reject: false,
    });
    if (res.exitCode === 0) return true;
  } catch {
    /* give up */
  }
  return false;
}