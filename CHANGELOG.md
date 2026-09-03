# Changelog

## [2.0.8] - 2026-09-03

### Fixed — progress bar not visible inside the wizard menu

- **Root cause:** the `@clack/prompts` wizard owns the terminal cursor; raw
  `\r` overwrites from `makeProgressRenderer` were immediately clobbered by
  clack's own ANSI rendering, so the bar flashed and disappeared.
- **New `makeClackProgressRenderer(p)`** in `src/util/misc.js` — a
  clack-aware variant that emits progress via `p.log.message()` throttled to
  at most once per 800 ms, then emits a final line on `.stop()`.  This keeps
  output stable inside clack's frame while still showing meaningful progress.
- **`backupNowAction` (wizard "Create snapshot" / force-backup path)** was
  missing `onProgress` entirely — the upload was completely silent even after
  v2.0.7.  Now wired to `makeClackProgressRenderer`.
- **`snapshotNowAction`** updated from the raw TTY renderer to the clack-aware
  one for the same reason.
- `makeProgressRenderer` (raw TTY version) is retained and still used by the
  non-wizard CLI paths (`parrot-blackbox snapshot now`,
  `parrot-blackbox force`) where clack is not active.

## [2.0.7] - 2026-09-03

### Added — Live upload progress bar with percentage, MB/s, and target remote

- **`makeProgressRenderer()`** — new shared utility in `src/util/misc.js` that
  returns an `onProgress` handler rendering a live, in-place progress bar.
  On a TTY it overwrites the current line with `\r` + erase-to-end so the
  display never scrolls:
  ```
    [█████████████░░░░░░░░░░░░]  53%  6823.4 MB / 13000.0 MB  4.1 MB/s  → mega-1
  ```
  When the stream size is unknown (BTRFS send with no parent estimate) it shows
  bytes streamed and speed instead of a percentage bar.  On non-TTY output
  (daemon / piped) it only prints when the line changes, avoiding log spam.
- **`planAndPlaceStream` now emits speed** — a 1.5-second rolling window
  calculates upload speed (`speedMBs`) and the current target `remote` are
  included in every `onProgress` event.
- **`snapshot now`**, **`force`/`backup`**, and the **menu wizard "Snapshot
  now"** action all pass a renderer as `onProgress` so upload progress is
  always visible. Before this fix every upload was completely silent — no
  indication anything was happening after "📤 Uploading…".

## [2.0.6] - 2026-09-03

### Fixed — BTRFS send "not read-only" error, stale mounts, and process hang on exit

- **`btrfs send failed: subvolume … is not read-only`** — `uploadViaBtrfsSend`
  now calls `isSubvolumeReadOnly` before invoking `btrfs send`. When the
  subvolume is accessed via the `subvolid=5` bind-mount created by
  `snapshotDirFor`, the kernel can expose the inner `@` subvolume as writable
  even though Timeshift created it read-only. If it is not read-only the tool
  now calls `setSubvolumeReadOnly(subvolPath, true)` to correct it before
  proceeding, instead of letting `btrfs send` abort with exit 1.
- **Stale `/run/parrot-blackbox-btrfs-*` mounts leaked after failed uploads.**
  Added a module-level `_activeTempMounts` registry in `snapshot.js` and a
  `process.on('exit', _cleanupAllTempMounts)` hook that unmounts every
  temporary `subvolid=5` bind-mount at process exit, even when the snapshot
  object that originally held the `_tempMount` reference was discarded (e.g.
  during the resume-upload flow).
- **Process hung indefinitely after choosing "Exit" from the wizard.** The open
  kernel mount file descriptor kept Node's event loop alive; `runMain` returning
  was not enough to terminate the process. `cli.js` now chains
  `.then(() => process.exit(process.exitCode ?? 0))` onto `runMain`, so the
  process always exits promptly after the command completes.
- **`_internal_upload` subprocess wrote its manifest via a lazy
  `import('node:fs').then(...)` microtask** that could be cut off when
  `process.exit()` fired. Changed to use top-level `import fs from 'node:fs'`
  so the write is synchronous and guaranteed before exit.

## [2.0.5] - 2026-09-03

### Fixed — BTRFS uploads and restores now work on a real Parrot (BTRFS-in-LUKS) install

- **`btrfs send` failed with `failed to get flags for subvolume …: Invalid argument`**
  because the tool sent the Timeshift *snapshot container directory* instead of
  the actual subvolume. Timeshift (BTRFS mode) stores each snapshot as
  `<snapshots>/<name>/@` — the container is a plain directory. New
  `findSnapshotSubvolume()` resolves `<snapshot-dir>/@` (and also accepts a
  layout where the directory itself is a subvolume). Full **and** incremental
  sends (`-p <parent>/@`) now work, with a clean message instead of a silent
  failure when the snapshots genuinely aren't subvolumes (Timeshift rsync mode
  → automatic file-copy fallback, copying the `@` tree).
- **Phantom 13-byte streams poisoned the incremental chain.** A failed send was
  still written to the cloud (stream fragment + manifest). Now:
  - Uploads abort and remove any partial stream + manifest when any pipeline
    stage fails or the produced stream is under `1 MiB`
    (`MIN_VALID_STREAM_BYTES`).
  - `findLastUploadedSnapshot()` only trusts manifests describing a real
    stream, so corrupt parents are never picked for `btrfs send -p`.
  - `snapshot list` / restore ignore phantom manifests (they are treated as
    absent).
- **Incremental parent info never reached the cloud.** The cloud manifest was
  written before the parent link was added, so a restore from a wiped machine
  lost the whole chain. The enriched manifest (with `parent` + `snapshot`) is
  now re-uploaded to the cloud right after every successful send.
- **`parrot-blackbox snapshot prune` crashed** (wrong argument order passed to
  `pruneSnapshots` — it received the state object as the accounts list). Fixed.
- **Restore now lands inside Timeshift's real BTRFS repo.** Before, restore
  piped into `btrfs receive /timeshift/snapshots`, which does not exist on a
  standard BTRFS-in-LUKS install. Restore now resolves the actual
  `timeshift-btrfs/snapshots` location (mounting `subvolid=5` when needed),
  receives each stream into `<snapshots>/<id>/` (streams are named `@`, so the
  received subvolume lands exactly where Timeshift expects it), writes the
  Timeshift control file (`info.json`) and marks the subvolume read-only — so
  `timeshift --restore --snapshot <id>` recognizes the backup immediately.
- **Mount hygiene:** parent-snapshot mounts and restore mounts are cleaned up
  instead of piling up in `/run`.

## [2.0.4] - 2026-09-03

### Fixed
- **Delete ALL snapshots actually works now.** Timeshift exits 0 even when it prints `E: Failed to destroy qgroup / E: Failed to remove snapshot` — the previous code trusted the exit code and reported success while the snapshots remained. The fix:
  - After each `timeshift --delete`, verify the snapshot is actually gone by re-running `timeshift --list`.
  - If it's still present, run a second `btrfs quota rescan -w /` (the delete itself creates a new stale qgroup entry) and retry once.
  - Only mark as deleted once absence is confirmed. Only mark as failed if it persists after both attempts.
  - Extracted `btrfsQuotaRescan()` helper used for both the upfront rescan and the mid-loop retry.

## [2.0.3] - 2026-09-03

### Added
- **Snapshot delete menu** (`parrot-blackbox` wizard → 🗑 Delete snapshots): lists all local Timeshift snapshots, lets you pick one to delete or choose "Delete ALL". Before the delete-all loop, `sudo btrfs quota rescan -w /` is always run first to fix stale qgroup entries that would otherwise cause "Failed to destroy qgroup" errors. Failed deletes are reported individually; you can retry and they will succeed after the rescan.
- **`parrot-blackbox snapshot delete [<name>|--all]`** CLI subcommand:
  - No argument: lists local snapshots and shows usage.
  - `<name>`: deletes that single snapshot.
  - `--all`: runs `btrfs quota rescan -w /` then deletes every local snapshot with confirmation (interactive) or immediately (non-interactive with `--yes` coming from stdin).

## [2.0.2] - 2026-09-03

### Fixed
- **BTRFS upload silent failure:** `uploadViaBtrfsSend` was hardcoding `/timeshift-btrfs/snapshots/<name>` as the subvolume path instead of using the real path resolved by `snapshotDirFor()` (the BTRFS root subvolume mount at `/run/parrot-blackbox-btrfs-<ts>/...`). `btrfs send` silently failed on the non-existent path and the upload dropped without error.
- **Undetected pipeline errors:** `createSendStream` now returns `{stream, child}` instead of just the stream, so `uploadViaBtrfsSend` waits on the `btrfs send` process exit code alongside the rest of the pipeline stages. Errors now surface with a clear message including the stderr output and the failing path.

## [2.0.1] - 2026-09-03

### Fixed
- Version bump to correctly follow v2.0.0 published release

## [2.0.0] - 2026-09-03

### 🚀 Major Release: BTRFS Send/Receive Architecture

**Revolutionary efficiency upgrade:** V2.0 replaces file-by-file snapshot copying with native BTRFS send/receive streaming, achieving **10-50x smaller uploads** after the initial bootstrap backup.

#### Breaking Changes
- **Config schema v2**: New `jobs.snapshots.btrfs` section added to config (auto-migrated on upgrade)
- **Manifest schema v2**: BTRFS streams use new manifest format with parent chain tracking
- **First backup after upgrade**: Will be a full BTRFS send (~35 GiB) to establish baseline

#### Added
- **Incremental BTRFS Streaming**
  - First backup: Full `btrfs send` (~35-40 GiB, compressed with zstd)
  - Subsequent backups: Incremental `btrfs send -p <parent>` (only block-level diffs, typically 100 MB - 2 GB)
  - Direct streaming pipeline: `btrfs send | zstd | [openssl] | rclone rcat` (no temp files)
  - Parent chain tracking in manifests for proper restore ordering
  
- **Optional AES-256 Encryption**
  - Configure via `jobs.snapshots.btrfs.encryption = true` and `storage.encryptionPassphrase`
  - Integrated into streaming pipeline with openssl

- **Smart Parent Discovery**
  - Automatically finds most recent uploaded snapshot as parent for incremental send
  - Protects parent snapshots from pruning if child snapshots are kept

- **Automatic Fallback**
  - Detects if root filesystem is BTRFS via `isBtrfsFilesystem()`
  - Gracefully falls back to v1.x file-copy mode on non-BTRFS systems
  - Backward compatible with all existing v1.x backups

- **Restore Enhancements**
  - Parent chain reconstruction for incremental restores
  - Reverse pipeline: `rclone cat | openssl dec | zstd -d | btrfs receive`
  - Post-restore UUID fixup guidance for hardware changes (`/etc/fstab`, `/etc/crypttab`, GRUB)

#### Changed
- **Upload efficiency**: After first backup, weekly uploads reduced from 35+ GiB to ~100 MB - 2 GB
- **Upload duration**: Incremental backups now complete in 5-20 minutes instead of 2-8 hours
- **Snapshot pruning**: Now parent-chain aware, won't delete snapshots needed for incremental restore

#### Technical Details
- New module: `src/backup/btrfs-send.js` with all BTRFS primitives
- Updated: `snapshot.js`, `restore.js`, `allocator.js`, `cli.js` for streaming architecture
- Config v1 → v2 migration is automatic and non-destructive
- Manifest schema v1 (file trees) and v2 (streams) coexist peacefully

See `CHANGELOG-v2.0.0.md` for complete technical documentation.

---

## [1.1.0] - 2026-09-02

### Changed
- **Account Limits** — Clarified in documentation that there is no limit to the number of MEGA or Google Drive accounts that can be added, and that MEGA accounts are always fully populated before any Google Drive fallback is used.
- **Test Suite** — Fixed nested tests and assertion bugs in the e2e test suite that were causing false positive test failures during cloud pruning assertions.

## [1.0.18] - 2026-09-02

### Fixed
- **Resume tracker uses wrong data source** — The snapshot resume logic was checking `state.manifests` (the in-memory JSON blob) to decide whether a local snapshot had been fully uploaded. This blob is always empty after a reinstall or fresh state, so every existing local snapshot was incorrectly treated as incomplete and retried instead of letting a new one be created. The check now looks at the actual manifest **files on disk** (`~/.local/state/parrot-blackbox/manifests/snapshots-<name>.json`), which are written by the allocator and survive reinstalls.
- **Early account guard** — `snapshot now` now fails immediately with a clear message if no storage accounts are configured, instead of silently creating a local Timeshift snapshot that can never be uploaded.
- **Resume Upload menu option** — Added an explicit `⏳ Resume upload` entry to the wizard main menu so users can manually trigger the resume tracker without needing to know the CLI subcommand.

## [1.0.17] - 2026-09-02

### Fixed
- **Storage Accounts Missing During Snapshot Upload** — Fixed an issue where `parrot-blackbox snapshot now` would fail to upload with a "no storage accounts configured" error because the internal `sudo` process lost the user's `HOME` directory and `PBB_STATE_DIR` variables, causing it to look in `/root`.

## [1.0.16] - 2026-09-02

### Changed
- **Interactive Sudo Prompts Everywhere** — Replaced silent non-interactive sudo execution with an intelligent authentication wrapper. Now, any menu item, command, package installation, or update requiring root privileges will explicitly pause and prompt for your sudo password interactively (`sudo -v`), arming the session so you never have to guess when root access is needed.

## [1.0.15] - 2026-09-02

### Fixed
- **Accounts disappearing after backup (rclone.conf permission denied)** — When `_internal_upload` ran as root to access BTRFS snapshots, `rclone` would sometimes refresh Google Drive OAuth tokens and rewrite `~/.config/rclone/rclone.conf` as `root:root`. This locked the normal user out of their own cloud accounts, causing the tool to drop the pool entries on the next `repair`. The upload routine now restores `rclone.conf` ownership to the original user (`SUDO_UID`:`SUDO_GID`) before exiting.

## [1.0.14] - 2026-09-02

### Added
- **Upload Resume Support** — If a snapshot upload is interrupted due to a power cut, network failure, or API rate limits, the next upload run will automatically detect the un-uploaded snapshot and resume exactly where it left off, skipping already uploaded chunks instead of starting a new snapshot from scratch.

### Fixed
- **Google Drive "directory not found" upload failure** — Addressed an issue where `rclone copy --files-from` would fail when writing to a newly generated remote destination directory. `parrot-blackbox` now explicitly creates the root remote directory (`rclone mkdir`) before batching files to ensure seamless uploads.

## [1.0.13] - 2026-09-02

### Fixed
- **BTRFS snapshot upload EACCES permissions error** — `fs.readdirSync` failed when scanning root-owned files (like `/etc/credstore`) inside the Timeshift BTRFS mount. The upload logic is now run through an internal privileged helper (`sudo -E node ... _internal_upload`), allowing full traversal and chunking of BTRFS files while preserving the exact interactive sudo password prompt behavior used in other tools (e.g. gitswitch).

### Changed
- **Massively faster snapshot uploads (batch mode)** — Replaced the sequential file-by-file upload loop (one `rclone copyto` per file, ~474k process spawns for a full system snapshot) with a two-pass batched architecture: files are pre-allocated to accounts in-memory, then uploaded using `rclone copy --files-from` with `--transfers=16 --checkers=16` for internal parallelism. Expected ~8–12× speedup (20+ hours → 1–3 hours).

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

[1.0.13]: https://github.com/DonArtkins/parrot-blackbox/releases/tag/v1.0.13
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