import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../api';
import { useSession } from '../auth';

export function Settings() {
  const { apiKey } = useSession();
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .settings(apiKey)
      .then((s) => {
        setNotice(s.privacyNotice ?? '');
        setSaved(s.privacyNotice ?? '');
      })
      .catch((e: Error) => setError(e.message));
  }, [apiKey]);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const r = await api.saveSettings(apiKey, { privacyNotice: (notice ?? '').trim() === '' ? null : (notice ?? '').trim() });
      setNotice(r.privacyNotice ?? '');
      setSaved(r.privacyNotice ?? '');
      setDone(true);
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'No se pudo guardar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div className="page-head">
        <h1>Ajustes</h1>
      </div>
      <form className="card" onSubmit={save}>
        <h2>Aviso sobre el uso de datos personales</h2>
        <p className="muted">
          Este texto va al pie de todos los correos que envía el servicio en nombre de su corredora: el código de verificación, el enlace de firma
          y la copia del documento firmado. Es un aviso informativo; el consentimiento que el firmante acepta y queda registrado se agrega como un
          bloque «Consentimiento» en la plantilla del documento.
        </p>
        {notice === null && !error && <p className="muted">Cargando…</p>}
        {notice !== null && (
          <>
            <label htmlFor="aviso">Texto del aviso</label>
            <textarea id="aviso" rows={10} maxLength={5000} value={notice} onChange={(e) => { setNotice(e.target.value); setDone(false); }} />
            <p className="hint">{notice.length}/5000 · Texto plano. Si lo deja vacío, los correos salen sin aviso.</p>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {done && <p className="ok" role="status">Guardado.</p>}
        <div className="actions">
          <button type="submit" className="btn btn-primary" disabled={busy || notice === null || notice === saved}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </>
  );
}
