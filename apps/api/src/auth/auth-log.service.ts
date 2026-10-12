import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { PG_OWNER } from '../db/db.module';
import { requestMeta } from '../db/tenant-context';

export type AuthEventName =
  | 'login_ok'
  | 'login_failed'
  | 'login_locked'
  | 'mfa_failed'
  | 'mfa_locked'
  | 'mfa_enabled'
  | 'mfa_disabled'
  | 'mfa_cleared'
  | 'logout'
  | 'session_reuse_detected'
  | 'password_changed'
  | 'password_reset_requested'
  | 'password_reset_completed'
  | 'password_reset_by_admin'
  | 'user_created'
  | 'user_updated'
  | 'tenant_created'
  | 'tenant_active_changed'
  | 'admin_added';

export interface AuthEventInput {
  event: AuthEventName;
  userId?: string | null;
  email?: string | null;
  tenantId?: string | null;
  actorId?: string | null;
  detail?: Record<string, unknown>;
}

export interface AuthEventRow {
  id: string;
  at: string;
  event: string;
  email: string | null;
  userName: string | null;
  actorName: string | null;
  tenantName: string | null;
  ip: string | null;
  userAgent: string | null;
  detail: Record<string, unknown> | null;
}

/**
 * Registra los accesos y las acciones de administración de usuarios. La IP y el navegador salen del contexto de la petición,
 * así que quien registra no tiene que pasarlos. **Registrar nunca debe romper la acción**: si la base falla, queda en el log
 * del servicio y la petición sigue (un inicio de sesión no puede fallar porque falló su bitácora).
 */
@Injectable()
export class AuthLogService {
  private readonly logger = new Logger('Bitácora de accesos');

  constructor(@Inject(PG_OWNER) private readonly pool: Pool) {}

  async record(e: AuthEventInput): Promise<void> {
    const meta = requestMeta();
    try {
      await this.pool.query(
        `INSERT INTO auth_events (event, user_id, email, tenant_id, actor_id, ip, user_agent, detail)
         VALUES ($1, $2::uuid, COALESCE($3, (SELECT email FROM users WHERE id = $2::uuid)),
                 COALESCE($4::uuid, (SELECT tenant_id FROM users WHERE id = $2::uuid)), $5, $6, $7, $8)`,
        [e.event, e.userId ?? null, e.email?.toLowerCase().slice(0, 200) ?? null, e.tenantId ?? null, e.actorId ?? null, meta?.ip ?? null, meta?.userAgent?.slice(0, 300) ?? null, e.detail ? JSON.stringify(e.detail) : null],
      );
    } catch (err) {
      this.logger.error(`No se pudo registrar ${e.event}: ${(err as Error).message}`);
    }
  }

  /** Los eventos más recientes, de una corredora (`tenantId`) o de todas (operador). Nunca más de 200. */
  async recent(opts: { tenantId?: string; limit?: number }): Promise<AuthEventRow[]> {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 200);
    const params: unknown[] = [limit];
    let where = '';
    if (opts.tenantId) {
      params.push(opts.tenantId);
      where = 'WHERE e.tenant_id = $2';
    }
    const { rows } = await this.pool.query(
      `SELECT e.id, e.at, e.event, e.email, e.ip, e.user_agent, e.detail,
              a.name AS actor_name, t.name AS tenant_name,
              (SELECT u.name FROM users u WHERE u.id = e.user_id) AS user_name
         FROM auth_events e
         LEFT JOIN users a ON a.id = e.actor_id
         LEFT JOIN tenants t ON t.id = e.tenant_id
         ${where}
        ORDER BY e.id DESC
        LIMIT $1`,
      params,
    );
    return rows.map((r) => ({
      id: String(r.id),
      at: new Date(r.at).toISOString(),
      event: r.event,
      email: r.email,
      userName: r.user_name,
      actorName: r.actor_name,
      tenantName: r.tenant_name,
      ip: r.ip,
      userAgent: r.user_agent,
      detail: r.detail,
    }));
  }
}
