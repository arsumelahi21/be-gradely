/**
 * The class ladder, in order.
 *
 * The stored value IS the sort key, which is why the numeric grades map to
 * their own number (Grade 5 -> 5) and the pre-primary years take the negative
 * slots below them. That keeps `ORDER BY level` correct without a lookup table.
 *
 * Mirrored on the frontend in `fe-gradely/src/lib/class-level.ts` — keep the two
 * in step; the values are persisted, so never renumber an existing one.
 */
export const CLASS_LEVELS = [
  { value: -3, label: 'PG' },
  { value: -2, label: 'Nursery' },
  { value: -1, label: 'Prep' },
  { value: 1, label: '1' },
  { value: 2, label: '2' },
  { value: 3, label: '3' },
  { value: 4, label: '4' },
  { value: 5, label: '5' },
  { value: 6, label: '6' },
  { value: 7, label: '7' },
  { value: 8, label: '8' },
  { value: 9, label: '9' },
  { value: 10, label: '10' },
] as const;

export const CLASS_LEVEL_VALUES: number[] = CLASS_LEVELS.map((l) => l.value);

/** Ordering shared by every query that lists classes. Unlevelled classes last. */
export const CLASS_LEVEL_ORDER_BY = [
  { level: { sort: 'asc' as const, nulls: 'last' as const } },
  { name: 'asc' as const },
];
