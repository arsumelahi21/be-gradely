import { Injectable, BadRequestException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Actor } from '../common/types/actor.type';
import { Role } from '../common/types/role.type';

/**
 * Advanced global search for admins: understands grade/section/subject/role tokens
 * (e.g. "grade 8 a teacher"), not just name/email LIKE. Tenant-scoped to one school.
 *
 * ponytail: token-subset matcher over the school's grades/sections/subjects (a
 * few dozen rows), not an NLP engine. Upgrade to a real parser / trigram index
 * only if a school's taxonomy or volume makes this the bottleneck.
 */

const ROLE_WORDS: Record<string, Role> = {
  teacher: Role.TEACHER,
  teachers: Role.TEACHER,
  tch: Role.TEACHER,
  faculty: Role.TEACHER,
  staff: Role.TEACHER,
  student: Role.STUDENT,
  students: Role.STUDENT,
  std: Role.STUDENT,
  pupil: Role.STUDENT,
  pupils: Role.STUDENT,
  parent: Role.PARENT,
  parents: Role.PARENT,
  guardian: Role.PARENT,
  guardians: Role.PARENT,
  par: Role.PARENT,
  admin: Role.SCHOOL_ADMIN,
  admins: Role.SCHOOL_ADMIN,
  administrator: Role.SCHOOL_ADMIN,
};
const GRADE_WORDS = new Set([
  'grade',
  'grades',
  'class',
  'classes',
  'std',
  'standard',
  'year',
]);
const SECTION_WORDS = new Set(['section', 'sections', 'sec']);
const NOISE = new Set(['the', 'of', 'in', 'for', 'and', 'all', 'a', 'an']);

/** Lowercase; split on non-alphanumerics; also split "8a"→"8","a", "grade8"→"grade","8". */
function tokenize(s: string): string[] {
  const base = (s || '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const out: string[] = [];
  for (const t of base) {
    out.push(t);
    const parts = t.match(/[a-z]+|[0-9]+/g);
    if (parts && parts.length > 1) out.push(...parts);
  }
  return [...new Set(out)];
}

type Taxon = { id: string; name: string; code?: string | null };

@Injectable()
export class SearchService {
  constructor(private readonly prisma: PrismaService) {}

  async globalSearch(actor: Actor, rawQuery: string, schoolIdParam?: string) {
    const q = (rawQuery ?? '').trim();
    if (q.length < 1) {
      return { interpreted: {}, results: [], total: 0 };
    }
    const isAdminRole =
      actor.role === Role.SCHOOL_ADMIN || actor.role === Role.SUPER_ADMIN;
    const schoolId =
      actor.role === Role.SUPER_ADMIN ? schoolIdParam : actor.schoolId;
    if (!schoolId) {
      throw new BadRequestException('No school context for search');
    }

    // Non-admins only ever search within the sections they can access.
    const accessibleSectionIds = isAdminRole
      ? null
      : await this.actorSectionIds(actor);

    const tokens = tokenize(q);
    const tokenSet = new Set(tokens);
    const consumed = new Set<string>();

    let roleFilter: Role | null = null;
    for (const t of tokens) {
      if (ROLE_WORDS[t]) {
        roleFilter = ROLE_WORDS[t];
        consumed.add(t);
      }
    }
    for (const t of tokens) {
      if (GRADE_WORDS.has(t) || SECTION_WORDS.has(t) || NOISE.has(t)) {
        consumed.add(t);
      }
    }

    // School taxonomy, scoped to the actor's accessible sections for non-admins.

    let [grades, sections, subjects] = await Promise.all([
      this.prisma.classGrade.findMany({
        where: { schoolId },
        select: { id: true, name: true, code: true },
      }),
      this.prisma.section.findMany({
        where: { schoolId },
        select: { id: true, name: true, classGradeId: true },
      }),
      this.prisma.subject.findMany({
        where: { schoolId },
        select: { id: true, name: true, code: true },
      }),
    ]);
    if (accessibleSectionIds !== null) {
      const acc = new Set(accessibleSectionIds);
      sections = sections.filter((s) => acc.has(s.id));
      const gradeIds = new Set(sections.map((s) => s.classGradeId));
      grades = grades.filter((g) => gradeIds.has(g.id));
      if (accessibleSectionIds.length) {
        const ss = await this.prisma.sectionSubject.findMany({
          where: { sectionId: { in: accessibleSectionIds } },
          select: { subjectId: true },
        });
        const subjIds = new Set(ss.map((x) => x.subjectId));
        subjects = subjects.filter((su) => subjIds.has(su.id));
      } else {
        subjects = [];
      }
    }

    // Resolve grade → section (within grade) → subject over the scoped taxonomy.
    const grade = this.resolveTaxon(grades, tokenSet, GRADE_WORDS);
    if (grade) {
      this.consumeTaxon(grade, GRADE_WORDS, tokenSet, consumed);
    }
    let section: (Taxon & { classGradeId: string }) | null = null;
    if (grade) {
      const inGrade = sections.filter((s) => s.classGradeId === grade.id);
      const match = this.resolveTaxon(inGrade, tokenSet, SECTION_WORDS);
      if (match) {
        section = inGrade.find((s) => s.id === match.id)!;
        this.consumeTaxon(match, SECTION_WORDS, tokenSet, consumed);
      }
    }
    const freeTokens = tokens.filter((t) => !consumed.has(t));
    const subject = this.resolveSubject(subjects, freeTokens);
    if (subject) {
      for (const t of tokenize(`${subject.name} ${subject.code ?? ''}`)) {
        consumed.add(t);
      }
    }
    const freeText = tokens
      .filter((t) => !consumed.has(t))
      .join(' ')
      .trim();

    // Which sections define the population (intersected with accessible).
    let targetSectionIds: string[] | null = null;
    if (section) targetSectionIds = [section.id];
    else if (grade) {
      targetSectionIds = sections
        .filter((s) => s.classGradeId === grade.id)
        .map((s) => s.id);
    } else if (subject) {
      const ss = await this.prisma.sectionSubject.findMany({
        where: { subjectId: subject.id },
        select: { sectionId: true },
      });
      targetSectionIds = [...new Set(ss.map((x) => x.sectionId))];
    }
    if (targetSectionIds && accessibleSectionIds !== null) {
      const acc = new Set(accessibleSectionIds);
      targetSectionIds = targetSectionIds.filter((id) => acc.has(id));
    }

    let users: ResultUser[];
    if (targetSectionIds) {
      users = await this.populationInSections(
        actor,
        targetSectionIds,
        roleFilter,
        subject?.id ?? null,
      );
      if (freeText) {
        const f = freeText.toLowerCase();
        users = users.filter((u) => userMatchesText(u, f));
      }
    } else if (isAdminRole) {
      users = await this.freeTextUsers(schoolId, freeText || q, roleFilter);
    } else {
      // Name search over the actor's accessible people + the school office.
      const pop = await this.populationInSections(
        actor,
        accessibleSectionIds ?? [],
        roleFilter,
        null,
      );
      const admins =
        !roleFilter || roleFilter === Role.SCHOOL_ADMIN
          ? await this.schoolAdmins(schoolId, actor.userId)
          : [];
      const dedup = new Map<string, ResultUser>();
      for (const u of [...pop, ...admins]) dedup.set(u.id, u);
      const f = (freeText || q).toLowerCase();
      users = [...dedup.values()].filter((u) => userMatchesText(u, f));
    }

    const total = users.length;
    const entities = this.entityResults(grade, section, subject, sections);

    return {
      interpreted: {
        grade: grade ? { id: grade.id, name: grade.name } : undefined,
        section: section ? { id: section.id, name: section.name } : undefined,
        subject: subject ? { id: subject.id, name: subject.name } : undefined,
        role: roleFilter ?? undefined,
        freeText: freeText || undefined,
      },
      results: [...entities, ...users.slice(0, 40)],
      total,
    };
  }

  // ---- per-role scoping --------------------------------------------------

  /** Sections a teacher/student/parent may see (reuses the announcements-service
   *  scoping shape). Admins are unrestricted (handled by the caller). */
  private async actorSectionIds(actor: Actor): Promise<string[]> {
    if (actor.role === Role.TEACHER) {
      const t = await this.prisma.teacherProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!t) return [];
      const [st, ss] = await Promise.all([
        this.prisma.sectionTeacher.findMany({
          where: { teacherId: t.id },
          select: { sectionId: true },
        }),
        this.prisma.sectionSubject.findMany({
          where: { teacherId: t.id },
          select: { sectionId: true },
        }),
      ]);
      return [
        ...new Set([
          ...st.map((x) => x.sectionId),
          ...ss.map((x) => x.sectionId),
        ]),
      ];
    }
    if (actor.role === Role.STUDENT) {
      const s = await this.prisma.studentProfile.findFirst({
        where: { userId: actor.userId },
        select: { id: true },
      });
      if (!s) return [];
      const enr = await this.prisma.enrollment.findMany({
        where: { studentId: s.id, status: 'ACTIVE' },
        select: { sectionId: true },
      });
      return [...new Set(enr.map((x) => x.sectionId))];
    }
    if (actor.role === Role.PARENT) {
      const childIds = await this.parentChildIds(actor);
      if (!childIds.length) return [];
      const enr = await this.prisma.enrollment.findMany({
        where: { studentId: { in: childIds }, status: 'ACTIVE' },
        select: { sectionId: true },
      });
      return [...new Set(enr.map((x) => x.sectionId))];
    }
    return [];
  }

  private async parentChildIds(actor: Actor): Promise<string[]> {
    const p = await this.prisma.parentProfile.findFirst({
      where: { userId: actor.userId },
      select: { id: true },
    });
    if (!p) return [];
    const links = await this.prisma.parentStudent.findMany({
      where: { parentId: p.id },
      select: { studentId: true },
    });
    return links.map((l) => l.studentId);
  }

  /** Population an actor may see in given sections: admin/teacher see everyone;
   *  student sees only teachers; parent sees teachers + only their own children. */
  private async populationInSections(
    actor: Actor,
    sectionIds: string[],
    roleFilter: Role | null,
    subjectId: string | null,
  ): Promise<ResultUser[]> {
    if (!sectionIds.length) return [];
    if (
      actor.role === Role.SCHOOL_ADMIN ||
      actor.role === Role.SUPER_ADMIN ||
      actor.role === Role.TEACHER
    ) {
      return this.usersInSections(sectionIds, roleFilter, subjectId);
    }
    if (actor.role === Role.STUDENT) {
      if (roleFilter && roleFilter !== Role.TEACHER) return [];
      return this.usersInSections(sectionIds, Role.TEACHER, subjectId);
    }
    // PARENT
    const wantTeachers = !roleFilter || roleFilter === Role.TEACHER;
    const wantChildren = !roleFilter || roleFilter === Role.STUDENT;
    const teachers = wantTeachers
      ? await this.usersInSections(sectionIds, Role.TEACHER, subjectId)
      : [];
    const children = wantChildren
      ? await this.parentChildrenInSections(actor, sectionIds)
      : [];
    return [...teachers, ...children];
  }

  private async parentChildrenInSections(
    actor: Actor,
    sectionIds: string[],
  ): Promise<ResultUser[]> {
    const childIds = await this.parentChildIds(actor);
    if (!childIds.length) return [];
    const enrollments = await this.prisma.enrollment.findMany({
      where: {
        studentId: { in: childIds },
        sectionId: { in: sectionIds },
        status: 'ACTIVE',
      },
      select: {
        student: {
          select: {
            id: true,
            fullName: true,
            rollNo: true,
            admissionNo: true,
            user: userSelect,
          },
        },
        section: {
          select: { name: true, classGrade: { select: { name: true } } },
        },
      },
    });
    const out = new Map<string, ResultUser>();
    for (const e of enrollments) {
      const u = e.student.user;
      if (!u || !u.isActive) continue;
      out.set(u.id, {
        ...baseUser(u, e.student.fullName),
        rollNo: e.student.rollNo,
        admissionNo: e.student.admissionNo,
        studentProfileId: e.student.id,
        className: e.section.classGrade?.name ?? null,
        sectionName: e.section.name,
      });
    }
    return [...out.values()];
  }

  private async schoolAdmins(
    schoolId: string,
    excludeUserId: string,
  ): Promise<ResultUser[]> {
    const rows = await this.prisma.user.findMany({
      where: {
        schoolId,
        role: Role.SCHOOL_ADMIN as any,
        isActive: true,
        id: { not: excludeUserId },
      },
      select: userSelect.select,
    });
    return rows.map((u) => baseUser(u));
  }

  // ---- resolvers ---------------------------------------------------------

  /** Significant tokens of a string, minus the generic prefix words. */
  private toks(s: string, generic: Set<string>): string[] {
    return tokenize(s).filter((x) => !generic.has(x));
  }

  /** Mark a resolved taxon's tokens (name or code) that appear in the query. */
  private consumeTaxon(
    t: Taxon,
    generic: Set<string>,
    tokenSet: Set<string>,
    consumed: Set<string>,
  ) {
    for (const tok of this.toks(`${t.name} ${t.code ?? ''}`, generic)) {
      if (tokenSet.has(tok)) consumed.add(tok);
    }
  }

  /**
   * Best taxon matched by the query: all its NAME tokens present, OR all its CODE
   * tokens present (code is an alternative, not an extra requirement).
   */
  private resolveTaxon<T extends Taxon>(
    items: T[],
    tokenSet: Set<string>,
    generic: Set<string>,
  ): T | null {
    let best: T | null = null;
    let bestScore = 0;
    for (const it of items) {
      const nameToks = this.toks(it.name, generic);
      const codeToks = it.code ? this.toks(it.code, generic) : [];
      let score = 0;
      if (nameToks.length && nameToks.every((t) => tokenSet.has(t))) {
        score = nameToks.length;
      }
      if (codeToks.length && codeToks.every((t) => tokenSet.has(t))) {
        score = Math.max(score, codeToks.length);
      }
      if (score > bestScore) {
        bestScore = score;
        best = it;
      }
    }
    return best;
  }

  private resolveSubject(
    subjects: Taxon[],
    freeTokens: string[],
  ): Taxon | null {
    let best: Taxon | null = null;
    let bestLen = 0;
    for (const s of subjects) {
      const name = s.name.toLowerCase();
      const code = s.code ? s.code.toLowerCase() : '';
      for (const t of freeTokens) {
        const hit = t === code || (t.length >= 3 && name.includes(t));
        if (hit && name.length > bestLen) {
          bestLen = name.length;
          best = s;
        }
      }
    }
    return best;
  }

  private entityResults(
    grade: Taxon | null,
    section: (Taxon & { classGradeId: string }) | null,
    subject: Taxon | null,
    sections: { classGradeId: string }[],
  ) {
    const out: any[] = [];
    if (grade) {
      const n = sections.filter((s) => s.classGradeId === grade.id).length;
      out.push({
        kind: 'class',
        id: grade.id,
        name: grade.name,
        subtitle: `Class · ${n} section${n === 1 ? '' : 's'}`,
      });
    }
    if (section) {
      out.push({
        kind: 'section',
        id: section.id,
        classGradeId: section.classGradeId,
        name: section.name,
        subtitle: grade ? `Section · ${grade.name}` : 'Section',
      });
    }
    if (subject) {
      out.push({
        kind: 'subject',
        id: subject.id,
        name: subject.name,
        subtitle: subject.code ? `Subject · ${subject.code}` : 'Subject',
      });
    }
    return out;
  }

  // ---- population gathering ---------------------------------------------

  private async usersInSections(
    sectionIds: string[],
    roleFilter: Role | null,
    subjectId: string | null,
  ): Promise<ResultUser[]> {
    const need = (r: Role) => !roleFilter || roleFilter === r;
    const out = new Map<string, ResultUser>();

    const enrollments =
      need(Role.STUDENT) || need(Role.PARENT)
        ? await this.prisma.enrollment.findMany({
            where: { sectionId: { in: sectionIds }, status: 'ACTIVE' },
            select: {
              student: {
                select: {
                  id: true,
                  fullName: true,
                  rollNo: true,
                  admissionNo: true,
                  user: userSelect,
                },
              },
              section: {
                select: {
                  name: true,
                  classGrade: { select: { name: true } },
                },
              },
            },
          })
        : [];

    if (need(Role.STUDENT)) {
      for (const e of enrollments) {
        const u = e.student.user;
        if (!u || !u.isActive) continue;
        out.set(u.id, {
          ...baseUser(u, e.student.fullName),
          rollNo: e.student.rollNo,
          admissionNo: e.student.admissionNo,
          studentProfileId: e.student.id,
          className: e.section.classGrade?.name ?? null,
          sectionName: e.section.name,
        });
      }
    }

    if (need(Role.PARENT)) {
      const studentIds = enrollments.map((e) => e.student.id);
      const secByStudent = new Map(
        enrollments.map((e) => [e.student.id, e.section]),
      );
      const links = studentIds.length
        ? await this.prisma.parentStudent.findMany({
            where: { studentId: { in: studentIds } },
            select: {
              studentId: true,
              student: { select: { fullName: true } },
              parent: { select: { fullName: true, user: userSelect } },
            },
          })
        : [];
      for (const l of links) {
        const u = l.parent?.user;
        if (!u || !u.isActive || out.has(u.id)) continue;
        const sec = secByStudent.get(l.studentId);
        out.set(u.id, {
          ...baseUser(u, l.parent.fullName),
          className: sec?.classGrade?.name ?? null,
          sectionName: sec?.name ?? null,
          relatedTo: l.student?.fullName ?? null,
        });
      }
    }

    if (need(Role.TEACHER)) {
      const [assigned, subjectTeachers] = await Promise.all([
        this.prisma.sectionTeacher.findMany({
          where: { sectionId: { in: sectionIds } },
          select: {
            section: {
              select: { name: true, classGrade: { select: { name: true } } },
            },
            teacher: { select: { fullName: true, user: userSelect } },
          },
        }),
        this.prisma.sectionSubject.findMany({
          where: {
            sectionId: { in: sectionIds },
            teacherId: { not: null },
            ...(subjectId ? { subjectId } : {}),
          },
          select: {
            section: {
              select: { name: true, classGrade: { select: { name: true } } },
            },
            subject: { select: { name: true } },
            teacher: { select: { fullName: true, user: userSelect } },
          },
        }),
      ]);
      const addTeacher = (
        teacher: { fullName: string; user: UserRow | null } | null,
        sec: { name: string; classGrade: { name: string } | null } | null,
        subjectName?: string,
      ) => {
        const u = teacher?.user;
        if (!u || !u.isActive) return;
        let r = out.get(u.id);
        if (!r) {
          r = {
            ...baseUser(u, teacher.fullName),
            className: sec?.classGrade?.name ?? null,
            sectionName: sec?.name ?? null,
          };
          out.set(u.id, r);
        }
        if (subjectName && !r.subjects.includes(subjectName)) {
          r.subjects.push(subjectName);
        }
      };
      for (const x of assigned) addTeacher(x.teacher, x.section);
      for (const x of subjectTeachers)
        addTeacher(x.teacher, x.section, x.subject?.name);
    }

    return [...out.values()];
  }

  private async freeTextUsers(
    schoolId: string,
    text: string,
    roleFilter: Role | null,
  ): Promise<ResultUser[]> {
    const s = text.trim();
    if (!s) return [];
    const where: any = { schoolId, isActive: true };
    if (roleFilter) where.role = roleFilter;
    where.OR = [
      { email: { contains: s, mode: 'insensitive' } },
      { fullName: { contains: s, mode: 'insensitive' } },
      { userCode: { contains: s, mode: 'insensitive' } },
      {
        teacherProfile: {
          is: { fullName: { contains: s, mode: 'insensitive' } },
        },
      },
      {
        parentProfile: {
          is: { fullName: { contains: s, mode: 'insensitive' } },
        },
      },
      {
        studentProfile: {
          is: { fullName: { contains: s, mode: 'insensitive' } },
        },
      },
      {
        studentProfile: {
          is: { rollNo: { contains: s, mode: 'insensitive' } },
        },
      },
      {
        studentProfile: {
          is: { admissionNo: { contains: s, mode: 'insensitive' } },
        },
      },
    ];

    const rows = await this.prisma.user.findMany({
      where,
      take: 40,
      select: {
        id: true,
        email: true,
        role: true,
        userCode: true,
        fullName: true,
        isActive: true,
        studentProfile: {
          select: {
            id: true,
            fullName: true,
            rollNo: true,
            admissionNo: true,
            enrollments: {
              where: { status: 'ACTIVE' },
              take: 1,
              orderBy: { createdAt: 'desc' },
              select: {
                section: {
                  select: {
                    name: true,
                    classGrade: { select: { name: true } },
                  },
                },
              },
            },
          },
        },
        teacherProfile: { select: { fullName: true } },
        parentProfile: { select: { fullName: true } },
      },
    });

    return rows.map((u) => {
      const profileName =
        u.studentProfile?.fullName ||
        u.teacherProfile?.fullName ||
        u.parentProfile?.fullName ||
        null;
      const enr = u.studentProfile?.enrollments?.[0]?.section;
      return {
        ...baseUser(u, profileName),
        rollNo: u.studentProfile?.rollNo ?? null,
        admissionNo: u.studentProfile?.admissionNo ?? null,
        studentProfileId: u.studentProfile?.id ?? null,
        className: enr?.classGrade?.name ?? null,
        sectionName: enr?.name ?? null,
      };
    });
  }
}

// ---- shared shapes -------------------------------------------------------

type UserRow = {
  id: string;
  email: string;
  role: string;
  userCode: string | null;
  fullName: string | null;
  isActive: boolean;
};

const userSelect = {
  select: {
    id: true,
    email: true,
    role: true,
    userCode: true,
    fullName: true,
    isActive: true,
  },
} as const;

type ResultUser = {
  kind: 'user';
  id: string;
  name: string;
  role: string;
  email: string;
  userCode: string | null;
  rollNo: string | null;
  admissionNo: string | null;
  studentProfileId: string | null;
  className: string | null;
  sectionName: string | null;
  subjects: string[];
  relatedTo?: string | null;
};

function baseUser(u: UserRow, profileName?: string | null): ResultUser {
  return {
    kind: 'user',
    id: u.id,
    name: u.fullName || profileName || u.email,
    role: u.role,
    email: u.email,
    userCode: u.userCode,
    rollNo: null,
    admissionNo: null,
    studentProfileId: null,
    className: null,
    sectionName: null,
    subjects: [],
  };
}

function userMatchesText(u: ResultUser, f: string): boolean {
  return (
    u.name.toLowerCase().includes(f) ||
    u.email.toLowerCase().includes(f) ||
    (u.userCode ?? '').toLowerCase().includes(f) ||
    (u.rollNo ?? '').toLowerCase().includes(f) ||
    (u.admissionNo ?? '').toLowerCase().includes(f)
  );
}
