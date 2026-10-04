import { NavLink, Outlet } from 'react-router-dom';
import { useSession, useAuth } from '../auth';

export function Layout() {
  const { me } = useSession();
  const { disconnect } = useAuth();
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong className="brand">Firma electrónica</strong>
          <nav>
            <NavLink to="/solicitudes" end>
              Solicitudes
            </NavLink>
            <NavLink to="/solicitudes/nueva">Nueva solicitud</NavLink>
          </nav>
          <div className="who">
            <span title={me.legalName}>{me.name}</span>
            <button type="button" className="btn btn-ghost" onClick={disconnect}>
              Desconectar
            </button>
          </div>
        </div>
      </header>
      <main className="container">
        <Outlet />
      </main>
    </>
  );
}
