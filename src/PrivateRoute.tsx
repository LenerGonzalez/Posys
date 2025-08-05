// PrivateRoute.tsx - Protección de rutas según rol
import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { auth, db } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";

interface PrivateRouteProps {
  children: React.ReactElement;
  allowedRoles: string[];
}

export default function PrivateRoute({
  children,
  allowedRoles,
}: PrivateRouteProps): React.ReactElement {
  const [loading, setLoading] = useState(true);
  const [authorized, setAuthorized] = useState(false);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (user) => {
      if (user) {
        const docRef = doc(db, "users", user.uid);
        const docSnap = await getDoc(docRef);

        if (docSnap.exists()) {
          const role = docSnap.data().role;
          setAuthorized(allowedRoles.includes(role));
        }
      }
      setLoading(false);
    });
    return () => unsubscribe();
  }, [allowedRoles]);

  if (loading) return <div className="p-4">Cargando...</div>;
  if (!authorized) return <Navigate to="/" />;

  return children;
}
