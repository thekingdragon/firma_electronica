import { Inject, Injectable, Logger } from '@nestjs/common';
import { Pool } from 'pg';
import { open, seal } from '../common/secret-box';
import { APP_CONFIG, AppConfig } from '../config/config';
import { PG_POOL } from '../db/db.module';
import { createTransport, explainSmtpError, formatFrom } from './smtp';

/** El tenant no tiene servidor de correo configurado: es un estado normal, no una falla de envío. */
export class MailNotConfiguredError extends Error {
  constructor() {
    super('El tenant no tiene un servidor de correo configurado.');
    this.name = 'MailNotConfiguredError';
  }
}

/** El envío falló; `explained` es un texto accionable (no el mensaje crudo del servidor). */
export class MailSendError extends Error {
  constructor(public readonly explained: string) {
    super(explained);
    this.name = 'MailSendError';
  }
}

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
  attachments?: { filename: string; content: Buffer; contentType: string }[];
}

export interface MailSettingsInput {
  host: string;
  port: number;
  secure?: boolean | null;
  username?: string | null;
  /** Solo al cambiarla. Con `undefined` se conserva la guardada. */
  password?: string;
  fromName?: string | null;
  fromEmail: string;
  replyTo?: string | null;
}

interface SettingsRow {
  host: string;
  port: number;
  secure: boolean | null;
  username: string | null;
  password_enc: string | null;
  from_name: string | null;
  from_email: string;
  reply_to: string | null;
}

@Injectable()
export class MailService {
  private readonly logger = new Logger(MailService.name);

  constructor(
    @Inject(PG_POOL) private readonly pool: Pool,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async isConfigured(tenantId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('SELECT 1 FROM tenant_mail_settings WHERE tenant_id = $1', [tenantId]);
    return (rowCount ?? 0) > 0;
  }

  /** Envía con el SMTP del tenant. Lanza MailNotConfiguredError o MailSendError. */
  async send(tenantId: string, message: MailMessage): Promise<void> {
    const { rows } = await this.pool.query<SettingsRow>(
      `SELECT host, port, secure, username, password_enc, from_name, from_email, reply_to
         FROM tenant_mail_settings WHERE tenant_id = $1`,
      [tenantId],
    );
    const s = rows[0];
    if (!s) throw new MailNotConfiguredError();
    const notice = (await this.pool.query<{ privacy_notice: string | null }>('SELECT privacy_notice FROM tenants WHERE id = $1', [tenantId])).rows[0]?.privacy_notice ?? null;

    let password: string | null = null;
    if (s.password_enc) {
      if (!this.config.secretsKey) {
        throw new MailSendError('Falta SECRETS_KEY en el servidor: no se puede descifrar la contraseña del correo.');
      }
      try {
        password = open(this.config.secretsKey, 'smtp-password', s.password_enc);
      } catch {
        throw new MailSendError('No se pudo descifrar la contraseña del correo (¿cambió SECRETS_KEY?). Vuelva a guardarla.');
      }
    }

    const transport = createTransport({ host: s.host, port: s.port, secure: s.secure, username: s.username, password });
    try {
      await transport.sendMail({
        from: formatFrom(s.from_name, s.from_email),
        to: message.to,
        replyTo: s.reply_to ?? undefined,
        subject: message.subject,
        text: notice ? `${message.text}\n\n--\n${notice}` : message.text,
        html: notice && message.html ? `${message.html}<hr><p style="color:#666;font-size:12px">${noticeHtml(notice)}</p>` : message.html,
        attachments: message.attachments,
      });
      await this.pool.query(
        `UPDATE tenant_mail_settings SET last_ok_at = now(), last_error = NULL, last_error_at = NULL WHERE tenant_id = $1`,
        [tenantId],
      );
    } catch (e) {
      const explained = explainSmtpError(e);
      this.logger.warn(`Fallo de envío para el tenant ${tenantId}: ${explained}`);
      await this.pool
        .query(`UPDATE tenant_mail_settings SET last_error = $2, last_error_at = now() WHERE tenant_id = $1`, [tenantId, explained])
        .catch(() => undefined);
      throw new MailSendError(explained);
    } finally {
      transport.close();
    }
  }
}

/**
 * Guarda o actualiza el correo de un tenant, cifrando la contraseña. Función suelta (sin Nest) para
 * que la use el comando de configuración y las pruebas.
 */
export async function saveMailSettings(
  pool: Pool,
  secretsKey: Buffer | null,
  tenantId: string,
  input: MailSettingsInput,
): Promise<void> {
  let passwordEnc: string | null | undefined;
  if (input.password !== undefined) {
    if (!secretsKey) throw new Error('Falta SECRETS_KEY: no se puede guardar una contraseña de correo sin cifrarla.');
    passwordEnc = seal(secretsKey, 'smtp-password', input.password);
  }
  const username = input.username ?? null;
  // La base exige «usuario y contraseña van juntos o ninguno van» (CHECK). Sin contraseña nueva y CON usuario, se conserva la
  // guardada: es una actualización de la fila existente (un INSERT con contraseña vacía ni siquiera llegaría al ON CONFLICT).
  if (username !== null && passwordEnc === undefined) {
    const r = await pool.query(
      `UPDATE tenant_mail_settings SET host = $2, port = $3, secure = $4, username = $5, from_name = $6, from_email = $7, reply_to = $8,
              verified_at = NULL, updated_at = now()
        WHERE tenant_id = $1 AND password_enc IS NOT NULL`,
      [tenantId, input.host, input.port, input.secure ?? null, username, input.fromName ?? null, input.fromEmail, input.replyTo ?? null],
    );
    if (r.rowCount) return;
    throw new Error('Con usuario hay que indicar la contraseña: no hay una guardada que conservar.');
  }
  // Sin usuario (servidor sin autenticación) la contraseña también queda vacía; con usuario, es la nueva.
  await pool.query(
    `INSERT INTO tenant_mail_settings
       (tenant_id, host, port, secure, username, password_enc, from_name, from_email, reply_to, verified_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NULL, now())
     ON CONFLICT (tenant_id) DO UPDATE SET
       host = EXCLUDED.host, port = EXCLUDED.port, secure = EXCLUDED.secure,
       username = EXCLUDED.username, password_enc = EXCLUDED.password_enc,
       from_name = EXCLUDED.from_name, from_email = EXCLUDED.from_email, reply_to = EXCLUDED.reply_to,
       verified_at = NULL, updated_at = now()`,
    [tenantId, input.host, input.port, input.secure ?? null, username, username === null ? null : (passwordEnc ?? null), input.fromName ?? null, input.fromEmail, input.replyTo ?? null],
  );
}

/** El aviso es texto plano: se escapa y los saltos de línea se conservan. */
function noticeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/\n/g, '<br>');
}
