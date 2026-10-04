import { useState } from 'react';
import { whatsappLink } from '../format';

/**
 * El enlace de firma con sus acciones de envío. El servicio no envía el link (delivery HOST):
 * quien usa el panel lo copia o lo manda por WhatsApp con el mensaje ya escrito.
 */
export function LinkBox({
  url,
  signerName,
  phone,
}: {
  url: string;
  signerName: string;
  phone?: string;
}) {
  const [copied, setCopied] = useState<'ok' | 'error' | null>(null);
  const wa = phone ? whatsappLink(phone, signerName, url) : null;

  async function copy() {
    try {
      await navigator.clipboard.writeText(url);
      setCopied('ok');
    } catch {
      setCopied('error');
    }
    setTimeout(() => setCopied(null), 2500);
  }

  return (
    <div className="linkbox">
      <input readOnly value={url} aria-label="Enlace de firma" onFocus={(e) => e.currentTarget.select()} />
      <div className="actions">
        <button type="button" className="btn" onClick={copy}>
          {copied === 'ok' ? 'Copiado ✓' : copied === 'error' ? 'No se pudo copiar' : 'Copiar enlace'}
        </button>
        {wa && (
          <a className="btn btn-wa" href={wa} target="_blank" rel="noreferrer">
            Enviar por WhatsApp
          </a>
        )}
      </div>
      {phone && !wa && <p className="hint warn">El número de WhatsApp no tiene un formato válido (use código de país, ej. +51 999 999 999).</p>}
    </div>
  );
}
