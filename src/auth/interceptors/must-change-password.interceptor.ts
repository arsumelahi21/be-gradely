import {
  CallHandler,
  ExecutionContext,
  ForbiddenException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';
import { ALLOW_WITH_TEMPORARY_PASSWORD } from '../decorators/allow-with-temporary-password.decorator';

/**
 * An admin-issued password is a one-time credential, so the session it opens may
 * only spend itself on setting a real one.
 *
 * An interceptor rather than a guard because an APP_GUARD runs BEFORE each
 * controller's own JwtAuthGuard, so `req.user` does not exist yet at that point;
 * interceptors run after every guard.
 */
@Injectable()
export class MustChangePasswordInterceptor implements NestInterceptor {
  constructor(private readonly reflector: Reflector) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const user = context.switchToHttp().getRequest<{
      user?: { mustChangePassword?: boolean };
    }>().user;

    if (user?.mustChangePassword) {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        ALLOW_WITH_TEMPORARY_PASSWORD,
        [context.getHandler(), context.getClass()],
      );
      if (!allowed)
        throw new ForbiddenException(
          'Set a new password before using the app.',
        );
    }

    return next.handle();
  }
}
