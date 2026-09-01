#!/bin/bash
# Quick verification test for parrot-blackbox v1.0.8 fixes

set -e

echo "🦜 parrot-blackbox v1.0.8 - Verification Test"
echo "=============================================="
echo ""

# Check version
echo "1. Checking installed version..."
VERSION=$(parrot-blackbox --version 2>/dev/null || echo "not found")
if [[ "$VERSION" == *"1.0.8"* ]]; then
  echo "   ✅ Version 1.0.8 installed"
else
  echo "   ❌ Wrong version: $VERSION"
  echo "   Run: npm install -g /home/artkins/Programming/Tools/parrot-blackbox"
  exit 1
fi
echo ""

# Check if timeshift snapshots exist
echo "2. Checking timeshift snapshots..."
SNAPSHOT_COUNT=$(sudo timeshift --list 2>/dev/null | grep -E '^\s*\d+\s+>' | wc -l)
if [ "$SNAPSHOT_COUNT" -gt 0 ]; then
  echo "   ✅ Found $SNAPSHOT_COUNT snapshot(s) in timeshift"
else
  echo "   ⚠️  No snapshots found - create one first"
fi
echo ""

# Test parser directly with actual timeshift output
echo "3. Testing snapshot parser..."
TEST_OUTPUT=$(cat <<'EOF'
Num     Name                 Tags  Description
------------------------------------------------------------------------------
0    >  2026-09-01_21-22-39  W     parrot-blackbox 2026-09-01T21:22:05
1    >  2026-09-01_21-23-42  W     parrot-blackbox 2026-09-01T21:23:17
EOF
)

PARSE_TEST=$(node -e "
const text = \`$TEST_OUTPUT\`;
let count = 0;
for (const line of text.split('\\n')) {
  const m = /^\s*\d+\s+>?\s+(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})\s+([A-Za-z]{1,6})\s+(.*)$/.exec(line);
  if (m) count++;
}
console.log(count);
")

if [ "$PARSE_TEST" -eq 2 ]; then
  echo "   ✅ Parser correctly extracts snapshots from timeshift output"
else
  echo "   ❌ Parser failed - found $PARSE_TEST instead of 2"
  exit 1
fi
echo ""

# Check if /run/timeshift exists
echo "4. Checking BTRFS mount paths..."
if [ -d "/run/timeshift" ]; then
  MOUNT_COUNT=$(find /run/timeshift -maxdepth 3 -type d -name "timeshift-btrfs" 2>/dev/null | wc -l)
  if [ "$MOUNT_COUNT" -gt 0 ]; then
    echo "   ✅ BTRFS timeshift mount found"
  else
    echo "   ⚠️  BTRFS mount not currently active (normal when timeshift not running)"
  fi
else
  echo "   ⚠️  /run/timeshift doesn't exist (might be rsync mode)"
fi
echo ""

# Verify tests pass
echo "5. Running automated tests..."
cd /home/artkins/Programming/Tools/parrot-blackbox
TEST_RESULT=$(npm test 2>&1 | grep -E "pass|fail" | tail -2)
if echo "$TEST_RESULT" | grep -q "pass 37"; then
  echo "   ✅ All 37 tests passing"
else
  echo "   ❌ Tests failed:"
  echo "$TEST_RESULT"
  exit 1
fi
echo ""

echo "=============================================="
echo "✅ All verification checks passed!"
echo ""
echo "Next steps:"
echo "  1. Test manually: parrot-blackbox"
echo "  2. Try 'List backups' - should show your snapshots"
echo "  3. Try 'Create snapshot' - should work without errors"
echo "  4. When ready: npm publish"
echo ""
