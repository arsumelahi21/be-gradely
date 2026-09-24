import { Prisma } from '@prisma/client';
import { narrowToTakers, subjectsOf, takersBySubject } from './subject-takers';

interface Offering {
  id: string;
  sectionId: string;
  isElective: boolean;
}
interface Row {
  sectionSubjectId: string;
  studentId: string;
  academicYearId: string;
}

const YEAR = 'year-1';

function fakeDb(offerings: Offering[], rows: Row[]) {
  let electiveReads = 0;
  const db = {
    sectionSubject: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          offerings
            .filter((o) =>
              where.id?.in
                ? where.id.in.includes(o.id)
                : o.sectionId === where.sectionId,
            )
            .map((o) => ({ id: o.id, isElective: o.isElective })),
        ),
    },
    studentSubject: {
      findMany: ({ where }: any) => {
        electiveReads += 1;
        return Promise.resolve(
          rows.filter(
            (r) =>
              where.sectionSubjectId.in.includes(r.sectionSubjectId) &&
              r.academicYearId === where.academicYearId &&
              (where.studentId?.in
                ? where.studentId.in.includes(r.studentId)
                : r.studentId === where.studentId),
          ),
        );
      },
    },
  };
  return {
    db: db as unknown as Prisma.TransactionClient,
    electiveReads: () => electiveReads,
  };
}

describe('subject-takers', () => {
  // Maths is taken by the whole class; the rest are chosen per student.
  const offerings: Offering[] = [
    { id: 'ss-maths', sectionId: 'sec-as-a', isElective: false },
    { id: 'ss-physics', sectionId: 'sec-as-a', isElective: true },
    { id: 'ss-economics', sectionId: 'sec-as-a', isElective: true },
    { id: 'ss-biology', sectionId: 'sec-as-a', isElective: true },
  ];
  const rows: Row[] = [
    { sectionSubjectId: 'ss-physics', studentId: 'ali', academicYearId: YEAR },
    {
      sectionSubjectId: 'ss-economics',
      studentId: 'ahmed',
      academicYearId: YEAR,
    },
    { sectionSubjectId: 'ss-biology', studentId: 'sara', academicYearId: YEAR },
  ];
  const roster = ['ali', 'ahmed', 'sara'];

  describe('narrowToTakers', () => {
    it('returns the roster untouched for a compulsory subject', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(
        narrowToTakers(db, 'ss-maths', roster, YEAR),
      ).resolves.toEqual(roster);
    });

    it('returns only the students who chose an elective', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(
        narrowToTakers(db, 'ss-physics', roster, YEAR),
      ).resolves.toEqual(['ali']);
    });

    it('keeps the caller ordering, which is the roster sort order', async () => {
      const { db } = fakeDb(offerings, [
        ...rows,
        {
          sectionSubjectId: 'ss-physics',
          studentId: 'sara',
          academicYearId: YEAR,
        },
      ]);
      await expect(
        narrowToTakers(db, 'ss-physics', ['sara', 'ali', 'ahmed'], YEAR),
      ).resolves.toEqual(['sara', 'ali']);
    });

    it('excludes a selection made in another session', async () => {
      const { db } = fakeDb(offerings, [
        {
          sectionSubjectId: 'ss-physics',
          studentId: 'ahmed',
          academicYearId: 'year-0',
        },
      ]);
      await expect(
        narrowToTakers(db, 'ss-physics', roster, YEAR),
      ).resolves.toEqual([]);
    });

    it('excludes a taker who is not on the caller roster', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(
        narrowToTakers(db, 'ss-physics', ['ahmed', 'sara'], YEAR),
      ).resolves.toEqual([]);
    });

    it('returns nobody for an unknown subject rather than the whole class', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(
        narrowToTakers(db, 'ss-gone', roster, YEAR),
      ).resolves.toEqual([]);
    });

    it('returns an empty roster unchanged', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(narrowToTakers(db, 'ss-physics', [], YEAR)).resolves.toEqual(
        [],
      );
    });
  });

  describe('takersBySubject', () => {
    it('resolves a whole sheet without a query per subject', async () => {
      const { db, electiveReads } = fakeDb(offerings, rows);
      const takers = await takersBySubject(
        db,
        ['ss-maths', 'ss-physics', 'ss-economics', 'ss-biology'],
        roster,
        YEAR,
      );
      expect([...(takers.get('ss-maths') ?? [])].sort()).toEqual([
        'ahmed',
        'ali',
        'sara',
      ]);
      expect([...(takers.get('ss-physics') ?? [])]).toEqual(['ali']);
      expect([...(takers.get('ss-economics') ?? [])]).toEqual(['ahmed']);
      expect([...(takers.get('ss-biology') ?? [])]).toEqual(['sara']);
      expect(electiveReads()).toBe(1);
    });

    it('reads no elective rows for an all-compulsory section', async () => {
      const { db, electiveReads } = fakeDb(offerings, rows);
      const takers = await takersBySubject(db, ['ss-maths'], roster, YEAR);
      expect([...(takers.get('ss-maths') ?? [])]).toHaveLength(3);
      expect(electiveReads()).toBe(0);
    });

    it('is empty for no subjects', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(takersBySubject(db, [], roster, YEAR)).resolves.toEqual(
        new Map(),
      );
    });
  });

  describe('subjectsOf', () => {
    it('gives each student the compulsory subjects plus their own electives', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(subjectsOf(db, 'ali', 'sec-as-a', YEAR)).resolves.toEqual(
        new Set(['ss-maths', 'ss-physics']),
      );
      await expect(subjectsOf(db, 'sara', 'sec-as-a', YEAR)).resolves.toEqual(
        new Set(['ss-maths', 'ss-biology']),
      );
    });

    it('gives a student with no selections just the compulsory subjects', async () => {
      const { db } = fakeDb(offerings, rows);
      await expect(subjectsOf(db, 'hamza', 'sec-as-a', YEAR)).resolves.toEqual(
        new Set(['ss-maths']),
      );
    });

    it('reads no elective rows for a regular section', async () => {
      const regular: Offering[] = [
        { id: 'ss-eng', sectionId: 'sec-5a', isElective: false },
        { id: 'ss-sci', sectionId: 'sec-5a', isElective: false },
      ];
      const { db, electiveReads } = fakeDb(regular, []);
      await expect(subjectsOf(db, 'ali', 'sec-5a', YEAR)).resolves.toEqual(
        new Set(['ss-eng', 'ss-sci']),
      );
      expect(electiveReads()).toBe(0);
    });
  });
});
