import React from "react";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useNavigate } from "react-router-dom";

const Sidebar = () => {
  const navigate = useNavigate();

  const sections = [
    { name: "tuma", path: "/admin/ventas" },
    { name: "Cierre", path: "/admin/cierre" },
    { name: "Historial de Cierres", path: "/admin/historial_cierres" },
    { name: "Usuarios", path: "/admin/usuarios" },
    { name: "Productos", path: "/admin/productos" },
    { name: "Inventario", path: "/admin/inventario" },
  ];

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  return (
    <div className="w-56 min-h-screen bg-gray-100 p-4 flex flex-col justify-between">
      <div>
        <h2 className="font-bold mb-4">Menú</h2>
        {sections.map((s) => (
          <button
            key={s.path}
            onClick={() => navigate(s.path)}
            className="block w-full text-left px-3 py-2 rounded hover:bg-gray-200"
          >
            {s.name}
          </button>
        ))}
      </div>

      {/* Botón cerrar sesión al final */}
    </div>
  );
};

export default Sidebar;
