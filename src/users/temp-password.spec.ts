import { generateTemporaryPassword } from './temp-password';

describe('generateTemporaryPassword', () => {
  it('produces three dash-separated groups of four unambiguous characters', () => {
    // No I, L, O, 0 or 1 — the pairs that get misheard or mistyped.
    expect(generateTemporaryPassword()).toMatch(
      /^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/,
    );
  });

  it('clears the 8-character minimum the change-password DTO enforces', () => {
    expect(generateTemporaryPassword().length).toBeGreaterThanOrEqual(8);
  });

  it('does not repeat itself', () => {
    const drawn = new Set(
      Array.from({ length: 200 }, () => generateTemporaryPassword()),
    );
    expect(drawn.size).toBe(200);
  });
});
