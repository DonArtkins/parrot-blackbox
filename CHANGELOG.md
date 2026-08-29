# Changelog

All notable changes to **parrot-blackbox** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [Unreleased]

- **Snapshot-only default**: the weekly Timeshift snapshot is now THE backup —
  daily file backups are disabled by default (opt-in) to respect storage.
  `force` now runs every enabled job (default = snapshot).
- **Auto-install missing tools**: the setup wizard checks the system for
  `rclone` / `timeshift` / `git` / `curl` and installs whatever is missing
  (interactive sudo) so snapshot backup AND restore always work on fresh Parrot.

## [1.0.0] - 2026-08-29

### Added
- **Crash-proof automation** — file backups daily at 22:00 and full Timeshift
  system snapshots every Saturday at 22:00, with automatic catch-up of every
  missed backup (oldest first) the moment the machine is back online.
- **Background daemon** — detached process with a 60s poll, offline/online edge
  detection, journal, atomic state and a process lock (stale-lock reclaim).
- **Smart multi-cloud storage pool** — register any number of MEGA and Google
  Drive accounts (rclone remotes) as one pool; placement water-fills accounts by
  used-percentage; files bigger than any single account are split into
  byte-range chunks spread across accounts with a restore manifest (cloud +
  local mirror).
- **Git-aware backups** — anything inside a git work tree is skipped (GitHub
  already backs it up).
- **Retention** — file backups keep the newest 3 generations; snapshots keep
  the newest 3, pruned locally AND in the cloud in the same pass.
- **Recovery** — `restore files` for fonts/images/docs and `restore snapshot`
  for a full system restore over a fresh install (interactive sudo, like
  gitswitch/theamify).
- **Account management** — `account add/list/remove/quota`, plus a gitswitch-style
  `doctor`, `status`, setup wizard and one-command `uninstall`.
- **Always-on service** — systemd user unit with cron fallback.
- **Sandbox e2e suite** — the real CLI is exercised against stub
  rclone/timeshift/sudo binaries and a fake cloud, so the Level-5 destructive
  paths are proven safe before any real use.

[1.0.0]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.0