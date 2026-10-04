/**
 * Configura el servidor de correo (SMTP) de un tenant, cifrando la contraseña. Con --test-to envía
 * un correo de prueba y, si sale, deja el correo marcado como verificado.
 *
 * La contraseña va por la variable de entorno SMTP_PASSWORD, NO por argumento: un argumento queda
 * en el historial del shell.
 *
 *   SMTP_PASSWORD='...' npm run tenant:mail -w api -- --tenant <uuid> --host smtp.ejemplo.com \
 *       --port 587 --user usuario --from-email avisos@corredora.com --from-name "Mi Corredora" \
 *       [--secure true|false] [--reply-to x@y.com] [--test-to yo@correo.com]
 *
 * Sin --user no se usa autenticación. Para cambiar solo el remitente conservando la contraseña
 * guardada, omita SMTP_PASSWORD.
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { loadConfig } from '../config/config';
import { MailNotConfiguredError, MailService, MailSendError, saveMailSettings } from '../mail/mail.service';
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tenantId = arg('tenant');
  const host = arg('host');
  const portRaw = arg('port');
  const fromEmail = arg('from-email');
  if (!tenantId || !host || !portRaw || !fromEmail) {
    throw new Error('Uso: --tenant <uuid> --host <servidor> --port <puerto> --from-email <correo> [--user <usuario>] [--from-name <nombre>] [--secure true|false] [--reply-to <correo>] [--test-to <correo>]');
  }
  const port = Number(portRaw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('--port debe ser un puerto válido (1-65535).');
  const secureRaw = arg('secure');
  if (secureRaw !== undefined && secureRaw !== 'true' && secureRaw !== 'false') throw new Error('--secure debe ser true o false.');
  const username = arg('user') ?? null;
  const password = process.env.SMTP_PASSWORD;
  if (username && password === undefined) {
    // Sin contraseña nueva solo vale si ya hay una guardada para ese usuario.
    console.warn('Aviso: sin SMTP_PASSWORD se conserva la contraseña ya guardada (si no hay ninguna, el guardado fallará).');
  }

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const t = await pool.query('SELECT name FROM tenants WHERE id = $1', [tenantId]);
    if (!t.rows[0]) throw new Error(`No existe el tenant ${tenantId}.`);

    await saveMailSettings(pool, config.secretsKey, tenantId, {
      host,
      port,
      secure: secureRaw === undefined ? null : secureRaw === 'true',
      username,
      password: username ? password : undefined,
      fromName: arg('from-name') ?? null,
      fromEmail,
      replyTo: arg('reply-to') ?? null,
    });
    console.log(`Correo guardado para «${t.rows[0].name}».`);

    const testTo = arg('test-to');
    if (testTo) {
      const mail = new MailService(pool, config);
      try {
        await mail.send(tenantId, {
          to: testTo,
          subject: 'Prueba de correo del servicio de firma electrónica',
          text: 'Si recibe este mensaje, el envío de correos de su corredora está bien configurado.',
        });
        await pool.query('UPDATE tenant_mail_settings SET verified_at = now() WHERE tenant_id = $1', [tenantId]);
        console.log(`Correo de prueba enviado a ${testTo}. Configuración verificada.`);
      } catch (e) {
        if (e instanceof MailSendError || e instanceof MailNotConfiguredError) {
          throw new Error(`La configuración se guardó, pero el envío de prueba falló: ${e.message}`);
        }
        throw e;
      }
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
