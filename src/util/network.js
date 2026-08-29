/**
 * Connectivity check. The offline/online edge is what triggers catch-up: when
 * the daemon observes the laptop coming back online, pending backups run
 * immediately in order.
 *
 * Overridable in tests via PBB_NETWORK=offline|online.
 */

import { execa } from 'execa';
import { loadConfig } from '../core/store.js';

export async function isOnline() {
  if (process.env.PBB_NETWORK === 'offline') return false;
  if (process.env.PBB_NETWORK === 'online') return true;

  const cfg = loadConfig();
  const host = cfg.network.pingHost || 'https://api.mega.nz';
  try {
    const res = await execa('curl', ['-fsSI', '--connect-timeout', '5', '--max-time', '10', host], {
      reject: false,
    });
    return res.exitCode === 0;
  } catch {
    return false;
  }
}