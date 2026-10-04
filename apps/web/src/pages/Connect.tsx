import { useState, type FormEvent } from 'react';
import { Navigate } from 'react-router-dom';
import { ApiRequestError } from '../api';
import { useAuth } from '../auth';

export function Connect() {
  const { session, connect } = useAuth();
  const [key, setKey] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (session) return <Navigate to="/solicitudes" replace />;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!key.trim()) {
      setError('Ingrese la clave de API de su corredora.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await connect(key);
    } catch (err) {
      setError(
        err instanceof ApiRequestError && err.status === 401
          ? 'La clave no es válida o el tenant está desactivado.'
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
      <h1>Firma electrónica</h1>
      <p className="lead">Conéctese con la clave de API de su corredora para crear y seguir solicitudes de firma.</p>
      <form className="card" onSubmit={submit} noValidate>
        <label htmlFor="key">Clave de API *</label>
        <input
          id="key"
          type="password"
          autoComplete="off"
          spellCheck={false}
          value={key}
          onChange={(e) => setKey(e.target.value)}
          className={error ? 'invalid' : ''}
          placeholder="fes_…"
        />
        {error && <p className="error" role="alert">{error}</p>}
        <p className="hint">La clave se entrega una sola vez al crear el tenant (<code>npm run tenant:create</code>).</p>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Conectando…' : 'Conectar'}
        </button>
      </form>
    </main>
  );
}
