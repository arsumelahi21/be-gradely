import { SetMetadata } from '@nestjs/common';
import { Role } from '../types/role.type';

export const ROLES_KEY = 'roles';
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);

/**
 * Every role — for the handful of authenticated routes that really do serve all
 * of them. `RolesGuard` fails closed, so "any role" has to be stated, not implied
 * by an absent decorator.
 */
export const ALL_ROLES: Role[] = [
  Role.SUPER_ADMIN,
  Role.SCHOOL_ADMIN,
  Role.TEACHER,
  Role.PARENT,
  Role.STUDENT,
];
