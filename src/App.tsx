// src/App.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { useRegisterSW } from "virtual:pwa-register/react";
import { hasRole } from "./utils/roles";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { auth, db } from "./firebase";
import { doc, getDoc } from "firebase/firestore";

// Auth / layout
import Login from "./components/Login";
import PrivateRoute from "./PrivateRoute";
import AdminLayout from "./components/AdminLayout";
import MobileTabsLayout from "./components/MobileTabsLayout";

// Módulos POLLO
import CierreVentas from "../src/components/Pollo/CierreVentas";
import HistorialCierres from "../src/components/Pollo/HistorialCierres";
import UserRegisterForm from "./components/UserRegisterForm";
import ProductForm from "../src/components/Pollo/ProductForm";
import SaleFormV2 from "../src/components/Pollo/SaleFormV2";
import InventoryBatches from "./components/Pollo/InventoryBatches";
import Liquidaciones from "../src/components/Pollo/Liquidaciones";
import FinancialDashboard from "../src/components/Pollo/FinancialDashboard";
import ExpensesAdmin from "./components/Pollo/ExpensesAdmin";
import FixBatchesPages from "../src/components/Pollo/FixBatchesPages";
import TransactionsPollo from "./components/Pollo/TransactionsPollo";
import PaidBatches from "../src/components/Pollo/PaidBatches";
import PolloCashAudits from "./components/Pollo/PolloCashAudits";
import Billing from "./components/Pollo/Billing";
import StatusAccount from "./components/Pollo/StatusAccount";
import StatusInventory from "./components/Pollo/StatusInventory";

// Módulos ROPA
import InventoryClothesBatches from "./components/Clothes/InventoryClothesBatches";
import ProductsClothes from "./components/Clothes/ClothesProducts";
import CustomersClothes from "./components/Clothes/CustomersClothes";
import SalesClothesPOS from "./components/Clothes/SalesClothesPOS";
import FinancialDashboardClothes from "./components//Clothes/FinancialDashboardClothes";
import ExpensesClothes from "./components//Clothes/ExpensesClothes";
import TransactionsReportClothes from "./components/Clothes/TransactionsReportClothes";
import CustomersPollo from "./components/Pollo/CustomersPollo";

// Módulos DULCES
import CandiesProducts from "./components/Candies/CatalogoProductos";
import InventoryCandies from "./components/Candies/InventarioProductos";
import CustomersCandies from "./components/Candies/CustomersCandies";
import SalesCandies from "./components/Candies/SalesCandies";
import ExpensesCandies from "./components/Candies/ExpensesCandies";
import TransactionCandies from "./components/Candies/TransactionCandies";
import DashboardCandies from "./components/Candies/DashboardCandies";
import Vendors from "./components/Candies/SubInventarios/Vendedores";
import OrdenVendedor from "./components/Candies/SubInventarios/OrdenVendedor";
import ProductMainOrder from "./components/Candies/OrdenMaestra";
import InventoryMainOrders from "./components/Candies/InventarioOrdenesMaestras";
import CierreVentasDulces from "./components/Candies/CierreVentasDulces";
import ConsolidadoVendedores from "./components/Candies/ConsolidadoVendedores";
import BillingCandies from "./components/Candies/BillingCandies";
import ReporteCierres from "./components/Candies/ReporteCierres";
import DataCenterCandies from "./components/Candies/DataCenter";
import EntregasCash from "./components/Candies/EntregasCash";
import PreciosVenta from "./components/Candies/PreciosVenta";
import EstadoCuentaCandies from "./components/Candies/EstadoCuentaCandies";

import GonperProductosPrices from "./components/Clothes/GonperProductosPrices";
import ArqueoProducto from "./components/Pollo/ArqueoProducto";

// Definición de roles
type Role =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  return isMobile;
}

function PwaUpdatePrompt(): React.ReactElement | null {
  const {
    offlineReady: [offlineReady, setOfflineReady],
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(_swUrl, registration) {
      registration?.update();
    },
    onRegisterError(error) {
      console.error("Error registrando service worker:", error);
    },
  });

  useEffect(() => {
    if (!("serviceWorker" in navigator)) return;

    const checkForUpdates = async () => {
      try {
        const registration = await navigator.serviceWorker.getRegistration();
        await registration?.update();
      } catch (error) {
        console.warn("No se pudo buscar una nueva version de la app:", error);
      }
    };

    checkForUpdates();
    const intervalId = window.setInterval(checkForUpdates, 60_000);

    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    if (!offlineReady) return;
    const timeoutId = window.setTimeout(() => setOfflineReady(false), 4000);
    return () => window.clearTimeout(timeoutId);
  }, [offlineReady, setOfflineReady]);

  if (!offlineReady && !needRefresh) return null;

  if (needRefresh) {
    return (
      <div className="fixed inset-0 z-[400] flex items-center justify-center bg-slate-950/75 px-4 backdrop-blur-sm">
        <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-sky-100 bg-white shadow-2xl">
          <div className="bg-gradient-to-r from-sky-50 via-white to-blue-50 px-4 py-3">
            <div className="flex items-center gap-3">
              <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-lg font-bold text-white">
                P
              </div>
              <div>
                <div className="text-sm font-semibold text-slate-900">
                  Posys
                </div>
                <div className="text-xs text-slate-500">
                  Actualizacion disponible
                </div>
              </div>
            </div>
          </div>

          <div className="p-4">
            <div className="text-sm leading-6 text-slate-700">
              Hola, hay una nueva actualizacion, por favor presiona
              Actualizar para disfrutar de una nueva y mejorada experiencia.
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                onClick={() => updateServiceWorker(true)}
                className="rounded-xl bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700"
              >
                Actualizar
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-x-0 bottom-4 z-[250] flex justify-center px-4">
      <div className="w-full max-w-lg overflow-hidden rounded-3xl border border-sky-100 bg-white shadow-2xl">
        <div className="bg-gradient-to-r from-sky-50 via-white to-blue-50 px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-600 text-lg font-bold text-white">
              P
            </div>
            <div>
              <div className="text-sm font-semibold text-slate-900">Posys</div>
              <div className="text-xs text-slate-500">
                {needRefresh
                  ? "Actualizacion disponible"
                  : "Modo offline activado"}
              </div>
            </div>
          </div>
        </div>

        <div className="p-4">
          <div className="text-sm leading-6 text-slate-700">
            La app ya puede funcionar offline y seguira usando el tema claro
            original.
          </div>

          <div className="mt-3 flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setOfflineReady(false)}
              className="rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-700 hover:bg-slate-50"
            >
              Cerrar
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<Role>("");
  const [roles, setRoles] = useState<Role[] | string[]>([]);
  const [sellerCandyId, setSellerCandyId] = useState<string>("");
  const [loading, setLoading] = useState(true);

  const isMobile = useIsMobile();

  // ✅ IMPORTANTE: esto debe estar ANTES del "if (loading) return ..."
  const Layout = useMemo(() => {
    return isMobile ? (
      <MobileTabsLayout role={role} roles={roles} />
    ) : (
      <AdminLayout role={role} roles={roles} />
    );
  }, [isMobile, role, roles]);

  const currentUserEmail = user?.email || "";

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);

      // Nota: eliminada la expiración automática de 15 días.
      // La sesión se mantendrá hasta que el usuario cierre sesión manualmente.

      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const docRef = doc(db, "users", firebaseUser.uid);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const data = snap.data() as any;
            const rlist: Role[] = Array.isArray(data.roles)
              ? data.roles
              : data.role
                ? [data.role]
                : [];
            const scId = (data.sellerCandyId || "") as string;
            setRoles(rlist);
            setRole(rlist[0] || "");
            setSellerCandyId(scId || "");
          } else {
            setRole("");
            setRoles([]);
            setSellerCandyId("");
          }
        } catch {
          setRole("");
          setSellerCandyId("");
        }
      } else {
        setUser(null);
        setRole("");
        setSellerCandyId("");
      }

      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  if (loading)
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
        <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900/90 px-6 py-5 text-white shadow-2xl">
          <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/40 border-t-white" />
          <div className="text-sm font-semibold tracking-wide">Cargando datos de usuario</div>
        </div>
      </div>
    );

  // Redirección por defecto dentro de /admin según rol
  const AdminIndexRedirect = () => {
    const subject = roles && roles.length ? roles : role;
    if (hasRole(subject, "admin"))
      return <Navigate to="financialDashboard" replace />;
    if (hasRole(subject, "vendedor_pollo"))
      return <Navigate to="salesV2" replace />;
    if (hasRole(subject, "supervisor_pollo"))
      return <Navigate to="batches" replace />;
    if (hasRole(subject, "contador")) return <Navigate to="batches" replace />;
    if (hasRole(subject, "vendedor_ropa"))
      return <Navigate to="salesClothes" replace />;

    if (hasRole(subject, "vendedor_dulces"))
      return <Navigate to="salesCandies" replace />;
    return <Navigate to="/" replace />;
  };

  return (
    <Router>
      <PwaUpdatePrompt />
      <Routes>
        <Route path="/" element={<Login />} />

        <Route
          path="/admin"
          element={
            <PrivateRoute
              allowedRoles={[
                "admin",
                "vendedor_pollo",
                "vendedor_ropa",
                "vendedor_dulces",
                "supervisor_pollo",
                "contador",
              ]}
            >
              {Layout}
            </PrivateRoute>
          }
        >
          <Route index element={<AdminIndexRedirect />} />

          {/* ======== POLLO ======== */}
          <Route
            path="bills"
            element={
              <PrivateRoute
                allowedRoles={[
                  "admin",
                  "vendedor_pollo",
                  "supervisor_pollo",
                  "contador",
                ]}
              >
                <CierreVentas role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="salesV2"
            element={
              <PrivateRoute
                allowedRoles={[
                  "admin",
                  "vendedor_pollo",
                  "supervisor_pollo",
                  "contador",
                ]}
              >
                <SaleFormV2 user={user} />
              </PrivateRoute>
            }
          />
          <Route
            path="financialDashboard"
            element={
              <PrivateRoute
                allowedRoles={["admin", "contador", "supervisor_pollo"]}
              >
                <FinancialDashboard />
              </PrivateRoute>
            }
          />
          <Route
            path="expenses"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <ExpensesAdmin />
              </PrivateRoute>
            }
          />
          <Route
            path="polloCashAudits"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <PolloCashAudits />
              </PrivateRoute>
            }
          />
          <Route
            path="statusAccount"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <StatusAccount role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="auditProductsPollo"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <ArqueoProducto role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="statusInventory"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <StatusInventory role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="transactionsPollo"
            element={
              <PrivateRoute
                allowedRoles={[
                  "admin",
                  "vendedor_pollo",
                  "supervisor_pollo",
                  "contador",
                ]}
              >
                <TransactionsPollo role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="batches"
            element={
              <PrivateRoute
                allowedRoles={[
                  "admin",
                  "vendedor_pollo",
                  "supervisor_pollo",
                  "contador",
                ]}
              >
                <InventoryBatches role={role} roles={roles} />
              </PrivateRoute>
            }
          />
          <Route
            path="paidBatches"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <PaidBatches />
              </PrivateRoute>
            }
          />
          <Route
            path="fix"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <FixBatchesPages />
              </PrivateRoute>
            }
          />
          <Route
            path="billing"
            element={
              <PrivateRoute allowedRoles={["admin", "contador"]}>
                <Billing />
              </PrivateRoute>
            }
          />
          <Route
            path="transactionclose"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <Liquidaciones />
              </PrivateRoute>
            }
          />
          <Route
            path="billhistoric"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <HistorialCierres />
              </PrivateRoute>
            }
          />
          <Route
            path="users"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <UserRegisterForm />
              </PrivateRoute>
            }
          />
          <Route
            path="products"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ProductForm />
              </PrivateRoute>
            }
          />

          <Route
            path="customersPollo"
            element={
              <PrivateRoute
                allowedRoles={[
                  "admin",
                  "vendedor_pollo",
                  "supervisor_pollo",
                  "contador",
                ]}
              >
                <CustomersPollo
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerPolloId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />

          {/* ======== CANDIES ======== */}
          <Route
            path="datacenter"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <DataCenterCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="productsCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <CandiesProducts />
              </PrivateRoute>
            }
          />
          <Route
            path="mainordersCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <ProductMainOrder />
              </PrivateRoute>
            }
          />
          <Route
            path="productsPricesCandies"
            element={
              <PrivateRoute
                roles={roles}
                allowedRoles={["admin", "vendedor_dulces"]}
              >
                <PreciosVenta />
              </PrivateRoute>
            }
          />
          <Route
            path="inventoryMainOrderCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <InventoryMainOrders />
              </PrivateRoute>
            }
          />
          <Route
            path="inventoryCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <InventoryCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="billingsCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <BillingCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="estadoCuentaCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <EstadoCuentaCandies
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="cashDeliveries"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <EntregasCash />
              </PrivateRoute>
            }
          />
          <Route
            path="customersCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <CustomersCandies
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="salesCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <SalesCandies
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="expensesCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <ExpensesCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="dashboardCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <DashboardCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="transactionCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <TransactionCandies
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="vendorsCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <Vendors />
              </PrivateRoute>
            }
          />
          <Route
            path="productsVendorsCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <OrdenVendedor
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="cierreVentasCandies"
            element={
              <PrivateRoute
                allowedRoles={["admin", "vendedor_dulces", "contador"]}
              >
                <CierreVentasDulces
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="reporteCierresCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <ReporteCierres
                  role={role}
                  roles={roles}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="consolidatedVendors"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <ConsolidadoVendedores />
              </PrivateRoute>
            }
          />

          {/* ======== ROPA ======== */}
          <Route
            path="salesClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <SalesClothesPOS />
              </PrivateRoute>
            }
          />
          <Route
            path="notebooksInventory"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <GonperProductosPrices />
              </PrivateRoute>
            }
          />
          <Route
            path="TransactionsReportClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <TransactionsReportClothes />
              </PrivateRoute>
            }
          />
          <Route
            path="financialDashboardClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <FinancialDashboardClothes />
              </PrivateRoute>
            }
          />
          <Route
            path="ExpensesClothes"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ExpensesClothes />
              </PrivateRoute>
            }
          />
          <Route
            path="inventoryClothesBatches"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <InventoryClothesBatches />
              </PrivateRoute>
            }
          />
          <Route
            path="productsClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <ProductsClothes />
              </PrivateRoute>
            }
          />
          <Route
            path="CustomersClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <CustomersClothes />
              </PrivateRoute>
            }
          />
        </Route>

        <Route
          path="/salesV2"
          element={
            <PrivateRoute
              allowedRoles={["admin", "vendedor_pollo", "contador"]}
            >
              <SaleFormV2 user={user} />
            </PrivateRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
