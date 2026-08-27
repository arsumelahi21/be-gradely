import { IsString, MinLength } from 'class-validator';

export class ResetPasswordDto {
  // Format: `${userId}.${rawToken}` — issued by /auth/forgot-password.
  @IsString()
  token: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
