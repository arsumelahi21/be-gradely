import { pickCurrentAcademicYear } from './academic-year';

const year = (id: string, start: string, end: string) => ({
  id,
  startDate: new Date(start),
  endDate: new Date(end),
});

describe('pickCurrentAcademicYear', () => {
  const past = year('past', '2025-04-01', '2026-03-31');
  const current = year('current', '2026-04-01', '2027-03-31');
  const future = year('future', '2027-04-01', '2028-03-31');
  const now = new Date('2026-10-08T09:00:00Z');

  it('picks the year covering today, whatever the input order', () => {
    expect(pickCurrentAcademicYear([past, future, current], now)?.id).toBe(
      'current',
    );
  });

  it('falls back to the latest year already begun when none covers today', () => {
    const gap = year('gap', '2025-04-01', '2026-03-31');
    expect(pickCurrentAcademicYear([future, gap], now)?.id).toBe('gap');
  });

  it('falls back to the newest year when none has begun', () => {
    const later = year('later', '2028-04-01', '2029-03-31');
    expect(pickCurrentAcademicYear([future, later], now)?.id).toBe('later');
  });

  it('returns null when there is no year', () => {
    expect(pickCurrentAcademicYear([], now)).toBeNull();
  });

  it('treats the first and last day as inside the year', () => {
    expect(
      pickCurrentAcademicYear([past, current], new Date('2026-04-01'))?.id,
    ).toBe('current');
    expect(
      pickCurrentAcademicYear([past, current], new Date('2027-03-31'))?.id,
    ).toBe('current');
  });
});
