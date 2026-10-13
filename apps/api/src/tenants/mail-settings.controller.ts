import { Body, Controller, Get, HttpCode, Inject, Post, Put, UseGuards } from '@nestjs/common';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Pool } from 'pg';
import { z } from 'zod';
import { Roles } from '../auth/access.guard';
import { ApiError } from '../common/api-error';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { MailNotConfiguredError, MailSendError, MailService, saveMailSettings } from '../mail/mail.service';
import { isPublicAddress } from '../webhooks/ssrf';
import { ApiKeyGuard, CurrentTenant } from './api-key.guard';
import type { Tenant } from './tenants.service';

export interface MailSettingsView {
  configured: boolean;
  host: string | null;
  port: number | null;
  /** `null` = se deduce del puerto (465 es TLS directo). */
  secure: boolean | null;
  username: string | null;
  /** Solo si hay una contraseña guardada: nunca se devuelve la contraseña. */
  hasPassword: boolean;
  fromName: string | null;
  fromEmail: string | null;
  replyTo: string | null;
  /** Última prueba de envío exitosa hecha a propósito. */
  verifiedAt: string | null;
  lastOkAt: string | null;
  lastError: string | null;
}

const EMAIL = z.string().trim().email('Escriba un correo válido.').max(200);
const bodySchema = z
  .object({
    host: z.string().trim().min(1, 'Indique el servidor.').max(253).regex(/^[A-Za-z0-9.-]+$/, 'El servidor solo puede tener letras, números, puntos y guiones (sin https:// ni espacios).'),
    port: z.number().int().min(1).max(65535),
    secure: z.boolean().nullable().optional(),
    username: z.string().trim().max(200).nullable().optional(),
    /** Solo al cambiarla: sin este campo se conserva la guardada. */
    password: z.string().min(1).max(500).optional(),
    fromName: z.string().trim().max(120).nullable().optional(),
    fromEmail: EMAIL,
    replyTo: EMAIL.nullable().optional(),
  })
  .strict();
const testSchema = z.object({ to: EMAIL }).strict();

/**
 * Correo propio de la corredora (SMTP): con él se envían el código de verificación, el enlace de firma y la copia del documento.
 * Lo configura el administrador desde Ajustes; la contraseña se guarda cifrada y NUNCA se devuelve.
 */
@Controller('v1/settings/mail')
@UseGuards(ApiKeyGuard)
@Roles('ADMIN')
export class MailSettingsController {
  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    private readonly mail: MailService,
  ) {}

  @Get()
  async get(@CurrentTenant() tenant: Tenant): Promise<MailSettingsView> {
    return this.view(tenant.id);
  }

  @Put()
  async put(@CurrentTenant() tenant: Tenant, @Body() body: unknown): Promise<MailSettingsView> {
    const parsed = bodySchema.safeParse(body);
    if (!parsed.success) {
      throw new ApiError(422, 'VALIDATION_ERROR', 'Los datos del correo no son válidos.', { issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    const b = parsed.data;
    if (b.password !== undefined && !this.config.secretsKey) {
      throw new ApiError(503, 'SECRETS_KEY_MISSING', 'Falta SECRETS_KEY en el servidor: no se puede guardar una contraseña sin cifrarla.');
    }
    // Un administrador no puede usar el servidor como puente hacia la red interna (mismo criterio que los webhooks).
    await this.assertPublicHost(b.host);
    const username = b.username?.trim() ? b.username.trim() : null;
    if (username && b.password === undefined) {
      const had = await this.pool.query('SELECT 1 FROM tenant_mail_settings WHERE tenant_id = $1 AND password_enc IS NOT NULL', [tenant.id]);
      if (!had.rowCount) throw new ApiError(422, 'VALIDATION_ERROR', 'Con usuario hay que indicar la contraseña.', { issues: [{ path: 'password', message: 'Indique la contraseña de la cuenta.' }] });
    }
    await saveMailSettings(this.pool, this.config.secretsKey, tenant.id, {
      host: b.host,
      port: b.port,
      secure: b.secure ?? null,
      username,
      password: username ? b.password : undefined,
      fromName: b.fromName?.trim() || null,
      fromEmail: b.fromEmail,
      replyTo: b.replyTo ?? null,
    });
    return this.view(tenant.id);
  }

  /** Envía un correo de prueba a la dirección indicada. Si sale, deja la configuración como verificada. */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentTenant() tenant: Tenant, @Body() body: unknown): Promise<{ ok: true; verifiedAt: string }> {
    const parsed = testSchema.safeParse(body);
    if (!parsed.success) throw new ApiError(422, 'VALIDATION_ERROR', 'Indique a qué correo enviar la prueba.');
    try {
      await this.mail.send(tenant.id, {
        to: parsed.data.to,
        subject: 'Prueba de correo del servicio de firma electrónica',
        text: 'Si recibe este mensaje, el envío de correos de su corredora está bien configurado.',
      });
    } catch (e) {
      if (e instanceof MailNotConfiguredError) throw new ApiError(409, 'MAIL_NOT_CONFIGURED', 'Primero guarde la configuración del correo.');
      // `explained` ya es un texto accionable (no el mensaje crudo del servidor).
      if (e instanceof MailSendError) throw new ApiError(502, 'MAIL_SEND_FAILED', e.explained);
      throw e;
    }
    const { rows } = await this.pool.query<{ verified_at: Date }>('UPDATE tenant_mail_settings SET verified_at = now() WHERE tenant_id = $1 RETURNING verified_at', [tenant.id]);
    return { ok: true, verifiedAt: rows[0].verified_at.toISOString() };
  }

  private async assertPublicHost(host: string): Promise<void> {
    if (this.config.webhookAllowPrivate) return;
    const addresses = isIP(host) ? [host] : await lookup(host, { all: true }).then((r) => r.map((x) => x.address), () => []);
    if (addresses.length === 0) throw new ApiError(422, 'VALIDATION_ERROR', `No se pudo encontrar el servidor «${host}». Revise cómo está escrito.`, { issues: [{ path: 'host', message: 'No se encontró ese servidor.' }] });
    if (!addresses.every(isPublicAddress)) throw new ApiError(422, 'MAIL_HOST_NOT_ALLOWED', 'Ese servidor apunta a una dirección interna o privada: no se permite.', { issues: [{ path: 'host', message: 'Dirección no permitida.' }] });
  }

  private async view(tenantId: string): Promise<MailSettingsView> {
    const { rows } = await this.pool.query(
      `SELECT host, port, secure, username, (password_enc IS NOT NULL) AS has_password, from_name, from_email, reply_to, verified_at, last_ok_at, last_error
         FROM tenant_mail_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    const r = rows[0];
    const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
    if (!r) return { configured: false, host: null, port: null, secure: null, username: null, hasPassword: false, fromName: null, fromEmail: null, replyTo: null, verifiedAt: null, lastOkAt: null, lastError: null };
    return { configured: true, host: r.host, port: r.port, secure: r.secure, username: r.username, hasPassword: r.has_password, fromName: r.from_name, fromEmail: r.from_email, replyTo: r.reply_to, verifiedAt: iso(r.verified_at), lastOkAt: iso(r.last_ok_at), lastError: r.last_error };
  }
}
