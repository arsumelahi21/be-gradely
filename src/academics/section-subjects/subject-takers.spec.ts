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
interface Placement {
  studentId: string;
  sectionId: string;
  academicYearId: string;
  status: 'ACTIVE' | 'COMPLETED' | 'INACTIVE';
}

const YEAR = 'year-1';
// Sections of one class share a prefix: sec-as-a / sec-as-b are AS; sec-5a is Class 5.
const classOf = (sectionId: string) =>
  sectionId.startsWith('sec-as') ? 'cls-as' : 'cls-5';

function fakeDb(
  offerings: Offering[],
  rows: Row[],
  placements: Placement[] = [],
) {
  let electiveReads = 0;
  const offeringById = new Map(offerings.map((o) => [o.id, o]));
  const db = {
    sectionSubject: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          offerings
            .filter((o) =>
              where.id?.in
                ? where.id.in.includes(o.id)
                : o.sectionId === where.sectionId &&
                  (where.isElective === undefined ||
                    o.isElective === where.isElective),
            )
            .map((o) => ({
              id: o.id,
              isElective: o.isElective,
              sectionId: o.sectionId,
              section: { classGradeId: classOf(o.sectionId) },
            })),
        ),
    },
    studentSubject: {
      findMany: ({ where }: any) => {
        electiveReads += 1;
        return Promise.resolve(
          rows.filter((r) => {
            if (r.academicYearId !== where.academicYearId) return false;
            if (
              where.studentId?.in
                ? !where.studentId.in.includes(r.studentId)
                : r.studentId !== where.studentId
            )
              return false;
            if (where.sectionSubjectId)
              return where.sectionSubjectId.in.includes(r.sectionSubjectId);
            // subjectsOf: any offering in the class of the given section.
            const anchor =
              where.sectionSubject.section.classGrade.sections.some.id;
            const offering = offeringById.get(r.sectionSubjectId);
            return (
              !!offering &&
              classOf(offering.sectionId) === classOf(anchor as string)
            );
          }),
        );
      },
    },
    enrollment: {
      findMany: ({ where }: any) =>
        Promise.resolve(
          placements
            .filter(
              (p) =>
                where.studentId.in.includes(p.studentId) &&
                p.academicYearId === where.academicYearId &&
                where.section.classGradeId.in.includes(classOf(p.sectionId)),
            )
            .map((p) => ({
              ...p,
              section: { classGradeId: classOf(p.sectionId) },
            })),
        ),
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
    { id: 'ss-chem-b', sectionId: 'sec-as-b', isElective: true },
    { id: 'ss-art-5', sectionId: 'sec-5a', isElective: true },
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
  const placed = (studentId: string, sectionId: string): Placement => ({
    studentId,
    sectionId,
    academicYearId: YEAR,
    status: 'ACTIVE',
  });
  const asA = roster.map((id) => placed(id, 'sec-as-a'));

  describe('narrowToTakers', () => {
    it('returns the roster untouched for a compulsory subject', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(
        narrowToTakers(db, 'ss-maths', roster, YEAR),
      ).resolves.toEqual(roster);
    });

    it('returns only the students who chose an elective', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(
        narrowToTakers(db, 'ss-physics', roster, YEAR),
      ).resolves.toEqual(['ali']);
    });

    it('keeps the caller ordering, which is the roster sort order', async () => {
      const { db } = fakeDb(
        offerings,
        [
          ...rows,
          {
            sectionSubjectId: 'ss-physics',
            studentId: 'sara',
            academicYearId: YEAR,
          },
        ],
        asA,
      );
      await expect(
        narrowToTakers(db, 'ss-physics', ['sara', 'ali', 'ahmed'], YEAR),
      ).resolves.toEqual(['sara', 'ali']);
    });

    it('excludes a selection made in another session', async () => {
      const { db } = fakeDb(
        offerings,
        [
          {
            sectionSubjectId: 'ss-physics',
            studentId: 'ahmed',
            academicYearId: 'year-0',
          },
        ],
        asA,
      );
      await expect(
        narrowToTakers(db, 'ss-physics', roster, YEAR),
      ).resolves.toEqual([]);
    });

    it('excludes a taker who is not on the caller roster', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(
        narrowToTakers(db, 'ss-physics', ['ahmed', 'sara'], YEAR),
      ).resolves.toEqual([]);
    });

    it('returns nobody for an unknown subject rather than the whole class', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(
        narrowToTakers(db, 'ss-gone', roster, YEAR),
      ).resolves.toEqual([]);
    });

    it('returns an empty roster unchanged', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(narrowToTakers(db, 'ss-physics', [], YEAR)).resolves.toEqual(
        [],
      );
    });

    it('keeps an elective pick made from a sibling section', async () => {
      const { db } = fakeDb(
        offerings,
        [
          ...rows,
          {
            sectionSubjectId: 'ss-physics',
            studentId: 'omar',
            academicYearId: YEAR,
          },
        ],
        [...asA, placed('omar', 'sec-as-b')],
      );
      await expect(
        narrowToTakers(db, 'ss-physics', [...roster, 'omar'], YEAR),
      ).resolves.toEqual(['ali', 'omar']);
    });
  });

  describe('takersBySubject', () => {
    it('resolves a whole sheet without a query per subject', async () => {
      const { db, electiveReads } = fakeDb(offerings, rows, asA);
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
      const { db, electiveReads } = fakeDb(offerings, rows, asA);
      const takers = await takersBySubject(db, ['ss-maths'], roster, YEAR);
      expect([...(takers.get('ss-maths') ?? [])]).toHaveLength(3);
      expect(electiveReads()).toBe(0);
    });

    it('is empty for no subjects', async () => {
      const { db } = fakeDb(offerings, rows, asA);
      await expect(takersBySubject(db, [], roster, YEAR)).resolves.toEqual(
        new Map(),
      );
    });

    it("leaves a sibling-section student off a compulsory subject they didn't pick", async () => {
      const { db } = fakeDb(offerings, rows, [
        ...asA,
        placed('omar', 'sec-as-b'),
      ]);
      const takers = await takersBySubject(
        db,
        ['ss-maths'],
        [...roster, 'omar'],
        YEAR,
      );
      expect(takers.get('ss-maths')?.has('omar')).toBe(false);
      expect(takers.get('ss-maths')?.size).toBe(3);
    });

    it('puts a sibling-section student on a compulsory subject they picked', async () => {
      const { db } = fakeDb(
        offerings,
        [
          ...rows,
          {
            sectionSubjectId: 'ss-maths',
            studentId: 'omar',
            academicYearId: YEAR,
          },
        ],
        [...asA, placed('omar', 'sec-as-b')],
      );
      const takers = await takersBySubject(
        db,
        ['ss-maths'],
        [...roster, 'omar'],
        YEAR,
      );
      expect(takers.get('ss-maths')?.has('omar')).toBe(true);
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

    it('gives a regular section every compulsory subject', async () => {
      const regular: Offering[] = [
        { id: 'ss-eng', sectionId: 'sec-5a', isElective: false },
        { id: 'ss-sci', sectionId: 'sec-5a', isElective: false },
      ];
      const { db } = fakeDb(regular, []);
      await expect(subjectsOf(db, 'ali', 'sec-5a', YEAR)).resolves.toEqual(
        new Set(['ss-eng', 'ss-sci']),
      );
    });

    it("adds picks from a sibling section, never another class's", async () => {
      const { db } = fakeDb(offerings, [
        ...rows,
        {
          sectionSubjectId: 'ss-chem-b',
          studentId: 'ali',
          academicYearId: YEAR,
        },
        {
          sectionSubjectId: 'ss-art-5',
          studentId: 'ali',
          academicYearId: YEAR,
        },
      ]);
      await expect(subjectsOf(db, 'ali', 'sec-as-a', YEAR)).resolves.toEqual(
        new Set(['ss-maths', 'ss-physics', 'ss-chem-b']),
      );
    });
  });
});
