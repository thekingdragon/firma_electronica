import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { verifyToken } from './tokens';

export type Role = 'OPERATOR' | 'ADMIN' | 'REVIEWER';

/** Quién hace la petición cuando entra por el panel. */
export interface SessionUser {
  id: string;
  /** `null` solo para el operador de la plataforma. */
  tenantId: string | null;
  email: string;
  name: string;
  role: Role;
  mustChangePassword: boolean;
  mfaEnabled: boolean;
}

interface UserRow {
  id: string;
  tenant_id: string | null;
  email: string;
  name: string;
  role: Role;
  must_change_password: boolean;
  mfa_enabled_at: Date | null;
}

export const toSessionUser = (r: UserRow): SessionUser => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  name: r.name,
  role: r.role,
  mustChangePassword: r.must_change_password,
  mfaEnabled: r.mfa_enabled_at !== null,
});

export const USER_COLUMNS = 'u.id, u.tenant_id, u.email, u.name, u.role, u.must_change_password, u.mfa_enabled_at';

export function bearerToken(header: string | undefined): string | null {
  const m = /^Bearer\s+(\S+)$/i.exec(header ?? '');
  return m ? m[1] : null;
}

/**
 * Resuelve el usuario de un access token. Se relee de la base en CADA petición a propósito: una baja, un cambio de
 * contraseña o una corredora desactivada tienen que cortar la sesión de inmediato, no cuando venza el token.
 */
export async function userFromAccessToken(pool: Pool, tokenSecret: string, token: string): Promise<SessionUser | null> {
  const claims = verifyToken(tokenSecret, 'access', token);
  if (!claims) return null;
  const { rows } = await pool.query<UserRow>(
    `SELECT ${USER_COLUMNS}
       FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.active AND (u.tenant_id IS NULL OR t.active)
        AND u.session_version = $2`,
    [claims.sub, claims.ver ?? -1],
  );
  return rows[0] ? toSessionUser(rows[0]) : null;
}

export const invalidSession = () => new ApiError(401, 'INVALID_SESSION', 'La sesión no es válida o venció. Vuelva a entrar.');
