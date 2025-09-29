// src/components/UserRegisterForm.tsx
import React, { useEffect, useState } from "react";
import { getAuth, signOut } from "firebase/auth";
import { getApp, initializeApp, deleteApp } from "firebase/app";

import { db } from "../firebase";
import { createUserWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  setDoc,
  doc,
  getDocs,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";

type Role = "admin" | "vendedor_pollo" | "vendedor_ropa" | "vendedor";

interface UserRow {
  id: string; // uid
  email: string;
  name: string;
  role: Role;
}

export default function UserRegisterForm() {
  // ====== crear (en modal) ======
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [role, setRole] = useState<Role>("vendedor_pollo");
  const [message, setMessage] = useState("");

  // listado / tabla
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // edición en tabla
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<Role>("vendedor_pollo");

  // modal crear
  const [showCreateModal, setShowCreateModal] = useState(false);

  const normalizeRole = (r?: string): Role => {
    if (!r) return "vendedor_pollo";
    if (r === "vendedor") return "vendedor_pollo"; // compat
    if (r === "admin" || r === "vendedor_pollo" || r === "vendedor_ropa")
      return r;
    return "vendedor_pollo";
  };

  const loadUsers = async () => {
    setLoadingList(true);
    const snap = await getDocs(collection(db, "users"));
    const rows: UserRow[] = [];
    snap.forEach((d) => {
      const it = d.data() as any;
      rows.push({
        id: d.id,
        email: it.email ?? "",
        name: it.name ?? "",
        role: normalizeRole(it.role),
      });
    });
    setUsers(rows);
    setLoadingList(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const resetCreateForm = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRole("vendedor_pollo");
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (password.length < 4) {
      setMessage("❌ La contraseña debe tener al menos 4 caracteres.");
      return;
    }
    if (!name.trim()) {
      setMessage("❌ El nombre es obligatorio.");
      return;
    }

    try {
      // 1) Crear instancia secundaria que NO afecta tu sesión actual
      const primaryApp = getApp(); // tu app principal ya inicializada
      const secondaryApp = initializeApp(
        primaryApp.options as any,
        "Secondary"
      );
      const secondaryAuth = getAuth(secondaryApp);

      // 2) Crear el usuario en la instancia secundaria (no te desloguea)
      const userCred = await createUserWithEmailAndPassword(
        secondaryAuth,
        email,
        password
      );

      // 3) Guardar su perfil en Firestore (colección users)
      await setDoc(doc(collection(db, "users"), userCred.user.uid), {
        email,
        name: name.trim(),
        role: normalizeRole(role),
      });

      // 4) Cerrar sesión de la instancia secundaria y limpiarla
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      // 5) Refrescar UI localmente
      const finalRole = normalizeRole(role);
      setUsers((prev) => [
        { id: userCred.user.uid, email, name: name.trim(), role: finalRole },
        ...prev,
      ]);
      setMessage("✅ Usuario creado correctamente.");

      resetCreateForm();
      setShowCreateModal(false);
    } catch (err: any) {
      console.error(err);
      setMessage("❌ Error al crear el usuario: " + err.message);
    }
  };

  const startEdit = (u: UserRow) => {
    setEditingId(u.id);
    setEditRole(normalizeRole(u.role));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditRole("vendedor_pollo");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const ref = doc(db, "users", editingId);
    const finalRole = normalizeRole(editRole);
    await updateDoc(ref, { role: finalRole });
    setUsers((prev) =>
      prev.map((x) => (x.id === editingId ? { ...x, role: finalRole } : x))
    );
    cancelEdit();
  };

  const deleteUserDoc = async (id: string) => {
    const ok = confirm("¿Eliminar este usuario del listado?");
    if (!ok) return;
    await deleteDoc(doc(db, "users", id));
    setUsers((prev) => prev.filter((x) => x.id !== id));
  };

  const roleBadge = (r: Role) => {
    const label =
      r === "admin"
        ? "admin"
        : r === "vendedor_ropa"
        ? "vendedor_ropa"
        : r === "vendedor_pollo" || r === "vendedor"
        ? "vendedor_pollo"
        : r;

    const cls =
      label === "admin"
        ? "bg-blue-100 text-blue-700"
        : label === "vendedor_ropa"
        ? "bg-indigo-100 text-indigo-700"
        : "bg-green-100 text-green-700";
    return (
      <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>
    );
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* Botón abrir modal crear */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Usuarios</h2>
        <button
          className="px-3 py-2 rounded bg-purple-600 text-white hover:bg-purple-700"
          onClick={() => setShowCreateModal(true)}
          type="button"
        >
          Crear usuario
        </button>
      </div>

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Nombre</th>
              <th className="p-2 border">Email</th>
              <th className="p-2 border">Rol</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loadingList ? (
              <tr>
                <td colSpan={4} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={4} className="p-4 text-center">
                  Sin usuarios
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const isEditing = editingId === u.id;
                return (
                  <tr key={u.id} className="text-center">
                    <td className="p-2 border">{u.name || "—"}</td>
                    <td className="p-2 border">{u.email}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value as Role)}
                        >
                          <option value="admin">Admin</option>
                          <option value="vendedor_pollo">Vendedor Pollo</option>
                          <option value="vendedor_ropa">Vendedor Ropa</option>
                        </select>
                      ) : (
                        roleBadge(u.role)
                      )}
                    </td>
                    <td className="p-2 border space-x-2">
                      {isEditing ? (
                        <>
                          <button
                            className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                            onClick={() => startEdit(u)}
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                            onClick={() => deleteUserDoc(u.id)}
                          >
                            Eliminar
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {message && <p className="text-sm mt-2">{message}</p>}

      {/* ===== Modal: Crear usuario ===== */}
      {showCreateModal && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setShowCreateModal(false)}
          />
          <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-lg max-h-[92vh] overflow-auto p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">Registrar nuevo usuario</h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setShowCreateModal(false)}
                type="button"
              >
                Cerrar
              </button>
            </div>

            <form onSubmit={handleRegister} className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Nombre completo
                </label>
                <input
                  type="text"
                  className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-purple-400"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Correo electrónico
                </label>
                <input
                  type="email"
                  className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-purple-400"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1 relative">
                <label className="block text-sm font-semibold text-gray-700">
                  Contraseña (mínimo 6 caracteres)
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  minLength={6}
                  className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-purple-400 pr-10"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required
                />
                <button
                  type="button"
                  className="absolute right-2 top-8 text-sm text-gray-600 hover:text-gray-800"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "🙈" : "👁️"}
                </button>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Rol
                </label>
                <select
                  className="w-full border p-2 rounded"
                  value={role}
                  onChange={(e) => setRole(e.target.value as Role)}
                >
                  <option value="admin">Admin</option>
                  <option value="vendedor_pollo">Vendedor Pollo</option>
                  <option value="vendedor_ropa">Vendedor Ropa</option>
                </select>
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancelar
                </button>
                <button className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                  Crear usuario
                </button>
              </div>
            </form>

            {message && <p className="text-sm mt-2">{message}</p>}
          </div>
        </div>
      )}
    </div>
  );
}
