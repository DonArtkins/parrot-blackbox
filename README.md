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
4. **Manages ~175 GB of free cloud storage for you** — 5 MEGA + 5 Google Drive
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

## Install (streamlined)

```bash
npm install -g parrot-blackbox
```

Run it — you land in the **menu wizard** (just like gitswitch):

```bash
parrot-blackbox
```

**On every launch the wizard:**
1. **Checks npm for the latest version** and offers to self-update
   (`npm install -g parrot-blackbox@latest`) if a newer one is published — the
   latest always comes from the npm registry, never from local state.
2. Shows a **menu with every feature**: add account, storage pool, check &
   install tools, snapshot now, run backup, list backups, restore, always-on
   service, daemon, guided setup, status, doctor, **repair**, **update**,
   **uninstall**. Choosing an action runs it and returns to the menu — saying
   "No" to a prompt never kicks you out; only **Exit** / **Ctrl+C** leaves.

---

## Quick start (the important bit)

```bash
# 1. Install + run the wizard (installs tools, adds accounts, first snapshot):
npm install -g parrot-blackbox
parrot-blackbox

# 2. If you have MORE MEGA / Drive accounts, add them the same guided way:
parrot-blackbox remote add mega          # prompts for email/password
parrot-blackbox remote add gdrive        # opens browser OAuth
parrot-blackbox remote list              # see remotes + pool registration

# 3. Force your FIRST snapshot backup right now (or again later — it captures
#    the whole system and uploads it to the cloud):
parrot-blackbox force
```

`parrot-blackbox status` shows the pool, network state, daemon state, last run
and pending backups.

---

## 🤖 Background Automation (Set it and forget it)

To make `parrot-blackbox` take weekly snapshots and upload them to your cloud accounts completely automatically in the background, install the background service:

```bash
parrot-blackbox schedule install
parrot-blackbox daemon start
```

Once started, the daemon runs silently as a background process. It wakes up every Saturday at 22:00, takes a Timeshift snapshot, and trickles the upload to your cloud accounts. 
If your laptop happens to be powered off or completely offline on Saturday night, the daemon is smart enough to immediately catch up and run the missed backup the very next time you connect to WiFi!

You can check on the daemon at any time using:
```bash
parrot-blackbox status
```

---

## Managing cloud accounts (rclone remotes)

Every MEGA / Google Drive login becomes one rclone remote = one pool account.
There are **two ways** to connect them:

- **Guided (recommended):** `parrot-blackbox` creates the rclone remote *for
  you* — no menus. `parrot-blackbox remote add mega` prompts for the remote
  name, email, password and optional 2FA, then registers it.
- **Manual:** configure remote(s) yourself with the raw `rclone config` — the
  **complete step-by-step walkthrough of every prompt and every letter is
  documented below** in the next section.

**Add** (guided — creates the remote AND saves it in the pool):
```bash
parrot-blackbox remote add mega            # prompts: name, email, password, 2FA (optional)
parrot-blackbox remote add gdrive          # opens browser OAuth for Google
parrot-blackbox remote add mega mega-1     # or pass the name directly
# non-interactive (CI): PBB_MEGA_USER=me@x.com PBB_MEGA_PASS=secret parrot-blackbox remote add mega
```

**List** (which remotes exist + are registered):
```bash
parrot-blackbox remote list
parrot-blackbox account list               # pool usage & free space
```

**Edit / rename** any remote (advanced, full rclone editor):
```bash
parrot-blackbox remote config              # pick the remote → e) Edit, r) Rename, c) Copy
```

**Delete** a remote entirely (removes the rclone entry AND its pool account):
```bash
parrot-blackbox remote remove <name>
```

**Already configured rclone remotes?** (e.g. an old `mega:` you created long
ago) — register them into the pool without recreating:
```bash
parrot-blackbox account add mega mega      # provider + existing remote name
parrot-blackbox account list
```

rclone stores secrets encrypted in `~/.config/rclone/rclone.conf`; parrot-blackbox
only ever stores the **remote name + provider + optional quota**, never your
passwords, and the allocator's manifests are safe to share.

---

## 📖 The full `rclone config` manual walkthrough (every letter, every prompt)

> The wizard's *"Configure rclone myself, then register the remote"* path (and
> the `parrot-blackbox remote config` command) open rclone's interactive menu.
> This is that menu, explained **prompt by prompt** so you never get lost.
> The quick alternative that skips all of this: `parrot-blackbox remote add mega`
> (or `gdrive`) creates the remote for you automatically.

### 1. The main menu — what each letter does

```
Current remotes:

Name                 Type
====                 ====
mega                 mega

e) Edit existing remote
n) New remote
d) Delete remote
r) Rename remote
c) Copy remote
s) Set configuration password
q) Quit config
e/n/d/r/c/s/q>
```

| Letter | Word | What it does |
|---|---|---|
| `e` | **Edit** | Change an **existing** remote's login (email / password / 2FA) or storage type |
| `n` | **New** | **Create a brand-new remote** → the flow below |
| `d` | **Delete** | Remove a remote from the config — rclone asks `y` to confirm |
| `r` | **Rename** | Give an existing remote a different name |
| `c` | **Copy** | Duplicate an existing remote under a new name (handy for a 2nd account of the same type) |
| `s` | **Set config password** | Lock the whole `rclone.conf` with a passphrase (optional; skip unless you want it) |
| `q` | **Quit** | Leave the menu → you return to parrot-blackbox |

> **The letters you'll use most:** `n` (new remote), `e` (fix a wrong password),
> `d` (remove an account you don't use), `q` (done).

---

### 2. Adding a MEGA remote (storage number **39**)

Start the menu with `n`, then follow exactly:

```
e/n/d/r/c/s/q> n                          ⬅ type the letter n and press Enter
Enter name for new remote.
name> mega-account-1                       ⬅ type the remote name and press Enter
```

> **What the name is:** a label for this login. Use something meaningful per
> account, e.g. `mega-account-1`, `mega-2`, `mega-main`. You'll type this exact
> name into parrot-blackbox later.

```
Option Storage.
Type of storage to configure.
...long numbered list of 68 providers...
Storage> 39                                ⬅ type 39 for Mega and press Enter
```

> **The storage number for each provider:**
> | Provider | Number to type | (what it says in the list) |
> |---|---|---|
> | **Mega** (the one you use) | **`39`** | `39 / Mega - Tier 2 \ (mega)` |
> | **Google Drive** | **`24`** | `24 / Google Drive - Tier 1 \ (drive)` |

Next rclone asks for login details — this means **the email + password of the
cloud account** you want to back up to:

```
Option user.
User name.
Enter a value.
user> info.donartkins.ke@gmail.com         ⬅ type the account's EMAIL and press Enter

Option pass.
Password.
Choose an alternative below.
y) Yes, type in my own password
g) Generate random password
y/g> y                                     ⬅ type y to enter your own password

Enter the password:
password: ********                          ⬅ type the account PASSWORD (invisible)
Confirm the password:
password: ********                          ⬅ type it again to confirm
```

> **What this means:** `user` = the **email address** of your MEGA account.
> `pass` = that account's **password**. rclone encrypts it before saving it —
> you'll see `*** ENCRYPTED ***` later.

After the password, optional but present for accounts that have it:

```
Option 2fa.
The 2FA code of your MEGA account if the account is set up with one
Enter a value. Press Enter to leave empty.
2fa>                                     ⬅ if you use 2FA on this MEGA account, enter the
                                              current 6-digit code here; if not, press Enter
```
---

### 3. Advanced config — ⚠️ **SAY NO** (this is the mistake you kept making)

rclone then asks `Edit advanced config?` **twice**. You almost always want
**`n` (No)** here — parrot-blackbox works fine with the defaults:

```
Edit advanced config?
y) Yes
n) No (default)
y/n> n                                  ⬅ type n and press Enter   ✅ SAY NO
```

If you mistakenly choose `y`, rclone will march you through `debug`,
`hard_delete`, `use_https`, `encoding`, `description`… — you can press **Enter**
on every single one to accept defaults, then it asks `Edit advanced config?`
again → answer `n` the second time. But the easy path is simply **`n` the
first time**.

When it finishes you get a confirmation:

```
Configuration complete.
Options:
- type: mega
- user: info.donartkins.ke@gmail.com
- pass: *** ENCRYPTED ***
Keep this "mega-account-1" remote?
y) Yes this is OK (default)
e) Edit this remote
d) Delete this remote
y/e/d> y                                 ⬅ type y to save this remote
```

> **Important:** this confirmation `y` ("keep this remote") is DIFFERENT from
> the advanced-config prompt. Here you DO want `y` — it saves the remote you
> just created.

---

### 4. Adding a Google Drive remote (storage number **24**)

Same `n` flow, but the two differences are the storage number and the auth step:

```
e/n/d/r/c/s/q> n                          ⬅ n for new
name> gdrive-account-1                    ⬅ the remote name
Storage> 24                               ⬅ 24 = Google Drive

-- rclone then prints a big "Use auto config?" section --
Use auto config?
y) Yes
n) No
y/n> y                                    ⬅ y (opens your browser automatically)
```

rclone opens a **browser page asking you to sign in to Google** and grant
access — log in, allow, done. Back in the terminal:

```
Edit advanced config?
y) Yes
n) No (default)
y/n> n                                    ⬅ ✅ NO

Keep this "gdrive-account-1" remote?
y) Yes this is OK (default)
y/e/d> y                                  ⬅ y to keep it
```

> If the browser doesn't open (headless), choose the manual option rclone gives
> you and paste the printed verification code into `http://localhost:53682` —
> but on your desktop the browser usually just opens.

---

### 5. After you quit (`q`) — register the remotes

You arrive back in parrot-blackbox with the message
`Starting rclone config — follow its prompts, then come back.` Once rclone's
menu is closed (`q`), the wizard automatically shows the remotes it found and
lets you pick which to register into the pool:

```
Select which rclone remotes to add to the backup pool:   ⬅ tick your new names
```

Each one is then tagged with its provider as you type it into rclone. If you
quit the wizard before registering, that's fine — either re-run
`parrot-blackbox` or:

```bash
parrot-blackbox account add mega mega-account-1     # provider + the remote name you chose in rclone
parrot-blackbox remote list                         # confirm it's now registered
```

---

### 6. Editing / renaming / deleting a remote later (the `e` `r` `d` letters)

Fix a wrong password, rename, or delete an old account:

```
e/n/d/r/c/s/q> e                             ⬅ e = Edit an existing remote
Choose a number from below ...               ⬅ pick the remote to edit
Edit remote
u) Update current
y) Yes type in my own password
g) Generate random password
q) Quit config
u> y                                         ⬅ choose what to change (u = update this field)
Name or type of remote > user                ⬅ which field: user, pass, 2fa, type, ...
user> new@email.com                          ⬅ the new value
```

Rename:
```
e/n/d/r/c/s/q> r                             ⬅ r = Rename
Old name> mega-account-1                     ⬅ current name
New name> mega-backup-1                      ⬅ new name
```

Delete:
```
e/n/d/r/c/s/q> d                             ⬅ d = Delete
Choose a number from below ...               ⬅ pick the remote
y) Yes this is OK
e) Edit this remote
y/e> y                                       ⬅ y confirms permanent deletion
```

> Any rename/delete also must be mirrored in parrot-blackbox's pool:
> `parrot-blackbox remote list` shows what's registered, and
> `parrot-blackbox remote remove <name>` removes an entry from BOTH rclone and
> the pool in one go.

---

## Commands

| Command | What it does |
|---|---|
| `parrot-blackbox` | ⭐ **Menu wizard** — every feature in one menu; automatic update check on launch |
| `parrot-blackbox install` | Same as the menu wizard |
| `parrot-blackbox repair [--yes]` | Fix a broken install (tools, config, service, pool) |
| `parrot-blackbox update [--force]` | Check npm & update to the latest published version |
| `parrot-blackbox setup` | Guided full setup (tools, accounts, schedule, service) |
| `parrot-blackbox run` | Run any due/pending backups now (safe for cron) |
| `parrot-blackbox force` | ⭐ Run every enabled backup NOW (default = weekly snapshot) `[sudo]` |
| `parrot-blackbox snapshot now` | Create + upload a Weekly Timeshift snapshot `[sudo]` |
| `parrot-blackbox snapshot list` | Local & cloud snapshots |
| `parrot-blackbox snapshot prune` | Delete snapshots past the keep limit `[sudo]` |
| `parrot-blackbox list` | List cloud file backups |
| `parrot-blackbox restore` | Interactive restore wizard `[sudo]` |
| `parrot-blackbox restore files <id> <dir>` | Recover a file backup into a folder |
| `parrot-blackbox restore snapshot <id> --yes` | Overwrite the whole system from a cloud snapshot `[sudo]` |
| `parrot-blackbox account add <mega\|gdrive> <remote>` | Register an existing rclone remote into the pool |
| `parrot-blackbox account list` | Pool summary + per-account quota |
| `parrot-blackbox account remove <id>` | Remove an account from the pool |
| `parrot-blackbox account quota <id> <GiB>` | Override an account's quota |
| `parrot-blackbox remote add <mega\|gdrive> [name]` | ⭐ Add a cloud account (guided — sets up rclone FOR you) |
| `parrot-blackbox remote list` | Show rclone remotes + pool registration |
| `parrot-blackbox remote remove <name>` | Delete a remote (rclone + pool) |
| `parrot-blackbox remote config` | Open the full rclone config editor (advanced) |
| `parrot-blackbox daemon start\|stop\|status` | Background automation |
| `parrot-blackbox schedule install\|remove` | systemd / cron always-on setup |
| `parrot-blackbox doctor` | Full diagnostics |
| `parrot-blackbox status` | Quick status |
| `parrot-blackbox uninstall` | Remove everything (cloud backups kept) |

---

## How the smart storage pool works

```
5 MEGA      (20 GiB each)     = 100 GiB
5 Drive     (15 GiB each)     =  75 GiB   ← Google Drive free tier is 15 GiB
──────────────────────────────
≈ 175 GiB managed automatically
```

(Your live `account list` proves it: 10 accounts → 175 GiB total.)
Every account is exactly one rclone remote (`mega-1:`, `gdrive-6:` …).
- Each backup has **one manifest** that records where every file (or chunk) is.
- Placement picks the account that would end up with the **lowest used
  percentage** (water-filling), then most free.
- A file that doesn't fit any single account is split at `chunkSize` boundaries
  and the pieces are spread across accounts — restore reassembles byte-perfect.
- **BTRFS native support** — BTRFS root-owned snapshot files (e.g. `/etc/credstore`) are securely backed up to the cloud without `EACCES` permission errors via an internal privileged helper that integrates with the familiar interactive sudo prompt.
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
rclone config                             # re-add the same remotes
parrot-blackbox account add mega mega-1   # …add every account
parrot-blackbox snapshot list             # see what's in the cloud
parrot-blackbox restore snapshot <snapshot-id> --yes
```

#### What happens during a snapshot restore on a fresh install?
When you run the restore command, `parrot-blackbox` does the following:
1. **Downloads the snapshot:** It pulls the exact system snapshot from your cloud accounts, reassembles the byte-chunks, and places it into your local Timeshift directory.
2. **Runs Timeshift Restore:** It then hands over control to Timeshift (`sudo timeshift --restore`).
3. **Overwrites the OS:** Timeshift systematically replaces the system files of your *fresh* install with the files from your *snapshot*. Your programs, configurations, user settings, and installed packages are exactly reverted to how they were when the snapshot was taken.
4. **Bootloader update:** Finally, Timeshift updates your GRUB bootloader and `/etc/fstab` to match the UUIDs of your new disk partitions, ensuring the system can boot.

#### What about Disk Encryption (Passphrases)?
**Disk encryption (LUKS) operates at the hardware/disk level, while snapshots operate at the file level.** 
If your old system had a passphrase (encrypted), but you decide to fresh-install Parrot OS *without* a passphrase (unencrypted), **the restore will still work perfectly.**
- The snapshot only contains your files and programs, not the LUKS encryption container.
- When Timeshift restores the files onto your new unencrypted fresh install, it simply places the files into the unencrypted disk.
- Timeshift automatically detects the new partition layout, updates your boot configurations, and after a reboot, you will have your exact old system back, but running on an unencrypted drive without any password prompts on boot!

*Note: After rebooting into your restored system, it is always a good idea to run `sudo apt update && sudo apt upgrade` to ensure all packages are perfectly aligned with the latest Parrot OS repositories.*

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