import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './auth';
import { Layout } from './components/Layout';
import { Connect } from './pages/Connect';
import { NewRequest } from './pages/NewRequest';
import { RequestDetail } from './pages/RequestDetail';
import { Requests } from './pages/Requests';

function Protected() {
  const { session } = useAuth();
  return session ? <Layout /> : <Navigate to="/conectar" replace />;
}

export function App() {
  return (
    <Routes>
      <Route path="/conectar" element={<Connect />} />
      <Route element={<Protected />}>
        <Route path="/solicitudes" element={<Requests />} />
        <Route path="/solicitudes/nueva" element={<NewRequest />} />
        <Route path="/solicitudes/:id" element={<RequestDetail />} />
      </Route>
      <Route path="*" element={<Navigate to="/solicitudes" replace />} />
    </Routes>
  );
}
