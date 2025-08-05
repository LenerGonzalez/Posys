import React, { useState } from "react";
import { auth, db } from "../firebase";
import { createUserWithEmailAndPassword } from "firebase/auth";
import { collection, setDoc, doc } from "firebase/firestore";

export default function UserRegisterForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("vendedor");
  const [message, setMessage] = useState("");

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    try {
      const userCred = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );

      // Guardar el rol en Firestore
      await setDoc(doc(collection(db, "users"), userCred.user.uid), {
        email,
        role,
      });

      setMessage("✅ Usuario creado correctamente.");
      setEmail("");
      setPassword("");
      setRole("vendedor");
    } catch (err: any) {
      setMessage("❌ Error al crear el usuario: " + err.message);
    }
  };

  return (
    <form
      onSubmit={handleRegister}
      className="max-w-md mx-auto bg-white p-8 shadow-lg rounded-lg space-y-6 border border-gray-200"
    >
      <h2 className="text-2xl font-bold mb-4 text-purple-700 flex items-center gap-2">
        <span className="inline-block bg-purple-100 text-purple-700 rounded-full p-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-6 w-6"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M12 4v16m8-8H4"
            />
          </svg>
        </span>
        Registrar nuevo usuario
      </h2>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Correo electrónico
        </label>
        <input
          type="email"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-purple-400"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Contraseña
        </label>
        <input
          type="password"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-purple-400"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>

      <div>
        <label className="block text-sm">Rol</label>
        <select
          className="w-full border p-2 rounded"
          value={role}
          onChange={(e) => setRole(e.target.value)}
        >
          <option value="vendedor">Vendedor</option>
          <option value="admin">Admin</option>
        </select>
      </div>

      <button
        type="submit"
        className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700 w-full"
      >
        Crear usuario
      </button>

      {message && <p className="text-sm mt-2">{message}</p>}
    </form>
  );
}
