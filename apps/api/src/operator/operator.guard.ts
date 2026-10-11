import { CanActivate, ExecutionContext, Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Request } from 'express';
import { ApiError } from '../common/api-error';
import { RateLimitService } from '../common/rate-limit';
import { APP_CONFIG, AppConfig } from '../config/config';

const digest = (s: string) => createHash('sha256').update(s).digest();

/**
 * Protege el panel de operador (quien administra el servicio entero). Es una credencial distinta de las claves de
 * API de las corredoras: una clave de tenant nunca abre estas rutas. Sin `OPERATOR_KEY` el panel NO EXISTE (404).
 * Por defecto tampoco acepta lo que llegue por el túnel de Cloudflare (`OPERATOR_ALLOW_REMOTE`).
 */
@Injectable()
export class OperatorGuard implements CanActivate {
  private readonly logger = new Logger(OperatorGuard.name);

  constructor(
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly limits: RateLimitService,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse();
    if (!this.config.operatorKey) throw new ApiError(404, 'OPERATOR_DISABLED', 'El panel de operador no está habilitado.');
    // El túnel agrega esta cabecera; una petición local no la trae. Se responde igual que si no existiera.
    if (!this.config.operatorAllowRemote && req.header('cf-connecting-ip')) {
      this.logger.warn(`Panel de operador pedido por el túnel (${req.header('cf-connecting-ip')}): rechazado`);
      throw new ApiError(404, 'OPERATOR_DISABLED', 'El panel de operador no está habilitado.');
    }
    const key = req.header('x-operator-key');
    if (key && timingSafeEqual(digest(key), digest(this.config.operatorKey))) return true;
    this.logger.warn(`Clave de operador ausente o inválida desde ${req.ip}`);
    const wait = this.limits.recordApiKeyFailure(`operador|${req.ip ?? 'desconocida'}`);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      throw new ApiError(429, 'RATE_LIMITED', 'Demasiados intentos con una clave inválida. Espere un momento.', { retryAfterSeconds: wait });
    }
    throw new ApiError(401, 'INVALID_OPERATOR_KEY', 'Clave de operador ausente o inválida.');
  }
}
