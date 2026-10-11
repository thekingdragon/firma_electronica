import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import type { Request } from 'express';
import { Pool } from 'pg';
import { UserRequest } from '../auth/access.guard';
import { bearerToken, invalidSession, userFromAccessToken } from '../auth/session';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';

/**
 * Protege el panel de operador (quien administra el servicio entero): exige una SESIÓN de un usuario con rol OPERATOR,
 * que además tiene el segundo factor obligatorio. Una clave de API de corredora o una sesión de corredora nunca lo abre.
 * Por defecto tampoco acepta lo que llegue por el túnel de Cloudflare (`OPERATOR_ALLOW_REMOTE`): se responde 404,
 * como si el panel no existiera.
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  private readonly logger = new Logger(OperatorGuard.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<UserRequest & Request>();
    if (!this.config.operatorAllowRemote && req.header('cf-connecting-ip')) {
      this.logger.warn(`Panel de operador pedido por el túnel (${req.header('cf-connecting-ip')}): rechazado`);
      throw new ApiError(404, 'OPERATOR_DISABLED', 'El panel de operador no está habilitado.');
    }
    const token = bearerToken(req.header('authorization'));
    const user = token ? await userFromAccessToken(this.pool, this.config.tokenSecret, token) : null;
    if (!user) throw invalidSession();
    if (user.role !== 'OPERATOR') throw new ApiError(403, 'FORBIDDEN_ROLE', 'Esta sección es solo para el operador de la plataforma.');
    if (user.mustChangePassword) throw new ApiError(403, 'PASSWORD_CHANGE_REQUIRED', 'Debe cambiar su contraseña provisional antes de continuar.');
    req.user = user;
    return true;
  }
}
