import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { createTestApp } from './utils/app';
import { prisma, resetDb } from './utils/db';
import { createTestSchool, createTestUser, tokenFor } from './utils/factories';
import { Role } from '../src/common/types/role.type';

/**
 * DEMO chatbot (see AI_CHATBOT_IMPLEMENTATION.md).
 *
 * The store is in-memory, so `resetDb()` does not clear it — each test makes its
 * own user, and since every store read is keyed by user id, that is enough to
 * keep tests isolated. It also means the ownership assertions below are testing
 * the real boundary rather than a happy path.
 */
describe('Chatbot (e2e)', () => {
  let app: INestApplication;
  let schoolId: string;

  beforeAll(async () => {
    app = await createTestApp();
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    await resetDb();
    const school = await createTestSchool();
    schoolId = school.id;
  });

  const server = () => app.getHttpServer();

  async function tokenForRole(role: Role): Promise<string> {
    const user = await createTestUser({
      role,
      schoolId: role === Role.SUPER_ADMIN ? null : schoolId,
    });
    return tokenFor(app, user);
  }

  // ---- Authorization ------------------------------------------------------

  describe('authorization', () => {
    const ROUTES: Array<[string, string]> = [
      ['get', '/api/chatbot/status'],
      ['get', '/api/chatbot/chats'],
      ['post', '/api/chatbot/chats'],
    ];

    it.each(ROUTES)('rejects unauthenticated %s %s', async (method, path) => {
      const res = await (request(server()) as any)[method](path).send({});
      expect(res.status).toBe(401);
    });

    it.each([Role.SCHOOL_ADMIN, Role.TEACHER])('allows %s', async (role) => {
      const token = await tokenForRole(role);
      const res = await request(server())
        .get('/api/chatbot/status')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(200);
    });

    it.each([Role.STUDENT, Role.PARENT, Role.SUPER_ADMIN])(
      'forbids %s on every chatbot route',
      async (role) => {
        const token = await tokenForRole(role);
        const auth = `Bearer ${token}`;

        for (const [method, path] of ROUTES) {
          const res = await (request(server()) as any)
            [method](path)
            .set('Authorization', auth)
            .send({});
          expect(res.status).toBe(403);
        }

        // And the per-chat routes, so no id-bearing route is left open.
        const fakeId = '00000000-0000-4000-8000-000000000000';
        for (const res of await Promise.all([
          request(server())
            .get(`/api/chatbot/chats/${fakeId}`)
            .set('Authorization', auth),
          request(server())
            .post(`/api/chatbot/chats/${fakeId}/messages`)
            .set('Authorization', auth)
            .send({ content: 'hi' }),
          request(server())
            .delete(`/api/chatbot/chats/${fakeId}`)
            .set('Authorization', auth),
        ])) {
          expect(res.status).toBe(403);
        }
      },
    );
  });

  // ---- Status -------------------------------------------------------------

  it('reports itself as a non-live, non-persistent demo', async () => {
    const token = await tokenForRole(Role.SCHOOL_ADMIN);
    const res = await request(server())
      .get('/api/chatbot/status')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      provider: 'demo',
      isLive: false,
      persistent: false,
    });
  });

  // ---- Conversation flow --------------------------------------------------

  describe('conversations', () => {
    it('creates an empty chat, then answers a message', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const auth = `Bearer ${token}`;

      const created = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', auth)
        .send({});
      expect(created.status).toBe(201);
      expect(created.body.messages).toEqual([]);
      expect(created.body.title).toBe('New chat');

      const sent = await request(server())
        .post(`/api/chatbot/chats/${created.body.id}/messages`)
        .set('Authorization', auth)
        .send({ content: 'How do I generate a challan?' });

      expect(sent.status).toBe(201);
      expect(sent.body.userMessage.role).toBe('USER');
      expect(sent.body.assistantMessage.role).toBe('ASSISTANT');
      expect(sent.body.matched).toBe(true);
      expect(sent.body.assistantMessage.content).toMatch(/Generate Challans/);
      // The first question names the chat.
      expect(sent.body.title).toBe('How do I generate a challan?');

      const detail = await request(server())
        .get(`/api/chatbot/chats/${created.body.id}`)
        .set('Authorization', auth);
      expect(detail.status).toBe(200);
      expect(detail.body.messages).toHaveLength(2);
    });

    it('starts a chat and answers in one request', async () => {
      const token = await tokenForRole(Role.TEACHER);
      const res = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', `Bearer ${token}`)
        .send({ content: 'ignored', message: 'How do I mark attendance?' })
        .then((r) => r);

      // `content` is not on CreateChatDto and the global ValidationPipe has
      // forbidNonWhitelisted on, so the extra key is rejected outright.
      expect(res.status).toBe(400);
    });

    it('accepts a first message on create', async () => {
      const token = await tokenForRole(Role.TEACHER);
      const res = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'How do I mark attendance?' });

      expect(res.status).toBe(201);
      expect(res.body.messages).toHaveLength(2);
      expect(res.body.title).toBe('How do I mark attendance?');
    });

    it('lists chats newest-first without their message bodies', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const auth = `Bearer ${token}`;

      await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', auth)
        .send({ message: 'How do I add a fee head?' });
      await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', auth)
        .send({ message: 'How do I record a payment?' });

      const list = await request(server())
        .get('/api/chatbot/chats')
        .set('Authorization', auth);

      expect(list.status).toBe(200);
      expect(list.body).toHaveLength(2);
      expect(list.body[0].title).toBe('How do I record a payment?');
      expect(list.body[0].messageCount).toBe(2);
      expect(list.body[0].messages).toBeUndefined();
    });

    it('paginates when asked', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const auth = `Bearer ${token}`;
      for (const q of ['one', 'two', 'three']) {
        await request(server())
          .post('/api/chatbot/chats')
          .set('Authorization', auth)
          .send({ message: q });
      }

      const res = await request(server())
        .get('/api/chatbot/chats?page=1&pageSize=2')
        .set('Authorization', auth);

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({ total: 3, page: 1, pageSize: 2 });
      expect(res.body.items).toHaveLength(2);
    });

    it('deletes a chat', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const auth = `Bearer ${token}`;

      const created = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', auth)
        .send({ message: 'hello' });

      const del = await request(server())
        .delete(`/api/chatbot/chats/${created.body.id}`)
        .set('Authorization', auth);
      expect(del.status).toBe(200);

      const after = await request(server())
        .get(`/api/chatbot/chats/${created.body.id}`)
        .set('Authorization', auth);
      expect(after.status).toBe(404);
    });
  });

  // ---- Ownership ----------------------------------------------------------

  it('never returns another user’s chat, even to a same-school admin', async () => {
    const ownerToken = await tokenForRole(Role.SCHOOL_ADMIN);
    const otherToken = await tokenForRole(Role.SCHOOL_ADMIN);

    const created = await request(server())
      .post('/api/chatbot/chats')
      .set('Authorization', `Bearer ${ownerToken}`)
      .send({ message: 'How do I record a payment?' });
    const chatId = created.body.id;

    for (const res of await Promise.all([
      request(server())
        .get(`/api/chatbot/chats/${chatId}`)
        .set('Authorization', `Bearer ${otherToken}`),
      request(server())
        .post(`/api/chatbot/chats/${chatId}/messages`)
        .set('Authorization', `Bearer ${otherToken}`)
        .send({ content: 'hi' }),
      request(server())
        .delete(`/api/chatbot/chats/${chatId}`)
        .set('Authorization', `Bearer ${otherToken}`),
    ])) {
      expect(res.status).toBe(404);
    }

    // The other user's list is empty — no leakage there either.
    const list = await request(server())
      .get('/api/chatbot/chats')
      .set('Authorization', `Bearer ${otherToken}`);
    expect(list.body).toEqual([]);
  });

  // ---- Validation ---------------------------------------------------------

  describe('invalid requests', () => {
    it('rejects an empty message', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const auth = `Bearer ${token}`;
      const created = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', auth)
        .send({});

      for (const body of [{}, { content: '' }, { content: 'x'.repeat(2001) }]) {
        const res = await request(server())
          .post(`/api/chatbot/chats/${created.body.id}/messages`)
          .set('Authorization', auth)
          .send(body);
        expect(res.status).toBe(400);
      }
    });

    it('rejects a non-uuid chat id', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const res = await request(server())
        .get('/api/chatbot/chats/not-a-uuid')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(400);
    });

    it('404s an unknown chat id', async () => {
      const token = await tokenForRole(Role.SCHOOL_ADMIN);
      const res = await request(server())
        .get('/api/chatbot/chats/00000000-0000-4000-8000-000000000000')
        .set('Authorization', `Bearer ${token}`);
      expect(res.status).toBe(404);
    });
  });

  // ---- Role-aware answers -------------------------------------------------

  it('does not walk a teacher through an admin-only fee workflow', async () => {
    const teacher = await tokenForRole(Role.TEACHER);
    const admin = await tokenForRole(Role.SCHOOL_ADMIN);

    const askAs = async (token: string) => {
      const res = await request(server())
        .post('/api/chatbot/chats')
        .set('Authorization', `Bearer ${token}`)
        .send({ message: 'How do I generate a challan?' });
      return res.body.messages[1].content as string;
    };

    expect(await askAs(admin)).toMatch(/Fee Management/);
    const teacherAnswer = await askAs(teacher);
    expect(teacherAnswer).toMatch(/not available to teachers/i);
    expect(teacherAnswer).not.toMatch(/Preview/);
  });

  it('says plainly that it is a demo when it cannot answer', async () => {
    const token = await tokenForRole(Role.SCHOOL_ADMIN);
    const res = await request(server())
      .post('/api/chatbot/chats')
      .set('Authorization', `Bearer ${token}`)
      .send({ message: 'Write me a poem about the sea' });

    expect(res.status).toBe(201);
    expect(res.body.messages[1].content).toContain('demo mode');
  });
});
