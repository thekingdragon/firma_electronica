import { randomBytes } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import { Pool, PoolClient } from 'pg';
import { seal } from '../common/secret-box';
import { PG_OWNER } from '../db/db.module';
import { generateApiKey, hashApiKey, looksLikeApiKey } from './api-key';
import { defaultTemplates } from './default-templates';

export interface Tenant {
  id: string;
  name: string;
  country: string;
  legalName: string;
  registryCode: string | null;
  webhookUrl: string | null;
}

export interface CreateTenantInput {
  name: string;
  country: string;
  legalName: string;
  registryCode?: string | null;
  webhookUrl?: string | null;
}

export interface CreatedTenant {
  tenant: Tenant;
  /** Se muestra una sola vez: en la base solo queda su hash. */
  apiKey: string;
  /** Secreto para verificar los webhooks. `null` si no hubo SECRETS_KEY para cifrarlo (configurar con tenant:webhook). */
  webhookSecret: string | null;
}

interface TenantRow {
  id: string;
  name: string;
  country: string;
  legal_name: string;
  registry_code: string | null;
  webhook_url: string | null;
}

const toTenant = (r: TenantRow): Tenant => ({
  id: r.id,
  name: r.name,
  country: r.country,
  legalName: r.legal_name,
  registryCode: r.registry_code,
  webhookUrl: r.webhook_url,
});

/**
 * Crea un tenant con su clave de API y le deja activas las plantillas de partida.
 * Recibe el pool (no depende de Nest) para poder usarse desde el comando de alta y desde pruebas.
 */
export async function createTenant(
  pool: Pool,
  input: CreateTenantInput,
  secretsKey: Buffer | null = null,
): Promise<CreatedTenant> {
  const apiKey = generateApiKey();
  const webhookSecret = secretsKey ? generateWebhookSecret() : null;
  const client: PoolClient = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query<TenantRow>(
      `INSERT INTO tenants (name, country, api_key_hash, webhook_url, webhook_secret_enc, legal_name, registry_code)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id, name, country, legal_name, registry_code, webhook_url`,
      [
        input.name,
        input.country.toUpperCase(),
        hashApiKey(apiKey),
        input.webhookUrl ?? null,
        secretsKey && webhookSecret ? seal(secretsKey, 'webhook-secret', webhookSecret) : null,
        input.legalName,
        input.registryCode ?? null,
      ],
    );
    const tenant = toTenant(rows[0]);
    for (const t of defaultTemplates()) {
      await client.query(
        `INSERT INTO document_templates
           (tenant_id, document_type, version, body_json, annex_text, clause_text,
            otp_required, photo_required, photo_challenge_required, id_photo_required, id_photo_back_required, review_required, active)
         VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8, $9, $10, $11, true)`,
        [
          tenant.id,
          t.documentType,
          JSON.stringify(t.bodyJson),
          t.annexText,
          t.clauseText,
          t.otpRequired,
          t.photoRequired,
          t.photoChallengeRequired,
          t.idPhotoRequired,
          t.idPhotoBackRequired,
          t.reviewRequired,
        ],
      );
    }
    await client.query('COMMIT');
    return { tenant, apiKey, webhookSecret };
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export const generateWebhookSecret = (): string => 'whsec_' + randomBytes(32).toString('base64url');

/**
 * Configura el webhook de un tenant: la URL y, si `rotateSecret`, un secreto NUEVO (cifrado). Devuelve
 * el secreto en claro UNA vez; el anterior deja de servir de inmediato.
 */
export async function setTenantWebhook(
  pool: Pool,
  secretsKey: Buffer,
  tenantId: string,
  opts: { url?: string | null; rotateSecret: boolean },
): Promise<{ secret: string | null }> {
  const secret = opts.rotateSecret ? generateWebhookSecret() : null;
  const { rowCount } = await pool.query(
    `UPDATE tenants SET
       webhook_url = CASE WHEN $2::boolean THEN $3 ELSE webhook_url END,
       webhook_secret_enc = COALESCE($4, webhook_secret_enc)
     WHERE id = $1`,
    [tenantId, opts.url !== undefined, opts.url ?? null, secret ? seal(secretsKey, 'webhook-secret', secret) : null],
  );
  if (!rowCount) throw new Error(`No existe el tenant ${tenantId}.`);
  return { secret };
}

@Injectable()
export class TenantsService {
  constructor(@Inject(PG_OWNER) private readonly pool: Pool) {}

  async findById(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      `SELECT id, name, country, legal_name, registry_code, webhook_url FROM tenants WHERE id = $1 AND active`,
      [id],
    );
    return rows[0] ? toTenant(rows[0]) : null;
  }

  /** Devuelve el tenant activo dueño de esa clave, o null. No distingue «no existe» de «inactivo». */
  async findByApiKey(apiKey: string): Promise<Tenant | null> {
    if (!looksLikeApiKey(apiKey)) return null;
    const { rows } = await this.pool.query<TenantRow>(
      `SELECT id, name, country, legal_name, registry_code, webhook_url
         FROM tenants
        WHERE api_key_hash = $1 AND active`,
      [hashApiKey(apiKey)],
    );
    return rows[0] ? toTenant(rows[0]) : null;
  }
}
