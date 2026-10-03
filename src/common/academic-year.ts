type YearSpan = { startDate: Date; endDate: Date };

/**
 * Every year is created active and none is ever cleared, so "newest active" can be a
 * session nobody sits in yet. Mirrors fe `defaultAcademicYear`: the one covering today,
 * else the latest already begun, else the newest. Pass only `isActive` years.
 */
export function pickCurrentAcademicYear<T extends YearSpan>(
  years: T[],
  now: Date,
): T | null {
  const newestFirst = [...years].sort(
    (a, b) => b.startDate.getTime() - a.startDate.getTime(),
  );
  return (
    newestFirst.find((y) => y.startDate <= now && y.endDate >= now) ??
    newestFirst.find((y) => y.startDate <= now) ??
    newestFirst[0] ??
    null
  );
}
