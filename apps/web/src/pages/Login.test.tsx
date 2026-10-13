import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api';
import { AuthProvider } from '../auth';
import { Login } from './Login';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const user = (role: 'ADMIN' | 'OPERATOR') => ({ id: 'u1', email: 'a@b.com', name: 'Ana', role, mustChangePassword: false, mfaEnabled: false });
const sesion = (role: 'ADMIN' | 'OPERATOR' = 'ADMIN') => ({
  status: 'ok',
  accessToken: 'tok',
  expiresInSeconds: 900,
  user: user(role),
  tenant: role === 'ADMIN' ? { name: 'Corredora', legalName: 'Corredora SAC', timezone: 'America/Lima' } : null,
});

type Route = (body: Record<string, unknown>) => Response;
let rutas: Record<string, Route> = {};
let peticiones: { url: string; body: Record<string, unknown> }[] = [];

function montar() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      peticiones.push({ url, body });
      // Al abrir la página se intenta restaurar la sesión con la cookie: aquí no hay ninguna.
      if (url === '/v1/auth/refresh') return json(401, { code: 'INVALID_SESSION', message: 'No hay sesión.' });
      const r = rutas[url];
      if (!r) throw new Error(`petición inesperada: ${url}`);
      return r(body);
    }),
  );
  return render(
    <MemoryRouter initialEntries={['/conectar']}>
      <AuthProvider>
        <Routes>
          <Route path="/conectar" element={<Login />} />
          <Route path="/solicitudes" element={<p>PANEL DE LA CORREDORA</p>} />
          <Route path="/operador" element={<p>PANEL DEL OPERADOR</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>,
  );
}

async function escribirYEntrar(u: ReturnType<typeof userEvent.setup>, correo = 'ana@corredora.pe', clave = 'Contrasena-Segura-123') {
  await u.type(await screen.findByLabelText(/Correo/), correo);
  await u.type(screen.getByLabelText(/Contraseña/), clave);
  await u.click(screen.getByRole('button', { name: 'Entrar' }));
}

beforeEach(() => {
  rutas = {};
  peticiones = [];
  setAccessToken(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('login del panel', () => {
  it('sin datos no llama al servidor y dice qué falta', async () => {
    montar();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Entrar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Escriba su correo y su contraseña.');
    expect(peticiones.some((p) => p.url === '/v1/auth/login')).toBe(false);
  });

  it('una contraseña incorrecta muestra el mensaje del servidor y no entra', async () => {
    rutas['/v1/auth/login'] = () => json(401, { code: 'INVALID_CREDENTIALS', message: 'Correo o contraseña incorrectos.' });
    montar();
    const u = userEntrar();
    await escribirYEntrar(u);
    expect(await screen.findByRole('alert')).toHaveTextContent('Correo o contraseña incorrectos.');
    expect(screen.queryByText('PANEL DE LA CORREDORA')).not.toBeInTheDocument();
  });

  it('una cuenta cerrada por intentos explica cuánto esperar', async () => {
    rutas['/v1/auth/login'] = () => json(429, { code: 'ACCOUNT_LOCKED', message: 'Demasiados intentos fallidos. Espere 5 min e intente de nuevo.' });
    montar();
    await escribirYEntrar(userEntrar());
    expect(await screen.findByRole('alert')).toHaveTextContent('Espere 5 min');
  });

  it('un administrador sin segundo factor entra directo al panel de su corredora', async () => {
    rutas['/v1/auth/login'] = () => json(200, sesion('ADMIN'));
    montar();
    await escribirYEntrar(userEntrar());
    expect(await screen.findByText('PANEL DE LA CORREDORA')).toBeInTheDocument();
    expect(peticiones.find((p) => p.url === '/v1/auth/login')?.body).toEqual({ email: 'ana@corredora.pe', password: 'Contrasena-Segura-123' });
  });

  it('con segundo factor pide el código, y el correcto abre la sesión', async () => {
    rutas['/v1/auth/login'] = () => json(200, { status: 'mfa_required', pendingToken: 'pend-1' });
    rutas['/v1/auth/mfa/verify'] = (b) => (b.code === '123456' ? json(200, sesion('ADMIN')) : json(401, { code: 'INVALID_CODE', message: 'El código no es correcto.' }));
    montar();
    const u = userEntrar();
    await escribirYEntrar(u);
    expect(await screen.findByRole('heading', { name: 'Verificación en dos pasos' })).toBeInTheDocument();
    await u.type(screen.getByLabelText(/^Código/), '000000');
    await u.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('El código no es correcto.');
    await u.clear(screen.getByLabelText(/^Código/));
    await u.type(screen.getByLabelText(/^Código/), '123456');
    await u.click(screen.getByRole('button', { name: 'Verificar' }));
    expect(await screen.findByText('PANEL DE LA CORREDORA')).toBeInTheDocument();
    const mandado = peticiones.filter((p) => p.url === '/v1/auth/mfa/verify').map((p) => p.body);
    expect(mandado[0]).toEqual({ pendingToken: 'pend-1', code: '000000' });
  });

  it('se puede entrar con un código de recuperación (y se manda como tal, no como código de la aplicación)', async () => {
    rutas['/v1/auth/login'] = () => json(200, { status: 'mfa_required', pendingToken: 'pend-1' });
    rutas['/v1/auth/mfa/verify'] = () => json(200, sesion('ADMIN'));
    montar();
    const u = userEntrar();
    await escribirYEntrar(u);
    await u.click(await screen.findByRole('button', { name: 'Usar un código de recuperación' }));
    await u.type(screen.getByLabelText(/Código de recuperación/), 'ABCDE-FGHJK');
    await u.click(screen.getByRole('button', { name: 'Verificar' }));
    await screen.findByText('PANEL DE LA CORREDORA');
    expect(peticiones.find((p) => p.url === '/v1/auth/mfa/verify')?.body).toEqual({ pendingToken: 'pend-1', recoveryCode: 'ABCDE-FGHJK' });
  });

  it('si el testigo del segundo paso venció, vuelve a la pantalla de inicio sin dejar la contraseña escrita', async () => {
    rutas['/v1/auth/login'] = () => json(200, { status: 'mfa_required', pendingToken: 'pend-1' });
    rutas['/v1/auth/mfa/verify'] = () => json(401, { code: 'INVALID_SESSION', message: 'El inicio de sesión venció. Vuelva a entrar.' });
    montar();
    const u = userEntrar();
    await escribirYEntrar(u);
    await u.type(await screen.findByLabelText(/^Código/), '123456');
    await u.click(screen.getByRole('button', { name: 'Verificar' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Entrar' })).toBeInTheDocument());
    expect(screen.getByLabelText(/Contraseña/)).toHaveValue('');
  });

  it('el operador que aún no tiene segundo factor lo activa, ve sus códigos de recuperación y solo entonces entra', async () => {
    rutas['/v1/auth/login'] = () => json(200, { status: 'mfa_setup_required', pendingToken: 'pend-setup' });
    rutas['/v1/auth/mfa/setup-pending'] = () => json(200, { qr: 'data:image/png;base64,AAAA', secret: 'ABCD EFGH IJKL', otpauthUri: 'otpauth://totp/x' });
    rutas['/v1/auth/mfa/enable-pending'] = () => json(200, { ...sesion('OPERATOR'), recoveryCodes: ['AAAAA-BBBBB', 'CCCCC-DDDDD'] });
    montar();
    const u = userEntrar();
    await escribirYEntrar(u, 'op@plataforma.pe');
    expect(await screen.findByRole('heading', { name: 'Active su segundo factor' })).toBeInTheDocument();
    expect(await screen.findByAltText(/código QR/i)).toBeInTheDocument();
    expect(screen.getByText('ABCD EFGH IJKL')).toBeInTheDocument();
    await u.type(screen.getByLabelText(/^Código/), '654321');
    await u.click(screen.getByRole('button', { name: 'Activar' }));
    // Los códigos de recuperación se muestran ANTES de abrir la sesión, y no se puede seguir sin confirmar que se guardaron.
    expect(await screen.findByText('AAAAA-BBBBB', { exact: false })).toBeInTheDocument();
    const seguir = screen.getByRole('button', { name: 'Continuar' });
    expect(seguir).toBeDisabled();
    expect(screen.queryByText('PANEL DEL OPERADOR')).not.toBeInTheDocument();
    await u.click(screen.getByRole('checkbox', { name: /guardé/i }));
    await u.click(seguir);
    expect(await screen.findByText('PANEL DEL OPERADOR')).toBeInTheDocument();
    expect(peticiones.find((p) => p.url === '/v1/auth/mfa/enable-pending')?.body).toEqual({ pendingToken: 'pend-setup', code: '654321' });
  });

  it('un código de activación equivocado se explica y deja reintentar', async () => {
    rutas['/v1/auth/login'] = () => json(200, { status: 'mfa_setup_required', pendingToken: 'pend-setup' });
    rutas['/v1/auth/mfa/setup-pending'] = () => json(200, { qr: 'data:image/png;base64,AAAA', secret: 'ABCD', otpauthUri: 'otpauth://totp/x' });
    rutas['/v1/auth/mfa/enable-pending'] = () => json(422, { code: 'INVALID_CODE', message: 'El código no es correcto. Revise la hora de su teléfono e intente de nuevo.' });
    montar();
    const u = userEntrar();
    await escribirYEntrar(u, 'op@plataforma.pe');
    await u.type(await screen.findByLabelText(/^Código/), '111111');
    await u.click(screen.getByRole('button', { name: 'Activar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Revise la hora de su teléfono');
    expect(screen.getByRole('button', { name: 'Activar' })).toBeEnabled();
  });
});

function userEntrar() {
  return userEvent.setup();
}
