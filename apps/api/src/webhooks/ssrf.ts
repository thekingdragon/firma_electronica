import { BlockList, isIP } from 'node:net';
import type { LookupFunction } from 'node:net';
import { lookup } from 'node:dns';
import { Agent } from 'undici';

/**
 * Protección contra SSRF: un tenant configura la URL de su webhook, y el servidor hace la petición
 * desde ESTA máquina, que tiene acceso a la red interna (Postgres, Redis, el túnel…). Sin esto, un
 * webhook apuntando a `http://127.0.0.1:5432` o `http://169.254.169.254` usaría al servicio como
 * puente hacia lo que solo él alcanza.
 */
const PRIVATE_V4: [string, number][] = [
  ['0.0.0.0', 8], // «esta red»
  ['10.0.0.0', 8],
  ['100.64.0.0', 10], // CGNAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (incluye el metadata de la nube)
  ['172.16.0.0', 12],
  ['192.0.0.0', 24],
  ['192.0.2.0', 24], // documentación
  ['192.168.0.0', 16],
  ['198.18.0.0', 15], // pruebas de rendimiento
  ['198.51.100.0', 24],
  ['203.0.113.0', 24],
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reservado (incluye 255.255.255.255)
];

const PRIVATE_V6: [string, number][] = [
  ['::', 128], // sin especificar
  ['::1', 128], // loopback
  ['fc00::', 7], // únicas locales
  ['fe80::', 10], // link-local
  ['ff00::', 8], // multicast
  ['2001:db8::', 32], // documentación
  ['64:ff9b::', 96], // NAT64: oculta una IPv4 dentro de una IPv6
];

const blocked = new BlockList();
for (const [net, prefix] of PRIVATE_V4) blocked.addSubnet(net, prefix, 'ipv4');
for (const [net, prefix] of PRIVATE_V6) blocked.addSubnet(net, prefix, 'ipv6');

/** Extrae la IPv4 de una dirección «IPv4 mapeada a IPv6» (::ffff:10.0.0.1), si lo es. */
function mappedV4(ip: string): string | null {
  const m = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (m) return m[1];
  // Forma hexadecimal: ::ffff:0a00:0001
  const h = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i.exec(ip);
  if (h) {
    const hi = parseInt(h[1], 16);
    const lo = parseInt(h[2], 16);
    return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  }
  return null;
}

/** `true` solo si es una dirección IP válida y de internet pública. Todo lo dudoso es `false`. */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 0) return false;
  if (family === 6) {
    const inner = mappedV4(ip);
    if (inner) return isPublicAddress(inner);
    return !blocked.check(ip, 'ipv6');
  }
  return !blocked.check(ip, 'ipv4');
}

export class BlockedAddressError extends Error {
  constructor(host: string, address: string) {
    super(`El webhook apunta a una dirección no pública (${host} → ${address}).`);
    this.name = 'BlockedAddressError';
  }
}

/**
 * Valida la URL de un webhook ANTES de conectar: solo http(s) y, si el host es una IP escrita
 * directamente, que sea pública. Hace falta además del `lookup` del cliente: con una IP literal Node
 * no consulta DNS, así que ese `lookup` nunca se ejecuta y la conexión pasaría sin validar.
 * El analizador de URLs normaliza las formas disfrazadas (`http://2130706433/`, `http://0x7f.1/`)
 * a `127.0.0.1`, que es lo que se comprueba.
 */
export function assertPublicUrl(rawUrl: string, allowPrivate: boolean): URL {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('La URL del webhook no es válida.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('La URL del webhook debe ser http o https.');
  }
  if (!allowPrivate) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isIP(host) !== 0 && !isPublicAddress(host)) throw new BlockedAddressError(host, host);
  }
  return url;
}

/**
 * Cliente HTTP cuyo `lookup` DNS valida la dirección en el momento de conectar. Validar la URL antes
 * no basta: un atacante controla el DNS y puede devolver una IP pública al validar y una interna al
 * conectar (DNS rebinding). Al validar DENTRO de la conexión, la dirección que se comprueba es
 * exactamente la que se usa.
 */
export function createWebhookAgent(allowPrivate: boolean): Agent {
  const safeLookup: LookupFunction = (hostname, options, callback) => {
    lookup(hostname, options, (err, address, family) => {
      if (err) return callback(err, address as never, family as never);
      const list = Array.isArray(address) ? address : [{ address, family }];
      const bad = allowPrivate ? undefined : list.find((a) => !isPublicAddress(a.address));
      if (bad) return callback(new BlockedAddressError(hostname, bad.address) as never, '' as never, 0 as never);
      return callback(null, address as never, family as never);
    });
  };
  return new Agent({
    // Un receptor lento o que nunca responde no puede dejar colgado al trabajador.
    headersTimeout: 10_000,
    bodyTimeout: 10_000,
    connect: { lookup: safeLookup, timeout: 10_000 },
    // Sin keep-alive largo: cada entrega es una conexión corta y se vuelve a validar el destino.
    keepAliveTimeout: 1,
    keepAliveMaxTimeout: 1,
  });
}
