import React from "react";
import { NavLink, Outlet } from "react-router-dom";
import Sidebar from "./Sidebar";
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
          <NavLink to={`${base}/ventas`} className={linkCls}>
            Ventas
          </NavLink>
          <NavLink to={`${base}/cierre`} className={linkCls}>
            Cierre
          </NavLink>
          <NavLink to={`${base}/cierres`} className={linkCls}>
            Historial de Cierres
          </NavLink>
          <NavLink to={`${base}/usuarios`} className={linkCls}>
            Usuarios
          </NavLink>
          <NavLink to={`${base}/productos`} className={linkCls}>
            Productos
          </NavLink>
          <NavLink to={`${base}/inventario`} className={linkCls}>
            Inventario
          </NavLink>
        </nav>
        <button
          onClick={handleLogout}
          className="mt-4 bg-red-500 text-white px-3 py-2 rounded hover:bg-red-600"
        >
          Cerrar sesión
        </button>
      </aside>

      {/* Contenido */}
      <main className="flex-1 p-6">
        <Outlet />
      </main>
    </div>
  );
}
