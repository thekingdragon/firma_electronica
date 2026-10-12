import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { setPanelZone } from './format';
import { authApi, setAccessToken, setSessionRefresher, type AuthTenant, type AuthUser, type SessionResponse } from './api';

interface Session {
  user: AuthUser;
  tenant: AuthTenant | null;
}

interface AuthValue {
  session: Session | null;
  /** Adopta una sesión recién emitida por el servidor (login, segundo factor, cambio de contraseña). */
  adopt: (s: SessionResponse) => void;
  disconnect: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Sesión del panel: usuario y contraseña (con segundo factor cuando aplica). El access token (15 min) vive solo en
 * memoria; la sesión durable es la cookie de refresh, HttpOnly, con la que se restaura al abrir la página y se renueva
 * el token cuando vence (ver `api.ts`). Cerrar la pestaña no cierra la sesión; «Salir» sí la revoca en el servidor.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(true);
  // StrictMode monta dos veces en desarrollo: la renovación rota el refresh, y dos a la vez se pisarían.
  const restoreStarted = useRef(false);

  const adopt = useCallback((s: SessionResponse) => {
    setAccessToken(s.accessToken);
    setPanelZone(s.tenant?.timezone ?? null);
    setSession({ user: s.user, tenant: s.tenant });
  }, []);

  const clear = useCallback(() => {
    setAccessToken(null);
    setPanelZone(null);
    setSession(null);
  }, []);

  // Una sola renovación a la vez, aunque varias peticiones reciban 401 juntas.
  const inFlight = useRef<Promise<boolean> | null>(null);
  useEffect(() => {
    setSessionRefresher(() => {
      inFlight.current ??= authApi
        .refresh()
        .then((s) => {
          if (s) adopt(s);
          else clear();
          return s !== null;
        })
        .finally(() => {
          inFlight.current = null;
        });
      return inFlight.current;
    });
    return () => setSessionRefresher(null);
  }, [adopt, clear]);

  useEffect(() => {
    if (restoreStarted.current) return;
    restoreStarted.current = true;
    authApi
      .refresh()
      .then((s) => {
        if (s) adopt(s);
      })
      .finally(() => setRestoring(false));
  }, [adopt]);

  const disconnect = useCallback(async () => {
    await authApi.logout();
    clear();
  }, [clear]);

  const value = useMemo(() => ({ session, adopt, disconnect }), [session, adopt, disconnect]);

  if (restoring) return <p className="center-note">Conectando…</p>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth fuera de AuthProvider');
  return ctx;
}

/** Sesión garantizada: solo se llama dentro de rutas protegidas. */
export function useSession(): Session {
  const { session } = useAuth();
  if (!session) throw new Error('useSession sin sesión');
  return session;
}
