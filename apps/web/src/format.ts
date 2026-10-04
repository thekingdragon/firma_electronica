import type { RequestStatus } from './api';

export const STATUS_LABEL: Record<RequestStatus, string> = {
  PENDING: 'Pendiente',
  SIGNED: 'Firmada',
  REJECTED: 'Rechazada',
  EXPIRED: 'Vencida',
  REVOKED: 'Revocada',
};

export const DOCUMENT_TYPE_LABEL: Record<string, string> = {
  APPOINTMENT_LETTER: 'Carta de nombramiento',
};

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('es-PE', { dateStyle: 'medium', timeStyle: 'short' });
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
