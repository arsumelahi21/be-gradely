import { canMessage } from './permission-matrix';
import { Role } from '../common/types/role.type';

const ALL: Role[] = [
  Role.SUPER_ADMIN,
  Role.SCHOOL_ADMIN,
  Role.TEACHER,
  Role.PARENT,
  Role.STUDENT,
];
const WITHIN_SCHOOL: Role[] = [
  Role.SCHOOL_ADMIN,
  Role.TEACHER,
  Role.PARENT,
  Role.STUDENT,
];

describe('canMessage permission matrix (open within school)', () => {
  it('lets any within-school role message any other, including student↔student', () => {
    for (const a of WITHIN_SCHOOL) {
      for (const b of WITHIN_SCHOOL) {
        expect(canMessage(a, b)).toBe(true);
      }
    }
    // spot-checks the previously-forbidden peer pairs
    expect(canMessage(Role.STUDENT, Role.STUDENT)).toBe(true);
    expect(canMessage(Role.PARENT, Role.PARENT)).toBe(true);
    expect(canMessage(Role.STUDENT, Role.PARENT)).toBe(true);
  });

  it('does not let teacher/parent/student reach the cross-school super-admin', () => {
    for (const sender of [Role.TEACHER, Role.PARENT, Role.STUDENT]) {
      expect(canMessage(sender, Role.SUPER_ADMIN)).toBe(false);
    }
  });

  it('pairs super-admin only with school admins (both directions)', () => {
    expect(canMessage(Role.SUPER_ADMIN, Role.SCHOOL_ADMIN)).toBe(true);
    expect(canMessage(Role.SCHOOL_ADMIN, Role.SUPER_ADMIN)).toBe(true);
    for (const r of [
      Role.TEACHER,
      Role.PARENT,
      Role.STUDENT,
      Role.SUPER_ADMIN,
    ]) {
      expect(canMessage(Role.SUPER_ADMIN, r)).toBe(false);
    }
  });

  it('returns a boolean for every role pair (total function, no undefined)', () => {
    for (const a of ALL) {
      for (const b of ALL) {
        expect(typeof canMessage(a, b)).toBe('boolean');
      }
    }
  });
});
