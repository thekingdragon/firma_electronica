import { Inject, Injectable, Logger } from '@nestjs/common';
import * as argon2 from 'argon2';
import { randomInt } from 'node:crypto';
import { Pool } from 'pg';
import * as QRCode from 'qrcode';
import { ApiError } from '../common/api-error';
import { open, seal } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_OWNER } from '../db/db.module';
import { AuthService, IssuedSession, mfaRequiredFor } from './auth.service';
import { verifyPassword } from './passwords';
import { formatSecretForHuman, generateSecret, otpauthUri, verifyTotp } from './totp';
import { verifyToken } from './tokens';

/** Mismos valores y razones que Polix: cinco fallos seguidos cierran el segundo factor quince minutos. */
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;
const RECOVERY_CODES = 10;
const RECOVERY_LENGTH = 10;
/** Sin 0/O/1/I/L: se confunden al copiar un código a mano. */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export interface TotpSetup {
  /** PNG en data URI, listo para un <img>. */
  qr: string;
  /** El secreto en grupos de cuatro, para teclear a mano cuando la cámara falla. */
  secret: string;
  otpauthUri: string;
}

const normalize = (code: string) => code.replace(/[\s-]/g, '').toUpperCase();

@Injectable()
export class MfaService {
  private readonly logger = new Logger(MfaService.name);

  constructor(
    @Inject(PG_OWNER) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly auth: AuthService,
  ) {}

  private key(): Buffer {
    if (!this.config.secretsKey) throw new ApiError(503, 'MFA_NOT_AVAILABLE', 'Falta SECRETS_KEY: no se puede activar el segundo factor.');
    return this.config.secretsKey;
  }

  /** Valida el testigo intermedio y devuelve el usuario; `stage` limita para qué sirve. */
  pendingUser(token: string, stage: 'verify' | 'setup'): string {
    const claims = verifyToken(this.config.tokenSecret, 'mfa-pending', token);
    if (!claims || claims.stage !== stage) throw new ApiError(401, 'INVALID_SESSION', 'El inicio de sesión venció. Vuelva a entrar.');
    return claims.sub;
  }

  // --------------------------------------------------------------- activación

  /** Genera la semilla (aún sin activar) y devuelve el QR. Repetirlo antes de activar reemplaza la semilla pendiente. */
  async setup(userId: string): Promise<TotpSetup> {
    const key = this.key();
    const { rows } = await this.pool.query<{ email: string; mfa_enabled_at: Date | null }>('SELECT email, mfa_enabled_at FROM users WHERE id = $1', [userId]);
    if (!rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', 'No existe el usuario.');
    if (rows[0].mfa_enabled_at) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'El segundo factor ya está activado.');
    const secret = generateSecret();
    await this.pool.query('UPDATE users SET mfa_secret_enc = $2, mfa_last_step = NULL, mfa_failed = 0 WHERE id = $1', [userId, seal(key, 'mfa-secret', secret)]);
    const uri = otpauthUri(secret, rows[0].email);
    return { qr: await QRCode.toDataURL(uri, { margin: 1, width: 220 }), secret: formatSecretForHuman(secret), otpauthUri: uri };
  }

  /** Confirma el primer código, activa el factor y entrega los códigos de recuperación (una sola vez). */
  async enable(userId: string, code: string): Promise<{ recoveryCodes: string[] }> {
    const key = this.key();
    const { rows } = await this.pool.query<{ mfa_secret_enc: string | null; mfa_enabled_at: Date | null }>('SELECT mfa_secret_enc, mfa_enabled_at FROM users WHERE id = $1', [userId]);
    const u = rows[0];
    if (!u?.mfa_secret_enc) throw new ApiError(409, 'MFA_NOT_STARTED', 'Primero genere el código QR.');
    if (u.mfa_enabled_at) throw new ApiError(409, 'MFA_ALREADY_ENABLED', 'El segundo factor ya está activado.');
    const step = verifyTotp(open(key, 'mfa-secret', u.mfa_secret_enc), code);
    if (step === null) throw new ApiError(422, 'INVALID_CODE', 'El código no es correcto. Revise la hora de su teléfono e intente de nuevo.');
    const codes = Array.from({ length: RECOVERY_CODES }, () => Array.from({ length: RECOVERY_LENGTH }, () => RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)]).join(''));
    const hashes = await Promise.all(codes.map((c) => argon2.hash(c, { type: argon2.argon2id })));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE users SET mfa_enabled_at = now(), mfa_last_step = $2, mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1', [userId, step]);
      await client.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
      for (const h of hashes) await client.query('INSERT INTO mfa_recovery_codes (user_id, code_hash) VALUES ($1, $2)', [userId, h]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw e;
    } finally {
      client.release();
    }
    return { recoveryCodes: codes.map((c) => `${c.slice(0, 5)}-${c.slice(5)}`) };
  }

  /** Activación hecha desde el testigo intermedio (operador sin factor): al terminar, abre la sesión. */
  async enableFromPending(pendingToken: string, code: string, ip: string | undefined): Promise<{ recoveryCodes: string[]; session: IssuedSession }> {
    const userId = this.pendingUser(pendingToken, 'setup');
    const { recoveryCodes } = await this.enable(userId, code);
    return { recoveryCodes, session: await this.auth.issueSession(userId, ip) };
  }

  // -------------------------------------------------------------- verificación

  /** Segundo paso del inicio de sesión: código de la aplicación o código de recuperación. */
  async verify(pendingToken: string, input: { code?: string; recoveryCode?: string }, ip: string | undefined): Promise<IssuedSession> {
    const userId = this.pendingUser(pendingToken, 'verify');
    const { rows } = await this.pool.query<{ mfa_secret_enc: string | null; mfa_enabled_at: Date | null; mfa_last_step: string | null; mfa_failed: number; mfa_locked_until: Date | null; active: boolean }>(
      'SELECT mfa_secret_enc, mfa_enabled_at, mfa_last_step, mfa_failed, mfa_locked_until, active FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (!u || !u.active || !u.mfa_enabled_at || !u.mfa_secret_enc) throw new ApiError(401, 'INVALID_SESSION', 'El inicio de sesión venció. Vuelva a entrar.');
    if (u.mfa_locked_until && u.mfa_locked_until.getTime() > Date.now()) {
      const minutes = Math.max(1, Math.ceil((u.mfa_locked_until.getTime() - Date.now()) / 60_000));
      throw new ApiError(429, 'MFA_LOCKED', `Demasiados códigos incorrectos. Espere ${minutes} min.`, { retryAfterSeconds: minutes * 60 });
    }

    let ok = false;
    if (input.recoveryCode) ok = await this.consumeRecoveryCode(userId, input.recoveryCode);
    else if (input.code) {
      const step = verifyTotp(open(this.key(), 'mfa-secret', u.mfa_secret_enc), input.code, { minStep: u.mfa_last_step === null ? null : Number(u.mfa_last_step) });
      if (step !== null) {
        // El paso se guarda con una condición, para que dos peticiones simultáneas con el mismo código no pasen las dos.
        const r = await this.pool.query('UPDATE users SET mfa_last_step = $2 WHERE id = $1 AND (mfa_last_step IS NULL OR mfa_last_step < $2)', [userId, step]);
        ok = r.rowCount === 1;
      }
    }
    if (!ok) {
      const failed = u.mfa_failed + 1;
      const lock = failed >= MAX_FAILED;
      await this.pool.query('UPDATE users SET mfa_failed = $2, mfa_locked_until = CASE WHEN $3 THEN now() + make_interval(mins => $4) ELSE mfa_locked_until END WHERE id = $1', [userId, lock ? 0 : failed, lock, LOCK_MINUTES]);
      if (lock) this.logger.warn(`Segundo factor del usuario ${userId} cerrado ${LOCK_MINUTES} min por ${MAX_FAILED} fallos (IP ${ip}).`);
      throw new ApiError(401, 'INVALID_CODE', input.recoveryCode ? 'El código de recuperación no es válido o ya se usó.' : 'El código no es correcto.');
    }
    await this.pool.query('UPDATE users SET mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1', [userId]);
    return this.auth.issueSession(userId, ip);
  }

  private async consumeRecoveryCode(userId: string, raw: string): Promise<boolean> {
    const code = normalize(raw);
    if (code.length !== RECOVERY_LENGTH) return false;
    const { rows } = await this.pool.query<{ id: string; code_hash: string }>('SELECT id, code_hash FROM mfa_recovery_codes WHERE user_id = $1 AND used_at IS NULL', [userId]);
    for (const r of rows) {
      if (await argon2.verify(r.code_hash, code).catch(() => false)) {
        // Consumo atómico: un mismo código no sirve dos veces aunque lleguen dos peticiones a la vez.
        return (await this.pool.query('UPDATE mfa_recovery_codes SET used_at = now() WHERE id = $1 AND used_at IS NULL', [r.id])).rowCount === 1;
      }
    }
    return false;
  }

  // --------------------------------------------------------------- desactivar

  /** Quita el segundo factor a petición del propio usuario (pide contraseña y un código). No aplica a roles que lo exigen. */
  async disable(userId: string, password: string, code: string): Promise<void> {
    const { rows } = await this.pool.query<{ role: string; password_hash: string; mfa_secret_enc: string | null; mfa_enabled_at: Date | null; mfa_last_step: string | null }>(
      'SELECT role, password_hash, mfa_secret_enc, mfa_enabled_at, mfa_last_step FROM users WHERE id = $1',
      [userId],
    );
    const u = rows[0];
    if (!u?.mfa_enabled_at || !u.mfa_secret_enc) throw new ApiError(409, 'MFA_NOT_ENABLED', 'El segundo factor no está activado.');
    if (mfaRequiredFor(u.role)) throw new ApiError(403, 'MFA_REQUIRED', 'Su rol exige el segundo factor: no se puede desactivar.');
    if (!(await verifyPassword(u.password_hash, password))) throw new ApiError(401, 'INVALID_CREDENTIALS', 'La contraseña no es correcta.');
    if (verifyTotp(open(this.key(), 'mfa-secret', u.mfa_secret_enc), code, { minStep: u.mfa_last_step === null ? null : Number(u.mfa_last_step) }) === null) {
      throw new ApiError(401, 'INVALID_CODE', 'El código no es correcto.');
    }
    await this.clear(userId);
  }

  /** Quita el factor a otro usuario (perdió el teléfono y los códigos). Lo decide un administrador. */
  async clear(userId: string): Promise<void> {
    await this.pool.query('UPDATE users SET mfa_secret_enc = NULL, mfa_enabled_at = NULL, mfa_last_step = NULL, mfa_failed = 0, mfa_locked_until = NULL WHERE id = $1', [userId]);
    await this.pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [userId]);
    await this.auth.revokeAllSessions(userId);
  }
}
