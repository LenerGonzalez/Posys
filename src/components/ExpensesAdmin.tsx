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
  const [status, setStatus] = useState<"PAGADO" | "PENDIENTE">("PAGADO");
  const [msg, setMsg] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      const qy = query(
        collection(db, "expenses"),
        orderBy("createdAt", "desc")
      );
      const snap = await getDocs(qy);
      const arr: any[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        arr.push({ id: d.id, ...x });
      });
      setRows(arr);
      setLoading(false);
    };
    load();
  }, []);

  const save = async () => {
    try {
      await addDoc(collection(db, "expenses"), {
        date,
        category,
        description,
        amount: Number(amount) || 0,
        status,
        createdAt: Timestamp.now(),
      });
      setMsg("✅ Gasto registrado.");
      setDate(format(new Date(), "yyyy-MM-dd"));
      setCategory("Varios");
      setDescription("");
      setAmount(0);
      setStatus("PAGADO");
      // refrescar simple
      const snap = await getDocs(collection(db, "expenses"));
      const arr: any[] = [];
      snap.forEach((d) => arr.push({ id: d.id, ...d.data() }));
      setRows(arr);
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

  return (
    <div className="max-w-4xl mx-auto bg-white p-6 rounded shadow">
      <h2 className="text-2xl font-bold mb-4">Gastos</h2>

      <div className="grid grid-cols-1 md:grid-cols-5 gap-2 mb-4">
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
            <option value="PAGADO">Pagado</option>
            <option value="PENDIENTE">Pendiente</option>
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
            {rows.map((r) => (
              <tr key={r.id} className="text-center">
                <td className="border p-1">{r.date}</td>
                <td className="border p-1">{r.category}</td>
                <td className="border p-1">{r.description}</td>
                <td className="border p-1">{money(r.amount)}</td>
                <td className="border p-1">{r.status}</td>
                <td className="border p-1">
                  <button
                    onClick={() => remove(r.id)}
                    className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                  >
                    Eliminar
                  </button>
                </td>
              </tr>
            ))}
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
