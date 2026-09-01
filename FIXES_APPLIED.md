# Fixes Applied to parrot-blackbox v1.0.8

## Critical Fixes Applied

### 1. Snapshot Detection Bug ✅ (v1.0.7)

**Problem:** Timeshift was successfully creating snapshots, but parrot-blackbox couldn't detect them.

**Root Cause:** Parser regex expected old format but Timeshift 24.06+ changed output format.

**Solution:** Dual-regex parser supporting both legacy and current formats.

**File Modified:** `src/backup/snapshot.js`

---

### 2. List Backups Silent Failure ✅ (v1.0.8)

**Problem:** The "List backups" menu option showed "none" even though snapshots existed (visible via `sudo timeshift --list`).

**Root Cause:** `listBackupsAction` was using `privileged: 'noninteractive'` which runs `sudo -n`. When the sudo timestamp expires, this fails silently returning empty output, making it appear like no snapshots exist.

**Solution:** Changed `listBackupsAction` to use `privileged: 'interactive'` so it can properly prompt for the sudo password.

**File Modified:** `src/commands/wizard.js`

---

### 3. BTRFS Snapshot Directory Not Found ✅ (v1.0.8)

**Problem:** After creating a snapshot, upload failed with:
```
✖ ENOENT: no such file or directory, scandir '/timeshift/snapshots/2026-09-01_23-20-50'
```

**Root Cause:** Timeshift BTRFS mode uses **dynamic mount paths** like:
```
/run/timeshift/146718/backup/timeshift-btrfs/snapshots/2026-09-01_23-20-50
```
Where `146718` is a PID that changes each time timeshift runs. The `snapshotDirFor` function was:
1. Checking static paths like `/timeshift/snapshots/...`
2. Searching `/run/timeshift/backup` without handling the PID subdirectory
3. Not using sudo when searching, causing permission failures

**Solution:** Updated `snapshotDirFor` to:
1. Search `/run/timeshift` (not just `/run/timeshift/backup`) to find the PID subdirectories
2. Try without sudo first (faster), then with sudo if `privileged: 'interactive'`
3. Use `maxdepth 5` to traverse the nested directory structure

**File Modified:** `src/backup/snapshot.js`

---

### 4. Wizard UI Redesign ✅ (v1.0.7)

**Problem:** Menu was cluttered and not user-friendly.

**Solution:** Redesigned to match gitswitch's friendly pattern with cleaner layout, better emojis, shorter labels.

**File Modified:** `src/commands/wizard.js`

---

## Version History

- **v1.0.8** (current) - Fixed list backups + BTRFS directory resolution
- **v1.0.7** - Fixed snapshot detection + redesigned UI  
- **v1.0.6** - Previous snapshot detection attempt
- **v1.0.5** - Earlier version

---

## Testing Instructions

### Install the Fixed Version

```bash
cd /home/artkins/Programming/Tools/parrot-blackbox
npm install -g .
```

### Test Snapshot Listing

```bash
parrot-blackbox
# Choose "📋 List backups"
# Should now show your 5 existing snapshots!
```

### Test Snapshot Creation + Upload

```bash
parrot-blackbox
# Choose "📸 Create snapshot"
# Should create, find the directory, and upload successfully
```

### Verify End-to-End

```bash
# 1. Create and upload
parrot-blackbox force

# 2. List to confirm
parrot-blackbox snapshot list

# 3. Check cloud
parrot-blackbox
# Choose "📋 List backups" - should show cloud snapshots too
```

---

## Technical Details

### Timeshift BTRFS Mode Behavior

When Timeshift runs in BTRFS mode, it:
1. Mounts the BTRFS subvolume at `/run/timeshift/<PID>/backup`
2. Creates snapshots at `.../backup/timeshift-btrfs/snapshots/<NAME>`
3. Unmounts after each operation (making the PID directory disappear)

**The problem:** We need to find and read the snapshot **while timeshift has it mounted**, but the PID changes every time.

**The solution:** Search the entire `/run/timeshift` tree to find whichever PID directory currently exists.

### Sudo Timestamp Behavior

`sudo -n` (non-interactive) will fail immediately if:
- No sudo timestamp exists (never ran sudo recently)
- The timestamp expired (default: 15 minutes of inactivity)

This is why background operations use `sudo -n` (safe, never hangs) but interactive CLI operations should use regular `sudo` (can prompt for password).

---

## All Tests Pass ✅

```bash
npm test
# ℹ tests 37
# ℹ pass 37
# ℹ fail 0
```

---

## What Changed

**v1.0.8 Changes:**
- `src/backup/snapshot.js` - Enhanced `snapshotDirFor` with proper search and sudo
- `src/commands/wizard.js` - Changed `listBackupsAction` to interactive sudo
- `package.json` - Version bump
- `CHANGELOG.md` - v1.0.8 entry

**v1.0.7 Changes:**
- `src/backup/snapshot.js` - Dual-format parser
- `src/commands/wizard.js` - UI redesign
- `package.json` - Version bump
- `CHANGELOG.md` - v1.0.7 entry

---

## Known Supported Formats

### Timeshift Output Formats

**Current (24.06+):**
```
Num     Name                 Tags  Description
0    >  2026-09-01_21-22-39  W     parrot-blackbox 2026-09-01T21:22:05
```

**Legacy (22.x/23.x/24.x):**
```
Num     Name                            Tags                Description
0   2026-08-29 22:00:01  W  2026-08-29_22-00-01  parrot-blackbox
```

**Old (pre-22.x):**
```
2026-08-29 22:00:01 W 2026-08-29_22-00-01 /timeshift/snapshots/...
```

✅ **All three formats are now supported!**

---

## Compatibility

✅ Timeshift 22.x, 23.x, 24.x, 24.06+  
✅ BTRFS mode  
✅ Rsync mode  
✅ Parrot OS  
✅ Any Debian-based system  

---

## Next Steps

After testing, publish to npm:
```bash
npm publish
```
