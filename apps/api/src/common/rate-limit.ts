import {
  CanActivate,
  ExecutionContext,
  Global,
  Inject,
  Injectable,
  Module,
  SetMetadata,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request, Response } from 'express';
import { APP_CONFIG, AppConfig } from '../config/config';
import { ApiError } from './api-error';
import { SlidingWindowLimiter } from './rate-limiter';

/**
 * Cupos por minuto y por IP, como fracción del límite base (`PUBLIC_RATE_LIMIT_PER_MIN`). Lo que cuesta
 * más —mandar un correo, probar un código, firmar— tiene menos margen que leer la página.
 */
export type RateBucket = 'default' | 'otp' | 'verify' | 'submit' | 'challenge';
const DIVISOR: Record<RateBucket, number> = { default: 1, otp: 6, verify: 3, submit: 6, challenge: 3 };

/** Intentos con clave de API inválida por IP y minuto antes de empezar a responder 429. */
export const API_KEY_FAILURES_PER_MIN = 20;

const BUCKET_KEY = 'rate-bucket';
export const RateBucketOf = (bucket: RateBucket) => SetMetadata(BUCKET_KEY, bucket);

@Injectable()
export class RateLimitService {
  private readonly pub = new SlidingWindowLimiter();
  private readonly failures = new SlidingWindowLimiter();

  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  limitFor(bucket: RateBucket): number {
    return Math.max(1, Math.ceil(this.config.publicRateLimitPerMin / DIVISOR[bucket]));
  }

  /** Registra una petición pública. Lanza 429 si esa IP excedió el cupo del grupo. */
  checkPublic(ip: string, bucket: RateBucket, res?: Response): void {
    const r = this.pub.hit(`${bucket}|${ip}`, this.limitFor(bucket));
    if (!r.allowed) {
      res?.setHeader('Retry-After', String(r.retryAfterSec));
      throw new ApiError(429, 'RATE_LIMITED', 'Demasiadas peticiones. Espere un momento e intente de nuevo.', {
        retryAfterSeconds: r.retryAfterSec,
      });
    }
  }

  /**
   * Anota un intento con clave de API inválida. Devuelve los segundos de espera si esa IP ya acumuló
   * demasiados (se responde 429 en lugar de 401), o 0. Una clave VÁLIDA nunca se bloquea por esto: no
   * debe poder dejarse sin servicio a un host legítimo que comparte IP con un atacante.
   */
  recordApiKeyFailure(ip: string): number {
    const r = this.failures.hit(ip, API_KEY_FAILURES_PER_MIN);
    return r.allowed ? 0 : r.retryAfterSec;
  }
}

/** Guard para los endpoints públicos de firma: cupo por IP según el grupo de cada ruta. */
@Injectable()
export class PublicRateLimitGuard implements CanActivate {
  constructor(
    private readonly limits: RateLimitService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    const req = context.switchToHttp().getRequest<Request>();
    const res = context.switchToHttp().getResponse<Response>();
    const bucket = this.reflector.get<RateBucket>(BUCKET_KEY, context.getHandler()) ?? 'default';
    this.limits.checkPublic(req.ip ?? 'desconocida', bucket, res);
    return true;
  }
}

@Global()
@Module({
  providers: [RateLimitService, PublicRateLimitGuard],
  exports: [RateLimitService, PublicRateLimitGuard],
})
export class RateLimitModule {}
