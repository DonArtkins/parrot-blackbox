# Changelog: V2.0.0 - BTRFS Send/Receive Redesign

## Overview

Major architectural redesign replacing file-level snapshot backups with native BTRFS send/receive streaming for **10-50x efficiency gains** after the initial bootstrap backup.

## What Changed

### Core Architecture

**Before (v1.x):**
- Walked entire snapshot directory tree file-by-file
- Uploaded every file in full every time
- ~35+ GiB per weekly backup
- 2-8 hours upload time per backup

**After (v2.0):**
- Uses `btrfs send` for full (first) or incremental (subsequent) streams
- Pipes through zstd compression (saves ~20-30%)
- Optional AES-256 encryption via openssl
- Streams directly to cloud via `rclone rcat` (no temp files)
- First backup: ~35 GiB (comparable to v2)
- Subsequent backups: **100 MB - 2 GB** (only block-level diffs)
- Upload time: 5-20 minutes for incrementals

### New Features

1. **Incremental Backups**
   - Tracks parent snapshot chains via manifests
   - Only uploads changed blocks, not whole filesystem
   - Automatic parent discovery from local snapshots

2. **Streaming Pipeline**
   - Direct pipe: `btrfs send | zstd | openssl | rclone rcat`
   - No intermediate disk writes
   - Chunked across multiple cloud accounts automatically

3. **Parent Chain Awareness**
   - Restore downloads and applies snapshots in correct order
   - Pruning protects parent snapshots from deletion
   - Manifests record parent references for rebuild

4. **Automatic Fallback**
   - Detects if root filesystem is BTRFS
   - Falls back to v1 file-copy mode gracefully if not
   - Backward compatible with existing v1 backups

5. **UUID Fixup Guidance**
   - Post-restore wizard guides hardware UUID updates
   - Helps with `/etc/fstab`, `/etc/crypttab`, GRUB config

## Files Modified

### New Files
- **src/backup/btrfs-send.js** - Complete BTRFS operations module
  - `hasBtrfs()` - Check for BTRFS tools
  - `isBtrfsFilesystem()` - Detect BTRFS mount
  - `setSubvolumeReadOnly()` - Required for send
  - `findLastUploadedSnapshot()` - Parent discovery
  - `createSendStream()` - Generate send pipe
  - `estimateSendSize()` - Progress estimation
  - `createUploadPipeline()` - Full compression/encryption chain
  - `createRestorePipeline()` - Reverse pipeline for restore

### Updated Files

1. **package.json**
   - Version bumped: `1.0.0` → `2.0.0`

2. **src/core/store.js**
   - Config version: `1` → `2`
   - Added `jobs.snapshots.btrfs` section:
     - `enabled: true` - Use BTRFS mode
     - `incremental: true` - Use parent snapshots
     - `compression: true` - zstd pipeline stage
     - `encryption: false` - openssl pipeline stage
     - `excludeSubvolumes: ['@swap']` - Skip meaningless data
   - Updated `storage.encryptionPassphrase` documentation

3. **src/backup/snapshot.js**
   - `runSnapshotBackup()`: Completely rewritten
     - Checks for BTRFS support via `hasBtrfs()` and `isBtrfsFilesystem()`
     - Discovers parent snapshot via `findLastUploadedSnapshot()`
     - Routes to `uploadViaBtrfsSend()` or `uploadViaFileCopy()`
     - Tracks parent in manifest and state
   - New `uploadViaBtrfsSend()`: Full BTRFS pipeline
     - Sets snapshot read-only
     - Estimates stream size
     - Creates send stream (full or incremental)
     - Builds compression + encryption pipeline
     - Calls `planAndPlaceStream()` for chunked cloud upload
   - New `uploadViaFileCopy()`: Legacy v2 fallback
   - `pruneSnapshots()`: Parent chain aware
     - Builds parent map from manifests
     - Protects any snapshot that's a parent of a kept snapshot
     - Logs protected count for transparency

4. **src/backup/restore.js**
   - `restoreSnapshot()`: Completely rewritten
     - Builds full parent chain via `buildParentChain()`
     - Downloads missing snapshots in order
     - Detects schema v2 (BTRFS stream) vs v1 (file tree)
     - Routes to `restoreBtrfsStream()` or legacy restore
     - Displays UUID fixup guidance post-restore
   - New `buildParentChain()`: Walks manifest parent references
   - New `downloadAndReceiveSnapshot()`: Per-snapshot restore orchestration
   - New `restoreBtrfsStream()`: Reverse pipeline
     - Downloads all chunks sequentially via `rclone cat`
     - Pipes through openssl decrypt (if encrypted)
     - Pipes through zstd decompress (if compressed)
     - Pipes into `btrfs receive` at Timeshift base
   - `placeIntoTimeshift()`: Now handles both v2 streams and v1 file trees

5. **src/cli.js**
   - `_internal_upload` command: Rewritten
     - Reads config `jobs.snapshots.btrfs` settings
     - Checks `hasBtrfs()` and `isBtrfsFilesystem()`
     - Builds proper sudo pipeline: `sudo -n btrfs send ...`
     - Respects config flags: compression, encryption
     - Falls back to `planAndPlace()` if BTRFS unavailable

6. **src/storage/allocator.js**
   - `planAndPlaceStream()`: Already existed, no changes needed
   - Verified: Correctly handles streaming, chunking, manifest schema v2

7. **README.md**
   - Added "🚀 What's New in V3.0" section
     - How it works (bootstrap + incremental diagrams)
     - Comparison table (v2 vs v3)
     - Real-world size examples
     - Requirements checklist
     - Automatic fallback explanation
   - Updated main feature list (#7: V3.0 BTRFS streaming)
   - Added "Upgrading from V2.x to V3.0" section
     - Backward compatibility
     - First backup behavior
     - Optional encryption setup
     - Mixing v2/v3 backups

## Manifest Schema Changes

### V1 Schema (v1.x file-tree backups)
```json
{
  "schema": 1,
  "kind": "snapshots",
  "id": "2026-09-03_22-00-01",
  "createdAt": "2026-09-03T22:00:01Z",
  "totalSize": 37580963840,
  "remoteRoot": "parrot-blackbox",
  "entries": [
    {"rel": "etc/passwd", "type": "file", "size": 2048, "loc": [...]},
    ...
  ]
}
```

### V2 Schema (v2.0 BTRFS streams)
```json
{
  "schema": 2,
  "kind": "snapshots",
  "id": "2026-09-03_22-00-01",
  "parent": "2026-08-27_22-00-01",  // NEW: parent for incremental chain
  "createdAt": "2026-09-03T22:00:01Z",
  "totalSize": 524288000,  // Compressed + (optionally) encrypted stream size
  "originalSize": 37580963840,  // NEW: Estimated uncompressed size
  "remoteRoot": "parrot-blackbox",
  "entries": [
    {
      "rel": "btrfs.stream",  // NEW: Single stream file
      "type": "file",
      "size": 524288000,
      "split": true,
      "loc": [
        {"remote": "mega-1", "path": "parrot-blackbox/snapshots/.../btrfs.stream.part-0000", "start": 0, "end": 2147483648, "size": 2147483648},
        {"remote": "mega-2", "path": "parrot-blackbox/snapshots/.../btrfs.stream.part-0001", "start": 2147483648, "end": 524288000, "size": ...}
      ]
    }
  ]
}
```

## Backward Compatibility

- **V1 manifests**: Still restorable via legacy file-tree path
- **V2 manifests**: Use new BTRFS receive pipeline
- **Detection**: Automatic based on `schema` and `entries[].rel === 'btrfs.stream'`
- **Mixing**: Both can coexist in the same cloud pool

## Migration Path

1. **Automatic on upgrade:**
   - First snapshot after v2.0 install: full BTRFS send (~35 GiB)
   - Config gains new `btrfs` section with safe defaults
   - Old v1 snapshots remain untouched

2. **Optional encryption:**
   - Edit `~/.config/parrot-blackbox/config.json`
   - Set `jobs.snapshots.btrfs.encryption = true`
   - Set `storage.encryptionPassphrase = "..."`
   - Next backup uses encryption

3. **Non-BTRFS systems:**
   - Automatically fall back to v1 file-copy
   - No manual intervention needed
   - No loss of functionality

## Testing Status

**Status:** Core implementation complete, tests pending (task #13)

**Manual testing recommended:**
1. Fresh BTRFS system: `parrot-blackbox snapshot now` (should use BTRFS send)
2. Non-BTRFS system: Verify fallback to file-copy
3. Incremental: Run twice, verify second is smaller
4. Restore: Full chain restore onto fresh system
5. UUID fixup: Follow post-restore guidance

**Automated testing TODO:**
- Mock `btrfs` command responses
- Mock `rclone` streaming behaviors
- Verify parent chain discovery
- Verify manifest schema v2 structure
- Test pruning with parent protection

## Known Limitations

1. **First backup is still full:** Incremental benefits only appear from backup #2 onward
2. **Requires BTRFS root:** Most Parrot installs since 2022, but older systems fall back
3. **Parent chain coupling:** Pruning must protect parent snapshots (already implemented)
4. **Hardware restore needs UUID fixup:** Documented in wizard output

## Performance Expectations

Based on research and typical Parrot OS installation:

| Metric | First Backup | Incremental |
|--------|--------------|-------------|
| Raw size | ~51 GiB (root + home) | N/A |
| Compressed | ~35-40 GiB | 100 MB - 2 GB |
| Upload time (10 Mbps) | ~8 hours | ~5-20 minutes |
| Upload time (50 Mbps) | ~1.6 hours | ~1-4 minutes |

## References

- Research document: `research/research-btrfs-send-receive-backups.md`
- BTRFS send/receive docs: `man btrfs-send`, Fedora Magazine, Oracle docs
- Similar tools: btrbk, snapper, btrfs2s3, btrfs2cloud-backup
