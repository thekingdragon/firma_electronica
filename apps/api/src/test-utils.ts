/**
 * Utilidades compartidas por las pruebas de integración (*.e2e.spec.ts). No se usa en producción.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { createServer } from 'node:http';
import forge from 'node-forge';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
import { configureApp } from './app.setup';
import { applyMigrations } from './db/migrations';

export function testDatabaseUrl(): string {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error('Falta TEST_DATABASE_URL: las pruebas e2e necesitan una base real que termine en _test.');
  }
  if (!/_test(\?.*)?$/.test(url)) {
    throw new Error('TEST_DATABASE_URL debe terminar en _test (la prueba vacía esa base).');
  }
  return url;
}

/** Aplica migraciones y vacía los datos de tenants (y todo lo que cuelga de ellos). */
export async function resetDatabase(url: string): Promise<Pool> {
  await applyMigrations(url, join(__dirname, '..', 'migrations'));
  const pool = new Pool({ connectionString: url });
  await pool.query('TRUNCATE tenants CASCADE');
  // La llave de sello va cifrada con SECRETS_KEY y las pruebas usan una distinta cada vez: la anterior no serviría.
  await pool.query('TRUNCATE seal_keys');
  return pool;
}

/**
 * Levanta la aplicación con un entorno concreto. El módulo de configuración lee el entorno al
 * compilarse, así que se pueden tener dos instancias con configuraciones distintas.
 */
export async function makeApp(env: Record<string, string>): Promise<INestApplication> {
  // Las tareas automáticas se apagan: las pruebas las invocan a mano para controlar el momento.
  // El límite por IP se sube muchísimo: las pruebas hacen cientos de peticiones desde la misma
  // dirección. Solo las pruebas del propio limitador usan uno bajo.
  env = { BACKGROUND_JOBS: 'false', PUBLIC_RATE_LIMIT_PER_MIN: '100000', ...env };
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const { AppModule } = await import('./app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
    configureApp(app); // la MISMA configuración que usa main.ts
    await app.init();
    return app;
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

export interface CapturedMail {
  to: string;
  from: { address: string; name: string | null };
  subject: string;
  text: string;
  /** El mensaje completo tal como llegó (incluye adjuntos codificados). */
  raw: string;
}

/** Lector mínimo de un correo MIME: cabeceras (con plegado) y la parte text/plain, decodificada. */
export function parseMail(raw: string): CapturedMail {
  const [head, ...rest] = raw.split(/\r?\n\r?\n/);
  const headers = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i > 0) headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const decode = (body: string, encoding: string): string => {
    const enc = encoding.toLowerCase();
    if (enc === 'base64') return Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8');
    if (enc === 'quoted-printable') {
      const bytes: number[] = [];
      const joined = body.replace(/=\r?\n/g, '');
      for (let i = 0; i < joined.length; i++) {
        if (joined[i] === '=' && /^[0-9A-Fa-f]{2}$/.test(joined.slice(i + 1, i + 3))) {
          bytes.push(parseInt(joined.slice(i + 1, i + 3), 16));
          i += 2;
        } else bytes.push(...Buffer.from(joined[i], 'utf8'));
      }
      return Buffer.from(bytes).toString('utf8');
    }
    return body;
  };

  const type = headers.get('content-type') ?? 'text/plain';
  const bodyRaw = rest.join('\r\n\r\n');
  let text = '';
  const boundary = /boundary="?([^";]+)"?/i.exec(type)?.[1];
  if (boundary) {
    for (const part of bodyRaw.split(`--${boundary}`)) {
      const [ph, ...pb] = part.split(/\r?\n\r?\n/);
      if (/content-type:\s*text\/plain/i.test(ph)) {
        const enc = /content-transfer-encoding:\s*(\S+)/i.exec(ph)?.[1] ?? '7bit';
        text = decode(pb.join('\r\n\r\n'), enc);
        break;
      }
    }
  } else {
    text = decode(bodyRaw, headers.get('content-transfer-encoding') ?? '7bit');
  }

  const fromRaw = headers.get('from') ?? '';
  const m = /^(?:"?([^"<]*?)"?\s*)?<([^>]+)>$/.exec(fromRaw);
  return {
    to: (/<([^>]+)>/.exec(headers.get('to') ?? '')?.[1] ?? headers.get('to') ?? '').trim(),
    from: m ? { address: m[2], name: m[1]?.trim() || null } : { address: fromRaw, name: null },
    subject: headers.get('subject') ?? '',
    text,
    raw,
  };
}

export interface SmtpCapture {
  port: number;
  mails: CapturedMail[];
  close: () => Promise<void>;
}

/** Servidor SMTP real que guarda lo que recibe. Con `auth`, exige ese usuario y contraseña. */
export function startSmtp(auth?: { user: string; pass: string }): Promise<SmtpCapture> {
  const mails: CapturedMail[] = [];
  const server = new SMTPServer({
    disabledCommands: auth ? ['STARTTLS'] : ['STARTTLS', 'AUTH'],
    authOptional: !auth,
    allowInsecureAuth: true,
    onAuth(a, _session, cb) {
      if (auth && a.username === auth.user && a.password === auth.pass) cb(null, { user: a.username });
      else cb(new Error('Invalid username or password'));
    },
    onData(stream, _session, cb) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        mails.push(parseMail(Buffer.concat(chunks).toString('utf8')));
        cb();
      });
      stream.on('error', cb);
    },
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({
        port: (server.server.address() as AddressInfo).port,
        mails,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}

/** Un puerto en el que nadie escucha, para probar un SMTP caído. */
export async function closedPort(): Promise<number> {
  const s = await startSmtp();
  const port = s.port;
  await s.close();
  return port;
}

/**
 * Reescribe datos de solicitudes YA firmadas (p. ej. mover `signed_at` al pasado para probar la retención).
 * El servicio no lo permite: un disparador bloquea los cambios a una solicitud firmada. La prueba, que es dueña de su
 * base, lo apaga durante esa sentencia y lo vuelve a encender.
 */
export async function rewritePast(pool: Pool, sql: string, params: unknown[] = []): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('ALTER TABLE signature_requests DISABLE TRIGGER signature_requests_signed_guard_trg');
    try {
      await client.query(sql, params);
    } finally {
      await client.query('ALTER TABLE signature_requests ENABLE TRIGGER signature_requests_signed_guard_trg');
    }
  } finally {
    client.release();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// Autoridad de sellado de tiempo falsa (RFC 3161) para las pruebas: responde con la estructura que lee el servicio.
// ---------------------------------------------------------------------------------------------------------------------

const A = forge.asn1;
const seq = (...v: forge.asn1.Asn1[]) => A.create(A.Class.UNIVERSAL, A.Type.SEQUENCE, true, v);
const oid = (o: string) => A.create(A.Class.UNIVERSAL, A.Type.OID, false, A.oidToDer(o).getBytes());
const int = (n: number) => A.create(A.Class.UNIVERSAL, A.Type.INTEGER, false, String.fromCharCode(n));
const octets = (bin: string) => A.create(A.Class.UNIVERSAL, A.Type.OCTETSTRING, false, bin);
const ctx0 = (...v: forge.asn1.Asn1[]) => A.create(A.Class.CONTEXT_SPECIFIC, 0, true, v);

/** Una TimeStampResp «concedida» para esa huella y esa hora. */
export function fakeTimestampResponse(sha256Hex: string, genTime: Date): Buffer {
  const tstInfo = seq(
    int(1),
    oid('1.2.3.4.5'),
    seq(seq(oid(forge.pki.oids.sha256 as string), A.create(A.Class.UNIVERSAL, A.Type.NULL, false, '')), octets(Buffer.from(sha256Hex, 'hex').toString('binary'))),
    int(42),
    A.create(A.Class.UNIVERSAL, A.Type.GENERALIZEDTIME, false, A.dateToGeneralizedTime(genTime)),
  );
  const signedData = seq(
    int(3),
    A.create(A.Class.UNIVERSAL, A.Type.SET, true, []),
    seq(oid('1.2.840.113549.1.9.16.1.4'), ctx0(octets(A.toDer(tstInfo).getBytes()))),
  );
  const token = seq(oid('1.2.840.113549.1.7.2'), ctx0(signedData));
  return Buffer.from(A.toDer(seq(seq(int(0)), token)).getBytes(), 'binary');
}

export interface FakeTsa {
  url: string;
  /** Cuántas solicitudes recibió. */
  requests: number;
  /** `ok`: concede; `fail`: responde 500; `wrong`: concede pero de OTRA huella; `denied`: estado «rechazado». */
  mode: 'ok' | 'fail' | 'wrong' | 'denied';
  close(): Promise<void>;
}

export function startFakeTsa(): Promise<FakeTsa> {
  const tsa: FakeTsa = { url: '', requests: 0, mode: 'ok', close: () => Promise.resolve() };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      tsa.requests++;
      if (tsa.mode === 'fail') {
        res.writeHead(500).end();
        return;
      }
      try {
        const body = A.fromDer(Buffer.concat(chunks).toString('binary'));
        const hash = Buffer.from((((body.value as forge.asn1.Asn1[])[1].value as forge.asn1.Asn1[])[1].value as string), 'binary').toString('hex');
        if (tsa.mode === 'denied') {
          res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }).end(Buffer.from(A.toDer(seq(seq(int(2)))).getBytes(), 'binary'));
          return;
        }
        const answered = tsa.mode === 'wrong' ? 'ab'.repeat(32) : hash;
        res.writeHead(200, { 'Content-Type': 'application/timestamp-reply' }).end(fakeTimestampResponse(answered, new Date()));
      } catch {
        res.writeHead(400).end();
      }
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      tsa.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tsa`;
      tsa.close = () => new Promise<void>((r) => server.close(() => r()));
      resolve(tsa);
    });
  });
}
