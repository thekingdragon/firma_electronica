/**
 * Usuarios OPERADOR de la plataforma (administran todas las corredoras). No pertenecen a ninguna, así que no hay correo
 * desde el cual recuperar su contraseña: se crean y se restablecen desde la línea de comandos, en la máquina del servicio.
 * La contraseña provisional se imprime UNA vez; al entrar deberá cambiarla y activar el segundo factor (obligatorio).
 *
 *   npm run operator:create -w api -- --email ana@empresa.com --name "Ana Pérez"
 *   npm run operator:reset  -w api -- --email ana@empresa.com          (nueva contraseña provisional)
 *   npm run operator:reset  -w api -- --email ana@empresa.com --mfa    (además quita el segundo factor: perdió el teléfono)
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { temporaryPassword, hashPassword } from './passwords';
import { insertUser } from './users.service';
dotenv.config();

const arg = (n: string) => {
  const i = process.argv.indexOf(`--${n}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
};

async function main(): Promise<void> {
  const cmd = process.argv[2];
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  const email = arg('email');
  if (!email) throw new Error('Falta --email.');
  const pool = new Pool({ connectionString: url });
  try {
    if (cmd === 'create') {
      const name = arg('name');
      if (!name) throw new Error('Falta --name.');
      const u = await insertUser(pool, { tenantId: null, email, name, role: 'OPERATOR' });
      console.log(`Operador creado: ${email}`);
      console.log('Contraseña provisional (no se vuelve a mostrar; deberá cambiarla al entrar):');
      console.log(`  ${u.temporaryPassword}`);
    } else if (cmd === 'reset') {
      const temp = temporaryPassword();
      const clearMfa = process.argv.includes('--mfa');
      const r = await pool.query(
        `UPDATE users SET password_hash = $2, must_change_password = true, failed_logins = 0, locked_until = NULL,
                session_version = session_version + 1,
                mfa_secret_enc = CASE WHEN $3 THEN NULL ELSE mfa_secret_enc END,
                mfa_enabled_at = CASE WHEN $3 THEN NULL ELSE mfa_enabled_at END,
                mfa_last_step = CASE WHEN $3 THEN NULL ELSE mfa_last_step END, mfa_failed = 0, mfa_locked_until = NULL
          WHERE lower(email) = lower($1) AND role = 'OPERATOR' RETURNING id`,
        [email, await hashPassword(temp), clearMfa],
      );
      if (!r.rowCount) throw new Error('No hay un operador con ese correo.');
      await pool.query(`UPDATE refresh_tokens SET revoked_at = now(), revoked_reason = 'password' WHERE user_id = $1 AND revoked_at IS NULL`, [r.rows[0].id]);
      if (clearMfa) await pool.query('DELETE FROM mfa_recovery_codes WHERE user_id = $1', [r.rows[0].id]);
      console.log(`Contraseña restablecida para ${email}${clearMfa ? ' (segundo factor quitado)' : ''}. Provisional (una sola vez):`);
      console.log(`  ${temp}`);
    } else {
      throw new Error('Uso: operator:create --email <correo> --name <nombre> | operator:reset --email <correo> [--mfa]');
    }
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
