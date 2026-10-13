import { useCallback, useEffect, useState } from 'react';
import { documentTypeName, getDocumentTypeUi } from '../document-types';
import { Link, useParams } from 'react-router-dom';
import { api, ApiRequestError, type SignatureRequest } from '../api';
import { useSession } from '../auth';
import { EvidencePanel } from '../components/EvidencePanel';
import { LinkBox } from '../components/LinkBox';
import { ReviewBadge, StatusBadge } from '../components/StatusBadge';
import { formatDateTime, isPast } from '../format';

export function RequestDetail() {
  const { id = '' } = useParams();
  const [req, setReq] = useState<SignatureRequest | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  const load = useCallback(() => {
    api
      .get(id)
      .then(setReq)
      .catch((e: Error) => setError({ notFound: e instanceof ApiRequestError && e.status === 404, message: e.message }));
  }, [id]);

  useEffect(() => {
    setReq(null);
    setError(null);
    load();
  }, [load]);

  if (error) {
    return (
      <>
        <p className="error" role="alert">{error.notFound ? 'No existe esa solicitud.' : error.message}</p>
        <Link to="/solicitudes">← Volver a solicitudes</Link>
      </>
    );
  }
  if (!req) return <p className="muted">Cargando…</p>;

  const expired = req.status === 'PENDING' && isPast(req.expiresAt);

  return (
    <>
      <p>
        <Link to="/solicitudes">← Solicitudes</Link>
      </p>
      <div className="page-head">
        <h1>{req.reference}</h1>
        <div className="badges">
          <StatusBadge status={req.status} />
          {req.status === 'SIGNED' && <ReviewBadge review={req.review} />}
        </div>
      </div>

      <div className="card">
        <dl className="details">
          <dt>Documento</dt>
          <dd>{documentTypeName(req.documentType)}</dd>
          <dt>Firmante</dt>
          <dd>{req.signerName}</dd>
          <dt>Referencia interna</dt>
          <dd>{req.externalRef}</dd>
          <dt>Atendió</dt>
          <dd>{req.attendedBy ?? '—'}</dd>
          {getDocumentTypeUi(req.documentType)?.detail(req.data)}
          <dt>Creada</dt>
          <dd>{formatDateTime(req.createdAt)}</dd>
          <dt>Vence</dt>
          <dd className={expired ? 'warn' : ''}>
            {formatDateTime(req.expiresAt)}
            {expired && ' · el enlace venció'}
          </dd>
        </dl>
      </div>

      {req.status === 'PENDING' && !expired && (
        <>
          <div className="card">
            <h2>Enlace de firma</h2>
            {req.deliveryMode === 'SERVICE' ? (
              <p>El enlace se envió por correo al firmante. Si no le llegó, revoque esta solicitud y cree otra.</p>
            ) : req.signUrl ? (
              <LinkBox documentName={documentTypeName(req.documentType)} url={req.signUrl} signerName={req.signerName} />
            ) : null}
          </div>
          <RevokeCard requestId={req.id} onRevoked={load} />
        </>
      )}

      {req.status === 'REVOKED' && <p className="notice">Esta solicitud se revocó: su enlace ya no abre.</p>}
      {req.status === 'EXPIRED' && <p className="notice">Esta solicitud venció sin firmarse. Cree una nueva.</p>}

      {req.status === 'SIGNED' && <EvidencePanel requestId={req.id} signerName={req.signerName} onReviewed={load} />}
    </>
  );
}

/** Revocar pide confirmación: es irreversible (el enlace deja de abrir y la solicitud no se reabre). */
function RevokeCard({ requestId, onRevoked }: { requestId: string; onRevoked: () => void }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function revoke() {
    setBusy(true);
    setError(null);
    try {
      await api.revoke(requestId);
      onRevoked();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo revocar.');
      setBusy(false);
    }
  }

  return (
    <div className="card">
      <h2>Revocar</h2>
      {!asking ? (
        <>
          <p className="muted">Si el enlace se envió a la persona equivocada o ya no se necesita, revóquelo: dejará de abrir.</p>
          <button type="button" className="btn btn-danger-outline" onClick={() => setAsking(true)}>Revocar solicitud</button>
        </>
      ) : (
        <div className="confirm" role="alertdialog" aria-label="Confirmar revocación">
          <p><strong>¿Revocar esta solicitud?</strong> El enlace dejará de funcionar y no se puede deshacer.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button type="button" className="btn btn-danger" onClick={revoke} disabled={busy}>{busy ? 'Revocando…' : 'Sí, revocar'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setAsking(false)} disabled={busy}>Cancelar</button>
          </div>
        </div>
      )}
    </div>
  );
}
