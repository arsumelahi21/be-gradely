import { SetMetadata } from '@nestjs/common';

export const ALLOW_WITH_TEMPORARY_PASSWORD = 'allowWithTemporaryPassword';

/** Reachable while `mustChangePassword` is set — the routes a user needs to clear it. */
export const AllowWithTemporaryPassword = () =>
  SetMetadata(ALLOW_WITH_TEMPORARY_PASSWORD, true);
