import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { MailService } from '../mail/mail.service';
import { AuthService } from './auth.service';
import { passwordProblem } from './passwords';
import { hashToken, newOpaqueToken } from './tokens';

const RESET_MINUTES = 60;

/**
 * Recuperación de contraseña por correo. Tres decisiones heredadas de Polix:
 *  - `request` responde SIEMPRE lo mismo, exista o no el correo (no delata qué cuentas hay).
 *  - El enlace es de un solo uso, vence en una hora y en la base solo queda su hash.
 *  - Restablecer corta todas las sesiones de la cuenta. El segundo factor NO se salta: sigue pidiéndose al entrar.
 *
 * El correo sale por el SMTP de la corredora del usuario. El operador de la plataforma no pertenece a ninguna, así que
 * no tiene correo desde el cual recibirlo: su restablecimiento se hace por línea de comandos (`operator:reset`).
 */
@Injectable()
export class PasswordResetService {
  private readonly logger = new Logger(PasswordResetService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mail: MailService,
    private readonly auth: AuthService,
  ) {}

  async request(email: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string; tenant_id: string | null; name: string }>(
      `SELECT u.id, u.tenant_id, u.name FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE lower(u.email) = lower($1) AND u.active AND (u.tenant_id IS NULL OR t.active)`,
      [email.trim()],
    );
    const u = rows[0];
    if (!u || !u.tenant_id) return;
    // Un solo enlace vivo por cuenta: pedir otro anula el anterior.
    await this.pool.query('UPDATE password_resets SET used_at = now() WHERE user_id = $1 AND used_at IS NULL', [u.id]);
    const token = newOpaqueToken();
    await this.pool.query(`INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, now() + make_interval(mins => $3))`, [u.id, hashToken(token), RESET_MINUTES]);
    const link = `${this.config.publicBaseUrl}/restablecer?token=${token}`;
    try {
      await this.mail.send(u.tenant_id, {
        to: email.trim(),
        subject: 'Restablecer su contraseña',
        text: `Hola ${u.name}:\n\nPara elegir una contraseña nueva abra este enlace (vale ${RESET_MINUTES} minutos y se usa una sola vez):\n\n${link}\n\nSi usted no lo pidió, ignore este correo: su contraseña no cambia.`,
      });
    } catch (e) {
      // No se le dice a quien pide que falló: eso también delataría que la cuenta existe. Queda en el log.
      this.logger.warn(`No se pudo enviar el restablecimiento al usuario ${u.id}: ${(e as Error).message}`);
    }
  }

  async complete(token: string, password: string): Promise<void> {
    const { rows } = await this.pool.query<{ id: string; user_id: string; email: string }>(
      `SELECT r.id, r.user_id, u.email FROM password_resets r JOIN users u ON u.id = r.user_id
        WHERE r.token_hash = $1 AND r.used_at IS NULL AND r.expires_at > now() AND u.active`,
      [hashToken(token)],
    );
    const r = rows[0];
    if (!r) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'El enlace no es válido o venció. Pida uno nuevo.');
    const problem = passwordProblem(password, r.email);
    if (problem) throw new ApiError(422, 'VALIDATION_ERROR', problem);
    // Se marca usado ANTES de cambiar la contraseña, con condición: dos usos simultáneos no pasan los dos.
    const used = await this.pool.query('UPDATE password_resets SET used_at = now() WHERE id = $1 AND used_at IS NULL', [r.id]);
    if (used.rowCount !== 1) throw new ApiError(400, 'INVALID_RESET_TOKEN', 'El enlace no es válido o venció. Pida uno nuevo.');
    await this.auth.setPassword(r.user_id, password, false);
  }
}
