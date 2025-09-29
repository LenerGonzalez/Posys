// src/components/AdminLayout.tsx
import { NavLink, Outlet } from "react-router-dom";
import { signOut } from "firebase/auth";
import { auth } from "../firebase";
import { useNavigate } from "react-router-dom";
import { useState } from "react";

export default function AdminLayout({ role }: { role: string }) {
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

  // Operaciones Ropa
  const [openRopa, setOpenRopa] = useState(false);
  const [openRopaInv, setOpenRopaInv] = useState(false);
  const [openRopaProd, setOpenRopaProd] = useState(false);
  const [openClients, setOpenClients] = useState(false);
  const [openRopaFin, setOpenRopaFin] = useState(false);
  const [openDashboardClothes, setOpenDashboardClothes] = useState(false);

  // Operaciones Otras
  const [openOtras, setOpenOtras] = useState(false);

  const handleLogout = async () => {
    await signOut(auth);
    navigate("/");
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
  const isAdmin = role === "admin";
  const isVendPollo = role === "vendedor_pollo" || role === "vendedor"; // compat: "vendedor" → pollo
  const isVendRopa = role === "vendedor_ropa";

  return (
    <div className="min-h-screen flex">
      <aside
        className={`${
          isCollapsed
            ? "w-15 bg-gray-50 border-r p-3 transition-all duration-300 flex flex-col items-center"
            : "w-55"
        } bg-gray-50 border-r p-3 transition-all duration-300 flex flex-col`}
      >
        <button
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="mb-2 p-2 rounded bg-gray-200 hover:bg-gray-300"
          aria-label={isCollapsed ? "Expandir menú" : "Colapsar menú"}
        >
          {isCollapsed ? (
            <span title="Expandir menú">▶</span>
          ) : (
            <span title="Colapsar menú">◀</span>
          )}
        </button>

        {!isCollapsed && (
          <>
            <nav className="space-y-1">
              {/* ================== ADMIN ================== */}
              {isAdmin && (
                <>
                  {/* -------- Operaciones Pollo -------- */}
                  <div className="border rounded mb-1">
                    <SectionBtn
                      open={openPollo}
                      onClick={() => setOpenPollo((v) => !v)}
                    >
                      Operaciones Pollo
                    </SectionBtn>

                    {openPollo && (
                      <div className="pb-2">
                        {/* Inventario (Pollo) */}
                        <SubSectionBtn
                          open={openPolloInv}
                          onClick={() => setOpenPolloInv((v) => !v)}
                          title="Inventario"
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
                              Cierre
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
                  <div className="border rounded mb-1">
                    <SectionBtn
                      open={openRopa}
                      onClick={() => setOpenRopa((v) => !v)}
                    >
                      Operaciones Ropa
                    </SectionBtn>

                    {openRopa && (
                      <div className="pb-2">
                        {/* Inventario (Ropa) */}
                        <SubSectionBtn
                          open={openRopaInv}
                          onClick={() => setOpenRopaInv((v) => !v)}
                          title="Inventario"
                        />
                        {openRopaInv && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/InventoryClothesBatches`}
                              className={linkCls}
                            >
                              Inventario Ropa
                            </NavLink>
                          </div>
                        )}
                        {/* Productos (Ropa) */}
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
                        {/* Clientes (Ropa) */}
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
                        {/* Finanzas (Ropa) */}
                        <SubSectionBtn
                          open={openRopaFin}
                          onClick={() => setOpenRopaFin((v) => !v)}
                          title="Finanzas"
                        />
                        {openRopaFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/salesClothes`}
                              className={linkCls}
                            >
                              Venta Ropa
                            </NavLink>
                          </div>
                        )}
                        {openRopaFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/financialDashboardClothes`}
                              className={linkCls}
                            >
                              Dashboard Financiero
                            </NavLink>
                          </div>
                        )}
                        {openRopaFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/TransactionsReportClothes`}
                              className={linkCls}
                            >
                              Transacciones
                            </NavLink>
                          </div>
                        )}

                        {openRopaFin && (
                          <div className="ml-4 mt-1 space-y-1">
                            <NavLink
                              to={`${base}/ExpensesClothes`}
                              className={linkCls}
                            >
                              Gastos Ropa
                            </NavLink>
                          </div>
                        )}
                      </div>
                    )}
                  </div>

                  {/* -------- Operaciones Otras -------- */}
                  <div className="border rounded">
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

              {/* ================== VENDEDOR POLLO ================== */}
              {isVendPollo && (
                <div className="border rounded">
                  <SectionBtn
                    open={openPolloFin}
                    onClick={() => setOpenPolloFin((v) => !v)}
                  >
                    Finanzas (Pollo)
                  </SectionBtn>
                  {openPolloFin && (
                    <div className="pb-2 ml-4 mt-1 space-y-1">
                      <NavLink to={`${base}/salesV2`} className={linkCls}>
                        Venta
                      </NavLink>
                      <NavLink to={`${base}/bills`} className={linkCls}>
                        Cierre
                      </NavLink>
                    </div>
                  )}
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
                      {/* Venta (Ropa) */}
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

                      {/* Productos (Ropa) */}
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

                      {/* Clientes (Ropa) */}
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
              className="mt-4 bg-red-500 text-white px-3 py-2 rounded hover:bg-red-600"
            >
              Cerrar sesión
            </button>
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
