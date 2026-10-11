import { useCallback, useEffect, useState, type ChangeEvent, type FormEvent } from 'react';
import { NavLink } from 'react-router-dom';
import { ApiRequestError, operatorApi, type CreatedTenant, type OperatorOverview, type OperatorTenant, type VerifyResult } from '../api';
import { useAuth, useSession } from '../auth';
import { formatDateTime } from '../format';

/**
 * Panel de OPERADOR: quien administra el servicio entero, por encima de cada corredora. Entra con su usuario (rol
 * OPERATOR, segundo factor obligatorio) por el mismo login que los demás.
 */
const message = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

const Dot = ({ ok, warn }: { ok: boolean; warn?: boolean }) => <span className={`dot ${ok ? 'dot-ok' : warn ? 'dot-warn' : 'dot-bad'}`} aria-hidden="true" />;

function Stat({ label, value, bad }: { label: string; value: number | string; bad?: boolean }) {
  return (
    <div className={`stat ${bad ? 'stat-bad' : ''}`}>
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

function NewTenant({ onCreated }: { onCreated: () => void }) {
  const [form, setForm] = useState({ name: '', legalName: '', country: 'PE', registryCode: '', adminEmail: '', adminName: '' });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<CreatedTenant | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const body = {
        name: form.name,
        legalName: form.legalName,
        country: form.country,
        ...(form.registryCode.trim() ? { registryCode: form.registryCode.trim() } : {}),
        ...(form.adminEmail.trim() ? { adminEmail: form.adminEmail.trim(), adminName: form.adminName.trim() } : {}),
      };
      setCreated(await operatorApi.createTenant(body));
      setForm({ name: '', legalName: '', country: 'PE', registryCode: '', adminEmail: '', adminName: '' });
      onCreated();
    } catch (err) {
      setError(message(err, 'No se pudo crear.'));
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
          <div>
            <label htmlFor="n-admin-name">Primer administrador: nombre</label>
            <input id="n-admin-name" value={form.adminName} onChange={set('adminName')} />
          </div>
          <div>
            <label htmlFor="n-admin-email">Primer administrador: correo</label>
            <input id="n-admin-email" type="email" value={form.adminEmail} onChange={set('adminEmail')} />
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
            <strong>{created.tenant.name}</strong> creada. Entregue estos datos; <strong>no se vuelven a mostrar</strong>:
          </p>
          {created.admin && (
            <p>
              Administrador <strong>{created.admin.email}</strong>, contraseña provisional (deberá cambiarla al entrar):
              <code className="secret">{created.admin.temporaryPassword}</code>
            </p>
          )}
          <p>
            Clave de API para la integración del host (sistema a sistema, no para el panel): <code className="secret">{created.apiKey}</code>
          </p>
          {created.webhookSecret && (
            <p>
              Secreto del webhook: <code className="secret">{created.webhookSecret}</code>
            </p>
          )}
          <button type="button" className="btn btn-ghost" onClick={() => setCreated(null)}>
            Ya los copié
          </button>
        </div>
      )}
    </div>
  );
}

export function Operator() {
  const { user } = useSession();
  const { disconnect } = useAuth();
  const [overview, setOverview] = useState<OperatorOverview | null>(null);
  const [tenants, setTenants] = useState<OperatorTenant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [verifying, setVerifying] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, VerifyResult>>({});
  const [temp, setTemp] = useState<{ who: string; password: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const [o, t] = await Promise.all([operatorApi.overview(), operatorApi.tenants()]);
      setOverview(o);
      setTenants(t);
      setError(null);
    } catch (err) {
      setError(message(err, 'No se pudo cargar.'));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(t: OperatorTenant) {
    if (t.active && !window.confirm(`¿Desactivar a ${t.name}? Sus usuarios y su clave de API dejarán de funcionar de inmediato.`)) return;
    try {
      await operatorApi.setActive(t.id, !t.active);
      await load();
    } catch (err) {
      setError(message(err, 'No se pudo cambiar.'));
    }
  }

  async function verify(t: OperatorTenant) {
    setVerifying(t.id);
    try {
      const r = await operatorApi.verify(t.id);
      setResults((prev) => ({ ...prev, [t.id]: r }));
    } catch (err) {
      setError(message(err, 'No se pudo verificar.'));
    } finally {
      setVerifying(null);
    }
  }

  async function addAdmin(t: OperatorTenant) {
    const email = window.prompt(`Correo del nuevo administrador de ${t.name}:`)?.trim();
    if (!email) return;
    const name = window.prompt('Nombre de esa persona:')?.trim();
    if (!name) return;
    try {
      const r = await operatorApi.addAdmin(t.id, email, name);
      setTemp({ who: r.email, password: r.temporaryPassword });
    } catch (err) {
      setError(message(err, 'No se pudo agregar.'));
    }
  }

  const s = overview?.service;
  const tot = overview?.totals;

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong className="brand">Firma electrónica · Operador</strong>
          <nav>
            <NavLink to="/cuenta">Mi cuenta</NavLink>
          </nav>
          <div className="who">
            <span>{user.name}</span>
            <button type="button" className="btn btn-ghost" onClick={() => void load()}>
              Actualizar
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => void disconnect()}>
              Salir
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        {error && <p className="error" role="alert">{error}</p>}

        {temp && (
          <div className="notice" role="status">
            <p>
              Contraseña provisional de <strong>{temp.who}</strong> (<strong>no se vuelve a mostrar</strong>):
            </p>
            <code className="secret">{temp.password}</code>
            <button type="button" className="btn btn-ghost" onClick={() => setTemp(null)}>
              Ya la copié
            </button>
          </div>
        )}

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
                      <button type="button" className="btn" onClick={() => void addAdmin(t)}>
                        Agregar administrador
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

        <NewTenant onCreated={() => void load()} />
      </main>
    </>
  );
}
