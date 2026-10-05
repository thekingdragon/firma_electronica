import { useCallback, useEffect, useRef, useState } from 'react';
import { SignApiError, signApi, type Challenge, type SigningView } from './signApi';
import { meetsMinimum, useCamera, type Captured } from './useCamera';

export interface TakenPhoto extends Captured {
  url: string;
  challenge: Challenge | null;
}

/** Segundos que faltan hasta `iso` (0 si ya pasó). Se actualiza cada segundo. */
function useSecondsUntil(iso: string | null): number {
  const target = iso ? new Date(iso).getTime() : 0;
  const calc = () => Math.max(0, Math.ceil((target - Date.now()) / 1000));
  const [left, setLeft] = useState(calc);
  useEffect(() => {
    setLeft(calc());
    if (!target) return;
    const id = setInterval(() => setLeft(calc()), 1000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target]);
  return left;
}

const mmss = (s: number) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

export function PhotoStep({
  kind = 'selfie',
  token,
  session,
  view,
  initial,
  onBack,
  onTaken,
  onSessionExpired,
}: {
  /** `selfie`: el rostro con el papel y el código. `document`: solo el documento de identidad. */
  kind?: 'selfie' | 'document';
  token: string;
  session: string;
  view: SigningView;
  initial: TakenPhoto | null;
  onBack: () => void;
  onTaken: (p: TakenPhoto) => void;
  onSessionExpired: () => void;
}) {
  const cam = useCamera();
  const [challenge, setChallenge] = useState<Challenge | null>(initial?.challenge ?? null);
  const [shot, setShot] = useState<TakenPhoto | null>(initial);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = useSecondsUntil(challenge?.expiresAt ?? null);
  const isDocument = kind === 'document';
  const needsChallenge = !isDocument && view.policy.photoChallengeRequired;
  const expired = needsChallenge && challenge !== null && left === 0;
  const requested = useRef(false);

  const newChallenge = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setChallenge(await signApi.photoChallenge(token, session));
      // La foto anterior tiene el código viejo: ya no sirve.
      setShot((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
    } catch (e) {
      if (e instanceof SignApiError && e.status === 401) onSessionExpired();
      setError(e instanceof Error ? e.message : 'No se pudo obtener el código.');
    } finally {
      setBusy(false);
    }
  }, [token, session, onSessionExpired]);

  // El código se pide una sola vez al entrar (y a mano si vence o se quiere otro).
  useEffect(() => {
    if (needsChallenge && !challenge && !requested.current) {
      requested.current = true;
      void newChallenge();
    }
  }, [needsChallenge, challenge, newChallenge]);

  async function take() {
    setError(null);
    try {
      const c = await cam.capture();
      const url = URL.createObjectURL(c.blob);
      setShot((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return { ...c, url, challenge };
      });
      cam.stop();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'No se pudo tomar la foto.');
    }
  }

  function retake() {
    setShot((prev) => {
      if (prev) URL.revokeObjectURL(prev.url);
      return null;
    });
    void cam.start(isDocument ? 'environment' : 'user');
  }

  const tooSmall = shot ? !meetsMinimum(shot.width, shot.height) : false;
  const cameraOn = cam.state.status === 'ready' || cam.state.status === 'starting';

  return (
    <section className="card">
      <h2>{isDocument ? 'Foto de su documento' : 'Su fotografía'}</h2>
      {isDocument ? (
        <p>
          Tómele una foto a su <strong>{view.signer.documentType}</strong> (la cara donde se ve su foto y su número) <strong>en este
          momento</strong>. Ponga el documento sobre una superficie plana, con buena luz. No se puede subir una foto guardada.
        </p>
      ) : (
        <p>
          Para confirmar que es usted quien firma ahora, tómese una foto de su rostro (selfie) <strong>en este momento</strong>,
          sosteniendo el papel con el número. No se puede subir una foto guardada.
        </p>
      )}

      {needsChallenge && (
        <div className={`challenge${expired ? ' expired' : ''}`} aria-live="polite">
          {challenge ? (
            <>
              <div className="challenge-label">Escriba este número en un papel y sosténgalo junto a su rostro</div>
              <div className="challenge-code" aria-label={`Código ${challenge.code.split('').join(' ')}`}>{challenge.code}</div>
              <div className="challenge-timer">
                {expired ? 'Este código venció.' : `Vence en ${mmss(left)}`}
              </div>
              <button type="button" className="btn btn-link" onClick={newChallenge} disabled={busy}>
                {busy ? 'Pidiendo…' : 'Pedir otro código (la foto se vuelve a tomar)'}
              </button>
            </>
          ) : (
            <div className="challenge-label">{busy ? 'Obteniendo su código…' : 'No hay código todavía.'}</div>
          )}
        </div>
      )}

      <ul className="tips">
        {isDocument ? (
          <li>Que el documento se vea completo y se lean con claridad su número y sus datos.</li>
        ) : (
          <li>Que se vean claros su rostro y el papel con el número.</li>
        )}
        <li>Busque buena luz y evite reflejos.</li>
      </ul>

      <div className="camera" style={{ aspectRatio: String(shot ? shot.width / shot.height : (cam.aspect ?? 4 / 3)) }}>
        {/* Siempre montado para poder asignar el stream; se oculta si no hay cámara activa. */}
        <video
          ref={cam.videoRef}
          playsInline
          muted
          className={`camera-video${cameraOn ? '' : ' hidden'}${cam.mirrored ? ' mirrored' : ''}`}
        />
        {shot && <img className="camera-shot" src={shot.url} alt="Su fotografía tomada" />}
        {!cameraOn && !shot && <div className="camera-placeholder">La cámara está apagada</div>}
      </div>

      {cam.state.status === 'ready' && cam.mirrored && (
        <p className="hint">La vista previa se ve como un espejo; la foto saldrá normal y el número se leerá bien.</p>
      )}
      {cam.state.status === 'error' && <p className="error" role="alert">{cam.state.message}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {tooSmall && shot && (
        <p className="error" role="alert">
          La foto salió muy pequeña ({shot.width}×{shot.height}). Pruebe con otro dispositivo o navegador: se necesita al menos 1280×720.
        </p>
      )}

      {!shot && cam.state.status !== 'ready' && (
        <button type="button" className="btn btn-primary btn-block" onClick={() => cam.start(isDocument ? 'environment' : 'user')} disabled={cam.state.status === 'starting' || (needsChallenge && (!challenge || expired))}>
          {cam.state.status === 'starting' ? 'Abriendo la cámara…' : 'Activar la cámara'}
        </button>
      )}
      {!shot && cam.state.status === 'ready' && (
        <button type="button" className="btn btn-primary btn-block" onClick={take} disabled={expired}>
          Tomar la foto
        </button>
      )}
      {shot && (
        <div className="actions">
          <button type="button" className="btn" onClick={retake}>Repetir la foto</button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={tooSmall || expired}
            onClick={() => onTaken(shot)}
          >
            Usar esta foto
          </button>
        </div>
      )}
      {expired && <p className="error" role="alert">El código venció: pida otro y vuelva a tomar la foto.</p>}

      <button type="button" className="btn btn-block btn-link" onClick={() => { cam.stop(); onBack(); }}>
        ← Volver al documento
      </button>
    </section>
  );
}
