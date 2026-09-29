import { randomInt } from 'crypto';

// Read aloud at the office desk or copied off a slip, so no 0/O, 1/I/L pairs.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const GROUPS = 3;
const GROUP_LENGTH = 4;

/**
 * One-time password an admin hands over. 12 characters of a 31-symbol alphabet
 * (~59 bits) — it only has to survive until the holder sets their own.
 */
export function generateTemporaryPassword(): string {
  return Array.from({ length: GROUPS }, () =>
    Array.from(
      { length: GROUP_LENGTH },
      () => ALPHABET[randomInt(ALPHABET.length)],
    ).join(''),
  ).join('-');
}
