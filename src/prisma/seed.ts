import { PrismaClient, Role } from '@prisma/client';
import * as bcrypt from 'bcrypt';

const prisma = new PrismaClient();

async function main() {
  const email = 'superadmin@gradely.com';
  const password = 'Admin@12345678';

  // check if super admin already exists
  const existing = await prisma.user.findUnique({
    where: { email },
  });

  if (existing) {
    console.log('✅ Super Admin already exists:', email);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);

  const superAdmin = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: Role.SUPER_ADMIN,
      schoolId: null,
      isActive: true,
    },
  });

  console.log('🎉 Super Admin created successfully');
  console.log({
    email,
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
