import { fechaHoraEnZonaIso, zonaDelNavegador } from './fechas';
import type { RequestStatus, ReviewResult } from './api';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Pendiente',
  SIGNED: 'Firmada',
  REJECTED: 'Rechazada',
  EXPIRED: 'Vencida',
  REVOKED: 'Revocada',
};

export const REVIEW_LABEL: Record<ReviewResult, string> = {
  VERIFIED: 'Identidad verificada',
  REJECTED: 'Identidad rechazada',
};

/** Nombres entendibles de los eventos de la bitácora. */
export const EVENT_LABEL: Record<string, string> = {
  link_opened: 'El firmante abrió el enlace',
  otp_sent: 'Se envió el código de verificación',
  otp_issued_dev: 'Se generó el código (modo desarrollo)',
  otp_failed: 'Código incorrecto',
  otp_locked: 'Código bloqueado por demasiados intentos',
  otp_verified: 'Código verificado',
  session_opened: 'El firmante abrió el documento',
  photo_challenge_issued: 'Se pidió un código para la foto',
  signed: 'Documento firmado',
  confirmation_sent: 'Se envió la copia al firmante',
  confirmation_failed: 'No se pudo enviar la copia al firmante',
  revoked: 'Solicitud revocada',
  expired: 'La solicitud venció',
  reviewed: 'Revisión del corredor',
  photo_purged: 'Foto borrada por vencer el plazo de retención',
  photos_deleted_on_request: 'Fotos eliminadas a pedido del titular',
};

/** Eventos de la bitácora de ACCESOS (inicios de sesión y cambios de usuarios). */
export const AUTH_EVENT_LABEL: Record<string, string> = {
  login_ok: 'Inicio de sesión',
  login_failed: 'Intento fallido',
  login_locked: 'Cuenta cerrada por intentos fallidos',
  mfa_failed: 'Código del segundo factor incorrecto',
  mfa_locked: 'Segundo factor cerrado por intentos fallidos',
  mfa_enabled: 'Segundo factor activado',
  mfa_disabled: 'Segundo factor desactivado',
  mfa_cleared: 'Segundo factor quitado por un administrador',
  logout: 'Salió',
  session_reuse_detected: 'Sesión cerrada por reuso sospechoso',
  password_changed: 'Cambió su contraseña',
  password_reset_requested: 'Pidió recuperar la contraseña',
  password_reset_completed: 'Recuperó su contraseña',
  password_reset_by_admin: 'Contraseña restablecida por un administrador',
  user_created: 'Usuario creado',
  user_updated: 'Usuario modificado',
  tenant_created: 'Corredora creada',
  tenant_active_changed: 'Corredora activada o desactivada',
  admin_added: 'Administrador agregado',
};

/**
 * Zona con que el panel muestra las horas: la de la corredora de quien entró (se fija al abrir la sesión). Sin corredora
 * (el operador de la plataforma), la del navegador. Siempre con el desfase al lado: «04/10/2026 12:35 (UTC-5)».
 */
let panelZone: string | null = null;
export const setPanelZone = (zona: string | null): void => {
  panelZone = zona;
};

export function formatDateTime(iso: string): string {
  return fechaHoraEnZonaIso(iso, panelZone ?? zonaDelNavegador());
}

export function formatDateTimeSeconds(iso: string): string {
  return fechaHoraEnZonaIso(iso, panelZone ?? zonaDelNavegador(), { segundos: true });
}

export function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

/** Enlace de WhatsApp (wa.me) con el mensaje ya escrito; la persona solo pulsa «enviar». */
export function whatsappLink(phone: string, signerName: string, url: string, documentName: string): string | null {
  const digits = phone.replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  const text = `Hola ${signerName}, le enviamos el documento «${documentName}» para que lo firme: ${url}`;
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

/** Baja un archivo que ya está en memoria (un Blob) con el nombre indicado. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/**
 * UUID v4. `crypto.randomUUID` solo existe en contextos seguros (HTTPS o localhost): abriendo el panel por la
 * IP de la red local con http no está y el formulario se caía. `getRandomValues` sí funciona en ambos.
 */
export function newUuid(): string {
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
