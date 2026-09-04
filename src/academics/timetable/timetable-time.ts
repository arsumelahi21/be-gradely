/**
 * Pure time helpers for the timetable module — no Prisma, no I/O, no clock.
 * Times are stored as Int minutes-from-midnight (wall-clock in the school's
 * timezone), matching the schema's all-Int convention. Unit-tested like
 * fee-calculator.ts.
 */

export const MINUTES_IN_DAY = 24 * 60;

/** Minutes-from-midnight (0–1440) -> "HH:mm". Throws on out-of-range input. */
export function minToHHMM(min: number): string {
  if (!Number.isInteger(min) || min < 0 || min > MINUTES_IN_DAY) {
    throw new Error(`Invalid minutes-from-midnight: ${min}`);
  }
  const h = Math.floor(min / 60);
  const m = min % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** "HH:mm" -> minutes-from-midnight. Throws on a malformed or out-of-range value. */
export function hhmmToMin(value: string): number {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`Invalid time: ${value}`);
  const h = Number(match[1]);
  const m = Number(match[2]);
  if (h > 23 || m > 59) throw new Error(`Invalid time: ${value}`);
  return h * 60 + m;
}

export interface TimeRange {
  startMin: number;
  endMin: number;
}

/** True when two half-open [start, end) ranges overlap. Touching edges don't. */
export function rangesOverlap(a: TimeRange, b: TimeRange): boolean {
  return a.startMin < b.endMin && b.startMin < a.endMin;
}

/**
 * THE conflict primitive (teacher/section/room): two half-open intervals overlap
 * iff `aStart < bEnd && aEnd > bStart`. Touching edges (10:00–10:45 & 10:45–11:30)
 * do NOT conflict; 10:00–10:45 & 10:30–11:15 do.
 */
export function overlaps(
  aStart: number,
  aEnd: number,
  bStart: number,
  bEnd: number,
): boolean {
  return aStart < bEnd && aEnd > bStart;
}

/**
 * True when a set of ranges has any pairwise overlap. O(n log n): sort by start,
 * then a linear sweep. Zero-length or reversed ranges are treated as invalid by
 * the caller's validation, not here.
 */
export function hasOverlap(ranges: TimeRange[]): boolean {
  const sorted = [...ranges].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMin < sorted[i - 1].endMin) return true;
  }
  return false;
}

export interface GeneratedSlot {
  index: number;
  label: string;
  startMin: number;
  endMin: number;
  kind: 'CLASS' | 'BREAK' | 'LUNCH' | 'ASSEMBLY' | 'FREE';
}

/** A break to insert at a given start time when generating the bell schedule. */
export interface BreakSpec {
  startMin: number;
  durationMin: number;
  label?: string;
  kind?: 'BREAK' | 'LUNCH' | 'ASSEMBLY';
}

/**
 * Generate a day's period slots from a start/end, a per-period duration and a
 * list of breaks. Breaks are placed at their `startMin`; class periods fill the
 * gaps between them until `dayEndMin`. Pure and deterministic — the service
 * persists the result as the source of truth so later manual edits survive.
 */
export function generatePeriodSlots(params: {
  dayStartMin: number;
  dayEndMin: number;
  periodMinutes: number;
  breaks?: BreakSpec[];
}): GeneratedSlot[] {
  const { dayStartMin, dayEndMin, periodMinutes } = params;
  if (dayStartMin >= dayEndMin) {
    throw new Error('dayStartMin must be before dayEndMin');
  }
  if (periodMinutes <= 0) {
    throw new Error('periodMinutes must be positive');
  }
  const breaks = [...(params.breaks ?? [])].sort(
    (a, b) => a.startMin - b.startMin,
  );

  const slots: GeneratedSlot[] = [];
  let cursor = dayStartMin;
  let breakIdx = 0;
  let classCount = 0;

  while (cursor < dayEndMin) {
    const nextBreak = breaks[breakIdx];
    // Emit the break when the cursor reaches it (a class period never straddles a break).
    if (nextBreak && cursor >= nextBreak.startMin) {
      const end = Math.min(
        nextBreak.startMin + nextBreak.durationMin,
        dayEndMin,
      );
      slots.push({
        index: slots.length + 1,
        label: nextBreak.label ?? labelForKind(nextBreak.kind ?? 'BREAK'),
        startMin: nextBreak.startMin,
        endMin: end,
        kind: nextBreak.kind ?? 'BREAK',
      });
      cursor = end;
      breakIdx++;
      continue;
    }

    // A class period stops early if it would run into the next break or day end.
    const cap = nextBreak ? Math.min(nextBreak.startMin, dayEndMin) : dayEndMin;
    const end = Math.min(cursor + periodMinutes, cap);
    if (end <= cursor) {
      // No room before the next boundary — advance to it without a zero-length slot.
      cursor = cap;
      continue;
    }
    classCount++;
    slots.push({
      index: slots.length + 1,
      label: `Period ${classCount}`,
      startMin: cursor,
      endMin: end,
      kind: 'CLASS',
    });
    cursor = end;
  }

  return slots;
}

function labelForKind(kind: 'BREAK' | 'LUNCH' | 'ASSEMBLY'): string {
  if (kind === 'LUNCH') return 'Lunch';
  if (kind === 'ASSEMBLY') return 'Assembly';
  return 'Break';
}

export interface PeriodInput {
  index: number;
  startMin: number;
  endMin: number;
  kind?: string;
}

/**
 * Validate a whole period SET (the bell schedule): each period well-formed and
 * in-day-bounds, indexes unique + 1-based-contiguous, and NO pair overlaps
 * (any kind vs any kind). Returns a list of human-readable errors ([] = valid).
 * Pure — the service turns a non-empty result into a 400.
 */
export function validatePeriodSet(
  periods: PeriodInput[],
  bounds: { dayStartMin: number; dayEndMin: number },
): string[] {
  const errors: string[] = [];
  if (periods.length === 0) return ['At least one period is required'];

  const seenIndex = new Set<number>();
  for (const p of periods) {
    const at = `Period ${p.index}`;
    if (!Number.isInteger(p.index) || p.index < 1) {
      errors.push(`${at}: index must be a positive integer`);
    } else if (seenIndex.has(p.index)) {
      errors.push(`Duplicate period index ${p.index}`);
    } else {
      seenIndex.add(p.index);
    }
    if (
      !Number.isInteger(p.startMin) ||
      !Number.isInteger(p.endMin) ||
      p.startMin < 0 ||
      p.endMin > MINUTES_IN_DAY ||
      p.startMin >= p.endMin
    ) {
      errors.push(`${at}: invalid time range`);
    } else if (p.startMin < bounds.dayStartMin || p.endMin > bounds.dayEndMin) {
      errors.push(`${at}: outside the school day`);
    }
  }

  // Pairwise overlap over ALL periods (breaks included), via a sorted sweep.
  const sorted = [...periods].sort((a, b) => a.startMin - b.startMin);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].startMin < sorted[i - 1].endMin) {
      errors.push(
        `Periods ${sorted[i - 1].index} and ${sorted[i].index} overlap`,
      );
    }
  }
  return errors;
}

/**
 * Per-class-period duration when the admin asks for a fixed NUMBER of periods:
 * (day span − total break time) / periodCount, floored to a whole minute.
 */
export function periodMinutesForCount(
  dayStartMin: number,
  dayEndMin: number,
  breaks: BreakSpec[],
  periodCount: number,
): number {
  if (periodCount <= 0) throw new Error('periodCount must be positive');
  const breakTotal = breaks.reduce((s, b) => s + Math.max(0, b.durationMin), 0);
  const available = dayEndMin - dayStartMin - breakTotal;
  if (available <= 0) {
    throw new Error('No time available for periods after breaks');
  }
  return Math.floor(available / periodCount);
}
