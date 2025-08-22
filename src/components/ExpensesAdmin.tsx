import React, { useEffect, useState } from "react";
import { db } from "../firebase";
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
import { format } from "date-fns";

const money = (n: unknown) => `C$${Number(n ?? 0).toFixed(2)}`;

export default function ExpensesAdmin(): React.ReactElement {
  const [rows, setRows] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  // form
  const [date, setDate] = useState(format(new Date(), "yyyy-MM-dd"));
  const [category, setCategory] = useState("Varios");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number>(0);
  // ✅ Nacen como PENDIENTE
  const [status, setStatus] = useState<"PAGADO" | "PENDIENTE">("PENDIENTE");
  const [msg, setMsg] = useState("");

  // edición fila
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eDate, setEDate] = useState("");
  const [eCategory, setECategory] = useState("");
  const [eDescription, setEDescription] = useState("");
  const [eAmount, setEAmount] = useState<number>(0);

  const reload = async () => {
    const qy = query(collection(db, "expenses"), orderBy("createdAt", "desc"));
    const snap = await getDocs(qy);
    const arr: any[] = [];
    snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
    setRows(arr);
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      await reload();
      setLoading(false);
    })();
  }, []);

  const save = async () => {
    try {
      await addDoc(collection(db, "expenses"), {
        date,
        category,
        description,
        amount: Number(amount) || 0,
        status, // nace como PENDIENTE (o el que elijas en el select)
        createdAt: Timestamp.now(),
      });
      setMsg("✅ Gasto registrado.");
      setDate(format(new Date(), "yyyy-MM-dd"));
      setCategory("Varios");
      setDescription("");
      setAmount(0);
      setStatus("PENDIENTE"); // ✅ reset a PENDIENTE
      await reload();
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo registrar el gasto.");
    }
  };

  const remove = async (id: string) => {
    if (!confirm("¿Eliminar gasto?")) return;
    await deleteDoc(doc(db, "expenses", id));
    setRows((r) => r.filter((x) => x.id !== id));
  };

  // ✅ Pagar gasto (cambiar a PAGADO y guardar paidAt)
  const pay = async (row: any) => {
    if (row.status === "PAGADO") return;
    const ref = doc(db, "expenses", row.id);
    await updateDoc(ref, { status: "PAGADO", paidAt: Timestamp.now() });
    setRows((prev) =>
      prev.map((x) =>
        x.id === row.id
          ? { ...x, status: "PAGADO", paidAt: Timestamp.now() }
          : x
      )
    );
  };

  // ✅ Edición
  const startEdit = (row: any) => {
    setEditingId(row.id);
    setEDate(row.date || "");
    setECategory(row.category || "Varios");
    setEDescription(row.description || "");
    setEAmount(Number(row.amount || 0));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEDate("");
    setECategory("Varios");
    setEDescription("");
    setEAmount(0);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const ref = doc(db, "expenses", editingId);
    await updateDoc(ref, {
      date: eDate,
      category: eCategory,
      description: eDescription,
      amount: Number(eAmount) || 0,
    });
    setRows((prev) =>
      prev.map((x) =>
        x.id === editingId
          ? {
              ...x,
              date: eDate,
              category: eCategory,
              description: eDescription,
              amount: Number(eAmount) || 0,
            }
          : x
      )
    );
    cancelEdit();
  };

  return (
    <div className="max-w-4xl mx-auto bg-white p-6 rounded shadow">
      <h2 className="text-2xl font-bold mb-4">Gastos</h2>

      <div className="grid grid-cols-1 md:grid-cols-6 gap-2 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Fecha</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Categoría</label>
          <input
            className="border rounded px-3 py-2 w-full"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
          />
        </div>
        <div className="md:col-span-2">
          <label className="block text-sm text-gray-600 mb-1">
            Descripción
          </label>
          <input
            className="border rounded px-3 py-2 w-full"
            value={description}
            onChange={(e) => setDescription(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Monto</label>
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            className="border rounded px-3 py-2 w-full"
            onKeyDown={(e) => {
              if (e.key === ",") {
                e.preventDefault();
                (e.target as HTMLInputElement).value += ".";
              }
            }}
            value={amount === 0 ? "" : amount}
            onChange={(e) =>
              setAmount(parseFloat((e.target.value || "0").replace(",", ".")))
            }
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Estado</label>
          <select
            className="border rounded px-3 py-2 w-full"
            value={status}
            onChange={(e) => setStatus(e.target.value as any)}
          >
            {/* Lo dejo para no romperte el flujo, pero ya nace PENDIENTE */}
            <option value="PENDIENTE">Pendiente</option>
            <option value="PAGADO">Pagado</option>
          </select>
        </div>
      </div>

      <button
        onClick={save}
        className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
      >
        Registrar gasto
      </button>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      <h3 className="font-semibold mt-6 mb-2">Listado</h3>
      {loading ? (
        <p>Cargando…</p>
      ) : (
        <table className="min-w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Categoría</th>
              <th className="border p-2">Descripción</th>
              <th className="border p-2">Monto</th>
              <th className="border p-2">Estado</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const isEditing = editingId === r.id;
              return (
                <tr key={r.id} className="text-center">
                  <td className="border p-1">
                    {isEditing ? (
                      <input
                        type="date"
                        className="border rounded px-2 py-1 w-full"
                        value={eDate}
                        onChange={(e) => setEDate(e.target.value)}
                      />
                    ) : (
                      r.date
                    )}
                  </td>
                  <td className="border p-1">
                    {isEditing ? (
                      <input
                        className="border rounded px-2 py-1 w-full"
                        value={eCategory}
                        onChange={(e) => setECategory(e.target.value)}
                      />
                    ) : (
                      r.category
                    )}
                  </td>
                  <td className="border p-1">
                    {isEditing ? (
                      <input
                        className="border rounded px-2 py-1 w-full"
                        value={eDescription}
                        onChange={(e) => setEDescription(e.target.value)}
                      />
                    ) : (
                      r.description
                    )}
                  </td>
                  <td className="border p-1">
                    {isEditing ? (
                      <input
                        type="number"
                        step="0.01"
                        className="border rounded px-2 py-1 w-full text-right"
                        value={Number.isNaN(eAmount) ? "" : eAmount}
                        onChange={(e) =>
                          setEAmount(parseFloat(e.target.value || "0"))
                        }
                      />
                    ) : (
                      money(r.amount)
                    )}
                  </td>
                  <td className="border p-1">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        r.status === "PAGADO"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {r.status}
                    </span>
                  </td>
                  <td className="border p-1 space-x-1">
                    {isEditing ? (
                      <>
                        <button
                          onClick={saveEdit}
                          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="text-xs bg-gray-200 px-2 py-1 rounded hover:bg-gray-300"
                        >
                          Cancelar
                        </button>
                      </>
                    ) : (
                      <>
                        {r.status === "PENDIENTE" && (
                          <button
                            onClick={() => pay(r)}
                            className="text-xs bg-green-600 text-white px-2 py-1 rounded hover:bg-green-700"
                          >
                            Pagar
                          </button>
                        )}
                        <button
                          onClick={() => startEdit(r)}
                          className="text-xs bg-yellow-600 text-white px-2 py-1 rounded hover:bg-yellow-700"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => remove(r.id)}
                          className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                        >
                          Eliminar
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              );
            })}
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="p-3 text-center text-gray-500">
                  Sin gastos aún.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      )}
    </div>
  );
}
