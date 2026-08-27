/**
 * Fee cache namespace. Report aggregates are cached briefly under this prefix
 * and cleared on every money-touching write, so the student list's own cache
 * never has to be flushed on a payment.
 */
export const FEE_REPORT_CACHE_TTL_SECONDS = 60;

export function feesCachePrefix(schoolId: string): string {
  return `fees:${schoolId}:`;
}

export function feesCacheKey(schoolId: string, variant: unknown): string {
  const v =
    typeof variant === 'string' ? variant : JSON.stringify(variant ?? 'all');
  return `${feesCachePrefix(schoolId)}${v}`;
}
