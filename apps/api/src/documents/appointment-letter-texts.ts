/**
 * Textos del modelo de carta de nombramiento (Anexo I). Son los de partida: la plantilla del tenant
 * puede traer los suyos en `content.texts` (otro país, otra redacción); lo que no traiga cae acá.
 */
export const DEFAULT_LETTER_TEXTS = {
  title: 'CARTA DE NOMBRAMIENTO',
  salutation: 'Señores:',
  addressee: 'CORREDORES DE SEGUROS',
  presente: 'Presente.-',
  greeting: 'Estimados señores:',
  body:
    'Les dirijo la presente para hacerles de conocimiento mi decisión de nombrarlos como Corredores de Seguros ' +
    'para efectuar la asesoría e intermediación de los seguros que se señalan a continuación:',
  powersIntro: 'Por lo tanto se encuentran facultados para realizar los siguientes actos en mi representación que implica:',
  observationLabel:
    'Observación: En caso el contratante o asegurado quiera otorgar alguna de las facultades antes mencionadas, debe especificarla:',
  noObservation: '—',
  closing: 'Atentamente,',
  signerBlock: 'Datos de contratante o asegurado',
  annexTitle: 'ANEXO A LA CARTA DE NOMBRAMIENTO',
  evidenceTitle: 'CONSTANCIA DE FIRMA ELECTRÓNICA',
} as const;
