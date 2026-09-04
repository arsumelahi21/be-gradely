import {
  minToHHMM,
  hhmmToMin,
  rangesOverlap,
  hasOverlap,
  overlaps,
  validatePeriodSet,
  periodMinutesForCount,
  generatePeriodSlots,
} from './timetable-time';

describe('timetable-time', () => {
  describe('minToHHMM', () => {
    it('formats minutes-from-midnight', () => {
      expect(minToHHMM(0)).toBe('00:00');
      expect(minToHHMM(480)).toBe('08:00');
      expect(minToHHMM(545)).toBe('09:05');
      expect(minToHHMM(1439)).toBe('23:59');
      expect(minToHHMM(1440)).toBe('24:00');
    });
    it('rejects out-of-range', () => {
      expect(() => minToHHMM(-1)).toThrow();
      expect(() => minToHHMM(1441)).toThrow();
      expect(() => minToHHMM(1.5)).toThrow();
    });
  });

  describe('hhmmToMin', () => {
    it('parses HH:mm', () => {
      expect(hhmmToMin('00:00')).toBe(0);
      expect(hhmmToMin('08:00')).toBe(480);
      expect(hhmmToMin('9:05')).toBe(545);
      expect(hhmmToMin(' 23:59 ')).toBe(1439);
    });
    it('round-trips with minToHHMM', () => {
      for (const m of [0, 60, 480, 725, 1439]) {
        expect(hhmmToMin(minToHHMM(m))).toBe(m);
      }
    });
    it('rejects malformed', () => {
      expect(() => hhmmToMin('8')).toThrow();
      expect(() => hhmmToMin('24:70')).toThrow();
      expect(() => hhmmToMin('ab:cd')).toThrow();
    });
  });

  describe('rangesOverlap / hasOverlap', () => {
    it('touching edges do not overlap (half-open)', () => {
      expect(
        rangesOverlap(
          { startMin: 480, endMin: 525 },
          { startMin: 525, endMin: 570 },
        ),
      ).toBe(false);
    });
    it('detects a real overlap', () => {
      expect(
        rangesOverlap(
          { startMin: 480, endMin: 530 },
          { startMin: 525, endMin: 570 },
        ),
      ).toBe(true);
    });
    it('hasOverlap over a set', () => {
      expect(
        hasOverlap([
          { startMin: 480, endMin: 525 },
          { startMin: 525, endMin: 570 },
          { startMin: 570, endMin: 615 },
        ]),
      ).toBe(false);
      expect(
        hasOverlap([
          { startMin: 480, endMin: 525 },
          { startMin: 520, endMin: 570 },
        ]),
      ).toBe(true);
    });
  });

  describe('generatePeriodSlots', () => {
    it('fills a day with equal periods when no breaks', () => {
      const slots = generatePeriodSlots({
        dayStartMin: 480,
        dayEndMin: 480 + 45 * 4,
        periodMinutes: 45,
      });
      expect(slots).toHaveLength(4);
      expect(slots[0]).toMatchObject({
        index: 1,
        startMin: 480,
        endMin: 525,
        kind: 'CLASS',
      });
      expect(slots[3]).toMatchObject({ index: 4, endMin: 660 });
      expect(slots.every((s) => s.kind === 'CLASS')).toBe(true);
    });

    it('inserts a break and resumes class periods after it', () => {
      const slots = generatePeriodSlots({
        dayStartMin: 480, // 08:00
        dayEndMin: 690, // 11:30
        periodMinutes: 45,
        breaks: [{ startMin: 570, durationMin: 15, kind: 'BREAK' }], // 09:30
      });
      // 08:00-08:45, 08:45-09:30, [break 09:30-09:45], 09:45-10:30, 10:30-11:15, 11:15-11:30
      const kinds = slots.map((s) => s.kind);
      expect(kinds).toContain('BREAK');
      const brk = slots.find((s) => s.kind === 'BREAK')!;
      expect(brk).toMatchObject({ startMin: 570, endMin: 585 });
      // indexes are contiguous and 1-based
      expect(slots.map((s) => s.index)).toEqual(slots.map((_, i) => i + 1));
      // no overlaps
      expect(
        hasOverlap(
          slots.map((s) => ({ startMin: s.startMin, endMin: s.endMin })),
        ),
      ).toBe(false);
    });

    it('never emits a zero-length trailing slot', () => {
      const slots = generatePeriodSlots({
        dayStartMin: 480,
        dayEndMin: 570, // exactly 2 x 45
        periodMinutes: 45,
      });
      expect(slots).toHaveLength(2);
      expect(slots.every((s) => s.endMin > s.startMin)).toBe(true);
    });

    it('caps the last period at dayEndMin', () => {
      const slots = generatePeriodSlots({
        dayStartMin: 480,
        dayEndMin: 600, // 120 min => 45 + 45 + 30
        periodMinutes: 45,
      });
      expect(slots).toHaveLength(3);
      expect(slots[2]).toMatchObject({ startMin: 570, endMin: 600 });
    });

    it('rejects an inverted day', () => {
      expect(() =>
        generatePeriodSlots({
          dayStartMin: 600,
          dayEndMin: 480,
          periodMinutes: 45,
        }),
      ).toThrow();
    });
  });

  describe('overlaps (the conflict primitive)', () => {
    it('touching edges do NOT conflict', () => {
      // 10:00–10:45 vs 10:45–11:30
      expect(overlaps(600, 645, 645, 690)).toBe(false);
    });
    it('real overlap conflicts (the critical case)', () => {
      // 10:00–10:45 vs 10:30–11:15
      expect(overlaps(600, 645, 630, 675)).toBe(true);
    });
    it('containment conflicts', () => {
      expect(overlaps(600, 700, 620, 640)).toBe(true);
    });
    it('disjoint does not conflict', () => {
      expect(overlaps(600, 645, 700, 745)).toBe(false);
    });
  });

  describe('validatePeriodSet', () => {
    const bounds = { dayStartMin: 480, dayEndMin: 690 };
    it('accepts a clean contiguous set', () => {
      expect(
        validatePeriodSet(
          [
            { index: 1, startMin: 480, endMin: 525 },
            { index: 2, startMin: 525, endMin: 570 },
            { index: 3, startMin: 570, endMin: 615 },
          ],
          bounds,
        ),
      ).toEqual([]);
    });
    it('flags an overlap', () => {
      const errs = validatePeriodSet(
        [
          { index: 1, startMin: 480, endMin: 530 },
          { index: 2, startMin: 525, endMin: 570 },
        ],
        bounds,
      );
      expect(errs.some((e) => /overlap/i.test(e))).toBe(true);
    });
    it('flags out-of-bounds and inverted ranges and dup index', () => {
      expect(
        validatePeriodSet([{ index: 1, startMin: 400, endMin: 470 }], bounds)
          .length,
      ).toBeGreaterThan(0); // before dayStart
      expect(
        validatePeriodSet([{ index: 1, startMin: 600, endMin: 500 }], bounds)
          .length,
      ).toBeGreaterThan(0); // inverted
      expect(
        validatePeriodSet(
          [
            { index: 1, startMin: 480, endMin: 525 },
            { index: 1, startMin: 525, endMin: 570 },
          ],
          bounds,
        ).some((e) => /Duplicate/.test(e)),
      ).toBe(true);
    });
    it('rejects an empty set', () => {
      expect(validatePeriodSet([], bounds).length).toBe(1);
    });
  });

  describe('periodMinutesForCount', () => {
    it('divides the day (minus breaks) by the count', () => {
      // 08:00–11:30 = 210 min, minus a 15-min break = 195, / 5 = 39
      expect(
        periodMinutesForCount(480, 690, [{ startMin: 570, durationMin: 15 }], 5),
      ).toBe(39);
    });
    it('throws when no time remains', () => {
      expect(() =>
        periodMinutesForCount(480, 500, [{ startMin: 480, durationMin: 30 }], 4),
      ).toThrow();
    });
  });
});
