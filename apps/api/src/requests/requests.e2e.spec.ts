/**
 * Pruebas de integración de `POST /v1/requests` contra una base real.
 *
 *   TEST_DATABASE_URL=postgres://.../firma_test npm run test:e2e
 *
 * La base DEBE terminar en `_test`: la prueba la vacía (TRUNCATE ... CASCADE), y apuntarla a una
 * base de trabajo por error borraría datos.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { Pool } from 'pg';
import request from 'supertest';
import { sha256Hex } from '../common/crypto';
import { applyMigrations } from '../db/migrations';
import { createTenant } from '../tenants/tenants.service';

const TEST_URL = process.env.TEST_DATABASE_URL;
if (!TEST_URL) {
  throw new Error('Falta TEST_DATABASE_URL: las pruebas e2e necesitan una base real que termine en _test.');
}
if (!/_test(\?.*)?$/.test(TEST_URL)) {
  throw new Error('TEST_DATABASE_URL debe terminar en _test (la prueba vacía esa base).');
}

const TOKEN_SECRET = 't'.repeat(40);
const BASE_URL = 'https://firma.test';

const validBody = () => ({
  documentType: 'APPOINTMENT_LETTER',
  externalRef: 'cliente-123',
  signer: { name: 'Ana Pérez Quispe', documentType: 'DNI', documentNumber: '12345678' },
  data: { insurances: ['SCTR Salud', 'SCTR Pensión'] },
  otp: { channel: 'EMAIL', to: 'ana@example.com' },
  delivery: { mode: 'HOST' },
});

describe('POST /v1/requests', () => {
  let app: INestApplication;
  let pool: Pool;
  let keyA: string;
  let keyB: string;
  let tenantA: string;
  let tenantB: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = TEST_URL;
    process.env.TOKEN_SECRET = TOKEN_SECRET;
    process.env.PUBLIC_BASE_URL = BASE_URL;
    process.env.NODE_ENV = 'test';

    await applyMigrations(TEST_URL!, join(__dirname, '..', '..', 'migrations'));
    pool = new Pool({ connectionString: TEST_URL });
    await pool.query('TRUNCATE tenants CASCADE');

    const a = await createTenant(pool, { name: 'A', country: 'PE', legalName: 'Corredora A SAC' });
    const b = await createTenant(pool, { name: 'B', country: 'PE', legalName: 'Corredora B SAC' });
    keyA = a.apiKey;
    keyB = b.apiKey;
    tenantA = a.tenant.id;
    tenantB = b.tenant.id;

    const { AppModule } = await import('../app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = mod.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await pool?.end();
  });

  const post = (key: string | undefined, body: unknown, idem?: string) => {
    const r = request(app.getHttpServer()).post('/v1/requests');
    if (key) r.set('X-Api-Key', key);
    if (idem) r.set('Idempotency-Key', idem);
    return r.send(body as object);
  };

  describe('autenticación', () => {
    it('sin clave -> 401', async () => {
      const res = await post(undefined, validBody());
      expect(res.status).toBe(401);
      expect(res.body.code).toBe('INVALID_API_KEY');
    });

    it('clave inventada -> 401', async () => {
      const res = await post('fes_' + 'z'.repeat(43), validBody());
      expect(res.status).toBe(401);
    });

    it('tenant desactivado -> 401', async () => {
      const t = await createTenant(pool, { name: 'C', country: 'PE', legalName: 'C SAC' });
      await pool.query('UPDATE tenants SET active = false WHERE id = $1', [t.tenant.id]);
      expect((await post(t.apiKey, validBody())).status).toBe(401);
    });

    it('la clave no se guarda en claro', async () => {
      const { rows } = await pool.query('SELECT api_key_hash FROM tenants WHERE id = $1', [tenantA]);
      expect(rows[0].api_key_hash).toBe(sha256Hex(keyA));
      expect(rows[0].api_key_hash).not.toContain(keyA);
    });
  });

  describe('creación', () => {
    it('crea la solicitud y devuelve el link para el host', async () => {
      const res = await post(keyA, validBody());
      expect(res.status).toBe(201);
      expect(res.body.status).toBe('PENDING');
      expect(res.body.documentType).toBe('APPOINTMENT_LETTER');
      expect(res.body.reference).toMatch(/^FE-\d{4}-[0-9A-HJKMNP-TV-Z]{8}$/);
      expect(res.body.signUrl).toMatch(new RegExp(`^${BASE_URL}/s/[A-Za-z0-9_-]{43}$`));
      expect(res.body.signedAt).toBeNull();

      const { rows } = await pool.query(
        `SELECT tenant_id, token_hash, snapshot_sha256, otp_to, delivery_mode,
                expires_at - created_at AS vigencia
           FROM signature_requests WHERE id = $1`,
        [res.body.id],
      );
      const token = res.body.signUrl.split('/s/')[1];
      expect(rows[0].tenant_id).toBe(tenantA);
      expect(rows[0].token_hash).toBe(sha256Hex(token));
      expect(rows[0].snapshot_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(rows[0].otp_to).toBe('ana@example.com');
      expect(rows[0].delivery_mode).toBe('HOST');
      // Por defecto vence a las 48 h.
      expect(rows[0].vigencia.days * 24 + (rows[0].vigencia.hours ?? 0)).toBe(48);
    });

    it('el token en claro no está en ninguna columna', async () => {
      const res = await post(keyA, validBody());
      const token = res.body.signUrl.split('/s/')[1];
      const { rows } = await pool.query('SELECT to_jsonb(s)::text AS fila FROM signature_requests s WHERE id = $1', [res.body.id]);
      expect(rows[0].fila).not.toContain(token);
    });

    it('respeta expiresInHours', async () => {
      const res = await post(keyA, { ...validBody(), expiresInHours: 24 });
      expect(res.status).toBe(201);
      const { rows } = await pool.query(
        `SELECT extract(epoch FROM expires_at - created_at) / 3600 AS horas FROM signature_requests WHERE id = $1`,
        [res.body.id],
      );
      expect(Math.round(Number(rows[0].horas))).toBe(24);
    });
  });

  describe('validación', () => {
    it('sin seguros -> 422 con la ruta del campo', async () => {
      const res = await post(keyA, { ...validBody(), data: { insurances: [] } });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('VALIDATION_ERROR');
      expect(res.body.issues[0].path).toBe('data.insurances');
    });

    it('campo desconocido -> 422 (no se ignora)', async () => {
      const res = await post(keyA, { ...validBody(), extra: 1 });
      expect(res.status).toBe(422);
    });

    it('tipo de documento sin validador -> 422', async () => {
      const res = await post(keyA, { ...validBody(), documentType: 'CONTRATO_X' });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('DOCUMENT_TYPE_UNSUPPORTED');
    });

    it('OTP obligatorio por política y ausente -> 422', async () => {
      const { otp: _otp, ...sinOtp } = validBody();
      const res = await post(keyA, sinOtp);
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('OTP_REQUIRED');
    });

    it('OTP por correo con destino que no es un correo -> 422', async () => {
      const res = await post(keyA, { ...validBody(), otp: { channel: 'EMAIL', to: 'no-es-correo' } });
      expect(res.body.code).toBe('INVALID_CONTACT');
    });

    it('canal sin proveedor (WhatsApp) -> 422 claro, no se acepta en silencio', async () => {
      const res = await post(keyA, { ...validBody(), otp: { channel: 'WHATSAPP', to: '+51999999999' } });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CHANNEL_NOT_AVAILABLE');
    });

    it('envío por el servicio (aún no disponible) -> 422', async () => {
      const res = await post(keyA, { ...validBody(), delivery: { mode: 'SERVICE', channel: 'EMAIL', to: 'a@b.co' } });
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('CHANNEL_NOT_AVAILABLE');
    });

    it('delivery HOST con channel -> 422', async () => {
      const res = await post(keyA, { ...validBody(), delivery: { mode: 'HOST', channel: 'EMAIL' } });
      expect(res.body.code).toBe('INVALID_DELIVERY');
    });

    it('tenant sin plantilla activa para el tipo -> 422', async () => {
      await pool.query(`UPDATE document_templates SET active = false WHERE tenant_id = $1`, [tenantB]);
      const res = await post(keyB, validBody());
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('TEMPLATE_NOT_FOUND');
      await pool.query(`UPDATE document_templates SET active = true WHERE tenant_id = $1`, [tenantB]);
    });

    it('una petición rechazada no deja filas', async () => {
      const antes = await pool.query('SELECT count(*)::int AS n FROM signature_requests');
      await post(keyA, { ...validBody(), data: { insurances: [] } });
      const despues = await pool.query('SELECT count(*)::int AS n FROM signature_requests');
      expect(despues.rows[0].n).toBe(antes.rows[0].n);
    });
  });

  describe('idempotencia', () => {
    it('repetir con la misma clave y cuerpo devuelve la misma solicitud y el mismo link', async () => {
      const primera = await post(keyA, validBody(), 'idem-1');
      const segunda = await post(keyA, validBody(), 'idem-1');
      expect(primera.status).toBe(201);
      expect(segunda.status).toBe(200);
      expect(segunda.body.id).toBe(primera.body.id);
      expect(segunda.body.signUrl).toBe(primera.body.signUrl);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM signature_requests WHERE tenant_id = $1 AND idempotency_key = 'idem-1'`,
        [tenantA],
      );
      expect(rows[0].n).toBe(1);
    });

    it('el orden de las claves del cuerpo no cuenta como un cuerpo distinto', async () => {
      const b = validBody();
      const reordenado = { delivery: b.delivery, otp: b.otp, data: b.data, signer: b.signer, externalRef: b.externalRef, documentType: b.documentType };
      const primera = await post(keyA, b, 'idem-orden');
      const segunda = await post(keyA, reordenado, 'idem-orden');
      expect(segunda.status).toBe(200);
      expect(segunda.body.id).toBe(primera.body.id);
    });

    it('misma clave con otro cuerpo -> 409', async () => {
      await post(keyA, validBody(), 'idem-2');
      const res = await post(keyA, { ...validBody(), externalRef: 'otro' }, 'idem-2');
      expect(res.status).toBe(409);
      expect(res.body.code).toBe('IDEMPOTENCY_KEY_REUSED');
    });

    it('dos peticiones simultáneas con la misma clave crean UNA sola solicitud', async () => {
      const [r1, r2] = await Promise.all([
        post(keyA, validBody(), 'idem-carrera'),
        post(keyA, validBody(), 'idem-carrera'),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([200, 201]);
      expect(r1.body.id).toBe(r2.body.id);
      const { rows } = await pool.query(
        `SELECT count(*)::int AS n FROM signature_requests WHERE idempotency_key = 'idem-carrera'`,
      );
      expect(rows[0].n).toBe(1);
    });

    it('la misma clave en otro tenant NO colisiona (aislamiento)', async () => {
      const a = await post(keyA, validBody(), 'idem-compartida');
      const b = await post(keyB, validBody(), 'idem-compartida');
      expect(a.status).toBe(201);
      expect(b.status).toBe(201);
      expect(b.body.id).not.toBe(a.body.id);
      const { rows } = await pool.query('SELECT tenant_id FROM signature_requests WHERE id = $1', [b.body.id]);
      expect(rows[0].tenant_id).toBe(tenantB);
    });

    it('Idempotency-Key con espacios -> 422', async () => {
      const res = await post(keyA, validBody(), 'con espacios');
      expect(res.status).toBe(422);
      expect(res.body.code).toBe('INVALID_IDEMPOTENCY_KEY');
    });
  });
});
