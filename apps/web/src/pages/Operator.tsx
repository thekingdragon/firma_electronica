import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { formatDateTime } from '../format';

/**
 * Panel de OPERADOR: quien administra el servicio entero, por encima de cada corredora. Usa su propia clave
 * (X-Operator-Key), distinta de la clave de API de un tenant, y la guarda solo mientras la pestaña esté abierta.
 */
const STORAGE = 'fes.operatorKey';

interface Overview {
  service: { database: boolean; storageWritable: boolean; secretsKey: boolean; sealKey: boolean; timestampAuthority: boolean; backgroundJobs: boolean };
  totals: {
    tenants: number;
    activeTenants: number;
    requests: Record<string, number>;
    signedLast30Days: number;
    timestampsPending: number;
    timestampsGivenUp: number;
    webhooksFailed: number;
    webhooksPending: number;
    mailWithErrors: number;
  };
}
interface TenantRow {
  id: string;
  name: string;
  legalName: string;
  country: string;
  active: boolean;
  createdAt: string;
  mailConfigured: boolean;
  mailLastError: string | null;
  signed: number;
  pending: number;
  lastSignedAt: string | null;
  timestampsPending: number;
  webhooksFailed: number;
  reviewPending: number;
}
interface VerifyResult {
  checked: number;
  ok: number;
  unsealed: number;
  failed: { requestId: string; reference: string; problems: string[] }[];
}
interface Created {
  tenant: { id: string; name: string };
  apiKey: string;
  webhookSecret: string | null;
}

class OpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

async function op<T>(key: string, method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/v1/operator${path}`, {
      method,
      headers: { 'X-Operator-Key': key, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new OpError(0, 'No se pudo conectar con el servicio.');
  }
  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const detalle = Array.isArray(json?.issues) && json.issues.length ? ` (${json.issues.map((i: { message: string }) => i.message).join('; ')})` : '';
    throw new OpError(res.status, `${json?.message ?? `Error ${res.status}`}${detalle}`);
  }
  return json as T;
}

function loadKey(): string | null {
  try {
    return sessionStorage.getItem(STORAGE);
  } catch {
    return null;
  }
}
function saveKey(k: string | null) {
  try {
    if (k) sessionStorage.setItem(STORAGE, k);
    else sessionStorage.removeItem(STORAGE);
  } catch {
    /* sin almacenamiento: dura lo que dure la pestaña */
  }
}

function Login({ onKey }: { onKey: (k: string) => void }) {
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) return setError('Ingrese la clave de operador.');
    setBusy(true);
    setError(null);
    try {
      await op<Overview>(key.trim(), 'GET', '/overview');
      saveKey(key.trim());
      onKey(key.trim());
    } catch (err) {
      setError(
        err instanceof OpError && err.status === 404
          ? 'El panel de operador no está habilitado en este servidor (o solo se abre desde la máquina del servicio).'
          : err instanceof Error
            ? err.message
            : 'No se pudo conectar.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <h1>Panel de operador</h1>
      <p className="lead">Administración del servicio completo. No es el panel de una corredora.</p>
      <form className="card" onSubmit={submit} noValidate>
        <label htmlFor="opkey">Clave de operador *</label>
        <input id="opkey" type="password" autoComplete="off" spellCheck={false} value={key} onChange={(e) => setKey(e.target.value)} className={error ? 'invalid' : ''} />
        {error && <p className="error" role="alert">{error}</p>}
        <p className="hint">Es la variable <code>OPERATOR_KEY</code> del servidor.</p>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Conectando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}

const Dot = ({ ok, warn }: { ok: boolean; warn?: boolean }) => <span className={`dot ${ok ? 'dot-ok' : warn ? 'dot-warn' : 'dot-bad'}`} aria-hidden="true" />;

function Stat({ label, value, bad }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div className={`stat ${bad ? 'stat-bad' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function NewTenant({ opKey, onCreated }: { opKey: string; onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', legalName: '', country: 'PE', registryCode: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<Created | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = { name: form.name, legalName: form.legalName, country: form.country, ...(form.registryCode.trim() ? { registryCode: form.registryCode.trim() } : {}) };
      setCreated(await op<Created>(opKey, 'POST', '/tenants', body));
      setForm({ name: '', legalName: '', country: 'PE', registryCode: '' });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo crear.');
    } finally {
      setBusy(false);
    }
  }
  const set = (k: keyof typeof form) => (e: ChangeEvent<HTMLInputElement>) => setForm({ ...form, [k]: e.target.value });

  return (
    <div className="card">
      <h2>Nueva corredora</h2>
      <form onSubmit={submit} noValidate>
        <div className="grid">
          <div>
            <label htmlFor="n-name">Nombre *</label>
            <input id="n-name" value={form.name} onChange={set('name')} />
          </div>
          <div>
            <label htmlFor="n-legal">Razón social *</label>
            <input id="n-legal" value={form.legalName} onChange={set('legalName')} />
          </div>
          <div>
            <label htmlFor="n-country">País *</label>
            <input id="n-country" maxLength={2} value={form.country} onChange={set('country')} />
          </div>
          <div>
            <label htmlFor="n-reg">Código de registro</label>
            <input id="n-reg" value={form.registryCode} onChange={set('registryCode')} />
          </div>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Creando…' : 'Crear corredora'}
        </button>
      </form>
      {created && (
        <div className="notice" role="status">
          <p>
            <strong>{created.tenant.name}</strong> creada. Entregue esta clave a la corredora; <strong>no se vuelve a mostrar</strong>:
          </p>
          <code className="secret">{created.apiKey}</code>
          {created.webhookSecret && (
            <p>
              Secreto del webhook: <code className="secret">{created.webhookSecret}</code>
            </p>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setCreated(null)}>
            Ya la copié
          </button>
        </div>
      )}
    </div>
  );
}

export function Operator() {
  const [key, setKey] = useState<string | null>(loadKey);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [tenants, setTenants] = useState<TenantRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerifyResult>>({});

  const logout = useCallback(() => {
    saveKey(null);
    setKey(null);
    setOverview(null);
  }, []);

  const load = useCallback(async () => {
    if (!key) return;
    try {
      const [o, t] = await Promise.all([op<Overview>(key, 'GET', '/overview'), op<{ tenants: TenantRow[] }>(key, 'GET', '/tenants')]);
      setOverview(o);
      setTenants(t.tenants);
      setError(null);
    } catch (err) {
      if (err instanceof OpError && (err.status === 401 || err.status === 404)) logout();
      else setError(err instanceof Error ? err.message : 'No se pudo cargar.');
    }
  }, [key, logout]);

  useEffect(() => {
    void load();
  }, [load]);

  if (!key) return <Login onKey={setKey} />;

  async function toggle(t: TenantRow) {
    if (t.active && !window.confirm(`¿Desactivar a ${t.name}? Su clave de API dejará de funcionar de inmediato.`)) return;
    try {
      await op(key as string, 'POST', `/tenants/${t.id}/active`, { active: !t.active });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo cambiar.');
    }
  }

  async function verify(t: TenantRow) {
    setVerifying(t.id);
    try {
      const r = await op<VerifyResult>(key as string, 'POST', `/tenants/${t.id}/verify`);
      setResults((prev) => ({ ...prev, [t.id]: r }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo verificar.');
    } finally {
      setVerifying(null);
    }
  }

  const s = overview?.service;
  const tot = overview?.totals;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong className="brand">Firma electrónica · Operador</strong>
          <div className="who">
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              Actualizar
            </button>
            <button type="button" className="btn btn-ghost" onClick={logout}>
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}

        {s && tot && (
          <>
            <div className="card">
              <h2>Estado del servicio</h2>
              <ul className="health">
                <li><Dot ok={s.database} /> Base de datos</li>
                <li><Dot ok={s.storageWritable} /> Carpeta de archivos escribible</li>
                <li><Dot ok={s.secretsKey} /> <code>SECRETS_KEY</code> configurada</li>
                <li><Dot ok={s.sealKey} warn /> Llave de sello {s.sealKey ? 'creada' : '(se crea con la primera firma)'}</li>
                <li><Dot ok={s.timestampAuthority} warn /> Sello de tiempo de un tercero {s.timestampAuthority ? 'activo' : 'sin configurar (TSA_URL)'}</li>
                <li><Dot ok={s.backgroundJobs} /> Tareas en segundo plano</li>
              </ul>
            </div>

            <div className="stats">
              <Stat label="Corredoras activas" value={`${tot.activeTenants}/${tot.tenants}`} />
              <Stat label="Firmadas (30 días)" value={tot.signedLast30Days} />
              <Stat label="Pendientes de firma" value={tot.requests.PENDING ?? 0} />
              <Stat label="Sellos de tiempo pendientes" value={tot.timestampsPending} bad={tot.timestampsPending > 0} />
              <Stat label="Sellos de tiempo abandonados" value={tot.timestampsGivenUp} bad={tot.timestampsGivenUp > 0} />
              <Stat label="Webhooks fallidos" value={tot.webhooksFailed} bad={tot.webhooksFailed > 0} />
              <Stat label="Corredoras con error de correo" value={tot.mailWithErrors} bad={tot.mailWithErrors > 0} />
            </div>
          </>
        )}

        <h2>Corredoras</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Corredora</th>
                <th>Firmadas</th>
                <th>Pendientes</th>
                <th>Última firma</th>
                <th>Por revisar</th>
                <th>Alertas</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {tenants.map((t) => {
                const r = results[t.id];
                const sinAlertas = t.mailConfigured && !t.mailLastError && t.webhooksFailed === 0 && t.timestampsPending === 0;
                return (
                  <tr key={t.id} className={t.active ? '' : 'row-off'}>
                    <td>
                      <strong>{t.name}</strong> <span className="muted">{t.country}</span>
                      <br />
                      <span className="muted">{t.legalName}</span>
                      {!t.active && <span className="badge badge-expired"> Desactivada</span>}
                    </td>
                    <td>{t.signed}</td>
                    <td>{t.pending}</td>
                    <td>{t.lastSignedAt ? formatDateTime(t.lastSignedAt) : '—'}</td>
                    <td>{t.reviewPending}</td>
                    <td>
                      {!t.mailConfigured && <div className="warn">Sin correo propio</div>}
                      {t.mailLastError && <div className="warn" title={t.mailLastError}>Error de correo</div>}
                      {t.webhooksFailed > 0 && <div className="warn">{t.webhooksFailed} webhooks fallidos</div>}
                      {t.timestampsPending > 0 && <div className="warn">{t.timestampsPending} sellos de tiempo pendientes</div>}
                      {sinAlertas && '—'}
                      {r && (
                        <div className={r.failed.length ? 'warn' : 'verified'}>
                          {r.failed.length
                            ? `${r.failed.length} de ${r.checked} con problemas: ${r.failed.map((f) => f.reference).join(', ')}`
                            : `${r.ok} de ${r.checked} íntegras${r.unsealed ? `, ${r.unsealed} anteriores al sello` : ''}`}
                        </div>
                      )}
                    </td>
                    <td className="actions-cell">
                      <button type="button" className="btn" onClick={() => void verify(t)} disabled={verifying === t.id}>
                        {verifying === t.id ? 'Verificando…' : 'Verificar firmas'}
                      </button>{' '}
                      <button type="button" className={t.active ? 'btn btn-danger-outline' : 'btn'} onClick={() => void toggle(t)}>
                        {t.active ? 'Desactivar' : 'Activar'}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="hint">«Verificar firmas» revisa las últimas 100 de la corredora: PDF, sello, sello de tiempo y bitácora.</p>

        <NewTenant opKey={key} onCreated={() => void load()} />
      </main>
    </>
  );
}
