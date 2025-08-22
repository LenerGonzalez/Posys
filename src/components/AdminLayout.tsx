import { NavLink, Outlet } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useNavigate } from "react-router-dom";

export default function AdminLayout() {
  const base = "/admin";
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `block rounded px-3 py-2 text-sm ${
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
    }`;
  const navigate = useNavigate();

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="min-h-screen flex">
      <aside className="w-56 bg-gray-50 border-r p-3">
        <h3 className="text-sm font-semibold text-gray-500 mb-2">Menú</h3>
        <nav className="space-y-1">
          <NavLink to={`${base}/financialDashboard`} className={linkCls}>
            Dashboard Financiero
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

          {/* <NavLink to={`${base}/inventario`} className={linkCls}>
            Inventario
          </NavLink> */}
        </nav>
        <button
          onClick={handleLogout}
          className="mt-4 bg-red-500 text-white px-3 py-2 rounded hover:bg-red-600"
        >
          Cerrar sesión
        </button>

        {/* dentro de <nav className="space-y-1"> … */}
      </aside>

      {/* Contenido */}
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
