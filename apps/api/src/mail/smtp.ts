import * as nodemailer from 'nodemailer';

export interface SmtpConfig {
  host: string;
  port: number;
  /** Sin valor, se deduce del puerto. */
  secure?: boolean | null;
  username?: string | null;
  password?: string | null;
}

/** El 465 es TLS desde el primer byte; el 587 y el 25 empiezan en claro y negocian STARTTLS. */
export function resolveSecure(port: number, secure?: boolean | null): boolean {
  return secure === null || secure === undefined ? port === 465 : secure;
}

export function createTransport(cfg: SmtpConfig): nodemailer.Transporter {
  return nodemailer.createTransport({
    host: cfg.host,
    port: cfg.port,
    secure: resolveSecure(cfg.port, cfg.secure),
    auth: cfg.username ? { user: cfg.username, pass: cfg.password ?? undefined } : undefined,
    // El firmante está esperando con la pantalla abierta: un servidor colgado no puede tenerlo así.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

/** Cabecera From. Con nombre visible el firmante sabe quién le escribe. */
export function formatFrom(name: string | null | undefined, email: string): string {
  if (!name) return email;
  // Sin comillas, un nombre con coma («Andina, S.A.C.») rompe la cabecera y el correo se rechaza.
  return `"${name.replace(/"/g, '')}" <${email}>`;
}

/** Traduce los errores de SMTP a algo que quien configura el correo pueda accionar. */
export function explainSmtpError(err: unknown): string {
  const e = err as { message?: string; code?: string } | null;
  // Un objeto sin `message` no debe mostrarse como «[object Object]».
  const raw = typeof e?.message === 'string' ? e.message : typeof err === 'string' ? err : '';
  const code = e?.code ?? '';

  if (/SendAsDenied|5\.2\.252|not allowed to send as|5\.7\.60|cannot send as this sender/i.test(raw)) {
    const m = raw.match(/([^\s;<>]+@[^\s;<>]+)\s+not allowed to send as\s+([^\s;<>]+@[^\s;<>]+)/i);
    const detalle = m
      ? `La cuenta «${m[1]}» no tiene permiso para enviar como «${m[2]}». `
      : 'La cuenta autenticada no tiene permiso para enviar con esa dirección de remitente. ';
    return (
      detalle +
      'Use como remitente la misma cuenta con la que se autentica, o conceda a esa cuenta el permiso ' +
      '«Enviar como» sobre el otro buzón desde la administración de su proveedor de correo.'
    );
  }
  if (code === 'EAUTH' || /535|5\.7\.8|authentication/i.test(raw)) {
    return (
      'El servidor rechazó el usuario o la contraseña. En Gmail hace falta una contraseña de aplicación ' +
      '(con la verificación en dos pasos activada); en Microsoft 365 el envío SMTP autenticado suele ' +
      'venir desactivado y hay que habilitarlo para ese buzón.'
    );
  }
  if (['ECONNREFUSED', 'ETIMEDOUT', 'ESOCKET', 'EDNS', 'ECONNECTION'].includes(code) || /getaddrinfo|ENOTFOUND/i.test(raw)) {
    return 'No se pudo conectar con el servidor. Revise el nombre del servidor y el puerto (587 para STARTTLS, 465 para TLS directo).';
  }
  if (/self.signed|certificate|SSL|wrong version number/i.test(raw)) {
    return 'Falló el cifrado de la conexión. Suele ser el puerto y el modo cruzados: 465 usa TLS directo y 587 usa STARTTLS.';
  }
  return recortar(raw) || 'El servidor de correo rechazó el envío sin dar un motivo.';
}

/** Microsoft 365 adjunta bloques de diagnóstico de kilobytes: se podan para que el error quepa en pantalla. */
function recortar(raw: string, max = 300): string {
  const limpio = raw
    .replace(/\[BeginDiagnosticData\][\s\S]*?(\[EndDiagnosticData\]|$)/gi, '')
    .replace(/STOREDRV\.\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio.length > max ? limpio.slice(0, max).trimEnd() + '…' : limpio;
}
