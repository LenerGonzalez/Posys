// src/components/MobileTabsLayout.tsx
import React, { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import InstallApp from "../components/InstallApp";

type Role =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";
type Rubro = "POLLO" | "DULCES";

function cn(...cls: Array<string | false | null | undefined>) {
  return cls.filter(Boolean).join(" ");
}

export default function MobileTabsLayout({ role }: { role: Role }) {
  const navigate = useNavigate();
  const base = "/admin";

  const isAdmin = role === "admin";
  const isVendPollo = role === "vendedor_pollo";
  const isVendDulces = role === "vendedor_dulces";

  // Admin puede ver ambos rubros -> selector
  const [rubro, setRubro] = useState<Rubro>(() => {
    if (isVendPollo) return "POLLO";
    if (isVendDulces) return "DULCES";
    return "POLLO";
  });

  // Tabs por rubro/rol (✅ ahora incluye Transacciones en DULCES)
  const tabs = useMemo(() => {
    // === ADMIN ===
    if (isAdmin) {
      if (rubro === "POLLO") {
        return [
          { key: "dash", label: "Dashboard", to: `${base}/financialDashboard` },
          { key: "inv", label: "Inventario", to: `${base}/batches` },
          { key: "invPag", label: "Factura", to: `${base}/paidBatches` },
          { key: "gastos", label: "Gastos", to: `${base}/expenses` },
        ];
      }
      // DULCES (admin)
      return [
        { key: "dc", label: "Data", to: `${base}/datacenter` },
        { key: "maes", label: "Inventario", to: `${base}/mainordersCandies` },
        { key: "ord", label: "Rutas", to: `${base}/productsVendorsCandies` },

        { key: "cli", label: "Cuentas", to: `${base}/customersCandies` },
        // ✅ NUEVO TAB
        { key: "trx", label: "Ventas", to: `${base}/transactionCandies` },
        { key: "cier", label: "Cierres", to: `${base}/cierreVentasCandies` },
      ];
    }

    // === VENDEDOR POLLO ===
    if (isVendPollo) {
      return [
        { key: "venta", label: "Venta", to: `${base}/salesV2` },
        { key: "inv", label: "Inventario", to: `${base}/batches` },
        { key: "cierre", label: "Cierre", to: `${base}/bills` },
      ];
    }

    // === VENDEDOR DULCES ===
    if (isVendDulces) {
      return [
        { key: "venta", label: "Vender", to: `${base}/salesCandies` },
        {
          key: "ped",
          label: "Inventario",
          to: `${base}/productsVendorsCandies`,
        },
        { key: "cli", label: "Cuentas", to: `${base}/customersCandies` },
        // ✅ NUEVO TAB
        { key: "trx", label: "Ventas", to: `${base}/transactionCandies` },
        { key: "cier", label: "Cierre", to: `${base}/cierreVentasCandies` },
        { key: "cash", label: "Cash", to: `${base}/cashDeliveries` },
      ];
    }

    // fallback
    return [{ key: "home", label: "Inicio", to: `${base}` }];
  }, [isAdmin, isVendPollo, isVendDulces, rubro]);

  useEffect(() => {
    // cuando cambia rubro, mandalo a la primera tab de ese rubro
    if (!isAdmin) return;
    if (!tabs.length) return;
    navigate(tabs[0].to, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rubro]);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
  };

  const tabCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex-1 text-center text-[11px] py-1.5 rounded-lg",
      "leading-none select-none",
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
    );

  return (
    // Layout en columna: header fijo + contenido scrolleable + tab bar fijo
    <div className="min-h-screen bg-[#f1f3f7] flex flex-col">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 bg-white border-b shadow-sm">
        <div className="px-3 py-3 flex items-center gap-2">
          {/* Rubro selector solo para admin */}
          {isAdmin ? (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setRubro("POLLO")}
                className={cn(
                  "px-3 py-2 rounded-2xl text-sm font-semibold",
                  rubro === "POLLO"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700"
                )}
              >
                Pollos Bea
              </button>
              <button
                type="button"
                onClick={() => setRubro("DULCES")}
                className={cn(
                  "px-3 py-2 rounded-2xl text-sm font-semibold",
                  rubro === "DULCES"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700"
                )}
              >
                CandyShop
              </button>
            </div>
          ) : (
            <div className="text-sm font-semibold text-gray-800">
              {isVendPollo
                ? "Pollos Bea"
                : isVendDulces
                ? "CandyShop"
                : "Posys"}
            </div>
          )}

          <div className="ml-auto flex items-center gap-2">
            {/* Si querés mantener InstallApp visible, descomentá */}
            {/* <InstallApp /> */}

            <button
              onClick={handleLogout}
              className="px-3 py-2 rounded-2xl bg-red-500 text-white text-sm font-semibold shadow hover:bg-red-600"
            >
              Cerrar
            </button>
          </div>
        </div>
      </header>

      {/* Content (solo esto scrollea)
          ✅ Ajuste PWA: padding-bottom con safe-area para que no lo tape el tabbar */}
      <main className="flex-1 overflow-y-auto px-3 pt-3 pb-[calc(92px+env(safe-area-inset-bottom))]">
        <Outlet />
      </main>

      {/* Bottom Tabs (fijo SIEMPRE)
          ✅ safe-area abajo */}
      <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t shadow-md pb-[env(safe-area-inset-bottom)]">
        <div className="max-w-3xl mx-auto px-2 py-1.5 flex gap-1.5">
          {tabs.map((t) => (
            <NavLink key={t.key} to={t.to} className={tabCls}>
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </div>
  );
}
