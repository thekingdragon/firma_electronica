import { useEffect, useState, type FormEvent } from 'react';
import { ApiRequestError, type TotpSetup } from '../api';

/**
 * Activación del segundo factor: muestra el QR (y el secreto para teclearlo si la cámara no lo lee), pide el primer
 * código para comprobar que quedó bien y entrega los códigos de recuperación. Sirve igual para quien ya tiene sesión y
 * para el operador que debe activarlo antes de entrar: cambia solo de dónde salen el QR y la confirmación.
 */
export function MfaEnroll({
  load,
  confirm,
  onDone,
}: {
  load: () => Promise<TotpSetup>;
  confirm: (code: string) => Promise<string[]>;
  onDone: (recoveryCodes: string[]) => void;
}) {
  const [setup, setSetup] = useState<TotpSetup | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    load()
      .then((s) => {
        if (!cancelled) setSetup(s);
      })
      .catch((e) => !cancelled && setError(e instanceof Error ? e.message : 'No se pudo preparar el código QR.'));
    return () => {
      cancelled = true;
    };
    // El QR se pide una sola vez al abrir: pedirlo de nuevo cambiaría la semilla bajo los pies de quien ya la escaneó.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) return setError('Escriba los 6 dígitos que muestra su aplicación.');
    setBusy(true);
    setError(null);
    try {
      onDone(await confirm(code.trim()));
    } catch (err) {
      setError(err instanceof ApiRequestError || err instanceof Error ? err.message : 'No se pudo activar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate>
      <ol className="steps">
        <li>
          Instale una aplicación de códigos (Google Authenticator, Microsoft Authenticator, 1Password, Authy…) y escanee este código QR.
          {setup ? <img className="qr" src={setup.qr} alt="Código QR para la aplicación de códigos" width={220} height={220} /> : !error && <p className="hint">Preparando…</p>}
          {setup && (
            <p className="hint">
              ¿No puede escanearlo? Escriba esta clave en la aplicación: <code className="secret-inline">{setup.secret}</code>
            </p>
          )}
        </li>
        <li>
          Escriba el código de 6 dígitos que muestra la aplicación.
          <label htmlFor="mfa-code">Código *</label>
          <input
            id="mfa-code"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            className={error ? 'invalid' : ''}
          />
        </li>
      </ol>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="btn btn-primary" type="submit" disabled={busy || !setup}>
        {busy ? 'Comprobando…' : 'Activar'}
      </button>
    </form>
  );
}

/** Los códigos de recuperación se muestran UNA vez: quien los pierda y pierda el teléfono tendrá que pedir que le quiten el factor. */
export function RecoveryCodes({ codes, onContinue }: { codes: string[]; onContinue: () => void }) {
  const [saved, setSaved] = useState(false);
  const text = codes.join('\n');

  function download() {
    const blob = new Blob([`Códigos de recuperación de Firma electrónica\nCada uno sirve UNA vez.\n\n${text}\n`], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'codigos-de-recuperacion.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      <h2>Guarde sus códigos de recuperación</h2>
      <p>
        Si pierde el teléfono, cada uno de estos códigos le permite entrar <strong>una vez</strong>. Se muestran ahora y no se vuelven a mostrar.
      </p>
      <pre className="recovery">{text}</pre>
      <div className="actions">
        <button type="button" className="btn" onClick={() => void navigator.clipboard?.writeText(text)}>
          Copiar
        </button>
        <button type="button" className="btn" onClick={download}>
          Descargar
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
        <span>Ya los guardé en un lugar seguro</span>
      </label>
      <button className="btn btn-primary" type="button" disabled={!saved} onClick={onContinue}>
        Continuar
      </button>
    </div>
  );
}
