import { IsBoolean, IsOptional, IsString, IsUrl } from 'class-validator';

export class CreateSocialLinkDto {
  @IsString()
  platform: string;

  @IsUrl()
  url: string;

  @IsOptional()
  @IsString()
  label?: string;

  @IsOptional()
  @IsBoolean()
  isActive?: boolean;
}
