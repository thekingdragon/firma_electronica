import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAccessToken } from '../api';
import { AuthProvider } from '../auth';
import { MailSettingsCard } from './MailSettingsCard';

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
const sinConfigurar = { configured: false, host: null, port: null, secure: null, username: null, hasPassword: false, fromName: null, fromEmail: null, replyTo: null, verifiedAt: null, lastOkAt: null, lastError: null };
const guardado = { configured: true, host: 'smtp.gmail.com', port: 587, secure: false, username: 'gerente@corredora.pe', hasPassword: true, fromName: 'Corredora', fromEmail: 'gerente@corredora.pe', replyTo: null, verifiedAt: null, lastOkAt: null, lastError: null };

let estado: Record<string, unknown>;
let peticiones: { url: string; method: string; body: Record<string, unknown> }[];
let respuestaPrueba: () => Response;

function montar() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      peticiones.push({ url, method, body });
      if (url === '/v1/auth/refresh') {
        return json(200, { status: 'ok', accessToken: 'tok', expiresInSeconds: 900, user: { id: 'u', email: 'gerente@corredora.pe', name: 'Gerente', role: 'ADMIN', mustChangePassword: false, mfaEnabled: false }, tenant: { name: 'C', legalName: 'C SAC', timezone: 'America/Lima' } });
      }
      if (url === '/v1/settings/mail' && method === 'GET') return json(200, estado);
      if (url === '/v1/settings/mail' && method === 'PUT') {
        estado = { ...guardado, ...body, hasPassword: Boolean(body.password) || (estado.hasPassword as boolean), password: undefined, verifiedAt: null };
        return json(200, estado);
      }
      if (url === '/v1/settings/mail/test') return respuestaPrueba();
      throw new Error(`petición inesperada: ${method} ${url}`);
    }),
  );
  return render(
    <MemoryRouter>
      <AuthProvider>
        <MailSettingsCard />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  estado = sinConfigurar;
  peticiones = [];
  respuestaPrueba = () => json(200, { ok: true, verifiedAt: new Date().toISOString() });
  setAccessToken(null);
});
afterEach(() => vi.unstubAllGlobals());

describe('correo de la corredora (Ajustes)', () => {
  it('sin configurar lo dice, y propone el correo de quien entró como usuario y remitente', async () => {
    montar();
    expect(await screen.findByText('Sin configurar')).toBeInTheDocument();
    expect(screen.getByLabelText(/Usuario/)).toHaveValue('gerente@corredora.pe');
    expect(screen.getByLabelText(/Correo desde el que se envía/)).toHaveValue('gerente@corredora.pe');
    expect(screen.queryByText('Enviar una prueba')).not.toBeInTheDocument();
  });

  it('elegir Gmail rellena servidor y puerto y avisa que hace falta una contraseña de aplicación', async () => {
    montar();
    const u = userEvent.setup();
    await u.selectOptions(await screen.findByLabelText('Proveedor'), 'Gmail / Google Workspace');
    expect(screen.getByLabelText(/Servidor/)).toHaveValue('smtp.gmail.com');
    expect(screen.getByLabelText(/Puerto/)).toHaveValue('587');
    expect(screen.getByRole('note')).toHaveTextContent(/contraseña de aplicación/);
  });

  it('con usuario y sin contraseña no llama al servidor y lo explica', async () => {
    montar();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Servidor/), 'smtp.gmail.com');
    await u.click(screen.getByRole('button', { name: 'Guardar el correo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Con usuario hay que indicar la contraseña.');
    expect(peticiones.some((p) => p.method === 'PUT')).toBe(false);
  });

  it('guarda con la contraseña, no la vuelve a mostrar y ofrece enviar la prueba', async () => {
    montar();
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Servidor/), 'smtp.gmail.com');
    await u.type(screen.getByLabelText(/^Contraseña/), 'clave-de-aplicacion');
    await u.click(screen.getByRole('button', { name: 'Guardar el correo' }));
    expect(await screen.findByText(/Guardado\. Ahora envíe una prueba/)).toBeInTheDocument();
    const put = peticiones.find((p) => p.method === 'PUT');
    expect(put?.body).toMatchObject({ host: 'smtp.gmail.com', port: 587, secure: false, username: 'gerente@corredora.pe', password: 'clave-de-aplicacion', fromEmail: 'gerente@corredora.pe' });
    expect(screen.getByLabelText(/^Contraseña/)).toHaveValue('');
    expect(await screen.findByText('Guardado, sin probar')).toBeInTheDocument();
    expect(screen.getByText('Enviar una prueba')).toBeInTheDocument();
  });

  it('con una contraseña ya guardada, dejarla en blanco NO la manda (el servidor conserva la guardada)', async () => {
    estado = guardado;
    montar();
    const u = userEvent.setup();
    // Primero que cargue lo guardado: hasta entonces el campo no sabe que ya hay una contraseña.
    await screen.findByText('Guardado, sin probar');
    const campo = screen.getByLabelText(/^Contraseña/);
    expect(campo).toHaveAttribute('placeholder', expect.stringContaining('déjelo en blanco'));
    await u.clear(screen.getByLabelText(/Nombre que ve el firmante/));
    await u.type(screen.getByLabelText(/Nombre que ve el firmante/), 'Otro nombre');
    await u.click(screen.getByRole('button', { name: 'Guardar el correo' }));
    await screen.findByText(/Guardado\./);
    const put = peticiones.find((p) => p.method === 'PUT');
    expect(put?.body).toMatchObject({ fromName: 'Otro nombre' });
    expect(put?.body).not.toHaveProperty('password');
  });

  it('la prueba que sale deja el correo como verificado', async () => {
    estado = guardado;
    montar();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Enviar correo de prueba' }));
    expect(await screen.findByRole('status')).toHaveTextContent('se envió un correo de prueba a gerente@corredora.pe');
    expect(peticiones.find((p) => p.url === '/v1/settings/mail/test')?.body).toEqual({ to: 'gerente@corredora.pe' });
  });

  it('si la prueba falla muestra la explicación del servidor, no un error técnico', async () => {
    estado = guardado;
    respuestaPrueba = () => json(502, { code: 'MAIL_SEND_FAILED', message: 'El servidor rechazó el usuario o la contraseña. Con Gmail use una contraseña de aplicación.' });
    montar();
    const u = userEvent.setup();
    await u.click(await screen.findByRole('button', { name: 'Enviar correo de prueba' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Con Gmail use una contraseña de aplicación.');
    await waitFor(() => expect(screen.getByRole('button', { name: 'Enviar correo de prueba' })).toBeEnabled());
  });

  it('muestra los detalles de validación que devuelve el servidor (p. ej. dirección no permitida)', async () => {
    montar();
    vi.mocked(fetch).mockImplementationOnce(async () => json(200, { status: 'ok', accessToken: 'tok', expiresInSeconds: 900, user: { id: 'u', email: 'gerente@corredora.pe', name: 'G', role: 'ADMIN', mustChangePassword: false, mfaEnabled: false }, tenant: { name: 'C', legalName: 'C', timezone: 'America/Lima' } }));
    const u = userEvent.setup();
    await u.type(await screen.findByLabelText(/Servidor/), '10.0.0.5');
    await u.type(screen.getByLabelText(/^Contraseña/), 'x');
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      if (String(url) === '/v1/settings/mail' && init?.method === 'PUT') return json(422, { code: 'MAIL_HOST_NOT_ALLOWED', message: 'Ese servidor apunta a una dirección interna o privada: no se permite.', issues: [{ path: 'host', message: 'Dirección no permitida.' }] });
      return json(200, sinConfigurar);
    });
    await u.click(screen.getByRole('button', { name: 'Guardar el correo' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('dirección interna o privada');
  });
});
