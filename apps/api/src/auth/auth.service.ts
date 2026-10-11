import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_OWNER } from '../db/db.module';
import { dummyHash, hashPassword, passwordProblem, verifyPassword } from './passwords';
import { SessionUser, USER_COLUMNS, toSessionUser } from './session';
import { ACCESS_MINUTES, PENDING_MINUTES, hashToken, newOpaqueToken, signToken } from './tokens';

/** Fallos de contraseña seguidos antes de cerrar la cuenta un rato, y cuánto dura el cierre. */
const MAX_FAILED_LOGINS = 10;
const LOCK_MINUTES = 5;
/** Vida del refresh (la credencial durable) y ventana en que un token recién reemplazado todavía se tolera (dos pestañas). */
const REFRESH_DAYS = 7;
const ROTATION_GRACE_MS = 20_000;

export interface IssuedSession {
  accessToken: string;
  /** Valor para la cookie; `null` cuando la petición no debe tocar la cookie (carrera tolerada). */
  refreshToken: string | null;
  expiresInSeconds: number;
  user: SessionUser;
}

export type LoginResult =
  | { status: 'ok'; session: IssuedSession }
  /** Contraseña correcta y segundo factor activado: falta el código. */
  | { status: 'mfa_required'; pendingToken: string }
  /** Contraseña correcta, el rol exige segundo factor y aún no lo activó. */
  | { status: 'mfa_setup_required'; pendingToken: string };

interface LoginRow {
  id: string;
  password_hash: string;
  failed_logins: number;
  locked_until: Date | null;
  mfa_enabled_at: Date | null;
  role: string;
  active: boolean;
  tenant_active: boolean | null;
}

/** El segundo factor es obligatorio para el operador de la plataforma (ve y administra a todas las corredoras). */
export const mfaRequiredFor = (role: string): boolean => role === 'OPERATOR';

@Injectable()
export class AuthService {
  private readonly logger = new Logger(AuthService.name);

  constructor(
    @Inject(PG_OWNER) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // ------------------------------------------------------------------ entrada

  async login(email: string, password: string, ip: string | undefined, viaTunnel = false): Promise<LoginResult> {
    const { rows } = await this.pool.query<LoginRow>(
      `SELECT u.id, u.password_hash, u.failed_logins, u.locked_until, u.mfa_enabled_at, u.role, u.active, t.active AS tenant_active
         FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
        WHERE lower(u.email) = lower($1)`,
      [email.trim()],
    );
    const u = rows[0];
    // Cuenta inexistente o de baja: se hace igual el trabajo de hashear para no delatar qué correos existen por el tiempo.
    // Por el túnel público el operador de la plataforma no entra (salvo OPERATOR_ALLOW_REMOTE): se responde como cuenta inexistente.
    const hidden = u?.role === 'OPERATOR' && viaTunnel && !this.config.operatorAllowRemote;
    if (!u || !u.active || u.tenant_active === false || hidden) {
      await verifyPassword(await dummyHash(), password);
      throw this.badCredentials();
    }
    if (u.locked_until && u.locked_until.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((u.locked_until.getTime() - Date.now()) / 60_000));
      throw new ApiError(429, 'ACCOUNT_LOCKED', `Demasiados intentos fallidos. Espere ${minutes} min e intente de nuevo.`, { retryAfterSeconds: minutes * 60 });
    }
    if (!(await verifyPassword(u.password_hash, password))) {
      const failed = u.failed_logins + 1;
      const lock = failed >= MAX_FAILED_LOGINS;
      await this.pool.query(
        `UPDATE users SET failed_logins = $2, locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE locked_until END WHERE id = $1`,
        [u.id, lock ? 0 : failed, lock, LOCK_MINUTES],
      );
      if (lock) this.logger.warn(`Cuenta ${u.id} cerrada ${LOCK_MINUTES} min por ${MAX_FAILED_LOGINS} fallos de contraseña (IP ${ip}).`);
      throw this.badCredentials();
    }
    await this.pool.query('UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);

    if (u.mfa_enabled_at) return { status: 'mfa_required', pendingToken: signToken(this.config.tokenSecret, 'mfa-pending', u.id, PENDING_MINUTES, { stage: 'verify' }) };
    if (mfaRequiredFor(u.role)) return { status: 'mfa_setup_required', pendingToken: signToken(this.config.tokenSecret, 'mfa-pending', u.id, PENDING_MINUTES, { stage: 'setup' }) };
    return { status: 'ok', session: await this.issueSession(u.id, ip) };
  }

  private badCredentials(): ApiError {
    return new ApiError(401, 'INVALID_CREDENTIALS', 'Correo o contraseña incorrectos.');
  }

  /** Abre una sesión nueva (familia nueva) o continúa la familia dada. */
  async issueSession(userId: string, ip: string | undefined, familyId?: string, client?: PoolClient): Promise<IssuedSession> {
    const db = client ?? this.pool;
    const user = await this.loadUser(userId, db);
    const version = (await db.query<{ session_version: number }>('SELECT session_version FROM users WHERE id = $1', [userId])).rows[0].session_version;
    const refresh = newOpaqueToken();
    const id = crypto.randomUUID();
    await db.query(
      `INSERT INTO refresh_tokens (id, user_id, token_hash, family_id, created_ip, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))`,
      [id, userId, hashToken(refresh), familyId ?? id, ip ?? null, REFRESH_DAYS],
    );
    if (!familyId) await db.query('UPDATE users SET last_login_at = now() WHERE id = $1', [userId]);
    return {
      accessToken: signToken(this.config.tokenSecret, 'access', userId, ACCESS_MINUTES, { ver: version }),
      refreshToken: refresh,
      expiresInSeconds: ACCESS_MINUTES * 60,
      user,
    };
  }

  private async loadUser(userId: string, db: Pool | PoolClient = this.pool): Promise<SessionUser> {
    const { rows } = await db.query(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [userId]);
    if (!rows[0]) throw new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida o venció. Vuelva a entrar.');
    return toSessionUser(rows[0]);
  }

  // ------------------------------------------------------------------ renovar

  /**
   * Renueva la sesión a partir del refresh de la cookie, rotándolo. Si llega un token YA reemplazado hace más que la
   * gracia, se presume robo: se cierra la familia entera (quien lo robó y su dueño quedan fuera).
   */
  async refresh(refreshToken: string, ip: string | undefined): Promise<IssuedSession> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const { rows } = await client.query<{ id: string; user_id: string; family_id: string }>('SELECT id, user_id, family_id FROM refresh_tokens WHERE token_hash = $1', [hashToken(refreshToken)]);
      const found = rows[0];
      if (!found) {
        await client.query('ROLLBACK');
        throw this.invalidRefresh();
      }
      // Una sesión (familia) a la vez: dos renovaciones simultáneas no se pisan.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [found.family_id]);
      const { rows: cur } = await client.query<{ revoked_at: Date | null; revoked_reason: string | null; expired: boolean; invalid_after_password: boolean }>(
        `SELECT r.revoked_at, r.revoked_reason, r.expires_at <= now() AS expired,
                (u.active AND (u.tenant_id IS NULL OR t.active)) IS NOT TRUE AS invalid_after_password
           FROM refresh_tokens r JOIN users u ON u.id = r.user_id LEFT JOIN tenants t ON t.id = u.tenant_id
          WHERE r.id = $1`,
        [found.id],
      );
      const r = cur[0];
      if (r.revoked_at) {
        const recent = Date.now() - r.revoked_at.getTime() <= ROTATION_GRACE_MS;
        if (r.revoked_reason === 'rotated' && recent) {
          // Carrera legítima (otra pestaña ya renovó): se da acceso y NO se toca la cookie, que ya tiene la ganadora.
          const user = await this.loadUser(found.user_id, client);
          const ver = (await client.query<{ session_version: number }>('SELECT session_version FROM users WHERE id = $1', [found.user_id])).rows[0].session_version;
          await client.query('COMMIT');
          return { accessToken: signToken(this.config.tokenSecret, 'access', found.user_id, ACCESS_MINUTES, { ver }), refreshToken: null, expiresInSeconds: ACCESS_MINUTES * 60, user };
        }
        if (r.revoked_reason === 'rotated') {
          await client.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'reuse' WHERE family_id = $1 AND revoked_at IS NULL`, [found.family_id]);
          await client.query('COMMIT');
          this.logger.warn(`Reuso de refresh token: se cerró la sesión ${found.family_id} del usuario ${found.user_id} (IP ${ip}).`);
          throw this.invalidRefresh();
        }
        await client.query('ROLLBACK');
        throw this.invalidRefresh();
      }
      if (r.expired || r.invalid_after_password) {
        await client.query('ROLLBACK');
        throw this.invalidRefresh();
      }
      await client.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'rotated' WHERE id = $1`, [found.id]);
      const session = await this.issueSession(found.user_id, ip, found.family_id, client);
      await client.query('COMMIT');
      return session;
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  private invalidRefresh(): ApiError {
    return new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida o venció. Vuelva a entrar.');
  }

  async logout(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.pool.query(
      `UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout'
        WHERE revoked_at IS NULL AND family_id = (SELECT family_id FROM refresh_tokens WHERE token_hash = $1)`,
      [hashToken(refreshToken)],
    );
  }

  // --------------------------------------------------------------- contraseña

  /** Cambia la contraseña conociendo la actual. Cierra TODAS las sesiones y abre una nueva para quien la cambió. */
  async changePassword(userId: string, current: string, next: string, ip: string | undefined): Promise<IssuedSession> {
    const { rows } = await this.pool.query<{ password_hash: string; email: string }>('SELECT password_hash, email FROM users WHERE id = $1', [userId]);
    if (!rows[0] || !(await verifyPassword(rows[0].password_hash, current))) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'La contraseña actual no es correcta.');
    }
    if (await verifyPassword(rows[0].password_hash, next)) throw new ApiError(422, 'VALIDATION_ERROR', 'La contraseña nueva debe ser distinta de la actual.');
    const problem = passwordProblem(next, rows[0].email);
    if (problem) throw new ApiError(422, 'VALIDATION_ERROR', problem);
    await this.setPassword(userId, next, false);
    return this.issueSession(userId, ip);
  }

  /** Fija una contraseña y corta todas las sesiones vivas del usuario (access y refresh). */
  async setPassword(userId: string, password: string, mustChange: boolean): Promise<void> {
    const hash = await hashPassword(password);
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE users SET password_hash = $2, must_change_password = $3, failed_logins = 0, locked_until = NULL,
                session_version = session_version + 1
          WHERE id = $1`,
        [userId, hash, mustChange],
      );
      await client.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
  }

  /** Cierra todas las sesiones de un usuario (baja, sospecha). */
  async revokeAllSessions(userId: string): Promise<void> {
    await this.pool.query(`UPDATE users SET session_version = session_version + 1 WHERE id = $1`, [userId]);
    await this.pool.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'logout' WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
  }
}
