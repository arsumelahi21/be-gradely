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
