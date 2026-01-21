// PrivateRoute.tsx - Protección de rutas según rol
import React, { useEffect, useState } from "react";
import { Navigate } from "react-router-dom";
import { auth, db } from "./firebase";
import { onAuthStateChanged } from "firebase/auth";
import { hasRole } from "./utils/roles";
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
          const data = docSnap.data() as any;
          const rlist: string[] = Array.isArray(data.roles)
            ? data.roles
            : data.role
              ? [data.role]
              : [];
          try {
            const isLocal =
              typeof window !== "undefined" &&
              window.location &&
              (window.location.hostname === "localhost" ||
                window.location.hostname === "127.0.0.1");
            if (isLocal) {
              console.info &&
                console.info(
                  "[PrivateRoute] uid:",
                  user.uid,
                  "roleFromDoc:",
                  role,
                  "allowedRoles:",
                  allowedRoles,
                );
            } else {
              console.debug &&
                console.debug(
                  "[PrivateRoute] uid:",
                  user.uid,
                  "roleFromDoc:",
                  role,
                  "allowedRoles:",
                  allowedRoles,
                );
            }
          } catch (e) {
            /* ignore logging errors */
          }
          // Autorizar si alguno de los allowedRoles coincide con los roles del usuario
          let ok = false;
          for (const ar of allowedRoles) {
            if (hasRole(rlist, ar)) {
              ok = true;
              break;
            }
          }
          setAuthorized(ok);
        } else {
          try {
            const isLocal =
              typeof window !== "undefined" &&
              window.location &&
              (window.location.hostname === "localhost" ||
                window.location.hostname === "127.0.0.1");
            if (isLocal) {
              console.info &&
                console.info("[PrivateRoute] no user doc for uid:", user.uid);
            } else {
              console.debug &&
                console.debug("[PrivateRoute] no user doc for uid:", user.uid);
            }
          } catch (e) {}
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
