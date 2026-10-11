import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Account } from './pages/Account';
import { ChangePassword } from './pages/ChangePassword';
import { Login } from './pages/Login';
import { Operator } from './pages/Operator';
import { ForgotPassword, ResetPassword } from './pages/Recovery';
import { NewRequest } from './pages/NewRequest';
import { RequestDetail } from './pages/RequestDetail';
import { TemplateEditor } from './pages/TemplateEditor';
import { Templates } from './pages/Templates';
import { Requests } from './pages/Requests';
import { Settings } from './pages/Settings';
import { Users } from './pages/Users';
import { SignPage } from './sign/SignPage';

/** Hay que haber entrado; con contraseña provisional, lo único que se ve es el cambio de contraseña. */
function Protected() {
  const { session } = useAuth();
  if (!session) return <Navigate to="/conectar" replace />;
  if (session.user.mustChangePassword) return <ChangePassword forced />;
  return <Outlet />;
}

/** El operador de la plataforma no opera dentro de una corredora, y a la inversa. */
function TenantArea() {
  const { session } = useAuth();
  if (session?.user.role === 'OPERATOR') return <Navigate to="/operador" replace />;
  return <Layout />;
}

function AdminOnly() {
  const { session } = useAuth();
  return session?.user.role === 'ADMIN' ? <Outlet /> : <Navigate to="/solicitudes" replace />;
}

function OperatorArea() {
  const { session } = useAuth();
  return session?.user.role === 'OPERATOR' ? <Operator /> : <Navigate to="/solicitudes" replace />;
}

/** El panel: usuario y contraseña, con segundo factor cuando aplica. */
function Panel() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/conectar" element={<Login />} />
        <Route path="/olvide" element={<ForgotPassword />} />
        <Route path="/restablecer" element={<ResetPassword />} />
        <Route element={<Protected />}>
          <Route path="/operador" element={<OperatorArea />} />
          <Route element={<TenantArea />}>
            <Route path="/solicitudes" element={<Requests />} />
            <Route path="/solicitudes/:id" element={<RequestDetail />} />
            <Route path="/cuenta" element={<Account />} />
            <Route element={<AdminOnly />}>
              <Route path="/solicitudes/nueva" element={<NewRequest />} />
              <Route path="/plantillas" element={<Templates />} />
              <Route path="/plantillas/:type" element={<TemplateEditor />} />
              <Route path="/ajustes" element={<Settings />} />
              <Route path="/usuarios" element={<Users />} />
            </Route>
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/solicitudes" replace />} />
      </Routes>
    </AuthProvider>
  );
}

export function App() {
  return (
    <Routes>
      {/* La página PÚBLICA de firma no pasa por el panel ni usa su sesión. */}
      <Route path="/s/:token" element={<SignPage />} />
      <Route path="/*" element={<Panel />} />
    </Routes>
  );
}
