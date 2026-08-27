import 'dotenv/config';
import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

/**
 * Bootstrap the first SUPER_ADMIN account. Credentials MUST come from env vars
 * (SUPER_ADMIN_EMAIL/PASSWORD) — no hardcoded default, to avoid a known-credentials backdoor.
 */
(async () => {
  const email = process.env.SUPER_ADMIN_EMAIL;
  const password = process.env.SUPER_ADMIN_PASSWORD;

  if (!email || !password) {
    console.error(
      'Refusing to run: set SUPER_ADMIN_EMAIL and SUPER_ADMIN_PASSWORD ' +
        '(env vars or .env) before creating the super admin.',
    );
    process.exit(1);
  }

  if (password.length < 8) {
    console.error('SUPER_ADMIN_PASSWORD must be at least 8 characters.');
    process.exit(1);
  }

  const exists = await prisma.user.findUnique({ where: { email } });
  if (exists) {
    console.log('Super Admin already exists');
    await prisma.$disconnect();
    process.exit(0);
  }

  const hash = await bcrypt.hash(password, 10);

  await prisma.user.create({
    data: {
      email,
      passwordHash: hash,
      role: Role.SUPER_ADMIN,
      isActive: true,
      schoolId: null,
    },
  });

  // Do not log the password back out.
  console.log(`Super Admin created: ${email}`);

  await prisma.$disconnect();
})();
