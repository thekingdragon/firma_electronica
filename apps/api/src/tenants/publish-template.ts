/**
 * Publica una versión nueva de la plantilla de un tenant (cláusula, anexo y política de evidencia).
 * Sirve para dejar el texto DEFINITIVO tras la revisión legal: las plantillas nacen en «BORRADOR».
 * Una versión usada no se edita; esto crea otra y la deja activa. Lo que no se indique se hereda.
 *
 *   npm run template:publish -w api -- --tenant <uuid> --clause-file clausula.txt --legal-reviewed true
 *   npm run template:publish -w api -- --tenant <uuid> --annex-file anexo.txt
 *   npm run template:publish -w api -- --tenant <uuid> --photo false --photo-challenge false
 *
 * Opciones: --type (por defecto APPOINTMENT_LETTER), --clause-file, --annex-file («-» o vacío lo
 * quita con --no-annex), --otp, --photo, --photo-challenge, --id-photo, --id-photo-back y --legal-reviewed (true|false).
 * Los textos se leen de archivos UTF-8 para no pasar por la codificación de la terminal.
 */
import { readFileSync } from 'node:fs';
import { Pool } from 'pg';
import * as dotenv from 'dotenv';
import { loadConfig } from '../config/config';
import { TemplateChanges, publishTemplate } from './templates.service';
dotenv.config();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function bool(name: string): boolean | undefined {
  const v = arg(name);
  if (v === undefined) return undefined;
  if (v !== 'true' && v !== 'false') throw new Error(`--${name} debe ser true o false.`);
  return v === 'true';
}

function text(name: string): string | undefined {
  const file = arg(name);
  if (file === undefined) return undefined;
  const s = readFileSync(file, 'utf8').replace(/^﻿/, '').trim();
  // Un archivo mal codificado dejaría «�» dentro de un documento legal.
  if (s.includes(String.fromCharCode(0xfffd))) throw new Error(`${file} no está en UTF-8 (tiene caracteres inválidos).`);
  return s;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const tenantId = arg('tenant');
  if (!tenantId) throw new Error('Uso: --tenant <uuid> [--type APPOINTMENT_LETTER] [--clause-file f] [--annex-file f | --no-annex] [--otp bool] [--photo bool] [--photo-challenge bool] [--id-photo bool] [--id-photo-back bool] [--legal-reviewed bool]');

  const changes: TemplateChanges = {
    clauseText: text('clause-file'),
    annexText: process.argv.includes('--no-annex') ? null : text('annex-file'),
    otpRequired: bool('otp'),
    photoRequired: bool('photo'),
    photoChallengeRequired: bool('photo-challenge'),
    idPhotoRequired: bool('id-photo'),
    idPhotoBackRequired: bool('id-photo-back'),
    legalReviewed: bool('legal-reviewed'),
  };
  if (Object.values(changes).every((v) => v === undefined)) throw new Error('No indicó ningún cambio.');

  const pool = new Pool({ connectionString: config.databaseUrl });
  try {
    const type = arg('type') ?? 'APPOINTMENT_LETTER';
    const r = await publishTemplate(pool, tenantId, type, changes);
    console.log(`Plantilla ${type} publicada: versión ${r.version} (activa).`);
    if (r.previousVersion !== null) console.log(`La versión ${r.previousVersion} queda inactiva; las solicitudes ya creadas siguen con la suya.`);
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
