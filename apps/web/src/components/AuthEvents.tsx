import { useEffect, useState } from 'react';
import type { AuthEventRow } from '../api';
import { AUTH_EVENT_LABEL, formatDateTimeSeconds } from '../format';

/**
 * Bitácora de accesos: quién entró, quién falló, quién cambió qué y desde dónde. Solo se agrega (no se puede editar ni borrar).
 * Los intentos fallidos contra un correo que no existe se muestran con el correo tal como se escribió.
 */
export function AuthEvents({ load, showTenant = false }: { load: () => Promise<AuthEventRow[]>; showTenant?: boolean }) {
  const [rows, setRows] = useState<AuthEventRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    load()
      .then(setRows)
      .catch((e: Error) => setError(e.message));
    // Se carga una vez al abrir; el botón «Actualizar» de la página vuelve a montar el componente.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (error) return <p className="error" role="alert">{error}</p>;
  if (!rows) return <p className="muted">Cargando…</p>;
  if (rows.length === 0) return <p className="muted">Todavía no hay actividad.</p>;

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Cuándo</th>
            <th>Qué</th>
            <th>Persona</th>
            {showTenant && <th>Corredora</th>}
            <th>Hecho por</th>
            <th>Desde</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((e) => (
            <tr key={e.id} className={e.event.endsWith('failed') || e.event.endsWith('locked') || e.event === 'session_reuse_detected' ? 'row-alert' : ''}>
              <td>{formatDateTimeSeconds(e.at)}</td>
              <td>{AUTH_EVENT_LABEL[e.event] ?? e.event}</td>
              <td>
                {e.userName ?? '—'}
                {e.email && <span className="muted"> {e.email}</span>}
              </td>
              {showTenant && <td>{e.tenantName ?? '—'}</td>}
              <td>{e.actorName ?? '—'}</td>
              <td>
                <span className="muted" title={e.userAgent ?? ''}>
                  {e.ip ?? '—'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
