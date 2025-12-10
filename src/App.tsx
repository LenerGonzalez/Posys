// src/App.tsx
import React, { useEffect, useState } from "react";
import {
  BrowserRouter as Router,
  Routes,
  Route,
  Navigate,
} from "react-router-dom";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "./firebase";
import { doc, getDoc } from "firebase/firestore";

// Auth / layout
import Login from "./components/Login";
import PrivateRoute from "./PrivateRoute";
import AdminLayout from "./components/AdminLayout";

// Módulos
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
import Billing from "./components/Pollo/Billing";
import PaidBatches from "../src/components/Pollo/PaidBatches";
import InventoryClothesBatches from "./components/Clothes/InventoryClothesBatches";
import ProductsClothes from "./components/Clothes/ClothesProducts";
import CustomersClothes from "./components/Clothes/CustomersClothes";
import SalesClothesPOS from "./components/Clothes/SalesClothesPOS";
import FinancialDashboardClothes from "./components/Clothes/FinancialDashboardClothes";
import ExpensesClothes from "./components/Clothes/ExpensesClothes";
import TransactionsReportClothes from "./components/Clothes/TransactionsReportClothes";
import CandiesProducts from "./components/Candies/CandiesProducts";
import InventoryCandies from "./components/Candies/InventoryCandies";
import CustomersCandies from "./components/Candies/CustomersCandies";
import SalesCandies from "./components/Candies/SalesCandies";
import ExpensesCandies from "./components/Candies/ExpensesCandies";
import TransactionCandies from "./components/Candies/TransactionCandies";
import DashboardCandies from "./components/Candies/DashboardCandies";
import Vendors from "./components/Candies/SubInventarios/Vendors";
import ProductsVendors from "./components/Candies/SubInventarios/ProductsVendors";
import ProductMainOrder from "./components/Candies/ProductMainOrder";
import InventoryMainOrders from "./components/Candies/InventoryMainOrders";
import CierreVentasDulces from "./components/Candies/CierreVentasDulces";
import ConsolidadoVendedores from "./components/Candies/ConsolidadoVendedores";

// Definición de roles
type Role =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<Role>("");
  const [sellerCandyId, setSellerCandyId] = useState<string>(""); // <- nuevo
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const docRef = doc(db, "users", firebaseUser.uid);
          const snap = await getDoc(docRef);
          if (snap.exists()) {
            const data = snap.data() as any;
            const r = (data.role || "") as Role;
            const scId = (data.sellerCandyId || "") as string;
            setRole(r || "");
            setSellerCandyId(scId || "");
          } else {
            setRole("");
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

  if (loading) return <div className="p-6 text-center">Cargando...</div>;

  // Redirección por defecto dentro de /admin según rol
  const AdminIndexRedirect = () => {
    if (role === "admin") return <Navigate to="FinancialDashboard" replace />;
    if (role === "vendedor_pollo") return <Navigate to="salesV2" replace />;
    if (role === "vendedor_ropa") return <Navigate to="salesClothes" replace />;
    if (role === "vendedor_dulces")
      return <Navigate to="productsCandies" replace />;
    return <Navigate to="/" replace />;
  };

  const currentUserEmail = user?.email || "";

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />

        {/* Árbol ADMIN protegido con layout + rutas hijas */}
        <Route
          path="/admin"
          element={
            <PrivateRoute
              allowedRoles={[
                "admin",
                "vendedor_pollo",
                "vendedor_ropa",
                "vendedor_dulces",
              ]}
            >
              <AdminLayout role={role} />
            </PrivateRoute>
          }
        >
          {/* Redirección inicial dentro de /admin según rol */}
          <Route index element={<AdminIndexRedirect />} />

          {/* ======== POLLO ======== */}
          {/* Cierre del día (admin y vendedor_pollo) */}
          <Route
            path="bills"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_pollo"]}>
                <CierreVentas />
              </PrivateRoute>
            }
          />
          {/* Ventas pollo (admin y vendedor_pollo) */}
          <Route
            path="salesV2"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_pollo"]}>
                <SaleFormV2 user={user} />
              </PrivateRoute>
            }
          />
          {/* Panel financiero pollo (solo admin) */}
          <Route
            path="financialDashboard"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <FinancialDashboard />
              </PrivateRoute>
            }
          />
          {/* Gastos pollo (solo admin) */}
          <Route
            path="expenses"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ExpensesAdmin />
              </PrivateRoute>
            }
          />
          {/* Billing / cierre manual (solo admin) */}
          <Route
            path="billing"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <Billing />
              </PrivateRoute>
            }
          />
          {/* Inventarios pollo (solo admin) */}
          <Route
            path="batches"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <InventoryBatches />
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
          {/* Otros (solo admin) */}
          <Route
            path="fix"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <FixBatchesPages />
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
          {/* Usuarios (solo admin) */}
          <Route
            path="users"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <UserRegisterForm />
              </PrivateRoute>
            }
          />
          {/* Productos pollo (solo admin) */}
          <Route
            path="products"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ProductForm />
              </PrivateRoute>
            }
          />

          {/* ======== CANDIES ======== */}
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
            path="customersCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <CustomersCandies />
              </PrivateRoute>
            }
          />
          <Route
            path="salesCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <SalesCandies
                  role={role}
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
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <TransactionCandies
                  role={role}
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
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <ProductsVendors
                  role={role}
                  currentUserEmail={currentUserEmail}
                  sellerCandyId={sellerCandyId}
                />
              </PrivateRoute>
            }
          />
          <Route
            path="cierreVentasCandies"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_dulces"]}>
                <CierreVentasDulces
                  role={role}
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
          {/* Venta ropa (admin y vendedor_ropa) */}
          <Route
            path="salesClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <SalesClothesPOS />
              </PrivateRoute>
            }
          />
          {/* Transacciones ropa (admin y vendedor_ropa) */}
          <Route
            path="TransactionsReportClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <TransactionsReportClothes />
              </PrivateRoute>
            }
          />
          {/* Dashboard ropa (admin y vendedor_ropa) */}
          <Route
            path="financialDashboardClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <FinancialDashboardClothes />
              </PrivateRoute>
            }
          />
          {/* Gastos ropa (solo admin) */}
          <Route
            path="ExpensesClothes"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ExpensesClothes />
              </PrivateRoute>
            }
          />
          {/* Inventario ropa (solo admin) */}
          <Route
            path="inventoryClothesBatches"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <InventoryClothesBatches />
              </PrivateRoute>
            }
          />
          {/* Productos ropa */}
          <Route
            path="productsClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <ProductsClothes />
              </PrivateRoute>
            }
          />
          {/* Clientes ropa */}
          <Route
            path="CustomersClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <CustomersClothes />
              </PrivateRoute>
            }
          />
        </Route>

        {/* Ruta legacy directa a ventas pollo */}
        <Route
          path="/salesV2"
          element={
            <PrivateRoute allowedRoles={["admin", "vendedor_pollo"]}>
              <SaleFormV2 user={user} />
            </PrivateRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
