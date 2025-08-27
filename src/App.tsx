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
import UserRegisterForm from "./components/UserRegisterForm"; // si quieres mantenerlo para “Usuarios”
import ProductForm from "./components/ProductForm";
import InventarioForm from "./components/InventarioForm"; // o el nombre que uses
import SaleFormV2 from "./components/SaleFormV2";
import InventoryBatches from "./components/InventoryBatches";
import Liquidaciones from "./components/Liquidaciones";
import FinancialDashboard from "./components/FinancialDashboard";
import ExpensesAdmin from "./components/ExpensesAdmin";
import FixBatchesPages from "./components/FixBatchesPages";

export default function App() {
  const [user, setUser] = useState<any>(null);
  const [role, setRole] = useState<string>("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
      setLoading(true);
      if (firebaseUser) {
        setUser(firebaseUser);
        const docRef = doc(db, "users", firebaseUser.uid);
        const snap = await getDoc(docRef);
        setRole(snap.exists() ? snap.data().role : "");
      } else {
        setUser(null);
        setRole("");
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, []);

  if (loading) return <div className="p-6 text-center">Cargando...</div>;

  return (
    <Router>
      <Routes>
        <Route path="/" element={<Login />} />

        {/* Árbol ADMIN protegido con layout + rutas hijas */}
       <Route
  path="/admin"
  element={
    <PrivateRoute allowedRoles={["admin", "vendedor"]}>
      <AdminLayout role={role} />
    </PrivateRoute>
  }
>

          {/* Redirige /admin a /admin/ventas */}
          <Route index element={<Navigate to="bills" replace />} />

          {/* Cierre del día */}
          <Route
            path="bills"
            element={
              <PrivateRoute allowedRoles={["vendedor", "admin"]}>
                <CierreVentas />
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
          {/* Ventas (vendedor y admin) */}
          <Route
            path="salesV2"
            element={
              <PrivateRoute allowedRoles={["vendedor", "admin"]}>
                <SaleFormV2 user={user} />
              </PrivateRoute>
            }
          />

          {/* Historial de cierres (solo admin) */}
          <Route
            path="billhistoric"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <HistorialCierres />
              </PrivateRoute>
            }
          />

          {/* Usuarios (solo admin) – usa tu componente de usuarios/registro */}
          <Route
            path="users"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <UserRegisterForm />
              </PrivateRoute>
            }
          />

          {/* Productos (solo admin) */}
          <Route
            path="products"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ProductForm />
              </PrivateRoute>
            }
          />

          <Route
            path="batches"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <InventoryBatches />
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
            path="financialDashboard"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <FinancialDashboard />
              </PrivateRoute>
            }
          />

          {/* Registro de gastos */}
          <Route
            path="expenses"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ExpensesAdmin />
              </PrivateRoute>
            }
          />
        </Route>

        {/* Ruta legacy para vendedores si la usas aún */}
        <Route
          path="/salesV2"
          element={
            <PrivateRoute allowedRoles={["vendedor", "admin"]}>
              <SaleFormV2 user={user} />
            </PrivateRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
