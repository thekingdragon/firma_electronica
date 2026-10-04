import { useEffect, useState, type FormEvent } from 'react';
import { SignApiError, signApi, type SignIntro, type Verified } from './signApi';

/** Cuenta regresiva en segundos hasta 0; se reinicia cada vez que cambia `from`. */
function useCountdown(from: number): number {
  const [left, setLeft] = useState(from);
  useEffect(() => {
    setLeft(from);
    if (from <= 0) return;
    const id = setInterval(() => setLeft((s) => (s <= 1 ? (clearInterval(id), 0) : s - 1)), 1000);
    return () => clearInterval(id);
  }, [from]);
  return left;
}

export function VerifyStep({
  token,
  intro,
  onVerified,
}: {
  token: string;
  intro: SignIntro;
  onVerified: (v: Verified) => void;
}) {
  const [phase, setPhase] = useState<'start' | 'code'>('start');
  const [sentTo, setSentTo] = useState<string | null>(intro.otpTo);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [cooldownFrom, setCooldownFrom] = useState(0);
  const cooldown = useCountdown(cooldownFrom);

  async function send() {
    setBusy(true);
    setError(null);
    setLocked(false);
    try {
      const r = await signApi.requestOtp(token);
      setSentTo(r.sentTo);
      setDevCode(r.devCode ?? null);
      setCode('');
      setPhase('code');
      setCooldownFrom(r.cooldownSeconds);
    } catch (e) {
      if (e instanceof SignApiError && e.code === 'OTP_COOLDOWN') {
        setPhase('code');
        setCooldownFrom(Number(e.extra.retryAfterSeconds) || 60);
      }
      setError(e instanceof Error ? e.message : 'No se pudo enviar el código.');
    } finally {
      setBusy(false);
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!/^\d{6}$/.test(code)) {
      setError('El código tiene 6 dígitos.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      onVerified(await signApi.verify(token, code));
    } catch (err) {
      if (err instanceof SignApiError) {
        if (err.code === 'OTP_INVALID') {
          const left = Number(err.extra.attemptsLeft);
          setError(left > 0 ? `El código no es correcto. Le quedan ${left} ${left === 1 ? 'intento' : 'intentos'}.` : 'El código no es correcto. Pida un código nuevo.');
          if (left === 0) setLocked(true);
        } else {
          setError(err.message);
          if (err.code === 'OTP_LOCKED' || err.code === 'OTP_EXPIRED' || err.code === 'OTP_NOT_REQUESTED') setLocked(true);
        }
      } else setError('No se pudo verificar el código.');
    } finally {
      setBusy(false);
    }
  }

  async function continueWithoutOtp() {
    setBusy(true);
    setError(null);
    try {
      onVerified(await signApi.verify(token));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo continuar.');
    } finally {
      setBusy(false);
    }
  }

  if (!intro.otpRequired) {
    return (
      <section className="card">
        <h2>Antes de empezar</h2>
        <p>Va a revisar y firmar un documento de <strong>{intro.issuer.name}</strong>.</p>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="button" className="btn btn-primary btn-block" onClick={continueWithoutOtp} disabled={busy}>
          {busy ? 'Abriendo…' : 'Continuar'}
        </button>
      </section>
    );
  }

  return (
    <section className="card">
      <h2>Verifique su identidad</h2>
      <p>
        <strong>{intro.issuer.name}</strong> le envió un documento para firmar. Para protegerlo, primero le enviamos un código de
        6 dígitos a su correo{sentTo ? <> <strong>{sentTo}</strong></> : null}.
      </p>

      {phase === 'start' ? (
        <>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="button" className="btn btn-primary btn-block" onClick={send} disabled={busy}>
            {busy ? 'Enviando…' : 'Enviarme el código'}
          </button>
        </>
      ) : (
        <form onSubmit={submit} noValidate>
          {devCode && (
            <p className="notice" role="note">
              <strong>Modo desarrollo:</strong> el correo no está configurado, así que el código es <code>{devCode}</code>.
            </p>
          )}
          <label htmlFor="otp">Código de 6 dígitos *</label>
          <input
            id="otp"
            className={`otp-input${error ? ' invalid' : ''}`}
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="[0-9]*"
            maxLength={6}
            value={code}
            onChange={(e) => {
              setCode(e.target.value.replace(/\D/g, '').slice(0, 6));
              setError(null);
            }}
            disabled={locked}
            autoFocus
            aria-describedby="otp-help"
          />
          <p id="otp-help" className="hint">Revise también la carpeta de correo no deseado. El código vence en 10 minutos.</p>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="submit" className="btn btn-primary btn-block" disabled={busy || locked}>
            {busy ? 'Verificando…' : 'Verificar'}
          </button>
          <button type="button" className="btn btn-block btn-link" onClick={send} disabled={busy || cooldown > 0}>
            {cooldown > 0 ? `Pedir un código nuevo en ${cooldown} s` : 'Pedir un código nuevo'}
          </button>
        </form>
      )}
    </section>
  );
}
