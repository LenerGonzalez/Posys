// src/components/MobileTabsLayout.tsx
import React, { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import {
  FaBook,
  FaBars,
  FaCandyCane,
  FaDrumstickBite,
  FaEllipsisV,
  FaSignOutAlt,
  FaThLarge,
  FaTimes,
} from "react-icons/fa";
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
    canPath(subject, "customersPollo", "view") ||
    canPath(subject, "billing", "view") ||
    canPath(subject, "statusInventory", "view");

  const hasDulces =
    canPath(subject, "salesCandies", "view") ||
    canPath(subject, "productsVendorsCandies", "view") ||
    canPath(subject, "customersCandies", "view") ||
    canPath(subject, "productsPricesCandies", "view") ||
    canPath(subject, "transactionCandies", "view") ||
    canPath(subject, "cierreVentasCandies", "view") ||
    canPath(subject, "estadoCuentaCandies", "view") ||
    canPath(subject, "stockPedidosCandies", "view") ||
    canPath(subject, "mainordersCandies", "view") ||
    canPath(subject, "reporteCierresCandies", "view");

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
  const [isLoggingOut, setIsLoggingOut] = useState(false);

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
            {
              key: "statusAccount",
              label: "Estado de Cuenta",
              to: `${base}/statusAccount`,
            },
            {
              key: "statusInventory",
              label: "Estado de Inventario",
              to: `${base}/statusInventory`,
            },
            { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },

            { key: "inv", label: "Inventario", to: `${base}/batches` },
            { key: "invPag", label: "Factura", to: `${base}/paidBatches` },
            { key: "gastos", label: "Gastos", to: `${base}/expenses` },
            {
              key: "arqueos",
              label: "Arqueos Caja",
              to: `${base}/polloCashAudits`,
            },
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
            {
              key: "dash",
              label: "Dashboard",
              to: `${base}/financialDashboard`,
            },
            {
              key: "statusAccount",
              label: "Estado de Cuenta",
              to: `${base}/statusAccount`,
            },
            {
              key: "statusInventory",
              label: "Estado de Inventario",
              to: `${base}/statusInventory`,
            },
            { key: "inv", label: "Inventario", to: `${base}/batches` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },
            { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
            { key: "facturacion", label: "Facturación", to: `${base}/billing` },
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
            { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
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
            {
              key: "dash",
              label: "Dashboard",
              to: `${base}/financialDashboard`,
            },
            {
              key: "statusAccount",
              label: "Estado de Cuenta",
              to: `${base}/statusAccount`,
            },
            {
              key: "statusInventory",
              label: "Estado de Inventario",
              to: `${base}/statusInventory`,
            },
            { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
            {
              key: "trxs",
              label: "Transacciones",
              to: `${base}/transactionsPollo`,
            },
            {
              key: "bills",
              label: "Facturación",
              to: `${base}/billing`,
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
              key: "venta",
              label: "Venta",
              to: `${base}/salesCandies`,
            },
            {
              key: "precios",
              label: "Precio Ventas",
              to: `${base}/productsPricesCandies`,
            },
            {
              key: "cier",
              label: "Ventas diarias",
              to: `${base}/cierreVentasCandies`,
            },
            {
              key: "trx",
              label: "Ventas del dia",
              to: `${base}/transactionCandies`,
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
              key: "cli",
              label: "Saldos Externos",
              to: `${base}/reporteCierresCandies`,
            },

            {
              key: "estadoCuenta",
              label: "Estado Cuenta",
              to: `${base}/estadoCuentaCandies`,
            },
            {
              key: "stockPedidos",
              label: "Stock Pedidos",
              to: `${base}/stockPedidosCandies`,
            },
            {
              key: "cash",
              label: "Entregas Efectivo ",
              to: `${base}/cashDeliveries`,
            },
            { key: "items", label: "Productos", to: `${base}/productsCandies` },

            {
              key: "dc",
              label: "Data Center Reporte",
              to: `${base}/datacenter`,
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
            { key: "trx", label: "Ventas", to: `${base}/transactionCandies` },
            { key: "cier", label: "Cierre", to: `${base}/cierreVentasCandies` },

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
            {
              key: "estadoCuenta",
              label: "Estado Cuenta",
              to: `${base}/estadoCuentaCandies`,
            },
            {
              key: "stockPedidos",
              label: "Stock Pedidos",
              to: `${base}/stockPedidosCandies`,
            },
          ];
        } else if (hasDulces) {
          const dulcesTabs = [] as Array<{
            key: string;
            label: string;
            to: string;
          }>;

          if (canPath(subject, "salesCandies", "view")) {
            dulcesTabs.push({
              key: "venta",
              label: "Ventas",
              to: `${base}/salesCandies`,
            });
          }
          if (canPath(subject, "productsPricesCandies", "view")) {
            dulcesTabs.push({
              key: "precios",
              label: "Precios ventas",
              to: `${base}/productsPricesCandies`,
            });
          }
          if (canPath(subject, "productsVendorsCandies", "view")) {
            dulcesTabs.push({
              key: "inv",
              label: "Inventario",
              to: `${base}/productsVendorsCandies`,
            });
          }
          if (canPath(subject, "transactionCandies", "view")) {
            dulcesTabs.push({
              key: "trx",
              label: "Transacciones",
              to: `${base}/transactionCandies`,
            });
          }
          if (canPath(subject, "customersCandies", "view")) {
            dulcesTabs.push({
              key: "cli",
              label: "Saldos pendientes",
              to: `${base}/customersCandies`,
            });
          }
          if (canPath(subject, "estadoCuentaCandies", "view")) {
            dulcesTabs.push({
              key: "estado",
              label: "Estado Cuenta",
              to: `${base}/estadoCuentaCandies`,
            });
          }
          if (canPath(subject, "cierreVentasCandies", "view")) {
            dulcesTabs.push({
              key: "cier",
              label: "Ventas diarias",
              to: `${base}/cierreVentasCandies`,
            });
          }
          if (canPath(subject, "stockPedidosCandies", "view")) {
            dulcesTabs.push({
              key: "stockPedidos",
              label: "Stock Pedidos",
              to: `${base}/stockPedidosCandies`,
            });
          }
          if (canPath(subject, "mainordersCandies", "view")) {
            dulcesTabs.push({
              key: "maes",
              label: "Orden maestra",
              to: `${base}/mainordersCandies`,
            });
          }
          if (canPath(subject, "reporteCierresCandies", "view")) {
            dulcesTabs.push({
              key: "saldosExt",
              label: "Saldos Externos",
              to: `${base}/reporteCierresCandies`,
            });
          }

          built = dulcesTabs.length
            ? dulcesTabs
            : [{ key: "home", label: "Inicio", to: `${base}` }];
        } else {
          built = [{ key: "home", label: "Inicio", to: `${base}` }];
        }
      }
    } else {
      // === SUPERVISOR POLLO (sin ambos rubros) ===
      if (isSupervisor) {
        const supTabs = [
          { key: "venta", label: "Venta", to: `${base}/salesV2` },
          {
            key: "dash",
            label: "Dashboard",
            to: `${base}/financialDashboard`,
          },
          {
            key: "statusAccount",
            label: "Estado de Cuenta",
            to: `${base}/statusAccount`,
          },
          {
            key: "statusInventory",
            label: "Estado de Inventario",
            to: `${base}/statusInventory`,
          },
          { key: "inv", label: "Inventario", to: `${base}/batches` },
          {
            key: "clientes",
            label: "Saldos Pendientes",
            to: `${base}/customersPollo`,
          },
          {
            key: "trxs",
            label: "Reporte Ventas",
            to: `${base}/transactionsPollo`,
          },
          { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
          { key: "facturacion", label: "Facturación", to: `${base}/billing` },
        ];
        if (hasRole(subject, "contador")) {
          built = [
            ...supTabs,
            {
              key: "arqueos",
              label: "Arqueos Caja",
              to: `${base}/polloCashAudits`,
            },
            {
              key: "statusAccount",
              label: "Estado de Cuenta",
              to: `${base}/statusAccount`,
            },
            {
              key: "statusInventory",
              label: "Estado de Inventario",
              to: `${base}/statusInventory`,
            },
          ];
        } else built = supTabs;
      }
      // === VENDEDOR POLLO ===
      else if (isVendPollo) {
        built = [
          { key: "venta", label: "Venta", to: `${base}/salesV2` },
          { key: "cierre", label: "Ventas diarias", to: `${base}/bills` },
          {
            key: "trxs",
            label: "Reporte Ventas",
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
            key: "cier",
            label: "Ventas diarias",
            to: `${base}/cierreVentasCandies`,
          },
          {
            key: "trx",
            label: "Reporte Ventas",
            to: `${base}/transactionCandies`,
          },

          {
            key: "stockPedidos",
            label: "Stock - Pedidos",
            to: `${base}/stockPedidosCandies`,
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
      "financialDashboard",
      "polloCashAudits",
      "billing",
      "statusAccount",
      "statusInventory",
      "polloCashAudits",
      // DULCES
      "salesCandies",
      "productsVendorsCandies",
      "productsPricesCandies",
      "transactionCandies",
      "cierreVentasCandies",
      "customersCandies",
      "estadoCuentaCandies",
      "stockPedidosCandies",
      "mainordersCandies",
      "reporteCierresCandies",
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
    setIsLoggingOut(true);
    const start = Date.now();
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
        localStorage.removeItem("pos_vendorId");
        localStorage.removeItem("pos_role");
      } catch (e) {}
      setConfirmLogoutOpen(false);
      setDrawerOpen(false);
      const elapsed = Date.now() - start;
      const minDurationMs = 800;
      if (elapsed < minDurationMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, minDurationMs - elapsed),
        );
      }
      try {
        sessionStorage.setItem("logout_transition", "1");
      } catch (e) {}
      navigate("/");
    }
  };

  const tabCls =
    (to: string) =>
    ({ isActive }: { isActive: boolean }) => {
      const meta = tabMeta(to);
      return cn(
        "flex-1 text-center text-[11px] py-1.5 rounded-lg",
        "leading-none select-none",
        isActive
          ? `${meta.activeBg} ${meta.activeText}`
          : "text-gray-700 hover:bg-gray-100",
      );
    };

  // ✅ Regla: si hay muchos tabs, ocultamos barra de abajo y usamos Drawer
  const showBottomTabs = tabs.length <= 2;

  const drawerLinkCls =
    (to: string) =>
    ({ isActive }: { isActive: boolean }) => {
      const meta = tabMeta(to);
      return cn(
        "w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border border-l-4",
        isActive
          ? `${meta.activeBg} ${meta.activeBorder} ${meta.activeText}`
          : "bg-white text-gray-800 border-gray-200 hover:bg-slate-50",
      );
    };

  const storedUserName =
    typeof window !== "undefined" ? localStorage.getItem("user_name") : null;
  const storedUserEmail =
    typeof window !== "undefined" ? localStorage.getItem("user_email") : null;
  const displayName = storedUserName || storedUserEmail || "Usuario";

  const getInitials = (value: string) => {
    const cleaned = value.trim();
    if (!cleaned) return "U";
    let parts = cleaned.split(/\s+/).filter(Boolean);
    if (parts.length < 2) {
      const alt = cleaned.split(/[._-]+/).filter(Boolean);
      if (alt.length >= 2) parts = alt;
    }
    const first = parts[0]?.[0] ?? "U";
    const second = parts[1]?.[0] ?? "";
    return `${first}${second}`.toUpperCase();
  };

  const avatarInitials = getInitials(displayName);

  const roleLabels: Record<string, string> = {
    admin: "Administrador",
    supervisor_pollo: "Supervisor Pollo",
    contador: "Contador",
    vendedor_pollo: "Vendedor Pollo",
    vendedor_ropa: "Vendedor Ropa",
    vendedor_dulces: "Vendedor Dulces",
    vendedor: "Vendedor Pollo",
  };
  const roleList = Array.isArray(subject)
    ? subject.map(String)
    : subject
      ? [String(subject)]
      : [];
  const roleLabel = roleList.length
    ? roleList.map((r) => roleLabels[r] || r).join("\n")
    : "Sin rol";

  const tabMeta = (to: string) => {
    if (to.includes("notebooksInventory")) {
      return {
        icon: <FaBook className="h-3.5 w-3.5" />,
        dot: "bg-indigo-500",
        border: "border-indigo-400",
        activeBg: "bg-indigo-200",
        activeBorder: "border-indigo-400",
        activeText: "text-indigo-900",
      };
    }
    if (
      to.includes("Candies") ||
      to.includes("datacenter") ||
      to.includes("cashDeliveries") ||
      to.includes("billingsCandies") ||
      to.includes("consolidatedVendors") ||
      to.includes("dashboardCandies")
    ) {
      return {
        icon: <FaCandyCane className="h-3.5 w-3.5" />,
        dot: "bg-pink-500",
        border: "border-pink-400",
        activeBg: "bg-pink-200",
        activeBorder: "border-pink-400",
        activeText: "text-pink-900",
      };
    }
    return {
      icon: <FaDrumstickBite className="h-3.5 w-3.5" />,
      dot: "bg-amber-500",
      border: "border-amber-400",
      activeBg: "bg-amber-200",
      activeBorder: "border-amber-400",
      activeText: "text-amber-900",
    };
  };

  const showPolloBadge = tabs.some(
    (t) =>
      t.to.includes("salesV2") ||
      t.to.includes("batches") ||
      t.to.includes("inventoryCutoffs") ||
      t.to.includes("customersPollo") ||
      t.to.includes("transactionsPollo") ||
      t.to.includes("bills"),
  );
  const showDulcesBadge = tabs.some((t) => t.to.includes("Candies"));
  const showLibreriaBadge = tabs.some((t) =>
    t.to.includes("notebooksInventory"),
  );

  return (
    <div className="min-h-screen bg-[#f1f3f7] flex flex-col">
      {/* Top Bar */}
      <header className="sticky top-0 z-50 bg-white border-b shadow-sm">
        <div className="px-2 sm:px-3 py-2.5 sm:py-3 flex items-center gap-1.5 sm:gap-2 min-w-0">
          {/* Rubro selector para admin o usuario con ambos rubros */}
          {isAdmin || hasBoth ? (
            <div className="flex flex-wrap items-center gap-1.5 sm:gap-2 min-w-0">
              <img
                src="/logo_black.svg"
                alt="Logo Multiservicios Ortiz"
                className="h-8 w-auto sm:h-11 max-[360px]:h-7 self-center shrink-0"
              />
              <button
                type="button"
                onClick={() => setRubro("POLLO")}
                className={cn(
                  "inline-flex items-center gap-1.5 sm:gap-2 rounded-full border px-2 py-1.5 sm:px-3 sm:py-2 text-[10px] sm:text-xs font-semibold shadow-sm transition max-[360px]:px-1.5 max-[360px]:py-1",
                  rubro === "POLLO"
                    ? "bg-amber-50 text-amber-700 border-amber-200"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50",
                )}
              >
                <span className="inline-flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-amber-500 text-white shrink-0">
                  <FaDrumstickBite className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                </span>
                Pollos Bea
              </button>
              <button
                type="button"
                onClick={() => setRubro("DULCES")}
                className={cn(
                  "inline-flex items-center gap-1.5 sm:gap-2 rounded-full border px-2 py-1.5 sm:px-3 sm:py-2 text-[10px] sm:text-xs font-semibold shadow-sm transition max-[360px]:px-1.5 max-[360px]:py-1",
                  rubro === "DULCES"
                    ? "bg-pink-50 text-pink-700 border-pink-200"
                    : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50",
                )}
              >
                <span className="inline-flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-pink-500 text-white shrink-0">
                  <FaCandyCane className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                </span>
                Mr. Candy
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-1.5 sm:gap-2 min-w-0 flex-1">
              <img
                src="/logo_black.svg"
                alt="Logo Multiservicios Ortiz"
                className="h-8 w-auto sm:h-11 max-[360px]:h-7 shrink-0"
              />
              {isVendPollo ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 sm:gap-2 rounded-full border px-2 py-1.5 sm:px-3 sm:py-2 text-[10px] sm:text-xs font-semibold shadow-sm",
                    "border-amber-200 bg-amber-50 text-amber-700 max-[360px]:px-1.5 max-[360px]:py-1",
                  )}
                >
                  <span className="inline-flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-amber-500 text-white shrink-0">
                    <FaDrumstickBite className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  </span>
                  Pollos Bea
                </span>
              ) : isVendDulces ? (
                <span
                  className={cn(
                    "inline-flex items-center gap-1.5 sm:gap-2 rounded-full border px-2 py-1.5 sm:px-3 sm:py-2 text-[10px] sm:text-xs font-semibold shadow-sm",
                    "border-pink-200 bg-pink-50 text-pink-700 max-[360px]:px-1.5 max-[360px]:py-1",
                  )}
                >
                  <span className="inline-flex h-4 w-4 sm:h-5 sm:w-5 items-center justify-center rounded-full bg-pink-500 text-white shrink-0">
                    <FaCandyCane className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
                  </span>
                  CandyShop
                </span>
              ) : (
                <div className="text-xs sm:text-sm font-semibold text-gray-800 truncate max-[360px]:text-[11px]">
                  Posys
                </div>
              )}
            </div>
          )}

          <div className="ml-auto flex items-center gap-1.5 sm:gap-2 shrink-0">
            {/* Si querés mantener InstallApp visible, lo agregas acá */}

            {/* ✅ Botón 3 puntos (Drawer) */}
            <button
              type="button"
              onClick={() => setDrawerOpen((v) => !v)}
              className={`inline-flex h-9 w-9 sm:h-10 sm:w-10 max-[360px]:h-8 max-[360px]:w-8 items-center justify-center rounded-2xl border shadow-sm transition ${
                drawerOpen
                  ? "bg-slate-900 text-white border-slate-900"
                  : "bg-white text-slate-700 border-slate-200 hover:bg-slate-50"
              }`}
              aria-label={drawerOpen ? "Cerrar menú" : "Abrir menú"}
              title={drawerOpen ? "Cerrar menú" : "Menú"}
            >
              {drawerOpen ? (
                <FaTimes className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              ) : (
                <FaBars className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
              )}
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
          <aside className="absolute right-0 top-0 h-full w-[86%] max-w-sm bg-gradient-to-b from-slate-50 via-white to-slate-50 shadow-2xl border-l border-slate-200 flex flex-col">
            <div className="p-4 border-b border-slate-200">
              <div className="flex items-center justify-between">
                <div className="font-bold text-gray-900">Panel</div>
                <button
                  type="button"
                  onClick={() => setDrawerOpen(false)}
                  className="inline-flex h-9 w-9 items-center justify-center rounded-xl bg-white/90 border border-slate-200 shadow-sm hover:bg-slate-50"
                >
                  <FaTimes className="h-4 w-4" />
                </button>
              </div>

              {(showPolloBadge || showDulcesBadge || showLibreriaBadge) && (
                <div className="mt-2 flex flex-wrap gap-2">
                  {showPolloBadge && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-semibold text-amber-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-amber-500 text-white">
                        <FaDrumstickBite className="h-2.5 w-2.5" />
                      </span>
                      Pollos
                    </span>
                  )}
                  {showDulcesBadge && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-pink-200 bg-pink-50 px-2.5 py-1 text-[11px] font-semibold text-pink-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-pink-500 text-white">
                        <FaCandyCane className="h-2.5 w-2.5" />
                      </span>
                      Dulces
                    </span>
                  )}
                  {showLibreriaBadge && (
                    <span className="inline-flex items-center gap-1 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-[11px] font-semibold text-indigo-700">
                      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full bg-indigo-500 text-white">
                        <FaBook className="h-2.5 w-2.5" />
                      </span>
                      Libreria
                    </span>
                  )}
                </div>
              )}

              <div className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
                <div className="text-[10px] uppercase tracking-wide text-slate-500">
                  Conectado como
                </div>
                <div className="mt-2 flex items-center gap-3">
                  <div className="h-10 w-10 rounded-full bg-slate-900 text-white flex items-center justify-center font-semibold">
                    {avatarInitials}
                  </div>
                  <div className="min-w-0">
                    <div className="text-base font-semibold text-slate-800 truncate">
                      {displayName}
                    </div>
                    <div className="text-xs text-slate-500 whitespace-pre-line">
                      {roleLabel}
                    </div>
                    {storedUserName && storedUserEmail && (
                      <div className="text-xs text-slate-500 truncate">
                        {storedUserEmail}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* Lista de opciones */}
            <div className="p-3 flex-1 overflow-y-auto space-y-2">
              {tabs.map((t) => {
                const meta = tabMeta(t.to);
                return (
                  <NavLink
                    key={t.key}
                    to={t.to}
                    className={drawerLinkCls(t.to)}
                  >
                    <span className="flex items-center gap-3">
                      <span
                        className={`inline-flex h-7 w-7 items-center justify-center rounded-full text-white ${meta.dot}`}
                      >
                        {meta.icon}
                      </span>
                      <span className="font-semibold">{t.label}</span>
                    </span>
                    <span className="text-sm opacity-80">›</span>
                  </NavLink>
                );
              })}
            </div>

            {/* acciones abajo */}
            <div className="p-3 border-t space-y-2 pb-[calc(12px+env(safe-area-inset-bottom))]">
              <button
                onClick={handleLogout}
                className="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl bg-red-500 text-white font-semibold shadow hover:bg-red-600"
              >
                <FaSignOutAlt className="h-4 w-4" />
                <span>Cerrar sesión</span>
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
                        className="px-3 py-2 rounded bg-red-500 text-white disabled:opacity-60"
                        disabled={isLoggingOut}
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

      {isLoggingOut && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900/90 px-6 py-5 text-white shadow-2xl">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            <div className="text-sm font-semibold tracking-wide">
              Cerrando sesion...
            </div>
          </div>
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
              <NavLink key={t.key} to={t.to} className={tabCls(t.to)}>
                {t.label}
              </NavLink>
            ))}
          </div>
        </nav>
      )}
    </div>
  );
}
