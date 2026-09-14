import { ArgumentsHost, HttpStatus } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaExceptionFilter } from './prisma-exception.filter';

/**
 * This filter decides what a user sees when the database misbehaves, so the
 * wording is part of its contract, not decoration.
 *
 * The case that motivated these tests: a login against an unreachable database
 * was reported as "Something went wrong while saving. Please try again." on the
 * sign-in screen — a write-shaped message for a read, and a 500 for what is
 * really a 503. Anyone debugging that goes looking at the login code instead of
 * at the database connection.
 */
describe('PrismaExceptionFilter', () => {
  const filter = new PrismaExceptionFilter();

  /** Captures what the filter would send, without an HTTP server. */
  function run(exception: unknown) {
    const json = jest.fn();
    const status = jest.fn().mockReturnValue({ json });
    const host = {
      switchToHttp: () => ({ getResponse: () => ({ status }) }),
    } as unknown as ArgumentsHost;

    // The filter logs unhandled errors; keep the suite output clean.
    jest.spyOn(filter['logger'], 'error').mockImplementation(() => undefined);

    filter.catch(exception, host);
    return {
      status: status.mock.calls[0][0] as number,
      body: json.mock.calls[0][0] as { statusCode: number; message: string },
    };
  }

  const known = (code: string, meta?: Record<string, unknown>) =>
    new Prisma.PrismaClientKnownRequestError('boom', {
      code,
      clientVersion: 'test',
      meta,
    });

  describe('database is unreachable', () => {
    // Every one of these means "the database, not your request" — and every one
    // of them can land on a plain read.
    const codes = [
      'P1000',
      'P1001',
      'P1002',
      'P1008',
      'P1010',
      'P1011',
      'P1017',
      'P2024',
    ];

    it.each(codes)('%s is 503, not 500', (code) => {
      expect(run(known(code)).status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });

    it.each(codes)('%s never claims the failure was a save', (code) => {
      expect(run(known(code)).body.message).not.toMatch(/saving/i);
    });

    it('an initialization error is caught rather than escaping as a bare 500', () => {
      const res = run(
        new Prisma.PrismaClientInitializationError(
          "Can't reach database server at `localhost:5433`",
          'test',
          'P1001',
        ),
      );
      expect(res.status).toBe(HttpStatus.SERVICE_UNAVAILABLE);
      expect(res.body.message).toMatch(/database/i);
    });

    it('does not leak the connection string or host into the response', () => {
      const res = run(
        new Prisma.PrismaClientInitializationError(
          'Authentication failed against database server at `gradely-prod.rds.amazonaws.com`, the provided password for `admin` is not valid',
          'test',
          'P1000',
        ),
      );
      expect(res.body.message).not.toMatch(/amazonaws|password|admin/i);
    });
  });

  describe('request-level failures keep their specific meaning', () => {
    it('P2002 is a 409 naming the field', () => {
      const res = run(known('P2002', { target: ['email'] }));
      expect(res.status).toBe(HttpStatus.CONFLICT);
      expect(res.body.message).toContain('email');
    });

    it('P2025 is a 404', () => {
      expect(run(known('P2025')).status).toBe(HttpStatus.NOT_FOUND);
    });

    it('P2003 is a 409', () => {
      expect(run(known('P2003')).status).toBe(HttpStatus.CONFLICT);
    });

    it('P2014 is a 409', () => {
      expect(run(known('P2014')).status).toBe(HttpStatus.CONFLICT);
    });

    it('a validation error is a 400, not a 500', () => {
      const res = run(
        new Prisma.PrismaClientValidationError('bad shape', {
          clientVersion: 'test',
        }),
      );
      expect(res.status).toBe(HttpStatus.BAD_REQUEST);
    });
  });

  describe('the generic fallback', () => {
    it('is a 500 that does not assume a write', () => {
      const res = run(known('P2037')); // too many connections — unmapped
      expect(res.status).toBe(HttpStatus.INTERNAL_SERVER_ERROR);
      expect(res.body.message).not.toMatch(/saving/i);
    });

    it('reports the status in the body too, so the client can branch on it', () => {
      const res = run(known('P1001'));
      expect(res.body.statusCode).toBe(HttpStatus.SERVICE_UNAVAILABLE);
    });
  });
});
