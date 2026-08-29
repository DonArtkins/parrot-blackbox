/**
 * Source walker with the parrot-blackbox golden rule: EVERYTHING tracked by
 * GitHub is already backed up, so any directory inside a git work tree is
 * skipped entirely (we keep only what GitHub does NOT have). User-provided
 * exclude globs are applied on top.
 */

import fs from 'node:fs';
import path from 'node:path';
import { execaSync } from 'execa';
import { matchesAny } from '../util/misc.js';

/** Resolve `~/x` and relative paths against a home dir. */
export function expandPath(p, home) {
  if (String(p).startsWith('~/')) return path.join(home, p.slice(2));
  if (String(p) === '~') return home;
  return path.resolve(p);
}

/** Nearest enclosing git work-tree root above `dir`, or null. */
export function gitTopLevel(dir) {
  try {
    const res = execaSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { reject: false });
    if (res.exitCode === 0 && res.stdout.trim()) return path.resolve(res.stdout.trim());
  } catch {
    /* no git available */
  }
  return null;
}

function pathHasGitDir(dir) {
  return fs.existsSync(path.join(dir, '.git'));
}

/**
 * Collect files to back up from `sources`, skipping:
 *  - any source that lives inside a git work tree (GitHub has those files)
 *  - any nested directory that is itself a git repo
 *  - anything matching the exclude globs
 * @param {string[]} sources
 * @param {{exclude?:string[], home?:string}} opts
 * @returns {{files:Array<{abs:string,rel:string}>, skippedRepos:string[], skipped:number, missing:string[]}}
 */
export function collectFiles(sources, { exclude = [], home = process.env.HOME } = {}) {
  const files = [];
  const skippedRepos = [];
  const missing = [];
  let skipped = 0;

  for (const src of sources) {
    const abs = expandPath(src, home);
    if (!fs.existsSync(abs)) {
      missing.push(src);
      continue;
    }

    const top = gitTopLevel(abs);
    if (top) {
      // The whole source is inside a git repo — GitHub already owns it.
      skippedRepos.push(abs);
      continue;
    }

    const prefix = path.basename(abs) || 'sources';
    walk(abs, prefix, abs);
  }

  function walk(abs, relPrefix, sourceRoot) {
    for (const ent of fs.readdirSync(abs, { withFileTypes: true })) {
      const eAbs = path.join(abs, ent.name);
      const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
      const relFromSource = path.relative(sourceRoot, eAbs);
      if (matchesAny(relFromSource.replace(/\\/g, '/'), exclude)) {
        skipped += 1;
        continue;
      }
      let st;
      try {
        st = fs.statSync(eAbs);
      } catch {
        skipped += 1;
        continue;
      }
      if (ent.isSymbolicLink()) {
        skipped += 1; // symlinks resolved when restoring via snapshot; keep tree clean here
        continue;
      }
      if (ent.isDirectory()) {
        if (pathHasGitDir(eAbs)) {
          skippedRepos.push(eAbs); // nested git repo — GitHub has it
          continue;
        }
        walk(eAbs, rel, sourceRoot);
      } else {
        files.push({ abs: eAbs, rel });
      }
    }
  }

  return { files, skippedRepos, skipped, missing };
}

/** Copy collected files into a staging root, preserving `rel`. */
export function stageFiles(files, stagingRoot) {
  for (const f of files) {
    const dest = path.join(stagingRoot, ...f.rel.split('/'));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(f.abs, dest);
  }
  return stagingRoot;
}

/** Total byte size of collected files. */
export function sumFiles(files) {
  return files.reduce((s, f) => {
    try {
      return s + fs.statSync(f.abs).size;
    } catch {
      return s;
    }
  }, 0);
}