import { Navigate, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './auth';
import { Layout } from './components/Layout';
import { Connect } from './pages/Connect';
import { NewRequest } from './pages/NewRequest';
import { RequestDetail } from './pages/RequestDetail';
import { TemplateEditor } from './pages/TemplateEditor';
import { Templates } from './pages/Templates';
import { Requests } from './pages/Requests';
import { Settings } from './pages/Settings';
import { SignPage } from './sign/SignPage';

function Protected() {
  const { session } = useAuth();
  return session ? <Layout /> : <Navigate to="/conectar" replace />;
}

/** El panel de la corredora: entra con la clave de API del tenant. */
function Panel() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/conectar" element={<Connect />} />
        <Route element={<Protected />}>
          <Route path="/solicitudes" element={<Requests />} />
          <Route path="/solicitudes/nueva" element={<NewRequest />} />
          <Route path="/solicitudes/:id" element={<RequestDetail />} />
          <Route path="/plantillas" element={<Templates />} />
          <Route path="/ajustes" element={<Settings />} />
          <Route path="/plantillas/:type" element={<TemplateEditor />} />
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
