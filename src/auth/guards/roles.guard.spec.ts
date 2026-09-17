import { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Role } from '../../common/types/role.type';
import { RolesGuard } from './roles.guard';

const ctxFor = (role?: Role) =>
  ({
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({
      getRequest: () => ({ user: role ? { role } : null }),
    }),
  }) as unknown as ExecutionContext;

describe('RolesGuard', () => {
  const guardWith = (required: Role[] | undefined) => {
    const reflector = {
      getAllAndOverride: () => required,
    } as unknown as Reflector;
    return new RolesGuard(reflector);
  };

  it('admits a role listed on the handler', () => {
    expect(guardWith([Role.TEACHER]).canActivate(ctxFor(Role.TEACHER))).toBe(
      true,
    );
  });

  it('refuses a role not listed', () => {
    expect(guardWith([Role.TEACHER]).canActivate(ctxFor(Role.STUDENT))).toBe(
      false,
    );
  });

  // The bug: a handler under this guard with no @Roles used to admit everyone.
  it('fails CLOSED when a handler declares no roles', () => {
    expect(guardWith(undefined).canActivate(ctxFor(Role.STUDENT))).toBe(false);
    expect(guardWith([]).canActivate(ctxFor(Role.SUPER_ADMIN))).toBe(false);
  });
});
