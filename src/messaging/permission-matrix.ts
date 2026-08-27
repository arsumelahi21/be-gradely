import { Role } from '../common/types/role.type';

/**
 * Who may open a DIRECT thread with whom, by role pair (same-school boundary enforced
 * separately in MessagingService.assertCanReach). Open within a school; the one cross-school pair is SUPER_ADMIN<->SCHOOL_ADMIN.
 */
const WITHIN_SCHOOL: ReadonlySet<Role> = new Set([
  Role.SCHOOL_ADMIN,
  Role.TEACHER,
  Role.PARENT,
  Role.STUDENT,
]);

const ALLOW: Record<Role, ReadonlySet<Role>> = {
  [Role.SUPER_ADMIN]: new Set([Role.SCHOOL_ADMIN]),
  [Role.SCHOOL_ADMIN]: new Set([Role.SUPER_ADMIN, ...WITHIN_SCHOOL]),
  [Role.TEACHER]: WITHIN_SCHOOL,
  [Role.PARENT]: WITHIN_SCHOOL,
  [Role.STUDENT]: WITHIN_SCHOOL,
};

export function canMessage(senderRole: Role, recipientRole: Role): boolean {
  return ALLOW[senderRole]?.has(recipientRole) ?? false;
}
