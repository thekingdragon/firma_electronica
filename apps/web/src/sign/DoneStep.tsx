import { useState } from 'react';
import { signApi } from './signApi';

export function DoneStep({
  token,
  session,
  reference,
  signedAt,
  emailed,
}: {
  token: string;
  session: string | null;
  reference: string;
  signedAt: string | null;
  emailed: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    if (!session) return;
    setBusy(true);
    setError(null);
    try {
      const blob = await signApi.document(token, session);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${reference || 'documento-firmado'}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo descargar la copia.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card done">
      <div className="done-mark" aria-hidden="true">✓</div>
      <h2>Documento firmado</h2>
      {(reference || signedAt) && (
        <p>
          {reference && <>Referencia <strong>{reference}</strong></>}
          {reference && signedAt && ' · '}
          {signedAt && new Date(signedAt).toLocaleString('es-PE', { dateStyle: 'long', timeStyle: 'short' })}
        </p>
      )}
      {emailed && <p>Le enviaremos una copia firmada a su correo.</p>}
      {session ? (
        <>
          <button type="button" className="btn btn-primary btn-block" onClick={download} disabled={busy}>
            {busy ? 'Descargando…' : 'Descargar copia (PDF)'}
          </button>
          <p className="hint">
            {emailed
              ? 'La descarga está disponible durante unos minutos desde esta página; después, use la copia que le llega por correo.'
              : 'La descarga está disponible durante unos minutos desde esta página: guárdela ahora. Si la necesita después, pídala a su corredor.'}
          </p>
        </>
      ) : (
        <p className="hint">Este documento ya fue firmado. Si necesita una copia, pídala a su corredor.</p>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      <p className="muted small">Ya puede cerrar esta página.</p>
    </section>
  );
}
