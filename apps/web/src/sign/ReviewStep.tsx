import type { SigningView } from './signApi';
import type { SignForm } from './DocumentStep';
import type { TakenPhoto } from './PhotoStep';

export function ReviewStep({
  view,
  form,
  photo,
  busy,
  error,
  onBack,
  onSign,
}: {
  view: SigningView;
  form: SignForm;
  photo: TakenPhoto | null;
  busy: boolean;
  error: string | null;
  onBack: () => void;
  onSign: () => void;
}) {
  const powers = (view.content.powers ?? []).filter((p) => form.powers.includes(p.code));
  return (
    <section className="card">
      <h2>Revise y firme</h2>
      <p className="muted">Al firmar, el documento queda registrado con la fecha y hora, su código de verificación y su fotografía.</p>

      <h3>Usted autoriza</h3>
      {powers.length > 0 ? (
        <ul className="plain">
          {powers.map((p) => (
            <li key={p.code}>{p.text}</li>
          ))}
        </ul>
      ) : (
        <p className="muted">Ninguna facultad marcada; solo lo indicado en la observación.</p>
      )}
      {form.observation.trim() && (
        <p>
          <strong>Observación:</strong> {form.observation}
        </p>
      )}
      <p>
        <strong>Seguros:</strong> {(view.data.insurances ?? []).join(' · ')}
      </p>

      {photo && (
        <div className="review-photo">
          <img src={photo.url} alt="Su fotografía" />
          {photo.challenge && <div className="muted small">Código de la foto: <strong>{photo.challenge.code}</strong></div>}
        </div>
      )}

      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-block btn-large" onClick={onSign} disabled={busy}>
        {busy ? 'Firmando… no cierre esta página' : 'Firmar documento'}
      </button>
      <button type="button" className="btn btn-block btn-link" onClick={onBack} disabled={busy}>
        ← Volver
      </button>
    </section>
  );
}
