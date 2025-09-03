import { NavLink, Outlet } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

export default function AdminLayout({ role }: { role: string }) {
  const base = "/admin";
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `block rounded px-3 py-2 text-sm ${
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
    }`;
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="min-h-screen flex">
      <aside
        className={`${
          isCollapsed ? "w-15" : "w-55"
        } bg-gray-50 border-r p-3 transition-all duration-300 flex flex-col items-center`}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="mb-2 p-2 rounded bg-gray-200 hover:bg-gray-300"
          aria-label={isCollapsed ? "Expandir menú" : "Colapsar menú"}
        >
          {isCollapsed ? (
            <span title="Expandir menú">▶</span>
          ) : (
            <span title="Colapsar menú">◀</span>
          )}
        </button>
        {!isCollapsed && (
          <>
            <nav className="space-y-1">
              {/* 🔹 Si es ADMIN, muestra todo */}
              {role === "admin" && (
                <>
                  <NavLink
                    to={`${base}/financialDashboard`}
                    className={linkCls}
                  >
                    Finanzas
                  </NavLink>
                  <NavLink to={`${base}/salesV2`} className={linkCls}>
                    Venta
                  </NavLink>
                  <NavLink to={`${base}/bills`} className={linkCls}>
                    Cierre
                  </NavLink>
                  <NavLink to={`${base}/billhistoric`} className={linkCls}>
                    Historial de Cierres
                  </NavLink>
                  <NavLink to={`${base}/batches`} className={linkCls}>
                    Inventario
                  </NavLink>
                  <NavLink to={`${base}/transactionclose`} className={linkCls}>
                    Liquidaciones
                  </NavLink>
                  <NavLink to={`${base}/expenses`} className={linkCls}>
                    Gastos
                  </NavLink>
                  <NavLink to={`${base}/products`} className={linkCls}>
                    Productos
                  </NavLink>
                  <NavLink to={`${base}/users`} className={linkCls}>
                    Usuarios
                  </NavLink>
                  <NavLink to={`${base}/fix`} className={linkCls}>
                    Fix de lotes
                  </NavLink>
                </>
              )}

              {/* 🔹 Si es VENDEDOR, solo ve ventas y cierre */}
              {role === "vendedor" && (
                <>
                  <NavLink to={`${base}/salesV2`} className={linkCls}>
                    Venta
                  </NavLink>
                  <NavLink to={`${base}/bills`} className={linkCls}>
                    Cierre
                  </NavLink>
                </>
              )}
            </nav>
            <button
              onClick={handleLogout}
              className="mt-4 bg-red-500 text-white px-3 py-2 rounded hover:bg-red-600"
            >
              Cerrar sesión
            </button>
          </>
        )}
      </aside>
      {/* Contenido */}
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
