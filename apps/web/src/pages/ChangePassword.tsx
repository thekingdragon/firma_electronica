import { useState, type FormEvent } from 'react';
import { ApiRequestError, authApi } from '../api';
import { useAuth } from '../auth';

/**
 * Cambio de contraseña. Con `forced` es la única pantalla que ve quien entró con una contraseña provisional (alta o
 * restablecimiento hecho por otra persona): hasta cambiarla no puede usar nada más.
 */
export function ChangePassword({ forced = false, onDone }: { forced?: boolean; onDone?: () => void }) {
  const { adopt, disconnect } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!current || !next) return setError('Complete la contraseña actual y la nueva.');
    if (next !== again) return setError('La confirmación no coincide con la contraseña nueva.');
    setBusy(true);
    setError(null);
    try {
      adopt(await authApi.changePassword(current, next));
      setCurrent('');
      setNext('');
      setAgain('');
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'No se pudo cambiar la contraseña.');
    } finally {
      setBusy(false);
    }
  }

  const form = (
    <form className="card" onSubmit={submit} noValidate>
      {!forced && <h2>Cambiar la contraseña</h2>}
      <label htmlFor="cp-current">{forced ? 'Contraseña provisional *' : 'Contraseña actual *'}</label>
      <input id="cp-current" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
      <label htmlFor="cp-next">Contraseña nueva *</label>
      <input id="cp-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
      <p className="hint">Al menos 10 caracteres, con letras y números. Una frase larga vale más que una clave rara.</p>
      <label htmlFor="cp-again">Repita la contraseña nueva *</label>
      <input id="cp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
      {error && <p className="error" role="alert">{error}</p>}
      <div className="actions">
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Guardando…' : 'Cambiar contraseña'}
        </button>
        {forced && (
          <button type="button" className="btn btn-ghost" onClick={() => void disconnect()}>
            Salir
          </button>
        )}
      </div>
      {!forced && <p className="hint">Al cambiarla se cierran las demás sesiones abiertas con su cuenta.</p>}
    </form>
  );

  if (!forced) return form;
  return (
    <main className="container narrow">
      <h1>Elija su contraseña</h1>
      <p className="lead">Entró con una contraseña provisional. Elija una propia para continuar.</p>
      {form}
    </main>
  );
}
