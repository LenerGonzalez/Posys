// src/components/AdminLayout.tsx
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useState } from "react";
import {
  FaBook,
  FaCandyCane,
  FaDrumstickBite,
  FaChevronLeft,
  FaChevronRight,
  FaSignOutAlt,
  FaTools,
} from "react-icons/fa";
import { hasRole } from "../utils/roles";
import { canPath } from "../utils/access";

export default function AdminLayout({
  role,
  roles,
}: {
  role: any;
  roles?: any[];
}) {
  const base = "/admin";
  const linkCls = ({ isActive }: { isActive: boolean }) =>
    `block rounded-lg px-3 py-2 text-sm transition ${
      isActive
        ? "bg-slate-900 text-white shadow-sm"
        : "text-slate-700 hover:bg-slate-100"
    }`;

  // Sidebar ancho/colapsado
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // ====== estados de menús colapsables ======
  // Operaciones Pollo
  const [openPollo, setOpenPollo] = useState(false);
  const [contadorMenuFinanzas, setContadorMenuFinanzas] = useState(false);
  const [openPolloVentas, setOpenPolloVentas] = useState(false);
  const [openPolloInv, setOpenPolloInv] = useState(false);
  const [openPolloFin, setOpenPolloFin] = useState(false);
  const [openPolloProd, setOpenPolloProd] = useState(false);
  const [openPolloOperaciones, setOpenPolloOperaciones] = useState(false);

  // Operaciones Ropa
  const [openRopa, setOpenRopa] = useState(false);
  const [openRopaInv, setOpenRopaInv] = useState(false);
  const [openRopaProd, setOpenRopaProd] = useState(false);
  const [openClients, setOpenClients] = useState(false);
  const [openRopaFin, setOpenRopaFin] = useState(false);
  const [openDashboardClothes, setOpenDashboardClothes] = useState(false);

  //Operaciones dulces
  const [openDulces, setOpenDulces] = useState(false);
  const [openDulcesInv, setOpenDulcesInv] = useState(false);
  const [openDulcesVendors, setOpenDulcesVendors] = useState(false);
  const [openDulcesFin, setOpenDulcesFin] = useState(false);

  // Operaciones Otras
  const [openOtras, setOpenOtras] = useState(false);

  const [confirmLogoutOpen, setConfirmLogoutOpen] = useState(false);

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
      navigate("/");
    }
  };

  const closePolloMenus = () => {
    setOpenPollo(false);
    setContadorMenuFinanzas(false);
    setOpenPolloVentas(false);
    setOpenPolloInv(false);
    setOpenPolloFin(false);
    setOpenPolloProd(false);
    setOpenPolloOperaciones(false);
  };

  const closeRopaMenus = () => {
    setOpenRopa(false);
    setOpenRopaInv(false);
    setOpenRopaProd(false);
    setOpenClients(false);
    setOpenRopaFin(false);
    setOpenDashboardClothes(false);
  };

  const closeDulcesMenus = () => {
    setOpenDulces(false);
    setOpenDulcesInv(false);
    setOpenDulcesVendors(false);
    setOpenDulcesFin(false);
  };

  const closeOtrasMenus = () => {
    setOpenOtras(false);
  };

  const toggleModule = (module: "pollo" | "ropa" | "dulces" | "otras") => {
    const isOpen =
      module === "pollo"
        ? openPollo
        : module === "ropa"
          ? openRopa
          : module === "dulces"
            ? openDulces
            : openOtras;

    if (isOpen) {
      if (module === "pollo") closePolloMenus();
      if (module === "ropa") closeRopaMenus();
      if (module === "dulces") closeDulcesMenus();
      if (module === "otras") closeOtrasMenus();
      return;
    }

    closePolloMenus();
    closeRopaMenus();
    closeDulcesMenus();
    closeOtrasMenus();

    if (module === "pollo") setOpenPollo(true);
    if (module === "ropa") setOpenRopa(true);
    if (module === "dulces") setOpenDulces(true);
    if (module === "otras") setOpenOtras(true);
  };

  // Helpers visuales
  const SectionBtn = ({
    open,
    onClick,
    children,
  }: {
    open: boolean;
    onClick: () => void;
    children: React.ReactNode;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`w-full flex items-center justify-between px-3 py-2 text-left text-sm font-semibold rounded-lg transition ${
        open
          ? "bg-slate-100 text-slate-900"
          : "text-slate-800 hover:bg-slate-100"
      }`}
    >
      <span>{children}</span>
      <span className="text-xs">{open ? "▾" : "▸"}</span>
    </button>
  );

  const SubSectionBtn = ({
    open,
    onClick,
    title,
  }: {
    open: boolean;
    onClick: () => void;
    title: string;
  }) => (
    <button
      type="button"
      onClick={onClick}
      className={`ml-2 w-[calc(100%-0.5rem)] flex items-center justify-between px-3 py-2 text-left text-sm rounded-lg transition ${
        open
          ? "bg-slate-100 text-slate-900"
          : "text-slate-700 hover:bg-slate-100"
      }`}
    >
      <span className="text-slate-700 font-medium">{title}</span>
      <span className="text-xs">{open ? "▾" : "▸"}</span>
    </button>
  );

  // ===== util de roles =====
  const subject = roles && roles.length ? roles : role;

  const isAdmin = hasRole(subject, "admin");
  const isVendPollo = hasRole(subject, "vendedor_pollo");
  const isVendRopa = hasRole(subject, "vendedor_ropa");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const isSupervisor =
    hasRole(subject, "supervisor_pollo") || hasRole(subject, "contador");
  const isContPollo = hasRole(subject, "contador");

  // permisos por rubro (para mostrar secciones aunque tenga 2 roles)
  const hasPolloAccess =
    canPath(subject, "salesV2", "view") ||
    canPath(subject, "customersPollo", "view") ||
    canPath(subject, "transactionsPollo", "view") ||
    canPath(subject, "bills", "view") ||
    canPath(subject, "expenses", "view") ||
    canPath(subject, "batches", "view") ||
    canPath(subject, "statusAccount", "view") ||
    canPath(subject, "statusInventory", "view");

  const hasDulcesAccess =
    canPath(subject, "salesCandies", "view") ||
    canPath(subject, "productsVendorsCandies", "view") ||
    canPath(subject, "customersCandies", "view") ||
    canPath(subject, "productsPricesCandies", "view") ||
    canPath(subject, "transactionCandies", "view") ||
    canPath(subject, "cierreVentasCandies", "view") ||
    canPath(subject, "estadoCuentaCandies", "view");

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

  return (
    <div className="min-h-screen flex">
      <aside
        className={`${
          isCollapsed
            ? "w-15 bg-slate-50 border-r p-3 transition-all duration-300 flex flex-col items-center"
            : "w-55"
        } bg-gradient-to-b from-slate-50 via-white to-slate-50 border-r border-slate-200 p-3 transition-all duration-300 flex flex-col relative`}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className={`absolute top-2 z-20 inline-flex min-w-[104px] items-center justify-between gap-2 rounded-full border border-slate-300 bg-white/95 px-3 py-2.5 text-sm font-semibold text-slate-700 shadow-lg ring-1 ring-white/70 backdrop-blur transition hover:bg-slate-50 ${
            isCollapsed ? "left-full translate-x-1" : "right-0 translate-x-1/2"
          }`}
          aria-label={isCollapsed ? "Expandir menú" : "Colapsar menú"}
          title={isCollapsed ? "Expandir menú" : "Colapsar menú"}
        >
          <span
            className={`whitespace-nowrap text-[10px] font-semibold tracking-[0.12em] text-slate-600 ${
              isCollapsed ? "px-1" : ""
            }`}
          >
            PANEL
          </span>
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-slate-900 text-white">
            {isCollapsed ? (
              <FaChevronRight className="h-4.5 w-4.5" />
            ) : (
              <FaChevronLeft className="h-4.5 w-4.5" />
            )}
          </span>
        </button>

        {!isCollapsed && (
          <>
            <nav className="space-y-2 pt-14">
              {/* ================== ADMIN ================== */}
              {isAdmin && (
                <>
                  {/* -------- Operaciones Pollo -------- */}
                  <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-amber-400">
                    <SectionBtn
                      open={openPollo}
                      onClick={() => toggleModule("pollo")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-white">
                          <FaDrumstickBite className="h-3.5 w-3.5" />
                        </span>
                        <span>Pollos Bea</span>
                      </span>
                    </SectionBtn>

                    {openPollo && (
                      <div className="pb-2">
                        <SubSectionBtn
                          open={openPolloOperaciones}
                          onClick={() => setOpenPolloOperaciones((v) => !v)}
                          title="Operaciones"
                        />
                        {openPolloOperaciones && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink to={`${base}/salesV2`} className={linkCls}>
                              Vender
                            </NavLink>
                            <NavLink
                              to={`${base}/customersPollo`}
                              className={linkCls}
                            >
                              Saldo Pendientes
                            </NavLink>
                            <NavLink
                              to={`${base}/transactionsPollo`}
                              className={linkCls}
                            >
                              Transacciones
                            </NavLink>
                            <NavLink to={`${base}/bills`} className={linkCls}>
                              Cierre Ventas
                            </NavLink>
                            <NavLink
                              to={`${base}/statusAccount`}
                              className={linkCls}
                            >
                              Estado de Cuenta
                            </NavLink>
                            <NavLink
                              to={`${base}/statusInventory`}
                              className={linkCls}
                            >
                              Evolutivo Libras
                            </NavLink>
                          </div>
                        )}

                        {/* Inventario (Pollo) */}
                        <SubSectionBtn
                          open={openPolloInv}
                          onClick={() => setOpenPolloInv((v) => !v)}
                          title="Inventarios"
                        />
                        {openPolloInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink to={`${base}/batches`} className={linkCls}>
                              Inventario Pollo
                            </NavLink>
                            <NavLink
                              to={`${base}/paidBatches`}
                              className={linkCls}
                            >
                              Inventarios Pagados
                            </NavLink>
                            <NavLink to={`${base}/billing`} className={linkCls}>
                              Facturacion
                            </NavLink>
                          </div>
                        )}

                        {/* Finanzas (Pollo) */}
                        <SubSectionBtn
                          open={openPolloFin}
                          onClick={() => setOpenPolloFin((v) => !v)}
                          title="Finanzas"
                        />
                        {openPolloFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/financialDashboard`}
                              className={linkCls}
                            >
                              Dashboard
                            </NavLink>
                            <NavLink to={`${base}/billing`} className={linkCls}>
                              Facturacion
                            </NavLink>
                            <NavLink
                              to={`${base}/expenses`}
                              className={linkCls}
                            >
                              Gastos
                            </NavLink>
                            <NavLink
                              to={`${base}/polloCashAudits`}
                              className={linkCls}
                            >
                              Arqueos Caja
                            </NavLink>
                            <NavLink to={`${base}/salesV2`} className={linkCls}>
                              Venta
                            </NavLink>
                            <NavLink to={`${base}/bills`} className={linkCls}>
                              Cierre Ventas
                            </NavLink>
                            <NavLink
                              to={`${base}/billhistoric`}
                              className={linkCls}
                            >
                              Historial de Cierres
                            </NavLink>
                          </div>
                        )}

                        {/* Productos (Pollo) */}
                        <SubSectionBtn
                          open={openPolloProd}
                          onClick={() => setOpenPolloProd((v) => !v)}
                          title="Productos"
                        />
                        {openPolloProd && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/products`}
                              className={linkCls}
                            >
                              Productos
                            </NavLink>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* -------- Operaciones Ropa -------- */}
                  <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-indigo-400">
                    <SectionBtn
                      open={openRopa}
                      onClick={() => toggleModule("ropa")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-white">
                          <FaBook className="h-3.5 w-3.5" />
                        </span>
                        <span>Gonper</span>
                      </span>
                    </SectionBtn>

                    {openRopa && (
                      <div className="pb-2">
                        <SubSectionBtn
                          open={openRopaInv}
                          onClick={() => setOpenRopaInv((v) => !v)}
                          title="Inventarios"
                        />
                        {openRopaInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/notebooksInventory`}
                              className={linkCls}
                            >
                              Productos y Precios
                            </NavLink>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* -------- Operaciones Dulces -------- */}
                  <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-pink-400">
                    <SectionBtn
                      open={openDulces}
                      onClick={() => toggleModule("dulces")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-pink-500 text-white">
                          <FaCandyCane className="h-3.5 w-3.5" />
                        </span>
                        <span>CandyShop</span>
                      </span>
                    </SectionBtn>

                    {openDulces && (
                      <div className="pb-2">
                        <SubSectionBtn
                          open={openDulcesVendors}
                          onClick={() => setOpenDulcesVendors((v) => !v)}
                          title="Vendedores"
                        />
                        {openDulcesVendors && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/salesCandies`}
                              className={linkCls}
                            >
                              Venta
                            </NavLink>
                          </div>
                        )}
                        {openDulcesVendors && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/productsVendorsCandies`}
                              className={linkCls}
                            >
                              Sub ordenes
                            </NavLink>
                          </div>
                        )}
                        {openDulcesVendors && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/productsPricesCandies`}
                              className={linkCls}
                            >
                              Precios Venta
                            </NavLink>
                          </div>
                        )}

                        <SubSectionBtn
                          open={openDulcesInv}
                          onClick={() => setOpenDulcesInv((v) => !v)}
                          title="Inventario"
                        />
                        {openDulcesInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/mainordersCandies`}
                              className={linkCls}
                            >
                              Ordenes Maestras
                            </NavLink>
                          </div>
                        )}
                        {openDulcesInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/inventoryMainOrderCandies`}
                              className={linkCls}
                            >
                              Lista de Ordenes
                            </NavLink>
                          </div>
                        )}
                        {openDulcesInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/inventoryCandies`}
                              className={linkCls}
                            >
                              Lista Productos
                            </NavLink>
                          </div>
                        )}
                        {openDulcesInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/productsCandies`}
                              className={linkCls}
                            >
                              Productos
                            </NavLink>
                          </div>
                        )}

                        <SubSectionBtn
                          open={openDulcesFin}
                          onClick={() => setOpenDulcesFin((v) => !v)}
                          title="Finanzas"
                        />
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/datacenter`}
                              className={linkCls}
                            >
                              Data Center
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/cashDeliveries`}
                              className={linkCls}
                            >
                              Entregas Cash
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/transactionCandies`}
                              className={linkCls}
                            >
                              Transacciones
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/cierreVentasCandies`}
                              className={linkCls}
                            >
                              Cierres
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/reporteCierresCandies`}
                              className={linkCls}
                            >
                              Reporte Cierres
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/billingsCandies`}
                              className={linkCls}
                            >
                              Facturas
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/consolidatedVendors`}
                              className={linkCls}
                            >
                              Consolidado Vendedores
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/dashboardCandies`}
                              className={linkCls}
                            >
                              Dashboard
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/customersCandies`}
                              className={linkCls}
                            >
                              Clientes
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/estadoCuentaCandies`}
                              className={linkCls}
                            >
                              Estado de Cuenta
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/vendorsCandies`}
                              className={linkCls}
                            >
                              Vendedores
                            </NavLink>
                          </div>
                        )}
                        {openDulcesFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/expensesCandies`}
                              className={linkCls}
                            >
                              Gastos
                            </NavLink>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* -------- Operaciones Otras -------- */}
                  <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-slate-400">
                    <SectionBtn
                      open={openOtras}
                      onClick={() => toggleModule("otras")}
                    >
                      <span className="flex items-center gap-2">
                        <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-slate-500 text-white">
                          <FaTools className="h-3.5 w-3.5" />
                        </span>
                        <span>Operaciones</span>
                      </span>
                    </SectionBtn>

                    {openOtras && (
                      <div className="pb-2 ml-4 mt-1 space-y-1">
                        <NavLink to={`${base}/users`} className={linkCls}>
                          Usuarios
                        </NavLink>
                        <NavLink to={`${base}/fix`} className={linkCls}>
                          Fix de lotes
                        </NavLink>
                        <NavLink
                          to={`${base}/transactionclose`}
                          className={linkCls}
                        >
                          Liquidaciones
                        </NavLink>
                      </div>
                    )}
                  </div>
                </>
              )}

              {/* ================== POLLO (supervisor/contador/vendedor o multi-rol) ================== */}
              {!isAdmin && hasPolloAccess && (
                <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-amber-400">
                  <SectionBtn
                    open={openPollo}
                    onClick={() => toggleModule("pollo")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-amber-500 text-white">
                        <FaDrumstickBite className="h-3.5 w-3.5" />
                      </span>
                      <span>Pollos Bea</span>
                    </span>
                  </SectionBtn>

                  {openPollo && (
                    <div className="pb-2 ml-4 mt-1 space-y-1">
                      {canPath(subject, "salesV2") && (
                        <NavLink to={`${base}/salesV2`} className={linkCls}>
                          Vender
                        </NavLink>
                      )}
                      {canPath(subject, "financialDashboard") && (
                        <NavLink
                          to={`${base}/financialDashboard`}
                          className={linkCls}
                        >
                          Dashboard
                        </NavLink>
                      )}
                      {canPath(subject, "batches") && (
                        <NavLink to={`${base}/batches`} className={linkCls}>
                          Inventario Pollo
                        </NavLink>
                      )}

                      {canPath(subject, "bills") && (
                        <NavLink to={`${base}/bills`} className={linkCls}>
                          Cierre Ventas
                        </NavLink>
                      )}
                      {canPath(subject, "transactionsPollo") && (
                        <NavLink
                          to={`${base}/transactionsPollo`}
                          className={linkCls}
                        >
                          Transacciones
                        </NavLink>
                      )}

                      {openPollo && (
                        <div className="pb-2">
                          <SubSectionBtn
                            open={contadorMenuFinanzas}
                            onClick={() => setContadorMenuFinanzas((v) => !v)}
                            title="Contabilidad"
                          />

                          {contadorMenuFinanzas && (
                            <div className="ml-4 mt-1 space-y-1">
                              {canPath(subject, "billing") && (
                                <NavLink
                                  to={`${base}/billing`}
                                  className={linkCls}
                                >
                                  Facturacion
                                </NavLink>
                              )}

                              {canPath(subject, "customersPollo") && (
                                <NavLink
                                  to={`${base}/customersPollo`}
                                  className={linkCls}
                                >
                                  Saldos Pendientes
                                </NavLink>
                              )}

                              {canPath(subject, "statusAccount") && (
                                <NavLink
                                  to={`${base}/statusAccount`}
                                  className={linkCls}
                                >
                                  Estado de Cuenta
                                </NavLink>
                              )}
                              {canPath(subject, "statusInventory") && (
                                <NavLink
                                  to={`${base}/statusInventory`}
                                  className={linkCls}
                                >
                                  Evolutivo de Libras
                                </NavLink>
                              )}
                              {canPath(subject, "expenses") && (
                                <NavLink
                                  to={`${base}/expenses`}
                                  className={linkCls}
                                >
                                  Gastos
                                </NavLink>
                              )}
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ================== DULCES (vendedor_dulces o multi-rol) ================== */}
              {!isAdmin && hasDulcesAccess && (
                <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-pink-400">
                  <SectionBtn
                    open={openDulces}
                    onClick={() => toggleModule("dulces")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-pink-500 text-white">
                        <FaCandyCane className="h-3.5 w-3.5" />
                      </span>
                      <span>CandyShop</span>
                    </span>
                  </SectionBtn>

                  {openDulces && (
                    <>
                      <div className="pb-2 ml-4 mt-1 space-y-1">
                        {canPath(subject, "salesCandies") && (
                          <NavLink
                            to={`${base}/salesCandies`}
                            className={linkCls}
                          >
                            Venta
                          </NavLink>
                        )}
                      </div>

                      <div className="pb-2 ml-4 mt-1 space-y-1">
                        {canPath(subject, "transactionCandies") && (
                          <NavLink
                            to={`${base}/transactionCandies`}
                            className={linkCls}
                          >
                            Ventas del dia
                          </NavLink>
                        )}
                      </div>

                      <div className="pb-2 ml-4 mt-1 space-y-1">
                        {canPath(subject, "cierreVentasCandies") && (
                          <NavLink
                            to={`${base}/cierreVentasCandies`}
                            className={linkCls}
                          >
                            Cierre de Ventas
                          </NavLink>
                        )}
                      </div>

                      <div className="ml-4 mt-1 space-y-1">
                        {canPath(subject, "productsVendorsCandies") && (
                          <NavLink
                            to={`${base}/productsVendorsCandies`}
                            className={linkCls}
                          >
                            Pedidos
                          </NavLink>
                        )}
                      </div>

                      <div className="ml-4 mt-1 space-y-1">
                        {canPath(subject, "customersCandies") && (
                          <NavLink
                            to={`${base}/customersCandies`}
                            className={linkCls}
                          >
                            Clientes
                          </NavLink>
                        )}
                      </div>

                      {/* <div className="ml-4 mt-1 space-y-1">
                        {canPath(subject, "estadoCuentaCandies") && (
                          <NavLink
                            to={`${base}/estadoCuentaCandies`}
                            className={linkCls}
                          >
                            Estado de Cuenta
                          </NavLink>
                        )}
                      </div> */}

                      <div className="ml-4 mt-1 space-y-1">
                        {canPath(subject, "productsPricesCandies") && (
                          <NavLink
                            to={`${base}/productsPricesCandies`}
                            className={linkCls}
                          >
                            Precios Venta
                          </NavLink>
                        )}
                      </div>
                    </>
                  )}
                </div>
              )}

              {/* ================== VENDEDOR ROPA ================== */}
              {isVendRopa && (
                <div className="border rounded-xl mb-2 shadow-sm bg-white border-l-4 border-indigo-400">
                  <SectionBtn
                    open={openRopa}
                    onClick={() => toggleModule("ropa")}
                  >
                    <span className="flex items-center gap-2">
                      <span className="inline-flex h-5 w-5 items-center justify-center rounded-full bg-indigo-500 text-white">
                        <FaBook className="h-3.5 w-3.5" />
                      </span>
                      <span>Operaciones Ropa</span>
                    </span>
                  </SectionBtn>

                  {openRopa && (
                    <div className="pb-2">
                      <SubSectionBtn
                        open={openRopaFin}
                        onClick={() => setOpenRopaFin((v) => !v)}
                        title="Ventas"
                      />
                      {openRopaFin && (
                        <div className="ml-4 mt-1 space-y-1">
                          <NavLink
                            to={`${base}/salesClothes`}
                            className={linkCls}
                          >
                            Venta Ropa
                          </NavLink>
                          <NavLink
                            to={`${base}/TransactionsReportClothes`}
                            className={linkCls}
                          >
                            Transacciones
                          </NavLink>
                        </div>
                      )}

                      <SubSectionBtn
                        open={openRopaProd}
                        onClick={() => setOpenRopaProd((v) => !v)}
                        title="Productos"
                      />
                      {openRopaProd && (
                        <div className="ml-4 mt-1 space-y-1">
                          <NavLink
                            to={`${base}/productsClothes`}
                            className={linkCls}
                          >
                            Agregar Productos
                          </NavLink>
                        </div>
                      )}

                      <SubSectionBtn
                        open={openClients}
                        onClick={() => setOpenClients((v) => !v)}
                        title="Clientes"
                      />
                      {openClients && (
                        <div className="ml-4 mt-1 space-y-1">
                          <NavLink
                            to={`${base}/CustomersClothes`}
                            className={linkCls}
                          >
                            Listado de Clientes
                          </NavLink>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </nav>

            <div className="mt-3 rounded-2xl border border-slate-200 bg-white/90 p-3 shadow-sm">
              <div className="text-xs uppercase tracking-wide text-slate-500">
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

            <button
              onClick={handleLogout}
              className="mt-3 w-full inline-flex items-center justify-center gap-2 bg-red-500 text-white px-3 py-2 rounded-2xl shadow-2xl hover:bg-red-600"
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
                      className="px-3 py-2 rounded bg-red-500 text-white"
                    >
                      SI
                    </button>
                  </div>
                </div>
              </div>
            )}
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
