import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, api } from '../api';
import { useSession } from '../auth';
import { desfaseUtc, zonasDisponibles } from '../fechas';
import { MailSettingsCard } from '../components/MailSettingsCard';
import { setPanelZone } from '../format';

export function Settings() {
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState('');
  const [zone, setZone] = useState<string | null>(null);
  const [savedZone, setSavedZone] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    api
      .settings()
      .then((s) => {
        setNotice(s.privacyNotice ?? '');
        setSaved(s.privacyNotice ?? '');
        setZone(s.timezone);
        setSavedZone(s.timezone);
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  async function save(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setDone(false);
    try {
      const r = await api.saveSettings({ privacyNotice: (notice ?? '').trim() === '' ? null : (notice ?? '').trim(), ...(zone ? { timezone: zone } : {}) });
      setNotice(r.privacyNotice ?? '');
      setSaved(r.privacyNotice ?? '');
      setZone(r.timezone);
      setSavedZone(r.timezone);
      setPanelZone(r.timezone);
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
      <MailSettingsCard />

      <form className="card" onSubmit={save}>
        <h2>Zona horaria</h2>
        <p className="muted">
          Con esta zona se escriben las fechas y horas del documento firmado, de los correos y de este panel, siempre con el desfase al lado
          (por ejemplo «04/10/2026 12:35 (UTC-5)»). Lo guardado en el sistema no cambia: solo cómo se muestra. Los PDF ya firmados conservan la zona
          con que se firmaron.
        </p>
        {zone !== null && (
          <>
            <label htmlFor="zona">Zona horaria *</label>
            <select id="zona" value={zone} onChange={(e) => { setZone(e.target.value); setDone(false); }}>
              {(zonasDisponibles().includes(zone) ? zonasDisponibles() : [zone, ...zonasDisponibles()]).map((z) => (
                <option key={z} value={z}>
                  {z} ({desfaseUtc(z)})
                </option>
              ))}
            </select>
          </>
        )}

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
          <button type="submit" className="btn btn-primary" disabled={busy || notice === null || (notice === saved && zone === savedZone)}>
            {busy ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </>
  );
}
