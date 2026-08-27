/**
 * Per-school cache: all filtered/paged variants of one school+entity share one
 * prefix, cleared via `delByPrefix` on write. TTL is just a backstop — logout does NOT touch this (tenant data, not session).
 */
export const SCHOOL_CACHE_TTL_SECONDS = 300;

export type SchoolCacheEntity =
  | 'subjects'
  | 'sections'
  | 'classes'
  | 'teachers'
  | 'students'
  // The generic admin users list (all roles). Any user write clears it.
  | 'users';

export function schoolCachePrefix(
  schoolId: string,
  entity: SchoolCacheEntity,
): string {
  return `school:${schoolId}:${entity}:`;
}

export function schoolCacheKey(
  schoolId: string,
  entity: SchoolCacheEntity,
  variant: unknown = 'all',
): string {
  const v =
    typeof variant === 'string' ? variant : JSON.stringify(variant ?? 'all');
  return `${schoolCachePrefix(schoolId, entity)}${v}`;
}

/**
 * Maps a User role to the cache entity its create/update/delete should invalidate.
 * Students/teachers go through `POST /users`, so users.service needs this too.
 */
export function schoolCacheEntityForRole(
  role: string,
): SchoolCacheEntity | null {
  if (role === 'STUDENT') return 'students';
  if (role === 'TEACHER') return 'teachers';
  return null;
}
