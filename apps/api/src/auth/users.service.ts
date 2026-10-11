import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { ApiError } from '../common/api-error';
import { PG_POOL } from '../db/db.module';
import { AuthService } from './auth.service';
import { MfaService } from './mfa.service';
import { hashPassword, temporaryPassword } from './passwords';
import type { Role } from './session';

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: Role;
  active: boolean;
  mfaEnabled: boolean;
  mustChangePassword: boolean;
  lastLoginAt: string | null;
  createdAt: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Alta de un usuario con contraseña provisional (se devuelve una sola vez; debe cambiarla al entrar). */
export async function insertUser(
  db: Pool | PoolClient,
  input: { tenantId: string | null; email: string; name: string; role: Role },
): Promise<{ id: string; temporaryPassword: string }> {
  if (!EMAIL.test(input.email.trim())) throw new ApiError(422, 'VALIDATION_ERROR', 'El correo no es válido.');
  const temp = temporaryPassword();
  try {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO users (tenant_id, email, name, password_hash, role, must_change_password)
       VALUES ($1, $2, $3, $4, $5, true) RETURNING id`,
      [input.tenantId, input.email.trim(), input.name.trim(), await hashPassword(temp), input.role],
    );
    return { id: rows[0].id, temporaryPassword: temp };
  } catch (e) {
    if ((e as { code?: string }).code === '23505') throw new ApiError(409, 'EMAIL_TAKEN', 'Ya existe un usuario con ese correo.');
    throw e;
  }
}

@Injectable()
export class UsersService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    private readonly auth: AuthService,
    private readonly mfa: MfaService,
  ) {}

  async list(tenantId: string): Promise<UserRow[]> {
    const { rows } = await this.pool.query(
      `SELECT id, email, name, role, active, mfa_enabled_at, must_change_password, last_login_at, created_at
         FROM users WHERE tenant_id = $1 ORDER BY created_at`,
      [tenantId],
    );
    return rows.map((r) => ({
      id: r.id,
      email: r.email,
      name: r.name,
      role: r.role,
      active: r.active,
      mfaEnabled: r.mfa_enabled_at !== null,
      mustChangePassword: r.must_change_password,
      lastLoginAt: r.last_login_at ? new Date(r.last_login_at).toISOString() : null,
      createdAt: new Date(r.created_at).toISOString(),
    }));
  }

  create(tenantId: string, input: { email: string; name: string; role: 'ADMIN' | 'REVIEWER' }) {
    return insertUser(this.pool, { tenantId, ...input });
  }

  private async target(tenantId: string, id: string) {
    const { rows } = await this.pool.query<{ id: string; role: Role; active: boolean }>('SELECT id, role, active FROM users WHERE id = $1 AND tenant_id = $2', [id, tenantId]);
    if (!rows[0]) throw new ApiError(404, 'USER_NOT_FOUND', 'No existe ese usuario en su corredora.');
    return rows[0];
  }

  /** Cambia rol o estado. Nadie se quita el acceso a sí mismo, y la corredora no se queda sin administrador activo. */
  async update(tenantId: string, actorId: string, id: string, changes: { role?: 'ADMIN' | 'REVIEWER'; active?: boolean }): Promise<void> {
    const t = await this.target(tenantId, id);
    if (id === actorId) throw new ApiError(409, 'CANNOT_CHANGE_SELF', 'No puede cambiar su propio rol ni darse de baja.');
    const losesAdmin = t.role === 'ADMIN' && t.active && ((changes.role && changes.role !== 'ADMIN') || changes.active === false);
    if (losesAdmin) {
      const { rows } = await this.pool.query<{ n: string }>(`SELECT count(*) AS n FROM users WHERE tenant_id = $1 AND role = 'ADMIN' AND active AND id <> $2`, [tenantId, id]);
      if (Number(rows[0].n) === 0) throw new ApiError(409, 'LAST_ADMIN', 'La corredora debe conservar al menos un administrador activo.');
    }
    await this.pool.query('UPDATE users SET role = COALESCE($3, role), active = COALESCE($4, active) WHERE id = $1 AND tenant_id = $2', [id, tenantId, changes.role ?? null, changes.active ?? null]);
    if (changes.active === false || (changes.role && changes.role !== t.role)) await this.auth.revokeAllSessions(id);
  }

  async resetPassword(tenantId: string, id: string): Promise<{ temporaryPassword: string }> {
    await this.target(tenantId, id);
    const temp = temporaryPassword();
    await this.auth.setPassword(id, temp, true);
    return { temporaryPassword: temp };
  }

  async resetMfa(tenantId: string, id: string): Promise<void> {
    await this.target(tenantId, id);
    await this.mfa.clear(id);
  }
}
