/**
 * Backfills `User.userCode` for existing TEACHER/PARENT/SCHOOL_ADMIN accounts missing one.
 * Idempotent: only fills nulls, continuing the existing per-school/prefix sequence.
 */
import { PrismaClient, Role } from '@prisma/client';

const prisma = new PrismaClient();

const PREFIX: Partial<Record<Role, string>> = {
  [Role.TEACHER]: 'TCH',
  [Role.PARENT]: 'PAR',
  [Role.SCHOOL_ADMIN]: 'ADM',
};

async function main() {
  const schools = await prisma.school.findMany({
    select: { id: true, name: true },
  });
  let assigned = 0;

  for (const school of schools) {
    for (const role of [
      Role.TEACHER,
      Role.PARENT,
      Role.SCHOOL_ADMIN,
    ] as const) {
      const prefix = PREFIX[role]!;

      // Continue the existing sequence for this school + prefix.
      const existing = await prisma.user.findMany({
        where: { schoolId: school.id, userCode: { startsWith: `${prefix}-` } },
        select: { userCode: true },
      });
      let max = 0;
      for (const e of existing) {
        const suffix = String(e.userCode).slice(prefix.length + 1);
        if (/^\d+$/.test(suffix)) {
          const n = parseInt(suffix, 10);
          if (n > max) max = n;
        }
      }

      const todo = await prisma.user.findMany({
        where: { schoolId: school.id, role, userCode: null },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
      });
      for (const u of todo) {
        max += 1;
        await prisma.user.update({
          where: { id: u.id },
          data: { userCode: `${prefix}-${String(max).padStart(4, '0')}` },
        });
        assigned++;
      }
      if (todo.length) {
        console.log(
          `${school.name}: ${role} -> assigned ${todo.length} (${prefix}-)`,
        );
      }
    }
  }
  console.log(`Done. Assigned ${assigned} user code(s).`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
