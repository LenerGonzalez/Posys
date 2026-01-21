// src/components/Chicken/ExpensesAdmin.tsx
import React, { useEffect, useMemo, useState } from "react";
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
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

// Puedes ajustar estas categorías cuando quieras
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

interface ExpenseRow {
  id: string;
  date: string; // yyyy-MM-dd
  category: Category | "";
  description: string;
  amount: number;
  status: Status;
  notes?: string;
  createdAt: Timestamp;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

export default function ExpensesAdmin() {
  const { refreshKey, refresh } = useManualRefresh();

  // ====== Filtros por fecha ======
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd"),
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd"),
  );

  // ====== Formulario (crear) ======
  const [dateStr, setDateStr] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [category, setCategory] = useState<Category | "">("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number>(0);
  const [status, setStatus] = useState<Status>("PENDIENTE");
  const [notes, setNotes] = useState("");

  // ====== Lista ======
  const [rows, setRows] = useState<ExpenseRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // ====== Edición ======
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eDate, setEDate] = useState<string>("");
  const [eCategory, setECategory] = useState<Category | "">("");
  const [eDescription, setEDescription] = useState<string>("");
  const [eAmount, setEAmount] = useState<number>(0);
  const [eStatus, setEStatus] = useState<Status>("PENDIENTE");
  const [eNotes, setENotes] = useState<string>("");

  // Mobile collapsible states
  const [formOpen, setFormOpen] = useState<boolean>(false);
  const toggleForm = () => setFormOpen((v) => !v);
  const [expandedExpenseId, setExpandedExpenseId] = useState<string | null>(
    null,
  );
  const toggleMobileExpense = (id: string) =>
    setExpandedExpenseId((prev) => (prev === id ? null : id));

  // ====== Cargar gastos ======
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const qE = query(collection(db, "expenses"), orderBy("date", "desc"));
        const snap = await getDocs(qE);
        const list: ExpenseRow[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            date: x.date || format(new Date(), "yyyy-MM-dd"),
            category: x.category || "",
            description: x.description || "",
            amount: Number(x.amount || 0),
            status: (x.status as Status) || "PENDIENTE",
            notes: x.notes || "",
            createdAt: x.createdAt ?? Timestamp.now(),
          });
        });
        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error al cargar gastos");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  // ====== Lista filtrada por rango ======
  const filteredRows = useMemo(() => {
    return rows.filter((r) => {
      if (fromDate && r.date < fromDate) return false;
      if (toDate && r.date > toDate) return false;
      return true;
    });
  }, [rows, fromDate, toDate]);

  // Totales
  const totals = useMemo(() => {
    const total = filteredRows.reduce((a, r) => a + (r.amount || 0), 0);
    const pagado = filteredRows
      .filter((r) => r.status === "PAGADO")
      .reduce((a, r) => a + (r.amount || 0), 0);
    const pendiente = total - pagado;
    return { total, pagado, pendiente };
  }, [filteredRows]);

  // ====== Crear gasto ======
  const resetForm = () => {
    setDateStr(format(new Date(), "yyyy-MM-dd"));
    setCategory("");
    setDescription("");
    setAmount(0);
    setStatus("PENDIENTE");
    setNotes("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!category) return setMsg("Selecciona una categoría.");
    if (!description.trim()) return setMsg("Ingresa una descripción.");
    if (!amount || amount <= 0) return setMsg("Ingresa un monto válido.");

    try {
      const payload = {
        date: dateStr,
        category,
        description: description.trim(),
        amount: Number(Number(amount || 0).toFixed(2)),
        status,
        notes: notes || "",
        createdAt: Timestamp.now(),
      };

      const ref = await addDoc(collection(db, "expenses"), payload);

      setRows((prev) => [{ id: ref.id, ...payload }, ...prev]);
      resetForm();
      setMsg("✅ Gasto registrado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar gasto");
    }
  };

  // ====== Editar / borrar ======
  const startEdit = (r: ExpenseRow) => {
    setMsg("");
    setEditingId(r.id);
    setEDate(r.date);
    setECategory(r.category || "");
    setEDescription(r.description || "");
    setEAmount(Number(r.amount || 0));
    setEStatus(r.status || "PENDIENTE");
    setENotes(r.notes || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEDate("");
    setECategory("");
    setEDescription("");
    setEAmount(0);
    setEStatus("PENDIENTE");
    setENotes("");
  };

  const saveEdit = async () => {
    if (!editingId) return;

    if (!eCategory) return setMsg("Selecciona una categoría.");
    if (!eDescription.trim()) return setMsg("Ingresa una descripción.");
    if (!eAmount || eAmount <= 0) return setMsg("Ingresa un monto válido.");

    try {
      const payload = {
        date: eDate,
        category: eCategory,
        description: eDescription.trim(),
        amount: Number(Number(eAmount || 0).toFixed(2)),
        status: eStatus,
        notes: eNotes || "",
      };

      await updateDoc(doc(db, "expenses", editingId), payload);

      setRows((prev) =>
        prev.map((x) => (x.id === editingId ? { ...x, ...payload } : x)),
      );
      cancelEdit();
      setMsg("✅ Gasto actualizado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al actualizar gasto");
    }
  };

  const handleDelete = async (r: ExpenseRow) => {
    const ok = confirm(`¿Eliminar el gasto "${r.description}"?`);
    if (!ok) return;

    try {
      await deleteDoc(doc(db, "expenses", r.id));
      setRows((prev) => prev.filter((x) => x.id !== r.id));
      setMsg("🗑️ Gasto borrado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al borrar gasto");
    }
  };

  const badge = (s: Status) =>
    s === "PAGADO"
      ? "bg-green-100 text-green-700"
      : "bg-yellow-100 text-yellow-700";

  return (
    <div className="max-w-6xl mx-auto px-3 sm:px-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Gastos (Pollo)</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {/* ===== Filtros ===== */}
      <div className="bg-white p-3 rounded-2xl shadow-2xl border mb-4 flex flex-col sm:flex-row sm:items-end gap-3 text-sm">
        <div className="flex gap-3">
          <div className="flex flex-col">
            <label className="font-semibold">Desde</label>
            <input
              type="date"
              className="border rounded px-2 py-1"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
            />
          </div>
          <div className="flex flex-col">
            <label className="font-semibold">Hasta</label>
            <input
              type="date"
              className="border rounded px-2 py-1"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
            />
          </div>
        </div>

        <div className="sm:ml-auto text-sm bg-gray-50 border rounded-xl p-3">
          <div className="font-semibold">Totales del rango</div>
          <div>Total: {money(totals.total)}</div>
          <div>Pagado: {money(totals.pagado)}</div>
          <div>Pendiente: {money(totals.pendiente)}</div>
        </div>
      </div>

      {/* ===== Formulario ===== */}
      {/* Mobile: collapsible */}
      <div className="md:hidden mb-4">
        <button
          type="button"
          onClick={toggleForm}
          className="w-full text-left px-3 py-3 flex items-center justify-between bg-white border rounded-2xl"
        >
          <div>
            <div className="font-semibold">Crear gasto</div>
            <div className="text-xs text-gray-600">
              Fecha: {dateStr} • Monto: {amount === 0 ? "—" : money(amount)}
            </div>
          </div>
          <div className="text-gray-500">{formOpen ? "▲" : "▼"}</div>
        </button>

        {formOpen && (
          <form
            onSubmit={handleCreate}
            className="mt-3 bg-white p-4 rounded-2xl shadow-2xl border grid grid-cols-1 gap-4"
          >
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
                placeholder="Detalle del gasto…"
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
                onChange={(e) => {
                  const raw = String(e.target.value || "").replace(",", ".");
                  const num = parseFloat(raw);
                  setAmount(Number.isFinite(num) ? Math.max(0, num) : 0);
                }}
                placeholder="0.00"
              />
            </div>

            <div>
              <label className="block text-sm font-semibold">Estado</label>
              <select
                className="w-full border p-2 rounded"
                value={status}
                onChange={(e) => setStatus(e.target.value as Status)}
              >
                <option value="PENDIENTE">Pendiente</option>
                <option value="PAGADO">Pagado</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-semibold">Comentario</label>
              <textarea
                className="w-full border p-2 rounded resize-y min-h-24"
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
              <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                Guardar gasto
              </button>
              <button
                type="button"
                className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
                onClick={resetForm}
              >
                Limpiar
              </button>
            </div>
          </form>
        )}
      </div>

      {/* Desktop: original form (visible md+) */}
      <div className="hidden md:block">
        <form
          onSubmit={handleCreate}
          className="bg-white p-4 rounded-2xl shadow-2xl border mb-6 grid grid-cols-1 md:grid-cols-2 gap-4"
        >
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

          <div className="md:col-span-2">
            <label className="block text-sm font-semibold">Descripción</label>
            <input
              className="w-full border p-2 rounded"
              placeholder="Detalle del gasto…"
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
              onChange={(e) => {
                const raw = String(e.target.value || "").replace(",", ".");
                const num = parseFloat(raw);
                setAmount(Number.isFinite(num) ? Math.max(0, num) : 0);
              }}
              placeholder="0.00"
            />
          </div>

          <div>
            <label className="block text-sm font-semibold">Estado</label>
            <select
              className="w-full border p-2 rounded"
              value={status}
              onChange={(e) => setStatus(e.target.value as Status)}
            >
              <option value="PENDIENTE">Pendiente</option>
              <option value="PAGADO">Pagado</option>
            </select>
          </div>

          <div className="md:col-span-2">
            <label className="block text-sm font-semibold">Comentario</label>
            <textarea
              className="w-full border p-2 rounded resize-y min-h-24"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              maxLength={500}
              placeholder="Comentario / nota opcional…"
            />
            <div className="text-xs text-gray-500 text-right">
              {notes.length}/500
            </div>
          </div>

          <div className="md:col-span-2 flex gap-2">
            <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
              Guardar gasto
            </button>
            <button
              type="button"
              className="bg-gray-200 px-4 py-2 rounded hover:bg-gray-300"
              onClick={resetForm}
            >
              Limpiar
            </button>
          </div>
        </form>
      </div>

      {/* ===== LISTA MOBILE FIRST: cards en móvil ===== */}
      <div className="block md:hidden space-y-3">
        {loading ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            Cargando…
          </div>
        ) : filteredRows.length === 0 ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            Sin gastos en el rango seleccionado.
          </div>
        ) : (
          filteredRows.map((r) => {
            const expanded = expandedExpenseId === r.id;
            const isEditing = editingId === r.id;
            return (
              <div
                key={r.id}
                className="bg-white border rounded-2xl overflow-hidden"
              >
                <button
                  type="button"
                  className="w-full text-left px-3 py-3 flex items-start justify-between bg-white"
                  onClick={() => toggleMobileExpense(r.id)}
                >
                  <div className="min-w-0">
                    <div className="font-semibold truncate">
                      {r.description}
                    </div>
                    <div className="text-xs text-gray-500">
                      {r.category || "—"} • {r.date}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="font-bold">{money(r.amount)}</div>
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${badge(r.status)}`}
                    >
                      {r.status}
                    </span>
                  </div>
                </button>

                {expanded && (
                  <div className="p-3">
                    <div className="mt-2 text-xs text-gray-600">
                      {r.notes ? r.notes : "—"}
                    </div>

                    {isEditing ? (
                      <div className="mt-3 grid grid-cols-1 gap-2 text-sm">
                        <input
                          type="date"
                          className="w-full border p-2 rounded"
                          value={eDate}
                          onChange={(e) => setEDate(e.target.value)}
                        />
                        <select
                          className="w-full border p-2 rounded"
                          value={eCategory}
                          onChange={(e) =>
                            setECategory(e.target.value as Category)
                          }
                        >
                          <option value="">Selecciona</option>
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                        <input
                          className="w-full border p-2 rounded"
                          value={eDescription}
                          onChange={(e) => setEDescription(e.target.value)}
                        />
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-full border p-2 rounded text-right"
                          value={Number.isNaN(eAmount) ? "" : eAmount}
                          onChange={(e) => {
                            const raw = String(e.target.value || "").replace(
                              ",",
                              ".",
                            );
                            const num = parseFloat(raw);
                            setEAmount(
                              Number.isFinite(num) ? Math.max(0, num) : 0,
                            );
                          }}
                        />
                        <select
                          className="w-full border p-2 rounded"
                          value={eStatus}
                          onChange={(e) => setEStatus(e.target.value as Status)}
                        >
                          <option value="PENDIENTE">Pendiente</option>
                          <option value="PAGADO">Pagado</option>
                        </select>
                        <textarea
                          className="w-full border p-2 rounded resize-y min-h-20"
                          value={eNotes}
                          onChange={(e) => setENotes(e.target.value)}
                          maxLength={500}
                        />

                        <div className="flex gap-2">
                          <button
                            type="button"
                            className="flex-1 px-3 py-2 rounded text-white bg-blue-600 hover:bg-blue-700"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            type="button"
                            className="flex-1 px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex gap-2">
                        <button
                          type="button"
                          className="flex-1 px-3 py-2 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                          onClick={() => startEdit(r)}
                        >
                          Editar
                        </button>
                        <button
                          type="button"
                          className="flex-1 px-3 py-2 rounded text-white bg-red-600 hover:bg-red-700"
                          onClick={() => handleDelete(r)}
                        >
                          Borrar
                        </button>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ===== TABLA (md+) ===== */}
      <div className="hidden md:block bg-white p-2 rounded-2xl shadow-2xl border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Descripción</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Comentario</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={7}>
                  Cargando…
                </td>
              </tr>
            ) : filteredRows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={7}>
                  Sin gastos en el rango seleccionado.
                </td>
              </tr>
            ) : (
              filteredRows.map((r) => {
                const isEditing = editingId === r.id;
                return (
                  <tr key={r.id} className="text-center">
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="date"
                          className="w-full border p-1 rounded"
                          value={eDate}
                          onChange={(e) => setEDate(e.target.value)}
                        />
                      ) : (
                        r.date
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={eCategory}
                          onChange={(e) =>
                            setECategory(e.target.value as Category)
                          }
                        >
                          <option value="">Selecciona</option>
                          {CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ) : (
                        r.category || "—"
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="w-full border p-1 rounded"
                          value={eDescription}
                          onChange={(e) => setEDescription(e.target.value)}
                        />
                      ) : (
                        <span title={r.description}>
                          {r.description.length > 45
                            ? r.description.slice(0, 45) + "…"
                            : r.description}
                        </span>
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-full border p-1 rounded text-right"
                          value={Number.isNaN(eAmount) ? "" : eAmount}
                          onChange={(e) => {
                            const raw = String(e.target.value || "").replace(
                              ",",
                              ".",
                            );
                            const num = parseFloat(raw);
                            setEAmount(
                              Number.isFinite(num) ? Math.max(0, num) : 0,
                            );
                          }}
                        />
                      ) : (
                        money(r.amount)
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={eStatus}
                          onChange={(e) => setEStatus(e.target.value as Status)}
                        >
                          <option value="PENDIENTE">Pendiente</option>
                          <option value="PAGADO">Pagado</option>
                        </select>
                      ) : (
                        <span
                          className={`px-2 py-0.5 rounded text-xs ${badge(
                            r.status,
                          )}`}
                        >
                          {r.status}
                        </span>
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEditing ? (
                        <textarea
                          className="w-full border p-1 rounded resize-y min-h-10"
                          value={eNotes}
                          onChange={(e) => setENotes(e.target.value)}
                          maxLength={500}
                        />
                      ) : (
                        <span title={r.notes || ""}>
                          {(r.notes || "").length > 45
                            ? (r.notes || "").slice(0, 45) + "…"
                            : r.notes || "—"}
                        </span>
                      )}
                    </td>

                    <td className="p-2 border">
                      <div className="flex gap-2 justify-center">
                        {isEditing ? (
                          <>
                            <button
                              type="button"
                              className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                              onClick={saveEdit}
                            >
                              Guardar
                            </button>
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                              onClick={cancelEdit}
                            >
                              Cancelar
                            </button>
                          </>
                        ) : (
                          <>
                            <button
                              type="button"
                              className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                              onClick={() => startEdit(r)}
                            >
                              Editar
                            </button>
                            <button
                              type="button"
                              className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                              onClick={() => handleDelete(r)}
                            >
                              Borrar
                            </button>
                          </>
                        )}
                      </div>
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
