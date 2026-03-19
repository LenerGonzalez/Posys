// src/components/Login.tsx
import React, { useEffect, useRef, useState } from "react";
import { auth, db } from "../firebase";
import {
  signInWithEmailAndPassword,
  browserLocalPersistence,
  setPersistence,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { hasRole } from "../utils/roles";
import { useNavigate } from "react-router-dom";

type AllowedRole =
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const [showLogoutTransition, setShowLogoutTransition] = useState(false);
  const isLoggingInRef = useRef(false);
  const isRedirectingRef = useRef(false);
  const minDurationMs = 100;
  const navigate = useNavigate();

  useEffect(() => {
    try {
      if (sessionStorage.getItem("logout_transition") === "1") {
        sessionStorage.removeItem("logout_transition");
        setShowLogoutTransition(true);
        const t = window.setTimeout(() => {
          setShowLogoutTransition(false);
        }, 450);
        return () => window.clearTimeout(t);
      }
    } catch (e) {}
    return undefined;
  }, []);

  useEffect(() => {
    let mounted = true;
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser || !mounted) return;
      if (isLoggingInRef.current) return;
      setLoading(true);
      isRedirectingRef.current = true;
      try {
        try {
          localStorage.removeItem("pos_vendorId");
          localStorage.removeItem("pos_role");
        } catch (e) {}
        const snap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!snap.exists()) {
          setMsg("Tu usuario no tiene perfil en la base de datos.");
          isRedirectingRef.current = false;
          setLoading(false);
          return;
        }
        const data = snap.data() as any;
        const roles: string[] = Array.isArray(data.roles)
          ? data.roles
          : data.role
            ? [data.role]
            : [];
        const role: string = roles[0] || "";
        const name: string = data.name || "";

        localStorage.setItem("user_email", firebaseUser.email || "");
        if (name) localStorage.setItem("user_name", name);
        localStorage.setItem("roles", JSON.stringify(roles));

        if (roles.length === 1) goByRole(role as AllowedRole);
        else navigate("/admin", { replace: true });
      } catch {
        isRedirectingRef.current = false;
        setLoading(false);
      }
    });
    return () => {
      mounted = false;
      unsub();
    };
  }, [navigate]);

  const goByRole = (subject: string | string[]) => {
    // subject puede ser un string (rol) o un array de roles
    if (Array.isArray(subject)) {
      if (subject.length !== 1) {
        // multi-rol -> panel central
        localStorage.setItem("role", subject[0] || "");
        return navigate("/admin");
      }
      subject = subject[0] || "";
    }

    const role = String(subject || "");
    localStorage.setItem("role", role);

    if (hasRole(role, "admin")) return navigate("/admin");
    if (hasRole(role, "vendedor_pollo")) return navigate("/admin/salesV2");
    if (hasRole(role, "vendedor_ropa")) return navigate("/admin/salesClothes");
    if (hasRole(role, "vendedor_dulces"))
      return navigate("/admin/salesCandies");
    if (hasRole(role, "supervisor_pollo")) return navigate("/admin/batches");
    if (hasRole(role, "contador")) return navigate("/admin/batches");
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    // Validaciones rápidas
    if (!email.trim()) {
      setMsg("Ingresa el correo.");
      return;
    }
    if (password.length < 6) {
      setMsg("La contraseña debe tener al menos 6 caracteres.");
      return;
    }

    const start = Date.now();
    isLoggingInRef.current = true;
    isRedirectingRef.current = false;
    try {
      setLoading(true);
      console.info && console.info("[Login] attempting signIn", { email });

      try {
        localStorage.removeItem("pos_vendorId");
        localStorage.removeItem("pos_role");
      } catch (e) {}

      // ✅ Mantener la sesión (persistencia en el dispositivo)
      await setPersistence(auth, browserLocalPersistence);

      const cred = await signInWithEmailAndPassword(auth, email, password);
      console.info &&
        console.info("[Login] signInWithEmailAndPassword success", {
          uid: cred.user.uid,
          email: cred.user.email,
        });
      const uid = cred.user.uid;

      // ✅ Marca inicio de sesión para expiración 15 días
      localStorage.setItem("POSYS_LOGIN_AT", String(Date.now()));

      // Leer perfil en Firestore
      const snap = await getDoc(doc(db, "users", uid));
      console.info &&
        console.info(
          "[Login] firestore users doc snap: exists=",
          snap.exists(),
        );
      if (!snap.exists()) {
        console.warn && console.warn("[Login] user doc missing for uid", uid);
        setMsg("Tu usuario no tiene perfil en la base de datos.");
        return;
      }

      const data = snap.data() as any;
      console.info && console.info("[Login] user profile:", data);
      const roles: string[] = Array.isArray(data.roles)
        ? data.roles
        : data.role
          ? [data.role]
          : [];
      const role: string = roles[0] || "";
      const name: string = data.name || ""; // si lo guardas en users

      // Aceptar nuevos roles
      const allowed: AllowedRole[] = [
        "admin",
        "vendedor_pollo",
        "vendedor_ropa",
        "vendedor_dulces",
        "supervisor_pollo",
        "contador",
      ];
      if (!roles.some((r) => allowed.includes(r as AllowedRole))) {
        setMsg("Rol no válido. Consulta al administrador.");
        return;
      }

      // Persistir info mínima para el layout / header
      localStorage.setItem("user_email", cred.user.email || "");
      if (name) localStorage.setItem("user_name", name);
      // Guardamos roles también para compatibilidad futura
      localStorage.setItem("roles", JSON.stringify(roles));

      const elapsed = Date.now() - start;
      if (elapsed < minDurationMs) {
        await new Promise((resolve) =>
          setTimeout(resolve, minDurationMs - elapsed),
        );
      }

      isRedirectingRef.current = true;
      // Si tiene solo un rol sencillo, redirigimos directo; si tiene múltiples, vamos a /admin
      if (roles.length === 1) goByRole(role as AllowedRole);
      else navigate("/admin", { replace: true });
    } catch (err: any) {
      console.error && console.error("[Login] sign-in error:", err);
      // Errores comunes de Firebase Auth
      const code = String(err?.code || "");
      if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password"
      ) {
        setMsg("Credenciales incorrectas. (" + code + ")");
      } else if (code === "auth/user-not-found") {
        setMsg("Usuario no encontrado. (" + code + ")");
      } else if (code === "auth/too-many-requests") {
        setMsg("Demasiados intentos. Intenta más tarde. (" + code + ")");
      } else {
        setMsg(
          (err?.message || "Error al iniciar sesión.") +
            (code ? ` (${code})` : ""),
        );
      }
    } finally {
      isLoggingInRef.current = false;
      if (!isRedirectingRef.current) {
        setLoading(false);
      }
    }
  };

  return (
    <div className="min-h-[100svh] bg-slate-900 grid place-items-center px-4 py-8 relative overflow-hidden">
      <div className="absolute inset-0 md:hidden bg-gradient-to-br from-rose-600 via-amber-500 to-pink-600" />
      <div className="absolute inset-0 hidden md:block bg-slate-900" />
      <div className="relative z-10 grid w-full max-w-4xl overflow-hidden rounded-3xl bg-white shadow-2xl md:grid-cols-2">
        <div className="p-6 sm:p-10">
          <div className="flex flex-col items-center text-center mb-6">
            <img
              src="/logo_black.svg"
              alt="Logo Multiservicios Ortiz"
              className="mb-3 h-28 w-auto sm:h-36"
            />
            <h1 className="text-xl font-bold text-slate-900">
              Multiservicios Ortiz
            </h1>
            <p className="text-sm text-slate-500">Acceso al sistema</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="block text-sm font-semibold text-slate-700">
                Correo electrónico
              </label>
              <input
                type="email"
                className="w-full border border-slate-200 rounded-2xl px-3 py-2 mt-1 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                autoComplete="username"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold text-slate-700">
                Contraseña
              </label>
              <div className="mt-1 flex flex-col gap-2 sm:flex-row">
                <input
                  type={showPw ? "text" : "password"}
                  className="min-w-0 flex-1 border border-slate-200 rounded-2xl px-3 py-2 shadow-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  minLength={6}
                  autoComplete="current-password"
                />
                <button
                  type="button"
                  className="w-full shrink-0 whitespace-nowrap rounded-2xl bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800 sm:w-auto"
                  onClick={() => setShowPw((v) => !v)}
                >
                  {showPw ? "Ocultar" : "Mostrar"}
                </button>
              </div>
              <div className="text-xs text-slate-500 mt-2">
                Mínimo 6 caracteres (requisito de Firebase).
              </div>
            </div>

            <button
              className="w-full bg-slate-900 text-white px-4 py-2 rounded-2xl shadow hover:bg-slate-800 disabled:opacity-60"
              disabled={loading}
            >
              {loading ? "Entrando..." : "Entrar"}
            </button>

            {msg && (
              <p
                className={`text-sm ${
                  msg.startsWith("Error") || msg.includes("no válido")
                    ? "text-red-600"
                    : "text-slate-700"
                }`}
              >
                {msg}
              </p>
            )}
          </form>
        </div>

        <div className="relative hidden md:flex min-h-[180px] items-center justify-center bg-gradient-to-br from-rose-600 via-amber-500 to-pink-600 md:min-h-0">
          <div className="absolute inset-0 opacity-20 bg-[radial-gradient(circle_at_top,_rgba(255,255,255,0.4),_transparent_55%)]" />
          <img
            src="/logo_red.svg"
            alt="Logo Multiservicios Ortiz"
            className="h-50 w-auto drop-shadow-lg"
          />
        </div>
      </div>
      {loading && (
        <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/60 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900/90 px-6 py-5 text-white shadow-2xl">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            <div className="text-sm font-semibold tracking-wide">
              Iniciando sesion...
            </div>
          </div>
        </div>
      )}
      {showLogoutTransition && !loading && (
        <div className="fixed inset-0 z-[190] flex items-center justify-center bg-slate-900/70 backdrop-blur-sm logout-transition pointer-events-none">
          <div className="flex flex-col items-center gap-3 rounded-2xl bg-slate-900/90 px-6 py-5 text-white shadow-2xl">
            <div className="h-10 w-10 animate-spin rounded-full border-2 border-white/40 border-t-white" />
            <div className="text-sm font-semibold tracking-wide">
              Cerrando sesion...
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
