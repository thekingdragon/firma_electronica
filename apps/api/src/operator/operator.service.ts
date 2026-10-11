import { Inject, Injectable } from '@nestjs/common';
import { access, constants } from 'node:fs/promises';
import { Pool } from 'pg';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { verifyAll } from '../ops/verify-evidence';
import { MAX_TSA_ATTEMPTS as MAX_ATTEMPTS } from '../seal/seal.service';
import { StorageService } from '../storage/storage.service';
import { insertUser } from '../auth/users.service';
import { CreateTenantInput, createTenant } from '../tenants/tenants.service';

export interface OperatorOverview {
  service: {
    database: boolean;
    storageWritable: boolean;
    secretsKey: boolean;
    sealKey: boolean;
    timestampAuthority: boolean;
    backgroundJobs: boolean;
  };
  totals: {
    tenants: number;
    activeTenants: number;
    requests: Record<string, number>;
    signedLast30Days: number;
    timestampsPending: number;
    timestampsGivenUp: number;
    webhooksFailed: number;
    webhooksPending: number;
    mailWithErrors: number;
  };
}

export interface OperatorTenant {
  id: string;
  name: string;
  legalName: string;
  country: string;
  active: boolean;
  createdAt: string;
  mailConfigured: boolean;
  mailLastError: string | null;
  signed: number;
  pending: number;
  lastSignedAt: string | null;
  timestampsPending: number;
  webhooksFailed: number;
  reviewPending: number;
}

@Injectable()
export class OperatorService {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly storage: StorageService,
  ) {}

  async overview(): Promise<OperatorOverview> {
    let database = true;
    try {
      await this.pool.query('SELECT 1');
    } catch {
      database = false;
    }
    const storageWritable = await access(this.config.storageDir, constants.W_OK).then(() => true, () => false);
    const q = async <T>(sql: string, params: unknown[] = []) => (await this.pool.query(sql, params)).rows as T[];
    const [tenants] = await q<{ total: string; active: string }>('SELECT count(*) AS total, count(*) FILTER (WHERE active) AS active FROM tenants');
    const byStatus = await q<{ status: string; n: string }>('SELECT status::text, count(*) AS n FROM signature_requests GROUP BY status');
    const [signed30] = await q<{ n: string }>("SELECT count(*) AS n FROM signature_requests WHERE status = 'SIGNED' AND signed_at >= now() - interval '30 days'");
    const [ts] = await q<{ pending: string; gave_up: string }>(
      `SELECT count(*) FILTER (WHERE tsa_attempts < $1) AS pending, count(*) FILTER (WHERE tsa_attempts >= $1) AS gave_up
         FROM signature_requests WHERE status = 'SIGNED' AND tsa_path IS NULL`,
      [MAX_ATTEMPTS],
    );
    const [wh] = await q<{ failed: string; pending: string }>(
      'SELECT count(*) FILTER (WHERE failed_at IS NOT NULL) AS failed, count(*) FILTER (WHERE failed_at IS NULL AND delivered_at IS NULL) AS pending FROM webhook_deliveries',
    );
    const [mail] = await q<{ n: string }>('SELECT count(*) AS n FROM tenant_mail_settings WHERE last_error IS NOT NULL');
    const [seal] = await q<{ n: string }>('SELECT count(*) AS n FROM seal_keys');
    return {
      service: {
        database,
        storageWritable,
        secretsKey: this.config.secretsKey !== null,
        sealKey: Number(seal.n) > 0,
        // Sin TSA_URL no se pide el sello de tiempo; los «pendientes» solo cuentan si hay autoridad configurada.
        timestampAuthority: this.config.tsaUrl !== null,
        backgroundJobs: this.config.backgroundJobs,
      },
      totals: {
        tenants: Number(tenants.total),
        activeTenants: Number(tenants.active),
        requests: Object.fromEntries(byStatus.map((r) => [r.status, Number(r.n)])),
        signedLast30Days: Number(signed30.n),
        timestampsPending: this.config.tsaUrl ? Number(ts.pending) : 0,
        timestampsGivenUp: this.config.tsaUrl ? Number(ts.gave_up) : 0,
        webhooksFailed: Number(wh.failed),
        webhooksPending: Number(wh.pending),
        mailWithErrors: Number(mail.n),
      },
    };
  }

  async tenants(): Promise<OperatorTenant[]> {
    const { rows } = await this.pool.query(
      `SELECT t.id, t.name, t.legal_name, t.country, t.active, t.created_at,
              (m.tenant_id IS NOT NULL) AS mail_configured, m.last_error AS mail_last_error,
              count(r.id) FILTER (WHERE r.status = 'SIGNED') AS signed,
              count(r.id) FILTER (WHERE r.status = 'PENDING') AS pending,
              max(r.signed_at) AS last_signed_at,
              count(r.id) FILTER (WHERE r.status = 'SIGNED' AND r.tsa_path IS NULL AND r.tsa_attempts < $1) AS timestamps_pending,
              (SELECT count(*) FROM webhook_deliveries w JOIN signature_requests rr ON rr.id = w.request_id
                WHERE rr.tenant_id = t.id AND w.failed_at IS NOT NULL) AS webhooks_failed,
              count(r.id) FILTER (WHERE r.status = 'SIGNED' AND (SELECT e.review_result FROM signature_evidence e WHERE e.request_id = r.id) IS NULL) AS review_pending
         FROM tenants t
         LEFT JOIN tenant_mail_settings m ON m.tenant_id = t.id
         LEFT JOIN signature_requests r ON r.tenant_id = t.id
        GROUP BY t.id, m.tenant_id, m.last_error
        ORDER BY t.created_at`,
      [MAX_ATTEMPTS],
    );
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      legalName: r.legal_name,
      country: r.country.trim(),
      active: r.active,
      createdAt: new Date(r.created_at).toISOString(),
      mailConfigured: r.mail_configured,
      mailLastError: r.mail_last_error,
      signed: Number(r.signed),
      pending: Number(r.pending),
      lastSignedAt: r.last_signed_at ? new Date(r.last_signed_at).toISOString() : null,
      timestampsPending: this.config.tsaUrl ? Number(r.timestamps_pending) : 0,
      webhooksFailed: Number(r.webhooks_failed),
      reviewPending: Number(r.review_pending),
    }));
  }

  /** Alta de una corredora, con su primer administrador si se indica (contraseña provisional, una sola vez). */
  async create(input: CreateTenantInput & { adminEmail?: string; adminName?: string }) {
    if (input.adminEmail) {
      const taken = await this.pool.query('SELECT 1 FROM users WHERE lower(email) = lower($1)', [input.adminEmail.trim()]);
      if (taken.rowCount) throw new ApiError(409, 'EMAIL_TAKEN', 'Ya existe un usuario con ese correo.');
    }
    const created = await createTenant(this.pool, input, this.config.secretsKey);
    const admin = input.adminEmail
      ? await insertUser(this.pool, { tenantId: created.tenant.id, email: input.adminEmail, name: input.adminName?.trim() || input.name, role: 'ADMIN' })
      : null;
    return { tenant: created.tenant, apiKey: created.apiKey, webhookSecret: created.webhookSecret, admin: admin ? { email: input.adminEmail, temporaryPassword: admin.temporaryPassword } : null };
  }

  /** Agrega un administrador a una corredora (p. ej. cuando se quedó sin acceso). */
  async addAdmin(tenantId: string, email: string, name: string) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (!rowCount) throw new ApiError(404, 'TENANT_NOT_FOUND', 'No existe esa corredora.');
    const u = await insertUser(this.pool, { tenantId, email, name, role: 'ADMIN' });
    return { email, temporaryPassword: u.temporaryPassword };
  }

  async setActive(id: string, active: boolean): Promise<void> {
    const r = await this.pool.query('UPDATE tenants SET active = $2 WHERE id = $1', [id, active]);
    if (r.rowCount === 0) throw new ApiError(404, 'TENANT_NOT_FOUND', 'No existe esa corredora.');
  }

  /** Revisa las firmas más recientes de una corredora (tope fijo: la petición es síncrona). */
  async verify(id: string, limit: number) {
    const { rowCount } = await this.pool.query('SELECT 1 FROM tenants WHERE id = $1', [id]);
    if (!rowCount) throw new ApiError(404, 'TENANT_NOT_FOUND', 'No existe esa corredora.');
    const s = await verifyAll(this.pool, this.storage, { tenantId: id, limit });
    return {
      checked: s.total,
      ok: s.ok,
      unsealed: s.unsealed,
      failed: s.failed.map((f) => ({ requestId: f.requestId, reference: f.reference, problems: f.problems })),
    };
  }
}
