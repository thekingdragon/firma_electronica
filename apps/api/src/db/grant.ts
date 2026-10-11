/**
 * Concede al rol de runtime (por defecto `firma_runtime`) los permisos que necesita y NINGUNO más. Se ejecuta con el
 * dueño de la base, después de crear el rol y cada vez que una migración agregue una tabla que el runtime deba usar.
 *
 *   -- una vez, como administrador de PostgreSQL:
 *   CREATE ROLE firma_runtime LOGIN PASSWORD '<clave>';
 *   npm run db:grant -w api [-- --role firma_runtime]
 *
 * y en apps/api/.env:  APP_DATABASE_URL=postgres://firma_runtime:<clave>@localhost:5432/firma_electronica
 */
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
dotenv.config();

async function main(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Falta DATABASE_URL en el entorno.');
  const i = process.argv.indexOf('--role');
  const role = i >= 0 ? process.argv[i + 1] : 'firma_runtime';
  if (!role || !/^[a-z_][a-z0-9_]*$/.test(role)) throw new Error('--role no es un nombre de rol válido.');
  const pool = new Pool({ connectionString: url });
  try {
    const exists = await pool.query('SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = $1', [role]);
    if (!exists.rowCount) throw new Error(`El rol ${role} no existe. Créelo primero: CREATE ROLE ${role} LOGIN PASSWORD '...';`);
    if (exists.rows[0].rolsuper || exists.rows[0].rolbypassrls) throw new Error(`El rol ${role} es superusuario o tiene BYPASSRLS: no aislaría nada. Use un rol sin esos privilegios.`);
    await pool.query('SELECT grant_runtime_access($1)', [role]);
    console.log(`Permisos concedidos a ${role}. Defina APP_DATABASE_URL con ese rol y reinicie la API.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
