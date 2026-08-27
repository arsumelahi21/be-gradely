import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import * as crypto from 'crypto';

const prisma = new PrismaClient();

function getEnv(name: string, fallback?: string) {
  const value = process.env[name];
  return value && value.trim().length ? value.trim() : fallback;
}

function parseBool(value?: string) {
  if (!value) return false;
  return ['1', 'true', 'yes', 'y', 'on'].includes(value.toLowerCase());
}

function generatePassword() {
  // 24 chars, URL-safe-ish, includes punctuation.
  return crypto.randomBytes(18).toString('base64url');
}

async function main() {
  const email = getEnv('SUPER_ADMIN_EMAIL', 'superadmin@gradely.com')!;
  const providedPassword = getEnv('SUPER_ADMIN_PASSWORD');
  const forceReset = parseBool(getEnv('SUPER_ADMIN_FORCE'));
  const password = providedPassword ?? generatePassword();

  const existing = await prisma.user.findUnique({
    where: { email },
  });

  if (existing && !forceReset) {
    console.log('✅ Super Admin already exists:', email);
    console.log('ℹ️  To reset password, set SUPER_ADMIN_FORCE=true');
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const superAdmin = existing
    ? await prisma.user.update({
        where: { id: existing.id },
        data: { passwordHash, isActive: true, role: Role.SUPER_ADMIN },
      })
    : await prisma.user.create({
        data: {
          email,
          passwordHash,
          role: Role.SUPER_ADMIN,
          isActive: true,
          schoolId: null,
        },
      });

  console.log(existing ? '🔁 Super Admin updated successfully' : '🎉 Super Admin created successfully');
  console.log({
    email,
    // If you provided SUPER_ADMIN_PASSWORD, it will be that value; otherwise this is a generated password.
    password,
    id: superAdmin.id,
  });
}

main()
  .catch((e) => {
    console.error('❌ Error creating Super Admin', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
