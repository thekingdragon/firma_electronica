import { useCallback, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { DocumentStep, initialForm, type SignForm } from './DocumentStep';
import { DoneStep } from './DoneStep';
import { PhotoStep, type TakenPhoto } from './PhotoStep';
import { ReviewStep } from './ReviewStep';
import { SignApiError, loadSession, saveSession, signApi, type SignIntro, type SigningView, type SubmitResult, type Verified } from './signApi';
import { VerifyStep } from './VerifyStep';

type Step = 'loading' | 'closed' | 'verify' | 'document' | 'idphoto' | 'idphotoBack' | 'photo' | 'review' | 'done';

const CLOSED_TITLES: Record<string, string> = {
  ALREADY_SIGNED: 'Este documento ya fue firmado',
  LINK_EXPIRED: 'Este enlace venció',
  LINK_REVOKED: 'Este enlace ya no está disponible',
  LINK_NOT_FOUND: 'Este enlace no es válido',
};

/** Datos informativos del dispositivo para la evidencia. El servidor los acota; nada sensible. */
function clientInfo(): Record<string, string> {
  const info: Record<string, string> = { language: navigator.language, screen: `${screen.width}x${screen.height}` };
  try {
    info.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    /* sin zona horaria */
  }
  return info;
}

export function SignPage() {
  const { token = '' } = useParams();
  const [step, setStep] = useState<Step>('loading');
  const [closed, setClosed] = useState<{ code: string; message: string } | null>(null);
  const [intro, setIntro] = useState<SignIntro | null>(null);
  const [session, setSession] = useState<string | null>(null);
  const [view, setView] = useState<SigningView | null>(null);
  const [form, setForm] = useState<SignForm | null>(null);
  const [photo, setPhoto] = useState<TakenPhoto | null>(null);
  const [idPhoto, setIdPhoto] = useState<TakenPhoto | null>(null);
  const [idPhotoBack, setIdPhotoBack] = useState<TakenPhoto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<SubmitResult | null>(null);

  useEffect(() => {
    document.title = 'Firmar documento';
  }, []);

  const close = useCallback((e: unknown) => {
    const code = e instanceof SignApiError ? e.code : 'LINK_NOT_FOUND';
    setClosed({ code, message: e instanceof Error ? e.message : 'No se pudo abrir el enlace.' });
    setStep('closed');
  }, []);

  const toVerify = useCallback(
    (message?: string) => {
      saveSession(token, null);
      setSession(null);
      setView(null);
      setNotice(message ?? null);
      setStep('verify');
    },
    [token],
  );

  // Al abrir: ver si el enlace sirve y, si hay una sesión guardada (recarga de página), retomar.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const i = await signApi.intro(token);
        if (cancelled) return;
        setIntro(i);
        const stored = loadSession(token);
        if (stored) {
          try {
            const v = await signApi.view(token, stored);
            if (cancelled) return;
            setSession(stored);
            setView(v);
            setForm(initialForm(v));
            setStep('document');
            return;
          } catch {
            saveSession(token, null);
          }
        }
        setStep('verify');
      } catch (e) {
        if (cancelled) return;
        // Ya firmado y con sesión vigente en este navegador: se ofrece la copia.
        if (e instanceof SignApiError && e.code === 'ALREADY_SIGNED' && loadSession(token)) {
          setSession(loadSession(token));
          setResult({ reference: '', signedAt: '', pdfSha256: '', emailed: false, awaitingReview: false });
          setStep('done');
          return;
        }
        close(e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, close]);

  function onVerified(v: Verified) {
    saveSession(token, v.sessionToken);
    setSession(v.sessionToken);
    setView(v.view);
    setForm(initialForm(v.view));
    setNotice(null);
    setStep('document');
  }

  function afterDocument() {
    setNotice(null);
    setStep(view?.policy.idPhotoRequired ? 'idphoto' : view?.policy.photoRequired ? 'photo' : 'review');
  }

  async function sign() {
    if (!session || !view || !form) return;
    setSubmitting(true);
    setSubmitError(null);
    const body = new FormData();
    body.append('accepted', 'true');
    body.append('form', JSON.stringify({ powers: form.powers, observation: form.observation, consents: form.consents }));
    body.append('clientInfo', JSON.stringify(clientInfo()));
    if (photo) {
      body.append('photo', photo.blob, 'foto.jpg');
      if (photo.challenge) body.append('challengeId', photo.challenge.challengeId);
    }
    if (idPhoto) body.append('idPhoto', idPhoto.blob, 'documento.jpg');
    if (idPhotoBack) body.append('idPhotoBack', idPhotoBack.blob, 'documento-reverso.jpg');
    try {
      const r = await signApi.submit(token, session, body);
      if (photo) URL.revokeObjectURL(photo.url);
      if (idPhoto) URL.revokeObjectURL(idPhoto.url);
      if (idPhotoBack) URL.revokeObjectURL(idPhotoBack.url);
      setPhoto(null);
      setIdPhoto(null);
      setIdPhotoBack(null);
      setResult(r);
      setStep('done');
    } catch (e) {
      if (!(e instanceof SignApiError)) {
        setSubmitError('No se pudo firmar.');
      } else if (e.code === 'CHALLENGE_EXPIRED' || e.code === 'CHALLENGE_INVALID') {
        // La foto tiene un código que ya no vale: se vuelve a tomar con uno nuevo.
        if (photo) URL.revokeObjectURL(photo.url);
        setPhoto(null);
        setNotice(`${e.message}`);
        setStep('photo');
      } else if (e.code === 'ID_PHOTO_BACK_TOO_SMALL' || e.code === 'ID_PHOTO_BACK_INVALID' || e.code === 'ID_PHOTO_BACK_REQUIRED') {
        if (idPhotoBack) URL.revokeObjectURL(idPhotoBack.url);
        setIdPhotoBack(null);
        setNotice(e.message);
        setStep('idphotoBack');
      } else if (e.code === 'ID_PHOTO_TOO_SMALL' || e.code === 'ID_PHOTO_INVALID' || e.code === 'ID_PHOTO_REQUIRED') {
        if (idPhoto) URL.revokeObjectURL(idPhoto.url);
        setIdPhoto(null);
        setNotice(e.message);
        setStep('idphoto');
      } else if (e.code === 'PHOTO_TOO_SMALL' || e.code === 'PHOTO_INVALID' || e.code === 'PHOTO_REQUIRED') {
        if (photo) URL.revokeObjectURL(photo.url);
        setPhoto(null);
        setNotice(e.message);
        setStep('photo');
      } else if (e.code === 'SESSION_INVALID') {
        toVerify('Su sesión venció. Verifique su código otra vez.');
      } else if (e.code === 'ALREADY_SIGNED') {
        // Doble clic o respuesta perdida: el documento SÍ quedó firmado.
        setResult({ reference: view.reference, signedAt: '', pdfSha256: '', emailed: false, awaitingReview: view.policy.reviewRequired });
        setStep('done');
      } else if (e.status === 410) {
        close(e);
      } else if (e.code === 'VALIDATION_ERROR' || e.code === 'ACCEPTANCE_REQUIRED') {
        setNotice(e.message);
        setStep('document');
      } else {
        // Red caída u otro: la foto sigue en memoria, se puede reintentar sin volver a tomarla.
        setSubmitError(e.message);
      }
    } finally {
      setSubmitting(false);
    }
  }

  // Los pasos que se muestran en el indicador, según lo que pide el documento.
  const labels: { id: Step; label: string }[] = [];
  if (intro?.otpRequired) labels.push({ id: 'verify', label: 'Verificación' });
  labels.push({ id: 'document', label: 'Documento' });
  if (view?.policy.idPhotoRequired) {
    labels.push({ id: 'idphoto', label: view.policy.idPhotoBackRequired ? `${view.signer.documentType} frente` : `Foto ${view.signer.documentType}` });
  }
  if (view?.policy.idPhotoBackRequired) labels.push({ id: 'idphotoBack', label: `${view.signer.documentType} reverso` });
  if (view?.policy.photoRequired ?? true) labels.push({ id: 'photo', label: view?.policy.idPhotoRequired ? 'Selfie' : 'Fotografía' });
  labels.push({ id: 'review', label: 'Firma' });
  const current = labels.findIndex((l) => l.id === step);

  return (
    <main className="container sign">
      <header className="sign-head">
        <div className="sign-brand">Firma electrónica</div>
        {intro && <div className="muted">{intro.issuer.name}</div>}
      </header>

      {current >= 0 && step !== 'done' && (
        <ol className="progress" aria-label="Pasos">
          {labels.map((l, i) => (
            <li key={l.id} className={i < current ? 'done' : i === current ? 'now' : ''} aria-current={i === current ? 'step' : undefined}>
              <span>{i + 1}</span> {l.label}
            </li>
          ))}
        </ol>
      )}

      {notice && step !== 'loading' && step !== 'done' && <p className="notice" role="alert">{notice}</p>}

      {step === 'loading' && <p className="center-note">Abriendo el documento…</p>}

      {step === 'closed' && closed && (
        <section className="card closed">
          <h2>{CLOSED_TITLES[closed.code] ?? 'No se puede abrir este enlace'}</h2>
          <p>{closed.message}</p>
        </section>
      )}

      {step === 'verify' && intro && <VerifyStep token={token} intro={intro} onVerified={onVerified} />}

      {step === 'document' && view && form && (
        <DocumentStep
          view={view}
          form={form}
          onChange={setForm}
          onContinue={afterDocument}
          continueLabel={view.policy.photoRequired ? 'Continuar: tomar mis fotos' : 'Continuar'}
        />
      )}

      {step === 'idphoto' && view && session && (
        <PhotoStep
          kind="document"
          token={token}
          session={session}
          view={view}
          initial={idPhoto}
          onBack={() => {
            setNotice(null);
            setStep('document');
          }}
          onTaken={(p) => {
            setIdPhoto(p);
            setNotice(null);
            setStep(view.policy.idPhotoBackRequired ? 'idphotoBack' : 'photo');
          }}
          onSessionExpired={() => toVerify('Su sesión venció. Verifique su código otra vez.')}
        />
      )}

      {step === 'idphotoBack' && view && session && (
        <PhotoStep
          kind="documentBack"
          token={token}
          session={session}
          view={view}
          initial={idPhotoBack}
          onBack={() => {
            setNotice(null);
            setStep('idphoto');
          }}
          onTaken={(p) => {
            setIdPhotoBack(p);
            setNotice(null);
            setStep('photo');
          }}
          onSessionExpired={() => toVerify('Su sesión venció. Verifique su código otra vez.')}
        />
      )}

      {step === 'photo' && view && session && (
        <PhotoStep
          token={token}
          session={session}
          view={view}
          initial={photo}
          onBack={() => {
            setNotice(null);
            setStep(view.policy.idPhotoBackRequired ? 'idphotoBack' : view.policy.idPhotoRequired ? 'idphoto' : 'document');
          }}
          onTaken={(p) => {
            setPhoto(p);
            setNotice(null);
            setStep('review');
          }}
          onSessionExpired={() => toVerify('Su sesión venció. Verifique su código otra vez.')}
        />
      )}

      {step === 'review' && view && form && (
        <ReviewStep
          view={view}
          form={form}
          photo={photo}
          idPhoto={idPhoto}
          idPhotoBack={idPhotoBack}
          busy={submitting}
          error={submitError}
          onBack={() => {
            setSubmitError(null);
            setStep(view.policy.photoRequired ? 'photo' : 'document');
          }}
          onSign={sign}
        />
      )}

      {step === 'done' && result && (
        <DoneStep
          token={token}
          session={session}
          reference={result.reference}
          signedAt={result.signedAt || null}
          timezone={view?.issuer.timezone ?? null}
          emailed={result.emailed}
          awaitingReview={result.awaitingReview}
        />
      )}
    </main>
  );
}
