import { useState, type FormEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ApiRequestError, authApi } from '../api';

const message = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

/** Pide el enlace de recuperación. La respuesta es la misma exista o no la cuenta: no se delata quién está registrado. */
export function ForgotPassword() {
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!email.trim()) return setError('Escriba su correo.');
    setBusy(true);
    setError(null);
    try {
      await authApi.resetRequest(email.trim());
      setSent(true);
    } catch (err) {
      setError(message(err, 'No se pudo enviar la solicitud.'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="container narrow">
      <h1>Recuperar la contraseña</h1>
      {sent ? (
        <div className="card">
          <p>Si el correo está registrado, le enviamos un enlace para elegir una contraseña nueva. Vale 60 minutos y se usa una sola vez.</p>
          <p className="hint">¿Es el operador de la plataforma, o su corredora no tiene correo configurado? Pida a un administrador que le restablezca la contraseña.</p>
          <Link to="/conectar">Volver a entrar</Link>
        </div>
      ) : (
        <form className="card" onSubmit={submit} noValidate>
          <label htmlFor="fp-email">Correo *</label>
          <input id="fp-email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={error ? 'invalid' : ''} />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Enviando…' : 'Enviar enlace'}
            </button>
            <Link to="/conectar">Volver</Link>
          </div>
        </form>
      )}
    </main>
  );
}

/** Elige la contraseña nueva con el enlace del correo. Al terminar se cierran todas las sesiones de la cuenta. */
export function ResetPassword() {
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const navigate = useNavigate();
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!next) return setError('Escriba la contraseña nueva.');
    if (next !== again) return setError('La confirmación no coincide con la contraseña nueva.');
    setBusy(true);
    setError(null);
    try {
      await authApi.resetComplete(token, next);
      setDone(true);
      window.setTimeout(() => navigate('/conectar', { replace: true }), 2500);
    } catch (err) {
      setError(message(err, 'No se pudo cambiar la contraseña.'));
    } finally {
      setBusy(false);
    }
  }

  if (!token) {
    return (
      <main className="container narrow">
        <h1>Enlace incompleto</h1>
        <p>
          Abra el enlace tal como llegó a su correo, o <Link to="/olvide">pida uno nuevo</Link>.
        </p>
      </main>
    );
  }
  return (
    <main className="container narrow">
      <h1>Elija una contraseña nueva</h1>
      {done ? (
        <p className="card">Listo: su contraseña cambió. Ya puede entrar con la nueva.</p>
      ) : (
        <form className="card" onSubmit={submit} noValidate>
          <label htmlFor="rp-next">Contraseña nueva *</label>
          <input id="rp-next" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
          <p className="hint">Al menos 10 caracteres, con letras y números.</p>
          <label htmlFor="rp-again">Repita la contraseña nueva *</label>
          <input id="rp-again" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
          {error && <p className="error" role="alert">{error}</p>}
          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? 'Guardando…' : 'Cambiar contraseña'}
          </button>
        </form>
      )}
    </main>
  );
}
