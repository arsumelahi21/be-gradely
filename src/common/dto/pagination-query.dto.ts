import { Type } from 'class-transformer';
import { IsInt, IsOptional, Min } from 'class-validator';

/**
 * Shared bounded pagination params for list endpoints (CLAUDE.md standing rule:
 * every list endpoint is paginated). Services clamp pageSize to a hard max.
 */
export class PaginationQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  pageSize?: number;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 200;

/** Normalize raw page/pageSize into a safe { page, pageSize, skip, take }. */
export function resolvePagination(query: {
  page?: number;
  pageSize?: number;
}): { page: number; pageSize: number; skip: number; take: number } {
  const page = query.page && query.page > 0 ? query.page : 1;
  const pageSize = Math.min(
    query.pageSize && query.pageSize > 0 ? query.pageSize : DEFAULT_PAGE_SIZE,
    MAX_PAGE_SIZE,
  );
  return { page, pageSize, skip: (page - 1) * pageSize, take: pageSize };
}
