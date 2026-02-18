import type { NotionCacheSnapshot } from '../domain/snapshot.js';

export function buildSnapshotVersion(snapshot: NotionCacheSnapshot): string {
  const updatedAt = snapshot.meta?.updatedAt ?? 'unknown';
  const totalPages =
    Object.keys(snapshot.phase_2_cache?.pages ?? {}).length;

  return `${updatedAt}:${totalPages}`;
}
