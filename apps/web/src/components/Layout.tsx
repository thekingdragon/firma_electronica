import { NavLink, Outlet } from 'react-router-dom';
import { useSession, useAuth } from '../auth';

export function Layout() {
  const { user, tenant } = useSession();
  const { disconnect } = useAuth();
  const admin = user.role === 'ADMIN';
  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <strong className="brand">Firma electrónica</strong>
          <nav>
            <NavLink to="/solicitudes" end>
              Solicitudes
            </NavLink>
            {/* El revisor consulta y dictamina; crear, plantillas, ajustes y personas son del administrador. */}
            {admin && <NavLink to="/solicitudes/nueva">Nueva solicitud</NavLink>}
            {admin && <NavLink to="/plantillas">Plantillas</NavLink>}
            {admin && <NavLink to="/ajustes">Ajustes</NavLink>}
            {admin && <NavLink to="/usuarios">Usuarios</NavLink>}
          </nav>
          <div className="who">
            <NavLink to="/cuenta" title={`${user.email}${tenant ? ` · ${tenant.legalName}` : ''}`}>
              {user.name}
            </NavLink>
            <button type="button" className="btn btn-ghost" onClick={() => void disconnect()}>
              Salir
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
