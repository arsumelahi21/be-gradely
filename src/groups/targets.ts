/** What "good" means on the director's overview. Rates are percent, ages are days. */
export interface Targets {
  attendance: number;
  passRate: number;
  collection: number;
  receiptsDays: number;
  resultsDays: number;
}

export const TARGET_DEFAULTS: Targets = {
  attendance: 75,
  passRate: 75,
  collection: 75,
  receiptsDays: 3,
  resultsDays: 14,
};

export const PERCENT_KEYS = ['attendance', 'passRate', 'collection'] as const;
export const DAY_KEYS = ['receiptsDays', 'resultsDays'] as const;
const KEYS = [...PERCENT_KEYS, ...DAY_KEYS];

/** Stored on `SchoolGroup.targets`: a network level and per-branch overrides, each partial. */
export interface StoredTargets {
  network: Partial<Targets>;
  branches: Record<string, Partial<Targets>>;
}

/** Keeps only known keys with whole-number values, so a hand-edited row can't break the overview. */
function pick(value: unknown): Partial<Targets> {
  if (!value || typeof value !== 'object') return {};
  const out: Partial<Targets> = {};
  for (const key of KEYS) {
    const v = (value as Record<string, unknown>)[key];
    if (Number.isInteger(v)) out[key] = v as number;
  }
  return out;
}

export function parseStoredTargets(json: unknown): StoredTargets {
  const raw = (json ?? {}) as { network?: unknown; branches?: unknown };
  const branches: Record<string, Partial<Targets>> = {};
  if (raw.branches && typeof raw.branches === 'object')
    for (const [id, t] of Object.entries(raw.branches)) branches[id] = pick(t);
  return { network: pick(raw.network), branches };
}

export function branchTargets(
  stored: StoredTargets,
  schoolId: string,
): Targets {
  return {
    ...TARGET_DEFAULTS,
    ...stored.network,
    ...stored.branches[schoolId],
  };
}
