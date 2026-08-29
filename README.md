# parrot-blackbox 🦜📦

**Crash-proof, multi-cloud backup & recovery automation for Parrot OS.**

`parrot-blackbox` is the "black box flight recorder you lost last time your
Parrot install died" — a single CLI + background daemon that:

1. **Automates backups** — a full **Timeshift system snapshot** every
   **Saturday at 22:00** (the weekly snapshot IS the backup — no noisy daily
   file backups, so storage stays lean).
2. **Installs whatever your system needs** — running the wizard checks for
   `rclone`, `timeshift`, `git` and `curl` and **auto-installs the missing
   ones** (sudo prompt, exactly like theamify) so snapshot backup AND restore
   always work on a fresh Parrot.
3. **Is crash-proof** — if the laptop is off or offline at backup time, the
   missed backups are run **in order, oldest first, the moment WiFi is back**.
   Every job is journalled and retried; a lock prevents collisions; state is
   written atomically. Nothing is silently lost.
4. **Manages ~150 GB of free cloud storage for you** — 5 MEGA + 5 Google Drive
   accounts are connected as one pool. Files are placed whole on whichever
   account has the most relative headroom; anything bigger than a single
   account's free space is split into byte-range chunks across accounts and a
   manifest remembers how to reassemble it. You can never be "out of space".
5. **Keeps the disk honest** — old snapshots (keep the latest 3, the middle one
   as the sanity safety-net) are pruned **both locally and in the cloud in the
   same pass**. Daily file backups are available as an **opt-in** if you ever
   want them.
6. **Brings you back from a fresh install** — restore a snapshot from the cloud
   onto fresh Parrot (works whether or not you used disk encryption; it just
   needs your `sudo` password, exactly like gitswitch/theamify).

---

## Why this exists

From `research.txt`: a Parrot OS crash once wiped every local file, every
customization, and the VS Codium profile. Only GitHub was safe. Timeshift
snapshots existed — but they lived on the *same* disk, so a dead SSD took them
too. This tool automates the fix:

- Timeshift snapshots are created **and uploaded to the cloud pool** weekly.
- File backups live on MEGA + Drive only.
- The only recovery-critical local thing left is the CLI itself (`npx` is a
  clone away).

---

## Requirements

| Tool | Why |
|---|---|
| Node.js ≥ 18 | runs the CLI |
| `rclone` | talks to MEGA and Google Drive (one rclone remote = one account) |
| `timeshift` | system snapshots (BTRFS mode; rsync mode also works) |
| `git` | detecting repos so their files are excluded |
| `curl` | connectivity checks |

```bash
sudo apt install rclone timeshift git curl
```

---

## Install

```bash
npm install -g parrot-blackbox
```

Run the setup wizard:

```bash
parrot-blackbox
```

**The wizard first checks your system and auto-installs anything needed** for
snapshot backup + restore (`rclone`, `timeshift`, `git`, `curl` — it detects
your package manager and runs the install with an interactive sudo prompt,
the gitswitch/theamify way). Then it walks you through: authorizing your
MEGA / Drive accounts in `rclone config` → registering each remote as an
account → installing the always-on service → an optional first snapshot.

---

## Quick start (the important bit)

```bash
# 1. Install, then run the wizard (installs missing tools for you):
npm install -g parrot-blackbox
parrot-blackbox

# 2. Create your rclone remotes (one per MEGA / Drive account) if not done:
rclone config

# 3. Add them to the pool (repeat for every account):
parrot-blackbox account add mega mega-account-1
parrot-blackbox account add gdrive my-drive-1
parrot-blackbox account list          # see the whole pool + quota

# 4. Force your FIRST snapshot backup right now (do this before a fresh
#    install — it captures the whole system and uploads it to the cloud):
parrot-blackbox force
```

`parrot-blackbox status` shows the pool, network state, daemon state, last run
---

## Commands

| Command | What it does |
|---|---|
| `parrot-blackbox` | Interactive setup wizard (checks & **auto-installs** needed tools) |
| `parrot-blackbox run` | Run any due/pending backups now (safe for cron) |
| `parrot-blackbox force` | ⭐ Run every enabled backup NOW (default = weekly snapshot) `[sudo]` |
| `parrot-blackbox snapshot now` | Create + upload a Weekly Timeshift snapshot `[sudo]` |
| `parrot-blackbox snapshot list` | Local & cloud snapshots |
| `parrot-blackbox snapshot prune` | Delete snapshots past the keep limit `[sudo]` |
| `parrot-blackbox list` | List cloud file backups |
| `parrot-blackbox restore` | Interactive restore wizard `[sudo]` |
| `parrot-blackbox restore files <id> <dir>` | Recover a file backup into a folder |
| `parrot-blackbox restore snapshot <id> --yes` | Overwrite the whole system from a cloud snapshot `[sudo]` |
| `parrot-blackbox account add <mega\|gdrive> <remote>` | Add an account to the pool |
| `parrot-blackbox account list` | Pool summary + per-account quota |
| `parrot-blackbox account remove <id>` | Remove an account |
| `parrot-blackbox account quota <id> <GiB>` | Override an account's quota |
| `parrot-blackbox daemon start\|stop\|status` | Background automation |
| `parrot-blackbox schedule install\|remove` | systemd / cron always-on setup |
| `parrot-blackbox doctor` | Full diagnostics |
| `parrot-blackbox status` | Quick status |
| `parrot-blackbox uninstall` | Remove everything (cloud backups kept) |

---

## How the smart storage pool works

```
5 MEGA      (20 GiB each)
5 Drive     (10 GiB each)
──────────────────────────────
≈ 150 GiB managed automatically
```

- Every account is exactly one rclone remote (`mega-1:`, `drive-2:` …).
- Each backup has **one manifest** that records where every file (or chunk) is.
- Placement picks the account that would end up with the **lowest used
  percentage** (water-filling), then most free.
- A file that doesn't fit any single account is split at `chunkSize` boundaries
  and the pieces are spread across accounts — restore reassembles byte-perfect.
- The manifest is written to the cloud **and** mirrored locally, so a wiped
  machine can still find and restore everything.

Never out of storage again — and if you ever pass 175 GiB of backups, the
allocator fails loudly with guidance instead of half-uploading.

---

## Retention (the "never out of disk / cloud" guarantees)

| What | Default | Result |
|---|---|---|
| Snapshots (Timeshift) | enabled, keep the newest **3** | latest + 2 previous weeks; the middle one is the sanity net |
| File backups | **disabled** (opt-in), keep newest 3 if enabled | no noisy daily uploads unless you want them |
| Pruning | happens for **local AND cloud in the same pass** | a fresh install can't resurrect old clutter |

The snapshot keep strategy: with `keep: 3` you always have *today's* snapshot
plus two earlier ones — so a crash mid-backup can still roll back to the most
recent working state, without wasting cloud or disk space. If you want the most
space-efficient option, set `keep: 1` and every successful backup erases the
previous one, leaving a single sane restore point:

```
$EDITOR ~/.config/parrot-blackbox/config.json   # jobs.snapshots.keep = 1
```

To ALSO run a daily file-level backup (opt-in), flip it on in the same file:

```
$EDITOR ~/.config/parrot-blackbox/config.json   # jobs.files.enabled = true
```
---

## Recovery guide (fresh install / new machine)

### Option A — restore your files (fonts, images, docs…)

```bash
parrot-blackbox restore files <backup-id> ~/recovered
```

### Option B — restore the whole system snapshot (recommended)

```bash
# on the fresh Parrot:
npm install -g parrot-blackbox
rclone config                       # re-add the same remotes
parrot-blackbox account add mega mega-1   # …add every account
parrot-blackbox snapshot list       # see what's in the cloud
parrot-blackbox restore snapshot <snapshot-id> --yes
```

This downloads the snapshot into Timeshift, then runs the interactive restore
(expect a `sudo` password prompt) — it **overwrites the fresh install's system
root** with the snapshot. After a reboot you're back to your old system; then
`sudo apt update && sudo apt upgrade` to move onto a newer Parrot release if
you installed one. Encryption or not makes no difference — snapshot restore is
run from inside the OS.

---

## Automation details (what "crash-proof" actually means)

- **Scheduling** — file backups daily 22:00, snapshots every Saturday 22:00
  (a recent Friday-through-Sunday window is hidden from storage by keeping
  only 3 generations). Both schedules are configurable.
- **Catch-up** — the daemon polls every 60s. On each tick it computes *every*
  calendar due that has passed since the last one it considered, drops the
  ancient backlog beyond `catchUpLimit`, and drains the rest **oldest first**.
  If it's offline at that moment, the dues stay pending and the daemon watches
  for the offline→online edge to fire immediately.
- **Crash-proofing** — state is written atomically (tmp + rename); the journal
  appends one line per event; every job opens a journal entry and only closes
  it on success; a single process lock (`withLock`) keeps the daemon and a
  manual `force` from colliding; stale locks (dead pid / expired TTL) are
  reclaimed automatically.
- **Non-interactive sudo** — the daemon never hangs on a password: it uses
  `sudo -n`, and if the sudo timestamp is lapsed it marks the snapshot job
  `deferred` and retries on the next tick. Run any interactive command (e.g.
  `parrot-blackbox snapshot now`) once to re-arm sudo.

---

## Uninstall

```bash
parrot-blackbox uninstall
```

Stops the daemon, drops the systemd/cron schedule, deletes local config/state
and the npm package. **Cloud backups are never touched.**

---

## Development

```bash
npm install
npm test                # unit tests + sandbox e2e tests (real CLI, fake cloud)
npm run publish:dry-run # inspect the tarball
npm run release:patch   # test → version bump → git push --follow-tags
npm publish             # to the public npm registry
```

The e2e suite (Level-5 safety proof) runs the **real CLI** against **stub**
`rclone`/`timeshift`/`sudo` binaries and a **fake cloud** — it never touches a
real disk, real account or real network.

## License

MIT
and pending backups. `parrot-blackbox doctor` is the full diagnostic.