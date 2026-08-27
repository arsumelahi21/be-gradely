import { IsString, MinLength } from 'class-validator';

// Self-service password change payload for PATCH /users/me/password.
export class ChangePasswordDto {
  @IsString()
  currentPassword: string;

  @IsString()
  @MinLength(8)
  newPassword: string;
}
