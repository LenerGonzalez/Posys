// src/components/Login.tsx
import React, { useEffect, useState } from "react";
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
  const navigate = useNavigate();

  useEffect(() => {
    let mounted = true;
    const unsub = onAuthStateChanged(auth, async (firebaseUser) => {
      if (!firebaseUser || !mounted) return;
      try {
        const snap = await getDoc(doc(db, "users", firebaseUser.uid));
        if (!snap.exists()) return;
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
        /* ignore auto-redirect errors */
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

    try {
      setLoading(true);
      console.info && console.info("[Login] attempting signIn", { email });

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

      // Si tiene solo un rol sencillo, redirigimos directo; si tiene múltiples, vamos a /admin
      if (roles.length === 1) goByRole(role as AllowedRole);
      else navigate("/admin");
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
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center ">
      <form
        onSubmit={handleSubmit}
        className="w-[92%] max-w-md bg-white p-6 rounded-2xl shadow-2xl"
      >
        <h2 className="text-2xl font-bold text-center mb-4">Iniciar Sesión</h2>

        <label className="block text-sm font-semibold">
          Correo electrónico
        </label>
        <input
          type="email"
          className="w-full border rounded-2xl px-3 py-2 mb-3 shadow-2xl"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
        />

        <label className="block text-sm font-semibold">Contraseña</label>
        <div className="flex gap-2 mb-2">
          <input
            type={showPw ? "text" : "password"}
            className="flex-1 border rounded-2xl px-3 py-2 shadow-2xl"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="px-3 py-2 rounded-2xl shadow-2xl bg-gray-200 hover:bg-gray-300"
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        <div className="text-xs text-gray-600 mb-3">
          Mínimo 6 caracteres (requisito de Firebase).
        </div>

        <button
          className="w-full bg-blue-600 text-white px-4 py-2 rounded-2xl shadow-2xl hover:bg-blue-700 disabled:opacity-60"
          disabled={loading}
        >
          {loading ? "Entrando..." : "Entrar"}
        </button>

        {msg && (
          <p
            className={`mt-3 text-sm ${
              msg.startsWith("Error") || msg.includes("no válido")
                ? "text-red-600"
                : "text-gray-700"
            }`}
          >
            {msg}
          </p>
        )}
      </form>
    </div>
  );
}
