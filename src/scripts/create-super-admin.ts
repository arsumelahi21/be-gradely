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
  const hash = await bcrypt.hash(password, 10);

  if (exists) {
    // The only way back in for a locked-out super admin: password recovery is
    // admin-issued, and no admin outranks this one. Opt-in, so a repeat bootstrap
    // can never silently overwrite a working account.
    if (process.env.SUPER_ADMIN_RESET !== 'true') {
      console.log(
        'Super Admin already exists. Set SUPER_ADMIN_RESET=true to reset its password.',
      );
      await prisma.$disconnect();
      process.exit(0);
    }

    await prisma.user.update({
      where: { id: exists.id },
      data: { passwordHash: hash, refreshTokenHash: null, isActive: true },
    });
    console.log(`Super Admin password reset: ${email}`);
    await prisma.$disconnect();
    process.exit(0);
  }

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
