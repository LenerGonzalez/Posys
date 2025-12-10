// src/components/Candies/SellersCandies.tsx
import React, { useEffect, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../../firebase";
import RefreshButton from "../../common/RefreshButton";
import useManualRefresh from "../../../hooks/useManualRefresh";

type Branch = "Rivas" | "Isla Ometepe" | "San Jorge";

interface SellerRow {
  id: string;
  name: string; // nombre y apellido
  commissionPercent: number; // comisión % sobre la venta
  branch: Branch; // sucursal a la que pertenece
  createdAt: Timestamp;
}

const BRANCHES: Branch[] = ["Rivas", "Isla Ometepe", "San Jorge"];

export default function SellersCandies() {
  const { refreshKey, refresh } = useManualRefresh();

  const [rows, setRows] = useState<SellerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Form nuevo vendedor
  const [openForm, setOpenForm] = useState(false);
  const [name, setName] = useState("");
  const [commission, setCommission] = useState<string>("0");
  const [branch, setBranch] = useState<Branch>("Rivas");

  // Edición
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCommission, setEditCommission] = useState<string>("0");
  const [editBranch, setEditBranch] = useState<Branch>("Rivas");

  // ====== Cargar vendedores ======
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const qS = query(
          collection(db, "sellers_candies"),
          orderBy("name", "asc")
        );
        const snap = await getDocs(qS);
        const list: SellerRow[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name || "",
            commissionPercent: Number(x.commissionPercent || 0),
            branch: (x.branch as Branch) || "Rivas",
            createdAt: x.createdAt || Timestamp.now(),
          });
        });
        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando vendedores.");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  const resetForm = () => {
    setName("");
    setCommission("0");
    setBranch("Rivas");
  };

  // ====== Crear vendedor ======
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    const nameTrim = name.trim();
    if (!nameTrim) {
      setMsg("Ingresa el nombre y apellido del vendedor.");
      return;
    }

    const commissionNum = Number(commission || 0);
    if (commissionNum < 0) {
      setMsg("La comisión no puede ser negativa.");
      return;
    }

    try {
      const docData = {
        name: nameTrim,
        commissionPercent: commissionNum,
        branch,
        createdAt: Timestamp.now(),
      };

      const ref = await addDoc(collection(db, "sellers_candies"), docData);

      setRows((prev) => [
        {
          id: ref.id,
          ...docData,
        },
        ...prev,
      ]);

      setMsg("✅ Vendedor creado correctamente.");
      resetForm();
      setOpenForm(false);
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al crear el vendedor.");
    }
  };

  // ====== Iniciar edición ======
  const startEdit = (row: SellerRow) => {
    setEditingId(row.id);
    setEditName(row.name);
    setEditCommission(row.commissionPercent.toString());
    setEditBranch(row.branch);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditCommission("0");
    setEditBranch("Rivas");
  };

  // ====== Guardar edición ======
  const saveEdit = async () => {
    if (!editingId) return;
    setMsg("");

    const nameTrim = editName.trim();
    if (!nameTrim) {
      setMsg("El nombre y apellido no pueden estar vacíos.");
      return;
    }

    const commissionNum = Number(editCommission || 0);
    if (commissionNum < 0) {
      setMsg("La comisión no puede ser negativa.");
      return;
    }

    try {
      await updateDoc(doc(db, "sellers_candies", editingId), {
        name: nameTrim,
        commissionPercent: commissionNum,
        branch: editBranch,
      });

      setRows((prev) =>
        prev.map((r) =>
          r.id === editingId
            ? {
                ...r,
                name: nameTrim,
                commissionPercent: commissionNum,
                branch: editBranch,
              }
            : r
        )
      );

      setMsg("✅ Vendedor actualizado.");
      cancelEdit();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al actualizar el vendedor.");
    }
  };

  // ====== Eliminar ======
  const handleDelete = async (row: SellerRow) => {
    const ok = window.confirm(
      `¿Eliminar al vendedor "${row.name}"? Esta acción no se puede deshacer.`
    );
    if (!ok) return;

    try {
      await deleteDoc(doc(db, "sellers_candies", row.id));
      setRows((prev) => prev.filter((x) => x.id !== row.id));
      setMsg("✅ Vendedor eliminado.");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al eliminar el vendedor.");
    }
  };

  return (
    <div className="max-w-5xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Vendedores de Dulces</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700"
            onClick={() => setOpenForm(true)}
          >
            <span className="inline-block bg-green-700/40 rounded-full p-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
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
            Nuevo vendedor
          </button>
        </div>
      </div>

      {/* MODAL NUEVO VENDEDOR */}
      {openForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4">Nuevo vendedor de dulces</h3>
            <form onSubmit={handleCreate} className="space-y-4 text-sm">
              {/* Nombre y apellido */}
              <div>
                <label className="block text-sm font-semibold">
                  Nombre y apellido
                </label>
                <input
                  className="w-full border p-2 rounded"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Juan Pérez"
                />
              </div>

              {/* Comisión */}
              <div>
                <label className="block text-sm font-semibold">
                  Comisión (% sobre venta total)
                </label>
                <input
                  type="number"
                  step="0.01"
                  min={0}
                  className="w-full border p-2 rounded"
                  value={commission}
                  onChange={(e) => setCommission(e.target.value)}
                  placeholder="Ej: 10"
                />
                <p className="text-[11px] text-gray-500 mt-1">
                  Este porcentaje se usa para calcular la comisión del vendedor
                  sobre el total de la venta (no es el margen del producto).
                </p>
              </div>

              {/* Sucursal */}
              <div>
                <label className="block text-sm font-semibold">Sucursal</label>
                <select
                  className="w-full border p-2 rounded"
                  value={branch}
                  onChange={(e) => setBranch(e.target.value as Branch)}
                >
                  {BRANCHES.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>

              {/* Botones */}
              <div className="flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={() => {
                    resetForm();
                    setOpenForm(false);
                  }}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  Guardar vendedor
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TABLA DE VENDEDORES */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto mt-3">
        <table className="min-w-[700px] text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border">Nombre y apellido</th>
              <th className="p-2 border">Comisión (%)</th>
              <th className="p-2 border">Sucursal</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Sin vendedores registrados.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isEditing = editingId === r.id;
                return (
                  <tr key={r.id} className="text-center whitespace-nowrap">
                    {/* Nombre */}
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="border p-1 rounded text-xs w-full"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      ) : (
                        r.name
                      )}
                    </td>

                    {/* Comisión */}
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          min={0}
                          className="border p-1 rounded text-xs w-24 text-right"
                          value={editCommission}
                          onChange={(e) => setEditCommission(e.target.value)}
                        />
                      ) : (
                        `${r.commissionPercent.toFixed(2)} %`
                      )}
                    </td>

                    {/* Sucursal */}
                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="border p-1 rounded text-xs"
                          value={editBranch}
                          onChange={(e) =>
                            setEditBranch(e.target.value as Branch)
                          }
                        >
                          {BRANCHES.map((b) => (
                            <option key={b} value={b}>
                              {b}
                            </option>
                          ))}
                        </select>
                      ) : (
                        r.branch
                      )}
                    </td>

                    {/* Acciones */}
                    <td className="p-2 border">
                      {isEditing ? (
                        <div className="flex gap-1 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-yellow-500 text-white hover:bg-yellow-600 text-xs"
                            onClick={() => startEdit(r)}
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                            onClick={() => handleDelete(r)}
                          >
                            Borrar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
