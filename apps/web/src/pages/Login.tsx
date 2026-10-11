import { useState, type FormEvent } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { ApiRequestError, authApi, type SessionResponse } from '../api';
import { useAuth } from '../auth';
import { MfaEnroll, RecoveryCodes } from '../components/MfaEnroll';

type Step =
  | { kind: 'credentials' }
  | { kind: 'mfa'; pendingToken: string }
  /** El rol exige segundo factor y todavía no lo activó. */
  | { kind: 'enroll'; pendingToken: string }
  /** Factor recién activado: se muestran los códigos de recuperación antes de abrir la sesión. */
  | { kind: 'codes'; session: SessionResponse; codes: string[] };

export const homeFor = (role: string) => (role === 'OPERATOR' ? '/operador' : '/solicitudes');

const message = (e: unknown, fallback: string) => (e instanceof ApiRequestError || e instanceof Error ? e.message : fallback);

export function Login() {
  const { session, adopt } = useAuth();
  const [step, setStep] = useState<Step>({ kind: 'credentials' });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [useRecovery, setUseRecovery] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // Con los códigos de recuperación a la vista no se redirige todavía: la sesión se adopta al pulsar «Continuar».
  if (session && step.kind !== 'codes') return <Navigate to={homeFor(session.user.role)} replace />;

  async function credentials(e: FormEvent) {
    e.preventDefault();
    if (!email.trim() || !password) return setError('Escriba su correo y su contraseña.');
    setBusy(true);
    setError(null);
    try {
      const r = await authApi.login(email.trim(), password);
      if (r.status === 'ok') adopt(r);
      else setStep({ kind: r.status === 'mfa_required' ? 'mfa' : 'enroll', pendingToken: r.pendingToken });
    } catch (err) {
      setError(message(err, 'No se pudo entrar.'));
    } finally {
      setBusy(false);
    }
  }

  async function second(e: FormEvent) {
    e.preventDefault();
    if (step.kind !== 'mfa') return;
    if (!code.trim()) return setError(useRecovery ? 'Escriba uno de sus códigos de recuperación.' : 'Escriba el código de 6 dígitos.');
    setBusy(true);
    setError(null);
    try {
      adopt(await authApi.mfaVerify(step.pendingToken, useRecovery ? { recoveryCode: code.trim() } : { code: code.trim() }));
    } catch (err) {
      setError(message(err, 'No se pudo verificar el código.'));
      // El testigo intermedio vence en 5 minutos: si ya venció, no hay nada que reintentar y se vuelve a empezar.
      if (err instanceof ApiRequestError && err.code === 'INVALID_SESSION') back();
    } finally {
      setBusy(false);
    }
  }

  function back() {
    setStep({ kind: 'credentials' });
    setCode('');
    setPassword('');
    setUseRecovery(false);
  }

  if (step.kind === 'codes') {
    return (
      <main className="container narrow">
        <div className="card">
          <RecoveryCodes
            codes={step.codes}
            onContinue={() => {
              // Salir del paso «códigos» antes de adoptar: con la sesión ya abierta, el Navigate de arriba lleva al panel.
              const opened = step.session;
              setStep({ kind: 'credentials' });
              adopt(opened);
            }}
          />
        </div>
      </main>
    );
  }

  if (step.kind === 'enroll') {
    const pendingToken = step.pendingToken;
    return (
      <main className="container narrow">
        <h1>Active su segundo factor</h1>
        <p className="lead">Por su rol, el segundo factor es obligatorio. Se hace una sola vez.</p>
        <div className="card">
          <MfaEnroll
            load={() => authApi.setupPending(pendingToken)}
            confirm={async (c) => {
              const r = await authApi.enablePending(pendingToken, c);
              setStep({ kind: 'codes', session: r, codes: r.recoveryCodes });
              return r.recoveryCodes;
            }}
            onDone={() => undefined}
          />
          <button type="button" className="btn btn-ghost" onClick={back}>
            Cancelar
          </button>
        </div>
      </main>
    );
  }

  if (step.kind === 'mfa') {
    return (
      <main className="container narrow">
        <h1>Verificación en dos pasos</h1>
        <p className="lead">{useRecovery ? 'Escriba uno de sus códigos de recuperación.' : 'Escriba el código de 6 dígitos de su aplicación.'}</p>
        <form className="card" onSubmit={second} noValidate>
          <label htmlFor="code">{useRecovery ? 'Código de recuperación *' : 'Código *'}</label>
          <input
            id="code"
            autoFocus
            autoComplete="one-time-code"
            inputMode={useRecovery ? 'text' : 'numeric'}
            spellCheck={false}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={error ? 'invalid' : ''}
          />
          {error && <p className="error" role="alert">{error}</p>}
          <div className="actions">
            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? 'Verificando…' : 'Verificar'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={() => { setUseRecovery(!useRecovery); setCode(''); setError(null); }}>
              {useRecovery ? 'Usar el código de la aplicación' : 'Usar un código de recuperación'}
            </button>
            <button type="button" className="btn btn-ghost" onClick={back}>
              Volver
            </button>
          </div>
        </form>
      </main>
    );
  }

  return (
    <main className="container narrow">
      <h1>Firma electrónica</h1>
      <p className="lead">Entre con su correo y su contraseña.</p>
      <form className="card" onSubmit={credentials} noValidate>
        <label htmlFor="email">Correo *</label>
        <input id="email" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} className={error ? 'invalid' : ''} />
        <label htmlFor="password">Contraseña *</label>
        <input id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} className={error ? 'invalid' : ''} />
        {error && <p className="error" role="alert">{error}</p>}
        <p className="hint">
          <Link to="/olvide">Olvidé mi contraseña</Link>
        </p>
        <button className="btn btn-primary" type="submit" disabled={busy}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </main>
  );
}
