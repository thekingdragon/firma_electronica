import { CanActivate, createParamDecorator, ExecutionContext, Inject, Injectable, SetMetadata } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_OWNER } from '../db/db.module';
import { Role, SessionUser, bearerToken, invalidSession, userFromAccessToken } from './session';

export type UserRequest = Request & { user?: SessionUser };

const ROLES_KEY = 'auth-roles';
const ALLOW_MUST_CHANGE_KEY = 'auth-allow-must-change';

/** Restringe una ruta a ciertos roles. Una clave de API de integración cuenta como ADMIN de su corredora. */
export const Roles = (...roles: Role[]) => SetMetadata(ROLES_KEY, roles);
/** Rutas que un usuario con contraseña provisional SÍ puede usar (cambiarla, ver quién es, salir). */
export const AllowMustChange = () => SetMetadata(ALLOW_MUST_CHANGE_KEY, true);

/** Autentica a un usuario del panel por access token (cualquier rol, con o sin corredora). */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    @Inject(PG_OWNER) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly reflector: Reflector,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<UserRequest>();
    const token = bearerToken(req.header('authorization'));
    const user = token ? await userFromAccessToken(this.pool, this.config.tokenSecret, token) : null;
    if (!user) throw invalidSession();
    enforce(this.reflector, context, user);
    req.user = user;
    return true;
  }
}

/** Reglas comunes a todo usuario del panel: contraseña provisional y rol. */
export function enforce(reflector: Reflector, context: ExecutionContext, user: SessionUser): void {
  const handlerAndClass = [context.getHandler(), context.getClass()];
  if (user.mustChangePassword && !reflector.getAllAndOverride<boolean>(ALLOW_MUST_CHANGE_KEY, handlerAndClass)) {
    throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Debe cambiar su contraseña provisional antes de continuar.');
  }
  const roles = reflector.getAllAndOverride<Role[] | undefined>(ROLES_KEY, handlerAndClass);
  if (roles && !roles.includes(user.role)) throw new ApiError(403, 'FORBIDDEN_ROLE', 'Su rol no permite esta acción.');
}

/** El usuario autenticado por AccessGuard (o por ApiKeyGuard cuando entró con sesión). */
export const CurrentUser = createParamDecorator((_: unknown, ctx: ExecutionContext): SessionUser => {
  const user = ctx.switchToHttp().getRequest<UserRequest>().user;
  if (!user) throw new Error('CurrentUser usado en una ruta sin guard de sesión.');
  return user;
});
