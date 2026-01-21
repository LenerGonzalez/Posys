import React, { useState } from "react";
import { signOut } from "firebase/auth";
import { auth } from "../../firebase";
import { useNavigate } from "react-router-dom";
import { hasRole } from "../../utils/roles";

type Props = {
  role?: string | null;
  roles?: string[] | undefined;
  onNavigate?: (path: string) => void;
};

const Sidebar = ({ role, roles, onNavigate }: Props) => {
  const navigate = useNavigate();

  const subject = roles && roles.length ? roles : role;

  // Determinar rubro: preferir localStorage (lo que usa MobileTabsLayout),
  // si no existe, inferir por roles.
  let rubro: "POLLO" | "DULCES" = "POLLO";
  try {
    const saved =
      typeof window !== "undefined" ? localStorage.getItem("rubro") : null;
    if (saved === "POLLO" || saved === "DULCES") rubro = saved as any;
    else if (hasRole(subject, "vendedor_dulces")) rubro = "DULCES";
  } catch (e) {
    if (hasRole(subject, "vendedor_dulces")) rubro = "DULCES";
  }

  const polloSections = [
    { name: "Venta", path: "/admin/salesV2" },
    { name: "Cierre", path: "/admin/bills" },
    { name: "Ventas del dia", path: "/admin/transactionPollo" },
    { name: "Pedidos", path: "/admin/orders" },
    { name: "Clientes", path: "/admin/customers" },
  ];

  const dulcesSections = [
    { name: "Venta", path: "/admin/salesCandies" },
    { name: "Ventas del dia", path: "/admin/transactionCandies" },
    { name: "Cierre de Ventas", path: "/admin/cierreVentasCandies" },
    { name: "Pedidos", path: "/admin/mainordersCandies" },
    { name: "Clientes", path: "/admin/customersCandies" },
  ];

  const sections = rubro === "DULCES" ? dulcesSections : polloSections;

  const canSeeCustomers =
    hasRole(subject, "admin") ||
    hasRole(subject, "vendedor_pollo") ||
    hasRole(subject, "supervisor_pollo") ||
    hasRole(subject, "contador");

  const handleLogout = async () => {
    setConfirmLogoutOpen(true);
  };

  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);

  const doLogout = async () => {
    try {
      await signOut(auth);
    } catch (err) {
      console.error("signOut error:", err);
    } finally {
      try {
        localStorage.removeItem("user_name");
        localStorage.removeItem("user_email");
        localStorage.removeItem("roles");
        localStorage.removeItem("role");
      } catch (e) {}
      setConfirmLogoutOpen(false);
      navigate("/");
    }
  };

  const go = (p: string) => {
    if (onNavigate) onNavigate(p);
    navigate(p);
  };

  return (
    <div className="w-56 min-h-screen bg-gray-100 p-4 flex flex-col justify-between">
      <div>
        <h2 className="font-bold mb-4">
          {rubro === "DULCES" ? "CandyShop" : "Finanzas (Pollo)"}
        </h2>
        {sections.map((s) => {
          if (s.path === "/admin/customers" && !canSeeCustomers) return null;
          return (
            <button
              key={s.path}
              onClick={() => go(s.path)}
              className="block w-full text-left px-3 py-2 rounded hover:bg-gray-200"
            >
              {s.name}
            </button>
          );
        })}
      </div>

      <div>
        <button
          onClick={handleLogout}
          className="w-full text-left px-3 py-2 rounded bg-red-500 text-white hover:bg-red-600"
        >
          Cerrar sesión
        </button>
        <div className="mt-2 text-sm text-gray-700">
          {typeof window !== "undefined" &&
            (localStorage.getItem("user_name") ||
              localStorage.getItem("user_email"))}
        </div>

        {confirmLogoutOpen && (
          <div className="fixed inset-0 z-[120] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/20"
              onClick={() => setConfirmLogoutOpen(false)}
            />
            <div className="bg-white p-4 rounded-xl shadow-lg z-[130] w-[90%] max-w-sm">
              <div className="font-semibold mb-3">
                ¿Estás seguro de cerrar sesión?
              </div>
              <div className="flex gap-2 justify-end">
                <button
                  onClick={() => setConfirmLogoutOpen(false)}
                  className="px-3 py-2 rounded bg-gray-200"
                >
                  No
                </button>
                <button
                  onClick={doLogout}
                  className="px-3 py-2 rounded bg-red-500 text-white"
                >
                  SI
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};

export default Sidebar;
