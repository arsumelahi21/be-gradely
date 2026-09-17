import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Role } from '../../common/types/role.type';

@Injectable()
export class RolesGuard implements CanActivate {
  constructor(private reflector: Reflector) {}

  canActivate(ctx: ExecutionContext): boolean {
    const required = this.reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
      ctx.getHandler(),
      ctx.getClass(),
    ]);
    // Fail CLOSED: a handler under this guard with no @Roles used to admit every
    // authenticated role, so forgetting the decorator silently published a route.
    // Handlers that genuinely serve all roles say so with @Roles(...ALL_ROLES).
    if (!required || required.length === 0) return false;

    const req = ctx.switchToHttp().getRequest();
    const user = req.user as { role?: Role };
    return !!user?.role && required.includes(user.role);
  }
}
