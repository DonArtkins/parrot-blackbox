# Changelog

All notable changes to **parrot-blackbox** are documented here. This project
adheres to [Semantic Versioning](https://semver.org/).

## [1.0.12] - 2026-09-02

### Fixed
- **BTRFS snapshot upload EACCES permissions error** — `fs.readdirSync` failed when scanning root-owned files (like `/etc/credstore`) inside the Timeshift BTRFS mount. The upload logic is now run through an internal privileged helper (`sudo -E node ... _internal_upload`), allowing full traversal and chunking of BTRFS files while preserving the exact interactive sudo password prompt behavior used in other tools (e.g. gitswitch).

## [1.0.10] - 2026-09-02

### Fixed
- **BTRFS device parsing fix** — `findmnt` returns the block device with the subvolume path in brackets (e.g. `/dev/dm-0[/@]`). This broke the BTRFS root subvolume mounting. The block device string is now properly parsed so the mount succeeds.

## [1.0.9] - 2026-09-02

### Fixed
- **CRITICAL: BTRFS snapshot upload always fails with ENOENT** — The root cause was
  that Timeshift unmounts the BTRFS subvolume immediately after creating a snapshot.
  When `snapshotDirFor()` tried to access `/timeshift/snapshots/...` or even searched
  `/run/timeshift`, the mount was already gone, causing `ENOENT: no such file or directory`.
  
  **Solution:** Mount the BTRFS root subvolume (subvolid=5) ourselves at a temporary
  location to access all snapshots directly. The mount is kept active during upload,
  then cleaned up automatically. This works because BTRFS snapshots are stored as
  subvolumes on the same partition, accessible by mounting the root subvolume which
  contains `timeshift-btrfs/snapshots/`.
  
  **Technical details:** Timeshift BTRFS mode stores snapshots at
  `<root-subvol>/timeshift-btrfs/snapshots/<NAME>`. These are accessible by mounting
  the device with `subvolid=5` (the BTRFS root subvolume). The fix creates a temporary
  mount at `/run/parrot-blackbox-btrfs-<timestamp>`, accesses the snapshot, uploads it,
  then unmounts and removes the temporary directory.

## [1.0.8] - 2026-09-01

### Fixed
- **List backups fails silently** — `listBackupsAction` was using non-interactive
  sudo which fails silently when the sudo timestamp expires, making it appear like
  no snapshots exist. Now uses interactive sudo to properly prompt for password.
- **Snapshot directory not found (BTRFS mode)** — Timeshift BTRFS mode uses
  dynamic mount paths `/run/timeshift/NNNN/backup/...` where NNNN is a PID. The
  `snapshotDirFor` function now searches with sudo when needed and handles the
  dynamic paths correctly, fixing the `ENOENT: no such file or directory` error.

## [1.0.7] - 2026-09-01

### Fixed
- **Snapshot detection completely broken with Timeshift 24.06+** — the output
  format changed from `Num DATE TIME TAGS NAME` to `Num > NAME TAGS Description`.
  The parser now supports both the legacy format (for older Timeshift versions)
  and the current format (24.06+), ensuring snapshots are always detected correctly.

### Changed
- **Redesigned wizard menu to match gitswitch's friendly UX** — cleaner intro
  (no yellow background), better emoji choices (☁️ for cloud, 🤖 for daemon),
  shorter/clearer menu labels, simplified hints, friendlier exit message.
  Replaced the separator line with a blank line for a cleaner look. All submenus
  (accounts, restore, service, daemon) now use the same friendly style.

## [1.0.6] - 2026-09-01

### Fixed
- **"timeshift reported success but no snapshot was found"** — the root cause
  was `timeshift --list`'s 24.x table format (leading `Num` column + header)
  that the parser didn't recognize. The snapshot name now comes straight from
  `timeshift --create` output ("Created new snapshot: …"), with a tolerant
  parser (old + table formats) as fallback.
- **Snapshot directory resolution for BTRFS mode** — snapshots live under the
  mounted hidden subvolume (`/run/timeshift/backup/…`), not `/timeshift`. The
  resolver now searches `/run/timeshift/backup` too, so the upload actually
  finds the snapshot content.
- **Daemon stuck on "offline" forever** — the connectivity probe used
  `curl -fS` and a single host (`api.mega.nz`, which your network fails to
  resolve; `api.github.com` also returns 403 to HEAD). The probe now accepts
  ANY HTTP response (any response = internet) across multiple hosts, with a
  bare-TCP last resort. This was silently deferring every scheduled backup.
- **systemd user unit wrote a bare `ExecStart` name** — the daemon crashed with
  "Cannot find module". The unit now uses the absolute bin path; `repair`
  detects and re-writes a broken unit.

## [1.0.5] - 2026-08-31

### Fixed
- **Snapshot creation failed as "timeshift reported success but no snapshot was
  found"** — `timeshift --list` needs admin access on most installs; the listing
  now runs through sudo (interactive `sudo timeshift --list`, non-interactive
  `sudo -n` with a direct fallback) so the created snapshot is properly detected
  and uploaded. Regression-tested against a stub that refuses unprivileged
  listings.
- **Daemon crashed with "Cannot find module '/home/artkins/parrot-blackbox'"**
  — the systemd user unit's `ExecStart` used a bare command name. The unit now
  always resolves the real `bin/parrot-blackbox.js` path, and `repair` detects a
  broken `ExecStart` and re-writes the unit.

## [1.0.4] - 2026-08-30

### Fixed
- **Google Drive quota is 15 GiB, not 10 GiB** — the real free tier. The
  fallback default quota, provider labels and docs are aligned, so a pool of
  5 MEGA + 5 Google Drive accounts reports the true **~175 GiB** total
  (verified live: `account list` → 10 accounts, 175 GiB total).

## [1.0.3] - 2026-08-30

### Added
- **Menu wizard (gitswitch-style)** — running `parrot-blackbox` (or
  `parrot-blackbox install`) opens a menu with EVERY feature: add account,
  storage pool, check & install tools, snapshot now, run backup, list backups,
  restore, always-on service, daemon, guided setup, status, doctor, **repair**,
  **update**, **uninstall**. Choosing an action runs it and returns to the menu;
  saying "No" to a prompt never kicks you out. Only Exit / Ctrl+C leaves.
- **Automatic update check on launch** — the wizard queries the npm registry
  (`npm view parrot-blackbox version`, never local state) and offers to
  self-update when a newer version is published. `update` / `self-update` /
  `upgrade` commands work standalone too.
- **`repair` command** — fixes a broken install: re-checks & auto-installs
  system tools, recreates a missing/corrupt config, re-installs the always-on
  service if missing, drops stale pool entries whose rclone remote no longer
  exists, and offers an optional npm reinstall. Run standalone
  (`parrot-blackbox repair`, `--yes` for non-interactive) or from the menu.
- **Full uninstall** — now also removes the npm package itself
  (`npm uninstall -g parrot-blackbox`), so the command disappears from PATH,
  matching gitswitch/theamify.

## [1.0.2] - 2026-08-30

### Added
- **Complete manual `rclone config` walkthrough in the README** — every menu
  letter (`e`/`n`/`d`/`r`/`c`/`s`/`q`) with what it does, the exact storage
  numbers (Mega = **39**, Google Drive = **24**), that `user` means the
  account's **email**, the password / 2FA prompts, the "**say no to advanced
  config**" guidance, and how to edit / rename / delete remotes afterwards.

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
  Drive accounts (rclone remotes) as one pool (~175 GB across 5+5 accounts);
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

[1.0.12]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.12
[1.0.10]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.10
[1.0.9]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.9
[1.0.8]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.8
[1.0.7]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.7
[1.0.6]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.6
[1.0.5]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.5
[1.0.4]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.4
[1.0.3]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.3
[1.0.2]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.2
[1.0.1]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.1
[1.0.0]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.0