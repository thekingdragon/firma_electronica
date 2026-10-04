import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { fetch as undiciFetch } from 'undici';
import { BlockedAddressError, assertPublicUrl, createWebhookAgent, isPublicAddress } from './ssrf';

describe('isPublicAddress', () => {
  it.each(['8.8.8.8', '1.1.1.1', '93.184.216.34', '2606:4700:4700::1111', '2a00:1450:4009:81f::200e'])(
    'una dirección pública (%s) pasa',
    (ip) => expect(isPublicAddress(ip)).toBe(true),
  );

  it.each([
    '127.0.0.1',
    '127.255.255.254',
    '10.0.0.1',
    '10.255.255.255',
    '172.16.0.1',
    '172.31.255.255',
    '192.168.0.1',
    '192.168.255.255',
    '169.254.169.254', // metadata de la nube
    '100.64.0.1',
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.0.2.5',
    '::1',
    '::',
    'fe80::1',
    'fc00::1',
    'fd12:3456::1',
    'ff02::1',
  ])('una dirección privada o reservada (%s) se bloquea', (ip) => expect(isPublicAddress(ip)).toBe(false));

  it('los bordes de los rangos: 172.15 y 172.32 son públicas, 172.16 y 172.31 no', () => {
    expect(isPublicAddress('172.15.255.255')).toBe(true);
    expect(isPublicAddress('172.16.0.0')).toBe(false);
    expect(isPublicAddress('172.31.255.255')).toBe(false);
    expect(isPublicAddress('172.32.0.0')).toBe(true);
  });

  it('una IPv4 privada escondida en una IPv6 «mapeada» también se bloquea', () => {
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:10.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:0a00:0001')).toBe(false); // forma hexadecimal de 10.0.0.1
    expect(isPublicAddress('::ffff:8.8.8.8')).toBe(true);
  });

  it('NAT64 (64:ff9b::/96) se bloquea', () => {
    expect(isPublicAddress('64:ff9b::7f00:1')).toBe(false);
  });

  it.each(['', 'localhost', 'no-es-ip', '999.1.1.1', '1.2.3', '1.2.3.4.5'])(
    'lo que no es una IP válida (%p) se trata como no público',
    (x) => expect(isPublicAddress(x)).toBe(false),
  );
});

describe('assertPublicUrl', () => {
  it.each(['https://example.com/hook', 'http://example.com:8080/a?b=1', 'https://8.8.8.8/x', 'https://[2606:4700:4700::1111]/x'])(
    'acepta %s',
    (u) => expect(() => assertPublicUrl(u, false)).not.toThrow(),
  );

  it.each([
    'http://127.0.0.1/x',
    'http://127.0.0.1:5432/',
    'http://10.1.2.3/',
    'http://192.168.1.10/',
    'http://169.254.169.254/latest/meta-data/', // metadata de la nube
    'http://[::1]/',
    'http://[::ffff:127.0.0.1]/',
    'http://[fe80::1]/',
    'http://0.0.0.0/',
  ])('bloquea la IP privada %s', (u) => expect(() => assertPublicUrl(u, false)).toThrow(BlockedAddressError));

  it.each(['http://2130706433/', 'http://0x7f.0.0.1/', 'http://0177.0.0.1/', 'http://127.1/', 'http://017700000001/'])(
    'bloquea la forma disfrazada de 127.0.0.1: %s',
    (u) => expect(() => assertPublicUrl(u, false)).toThrow(BlockedAddressError),
  );

  it('el truco del usuario en la URL no engaña: http://publico.com@127.0.0.1/ apunta a 127.0.0.1', () => {
    expect(() => assertPublicUrl('http://publico.com@127.0.0.1/', false)).toThrow(BlockedAddressError);
  });

  it.each(['ftp://example.com/', 'file:///etc/passwd', 'javascript:alert(1)', 'gopher://example.com/'])(
    'rechaza el esquema no http(s): %s',
    (u) => expect(() => assertPublicUrl(u, false)).toThrow(/http/),
  );

  it.each(['', 'no-es-url', '//sin-esquema.com'])('rechaza lo que no es una URL: %p', (u) => {
    expect(() => assertPublicUrl(u, false)).toThrow(/no es válida/);
  });

  it('con allowPrivate=true (solo desarrollo) acepta direcciones locales, pero sigue exigiendo http(s)', () => {
    expect(() => assertPublicUrl('http://127.0.0.1:3000/hook', true)).not.toThrow();
    expect(() => assertPublicUrl('file:///etc/passwd', true)).toThrow(/http/);
  });
});

describe('createWebhookAgent (valida al conectar)', () => {
  let server: ReturnType<typeof createServer>;
  let port: number;
  let hits = 0;

  beforeAll(async () => {
    server = createServer((_req, res) => {
      hits++;
      res.end('ok');
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise<void>((r) => server.close(() => r())));

  it('con allowPrivate=false NO conecta a localhost y el servidor ni se entera', async () => {
    const before = hits;
    const agent = createWebhookAgent(false);
    await expect(undiciFetch(`http://localhost:${port}/`, { dispatcher: agent })).rejects.toThrow();
    expect(hits).toBe(before);
    await agent.close();
  });

  it('una IP literal NO pasa por el lookup del agente: por eso hay que validarla antes (assertPublicUrl)', async () => {
    // Documenta el hueco que motivó assertPublicUrl: el agente solo no basta.
    const agent = createWebhookAgent(false);
    const res = await undiciFetch(`http://127.0.0.1:${port}/`, { dispatcher: agent });
    expect(await res.text()).toBe('ok');
    await agent.close();
  });

  it('con allowPrivate=true (solo desarrollo) sí conecta', async () => {
    const agent = createWebhookAgent(true);
    const res = await undiciFetch(`http://localhost:${port}/`, { dispatcher: agent });
    expect(await res.text()).toBe('ok');
    await agent.close();
  });
});
