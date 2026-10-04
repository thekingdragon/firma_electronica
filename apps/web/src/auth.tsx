import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, loadApiKey, saveApiKey, type Me } from './api';

interface Session {
  apiKey: string;
  me: Me;
}

interface AuthValue {
  session: Session | null;
  connect: (apiKey: string) => Promise<void>;
  disconnect: () => void;
}

const AuthContext = createContext<AuthValue | null>(null);

/**
 * Sesión del panel = la clave de API del tenant. Es la solución de la primera iteración (sin
 * usuarios ni contraseñas): vale para uso local y de prueba. Antes de exponer el panel a otras
 * personas hay que reemplazarla por un login real.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<Session | null>(null);
  const [restoring, setRestoring] = useState(() => loadApiKey() !== null);

  // Restaurar la clave guardada al abrir, validándola contra la API.
  useEffect(() => {
    const stored = loadApiKey();
    if (!stored) return;
    let cancelled = false;
    api
      .me(stored)
      .then((me) => {
        if (!cancelled) setSession({ apiKey: stored, me });
      })
      .catch(() => saveApiKey(null))
      .finally(() => {
        if (!cancelled) setRestoring(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const connect = useCallback(async (apiKey: string) => {
    const me = await api.me(apiKey.trim());
    saveApiKey(apiKey.trim());
    setSession({ apiKey: apiKey.trim(), me });
  }, []);

  const disconnect = useCallback(() => {
    saveApiKey(null);
    setSession(null);
  }, []);

  const value = useMemo(() => ({ session, connect, disconnect }), [session, connect, disconnect]);

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
