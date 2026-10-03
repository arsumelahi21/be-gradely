import { CanActivate, ExecutionContext, Injectable } from '@nestjs/common';
import { DirectorService } from './director.service';

/**
 * Must run after JwtAuthGuard and RolesGuard. Handlers read `req.directorScope` only and
 * never call scope() themselves, so a forgotten call cannot skip the check.
 */
@Injectable()
export class DirectorScopeGuard implements CanActivate {
  constructor(private director: DirectorService) {}

  async canActivate(ctx: ExecutionContext): Promise<boolean> {
    const req = ctx.switchToHttp().getRequest();
    req.directorScope = await this.director.scope(req.user.userId);
    return true;
  }
}
