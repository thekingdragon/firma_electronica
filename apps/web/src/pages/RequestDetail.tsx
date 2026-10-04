import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, ApiRequestError, type SignatureRequest } from '../api';
import { useSession } from '../auth';
import { LinkBox } from '../components/LinkBox';
import { StatusBadge } from '../components/StatusBadge';
import { SIGNING_PAGE_READY } from '../config';
import { DOCUMENT_TYPE_LABEL, formatDateTime, isPast } from '../format';

export function RequestDetail() {
  const { apiKey } = useSession();
  const { id = '' } = useParams();
  const [req, setReq] = useState<SignatureRequest | null>(null);
  const [error, setError] = useState<{ notFound: boolean; message: string } | null>(null);

  useEffect(() => {
    setReq(null);
    setError(null);
    api
      .get(apiKey, id)
      .then(setReq)
      .catch((e: Error) =>
        setError({ notFound: e instanceof ApiRequestError && e.status === 404, message: e.message }),
      );
  }, [apiKey, id]);

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
        <StatusBadge status={req.status} />
      </div>

      <div className="card">
        <dl className="details">
          <dt>Documento</dt>
          <dd>{DOCUMENT_TYPE_LABEL[req.documentType] ?? req.documentType}</dd>
          <dt>Firmante</dt>
          <dd>{req.signerName}</dd>
          <dt>Referencia interna</dt>
          <dd>{req.externalRef}</dd>
          {req.data.insurances && (
            <>
              <dt>Seguros nombrados</dt>
              <dd>
                <ul>
                  {req.data.insurances.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
          <dt>Creada</dt>
          <dd>{formatDateTime(req.createdAt)}</dd>
          <dt>Vence</dt>
          <dd className={expired ? 'warn' : ''}>
            {formatDateTime(req.expiresAt)}
            {expired && ' · el enlace venció'}
          </dd>
          {req.signedAt && (
            <>
              <dt>Firmada</dt>
              <dd>{formatDateTime(req.signedAt)}</dd>
            </>
          )}
        </dl>
      </div>

      {req.status === 'PENDING' && req.signUrl && !expired && (
        <div className="card">
          <h2>Enlace de firma</h2>
          {!SIGNING_PAGE_READY && (
            <p className="notice">La página de firma todavía está en construcción: este enlace aún no abre.</p>
          )}
          <LinkBox url={req.signUrl} signerName={req.signerName} />
        </div>
      )}
    </>
  );
}
