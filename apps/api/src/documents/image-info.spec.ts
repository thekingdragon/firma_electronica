import { imageInfo } from './image-info';
import { makeJpegHeader, makePng } from './image-fixtures';

describe('imageInfo', () => {
  it('lee las dimensiones de un PNG', () => {
    expect(imageInfo(makePng(1280, 720))).toEqual({ type: 'png', mime: 'image/png', width: 1280, height: 720 });
  });

  it('lee las dimensiones de un JPEG, también en vertical', () => {
    expect(imageInfo(makeJpegHeader(1920, 1080))).toEqual({ type: 'jpeg', mime: 'image/jpeg', width: 1920, height: 1080 });
    expect(imageInfo(makeJpegHeader(720, 1280))).toMatchObject({ width: 720, height: 1280 });
  });

  it('rechaza lo que no es una imagen, aunque lo declare', () => {
    expect(imageInfo(Buffer.from('<?php system($_GET["x"]); ?>'))).toBeNull();
    expect(imageInfo(Buffer.from('%PDF-1.7 documento'))).toBeNull();
    expect(imageInfo(Buffer.from('GIF89a......'))).toBeNull();
    expect(imageInfo(Buffer.alloc(0))).toBeNull();
    expect(imageInfo(Buffer.alloc(3000))).toBeNull();
  });

  it('rechaza un PNG o JPEG truncado o con cabecera rota', () => {
    expect(imageInfo(makePng(100, 100).subarray(0, 12))).toBeNull();
    expect(imageInfo(makeJpegHeader(100, 100).subarray(0, 6))).toBeNull();
    const roto = makePng(100, 100);
    roto.write('XXXX', 12, 'ascii'); // IHDR corrupto
    expect(imageInfo(roto)).toBeNull();
  });

  it('rechaza dimensiones cero o absurdas (bombas de descompresión)', () => {
    expect(imageInfo(makeJpegHeader(0, 100))).toBeNull();
    expect(imageInfo(makeJpegHeader(100, 0))).toBeNull();
    expect(imageInfo(makeJpegHeader(65535, 65535))).toBeNull();
    const enorme = makePng(10, 10);
    enorme.writeUInt32BE(900_000, 16);
    expect(imageInfo(enorme)).toBeNull();
  });

  it('un JPEG que termina antes de declarar dimensiones es inválido', () => {
    expect(imageInfo(Buffer.from([0xff, 0xd8, 0xff, 0xd9]))).toBeNull();
  });
});
