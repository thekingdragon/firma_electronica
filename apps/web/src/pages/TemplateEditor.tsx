import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { ApiRequestError, api, type TemplateDetail, type TemplatePolicy } from '../api';
import { useSession } from '../auth';
import { getDocumentTypeUi } from '../document-types';
import { cleanBlocks, localProblems, type Block } from '../blocks';
import { BlockEditor } from '../components/BlockEditor';
import { formatDateTime } from '../format';

interface Draft {
  blocks: Block[];
  footer: string;
  clauseText: string;
  policy: TemplatePolicy;
  legalReviewed: boolean;
}

const draftOf = (d: TemplateDetail): Draft => ({
  blocks: structuredClone(d.blocks),
  footer: d.footer ?? '',
  clauseText: d.clauseText,
  policy: { ...d.policy },
  legalReviewed: d.legalReviewed,
});

/** Texto que puede mostrarse tal cual: lo que devuelve el servidor, con el lugar de cada problema. */
function describe(e: unknown): { message: string; issues: string[] } {
  if (e instanceof ApiRequestError) {
    return { message: e.message, issues: e.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)) };
  }
  return { message: e instanceof Error ? e.message : 'Ocurrió un error.', issues: [] };
}

export function TemplateEditor() {
  const { type = '' } = useParams();
  const [detail, setDetail] = useState<TemplateDetail | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [baseline, setBaseline] = useState('');
  const [loadError, setLoadError] = useState<string | null>(null);
  // Quien publica es quien entró: queda registrado con su nombre, sin teclearlo.
  const { user } = useSession();
  const by = user.name;
  const [busy, setBusy] = useState<'preview' | 'publish' | null>(null);
  const [problem, setProblem] = useState<{ message: string; issues: string[] } | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [fromVersion, setFromVersion] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoadError(null);
    api
      .template(type)
      .then((d) => {
        setDetail(d);
        const dr = draftOf(d);
        setDraft(dr);
        setBaseline(JSON.stringify(dr));
        setFromVersion(null);
      })
      .catch((e: Error) => setLoadError(e.message));
  }, [type]);

  useEffect(load, [load]);

  const dirty = useMemo(() => (draft ? JSON.stringify(draft) !== baseline : false), [draft, baseline]);

  // Un cambio sin publicar se pierde al cerrar la pestaña: se avisa.
  useEffect(() => {
    if (!dirty) return;
    const onBefore = (e: BeforeUnloadEvent) => {
      e.preventDefault();
    };
    window.addEventListener('beforeunload', onBefore);
    return () => window.removeEventListener('beforeunload', onBefore);
  }, [dirty]);

  if (loadError) {
    return (
      <>
        <p className="error" role="alert">{loadError}</p>
        <Link to="/plantillas">← Plantillas</Link>
      </>
    );
  }
  if (!detail || !draft) return <p className="muted">Cargando…</p>;

  const set = (patch: Partial<Draft>) => {
    setDraft({ ...draft, ...patch });
    setDone(null);
    setProblem(null);
  };
  const setPolicy = (patch: Partial<TemplatePolicy>) => {
    const p = { ...draft.policy, ...patch };
    // Las dependencias se cumplen solas: sin foto no hay código ni foto del documento.
    if (!p.photoRequired) {
      p.photoChallengeRequired = false;
      p.idPhotoRequired = false;
    }
    if (!p.idPhotoRequired) p.idPhotoBackRequired = false;
    set({ policy: p });
  };

  const local = localProblems(draft.blocks);
  const body = () => ({ blocks: cleanBlocks(draft.blocks), footer: draft.footer.trim(), clauseText: draft.clauseText });

  async function preview() {
    if (!draft) return;
    setProblem(null);
    setBusy('preview');
    // La ventana se abre YA, dentro del clic: si se abriera después de esperar al servidor, el navegador la bloquearía.
    const w = window.open('', '_blank');
    try {
      const blob = await api.previewTemplate(type, body());
      const url = URL.createObjectURL(blob);
      if (w) w.location.href = url;
      else window.location.href = url;
      setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (e) {
      w?.close();
      setProblem(describe(e));
    } finally {
      setBusy(null);
    }
  }

  async function publish() {
    if (!draft || !detail) return;
    if (local.length) {
      setProblem({ message: 'Hay cosas por corregir antes de publicar.', issues: local });
      return;
    }
    const next = detail.versions.reduce((m, v) => Math.max(m, v.version), 0) + 1;
    const ok = window.confirm(
      `Se publicará la versión ${next} y quedará activa.\n\nLas solicitudes que se creen desde ahora usarán este texto. Las que ya se enviaron conservan el suyo.\n\n¿Publicar?`,
    );
    if (!ok) return;
    setProblem(null);
    setBusy('publish');
    try {
      const r = await api.publishTemplate(type, { ...body(), policy: draft.policy, legalReviewed: draft.legalReviewed, publishedBy: by.trim() });
      setDone(`Versión ${r.version} publicada y activa.`);
      load();
    } catch (e) {
      setProblem(describe(e));
    } finally {
      setBusy(null);
    }
  }

  async function loadVersion(v: number) {
    if (dirty && !window.confirm('Tiene cambios sin publicar. Si carga otra versión, se pierden. ¿Continuar?')) return;
    setProblem(null);
    try {
      const d = await api.template(type, v);
      setDraft(draftOf(d));
      setFromVersion(v);
      setDone(null);
    } catch (e) {
      setProblem(describe(e));
    }
  }

  return (
    <>
      <p>
        <Link to="/plantillas">← Plantillas</Link>
      </p>
      <div className="page-head">
        <h1>{detail.name}</h1>
        <span className="badge">{`Activa: versión ${detail.versions.find((v) => v.active)?.version ?? detail.version}`}</span>
      </div>

      {detail.legacy && (
        <p className="notice">
          Esta plantilla se guardó antes de existir el editor por bloques. Lo que ve abajo es su equivalente; al publicar se guardará por bloques.
        </p>
      )}
      {fromVersion !== null && (
        <p className="notice">Está editando a partir de la versión {fromVersion}. Nada cambia hasta que publique.</p>
      )}

      <details className="card vars">
        <summary>Variables y negrita en los textos</summary>
        <p className="hint">
          Para poner algo en <strong>negrita</strong>, enciérrelo entre dos asteriscos: <code>**así**</code>. Funciona en cualquier texto, también
          alrededor de una variable: <code>**{'{{signer.name}}'}**</code>.
        </p>
        <ul>
          {detail.variables.map((v) => (
            <li key={v.name}>
              <code>{`{{${v.name}}}`}</code> — {v.label}
            </li>
          ))}
        </ul>
      </details>

      <div className="card">
        <h2>Contenido del documento</h2>
        <BlockEditor blocks={draft.blocks} onChange={(blocks) => set({ blocks })} defaultListKey={getDocumentTypeUi(type)?.defaultListKey} />
      </div>

      <div className="card">
        <h2>Pie de página</h2>
        <p className="hint">
          Se repite al pie de <strong>cada hoja</strong> del PDF y se muestra al final del documento en pantalla. Sirve para dejar los datos de quien
          firma, la fecha y <strong>quién atendió</strong> (la persona de la corredora que envió el enlace; no quien revisa la identidad). Admite las
          variables de arriba y negrita con <code>**</code>. Déjelo vacío para no poner pie de página.
        </p>
        <textarea
          rows={3}
          maxLength={400}
          value={draft.footer}
          onChange={(e) => set({ footer: e.target.value })}
          aria-label="Pie de página"
          placeholder={'Nombres y apellidos: **{{signer.name}}**  ·  {{signer.documentType}}: **{{signer.documentNumber}}**  ·  {{date}}  ·  Atendido por: **{{attendedBy}}**'}
        />
        <p className="hint">{draft.footer.length}/400</p>
      </div>

      <div className="card">
        <h2>Texto de aceptación</h2>
        <p className="hint">Es la casilla que el firmante marca para firmar. Va siempre al final, después de los anexos.</p>
        <textarea rows={4} maxLength={5000} value={draft.clauseText} onChange={(e) => set({ clauseText: e.target.value })} aria-label="Texto de aceptación" />
      </div>

      <div className="card">
        <h2>Cómo se comprueba quién firma</h2>
        <label className="check">
          <input type="checkbox" checked={draft.policy.otpRequired} onChange={(e) => setPolicy({ otpRequired: e.target.checked })} />
          <span>Código de verificación por correo (OTP)</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.policy.photoRequired} onChange={(e) => setPolicy({ photoRequired: e.target.checked })} />
          <span>Selfie en vivo</span>
        </label>
        <label className="check indent">
          <input
            type="checkbox"
            checked={draft.policy.photoChallengeRequired}
            disabled={!draft.policy.photoRequired}
            onChange={(e) => setPolicy({ photoChallengeRequired: e.target.checked })}
          />
          <span>… con un número que el firmante escribe en un papel</span>
        </label>
        <label className="check indent">
          <input
            type="checkbox"
            checked={draft.policy.idPhotoRequired}
            disabled={!draft.policy.photoRequired}
            onChange={(e) => setPolicy({ idPhotoRequired: e.target.checked })}
          />
          <span>… y foto del documento de identidad (frente)</span>
        </label>
        <label className="check indent">
          <input
            type="checkbox"
            checked={draft.policy.idPhotoBackRequired}
            disabled={!draft.policy.idPhotoRequired}
            onChange={(e) => setPolicy({ idPhotoBackRequired: e.target.checked })}
          />
          <span>… y también el reverso del documento</span>
        </label>
        <label className="check">
          <input type="checkbox" checked={draft.policy.reviewRequired} onChange={(e) => setPolicy({ reviewRequired: e.target.checked })} />
          <span>El firmante recibe su copia solo cuando alguien de la corredora verifique su identidad</span>
        </label>
        <p className="hint">
          La revisión de las fotos la hace el personal de la corredora desde cada solicitud firmada. Con la última casilla marcada, la copia
          (por correo y por descarga) queda retenida hasta que se marque «Identidad verificada».
        </p>
      </div>

      <div className="card">
        <h2>Publicar</h2>
        <label className="check">
          <input type="checkbox" checked={draft.legalReviewed} onChange={(e) => set({ legalReviewed: e.target.checked })} />
          <span>Confirmo que este texto fue revisado por el área legal de la corredora</span>
        </label>
        <p className="hint">Queda registrado como publicada por <strong>{by}</strong>.</p>

        {local.length > 0 && (
          <ul className="issues">
            {local.map((m) => (
              <li key={m}>{m}</li>
            ))}
          </ul>
        )}
        {problem && (
          <div className="error" role="alert">
            <p>{problem.message}</p>
            {problem.issues.length > 0 && (
              <ul className="issues">
                {problem.issues.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            )}
          </div>
        )}
        {done && <p className="ok" role="status">{done}</p>}

        <div className="actions">
          <button type="button" className="btn" onClick={preview} disabled={busy !== null}>
            {busy === 'preview' ? 'Generando…' : 'Vista previa en PDF'}
          </button>
          <button type="button" className="btn btn-primary" onClick={publish} disabled={busy !== null}>
            {busy === 'publish' ? 'Publicando…' : 'Publicar como versión nueva'}
          </button>
        </div>
        {dirty && <p className="hint">Hay cambios sin publicar.</p>}
      </div>

      <div className="card">
        <h2>Versiones</h2>
        <table className="table">
          <thead>
            <tr>
              <th>Versión</th>
              <th>Publicada</th>
              <th>Por</th>
              <th>Revisada</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {detail.versions.map((v) => (
              <tr key={v.version}>
                <td>
                  {v.version} {v.active && <span className="badge badge-ok">activa</span>}
                </td>
                <td>{formatDateTime(v.createdAt)}</td>
                <td>{v.publishedBy ?? '—'}</td>
                <td>{v.legalReviewed ? 'Sí' : 'No'}</td>
                <td>
                  <button type="button" className="btn btn-ghost" onClick={() => loadVersion(v.version)}>
                    Usar como base
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
