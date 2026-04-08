// src/components/UserRegisterForm.tsx
import React, { useEffect, useState } from "react";
import { getAuth, signOut, sendPasswordResetEmail } from "firebase/auth";
import Button from "./common/Button";
import ActionMenu, { ActionMenuTrigger } from "./common/ActionMenu";
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

  const [userRowMenu, setUserRowMenu] = useState<{
    userId: string;
    rect: DOMRect;
  } | null>(null);

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
          ? String(
              editingId ? editSellerCandyId : sellerCandyIdCreate,
            ).trim()
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
          : r === "contador"
            ? "contador"
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
          : label === "contador"
            ? "bg-emerald-100 text-emerald-700"
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
    <div className="mx-auto max-w-6xl p-3 md:p-6">
      {/* Botón abrir modal crear */}
      <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="text-lg font-bold tracking-tight text-slate-900 md:text-2xl">
            Usuarios
          </h2>
          <p className="mt-0.5 text-xs text-slate-500 md:text-sm">
            Alta y edición de cuentas, roles y vendedor de dulces.
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          size="sm"
          className="!rounded-lg bg-indigo-600 shadow-none hover:bg-indigo-700 active:bg-indigo-800"
          onClick={() => {
            setEditingId(null);
            setEditRoles(["vendedor_pollo"] as Role[]);
            setEditSellerCandyId("");
            setOrigEmail("");
            resetCreateForm();
            setShowCreateModal(true);
          }}
        >
          Crear usuario
        </Button>
      </div>

      {/* Tabla */}
      <div className="overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm ring-1 ring-slate-900/[0.04]">
        <div className="border-b border-slate-200/90 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
          <div className="text-sm text-slate-700">
            <span className="font-semibold text-slate-900">
              {loadingList ? "…" : users.length}
            </span>{" "}
            usuario{users.length === 1 ? "" : "s"}
          </div>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-xs">
            <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100/95 backdrop-blur-sm">
              <tr className="whitespace-nowrap">
                <th className="border-b border-slate-200 p-2.5 text-left font-semibold text-slate-700">
                  Nombre
                </th>
                <th className="border-b border-slate-200 p-2.5 text-left font-semibold text-slate-700">
                  Email
                </th>
                <th className="border-b border-slate-200 p-2.5 text-left font-semibold text-slate-700">
                  Rol
                </th>
                <th className="border-b border-slate-200 p-2.5 text-center font-semibold text-slate-700">
                  Acciones
                </th>
              </tr>
            </thead>
            <tbody>
            {loadingList ? (
              <tr>
                <td
                  colSpan={4}
                  className="p-10 text-center text-sm text-slate-500"
                >
                  Cargando…
                </td>
              </tr>
            ) : users.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="p-10 text-center text-sm text-slate-500"
                >
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
                  <tr
                    key={u.id}
                    className="border-b border-slate-100 transition-colors hover:bg-slate-50/90"
                  >
                    <td className="p-2.5 text-left font-medium text-slate-900">
                      {u.name || "—"}
                    </td>
                    <td className="p-2.5 text-left text-slate-600">{u.email}</td>
                    <td className="p-2.5 text-left">
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
                              className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
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
                            <div className="mt-1 text-[11px] text-slate-500">
                              Vendedor asignado
                            </div>
                          )}
                        </>
                      )}
                    </td>
                    <td className="p-2.5 text-center align-middle">
                      <ActionMenuTrigger
                        className="!h-8 !w-8 rounded-lg border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                        aria-label="Acciones del usuario"
                        iconClassName="h-5 w-5 text-slate-700"
                        onClick={(e) =>
                          setUserRowMenu({
                            userId: u.id,
                            rect: (
                              e.currentTarget as HTMLElement
                            ).getBoundingClientRect(),
                          })
                        }
                      />
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>

      <ActionMenu
        anchorRect={userRowMenu?.rect ?? null}
        isOpen={!!userRowMenu}
        onClose={() => setUserRowMenu(null)}
        width={200}
      >
        {userRowMenu && (
          <div className="py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
              onClick={() => {
                const u = users.find((x) => x.id === userRowMenu.userId);
                setUserRowMenu(null);
                if (u) startEdit(u);
              }}
            >
              Editar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700 hover:!bg-red-50"
              onClick={() => {
                const id = userRowMenu.userId;
                setUserRowMenu(null);
                void deleteUserDoc(id);
              }}
            >
              Eliminar
            </Button>
          </div>
        )}
      </ActionMenu>

      {message && (
        <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">
          {message}
        </p>
      )}

      {/* ===== Modal: Crear usuario ===== */}
      {showCreateModal && (
        <div
          className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-900/50 p-2 backdrop-blur-[3px] md:p-6"
          role="presentation"
        >
          <div
            className="absolute inset-0"
            onClick={cancelEdit}
            aria-hidden
          />
          <div
            className="relative max-h-[92vh] w-[96%] max-w-lg overflow-auto rounded-2xl border border-slate-200/80 bg-white p-4 shadow-2xl shadow-slate-900/12 ring-1 ring-slate-900/[0.04] md:p-6"
            role="dialog"
            aria-modal="true"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-3 border-b border-slate-200/90 pb-3">
              <h3 className="text-base font-bold tracking-tight text-slate-900 md:text-lg">
                {editingId ? "Editar usuario" : "Registrar nuevo usuario"}
              </h3>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="!rounded-lg border-slate-200 shadow-sm"
                onClick={cancelEdit}
              >
                Cerrar
              </Button>
            </div>

            <form onSubmit={handleRegister} className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-semibold text-slate-700">
                  Nombre completo
                </label>
                <input
                  type="text"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  required
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-slate-700">
                  Correo electrónico
                </label>
                <input
                  type="email"
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  required
                />
              </div>

              <div className="relative space-y-1">
                <label className="block text-sm font-semibold text-slate-700">
                  Contraseña (mínimo 6 caracteres)
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  minLength={6}
                  className="w-full rounded-lg border border-slate-200 px-3 py-2 pr-10 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  required={!editingId}
                />
                <button
                  type="button"
                  className="absolute right-2 top-[2.125rem] text-sm text-slate-600 hover:text-slate-900"
                  onClick={() => setShowPassword((v) => !v)}
                >
                  {showPassword ? "🙈" : "👁️"}
                </button>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-slate-700">
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
                    <label
                      key={opt}
                      className="mr-3 inline-flex items-center text-sm text-slate-700"
                    >
                      <input
                        type="checkbox"
                        className="mr-2 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500/30"
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
                      <span>{opt}</span>
                    </label>
                  ))}
                </div>
              </div>

              {(editingId
                ? editRoles.includes("vendedor_dulces")
                : roles.includes("vendedor_dulces")) && (
                <div className="space-y-1">
                  <label className="block text-sm font-semibold text-slate-700">
                    Vendedor (dulces)
                  </label>
                  <select
                    className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                    value={
                      editingId ? editSellerCandyId : sellerCandyIdCreate
                    }
                    onChange={(e) =>
                      editingId
                        ? setEditSellerCandyId(e.target.value)
                        : setSellerCandyIdCreate(e.target.value)
                    }
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

              <div className="flex justify-end gap-2 border-t border-slate-200/90 pt-4">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="!rounded-lg border-slate-200 shadow-sm"
                  onClick={cancelEdit}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  className="!rounded-lg bg-indigo-600 shadow-none hover:bg-indigo-700 active:bg-indigo-800"
                >
                  {editingId ? "Guardar cambios" : "Crear usuario"}
                </Button>
              </div>
            </form>

            {message && (
              <p className="mt-3 text-sm text-slate-700">{message}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
