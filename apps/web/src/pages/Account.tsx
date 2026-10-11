import { useState, type FormEvent } from 'react';
import { ApiRequestError, authApi } from '../api';
import { useAuth, useSession } from '../auth';
import { MfaEnroll, RecoveryCodes } from '../components/MfaEnroll';
import { ChangePassword } from './ChangePassword';

const ROLE: Record<string, string> = { OPERATOR: 'Operador de la plataforma', ADMIN: 'Administrador', REVIEWER: 'Revisor' };

/** Mi cuenta: contraseña y segundo factor. */
export function Account() {
  const { user, tenant } = useSession();
  const { adopt } = useAuth();
  const [stage, setStage] = useState<'idle' | 'enroll' | 'codes' | 'disable'>('idle');
  const [codes, setCodes] = useState<string[]>([]);
  const [pw, setPw] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** El servidor solo cambió el estado del factor: se repide la sesión para que el panel lo refleje. */
  async function refreshProfile() {
    const s = await authApi.refresh();
    if (s) adopt(s);
  }

  async function disable(e: FormEvent) {
    e.preventDefault();
    if (!pw || !code.trim()) return setError('Escriba su contraseña y un código de su aplicación.');
    setBusy(true);
    setError(null);
    try {
      await authApi.mfaDisable(pw, code.trim());
      setStage('idle');
      setPw('');
      setCode('');
      await refreshProfile();
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'No se pudo desactivar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <h1>Mi cuenta</h1>
      <div className="card">
        <p>
          <strong>{user.name}</strong>
          <br />
          {user.email}
          <br />
          <span className="muted">
            {ROLE[user.role]}
            {tenant ? ` · ${tenant.name}` : ''}
          </span>
        </p>
      </div>

      <div className="card">
        <h2>Verificación en dos pasos</h2>
        {stage === 'codes' ? (
          <RecoveryCodes
            codes={codes}
            onContinue={() => {
              setStage('idle');
              void refreshProfile();
            }}
          />
        ) : stage === 'enroll' ? (
          <MfaEnroll
            load={authApi.mfaSetup}
            confirm={async (c) => (await authApi.mfaEnable(c)).recoveryCodes}
            onDone={(c) => {
              setCodes(c);
              setStage('codes');
            }}
          />
        ) : user.mfaEnabled ? (
          <>
            <p>
              <span className="badge badge-signed">Activada</span> Al entrar, además de la contraseña se pide un código de su aplicación.
            </p>
            {user.role === 'OPERATOR' ? (
              <p className="hint">Para su rol es obligatoria: no se puede desactivar.</p>
            ) : stage === 'disable' ? (
              <form onSubmit={disable} noValidate>
                <label htmlFor="d-pw">Su contraseña *</label>
                <input id="d-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} />
                <label htmlFor="d-code">Código de la aplicación *</label>
                <input id="d-code" inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} />
                {error && <p className="error" role="alert">{error}</p>}
                <div className="actions">
                  <button className="btn btn-danger-outline" type="submit" disabled={busy}>
                    {busy ? 'Desactivando…' : 'Desactivar'}
                  </button>
                  <button
                    className="btn btn-ghost"
                    type="button"
                    onClick={() => {
                      setStage('idle');
                      setError(null);
                    }}
                  >
                    Cancelar
                  </button>
                </div>
              </form>
            ) : (
              <button className="btn btn-ghost" type="button" onClick={() => setStage('disable')}>
                Desactivar
              </button>
            )}
          </>
        ) : (
          <>
            <p>Protege su cuenta aunque alguien conozca su contraseña.{user.role === 'ADMIN' ? ' Recomendado para administradores, que ven toda la evidencia de la corredora.' : ''}</p>
            <button className="btn btn-primary" type="button" onClick={() => setStage('enroll')}>
              Activar
            </button>
          </>
        )}
      </div>

      <ChangePassword />
    </>
  );
}
