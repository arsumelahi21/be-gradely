/**
 * The class ladder, in order — a SORT position only. Nothing may branch on it:
 * "O1" places a class after Class 12; it says nothing about its students.
 *
 * The stored value is the sort key. Numbered classes map to their own number
 * (Class 5 -> 5), pre-primary takes the negative slots, and the lettered rungs
 * take gapped blocks above 12 so a rung can be added later without renumbering
 * a persisted value.
 *
 * Mirrored on the frontend in `fe-gradely/src/lib/class-level.ts` — keep the two
 * in step; the values are persisted, so never renumber an existing one.
 */
export const CLASS_LEVELS: { value: number; label: string }[] = [
  { value: -3, label: 'Kindergarten' }, // was "PG": same slot, so existing classes keep their place
  { value: -2, label: 'Nursery' },
  { value: -1, label: 'Prep' },
  ...Array.from({ length: 12 }, (_, i) => ({
    value: i + 1,
    label: `Class ${i + 1}`,
  })),
  { value: 21, label: 'O1' },
  { value: 22, label: 'O2' },
  { value: 23, label: 'O3' },
  { value: 31, label: 'A1' },
  { value: 32, label: 'A2' },
];

export const CLASS_LEVEL_VALUES: number[] = CLASS_LEVELS.map((l) => l.value);

/** Ordering shared by every query that lists classes. Unlevelled classes last. */
export const CLASS_LEVEL_ORDER_BY = [
  { level: { sort: 'asc' as const, nulls: 'last' as const } },
  { name: 'asc' as const },
];
