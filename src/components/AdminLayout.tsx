// src/components/AdminLayout.tsx
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useState } from "react";
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
    `block rounded px-3 py-2 text-sm ${
      isActive ? "bg-blue-600 text-white" : "text-gray-700 hover:bg-gray-100"
    }`;

  // Sidebar ancho/colapsado
  const navigate = useNavigate();
  const [isCollapsed, setIsCollapsed] = useState(false);

  // ====== estados de menús colapsables ======
  // Operaciones Pollo
  const [openPollo, setOpenPollo] = useState(false);
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
      className="w-full flex items-center justify-between px-3 py-2 text-left text-sm font-semibold rounded hover:bg-gray-100"
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
      className="ml-2 w-[calc(100%-0.5rem)] flex items-center justify-between px-3 py-2 text-left text-sm rounded hover:bg-gray-100"
    >
      <span className="text-blue-500 font-medium ">{title}</span>
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
    canPath(subject, "batches", "view");

  const hasDulcesAccess =
    canPath(subject, "salesCandies", "view") ||
    canPath(subject, "productsVendorsCandies", "view") ||
    canPath(subject, "customersCandies", "view") ||
    canPath(subject, "productsPricesCandies", "view") ||
    canPath(subject, "transactionCandies", "view") ||
    canPath(subject, "cierreVentasCandies", "view");

  return (
    <div className="min-h-screen flex">
      <aside
        className={`${
          isCollapsed
            ? "w-15 bg-gray-50 border-r p-3 transition-all duration-300 flex flex-col items-center"
            : "w-55"
        } bg-[#f1f3f7] border-r p-3 transition-all duration-300 flex flex-col`}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="mb-2 p-2 rounded-2xl shadow-2xl bg-gray-300 hover:bg-gray-400"
          aria-label={isCollapsed ? "Expandir menú" : "Colapsar menú"}
        >
          {isCollapsed ? (
            <span title="Expandir menú">Menu ▶</span>
          ) : (
            <span title="Colapsar menú">Cerrar ◀</span>
          )}
        </button>

        {!isCollapsed && (
          <>
            <nav className="space-y-1">
              {/* ================== ADMIN ================== */}
              {isAdmin && (
                <>
                  {/* -------- Operaciones Pollo -------- */}
                  <div className="border rounded mb-1 rounded-2xl shadow-2xl bg-white">
                    <SectionBtn
                      open={openPollo}
                      onClick={() => setOpenPollo((v) => !v)}
                    >
                      Pollos Bea
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
                  <div className="border rounded mb-1 rounded-2xl shadow-2xl bg-white">
                    <SectionBtn
                      open={openRopa}
                      onClick={() => setOpenRopa((v) => !v)}
                    >
                      Gonper
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
                  <div className="border rounded mb-1 rounded-2xl shadow-2xl bg-white">
                    <SectionBtn
                      open={openDulces}
                      onClick={() => setOpenDulces((v) => !v)}
                    >
                      CandyShop
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
                  <div className="border rounded mb-1 rounded-2xl shadow-2xl bg-white">
                    <SectionBtn
                      open={openOtras}
                      onClick={() => setOpenOtras((v) => !v)}
                    >
                      Operaciones Otras
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
                <div className="border rounded mb-1 rounded-2xl shadow-2xl bg-white">
                  <SectionBtn
                    open={openPollo}
                    onClick={() => setOpenPollo((v) => !v)}
                  >
                    Pollos Bea
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
                      {canPath(subject, "expenses") && (
                        <NavLink to={`${base}/expenses`} className={linkCls}>
                          Gastos
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
                    </div>
                  )}
                </div>
              )}

              {/* ================== DULCES (vendedor_dulces o multi-rol) ================== */}
              {!isAdmin && hasDulcesAccess && (
                <div className="border rounded">
                  <div className="pb-2 ml-4 mt-1 space-y-1">
                    {canPath(subject, "salesCandies") && (
                      <NavLink to={`${base}/salesCandies`} className={linkCls}>
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
                </div>
              )}

              {/* ================== VENDEDOR ROPA ================== */}
              {isVendRopa && (
                <div className="border rounded">
                  <SectionBtn
                    open={openRopa}
                    onClick={() => setOpenRopa((v) => !v)}
                  >
                    Operaciones Ropa
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

            <button
              onClick={handleLogout}
              className="mt-4 bg-red-500 text-white px-3 py-2 rounded-2xl shadow-2xl hover:bg-red-600"
            >
              Cerrar sesión
            </button>

            <div className="mt-2 text-[20px] text-gray-700">
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
