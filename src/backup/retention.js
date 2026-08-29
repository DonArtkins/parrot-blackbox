/**
 * Retention: keep only the newest `keep` artifacts (by due date), return the
 * rest for removal. File backups and snapshots share this rule — snapshots are
 * pruned BOTH locally (timeshift delete) and in the cloud in one pass.
 */

/** Newest-first list of artifact ids with the rest marked for removal. */
export function planPrune(ids, keep) {
  if (typeof keep !== 'number' || keep < 1) keep = 3;
  const sorted = [...ids].sort(); // ISO-ish ids sort chronologically
  if (sorted.length <= keep) return { keep: sorted, prune: [] };
  return { keep: sorted.slice(-keep), prune: sorted.slice(0, -keep) };
}

/** Older-than-N-days pruning rule for file backups (kept, prune by date). */
export function pruneOlderThan(artifacts, maxAgeDays) {
  const cutoff = Date.now() - maxAgeDays * 86_400_000;
  return artifacts.filter((a) => {
    const t = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    return t < cutoff;
  });
}