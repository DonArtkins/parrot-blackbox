# Changelog

All notable changes to **parrot-blackbox** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.1] - 2026-08-30

### Fixed
- **Wizard crash** (`ReferenceError: registerAccountsFlow is not defined`) when
  adding the first account — the registration helper was accidentally nested
  inside a scope. The wizard is now split into clear top-level steps.
- **Account adding actually saves the account.** A new guided flow creates the
  rclone remote FOR you and registers it in the pool in one step.

### Added
- **`remote` subcommands** — `remote add <mega|gdrive> [name]` (guided remote
  creation + pool registration), `remote list`, `remote remove <name>`,
  `remote config` (advanced rclone editor).
- **Streamlined setup wizard** — no more raw 68-option `rclone config` menu in
  the default path; pick MEGA or Drive and type your credentials.
- **Module-integrity regression test** guarding against the scoping bug.
- **README documents the complete manual `rclone config` flow** — every menu
  letter (`e`/`n`/`d`/`r`/`c`/`s`/`q`), the storage numbers to choose
  (Mega = **39**, Google Drive = **24**), what "user name" means (your email),
  the password/2FA prompts, the "**say no to advanced config**" guidance, and
  how to edit / rename / delete remotes afterwards.

## [1.0.0] - 2026-08-29

### Added
- **Snapshot-only backup by default** — a full Timeshift system snapshot every
  Saturday at 22:00 is THE backup (storage-conscious). Daily file backups are
  an optional opt-in (`jobs.files.enabled`). `force` runs every enabled job.
- **Auto-install needed tools** — the setup wizard checks the system for
  `rclone`, `timeshift`, `git` and `curl` and installs whatever is missing
  (interactive sudo prompt), so snapshot backup AND restore work out of the box.
- **Crash-proof catch-up** — if the machine is off or offline at backup time,
  every missed backup (oldest first) runs the moment WiFi is back.
- **Background daemon** — detached process with a 60s poll, offline/online edge
  detection, journal, atomic state and a process lock (stale-lock reclaim).
- **Smart multi-cloud storage pool** — register any number of MEGA and Google
  Drive accounts (rclone remotes) as one pool (~150 GB across 5+5 accounts);
  placement water-fills accounts by used-percentage; anything bigger than a
  single account's free space is split into byte-range chunks spread across
  accounts with a restore manifest (cloud + local mirror).
- **Git-aware backups** — anything inside a git work tree is skipped (GitHub
  already backs it up).
- **Retention** — snapshots keep the newest 3 (local AND cloud pruned in the
  same pass); optional file backups keep the newest 3 generations.
- **Recovery** — `restore files` for fonts/images/docs and `restore snapshot`
  for a full system restore over a fresh install (interactive sudo, like
  gitswitch/theamify).
- **Always-on service** — systemd user unit with cron fallback.
- **Sandbox e2e suite** — the real CLI is exercised against stub
  rclone/timeshift/sudo binaries and a fake cloud, so the Level-5 destructive
  paths are proven safe before any real use.

[1.0.1]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.1
[1.0.0]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.0