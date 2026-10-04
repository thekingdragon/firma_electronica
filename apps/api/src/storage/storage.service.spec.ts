import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppConfig } from '../config/config';
import { StorageNotConfiguredError, StorageService } from './storage.service';

describe('StorageService', () => {
  let dir: string;
  const key = randomBytes(32);
  const make = (secretsKey: Buffer | null = key) =>
    new StorageService({ storageDir: dir, secretsKey } as unknown as AppConfig);

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'fes-storage-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('guarda cifrado y lee igual que el original', async () => {
    const s = make();
    const foto = randomBytes(10_000);
    await s.put('t1/r1/photo.bin', foto);
    expect((await s.get('t1/r1/photo.bin')).equals(foto)).toBe(true);
  });

  it('en disco NO está el contenido original', async () => {
    const s = make();
    const marca = Buffer.from('CONTENIDO-RECONOCIBLE-1234567890');
    await s.put('t1/r1/doc.bin', Buffer.concat([marca, randomBytes(100)]));
    const crudo = await readFile(join(dir, 't1/r1/doc.bin'));
    expect(crudo.includes(marca)).toBe(false);
  });

  it('con otra clave maestra no se puede leer', async () => {
    await make().put('a/b.bin', Buffer.from('secreto'));
    await expect(make(randomBytes(32)).get('a/b.bin')).rejects.toThrow();
  });

  it('detecta un archivo alterado en disco', async () => {
    const s = make();
    await s.put('a/b.bin', Buffer.from('secreto largo para alterar'));
    const crudo = await readFile(join(dir, 'a/b.bin'));
    crudo[crudo.length - 1] ^= 0xff;
    await writeFile(join(dir, 'a/b.bin'), crudo);
    await expect(s.get('a/b.bin')).rejects.toThrow();
  });

  it('no deja archivos temporales después de guardar', async () => {
    await make().put('a/b.bin', Buffer.from('x'));
    expect(await readdir(join(dir, 'a'))).toEqual(['b.bin']);
  });

  it('no sobrescribe silenciosamente por una carrera de temporales: dos puts del mismo destino terminan íntegros', async () => {
    const s = make();
    await Promise.all([s.put('a/b.bin', Buffer.from('uno')), s.put('a/b.bin', Buffer.from('dos'))]);
    expect(['uno', 'dos']).toContain((await s.get('a/b.bin')).toString());
  });

  it.each(['../fuera.bin', 'a/../../fuera.bin', '/etc/passwd'.replace('/etc', '..')])(
    'rechaza la ruta %p que sale del directorio',
    async (ruta) => {
      await expect(make().put(ruta, Buffer.from('x'))).rejects.toThrow(/Ruta de almacenamiento inválida/);
      await expect(make().get(ruta)).rejects.toThrow(/Ruta de almacenamiento inválida/);
    },
  );

  it('remove borra y no falla si ya no existe', async () => {
    const s = make();
    await s.put('a/b.bin', Buffer.from('x'));
    await s.remove('a/b.bin');
    await s.remove('a/b.bin');
    await expect(s.get('a/b.bin')).rejects.toThrow();
  });

  it('sin SECRETS_KEY se niega a guardar y a leer, con un error propio', async () => {
    await expect(make(null).put('a/b.bin', Buffer.from('x'))).rejects.toBeInstanceOf(StorageNotConfiguredError);
    await expect(make(null).get('a/b.bin')).rejects.toBeInstanceOf(StorageNotConfiguredError);
  });
});
