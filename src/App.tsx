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
import SaleForm from "./components/SaleForm";
import CierreVentas from "./components/CierreVentas";
import HistorialCierres from "./components/HistorialCierres";
import UserRegisterForm from "./components/UserRegisterForm";
import ProductForm from "./components/ProductForm";
import InventarioForm from "./components/InventarioForm";
import SaleFormV2 from "./components/SaleFormV2";
import InventoryBatches from "./components/InventoryBatches";
import Liquidaciones from "./components/Liquidaciones";
import FinancialDashboard from "./components/FinancialDashboard";
import ExpensesAdmin from "./components/ExpensesAdmin";
import FixBatchesPages from "./components/FixBatchesPages";
import Billing from "./components/Billing";
import PaidBatches from "./components/PaidBatches";
import InventoryClothesBatches from "./components/Clothes/InventoryClothesBatches";
import ProductsClothes from "./components/Clothes/ClothesProducts";
import CustomersClothes from "./components/Clothes/CustomersClothes";
import SalesClothesPOS from "./components/Clothes/SalesClothesPOS";
import FinancialDashboardClothes from "./components/Clothes/FinancialDashboardClothes";
import ExpensesClothes from "./components/Clothes/ExpensesClothes";
import TransactionsReportClothes from "./components/Clothes/TransactionsReportClothes";

type Role = "" | "admin" | "vendedor_pollo" | "vendedor_ropa";

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<Role>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        setUser(firebaseUser);
        try {
          const docRef = doc(db, "users", firebaseUser.uid);
          const snap = await getDoc(docRef);
          const r = (snap.exists() ? snap.data().role : "") as Role;
          setRole(r || "");
        } catch {
          setRole("");
        }
      } else {
        setUser(null);
        setRole("");
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
    return <Navigate to="/" replace />;
    // ^ si no hay rol válido, vuelve al login
  };

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />

        {/* Árbol ADMIN protegido con layout + rutas hijas */}
        <Route
          path="/admin"
          element={
            <PrivateRoute
              allowedRoles={["admin", "vendedor_pollo", "vendedor_ropa"]}
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
          {/* Gastos ropa (solo admin) — si quieres permitir también a vendedor_ropa, agrega el rol */}
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
          {/* Productos ropa (admin y vendedor_ropa si deseas que cree productos; de momento admin) */}
          <Route
            path="productsClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <ProductsClothes />
              </PrivateRoute>
            }
          />
          {/* Clientes ropa (admin y vendedor_ropa) */}
          <Route
            path="CustomersClothes"
            element={
              <PrivateRoute allowedRoles={["admin", "vendedor_ropa"]}>
                <CustomersClothes />
              </PrivateRoute>
            }
          />
        </Route>

        {/* Ruta legacy directa a ventas pollo (si la sigues usando) */}
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
