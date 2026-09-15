import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { Role } from '../common/types/role.type';
import { ExamsController } from './exams.controller';
import { ExamResultsController } from './exam-results.controller';
import { ExamSettingsController } from './exam-settings.controller';

// RolesGuard lets ANY logged-in user through a handler without @Roles, so a forgotten
// decorator on an exam route would be a silent data leak. This fails the build instead.
const controllers = [ExamsController, ExamResultsController, ExamSettingsController];

function handlers(controller: { prototype: object }) {
  const proto = controller.prototype as Record<string, unknown>;
  return Object.getOwnPropertyNames(proto)
    .filter((name) => name !== 'constructor' && typeof proto[name] === 'function')
    .map((name) => ({ name, fn: proto[name] as object }));
}

describe('exam controllers', () => {
  it.each(controllers.flatMap((c) => handlers(c).map((h) => [`${c.name}.${h.name}`, h.fn] as const)))(
    '%s declares @Roles',
    (_label, fn) => {
      const roles = Reflect.getMetadata(ROLES_KEY, fn) as Role[] | undefined;
      expect(roles?.length).toBeGreaterThan(0);
    },
  );

  it('never lets a student or parent reach the exam paper', () => {
    const proto = ExamsController.prototype as unknown as Record<string, object>;
    for (const name of ['readPaper', 'uploadPaper', 'removePaper']) {
      const roles = Reflect.getMetadata(ROLES_KEY, proto[name]) as Role[];
      expect(roles).toEqual(expect.not.arrayContaining([Role.STUDENT, Role.PARENT, Role.SUPER_ADMIN]));
    }
  });

  it('keeps publishing, review and finalization for the principal only', () => {
    const exams = ExamsController.prototype as unknown as Record<string, object>;
    const results = ExamResultsController.prototype as unknown as Record<string, object>;
    for (const fn of [exams.publish, exams.requestChanges, exams.reject, results.finalize, results.reopen]) {
      expect(Reflect.getMetadata(ROLES_KEY, fn)).toEqual([Role.SCHOOL_ADMIN]);
    }
    expect(Reflect.getMetadata(ROLES_KEY, exams.submit)).toEqual([Role.TEACHER]);
  });
});
