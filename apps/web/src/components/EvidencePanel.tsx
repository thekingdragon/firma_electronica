import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiRequestError, loadReviewer, saveReviewer, type Evidence, type ReviewResult } from '../api';
import { useSession } from '../auth';
import { EVENT_LABEL, REVIEW_LABEL, formatDateTime, formatDateTimeSeconds, saveBlob } from '../format';
import { ReviewBadge } from './StatusBadge';

/** Resumen corto del navegador a partir del user agent; el texto completo queda en el título. */
function deviceOf(ua: string | null): string {
  if (!ua) return 'desconocido';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad|iOS/i.test(ua) ? 'iOS' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'macOS' : /Linux/i.test(ua) ? 'Linux' : '';
  const browser = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  const mobile = /Mobile/i.test(ua) ? ' (móvil)' : '';
  return [browser, os].filter(Boolean).join(' en ') + mobile || 'desconocido';
}

type PhotoInfo = NonNullable<Evidence['photo']>;

/**
 * Una foto de la evidencia: se baja con la clave en una cabecera (por eso va por fetch y no por <img src>),
 * se muestra como miniatura y, al pulsarla, se abre ampliada sobre toda la pantalla (Escape o clic la cierran).
 */
function EvidencePhoto({
  info,
  fetchPhoto,
  alt,
  emptyMessage,
}: {
  info: PhotoInfo | null;
  fetchPhoto: () => Promise<Blob>;
  alt: string;
  emptyMessage: string;
}) {
  const [state, setState] = useState<
    { kind: 'loading' } | { kind: 'ready'; url: string } | { kind: 'none'; message: string }
  >({ kind: 'loading' });
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    if (!info) {
      setState({ kind: 'none', message: emptyMessage });
      return;
    }
    if (info.deletedAt) {
      setState({ kind: 'none', message: `La foto se borró el ${formatDateTime(info.deletedAt)} al vencer el plazo de retención. Quedan su huella y la constancia.` });
      return;
    }
    let url: string | null = null;
    let cancelled = false;
    fetchPhoto()
      .then((blob) => {
        if (cancelled) return;
        url = URL.createObjectURL(blob);
        setState({ kind: 'ready', url });
      })
      .catch((e: Error) => !cancelled && setState({ kind: 'none', message: e.message }));
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [info?.sha256, info?.deletedAt]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!zoomed) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setZoomed(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoomed]);

  if (state.kind === 'loading') return <div className="photo-box muted">Cargando la foto…</div>;
  if (state.kind === 'none') return <div className="photo-box muted">{state.message}</div>;
  return (
    <>
      <button type="button" className="photo-zoom" onClick={() => setZoomed(true)} title="Ampliar la foto">
        <img className="photo-box" src={state.url} alt={alt} />
      </button>
      <p className="hint">Toque la foto para verla en grande.</p>
      {zoomed && (
        <div className="lightbox" role="dialog" aria-modal="true" aria-label="Fotografía ampliada" onClick={() => setZoomed(false)}>
          <button type="button" className="lightbox-close" onClick={() => setZoomed(false)} aria-label="Cerrar">×</button>
          <img src={state.url} alt={`${alt}, ampliada`} />
        </div>
      )}
    </>
  );
}

/**
 * Lo que una persona del corredor necesita para decidir si la identidad del firmante le convence:
 * la foto, el código que debía verse en el papel y todo lo registrado. Es la revisión humana de la
 * fase 1 (todavía no hay verificación automática del rostro).
 */
export function EvidencePanel({
  requestId,
  signerName,
  onReviewed,
}: {
  requestId: string;
  signerName: string;
  /** Se llama al guardar un dictamen, para que la pantalla que lo contiene refresque su encabezado. */
  onReviewed?: () => void;
}) {
  const { apiKey } = useSession();
  const [ev, setEv] = useState<Evidence | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pdfBusy, setPdfBusy] = useState(false);
  const [pdfError, setPdfError] = useState<string | null>(null);
  const [pkgBusy, setPkgBusy] = useState(false);

  const load = useCallback(() => {
    api
      .evidence(apiKey, requestId)
      .then(setEv)
      .catch((e: Error) => setError(e.message));
  }, [apiKey, requestId]);

  useEffect(load, [load]);

  async function downloadPackage() {
    if (!ev) return;
    setPkgBusy(true);
    setPdfError(null);
    try {
      saveBlob(await api.evidencePackage(apiKey, requestId), `${ev.reference}-evidencia.zip`);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : 'No se pudo descargar el paquete.');
    } finally {
      setPkgBusy(false);
    }
  }

  async function downloadPdf() {
    if (!ev) return;
    setPdfBusy(true);
    setPdfError(null);
    try {
      saveBlob(await api.document(apiKey, requestId), `${ev.reference}.pdf`);
    } catch (e) {
      setPdfError(e instanceof Error ? e.message : 'No se pudo descargar el PDF.');
    } finally {
      setPdfBusy(false);
    }
  }

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!ev) return <p className="muted">Cargando la evidencia…</p>;

  const ci = ev.clientInfo ?? {};

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h2>Documento firmado</h2>
          <ReviewBadge review={ev.review?.result ?? null} />
        </div>
        <p className="muted">Firmado el {ev.signedAt ? formatDateTimeSeconds(ev.signedAt) : '—'} por {signerName}.</p>
        <div className="actions">
          <button type="button" className="btn btn-primary" onClick={downloadPdf} disabled={pdfBusy}>
            {pdfBusy ? 'Descargando…' : 'Descargar PDF firmado'}
          </button>
        </div>
        {pdfError && <p className="error" role="alert">{pdfError}</p>}
        {ev.pdfSha256 && <p className="hint">SHA-256 del PDF: <code className="hash">{ev.pdfSha256}</code></p>}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Integridad de la firma</h2>
          <span className={`badge ${ev.integrity.ok ? 'badge-ok' : 'badge-warn'}`}>{ev.integrity.ok ? 'Verificada' : 'Con problemas'}</span>
        </div>
        <ul className="integrity">
          <li className={ev.integrity.pdfIntact ? 'ok' : 'bad'}>
            {ev.integrity.pdfIntact ? '✓' : '✗'} El PDF guardado es el mismo que se firmó (su huella coincide).
          </li>
          <li className={ev.integrity.seal.valid && ev.integrity.seal.coversWholeFile && ev.integrity.seal.matchesRecord ? 'ok' : 'bad'}>
            {ev.integrity.seal.valid && ev.integrity.seal.coversWholeFile && ev.integrity.seal.matchesRecord ? '✓' : '✗'}{' '}
            {ev.integrity.seal.present
              ? 'Sello de integridad del PDF: cualquier cambio posterior lo invalidaría.'
              : 'Esta firma es anterior al sello de integridad: su PDF no está sellado.'}
            {ev.integrity.seal.certificateSha256 && (
              <>
                {' '}Certificado <code className="hash">{ev.integrity.seal.certificateSha256.slice(0, 16)}…</code>
              </>
            )}
          </li>
          <li className={ev.integrity.timestamp.valid ? 'ok' : 'warn'}>
            {ev.integrity.timestamp.valid
              ? `✓ Sello de tiempo de una autoridad independiente: ${formatDateTimeSeconds(ev.integrity.timestamp.at as string)}.`
              : '… Sello de tiempo de un tercero: pendiente o no configurado (la fecha de la firma es la del servidor).'}
          </li>
          <li className={ev.integrity.chain.ok ? 'ok' : 'bad'}>
            {ev.integrity.chain.ok ? '✓' : '✗'} Bitácora encadenada: {ev.integrity.chain.events} eventos
            {ev.integrity.chain.ok ? ', sin alteraciones.' : `, alterada a partir del evento ${ev.integrity.chain.brokenAt}.`}
          </li>
        </ul>
        {ev.integrity.problems.length > 0 && (
          <ul className="issues">
            {ev.integrity.problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="actions">
          <button type="button" className="btn" onClick={downloadPackage} disabled={pkgBusy}>
            {pkgBusy ? 'Preparando…' : 'Descargar paquete de evidencia (ZIP)'}
          </button>
        </div>
        <p className="hint">El paquete trae el PDF sellado, el sello de tiempo, la bitácora y las fotos, con instrucciones para verificarlo sin este servicio.</p>
      </div>

      <div className="card">
        <h2>Revisión de identidad</h2>
        <div className="review-photos">
          <div>
            <p className="checklist-title">Selfie con el número</p>
            <EvidencePhoto
              info={ev.photo}
              fetchPhoto={() => api.photo(apiKey, requestId)}
              alt={`Selfie de verificación de ${signerName}`}
              emptyMessage="Este documento no pidió fotografía."
            />
          </div>
          <div>
            <p className="checklist-title">Documento de identidad (frente)</p>
            <EvidencePhoto
              info={ev.idPhoto}
              fetchPhoto={() => api.idPhoto(apiKey, requestId)}
              alt={`Documento de identidad de ${signerName}`}
              emptyMessage="Esta firma no tiene foto del documento: se hizo antes de que se pidiera."
            />
          </div>
          {ev.idPhotoBack && (
            <div>
              <p className="checklist-title">Documento de identidad (reverso)</p>
              <EvidencePhoto
                info={ev.idPhotoBack}
                fetchPhoto={() => api.idPhotoBack(apiKey, requestId)}
                alt={`Reverso del documento de identidad de ${signerName}`}
                emptyMessage="No hay foto del reverso."
              />
            </div>
          )}
        </div>
        <div className="review-check">
          <div>
            {ev.challenge && (
              <div className="challenge-check">
                <div className="muted small">Código que debía verse en el papel</div>
                <div className="challenge-code-sm">{ev.challenge.code}</div>
              </div>
            )}
            <p className="checklist-title">Antes de decidir, compruebe en la foto:</p>
            <ul className="checklist">
              <li>Que el <strong>rostro</strong> de la selfie se vea claro, de una sola persona, tomado en el momento.</li>
              {ev.idPhoto && (
                <>
                  <li>Que el rostro de la selfie <strong>sea el de la foto del documento</strong>.</li>
                  <li>Que el documento sea de <strong>{ev.signer.name}</strong> ({ev.signer.documentType} {ev.signer.documentNumber}) y se lea con claridad.</li>
                </>
              )}
              {ev.challenge && <li>Que el papel muestre <strong>exactamente {ev.challenge.code}</strong>, escrito a mano.</li>}
            </ul>
            <p className="hint">Esta revisión es manual: el servicio todavía no compara el rostro ni lee el código automáticamente.</p>
          </div>
        </div>

        <ReviewForm
          requestId={requestId}
          current={ev.review}
          onSaved={() => {
            load();
            onReviewed?.();
          }}
        />
      </div>

      <div className="card">
        <h2>Lo que quedó registrado</h2>
        <dl className="details">
          {ev.otp && (
            <>
              <dt>Código por correo</dt>
              <dd>Verificado el {formatDateTimeSeconds(ev.otp.verifiedAt)} ({ev.otp.attempts} {ev.otp.attempts === 1 ? 'intento' : 'intentos'})</dd>
            </>
          )}
          {ev.photo && (
            <>
              <dt>Fotografía</dt>
              <dd>
                {ev.photo.width}×{ev.photo.height} px{ev.photo.receivedAt ? `, recibida el ${formatDateTimeSeconds(ev.photo.receivedAt)}` : ''}
                <br />
                <code className="hash">{ev.photo.sha256}</code>
              </dd>
            </>
          )}
          {ev.idPhoto && (
            <>
              <dt>Foto del documento</dt>
              <dd>
                {ev.idPhoto.width}×{ev.idPhoto.height} px{ev.idPhoto.receivedAt ? `, recibida el ${formatDateTimeSeconds(ev.idPhoto.receivedAt)}` : ''}
                <br />
                <code className="hash">{ev.idPhoto.sha256}</code>
              </dd>
            </>
          )}
          {ev.idPhotoBack && (
            <>
              <dt>Reverso del documento</dt>
              <dd>
                {ev.idPhotoBack.width}×{ev.idPhotoBack.height} px{ev.idPhotoBack.receivedAt ? `, recibida el ${formatDateTimeSeconds(ev.idPhotoBack.receivedAt)}` : ''}
                <br />
                <code className="hash">{ev.idPhotoBack.sha256}</code>
              </dd>
            </>
          )}
          {ev.form && Array.isArray((ev.form as { consents?: string[] }).consents) && (
            <>
              <dt>Consentimientos marcados</dt>
              <dd>{((ev.form as { consents?: string[] }).consents ?? []).join(', ') || 'Ninguno'}</dd>
            </>
          )}
          <dt>Dirección IP</dt>
          <dd>{ev.ip ?? 'desconocida'}</dd>
          <dt>Dispositivo</dt>
          <dd title={ev.userAgent ?? ''}>
            {deviceOf(ev.userAgent)}
            {typeof ci.timezone === 'string' ? ` · zona horaria ${ci.timezone}` : ''}
            {typeof ci.screen === 'string' ? ` · pantalla ${ci.screen}` : ''}
          </dd>
          <dt>Facultades otorgadas</dt>
          <dd>
            {ev.form?.powers?.length ? ev.form.powers.join(', ') : 'Ninguna marcada'}
            {ev.form?.observation ? <><br /><strong>Observación:</strong> {ev.form.observation}</> : null}
          </dd>
        </dl>
      </div>

      <details className="card events">
        <summary>Bitácora ({ev.events.length})</summary>
        <ol className="timeline">
          {ev.events.map((e, i) => (
            <li key={i}>
              <span className="muted">{formatDateTimeSeconds(e.at)}</span> · {EVENT_LABEL[e.event] ?? e.event}
              {e.ip ? <span className="muted"> · {e.ip}</span> : null}
            </li>
          ))}
        </ol>
      </details>
    </>
  );
}

function ReviewForm({ requestId, current, onSaved }: { requestId: string; current: Evidence['review']; onSaved: () => void }) {
  const { apiKey } = useSession();
  const [reviewer, setReviewer] = useState(loadReviewer());
  const [result, setResult] = useState<ReviewResult | ''>('');
  const [note, setNote] = useState('');
  const [shown, setShown] = useState<{ reviewer?: string; result?: string }>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const missing: { reviewer?: string; result?: string } = {};
    if (reviewer.trim().length < 2) missing.reviewer = 'Escriba su nombre: queda registrado con la revisión.';
    if (!result) missing.result = 'Elija si la identidad queda verificada o rechazada.';
    setShown(missing);
    if (Object.keys(missing).length || !result) return;
    setBusy(true);
    setError(null);
    try {
      await api.review(apiKey, requestId, { result, reviewedBy: reviewer.trim(), ...(note.trim() ? { note: note.trim() } : {}) });
      saveReviewer(reviewer.trim());
      setEditing(false);
      setResult('');
      setNote('');
      onSaved();
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'No se pudo guardar la revisión.');
    } finally {
      setBusy(false);
    }
  }

  if (current && !editing) {
    return (
      <div className={`review-result ${current.result === 'VERIFIED' ? 'ok' : 'bad'}`}>
        <strong>{REVIEW_LABEL[current.result]}</strong> por {current.reviewedBy} · {formatDateTime(current.reviewedAt)}
        {current.note && <p className="review-note">«{current.note}»</p>}
        <button type="button" className="btn btn-ghost" onClick={() => setEditing(true)}>Cambiar el dictamen</button>
      </div>
    );
  }

  return (
    <form className="review-form" onSubmit={submit} noValidate>
      <h3>{current ? 'Cambiar el dictamen' : 'Su dictamen'}</h3>
      <label htmlFor="reviewer">Su nombre *</label>
      <input id="reviewer" value={reviewer} className={shown.reviewer ? 'invalid' : ''} onChange={(e) => { setReviewer(e.target.value); setShown((s) => ({ ...s, reviewer: undefined })); }} />
      {shown.reviewer && <p className="error">{shown.reviewer}</p>}

      <fieldset className={`choice${shown.result ? ' invalid' : ''}`}>
        <legend>Resultado *</legend>
        <label className="check">
          <input type="radio" name="result" checked={result === 'VERIFIED'} onChange={() => { setResult('VERIFIED'); setShown((s) => ({ ...s, result: undefined })); }} />
          <span><strong>Identidad verificada</strong> — la foto, el documento y el código coinciden.</span>
        </label>
        <label className="check">
          <input type="radio" name="result" checked={result === 'REJECTED'} onChange={() => { setResult('REJECTED'); setShown((s) => ({ ...s, result: undefined })); }} />
          <span><strong>Identidad rechazada</strong> — algo no coincide o no se puede comprobar.</span>
        </label>
      </fieldset>
      {shown.result && <p className="error">{shown.result}</p>}

      <label htmlFor="note">Nota</label>
      <textarea id="note" rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Por qué lo verifica o lo rechaza" />

      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button type="submit" className="btn btn-primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar revisión'}</button>
        {current && <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Cancelar</button>}
      </div>
    </form>
  );
}
