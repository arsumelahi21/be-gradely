import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
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
