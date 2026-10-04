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

export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  APPOINTMENT_LETTER: 'Carta de nombramiento',
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
};

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
}

export function formatDateTimeSeconds(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'medium' });
}

export function isPast(iso: string): boolean {
  return new Date(iso).getTime() < Date.now();
}

/** Enlace de WhatsApp (wa.me) con el mensaje ya escrito; la persona solo pulsa «enviar». */
export function whatsappLink(phone: string, signerName: string, url: string): string | null {
  const digits = phone.replace(/[\s()-]/g, '').replace(/^\+/, '');
  if (!/^[1-9]\d{7,14}$/.test(digits)) return null;
  const text = `Hola ${signerName}, le enviamos su carta de nombramiento para que la firme: ${url}`;
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
