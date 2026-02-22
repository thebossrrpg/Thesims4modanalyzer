export function buildSnapshotVersion(snapshot) {
    const updatedAt = snapshot.meta?.updatedAt ?? 'unknown';
    const totalPages = Object.keys(snapshot.phase_2_cache?.pages ?? {}).length;
    return `${updatedAt}:${totalPages}`;
}
