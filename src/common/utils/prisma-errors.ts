import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Turn a unique-constraint violation into a 409 the form can actually show.
 *
 * Left alone, P2002 reaches Nest's default handler and the user gets a bare
 * 500 "Internal server error" — which reads as a broken server rather than
 * "that name is already taken", and gives them nothing to act on.
 *
 * Use as a `.catch()` on the write itself, so the constraint stays the source
 * of truth: a pre-flight `findFirst` would still race, and would cost a query
 * on every successful write to catch the rare failing one.
 *
 *   await this.prisma.section.create({ ... })
 *     .catch(uniqueConflict(`${grade.name} already has a section "${name}"`));
 */
export function uniqueConflict(message: string) {
  return (e: unknown): never => {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === 'P2002'
    ) {
      throw new ConflictException(message);
    }
    throw e;
  };
}

/**
 * A delete blocked by a child row.
 *
 * Section, ClassGrade, Subject and SectionSubject are all referenced WITHOUT a
 * cascade, so Prisma's default (Restrict) refuses the delete — and left
 * untranslated that surfaces as a 500 too. P2003 is the FK violation; P2014 is
 * Prisma's own required-relation check, which fires first on some shapes.
 */
export function isRestrictedDelete(e: unknown) {
  // P2003 = foreign-key violation, P2014 = Prisma's own required-relation check.
  if (e instanceof Prisma.PrismaClientKnownRequestError) {
    return e.code === 'P2003' || e.code === 'P2014';
  }
  // A DB-level ON DELETE RESTRICT raises Postgres 23001, which Prisma does NOT
  // map to a code at all — it arrives as an UNKNOWN error with the SQLSTATE
  // buried in the message. Sniffing text is unpleasant, but the alternative is
  // the 500 this whole helper exists to remove.
  if (e instanceof Prisma.PrismaClientUnknownRequestError) {
    return (
      e.message.includes('23001') ||
      e.message.includes('23503') ||
      e.message.includes('violates RESTRICT setting') ||
      e.message.includes('violates foreign key constraint')
    );
  }
  return false;
}

/** "3 subjects, 1 quiz" — only the non-zero blockers, plural-correct. */
export function describeBlockers(
  parts: Array<[count: number, singular: string, plural: string]>,
) {
  return parts
    .filter(([n]) => n > 0)
    .map(([n, one, many]) => `${n} ${n === 1 ? one : many}`)
    .join(', ');
}
