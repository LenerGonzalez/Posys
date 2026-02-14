import React, { useState } from "react";
import { addDoc, collection, Timestamp } from "firebase/firestore";
import { db } from "../../firebase";
import { format } from "date-fns";

const CATEGORIES = [
  "Energia",
  "Bolsas",
  "Detergentes",
  "Limpieza de Freezer",
  "Delivery",
  "Pago a Personal",
  "Varios",
] as const;

type Category = (typeof CATEGORIES)[number];
type Status = "PAGADO" | "PENDIENTE";

interface ExpenseFormProps {
  onCreated: (expense: any) => void;
  onClose: () => void;
}

export default function ExpenseFormModal({
  onCreated,
  onClose,
}: ExpenseFormProps) {
  const [dateStr, setDateStr] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [category, setCategory] = useState<Category | "">("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number>(0);
  const [status] = useState<Status>("PAGADO");
  const [notes, setNotes] = useState("");
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(false);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    if (!category) return setMsg("Selecciona una categoría.");
    if (!description.trim()) return setMsg("Ingresa una descripción.");
    if (!amount || amount <= 0) return setMsg("Ingresa un monto válido.");
    try {
      setLoading(true);
      const payload = {
        date: dateStr,
        category,
        description: description.trim(),
        amount: Number(Number(amount || 0).toFixed(2)),
        status: "PAGADO",
        notes: notes || "",
        createdAt: Timestamp.now(),
      };
      const ref = await addDoc(collection(db, "expenses"), payload);
      onCreated({ id: ref.id, ...payload });
      setMsg("✅ Gasto registrado");
      onClose();
    } catch (err) {
      setMsg("❌ Error al guardar gasto");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white w-full max-w-md rounded-xl shadow-xl p-6 relative">
        <div className="flex items-center mb-4">
          <h3 className="text-lg font-semibold">Crear gasto</h3>
          <button
            type="button"
            onClick={onClose}
            className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
          >
            Cerrar
          </button>
        </div>
        <form onSubmit={handleCreate} className="space-y-3">
          <div>
            <label className="block text-sm font-semibold">Fecha</label>
            <input
              type="date"
              className="w-full border p-2 rounded"
              value={dateStr}
              onChange={(e) => setDateStr(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-semibold">Categoría</label>
            <select
              className="w-full border p-2 rounded"
              value={category}
              onChange={(e) => setCategory(e.target.value as Category)}
            >
              <option value="">Selecciona</option>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="block text-sm font-semibold">Descripción</label>
            <input
              className="w-full border p-2 rounded"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-semibold">Monto</label>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className="w-full border p-2 rounded text-right"
              value={amount === 0 ? "" : amount}
              onChange={(e) => setAmount(Number(e.target.value))}
              placeholder="0.00"
            />
          </div>
          <div>
            <label className="block text-sm font-semibold">Estado</label>
            <input
              className="w-full border p-2 rounded bg-gray-100 text-gray-500 cursor-not-allowed"
              value="PAGADO"
              readOnly
              disabled
            />
          </div>
          <div>
            <label className="block text-sm font-semibold">Comentario</label>
            <textarea
              className="w-full border p-2 rounded resize-y min-h-20"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              placeholder="Comentario / nota opcional…"
            />
            <div className="text-xs text-gray-500 text-right">
              {notes.length}/500
            </div>
          </div>
          <div className="flex gap-2">
            <button
              className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              disabled={loading}
            >
              Guardar gasto
            </button>
            <button
              type="button"
              className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
              onClick={onClose}
            >
              Cancelar
            </button>
          </div>
          {msg && <div className="text-sm mt-2">{msg}</div>}
        </form>
      </div>
    </div>
  );
}
