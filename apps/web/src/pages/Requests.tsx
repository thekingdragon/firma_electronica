import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type RequestStatus, type SignatureRequest } from '../api';
import { useSession } from '../auth';
import { ReviewBadge, StatusBadge } from '../components/StatusBadge';
import { STATUS_LABEL, formatDateTime, isPast } from '../format';

export function Requests() {
  const { apiKey } = useSession();
  const [status, setStatus] = useState<RequestStatus | ''>('');
  const [items, setItems] = useState<SignatureRequest[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setError(null);
    api
      .list(apiKey, status || undefined)
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, [apiKey, status]);

  useEffect(load, [load]);

  return (
    <>
      <div className="page-head">
        <h1>Solicitudes</h1>
        <Link to="/solicitudes/nueva" className="btn btn-primary">
          Nueva solicitud
        </Link>
      </div>

      <div className="toolbar">
        <label htmlFor="estado">Estado</label>
        <select id="estado" value={status} onChange={(e) => setStatus(e.target.value as RequestStatus | '')}>
          <option value="">Todos</option>
          {(Object.keys(STATUS_LABEL) as RequestStatus[]).map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button type="button" className="btn" onClick={load}>
          Actualizar
        </button>
      </div>

      {error && <p className="error" role="alert">{error}</p>}
      {!items && !error && <p className="muted">Cargando…</p>}
      {items && items.length === 0 && (
        <div className="empty card">
          <p>No hay solicitudes{status ? ` con estado «${STATUS_LABEL[status]}»` : ''}.</p>
          {!status && (
            <Link to="/solicitudes/nueva" className="btn btn-primary">
              Crear la primera
            </Link>
          )}
        </div>
      )}
      {items && items.length > 0 && (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Referencia</th>
                <th>Firmante</th>
                <th>Seguros</th>
                <th>Estado</th>
                <th>Revisión</th>
                <th>Creada</th>
                <th>Vence</th>
              </tr>
            </thead>
            <tbody>
              {items.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link to={`/solicitudes/${r.id}`}>{r.reference}</Link>
                  </td>
                  <td>{r.signerName}</td>
                  <td>{r.data.insurances?.length ?? '—'}</td>
                  <td>
                    <StatusBadge status={r.status} />
                  </td>
                  <td>{r.status === 'SIGNED' ? <ReviewBadge review={r.review} /> : <span className="muted">—</span>}</td>
                  <td>{formatDateTime(r.createdAt)}</td>
                  <td className={r.status === 'PENDING' && isPast(r.expiresAt) ? 'warn' : ''}>
                    {formatDateTime(r.expiresAt)}
                    {r.status === 'PENDING' && isPast(r.expiresAt) && ' · vencido'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
