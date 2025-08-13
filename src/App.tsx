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
              <AdminLayout />
            </PrivateRoute>
          }
        >
          {/* Redirige /admin a /admin/ventas */}
          <Route index element={<Navigate to="ventas" replace />} />

          {/* Ventas (vendedor y admin) */}
          <Route
            path="ventas"
            element={
              <PrivateRoute allowedRoles={["vendedor", "admin"]}>
                {/* Si tu SaleForm necesita user, pásalo */}
                <SaleForm user={user} />
              </PrivateRoute>
            }
          />

          {/* Cierre del día */}
          <Route
            path="cierre"
            element={
              <PrivateRoute allowedRoles={["vendedor", "admin"]}>
                {/* si tu CierreVentas recibe role, usa: role={role === "admin" ? "admin" : "vendedor"} */}
                <CierreVentas />
              </PrivateRoute>
            }
          />

          {/* Historial de cierres (solo admin) */}
          <Route
            path="cierres"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <HistorialCierres />
              </PrivateRoute>
            }
          />

          {/* Usuarios (solo admin) – usa tu componente de usuarios/registro */}
          <Route
            path="usuarios"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <UserRegisterForm />
              </PrivateRoute>
            }
          />

          {/* Productos (solo admin) */}
          <Route
            path="productos"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <ProductForm />
              </PrivateRoute>
            }
          />

          {/* Inventario (solo admin) */}
          <Route
            path="inventario"
            element={
              <PrivateRoute allowedRoles={["admin"]}>
                <InventarioForm />
              </PrivateRoute>
            }
          />
        </Route>

        {/* Ruta legacy para vendedores si la usas aún */}
        <Route
          path="/ventas"
          element={
            <PrivateRoute allowedRoles={["vendedor", "admin"]}>
              <SaleForm user={user} />
            </PrivateRoute>
          }
        />

        <Route path="*" element={<Navigate to="/" />} />
      </Routes>
    </Router>
  );
}
