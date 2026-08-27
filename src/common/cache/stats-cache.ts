import { CacheService } from '../services/cache.service';

/**
 * Exact (non-variant) cache keys for dashboard overview + 3 of 4 stat aggregates
 * — deleted with `del()`, no keyspace scan. (`schoolStatsPrefixes` covers the 4th.)
 */
export function schoolStatsExactKeys(schoolId: string): string[] {
  return [
    `dashboard:overview:${schoolId}`,
    `dashboard:stats:${schoolId}`,
    `exams:school-stats:${schoolId}`,
    `assignments:school-stats:${schoolId}`,
  ];
}

/**
 * Variant-keyed stat caches needing prefix deletion — only attendance summary,
 * whose key appends `:{from}:{to}`, so all windowed variants clear together.
 */
export function schoolStatsPrefixes(schoolId: string): string[] {
  return [`attendance:school-summary:${schoolId}:`];
}

/**
 * Clears the cached dashboard overview + stat aggregates for a school. Call
 * AFTER the write's `$transaction` commits — clearing mid-transaction lets a concurrent read re-cache stale data.
 */
export async function invalidateSchoolStats(
  cache: CacheService | undefined | null,
  schoolId: string | null | undefined,
): Promise<void> {
  if (!cache || !schoolId) return;
  await Promise.all([
    cache.del(...schoolStatsExactKeys(schoolId)),
    cache.delByPrefixes(...schoolStatsPrefixes(schoolId)),
  ]);
}
