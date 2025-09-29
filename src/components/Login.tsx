// src/components/Login.tsx
import React, { useState } from "react";
import { auth, db } from "../firebase";
import { signInWithEmailAndPassword } from "firebase/auth";
import { doc, getDoc } from "firebase/firestore";
import { useNavigate } from "react-router-dom";

type AllowedRole = "admin" | "vendedor_pollo" | "vendedor_ropa";

export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPw, setShowPw] = useState(false);
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);
  const navigate = useNavigate();

  const goByRole = (role: AllowedRole) => {
    // Guarda el rol (y opcionalmente el nombre) para AdminLayout
    localStorage.setItem("role", role);
    // Redirecciones por rol
    if (role === "admin") return navigate("/admin");
    if (role === "vendedor_pollo") return navigate("/admin/salesV2");
    if (role === "vendedor_ropa") return navigate("/admin/salesClothes");
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
      const cred = await signInWithEmailAndPassword(auth, email, password);
      const uid = cred.user.uid;

      // Leer perfil en Firestore
      const snap = await getDoc(doc(db, "users", uid));
      if (!snap.exists()) {
        setMsg("Tu usuario no tiene perfil en la base de datos.");
        return;
      }

      const data = snap.data() as any;
      const role: string = data.role || "";
      const name: string = data.name || ""; // si lo guardas en users

      // Aceptar nuevos roles
      const allowed: AllowedRole[] = [
        "admin",
        "vendedor_pollo",
        "vendedor_ropa",
      ];
      if (!allowed.includes(role as AllowedRole)) {
        setMsg("Rol no válido. Consulta al administrador.");
        return;
      }

      // Persistir info mínima para el layout / header
      localStorage.setItem("user_email", cred.user.email || "");
      if (name) localStorage.setItem("user_name", name);

      goByRole(role as AllowedRole);
    } catch (err: any) {
      // Errores comunes de Firebase Auth
      const code = String(err?.code || "");
      if (
        code === "auth/invalid-credential" ||
        code === "auth/wrong-password"
      ) {
        setMsg("Credenciales incorrectas.");
      } else if (code === "auth/user-not-found") {
        setMsg("Usuario no encontrado.");
      } else if (code === "auth/too-many-requests") {
        setMsg("Demasiados intentos. Intenta más tarde.");
      } else {
        setMsg(err?.message || "Error al iniciar sesión.");
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center">
      <form
        onSubmit={handleSubmit}
        className="w-[92%] max-w-md bg-white p-6 rounded-lg shadow border"
      >
        <h2 className="text-2xl font-bold text-center mb-4">Iniciar Sesión</h2>

        <label className="block text-sm font-semibold">
          Correo electrónico
        </label>
        <input
          type="email"
          className="w-full border rounded px-3 py-2 mb-3"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          autoComplete="username"
        />

        <label className="block text-sm font-semibold">Contraseña</label>
        <div className="flex gap-2 mb-2">
          <input
            type={showPw ? "text" : "password"}
            className="flex-1 border rounded px-3 py-2"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={6}
            autoComplete="current-password"
          />
          <button
            type="button"
            className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
            onClick={() => setShowPw((v) => !v)}
          >
            {showPw ? "Ocultar" : "Mostrar"}
          </button>
        </div>
        <div className="text-xs text-gray-600 mb-3">
          Mínimo 6 caracteres (requisito de Firebase).
        </div>

        <button
          className="w-full bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
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
