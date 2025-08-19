import React, { useEffect, useState } from "react";
import { auth, db } from "../firebase";
import { createUserWithEmailAndPassword } from "firebase/auth";
import {
  collection,
  setDoc,
  doc,
  getDocs,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";

interface UserRow {
  id: string; // uid
  email: string;
  role: string;
}

export default function UserRegisterForm() {
  // formulario crear
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState("vendedor");
  const [message, setMessage] = useState("");

  // listado / tabla
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // edición en tabla
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRole, setEditRole] = useState<string>("vendedor");

  const loadUsers = async () => {
    setLoadingList(true);
    const snap = await getDocs(collection(db, "users"));
    const rows: UserRow[] = [];
    snap.forEach((d) => {
      const it = d.data() as any;
      rows.push({
        id: d.id,
        email: it.email ?? "",
        role: it.role ?? "vendedor",
      });
    });
    setUsers(rows);
    setLoadingList(false);
  };

  useEffect(() => {
    loadUsers();
  }, []);

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    try {
      const userCred = await createUserWithEmailAndPassword(
        auth,
        email,
        password
      );
      await setDoc(doc(collection(db, "users"), userCred.user.uid), {
        email,
        role,
      });

      setUsers((prev) => [{ id: userCred.user.uid, email, role }, ...prev]);

      setMessage("✅ Usuario creado correctamente.");
      setEmail("");
      setPassword("");
      setRole("vendedor");
    } catch (err: any) {
      setMessage("❌ Error al crear el usuario: " + err.message);
    }
  };

  const startEdit = (u: UserRow) => {
    setEditingId(u.id);
    setEditRole(u.role || "vendedor");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditRole("vendedor");
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const ref = doc(db, "users", editingId);
    await updateDoc(ref, { role: editRole });
    setUsers((prev) =>
      prev.map((x) => (x.id === editingId ? { ...x, role: editRole } : x))
    );
    cancelEdit();
  };

  const deleteUserDoc = async (id: string) => {
    const ok = confirm("¿Eliminar este usuario del listado?");
    if (!ok) return;
    await deleteDoc(doc(db, "users", id));
    setUsers((prev) => prev.filter((x) => x.id !== id));
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* Form Crear */}
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

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto mt-6">
        <h3 className="text-lg font-semibold p-2">Usuarios</h3>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Email</th>
              <th className="p-2 border">Rol</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loadingList ? (
              <tr>
                <td colSpan={3} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td colSpan={3} className="p-4 text-center">
                  Sin usuarios
                </td>
              </tr>
            ) : (
              users.map((u) => {
                const isEditing = editingId === u.id;
                return (
                  <tr key={u.id} className="text-center">
                    <td className="p-2 border">{u.email}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={editRole}
                          onChange={(e) => setEditRole(e.target.value)}
                        >
                          <option value="vendedor">Vendedor</option>
                          <option value="admin">Admin</option>
                        </select>
                      ) : (
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${
                            u.role === "admin"
                              ? "bg-blue-100 text-blue-700"
                              : "bg-green-100 text-green-700"
                          }`}
                        >
                          {u.role}
                        </span>
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
    </div>
  );
}
