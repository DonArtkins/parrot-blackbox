# Research: BTRFS Send/Receive for Incremental Cloud Backup (Parrot Blackbox Redesign)

Use case: Parrot OS on BTRFS-in-LUKS, backing up to cloud (e.g. Mega via rclone),
with the goal of restoring onto a *fresh* Parrot OS install on new hardware.

---

## 1. Why a snapshot is not a backup, and why `btrfs send` is different

A Timeshift/Btrfs snapshot is a read-only reference into the same copy-on-write
(CoW) tree as your live filesystem. It's cheap locally because unchanged blocks
are literally the same blocks — nothing is duplicated. This is exactly why `du`
and naive folder-copy tools misreport snapshot size: they see full logical size,
not actual disk usage.

The diagnosis in your source material checks out: **if you tar/zip a
snapshot's directory tree and upload that, the CoW efficiency is gone.** The
cloud receives full file contents every time, with no concept of "what
changed since last time."

`btrfs send` fixes this at the *filesystem* level rather than the file level:

- `btrfs send <snapshot>` — generates a binary stream describing a subvolume's
  entire content (a "full send").
- `btrfs send -p <parent_snapshot> <snapshot>` — generates a stream containing
  **only the block-level differences** between two related read-only snapshots.
- `btrfs receive <path>` — consumes either stream and reconstructs the subvolume
  as a real Btrfs subvolume at the destination, byte-for-byte, including
  extended attributes, permissions, and Btrfs-specific metadata.

Per the official btrfs-send manual page, it generates a stream of instructions
describing changes between two subvolume snapshots, which `btrfs receive`
consumes to replicate the snapshot on a different filesystem; the command
operates in full mode (everything included) or incremental mode (only the
diff) [1].

**Requirement:** both snapshots involved in an incremental send must be
**read-only**, and the parent snapshot must exist unchanged on both sides —
you cannot mix compression/checksum settings between source and destination
in incompatible ways, but normal Parrot Btrfs defaults are fine.

---

## 2. The standard incremental workflow

The pattern used by essentially every Btrfs backup tool (snapper+btrbk, Fedora's
own docs, Oracle Linux docs, btrfs2s3, btrfs2cloud) is:

**First backup (bootstrap / full send):**
```bash
sudo btrfs subvolume snapshot -r / /.snapshots/backup_0
sudo sync
sudo btrfs send /.snapshots/backup_0 | sudo btrfs receive /mnt/backup_drive/
```
Fedora Magazine's guide confirms this bootstrapping pattern: the initial send
corresponds to a full backup, with duration depending on subvolume size, while
subsequent incremental sends take much less time [2].

**Every subsequent backup (incremental):**
```bash
sudo btrfs subvolume snapshot -r / /.snapshots/backup_1
sudo sync
sudo btrfs send -p /.snapshots/backup_0 /.snapshots/backup_1 | sudo btrfs receive /mnt/backup_drive/
```
The `-p` flag is what makes it incremental. Specifying the previous snapshot
as a base with `-p` requires that snapshot to exist on both source and
destination, letting the send run incrementally instead of as a full
transfer [2].

Real-world measured effect, from someone doing exactly this: an initial full
copy took two minutes, while a later incremental send of the same subvolume
took only a few seconds because little had actually changed between the
snapshots [3]. Also worth noting: standard tools like `du` don't understand
Btrfs snapshots and will report inflated, doubled-looking usage even though
real incremental usage barely changed — a dedicated tool like `compsize` gives
accurate numbers [3]. **Don't trust `du` to verify your incremental setup is
working — use `btrfs filesystem df`, `btrfs qgroup show`, or `compsize`.**

You keep the old reference snapshot (`backup_0`) around specifically because
the *next* incremental send needs a common parent that exists in both places:
the subvolume kept as the local reference is needed for constructing the
incremental backup for the next step, since the send operation transmits only
the difference between the old and new backup snapshot to the backup
volume [4].

---

## 3. Sending over SSH vs. piping to a local/cloud destination

`btrfs send` and `btrfs receive` are two separate programs connected by a
pipe. That pipe can go anywhere a stream of bytes can go:

- **Local disk / external drive**: pipe directly into `btrfs receive /mnt/backup`.
- **Remote machine over SSH**, if the *destination* is also Btrfs:
  ```bash
  sudo btrfs send -p backup_0 backup_1 | ssh user@remote "sudo btrfs receive /backup/"
  ```
  This is documented as a supported pattern for remotely backing up a
  subvolume over SSH, since disk usage for incremental backups is restricted
  only to the size of the changes [5].
- **Object storage / non-Btrfs cloud (Mega, S3, B2, Google Drive, etc.)**: this
  is your actual case, and it needs one more step, because Mega/S3/etc. don't
  understand Btrfs subvolumes at all — they only store opaque files. The
  stream itself is just bytes, so the standard approach is: **pipe the stream
  through compression and encryption into a single file, then upload that
  file** rather than trying to "receive" it into cloud storage directly.

This exact pattern — compress, encrypt, and upload in one pipeline, without
writing an intermediate file to disk — is implemented by real open-source
tools. One implementation (btrfs2cloud-backup) uses snapper for read-only
snapshots, then a single pipe to upload the volume to the cloud with no
intermediate file, compressing with zstd and encrypting with openssl before
sending via rclone. The restore side mirrors this in reverse — pulling the
stored object back through rclone, decrypting with openssl, decompressing
with zstd, and piping the result into `btrfs receive` [6].

**Full pipeline shape (bootstrap, one-time):**
```bash
sudo btrfs send /.snapshots/backup_0 \
  | zstd -T0 -c \
  | openssl enc -e -aes256 -pbkdf2 -pass "pass:YOUR_PASSPHRASE" \
  | rclone rcat mega:parrot-backup/backup_0.zst.enc
```

**Incremental pipeline (every subsequent run):**
```bash
sudo btrfs send -p /.snapshots/backup_0 /.snapshots/backup_1 \
  | zstd -T0 -c \
  | openssl enc -e -aes256 -pbkdf2 -pass "pass:YOUR_PASSPHRASE" \
  | rclone rcat mega:parrot-backup/backup_1.zst.enc
```
(`rclone rcat` streams stdin directly to a remote file — no local temp file
needed, which matters for disk space on the source machine.)

A more structured alternative that manages the whole "tree of diffs" concept
automatically is **btrfs2s3**, purpose-built for this: it maintains a tree of
differential backups in cloud object storage compatible with any S3-style
API, where each backup object is a native btrfs archive produced by
`btrfs send`, the tree root is a full backup, and other nodes are
differential backups following a customizable schedule. It requires keeping
one local snapshot per corresponding cloud backup, because differential
backups need that correspondence [7]. It's S3-oriented rather than
Mega-oriented, but the design pattern — a schedule of full → monthly-diff →
daily-diff, one local snapshot kept per cloud object — is directly usable as
a blueprint for redesigning Parrot Blackbox's retention logic.

**Why not just zip the raw snapshot instead of using `btrfs send`?** Your
source material's instinct checks out against real numbers: in one
documented case a 17.4 GiB subvolume compressed down to about 13.0 GiB with
zstd — roughly 75% of original size [3]. That's useful, but nowhere near what
incremental send achieves, since an incremental stream of a mostly-unchanged
filesystem can be megabytes instead of gigabytes. Compression on top of the
*stream* (as shown above) still helps — it's not either/or — but compression
alone, without incremental send, still uploads the whole filesystem every
time.

---

## 4. Restoring onto a brand-new machine with a fresh Parrot OS install

This is the scenario you asked about directly: old laptop backed up to Mega,
new laptop bought, fresh Parrot OS installed, now restore.

### Step-by-step

**1. Boot the fresh Parrot install (or a Parrot/Debian live USB) and get root
access.** If you're restoring *over* the fresh install's root subvolume,
doing this from a live USB is safer than restoring while the target subvolume
is your active running root — you generally can't cleanly `btrfs receive` on
top of a mounted, in-use `/`, and a live environment avoids that entirely.

**2. Ensure the destination has a Btrfs filesystem to receive into.** The
fresh Parrot install already created one during setup, assuming you again
choose Btrfs at install time. Mount it:
```bash
sudo mount /dev/mapper/<your-new-luks-mapping> /mnt/target
```

**3. Download and reverse the pipeline for the full/bootstrap backup first:**
```bash
rclone cat mega:parrot-backup/backup_0.zst.enc \
  | openssl enc -d -aes256 -pbkdf2 -pass "pass:YOUR_PASSPHRASE" \
  | zstd -d -c \
  | sudo btrfs receive /mnt/target/
```
This recreates `backup_0` as a real subvolume under `/mnt/target/`.

**4. Download and apply each incremental in order, oldest to newest:**
```bash
rclone cat mega:parrot-backup/backup_1.zst.enc \
  | openssl enc -d -aes256 -pbkdf2 -pass "pass:YOUR_PASSPHRASE" \
  | zstd -d -c \
  | sudo btrfs receive /mnt/target/
```
Repeat for `backup_2`, `backup_3`, etc. **Order matters** — each incremental
stream was generated as a diff from the previous one, so `btrfs receive`
needs them applied in the same sequence they were created. Keeping track of
which snapshot is whose parent (via consistent naming or a manifest file
uploaded alongside the streams) is essential — this is a gap worth designing
into Parrot Blackbox explicitly.

**5. Point the new install at the restored subvolume.** This is the step
that most often trips people up on real forums, and it's not covered by your
source material's plan: restoring a full system via btrfs send/receive onto
new hardware means the new LUKS container UUID must be updated in
`/etc/default/grub` (to boot via GRUB) and `/etc/crypttab` (to unlock with
keyfile), and the new Btrfs filesystem UUID must be updated in `/etc/fstab`
(to mount all subvolumes) [8] — because the received subvolume carries over
old UUIDs and paths baked into config files from the *original* machine, not
the new one. Concretely, after receiving:
```bash
# Get new UUIDs
sudo blkid /dev/mapper/<your-new-luks-mapping>   # btrfs UUID
sudo blkid /dev/nvme0n1p2                         # LUKS container UUID

# Edit these inside the restored subvolume (chroot in, or edit directly):
#   /etc/fstab        — btrfs UUID
#   /etc/crypttab     — LUKS UUID
#   /etc/default/grub — if it references UUIDs directly
```
Then reinstall/regenerate GRUB from inside a chroot into the restored system
(bind-mount `/dev`, `/proc`, `/sys`, `chroot`, run `update-grub` /
`grub-install`), similar to standard "reinstall GRUB after wipe" procedures.

**6. Reboot into the restored system**, and if it boots successfully, treat
that current live-booted state as your new `backup_0` reference for future
incrementals — the parent chain has effectively started over on new
hardware, since the UUIDs changed.

### Simpler alternative if you don't need multi-generation history

If all you actually want is "one full system replica, refreshed
periodically," skip the incremental chain complexity: keep **one**
most-recent full send in the cloud (overwrite it each time or rotate 2–3
copies), sized at your actual used space, and only build the
incremental-chain logic if you specifically want space-efficient *frequent*
backups with rollback to multiple past points, not just "latest good copy."

---

## 5. Storage size: what to actually expect

Based on your system's real numbers from this session:

| Item | Size |
|---|---|
| Actual root filesystem used space | ~51.4 GiB (from `btrfs filesystem df`) |
| Reported free space with no snapshots | ~449–451 GB |
| Per-subvolume breakdown (from `qgroup show`) | `@` (root) 26.2 GiB, `@home` 17.1 GiB, `@swap` 8.0 GiB |

**First (full) backup upload size** ≈ your actual used space, minus swap (you
almost certainly don't want to back up `@swap` at all — it's not meaningful
data, and should be excluded from the send list entirely) ≈ **~43 GiB**
(`@` + `@home`), before compression. With zstd compression in the pipeline,
expect roughly 20–30% size reduction on typical system data (per the
real-world 75%-of-original figure cited above, i.e. ~25% savings) — so
realistically **~32–38 GiB** of actual upload traffic for the first backup,
with encryption overhead being negligible.

**Each subsequent incremental** genuinely depends on how much you change day
to day (installed packages, downloaded files, edited configs). For a
moderately active dev machine, tens to a few hundred MB per day is typical,
occasionally spiking higher after a big `apt upgrade` or when large files
land in `~/Downloads` or `~/Programming`. This matches the general pattern
in your own source material's example table — small deltas accumulating
instead of re-sending the whole system each time.

---

## 6. Upload time estimate to Mega

This is the one number that depends entirely on your actual uplink speed,
which I don't have — but here's how to calculate it, plus the real caveats
about Mega specifically.

**Formula:**
```
upload time (seconds) = file size in bits ÷ actual sustained upload speed in bits/sec
```
Practically: **check your real upload speed first**, don't assume your ISP's
advertised number:
```bash
speedtest-cli   # or: fast --upload
```

**Example calculation** (substitute your real upload speed):
- 35 GiB (≈ 282 Gb) full backup ÷ a 10 Mbps sustained upload ≈ **~7.8 hours**
- Same 35 GiB ÷ a 50 Mbps sustained upload ≈ **~1.6 hours**
- A 300 MB daily incremental ÷ 10 Mbps ≈ **~4 minutes**

**Mega-specific caveats worth knowing before you build around it:**
- Mega does not officially recommend third-party tools like rclone, stating
  they don't fully implement Mega's cryptographic protocols, can't detect
  account quota, and may be bandwidth-limited by Mega as a result [9]. Free
  accounts are widely reported to experience throttled bandwidth well below
  the user's actual connection speed when using such tools.
- In the same discussion, a user reports that rclone's Mega backend creates a
  fresh login session on every invocation rather than reusing one, which
  accumulates sessions until Mega's concurrent-session limit is hit, causing
  further login attempts to be rejected [9] — a real operational failure mode
  if Parrot Blackbox calls rclone very frequently (e.g. hourly, as yours
  currently does) rather than batching.
- Free-tier bandwidth quotas are commonly cited around a few GB per rolling
  24-hour window before further transfers are throttled or blocked — verify
  your specific plan's current limits directly on Mega's own pricing page
  rather than relying on secondhand numbers, since these change over time.
- **Practical implication for your redesign:** if your daemon currently runs
  hourly (as `parrot-blackbox.service` does on your system right now) and
  each run opens a fresh Mega session, you may be creating exactly the
  session-accumulation problem described above. Reducing frequency (e.g. to
  once daily, or only on meaningful change thresholds) and reusing a single
  authenticated session across the run would both reduce upload volume *and*
  sidestep that failure mode.

---

## 7. Why this approach is generally preferred (summary)

1. **Bandwidth**: incremental sends transfer only changed blocks, not the
   whole filesystem — the single biggest win, confirmed by both the Btrfs
   documentation and every real backup tool built on it (Fedora Magazine,
   Oracle docs, btrfs2s3, btrfs2cloud, marc.merlins.org's production script).
2. **Storage**: cloud storage cost/quota scales with what you actually
   upload, so smaller incrementals directly reduce ongoing storage growth
   compared to re-uploading full copies repeatedly.
3. **Fidelity**: because the stream is generated at the filesystem level, it
   preserves permissions, ownership, extended attributes, and Btrfs-specific
   metadata exactly — a plain file copy/zip can lose or mangle some of this
   depending on tooling.
4. **Speed**: the real measured example above showed a full send taking 2
   minutes vs. a few seconds for a subsequent incremental of the same data —
   this compounds enormously over weeks/months of daily backups.
5. **Restorability**: because `btrfs receive` reconstructs actual
   subvolumes, not just files, restoring gives you a bootable filesystem
   structure directly, rather than needing to reconstruct one from a plain
   file dump.

---

## 8. Open design questions for your Parrot Blackbox rewrite

These aren't answered by research — they're decisions specific to your
system and workflow:

- **Retention policy**: keep every incremental forever (grows storage
  indefinitely, but full history), or roll old incrementals into periodic
  new "full" bootstraps and discard the old chain (bounded storage, less
  granular history)? btrfs2s3's yearly/monthly/daily tree model (Section 3)
  is a reasonable template either way.
- **Snapshot-to-cloud-object naming/manifest**: you need a reliable way to
  know which cloud object is the parent of which, especially across restores
  on new hardware where local snapshot names may not match what's in the
  cloud. A small JSON/text manifest uploaded alongside each stream (parent
  name, timestamp, size) solves this cleanly.
- **Excluding `@swap`**: near-certain this subvolume should never be part of
  the backup set at all — it's not meaningful state to restore.
- **Session reuse for Mega specifically**: given the rclone/Mega session
  issue found above, batching your daemon's cloud calls (fewer, larger
  operations) rather than the current hourly cadence is worth prioritizing
  in the rewrite.

---

## Sources

1. [btrfs-send(8) manual page](https://man.cx/btrfs-send(8))
2. [Incremental backups with Btrfs snapshots — Fedora Magazine](https://fedoramagazine.org/btrfs-snapshots-backup-incremental/)
3. [Btrfs send and receive — Forza's Ramblings](https://wiki.tnonline.net/w/Btrfs/Send)
4. [Incremental Backup — btrfs Wiki (kernel.org archive)](https://archive.kernel.org/oldwiki/btrfs.wiki.kernel.org/index.php/Incremental_Backup.html)
5. [Use Btrfs Send and Receive to Create a Secure Remote Backup Facility — Oracle](https://docs.oracle.com/en/learn/ol-btrfs-send/)
6. [btrfs2cloud-backup — GitHub](https://github.com/simone-viozzi/btrfs2cloud-backup)
7. [btrfs2s3 — PyPI](https://pypi.org/project/btrfs2s3/)
8. [Btrfs: Full system backup and restore — Arch Linux Forums](https://bbs.archlinux.org/viewtopic.php?id=289199)
9. [Slow cloud sync [MEGA.nz] — TrueNAS Community](https://www.truenas.com/community/threads/slow-cloud-sync-mega-nz.88024/)
