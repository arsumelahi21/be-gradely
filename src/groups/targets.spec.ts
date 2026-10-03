import { TARGET_DEFAULTS, branchTargets, parseStoredTargets } from './targets';

describe('targets', () => {
  it('layers branch over network over defaults', () => {
    const stored = parseStoredTargets({
      network: { attendance: 90, resultsDays: 7 },
      branches: { b1: { attendance: 80 } },
    });
    expect(branchTargets(stored, 'b1')).toEqual({
      ...TARGET_DEFAULTS,
      attendance: 80,
      resultsDays: 7,
    });
    expect(branchTargets(stored, 'b2')).toEqual({
      ...TARGET_DEFAULTS,
      attendance: 90,
      resultsDays: 7,
    });
  });

  it('ignores a missing row and anything that is not a known whole number', () => {
    expect(parseStoredTargets(null)).toEqual({ network: {}, branches: {} });
    expect(
      parseStoredTargets({
        network: { attendance: '90', passRate: 1.5, evil: 1, collection: 60 },
        branches: 'x',
      }),
    ).toEqual({ network: { collection: 60 }, branches: {} });
  });
});
