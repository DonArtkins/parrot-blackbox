# Contributing

Thanks for helping improve **parrot-blackbox**! 🦜📦

## Getting started

```bash
git clone https://github.com/DonArtkins/parrot-blackbox.git
cd parrot-blackbox
npm install
```

## Tests

```bash
npm test                # unit + e2e (real CLI against stub tools + fake cloud)
```

- `test/unit.test.js`  — pure scheduling / allocator / retention / parser math.
- `test/e2e.test.js`   — the **Level-5 safety suite**: the real CLI is run as a
  subprocess against stub `rclone`, `timeshift`, `sudo`, `systemctl`, `curl`
  binaries and a fake cloud under a fake `$HOME`. Nothing outside the sandbox
  (temp dir) is ever touched. New destructive flows MUST ship a sandbox test.
- `test/readme.test.js` — keeps the README/CHANGELOG honest.

Run a single test with `node --test --test-name-pattern='retention'`.

## Design rules

- Keep the storage-pool contract intact: placement whole-first, chunks only
  when a file can't fit any single account, and a manifest recorded in cloud +
  local mirror.
- Any new job must be crash-proof by default: it opens a journal entry, writes
  state atomically, and is retryable. A job that can't be retried safely is a
  bug.
- Background/daemon code must never prompt — use `sudo -n` and mark jobs
  `deferred` instead of hanging.
- Preferred stack: ESM, `citty`, `@clack/prompts`, `execa`, `picocolors`
  (the gitswitch / theamify / warp-wizard family).

## Before you open a PR

1. `npm test` passes.
2. `npm run publish:dry-run` shows only expected files (`bin/`, `src/`, docs).
3. README.md documents any new command in the command table.
4. CHANGELOG.md has an `## [Unreleased]` entry describing the change.

## Releases

```bash
npm run release:patch   # or minor / major  → tests, bumps, pushes with tags
npm publish             # publishes to the public npm registry
```