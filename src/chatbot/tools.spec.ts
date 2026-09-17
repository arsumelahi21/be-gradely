import { Role } from '../common/types/role.type';
import { CHAT_TOOLS, toolsFor } from './tools';

/**
 * The tool list is the model's whole reachable surface, so what each role may
 * see is a security boundary, not a convenience.
 */
describe('chat tools', () => {
  it('never shows a teacher the school-wide fee tools', () => {
    const names = toolsFor(Role.TEACHER).map((t) => t.name);

    expect(names).not.toContain('outstanding_fees');
    expect(names).not.toContain('fee_summary');
    expect(names).not.toContain('fees_by_class');
    expect(names).not.toContain('school_counts');
  });

  it('gives a teacher their own classes and timetable', () => {
    const names = toolsFor(Role.TEACHER).map((t) => t.name);

    expect(names).toContain('my_classes');
    expect(names).toContain('my_timetable');
  });

  it('keeps my_classes away from an admin, who has no classes of their own', () => {
    expect(toolsFor(Role.SCHOOL_ADMIN).map((t) => t.name)).not.toContain(
      'my_classes',
    );
  });

  // Students and parents cannot reach the chatbot at all (the controller's
  // @Roles), but a tool list for them must still be empty rather than default-on.
  it.each([Role.STUDENT, Role.PARENT])('exposes nothing to %s', (role) => {
    expect(toolsFor(role)).toHaveLength(0);
  });

  it('declares a name, description and schema for every tool', () => {
    for (const tool of CHAT_TOOLS) {
      expect(tool.name).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.input.type).toBe('object');
      expect(tool.roles.length).toBeGreaterThan(0);
    }
  });

  it('has no duplicate tool names', () => {
    const names = CHAT_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });
});
