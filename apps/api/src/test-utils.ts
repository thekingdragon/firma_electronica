/**
 * Utilidades compartidas por las pruebas de integración (*.e2e.spec.ts). No se usa en producción.
 */
import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { join } from 'node:path';
import { AddressInfo } from 'node:net';
import { Pool } from 'pg';
import { SMTPServer } from 'smtp-server';
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
  return pool;
}

/**
 * Levanta la aplicación con un entorno concreto. El módulo de configuración lee el entorno al
 * compilarse, así que se pueden tener dos instancias con configuraciones distintas.
 */
export async function makeApp(env: Record<string, string>): Promise<INestApplication> {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    const { AppModule } = await import('./app.module');
    const mod = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = mod.createNestApplication();
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
