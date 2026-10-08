import { Fragment } from 'react';

/** Texto con `**negrita**` entre dobles asteriscos (lo mismo que el PDF). Todo lo demás es texto plano. */
export function Rich({ text }: { text: string }) {
  return (
    <>
      {text.split('**').map((chunk, i) => (chunk === '' ? null : i % 2 === 1 ? <strong key={i}>{chunk}</strong> : <Fragment key={i}>{chunk}</Fragment>))}
    </>
  );
}
