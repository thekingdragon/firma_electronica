import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, type TemplateListItem } from '../api';
import { useSession } from '../auth';
import { formatDateTime } from '../format';

export function Templates() {
  const { apiKey } = useSession();
  const [items, setItems] = useState<TemplateListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .templates(apiKey)
      .then(setItems)
      .catch((e: Error) => setError(e.message));
  }, [apiKey]);

  return (
    <>
      <div className="page-head">
        <h1>Plantillas de documentos</h1>
      </div>
      <p className="muted">
        El texto y la estructura de cada documento son suyos: se editan aquí. Cada cambio se publica como una versión nueva; las solicitudes que
        ya se enviaron conservan la versión con la que se crearon.
      </p>
      {error && <p className="error" role="alert">{error}</p>}
      {!items && !error && <p className="muted">Cargando…</p>}
      {items && items.length === 0 && <div className="card empty"><p>No hay plantillas.</p></div>}
      {items?.map((t) => (
        <div key={t.documentType} className="card">
          <div className="card-head">
            <h2>{t.name}</h2>
            <span className={`badge ${t.legalReviewed ? 'badge-ok' : 'badge-warn'}`}>{t.legalReviewed ? 'Revisada' : 'Sin marcar como revisada'}</span>
          </div>
          <p className="muted">
            Versión {t.activeVersion} · publicada el {formatDateTime(t.updatedAt)}
            {t.publishedBy ? ` por ${t.publishedBy}` : ''}
          </p>
          <Link to={`/plantillas/${t.documentType}`} className="btn btn-primary">
            Editar
          </Link>
        </div>
      ))}
    </>
  );
}
