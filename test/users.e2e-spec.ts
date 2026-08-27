import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

const YEAR = new Date().getFullYear();

/**
 * Complete STUDENT create payload: essentials/address fields + a guardian
 * (parentProfileId or inline newParent). Default creates a fresh parent.
 */
function studentPayload(overrides: Record<string, unknown> = {}) {
  const rnd = Math.random().toString(36).slice(2);
  return {
    email: `student-${rnd}@ghs.test`,
    password: 'Student@123',
    role: 'STUDENT',
    fullName: 'Student One',
    gender: 'MALE',
    dob: '2012-05-01',
    dateOfJoining: '2026-01-10',
    city: 'Springfield',
    state: 'Illinois',
    country: 'United States',
    // Mandatory at admission since the fee module landed.
    monthlyFeeAmount: 500000,
    newParent: {
      fullName: 'Guardian One',
      email: `parent-${rnd}@ghs.test`,
      password: 'Parent@123',
      phone: '5550100',
      phoneDialCode: '+1',
    },
    relationship: 'GUARDIAN',
    ...overrides,
  };
}

describe('Users / student creation (e2e)', () => {
  let app: INestApplication;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
  });

  async function schoolAdmin(code = 'GHS') {
    const school = await createTestSchool({ code });
    const admin = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: school.id,
    });
    const token = await tokenFor(app, admin);
    return { school, admin, token };
  }

  function post(token: string, body: Record<string, unknown>) {
    return request(app.getHttpServer())
      .post('/api/users')
      .set('Authorization', `Bearer ${token}`)
      .send(body);
  }

  it('auto-generates sequential per-school admission numbers', async () => {
    const { token } = await schoolAdmin('GHS');

    const s1 = await post(token, studentPayload({ email: 's1@ghs.test' }));
    const s2 = await post(token, studentPayload({ email: 's2@ghs.test' }));

    expect(s1.status).toBe(201);
    expect(s2.status).toBe(201);
    expect(s1.body.studentProfile.admissionNo).toBe(`GHS-${YEAR}-0001`);
    expect(s2.body.studentProfile.admissionNo).toBe(`GHS-${YEAR}-0002`);
  });

  it('auto-generates sequential school-wide roll numbers, with manual override', async () => {
    const { token } = await schoolAdmin('GHS');

    const s1 = await post(token, studentPayload({ email: 'r1@ghs.test' }));
    const s2 = await post(token, studentPayload({ email: 'r2@ghs.test' }));
    // Manual override is honoured verbatim.
    const s3 = await post(
      token,
      studentPayload({ email: 'r3@ghs.test', rollNo: 'A-42' }),
    );
    // Next auto number continues from the highest numeric roll (0002 -> 0003).
    const s4 = await post(token, studentPayload({ email: 'r4@ghs.test' }));

    expect(s1.body.studentProfile.rollNo).toBe('0001');
    expect(s2.body.studentProfile.rollNo).toBe('0002');
    expect(s3.body.studentProfile.rollNo).toBe('A-42');
    expect(s4.body.studentProfile.rollNo).toBe('0003');
  });

  it('persists the newly-exposed student fields and derives the guardian from the parent', async () => {
    const { token } = await schoolAdmin('GHS');

    const res = await post(
      token,
      studentPayload({
        email: 'aisha@ghs.test',
        fullName: 'Aisha Khan',
        gender: 'FEMALE',
        bloodGroup: 'O+',
        phone: '5550111',
        phoneDialCode: '+1',
        newParent: {
          fullName: 'Sana Khan',
          email: 'sana@ghs.test',
          password: 'Parent@123',
          phone: '5550199',
          phoneDialCode: '+1',
        },
      }),
    );

    expect(res.status).toBe(201);
    expect(res.body.studentProfile.gender).toBe('FEMALE');
    expect(res.body.studentProfile.bloodGroup).toBe('O+');
    expect(res.body.studentProfile.phoneDialCode).toBe('+1');
    // Guardian name/phone are derived from the created parent, not free-typed.
    expect(res.body.studentProfile.guardianName).toBe('Sana Khan');
    expect(res.body.studentProfile.guardianPhone).toBe('+1 5550199');
    // The parent was linked with the given relationship.
    expect(res.body.studentProfile.parents).toHaveLength(1);
    expect(res.body.studentProfile.parents[0].parent.fullName).toBe(
      'Sana Khan',
    );
    expect(res.body.studentProfile.parents[0].relationship).toBe('GUARDIAN');
  });

  it('rejects a student missing required essentials/address fields (400)', async () => {
    const { token } = await schoolAdmin('GHS');

    const noGender = await post(
      token,
      (() => {
        const p = studentPayload({ email: 'ng@ghs.test' });
        delete (p as Record<string, unknown>).gender;
        return p;
      })(),
    );
    expect(noGender.status).toBe(400);

    const noCity = await post(
      token,
      (() => {
        const p = studentPayload({ email: 'nc@ghs.test' });
        delete (p as Record<string, unknown>).city;
        return p;
      })(),
    );
    expect(noCity.status).toBe(400);
  });

  it('rejects a duplicate email with 409 Conflict', async () => {
    const { token } = await schoolAdmin('GHS');

    const first = await post(token, studentPayload({ email: 'dup@ghs.test' }));
    expect(first.status).toBe(201);

    const second = await post(token, studentPayload({ email: 'dup@ghs.test' }));
    expect(second.status).toBe(409);
  });

  it('rejects a duplicate manual roll number with 409 and creates no orphan user', async () => {
    const { token } = await schoolAdmin('GHS');

    const first = await post(
      token,
      studentPayload({ email: 'roll1@ghs.test', rollNo: 'R-1' }),
    );
    expect(first.status).toBe(201);

    const second = await post(
      token,
      studentPayload({ email: 'roll2@ghs.test', rollNo: 'R-1' }),
    );
    expect(second.status).toBe(409);

    const orphan = await prisma.user.findUnique({
      where: { email: 'roll2@ghs.test' },
    });
    expect(orphan).toBeNull();
  });

  it('student creation is atomic — a duplicate admission number leaves no orphaned User (409)', async () => {
    const { token } = await schoolAdmin('GHS');

    const first = await post(
      token,
      studentPayload({ email: 'first@ghs.test', admissionNo: 'DUP-1' }),
    );
    expect(first.status).toBe(201);

    // Second student re-uses the same manual admission number -> rejected by the
    // pre-flight uniqueness check (409) before any row is written.
    const second = await post(
      token,
      studentPayload({ email: 'second@ghs.test', admissionNo: 'DUP-1' }),
    );
    expect(second.status).toBe(409);

    const orphan = await prisma.user.findUnique({
      where: { email: 'second@ghs.test' },
    });
    expect(orphan).toBeNull();
  });

  it('rejects user creation without auth (401) and by the wrong role (403)', async () => {
    const anon = await request(app.getHttpServer())
      .post('/api/users')
      .send(studentPayload({ email: 'x@ghs.test' }));
    expect(anon.status).toBe(401);

    const student = await createTestUser({ role: Role.STUDENT });
    const studentToken = await tokenFor(app, student);
    const forbidden = await post(
      studentToken,
      studentPayload({ email: 'y@ghs.test' }),
    );
    expect(forbidden.status).toBe(403);
  });

  it("enforces tenant isolation — a school admin cannot read another school's user", async () => {
    const schoolA = await createTestSchool({ code: 'AAA' });
    const schoolB = await createTestSchool({ code: 'BBB' });

    const adminA = await createTestUser({
      role: Role.SCHOOL_ADMIN,
      schoolId: schoolA.id,
    });
    const tokenA = await tokenFor(app, adminA);

    const userInA = await createTestUser({
      role: Role.TEACHER,
      schoolId: schoolA.id,
    });
    const userInB = await createTestUser({
      role: Role.TEACHER,
      schoolId: schoolB.id,
    });

    // same-school read is allowed
    const ownSchool = await request(app.getHttpServer())
      .get(`/api/users/${userInA.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(ownSchool.status).toBe(200);

    // cross-school read is denied
    const crossSchool = await request(app.getHttpServer())
      .get(`/api/users/${userInB.id}`)
      .set('Authorization', `Bearer ${tokenA}`);
    expect(crossSchool.status).toBe(403);
  });

  it('links an existing parent to a new student with the given relationship', async () => {
    const { token } = await schoolAdmin('GHS');

    const parentRes = await post(token, {
      email: 'existing-parent@ghs.test',
      password: 'Parent@123',
      role: 'PARENT',
      fullName: 'Existing Parent',
      phone: '5550300',
      phoneDialCode: '+1',
    });
    expect(parentRes.status).toBe(201);
    const parentProfileId = parentRes.body.parentProfile.id;
    expect(parentProfileId).toBeTruthy();

    const p = studentPayload({ email: 'linked@ghs.test' });
    delete (p as Record<string, unknown>).newParent;
    const res = await post(token, {
      ...p,
      parentProfileId,
      relationship: 'MOTHER',
    });

    expect(res.status).toBe(201);
    expect(res.body.studentProfile.parents).toHaveLength(1);
    expect(res.body.studentProfile.parents[0].parent.id).toBe(parentProfileId);
    expect(res.body.studentProfile.parents[0].relationship).toBe('MOTHER');
    // Guardian snapshot is derived from the linked parent.
    expect(res.body.studentProfile.guardianName).toBe('Existing Parent');
  });

  it('rejects linking a parent from another school (403)', async () => {
    const a = await schoolAdmin('AAA');
    const b = await schoolAdmin('BBB');

    const parentRes = await post(a.token, {
      email: 'parent-a@aaa.test',
      password: 'Parent@123',
      role: 'PARENT',
      fullName: 'Parent A',
      phone: '5550400',
    });
    expect(parentRes.status).toBe(201);
    const parentProfileId = parentRes.body.parentProfile.id;

    const p = studentPayload({ email: 'cross@bbb.test' });
    delete (p as Record<string, unknown>).newParent;
    const res = await post(b.token, { ...p, parentProfileId });
    expect(res.status).toBe(403);
  });

  it('requires a guardian on student create (400)', async () => {
    const { token } = await schoolAdmin('GHS');
    const p = studentPayload({ email: 'noguardian@ghs.test' });
    delete (p as Record<string, unknown>).newParent;
    const res = await post(token, p);
    expect(res.status).toBe(400);
  });

  it('creates the inline parent account (visible in the parents list) and links it', async () => {
    const { token } = await schoolAdmin('GHS');

    const res = await post(
      token,
      studentPayload({
        email: 'withnewparent@ghs.test',
        newParent: {
          fullName: 'Brand New Parent',
          email: 'brandnew@ghs.test',
          password: 'Parent@123',
          phone: '5550500',
          phoneDialCode: '+1',
        },
      }),
    );
    expect(res.status).toBe(201);
    const linkedParentId = res.body.studentProfile.parents[0].parent.id;

    const parents = await request(app.getHttpServer())
      .get('/api/users?role=PARENT')
      .set('Authorization', `Bearer ${token}`);
    expect(parents.status).toBe(200);
    const created = parents.body.find(
      (u: any) => u.email === 'brandnew@ghs.test',
    );
    expect(created).toBeTruthy();
    expect(created.parentProfile.id).toBe(linkedParentId);
  });

  it('rejects an inline parent whose email is already taken (409)', async () => {
    const { token } = await schoolAdmin('GHS');

    const first = await post(token, {
      email: 'taken-parent@ghs.test',
      password: 'Parent@123',
      role: 'PARENT',
      fullName: 'Taken Parent',
      phone: '5550600',
    });
    expect(first.status).toBe(201);

    const res = await post(
      token,
      studentPayload({
        email: 'dupparent-student@ghs.test',
        newParent: {
          fullName: 'Dup Parent',
          email: 'taken-parent@ghs.test',
          password: 'Parent@123',
          phone: '5550601',
        },
      }),
    );
    expect(res.status).toBe(409);
  });

  it('persists the extra optional student fields', async () => {
    const { token } = await schoolAdmin('GHS');

    const res = await post(
      token,
      studentPayload({
        email: 'extra@ghs.test',
        nationalId: '35202-1111111-1',
        phone: '5551000',
        phoneDialCode: '+92',
        whatsapp: '5551001',
        whatsappDialCode: '+92',
        profileEmail: 'kid.personal@ghs.test',
        prevInstituteName: 'Old School',
        prevAdmissionNo: 'OS-42',
        prevLeavingReason: 'Relocation',
        entryTestObtainedMarks: 85,
        entryTestTotalMarks: 100,
      }),
    );

    expect(res.status).toBe(201);
    const p = res.body.studentProfile;
    expect(p.nationalId).toBe('35202-1111111-1');
    expect(p.phone).toBe('5551000');
    expect(p.phoneDialCode).toBe('+92');
    expect(p.whatsapp).toBe('5551001');
    expect(p.whatsappDialCode).toBe('+92');
    expect(p.email).toBe('kid.personal@ghs.test');
    expect(p.prevInstituteName).toBe('Old School');
    expect(p.prevAdmissionNo).toBe('OS-42');
    expect(p.prevLeavingReason).toBe('Relocation');
    expect(p.entryTestObtainedMarks).toBe(85);
    expect(p.entryTestTotalMarks).toBe(100);
  });

  it('persists the extra optional parent fields', async () => {
    const { token } = await schoolAdmin('GHS');

    const res = await post(token, {
      email: 'infoparent@ghs.test',
      password: 'Parent@123',
      role: 'PARENT',
      fullName: 'Info Parent',
      phone: '5552000',
      phoneDialCode: '+92',
      whatsapp: '5552001',
      whatsappDialCode: '+92',
      nationalId: '35202-2222222-2',
      occupation: 'Engineer',
      academicStatus: 'Masters',
      profileEmail: 'info.personal@ghs.test',
    });

    expect(res.status).toBe(201);
    const p = res.body.parentProfile;
    expect(p.whatsapp).toBe('5552001');
    expect(p.whatsappDialCode).toBe('+92');
    expect(p.nationalId).toBe('35202-2222222-2');
    expect(p.occupation).toBe('Engineer');
    expect(p.academicStatus).toBe('Masters');
    expect(p.email).toBe('info.personal@ghs.test');
  });

  it('uploads a student photo and serves it back', async () => {
    const { token } = await schoolAdmin('GHS');

    const created = await post(
      token,
      studentPayload({ email: 'pic@ghs.test' }),
    );
    expect(created.status).toBe(201);
    const studentProfileId = created.body.studentProfile.id;

    // 1x1 transparent PNG.
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );

    const upload = await request(app.getHttpServer())
      .post(`/api/users/students/${studentProfileId}/photo`)
      .set('Authorization', `Bearer ${token}`)
      .attach('photo', png, { filename: 'p.png', contentType: 'image/png' });
    expect(upload.status).toBe(201);

    const fetched = await request(app.getHttpServer())
      .get(`/api/users/students/${studentProfileId}/photo`)
      .set('Authorization', `Bearer ${token}`);
    expect(fetched.status).toBe(200);
    expect(fetched.headers['content-type']).toContain('image/png');
    expect(fetched.body.length).toBe(png.length);

    // The profile now advertises a photo via photoMimeType.
    const detail = await request(app.getHttpServer())
      .get(`/api/users/${created.body.id}`)
      .set('Authorization', `Bearer ${token}`);
    expect(detail.body.studentProfile.photoMimeType).toBe('image/png');
  });

  it('rejects a student photo upload from another school (403)', async () => {
    const a = await schoolAdmin('AAA');
    const b = await schoolAdmin('BBB');

    const created = await post(
      a.token,
      studentPayload({ email: 'a-pic@aaa.test' }),
    );
    expect(created.status).toBe(201);
    const studentProfileId = created.body.studentProfile.id;

    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
      'base64',
    );
    const upload = await request(app.getHttpServer())
      .post(`/api/users/students/${studentProfileId}/photo`)
      .set('Authorization', `Bearer ${b.token}`)
      .attach('photo', png, { filename: 'p.png', contentType: 'image/png' });
    expect(upload.status).toBe(403);
  });

  it('paginates the users list and returns an envelope; omitting page returns the array', async () => {
    const { token } = await schoolAdmin('GHS');
    for (let i = 0; i < 3; i++) {
      const res = await post(
        token,
        studentPayload({ email: `pg${i}@ghs.test` }),
      );
      expect(res.status).toBe(201);
    }

    // Paginated: envelope with bounded items + correct total.
    const paged = await request(app.getHttpServer())
      .get('/api/users?role=STUDENT&page=1&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    expect(paged.status).toBe(200);
    expect(paged.body.total).toBe(3);
    expect(paged.body.page).toBe(1);
    expect(paged.body.pageSize).toBe(2);
    expect(paged.body.items).toHaveLength(2);

    const page2 = await request(app.getHttpServer())
      .get('/api/users?role=STUDENT&page=2&pageSize=2')
      .set('Authorization', `Bearer ${token}`);
    expect(page2.body.items).toHaveLength(1);

    // Search filters the total.
    const searched = await request(app.getHttpServer())
      .get('/api/users?role=STUDENT&page=1&pageSize=20&search=pg1@ghs.test')
      .set('Authorization', `Bearer ${token}`);
    expect(searched.body.total).toBe(1);
    expect(searched.body.items[0].email).toBe('pg1@ghs.test');

    // Back-compat: no page param -> plain array.
    const array = await request(app.getHttpServer())
      .get('/api/users?role=STUDENT')
      .set('Authorization', `Bearer ${token}`);
    expect(Array.isArray(array.body)).toBe(true);
    expect(array.body).toHaveLength(3);
  });

  // ---- Guardian unlinking (a student keeps at least one guardian) ----

  function unlink(
    token: string,
    studentProfileId: string,
    parentProfileId: string,
  ) {
    return request(app.getHttpServer())
      .delete(
        `/api/users/students/${studentProfileId}/parents/${parentProfileId}`,
      )
      .set('Authorization', `Bearer ${token}`);
  }

  /** The parent links currently on a student user (via GET /api/users/:id). */
  async function guardianLinks(token: string, userId: string) {
    const detail = await request(app.getHttpServer())
      .get(`/api/users/${userId}`)
      .set('Authorization', `Bearer ${token}`);
    return detail.body.studentProfile.parents as Array<{
      parent: { id: string };
    }>;
  }

  /** Create a student with two linked guardians; returns the relevant ids. */
  async function studentWithTwoGuardians(token: string) {
    const rnd = Math.random().toString(36).slice(2);
    const created = await post(
      token,
      studentPayload({ email: `twg-${rnd}@ghs.test` }),
    );
    expect(created.status).toBe(201);
    const userId = created.body.id as string;
    const studentProfileId = created.body.studentProfile.id as string;
    const guardian1Id = created.body.studentProfile.parents[0].parent
      .id as string;

    const parent2 = await post(token, {
      email: `g2-${rnd}@ghs.test`,
      password: 'Parent@123',
      role: 'PARENT',
      fullName: 'Guardian Two',
      phone: '5550700',
      phoneDialCode: '+1',
    });
    expect(parent2.status).toBe(201);
    const guardian2Id = parent2.body.parentProfile.id as string;

    const link = await request(app.getHttpServer())
      .post('/api/users/link-parent-student')
      .set('Authorization', `Bearer ${token}`)
      .send({
        parentProfileId: guardian2Id,
        studentProfileId,
        relationship: 'FATHER',
      });
    expect(link.status).toBe(201);

    return { userId, studentProfileId, guardian1Id, guardian2Id };
  }

  it('unlinks an additional guardian, keeping the remaining one', async () => {
    const { token } = await schoolAdmin('GHS');
    const { userId, studentProfileId, guardian1Id, guardian2Id } =
      await studentWithTwoGuardians(token);

    // Sanity: two guardians linked.
    expect(await guardianLinks(token, userId)).toHaveLength(2);

    const res = await unlink(token, studentProfileId, guardian2Id);
    expect(res.status).toBe(200);

    const remaining = await guardianLinks(token, userId);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].parent.id).toBe(guardian1Id);
  });

  it('refuses to remove the last remaining guardian (400) and keeps the link', async () => {
    const { token } = await schoolAdmin('GHS');
    const created = await post(
      token,
      studentPayload({ email: 'solo@ghs.test' }),
    );
    expect(created.status).toBe(201);
    const userId = created.body.id as string;
    const studentProfileId = created.body.studentProfile.id as string;
    const guardianId = created.body.studentProfile.parents[0].parent
      .id as string;

    const res = await unlink(token, studentProfileId, guardianId);
    expect(res.status).toBe(400);

    // The guardian is still linked — nothing was removed.
    expect(await guardianLinks(token, userId)).toHaveLength(1);
  });

  it("rejects unlinking a guardian from another school's student (403)", async () => {
    const a = await schoolAdmin('AAA');
    const b = await schoolAdmin('BBB');
    const { studentProfileId, guardian2Id } = await studentWithTwoGuardians(
      a.token,
    );

    const res = await unlink(b.token, studentProfileId, guardian2Id);
    expect(res.status).toBe(403);
  });

  it('rejects unlinking without auth (401) and by the wrong role (403)', async () => {
    const { token } = await schoolAdmin('GHS');
    const { studentProfileId, guardian2Id } =
      await studentWithTwoGuardians(token);

    const anon = await request(app.getHttpServer()).delete(
      `/api/users/students/${studentProfileId}/parents/${guardian2Id}`,
    );
    expect(anon.status).toBe(401);

    const student = await createTestUser({ role: Role.STUDENT });
    const studentToken = await tokenFor(app, student);
    const forbidden = await unlink(studentToken, studentProfileId, guardian2Id);
    expect(forbidden.status).toBe(403);
  });
});
