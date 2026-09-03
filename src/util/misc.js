/** Small shared utilities: deep merge, sizes, glob-to-regexp, hashing. */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** Recursive deep merge (later objects win). Arrays are replaced wholesale. */
export default function deepMerge(base, override) {
  if (Array.isArray(base) || Array.isArray(override)) {
    return override === undefined ? base : override;
  }
  if (isPlainObj(base) && isPlainObj(override)) {
    const out = { ...base };
    for (const key of Object.keys(override)) {
      out[key] = deepMerge(base[key], override[key]);
    }
    return out;
  }
  return override === undefined ? base : override;
}

function isPlainObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function bytesHuman(n) {
  if (n === null || n === undefined) return '?';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${v.toFixed(v >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

/** Parse `1.5 GiB`, `2048`, `3.2G` → integer bytes. */
export function parseBytes(str) {
  if (typeof str === 'number') return str;
  const m = /^\s*([\d.]+)\s*([kmgt]?i?b?)\s*$/i.exec(String(str ?? ''));
  if (!m) return null;
  const mult = { b: 1, kb: 1024, kib: 1024, mb: 1024 ** 2, mib: 1024 ** 2, gb: 1024 ** 3, gib: 1024 ** 3, tb: 1024 ** 4, tib: 1024 ** 4, k: 1024, m: 1024 ** 2, g: 1024 ** 3, t: 1024 ** 4 }[m[2].toLowerCase()] ?? 1;
  return Math.round(parseFloat(m[1]) * mult);
}

/** sha256 of a file. */
export async function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('error', reject);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
  });
}

/** Translate a small glob subset to RegExp. Supports **, *, ?, {a,b}. */
export function globToRegExp(pattern) {
  let src = String(pattern).replace(/[.+^${}()|[\]\\]/g, '\\$&');
  src = src.replace(/\*\*/g, '@@DOUBLESTAR@@');
  src = src.replace(/\*/g, '[^/]*');
  src = src.replace(/\?/g, '[^/]');
  src = src.replace(/@@DOUBLESTAR@@/g, '.*');
  src = src.replace(/{([^}]+)}/g, (_, body) => `(${body.split(',').map((x) => x.trim().replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('|')})`);
  return new RegExp(`^${src}$`);
}

/** Does POSIX-ish relative path match any pattern? */
export function matchesAny(relPath, patterns) {
  if (!patterns || patterns.length === 0) return false;
  const p = relPath.replace(/\\/g, '/');
  return patterns.some((pat) => {
    const rx = globToRegExp(String(pat));
    return rx.test(p) || rx.test(p + '/');
  });
}

/** Recursive byte size of a directory (breaks symlink loops). */
export function dirSize(dir) {
  const seen = new Set();
  function walk(d) {
    let total = 0;
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const abs = path.join(d, ent.name);
      let real;
      try {
        real = fs.realpathSync(abs);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      try {
        if (ent.isSymbolicLink()) continue;
        if (ent.isDirectory()) total += walk(abs);
        else total += fs.statSync(abs).size;
      } catch {
        /* skip unreadable */
      }
    }
    return total;
  }
  return walk(dir);
}

/** Safe backtick shell-escape for a single path. */
export function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

export function pad2(n) {
  return String(n).padStart(2, '0');
}

/**
 * Returns an onProgress handler that renders a live, in-place progress bar
 * with percentage, MB transferred, and upload speed.
 *
 * Expected event shape:
 *   { done: number (bytes), total: number (bytes or 0), speedMBs?: number, remote?: string }
 *
 * Call renderer.stop() when done to advance to the next line.
 *
 * When `total` is 0 (stream size unknown) we display bytes + speed only.
 */
export function makeProgressRenderer() {
  const isTTY = process.stdout.isTTY;
  const BAR_WIDTH = 25;
  let lastLine = '';

  function buildLine({ done = 0, total = 0, speedMBs = 0, remote = '' } = {}) {
    const doneMB   = done / (1024 * 1024);
    const totalMB  = total / (1024 * 1024);
    const speedStr = speedMBs > 0 ? `  ${speedMBs.toFixed(1)} MB/s` : '';
    const destStr  = remote ? `  → ${remote}` : '';

    if (total > 0) {
      const pct    = Math.min(100, Math.round((done / total) * 100));
      const filled = Math.round((pct / 100) * BAR_WIDTH);
      const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      return `  [${bar}] ${String(pct).padStart(3)}%  ${doneMB.toFixed(1)} MB / ${totalMB.toFixed(1)} MB${speedStr}${destStr}`;
    }
    return `  ⬆  ${doneMB.toFixed(1)} MB streamed${speedStr}${destStr}`;
  }

  function render(evt = {}) {
    const line = buildLine(evt);
    if (isTTY) {
      process.stdout.write(`\r${line}\x1b[K`);
    } else if (line !== lastLine) {
      // Non-TTY (piped / daemon log): only emit when something changes to
      // avoid flooding the journal with thousands of identical lines.
      process.stdout.write(line + '\n');
    }
    lastLine = line;
  }

  render.stop = function stop() {
    if (isTTY && lastLine) process.stdout.write('\n');
    lastLine = '';
  };

  return render;
}

/**
 * A @clack/prompts-aware progress renderer.
 *
 * Inside the clack wizard the terminal is managed by clack's ANSI cursor
 * tracking — raw `\r` writes get clobbered.  This variant throttles output
 * to at most one `p.log.message()` call per second so clack can handle
 * rendering, and the bar stays readable.
 *
 * Usage:
 *   import * as p from '@clack/prompts';
 *   const progress = makeClackProgressRenderer(p);
 *   await runSnapshotNow(undefined, undefined, { onProgress: progress });
 *   progress.stop();
 *
 * Expected event shape: same as makeProgressRenderer().
 */
export function makeClackProgressRenderer(p) {
  const BAR_WIDTH = 20;
  const THROTTLE_MS = 800; // max one clack log line per 800 ms
  let lastEmitAt = 0;
  let lastLine = '';

  function buildLine({ done = 0, total = 0, speedMBs = 0, remote = '' } = {}) {
    const doneMB   = done / (1024 * 1024);
    const totalMB  = total / (1024 * 1024);
    const speedStr = speedMBs > 0 ? `  ${speedMBs.toFixed(1)} MB/s` : '';
    const destStr  = remote ? `  → ${remote}` : '';

    if (total > 0) {
      const pct    = Math.min(100, Math.round((done / total) * 100));
      const filled = Math.round((pct / 100) * BAR_WIDTH);
      const bar    = '█'.repeat(filled) + '░'.repeat(BAR_WIDTH - filled);
      return `[${bar}] ${String(pct).padStart(3)}%  ${doneMB.toFixed(1)} / ${totalMB.toFixed(1)} MB${speedStr}${destStr}`;
    }
    return `⬆  ${doneMB.toFixed(1)} MB streamed${speedStr}${destStr}`;
  }

  function render(evt = {}) {
    const now  = Date.now();
    const line = buildLine(evt);
    if (line === lastLine) return;           // nothing changed
    if (now - lastEmitAt < THROTTLE_MS) return; // too soon
    lastEmitAt = now;
    lastLine   = line;
    p.log.message(line);
  }

  render.stop = function stop() {
    // emit the final state unconditionally so the user sees 100% or final MB
    if (lastLine) p.log.message(lastLine);
    lastLine = '';
  };

  return render;
}