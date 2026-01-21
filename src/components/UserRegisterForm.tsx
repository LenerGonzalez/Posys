// src/components/UserRegisterForm.tsx
import React, { useEffect, useState } from "react";
import { getAuth, signOut, sendPasswordResetEmail } from "firebase/auth";
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

type Role =
  | "admin"
  | "supervisor_pollo"
  | "contador"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "vendedor"; // compatibilidad vieja

interface UserRow {
  id: string; // uid
  email: string;
  name: string;
  roles: Role[];
  sellerCandyId?: string; // id del vendedor (sellers_candies) si es vendedor_dulces
}

interface SellerCandy {
  id: string;
  name: string;
  branchLabel: string;
  commissionPercent: number;
}

export default function UserRegisterForm() {
  // ====== crear (en modal) ======
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [roles, setRoles] = useState<Role[]>(["vendedor_pollo"]);
  const [message, setMessage] = useState("");

  // vendedor de dulces asignado al crear
  const [sellerCandyIdCreate, setSellerCandyIdCreate] = useState<string>("");

  // listado / tabla
  const [users, setUsers] = useState<UserRow[]>([]);
  const [loadingList, setLoadingList] = useState(true);

  // edición en tabla
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editRoles, setEditRoles] = useState<Role[]>(["vendedor_pollo"]);
  const [editSellerCandyId, setEditSellerCandyId] = useState<string>("");
  const [origEmail, setOrigEmail] = useState<string>("");

  // modal crear
  const [showCreateModal, setShowCreateModal] = useState(false);

  // catálogo de vendedores de dulces
  const [sellersCandy, setSellersCandy] = useState<SellerCandy[]>([]);

  const normalizeRole = (r?: string): Role => {
    if (!r) return "vendedor_pollo";
    if (r === "vendedor") return "vendedor_pollo"; // compat antigua
    if (
      r === "admin" ||
      r === "supervisor_pollo" ||
      r === "contador" ||
      r === "vendedor_pollo" ||
      r === "vendedor_ropa" ||
      r === "vendedor_dulces"
    ) {
      return r;
    }
    return "vendedor_pollo";
  };

  const normalizeRoles = (input?: any): Role[] => {
    if (!input) return ["vendedor_pollo"] as Role[];
    if (Array.isArray(input)) return input.map((x) => normalizeRole(String(x)));
    // fall back to single string role
    return [normalizeRole(String(input))];
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
        roles: normalizeRoles(it.roles ?? it.role),
        sellerCandyId: it.sellerCandyId ?? "",
      });
    });
    setUsers(rows);
    setLoadingList(false);
  };

  const loadSellersCandy = async () => {
    try {
      const snap = await getDocs(collection(db, "sellers_candies"));
      const list: SellerCandy[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          name: x.name ?? "(sin nombre)",
          branchLabel: x.branch ?? "",
          commissionPercent: Number(x.commissionPercent ?? 0),
        });
      });
      setSellersCandy(list);
    } catch (e) {
      console.error("Error cargando sellers_candies:", e);
    }
  };

  useEffect(() => {
    loadUsers();
    loadSellersCandy();
  }, []);

  const resetCreateForm = () => {
    setName("");
    setEmail("");
    setPassword("");
    setRoles(["vendedor_pollo"] as Role[]);
    setSellerCandyIdCreate("");
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");
    // When creating a new user, password is required and must be >=6
    if (!editingId) {
      if (password.length < 6) {
        setMessage("❌ La contraseña debe tener al menos 6 caracteres.");
        return;
      }
    } else {
      // editing: password is optional; if provided must be >=6
      if (password && password.length > 0 && password.length < 6) {
        setMessage("❌ La contraseña debe tener al menos 6 caracteres.");
        return;
      }
    }
    if (!name.trim()) {
      setMessage("❌ El nombre es obligatorio.");
      return;
    }

    try {
      // If editing an existing user -> update Firestore only and optionally send a reset email
      if (editingId) {
        const ref = doc(db, "users", editingId);
        const finalRoles = editRoles.length
          ? editRoles
          : (["vendedor_pollo"] as Role[]);
        const sellerCandyIdToSave = finalRoles.includes("vendedor_dulces")
          ? editSellerCandyId || sellerCandyIdCreate || ""
          : "";

        await updateDoc(ref, {
          email,
          name: name.trim(),
          roles: finalRoles,
          role: finalRoles[0] || "vendedor_pollo",
          sellerCandyId: sellerCandyIdToSave,
        });

        setUsers((prev) =>
          prev.map((x) =>
            x.id === editingId
              ? {
                  ...x,
                  email,
                  name: name.trim(),
                  roles: finalRoles,
                  sellerCandyId: sellerCandyIdToSave,
                }
              : x,
          ),
        );

        // If admin filled a new password, send password reset to the original auth email
        if (password && password.length >= 6) {
          try {
            const auth = getAuth();
            const targetEmail = origEmail || email;
            await sendPasswordResetEmail(auth, targetEmail);
            setMessage(
              `✅ Usuario actualizado. Se envió correo de restablecimiento a ${targetEmail}`,
            );
          } catch (err: any) {
            console.error("Error sending password reset:", err);
            setMessage(
              "✅ Usuario actualizado. No se pudo enviar correo de restablecimiento.",
            );
          }
        } else {
          setMessage("✅ Usuario actualizado correctamente.");
        }

        cancelEdit();
        return;
      }

      // 1) Crear instancia secundaria que NO afecta tu sesión actual
      const primaryApp = getApp(); // tu app principal ya inicializada
      const secondaryApp = initializeApp(
        primaryApp.options as any,
        "Secondary",
      );
      const secondaryAuth = getAuth(secondaryApp);

      // 2) Crear el usuario en la instancia secundaria (no te desloguea)
      const userCred = await createUserWithEmailAndPassword(
        secondaryAuth,
        email,
        password,
      );

      // 3) Guardar su perfil en Firestore (colección users)
      const finalRoles = roles.length ? roles : (["vendedor_pollo"] as Role[]);
      const sellerCandyIdToSave = finalRoles.includes("vendedor_dulces")
        ? sellerCandyIdCreate || ""
        : "";

      await setDoc(doc(collection(db, "users"), userCred.user.uid), {
        email,
        name: name.trim(),
        roles: finalRoles,
        role: finalRoles[0] || "vendedor_pollo",
        sellerCandyId: sellerCandyIdToSave,
      });

      // 4) Cerrar sesión de la instancia secundaria y limpiarla
      await signOut(secondaryAuth);
      await deleteApp(secondaryApp);

      // 5) Refrescar UI localmente
      setUsers((prev) => [
        {
          id: userCred.user.uid,
          email,
          name: name.trim(),
          roles: finalRoles,
          sellerCandyId: sellerCandyIdToSave,
        },
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
    // Open the create modal populated with the user's data for editing
    setEditingId(u.id);
    setName(u.name || "");
    setEmail(u.email || "");
    setOrigEmail(u.email || "");
    setEditRoles(
      u.roles && u.roles.length ? u.roles : (["vendedor_pollo"] as Role[]),
    );
    setSellerCandyIdCreate(u.sellerCandyId || "");
    setEditSellerCandyId(u.sellerCandyId || "");
    setPassword("");
    setShowCreateModal(true);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditRoles(["vendedor_pollo"] as Role[]);
    setEditSellerCandyId("");
    setOrigEmail("");
    resetCreateForm();
    setShowCreateModal(false);
  };

  // Note: we will handle both create and edit in handleRegister

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
        : r === "supervisor_pollo"
          ? "supervisor_pollo"
          : r === "vendedor_ropa"
            ? "vendedor_ropa"
            : r === "vendedor_dulces"
              ? "vendedor_dulces"
              : "vendedor_pollo";

    const cls =
      label === "admin"
        ? "bg-blue-100 text-blue-700"
        : label === "supervisor_pollo"
          ? "bg-amber-100 text-amber-700"
          : label === "vendedor_ropa"
            ? "bg-indigo-100 text-indigo-700"
            : label === "vendedor_dulces"
              ? "bg-pink-100 text-pink-700"
              : "bg-green-100 text-green-700";

    return (
      <span className={`px-2 py-0.5 rounded text-xs ${cls}`}>{label}</span>
    );
  };

  const sellerLabel = (s: SellerCandy) =>
    `${s.name} — ${
      s.branchLabel || "Sin sucursal"
    } — ${s.commissionPercent.toFixed(2)}%`;

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
                const isVendDulcesRow = (
                  isEditing ? editRoles : u.roles
                ).includes("vendedor_dulces");

                return (
                  <tr key={u.id} className="text-center">
                    <td className="p-2 border">{u.name || "—"}</td>
                    <td className="p-2 border">{u.email}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <div className="space-y-2 text-left">
                          {[
                            "supervisor_pollo",
                            "admin",
                            "vendedor_pollo",
                            "vendedor_ropa",
                            "vendedor_dulces",
                          ].map((opt) => (
                            <label
                              key={opt}
                              className="inline-flex items-center mr-3"
                            >
                              <input
                                type="checkbox"
                                className="mr-2"
                                checked={editRoles.includes(opt as Role)}
                                onChange={() =>
                                  setEditRoles((prev) =>
                                    prev.includes(opt as Role)
                                      ? prev.filter((x) => x !== (opt as Role))
                                      : [...prev, opt as Role],
                                  )
                                }
                              />
                              <span className="text-sm">{opt}</span>
                            </label>
                          ))}

                          {editRoles.includes("vendedor_dulces") && (
                            <select
                              className="w-full border p-1 rounded text-xs mt-1"
                              value={editSellerCandyId}
                              onChange={(e) =>
                                setEditSellerCandyId(e.target.value)
                              }
                            >
                              <option value="">
                                Selecciona vendedor de dulces
                              </option>
                              {sellersCandy.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {sellerLabel(s)}
                                </option>
                              ))}
                            </select>
                          )}
                        </div>
                      ) : (
                        <>
                          <div className="flex gap-2 justify-center">
                            {u.roles.map((r) => (
                              <span key={r}>{roleBadge(r)}</span>
                            ))}
                          </div>
                          {isVendDulcesRow && u.sellerCandyId && (
                            <div className="mt-1 text-[11px] text-gray-500">
                              Vendedor asignado
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-2 border space-x-2">
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
              <h3 className="text-lg font-bold">
                {editingId ? "Editar usuario" : "Registrar nuevo usuario"}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={cancelEdit}
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
                  required={!editingId}
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
                  Roles
                </label>
                <div className="flex flex-wrap gap-2">
                  {[
                    "supervisor_pollo",
                    "contador",
                    "admin",
                    "vendedor_pollo",
                    "vendedor_ropa",
                    "vendedor_dulces",
                  ].map((opt) => (
                    <label key={opt} className="inline-flex items-center mr-3">
                      <input
                        type="checkbox"
                        className="mr-2"
                        checked={
                          editingId
                            ? editRoles.includes(opt as Role)
                            : roles.includes(opt as Role)
                        }
                        onChange={() => {
                          if (editingId) {
                            setEditRoles((prev) =>
                              prev.includes(opt as Role)
                                ? prev.filter((x) => x !== (opt as Role))
                                : [...prev, opt as Role],
                            );
                          } else {
                            setRoles((prev) =>
                              prev.includes(opt as Role)
                                ? prev.filter((x) => x !== (opt as Role))
                                : [...prev, opt as Role],
                            );
                          }
                        }}
                      />
                      <span className="text-sm">{opt}</span>
                    </label>
                  ))}
                </div>
              </div>

              {(editingId
                ? editRoles.includes("vendedor_dulces")
                : roles.includes("vendedor_dulces")) && (
                <div className="space-y-1">
                  <label className="block text-sm font-semibold text-gray-700">
                    Vendedor (dulces)
                  </label>
                  <select
                    className="w-full border p-2 rounded text-sm"
                    value={sellerCandyIdCreate}
                    onChange={(e) => setSellerCandyIdCreate(e.target.value)}
                  >
                    <option value="">
                      Selecciona vendedor de dulces asignado
                    </option>
                    {sellersCandy.map((s) => (
                      <option key={s.id} value={s.id}>
                        {sellerLabel(s)}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={cancelEdit}
                >
                  Cancelar
                </button>
                <button className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700">
                  {editingId ? "Guardar cambios" : "Crear usuario"}
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
