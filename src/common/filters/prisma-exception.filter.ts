import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { Response } from 'express';

/**
 * Turns a Prisma error into a clean HTTP response.
 *
 * Nothing here is a workaround for referential integrity — the schema decides
 * what a delete cascades (see `scripts/fk-audit.mjs`). This exists so a genuine
 * database failure reaches the client as a structured message instead of a raw
 * driver dump, which previously surfaced as a bare 500 carrying SQL internals.
 *
 * Anything unrecognised is logged in full server-side and reported as a generic
 * 500: the details belong in the log, not in the browser.
 */
@Catch(
  Prisma.PrismaClientKnownRequestError,
  Prisma.PrismaClientValidationError,
  Prisma.PrismaClientUnknownRequestError,
  // An unreachable/misconfigured database throws these, NOT a request error.
  // Without them a DB outage escaped as a bare Nest 500 with no useful message.
  Prisma.PrismaClientInitializationError,
  Prisma.PrismaClientRustPanicError,
)
export class PrismaExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(PrismaExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    const { status, message } = this.translate(exception);

    // 503 included: an outage is an operational failure, and the log is the
    // only place the real cause (bad host, wrong credentials) is recorded.
    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error(
        `unhandled Prisma error: ${
          exception instanceof Error ? exception.stack : String(exception)
        }`,
      );
    }

    res.status(status).json({
      statusCode: status,
      message,
      error: HttpStatus[status],
    });
  }

  /**
   * The database is unreachable, unauthenticated or out of connections —
   * nothing to do with the request itself. These MUST NOT be reported as a
   * failed write: they surface on reads too (a login is the obvious one), and
   * "something went wrong while saving" on a sign-in screen sends whoever sees
   * it looking in entirely the wrong place.
   */
  private static readonly UNAVAILABLE_CODES = new Set([
    'P1000', // authentication failed against the database server
    'P1001', // can't reach database server
    'P1002', // reached, but timed out
    'P1008', // operation timed out
    'P1010', // access denied for the user
    'P1011', // TLS connection error
    'P1017', // server has closed the connection
    'P2024', // timed out fetching a connection from the pool
  ]);

  private translate(exception: unknown): {
    status: HttpStatus;
    message: string;
  } {
    if (exception instanceof Prisma.PrismaClientInitializationError) {
      return this.unavailable();
    }

    if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (PrismaExceptionFilter.UNAVAILABLE_CODES.has(exception.code)) {
        return this.unavailable();
      }
      switch (exception.code) {
        case 'P2002':
          return {
            status: HttpStatus.CONFLICT,
            message: `That ${this.targetOf(exception)} is already taken.`,
          };
        case 'P2025':
          return {
            status: HttpStatus.NOT_FOUND,
            message: 'That record no longer exists.',
          };
        // A remaining referential constraint. With the cascade rules in place
        // this should be unreachable on a delete; if it fires, the schema and
        // the operation disagree and the log above is the thing to read.
        case 'P2003':
          return {
            status: HttpStatus.CONFLICT,
            message:
              'That record is still linked to other data and could not be removed. Please refresh and try again.',
          };
        case 'P2014':
          return {
            status: HttpStatus.CONFLICT,
            message:
              'That change would break a required relationship between records.',
          };
        default:
          return {
            status: HttpStatus.INTERNAL_SERVER_ERROR,
            // Deliberately not "while saving" — this branch catches reads too.
            message: 'Something went wrong. Please try again.',
          };
      }
    }

    if (exception instanceof Prisma.PrismaClientValidationError) {
      return {
        status: HttpStatus.BAD_REQUEST,
        message: 'The request was not in the expected shape.',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      message: 'Something went wrong. Please try again.',
    };
  }

  /** 503, so a caller can tell "try again shortly" from "your request was bad". */
  private unavailable(): { status: HttpStatus; message: string } {
    return {
      status: HttpStatus.SERVICE_UNAVAILABLE,
      message:
        'Cannot reach the database right now. Please try again in a moment.',
    };
  }

  /** The unique field(s) a P2002 names, for a message a user can act on. */
  private targetOf(e: Prisma.PrismaClientKnownRequestError): string {
    const target = (e.meta as { target?: string[] | string } | undefined)
      ?.target;
    if (Array.isArray(target)) return target.join(' + ');
    if (typeof target === 'string') return target;
    return 'value';
  }
}
