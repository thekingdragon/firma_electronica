import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, usersApi, type ManagedUser } from '../api';
import { useSession } from '../auth';
import { AuthEvents } from '../components/AuthEvents';
import { formatDateTime } from '../format';

const ROLE = { ADMIN: 'Administrador', REVIEWER: 'Revisor' } as const;
const message = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

/** Usuarios de la corredora (solo administradores). Las contraseñas provisionales se muestran UNA vez. */
export function Users() {
  const { user: me } = useSession();
  const [users, setUsers] = useState<ManagedUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({ email: '', name: '', role: 'REVIEWER' as 'ADMIN' | 'REVIEWER' });
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Contraseña provisional recién generada, a la vista hasta que se cierre. */
  const [temp, setTemp] = useState<{ who: string; password: string } | null>(null);

  const load = useCallback(() => {
    usersApi
      .list()
      .then((u) => {
        setUsers(u);
        setError(null);
      })
      .catch((e) => setError(message(e, 'No se pudo cargar la lista.')));
  }, []);

  useEffect(load, [load]);

  async function create(e: FormEvent) {
    e.preventDefault();
    if (!form.email.trim() || !form.name.trim()) return setFormError('Complete el correo y el nombre.');
    setBusy(true);
    setFormError(null);
    try {
      const r = await usersApi.create({ email: form.email.trim(), name: form.name.trim(), role: form.role });
      setTemp({ who: form.email.trim(), password: r.temporaryPassword });
      setForm({ email: '', name: '', role: 'REVIEWER' });
      load();
    } catch (err) {
      setFormError(message(err, 'No se pudo crear el usuario.'));
    } finally {
      setBusy(false);
    }
  }

  async function act(fn: () => Promise<void>) {
    try {
      await fn();
      setError(null);
      load();
    } catch (err) {
      setError(message(err, 'No se pudo completar la acción.'));
    }
  }

  async function reset(u: ManagedUser) {
    if (!window.confirm(`¿Restablecer la contraseña de ${u.name}? Se cerrarán sus sesiones y deberá elegir una nueva.`)) return;
    await act(async () => setTemp({ who: u.email, password: (await usersApi.resetPassword(u.id)).temporaryPassword }));
  }

  return (
    <>
      <h1>Usuarios</h1>
      <p className="lead">Las personas de su corredora que entran al panel. El administrador gestiona todo; el revisor consulta solicitudes y dictamina la identidad.</p>
      {error && <p className="error" role="alert">{error}</p>}

      {temp && (
        <div className="notice" role="status">
          <p>
            Contraseña provisional de <strong>{temp.who}</strong> (<strong>no se vuelve a mostrar</strong>; deberá cambiarla al entrar):
          </p>
          <code className="secret">{temp.password}</code>
          <button type="button" className="btn btn-ghost" onClick={() => setTemp(null)}>
            Ya la copié
          </button>
        </div>
      )}

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Persona</th>
              <th>Rol</th>
              <th>Segundo factor</th>
              <th>Último ingreso</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {(users ?? []).map((u) => {
              const yo = u.id === me.id;
              return (
                <tr key={u.id} className={u.active ? '' : 'row-off'}>
                  <td>
                    <strong>{u.name}</strong> {yo && <span className="muted">(usted)</span>}
                    <br />
                    <span className="muted">{u.email}</span>
                    {!u.active && <span className="badge badge-expired"> Dado de baja</span>}
                    {u.mustChangePassword && <span className="badge badge-unreviewed"> Contraseña provisional</span>}
                  </td>
                  <td>
                    {yo ? (
                      ROLE[u.role]
                    ) : (
                      <select value={u.role} aria-label={`Rol de ${u.name}`} onChange={(e) => void act(() => usersApi.update(u.id, { role: e.target.value as 'ADMIN' | 'REVIEWER' }))}>
                        <option value="ADMIN">{ROLE.ADMIN}</option>
                        <option value="REVIEWER">{ROLE.REVIEWER}</option>
                      </select>
                    )}
                  </td>
                  <td>{u.mfaEnabled ? 'Activado' : '—'}</td>
                  <td>{u.lastLoginAt ? formatDateTime(u.lastLoginAt) : 'Nunca'}</td>
                  <td className="actions-cell">
                    {!yo && (
                      <>
                        <button type="button" className="btn" onClick={() => void reset(u)}>
                          Restablecer contraseña
                        </button>{' '}
                        {u.mfaEnabled && (
                          <>
                            <button
                              type="button"
                              className="btn"
                              onClick={() => window.confirm(`¿Quitar el segundo factor de ${u.name}? Úselo si perdió el teléfono y los códigos.`) && void act(() => usersApi.resetMfa(u.id))}
                            >
                              Quitar segundo factor
                            </button>{' '}
                          </>
                        )}
                        <button
                          type="button"
                          className={u.active ? 'btn btn-danger-outline' : 'btn'}
                          onClick={() => void act(() => usersApi.update(u.id, { active: !u.active }))}
                        >
                          {u.active ? 'Dar de baja' : 'Reactivar'}
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <h2>Actividad de accesos</h2>
      <p className="muted">Quién entró, quién falló y quién cambió qué en su corredora. Solo se agrega: no se puede editar ni borrar.</p>
      <AuthEvents key={users?.length ?? 0} load={usersApi.events} />

      <div className="card">
        <h2>Nuevo usuario</h2>
        <form onSubmit={create} noValidate>
          <div className="grid">
            <div>
              <label htmlFor="u-name">Nombre *</label>
              <input id="u-name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-email">Correo *</label>
              <input id="u-email" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
            </div>
            <div>
              <label htmlFor="u-role">Rol *</label>
              <select id="u-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value as 'ADMIN' | 'REVIEWER' })}>
                <option value="REVIEWER">{ROLE.REVIEWER}</option>
                <option value="ADMIN">{ROLE.ADMIN}</option>
              </select>
            </div>
          </div>
          {formError && <p className="error" role="alert">{formError}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Creando…' : 'Crear usuario'}
          </button>
        </form>
        <p className="hint">Se genera una contraseña provisional que usted entrega a la persona; al entrar deberá elegir la suya.</p>
      </div>
    </>
  );
}
