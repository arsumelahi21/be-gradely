import { INestApplication } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import type { StringValue } from 'ms';
import * as bcrypt from 'bcrypt';
import { prisma } from './db';
import { Role } from '../../src/common/types/role.type';

let seq = 0;
const uniq = () => `${Date.now()}${seq++}`;

const DEFAULT_PASSWORD = 'Password@123';
/**
 * Hashed once per run rather than once per user. bcrypt at cost 10 costs ~60ms and a full
 * suite creates roughly a thousand fixture users, nearly all with this one password — that
 * was about a minute of pure CPU. Still a real bcrypt hash, so login paths are unchanged.
 */
const DEFAULT_PASSWORD_HASH = bcrypt.hashSync(DEFAULT_PASSWORD, 10);

export async function createTestSchool(
  overrides: Partial<{ name: string; code: string; isActive: boolean }> = {},
) {
  const n = uniq();
  return prisma.school.create({
    data: {
      name: overrides.name ?? `Test School ${n}`,
      code: overrides.code ?? `TS${n}`.slice(0, 20),
      isActive: overrides.isActive ?? true,
    },
  });
}

export interface CreateTestUserInput {
  role: Role;
  schoolId?: string | null;
  email?: string;
  password?: string;
  fullName?: string;
  isActive?: boolean;
}

/**
 * Creates a base User row directly (bcrypt-hashed) — sufficient for auth/role/tenant tests.
 * Flows needing a full profile go through the real endpoints instead.
 */
export async function createTestUser(input: CreateTestUserInput) {
  const {
    role,
    schoolId = null,
    email = `user-${uniq()}@test.local`,
    password = DEFAULT_PASSWORD,
    fullName = 'Test User',
    isActive = true,
  } = input;

  const passwordHash =
    password === DEFAULT_PASSWORD
      ? DEFAULT_PASSWORD_HASH
      : await bcrypt.hash(password, 10);
  const isAdmin = role === Role.SUPER_ADMIN || role === Role.SCHOOL_ADMIN;

  const user = await prisma.user.create({
    data: {
      email,
      passwordHash,
      role: role as any,
      schoolId,
      isActive,
      ...(isAdmin ? { fullName } : {}),
    },
  });

  return { ...user, password };
}

/** Sign a valid access token for a user (bypasses the throttled login route). */
export async function tokenFor(
  app: INestApplication,
  user: { id: string; role: string; schoolId: string | null; email: string },
): Promise<string> {
  const jwt = app.get(JwtService);
  return jwt.signAsync(
    {
      sub: user.id,
      role: user.role,
      schoolId: user.schoolId ?? null,
      email: user.email,
    },
    {
      secret: process.env.JWT_ACCESS_SECRET,
      expiresIn: (process.env.JWT_ACCESS_EXPIRES_IN ?? '15m') as StringValue,
    },
  );
}
