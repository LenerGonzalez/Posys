// src/components/MobileTabsLayout.tsx
import React, { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
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
  const location = useLocation();
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

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);

  // Tabs por rubro/rol
  const tabs = useMemo(() => {
    // === ADMIN ===
    if (isAdmin) {
      if (rubro === "POLLO") {
        return [
          { key: "venta", label: "Venta", to: `${base}/salesV2` },
          { key: "dash", label: "Dashboard", to: `${base}/financialDashboard` },
          { key: "inv", label: "Inventario", to: `${base}/batches` },
          { key: "invPag", label: "Factura", to: `${base}/paidBatches` },
          { key: "gastos", label: "Gastos", to: `${base}/expenses` },
        ];
      }
      // DULCES (admin)
      return [
        { key: "dc", label: "Data Center Reporte", to: `${base}/datacenter` },
        {
          key: "maes",
          label: "Inventario Global",
          to: `${base}/mainordersCandies`,
        },
        {
          key: "ord",
          label: "Inventario Vendedor",
          to: `${base}/productsVendorsCandies`,
        },
        {
          key: "cli",
          label: "Saldos Pendientes",
          to: `${base}/customersCandies`,
        },
        {
          key: "trx",
          label: "Ventas del dia",
          to: `${base}/transactionCandies`,
        },
        {
          key: "cier",
          label: "Cierre de ventas",
          to: `${base}/cierreVentasCandies`,
        },
        {
          key: "cash",
          label: "Entregas Efectivo ",
          to: `${base}/cashDeliveries`,
        },
        { key: "items", label: "Productos", to: `${base}/productsCandies` },
        //{ key: "venta", label: "Vender", to: `${base}/salesCandies` },
        {
          key: "precios",
          label: "Precio Ventas",
          to: `${base}/productsPricesCandies`,
        },
        {
          key: "gonper",
          label: "Productos Gonper",
          to: `${base}/notebooksInventory`,
        },
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
          key: "precios",
          label: "Precios",
          to: `${base}/productsPricesCandies`,
        },
        {
          key: "ped",
          label: "Inventario",
          to: `${base}/productsVendorsCandies`,
        },
        {
          key: "cli",
          label: "Saldos Pendientes",
          to: `${base}/customersCandies`,
        },
        { key: "trx", label: "Ventas", to: `${base}/transactionCandies` },
        { key: "cier", label: "Cierre", to: `${base}/cierreVentasCandies` },
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

  // Cerrar drawer al cambiar de ruta
  useEffect(() => {
    if (!drawerOpen) return;
    setDrawerOpen(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.pathname]);

  // Esc para cerrar drawer
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setDrawerOpen(false);
    };
    if (drawerOpen) window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawerOpen]);

  const handleLogout = async () => {
    await signOut(auth);
    setDrawerOpen(false);
    navigate("/");
  };

  const tabCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex-1 text-center text-[11px] py-1.5 rounded-lg",
      "leading-none select-none",
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100",
    );

  // ✅ Regla: si hay muchos tabs, ocultamos barra de abajo y usamos Drawer
  const showBottomTabs = tabs.length <= 4;

  const drawerLinkCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      "w-full flex items-center justify-between px-4 py-3 rounded-xl border",
      isActive
        ? "bg-blue-600 text-white border-blue-600"
        : "bg-white text-gray-800 border-gray-200 hover:bg-gray-50",
    );

  return (
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
                    : "bg-gray-100 text-gray-700",
                )}
              >
                Carniceria
              </button>
              <button
                type="button"
                onClick={() => setRubro("DULCES")}
                className={cn(
                  "px-3 py-2 rounded-2xl text-sm font-semibold",
                  rubro === "DULCES"
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700",
                )}
              >
                Mr. Candy
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

            {/* ✅ Botón 3 puntos (Drawer) */}
            <button
              type="button"
              onClick={() => setDrawerOpen(true)}
              className="px-3 py-2 rounded-2xl bg-gray-100 text-gray-800 text-sm font-bold shadow hover:bg-gray-200"
              aria-label="Abrir menú"
              title="Menú"
            >
              ⋮
            </button>
          </div>
        </div>
      </header>

      {/* Drawer */}
      {drawerOpen && (
        <div className="fixed inset-0 z-[80]">
          {/* overlay */}
          <button
            type="button"
            className="absolute inset-0 bg-black/40"
            onClick={() => setDrawerOpen(false)}
            aria-label="Cerrar menú"
          />

          {/* panel */}
          <aside className="absolute right-0 top-0 h-full w-[86%] max-w-sm bg-white shadow-2xl border-l flex flex-col">
            <div className="p-4 border-b flex items-center justify-between">
              <div className="font-bold text-gray-900">Menú</div>
              <button
                type="button"
                onClick={() => setDrawerOpen(false)}
                className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200"
              >
                ✕
              </button>
            </div>

            {/* Lista de opciones */}
            <div className="p-3 flex-1 overflow-y-auto space-y-2">
              {tabs.map((t) => (
                <NavLink key={t.key} to={t.to} className={drawerLinkCls}>
                  <span className="font-semibold">{t.label}</span>
                  <span className="text-sm opacity-80">›</span>
                </NavLink>
              ))}
            </div>

            {/* acciones abajo */}
            <div className="p-3 border-t space-y-2 pb-[calc(12px+env(safe-area-inset-bottom))]">
              <button
                onClick={handleLogout}
                className="w-full px-4 py-3 rounded-xl bg-red-500 text-white font-semibold shadow hover:bg-red-600"
              >
                Cerrar sesión
              </button>
            </div>
          </aside>
        </div>
      )}

      {/* Content (solo esto scrollea)
          ✅ Ajuste PWA: padding-bottom con safe-area para que no lo tape el tabbar */}
      <main
        className={cn(
          "flex-1 overflow-y-auto px-3 pt-3",
          showBottomTabs
            ? "pb-[calc(92px+env(safe-area-inset-bottom))]"
            : "pb-[calc(16px+env(safe-area-inset-bottom))]",
        )}
      >
        <Outlet />
      </main>

      {/* Bottom Tabs (solo si hay pocos tabs) */}
      {showBottomTabs && (
        <nav className="fixed bottom-0 left-0 right-0 z-50 bg-white border-t shadow-md pb-[env(safe-area-inset-bottom)]">
          <div className="max-w-3xl mx-auto px-2 py-1.5 flex gap-1.5">
            {tabs.map((t) => (
              <NavLink key={t.key} to={t.to} className={tabCls}>
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
