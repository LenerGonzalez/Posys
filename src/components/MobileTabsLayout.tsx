// src/components/MobileTabsLayout.tsx
import React, { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { hasRole } from "../utils/roles";
import { canPath, PathKey } from "../utils/access";

type Role =
  | ""
  | "admin"
  | "supervisor_pollo"
  | "contador"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

type Rubro = "POLLO" | "DULCES";

function cn(...cls: Array<string | false | null | undefined>) {
  return cls.filter(Boolean).join(" ");
}

export default function MobileTabsLayout({
  role,
  roles,
}: {
  role?: Role | string;
  roles?: Role[] | string[];
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const base = "/admin";

  const subject = roles && roles.length ? roles : role;

  const isAdmin = hasRole(subject, "admin");
  const isVendPollo = hasRole(subject, "vendedor_pollo");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const isSupervisor =
    hasRole(subject, "supervisor_pollo") || hasRole(subject, "contador");
  const isContPollo = hasRole(subject, "contador");

  // ✅ Detectar acceso real por permisos (multi-rol)
  const hasPollo =
    canPath(subject, "salesV2", "view") ||
    canPath(subject, "batches", "view") ||
    canPath(subject, "bills", "view") ||
    canPath(subject, "transactionsPollo", "view") ||
    canPath(subject, "customersPollo", "view");

  const hasDulces =
    canPath(subject, "salesCandies", "view") ||
    canPath(subject, "productsVendorsCandies", "view") ||
    canPath(subject, "customersCandies", "view") ||
    canPath(subject, "productsPricesCandies", "view") ||
    canPath(subject, "transactionCandies", "view") ||
    canPath(subject, "cierreVentasCandies", "view");

  // Mostrar selector cuando el usuario tenga acceso a ambos rubros
  const hasBoth = hasPollo && hasDulces;

  const [rubro, setRubro] = useState<Rubro>(() => {
    try {
      const saved =
        typeof window !== "undefined" ? localStorage.getItem("rubro") : null;
      if (saved === "POLLO" || saved === "DULCES") return saved as Rubro;
    } catch (e) {}

    if (hasPollo) return "POLLO";
    if (hasDulces) return "DULCES";
    return "POLLO";
  });

  // Drawer
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);

  // Tabs por rubro/rol
  const tabs = useMemo(() => {
    let built: Array<{ key: string; label: string; to: string }> = [];

    // Si el usuario es admin O tiene ambos rubros, respetamos rubro
    if (isAdmin || hasBoth) {
      if (rubro === "POLLO") {
        // ADMIN - POLLO
        if (isAdmin) {
          built = [
            { key: "venta", label: "Vender", to: `${base}/salesV2` },
            {
              key: "clientes",
              label: "Saldos pendientes",
              to: `${base}/customersPollo`,
            },
            {
              key: "dash",
              label: "Dashboard",
              to: `${base}/financialDashboard`,
            },
            { key: "cierre", label: "Cierre Ventas", to: `${base}/bills` },
            { key: "trxs", label: "Transacciones", to: `${base}/transactionsPollo` },
            { key: "inv", label: "Inventario", to: `${base}/batches` },
            { key: "invPag", label: "Factura", to: `${base}/paidBatches` },
            { key: "gastos", label: "Gastos", to: `${base}/expenses` },
          ];
        }
        // Usuario con ambos rubros mostrando POLLO
        else if (isSupervisor) {
          const supTabs = [
            { key: "venta", label: "Vender", to: `${base}/salesV2` },
            {
              key: "clientes",
              label: "Saldos pendientes",
              to: `${base}/customersPollo`,
            },
            { key: "inv", label: "Inventario", to: `${base}/batches` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },
            { key: "cierre", label: "Cierre Ventas", to: `${base}/bills` },
          ];

          // contador no ve cierre (como tu lógica actual)
          if (hasRole(subject, "contador")) built = supTabs;
        } else if (isVendPollo) {
          built = [
            { key: "venta", label: "Vender", to: `${base}/salesV2` },
            {
              key: "clientes",
              label: "Saldos Pendientes",
              to: `${base}/customersPollo`,
            },
            { key: "cierre", label: "Cierre Ventas", to: `${base}/bills` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },
            
          ];
        } else if (isContPollo) {
          built = [
            { key: "venta", label: "Vender", to: `${base}/salesV2` },
            {
              key: "clientes",
              label: "Saldos Pendientes",
              to: `${base}/customersPollo`,
            },
            { key: "cierre", label: "Cierre Ventas", to: `${base}/bills` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },
          ];
        } else {
          built = [{ key: "home", label: "Inicio", to: `${base}` }];
        }
      }

      // DULCES (admin o usuario con ambos rubros mostrando DULCES)
      if (rubro === "DULCES") {
        if (isAdmin) {
          built = [
            {
              key: "dc",
              label: "Data Center Reporte",
              to: `${base}/datacenter`,
            },
            {
              key: "maes",
              label: "Inventario Maestro",
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
        } else if (isVendDulces) {
          built = [
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
        } else {
          built = [{ key: "home", label: "Inicio", to: `${base}` }];
        }
      }
    } else {
      // === SUPERVISOR POLLO (sin ambos rubros) ===
      if (isSupervisor) {
        const supTabs = [
          { key: "venta", label: "Venta", to: `${base}/salesV2` },
          { key: "inv", label: "Inventario", to: `${base}/batches` },
          {
            key: "clientes",
            label: "Saldos Pendientes",
            to: `${base}/customersPollo`,
          },
          {
            key: "trxs",
            label: "Transacciones",
            to: `${base}/transactionsPollo`,
          },
          { key: "cierre", label: "Cierre", to: `${base}/bills` },
        ];
        if (hasRole(subject, "contador")) built = supTabs;
        else built = supTabs;
      }
      // === VENDEDOR POLLO ===
      else if (isVendPollo) {
        built = [
          { key: "venta", label: "Venta", to: `${base}/salesV2` },
          { key: "cierre", label: "Cierre", to: `${base}/bills` },
          {
            key: "trxs",
            label: "Transacciones",
            to: `${base}/transactionsPollo`,
          },
        ];
      }
      // === VENDEDOR DULCES ===
      else if (isVendDulces) {
        built = [
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
      } else {
        built = [{ key: "home", label: "Inicio", to: `${base}` }];
      }
    }

    // ✅ Filtrar tabs por permisos de matriz (multi-rol)
    // Solo filtramos para los paths controlados en access.ts
    const controlled = new Set<PathKey>([
      // POLLO
      "bills",
      "customersPollo",
      "transactionsPollo",
      "batches",
      "salesV2",
      // DULCES
      "salesCandies",
      "productsVendorsCandies",
      "productsPricesCandies",
      "transactionCandies",
      "cierreVentasCandies",
      "customersCandies",
    ]);

    const filtered = built.filter((t) => {
      const raw = t.to.replace(`${base}/`, "");
      const key = raw as PathKey;
      if (controlled.has(key)) return canPath(subject, key, "view");
      return true; // rutas no incluidas en matriz: no tocar (admin ya igual las ve)
    });

    return filtered;
  }, [
    base,
    rubro,
    isAdmin,
    hasBoth,
    isSupervisor,
    isVendPollo,
    isVendDulces,
    isContPollo,
    subject,
  ]);

  useEffect(() => {
    // cuando cambia rubro (admin o usuario con ambos rubros), mandalo a la primera tab de ese rubro
    if (!(isAdmin || hasBoth)) return;
    if (!tabs.length) return;

    try {
      localStorage.setItem("rubro", rubro);
    } catch (e) {}

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
    setConfirmLogoutOpen(true);
  };

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
      setDrawerOpen(false);
      navigate("/");
    }
  };

  const tabCls = ({ isActive }: { isActive: boolean }) =>
    cn(
      "flex-1 text-center text-[11px] py-1.5 rounded-lg",
      "leading-none select-none",
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100",
    );

  // ✅ Regla: si hay muchos tabs, ocultamos barra de abajo y usamos Drawer
  const showBottomTabs = tabs.length <= 2;

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
          {/* Rubro selector para admin o usuario con ambos rubros */}
          {isAdmin || hasBoth ? (
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
            {/* Si querés mantener InstallApp visible, lo agregas acá */}

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
            <div className="p-4 border-b">
              <div className="flex items-center justify-between">
                <div className="font-bold text-gray-900">Menú</div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200"
                >
                  ✕
                </button>
              </div>
              <div className="mt-2 text-[20px] text-gray-600">
                {typeof window !== "undefined" &&
                  (localStorage.getItem("user_name") ||
                    localStorage.getItem("user_email"))}
              </div>
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
          </aside>
        </div>
      )}

      {/* Content (solo esto scrollea) */}
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
