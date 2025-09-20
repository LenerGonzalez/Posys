// src/components/InvoiceModal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { format } from "date-fns";

type Batch = {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string; // "LB" o unidades
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  invoiceTotal?: number;
  expectedTotal?: number;
  date: string; // yyyy-MM-dd
  status: "PENDIENTE" | "PAGADO";
  paidAt?: any;
};

type Expense = {
  id: string;
  date?: string;
  description?: string;
  amount?: number;
  // otros campos que tengas en tu pantalla de Gastos
};

const money = (n: number) => `C$${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);

const isLB = (u: string) =>
  (u || "").toLowerCase() === "lb" || /libra/.test((u || "").toLowerCase());

export default function InvoiceModal({
  paidBatches = [], // ✅ default: evita el error de .filter en undefined
  onClose,
  onCreated,
}: {
  paidBatches?: Batch[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // Siempre trabajamos con un array seguro
  const safeBatches: Batch[] = Array.isArray(paidBatches) ? paidBatches : [];

  // ======= Form state =======
  const [invoiceDate, setInvoiceDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [invoiceNumber, setInvoiceNumber] = useState<string>(() => {
    // Puedes cambiar a tu lógica FAC-001 secuencial si ya la tienes
    const n = Date.now().toString().slice(-6);
    return `FAC-${n}`;
  });
  const [description, setDescription] = useState<string>("");

  // Selección múltiple de lotes pagados (por defecto todos visibles)
  const [selectedIds, setSelectedIds] = useState<string[]>(
    safeBatches.map((b) => b.id)
  );

  // Gastos (opcionales) traídos de tu colección de gastos
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState<boolean>(false);
  const [creating, setCreating] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  // Cargar gastos (opcional)
  useEffect(() => {
    (async () => {
      try {
        setLoadingExpenses(true);
        // Ajusta la colección si tu pantalla de gastos usa otro nombre
        const qy = query(collection(db, "expenses"), orderBy("date", "desc"));
        const snap = await getDocs(qy);
        const rows: Expense[] = [];
        snap.forEach((d) => {
          const it = d.data() as any;
          rows.push({
            id: d.id,
            date: it.date,
            description: it.description,
            amount: Number(it.amount || 0),
          });
        });
        setExpenses(rows);
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingExpenses(false);
      }
    })();
  }, []);

  // Lista de lotes seleccionados
  const selectedBatches = useMemo(
    () => safeBatches.filter((b) => selectedIds.includes(b.id)),
    [safeBatches, selectedIds]
  );

  // Totales (3 decimales para cantidades, 2 para dinero)
  const totals = useMemo(() => {
    let lbs = 0,
      uds = 0,
      amount = 0;
    for (const b of selectedBatches) {
      if (isLB(b.unit)) lbs += Number(b.quantity || 0);
      else uds += Number(b.quantity || 0);

      // Monto por línea = cantidad * precio venta (si ya guardas expectedTotal lo puedes usar)
      const line =
        b.expectedTotal ??
        Number((Number(b.quantity || 0) * Number(b.salePrice || 0)).toFixed(2));
      amount += Number(line || 0);
    }
    // total gastos seleccionados
    const totalGastos = expenses
      .filter((g) => selectedExpenseIds.includes(g.id))
      .reduce((a, g) => a + Number(g.amount || 0), 0);

    const finalAmount = amount - totalGastos;

    return {
      totalLbs: lbs,
      totalUnits: uds,
      totalAmount: amount,
      totalGastos,
      finalAmount,
    };
  }, [selectedBatches, expenses, selectedExpenseIds]);

  const toggleBatch = (id: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };

  const toggleExpense = (id: string, checked: boolean) => {
    setSelectedExpenseIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };

  const selectAllBatches = (checked: boolean) => {
    setSelectedIds(checked ? safeBatches.map((b) => b.id) : []);
  };

  const createInvoice = async () => {
    setMsg("");
    if (selectedBatches.length === 0) {
      setMsg("Selecciona al menos 1 lote pagado.");
      return;
    }
    try {
      setCreating(true);

      // Armamos el payload de la factura
      const invoicePayload = {
        number: invoiceNumber.trim(),
        date: invoiceDate,
        description: description.trim(),
        status: "PENDIENTE", // se puede cambiar a PAGO luego
        createdAt: Timestamp.now(),

        // Totales
        totalLbs: Number(totals.totalLbs.toFixed(3)),
        totalUnits: Number(totals.totalUnits.toFixed(3)),
        totalAmount: Number(totals.totalAmount.toFixed(2)),
        totalExpenses: Number(totals.totalGastos.toFixed(2)),
        finalAmount: Number(totals.finalAmount.toFixed(2)),

        // Detalle de lotes
        batches: selectedBatches.map((b) => ({
          id: b.id,
          productId: b.productId,
          productName: b.productName,
          unit: b.unit,
          quantity: Number(Number(b.quantity || 0).toFixed(3)),
          salePrice: Number(Number(b.salePrice || 0).toFixed(2)),
          amount: Number(
            (Number(b.quantity || 0) * Number(b.salePrice || 0)).toFixed(2)
          ),
          batchDate: b.date,
          paidAt: b.paidAt?.toDate
            ? format(b.paidAt.toDate(), "yyyy-MM-dd")
            : null,
        })),

        // Gastos vinculados (si seleccionados)
        expenses: expenses
          .filter((g) => selectedExpenseIds.includes(g.id))
          .map((g) => ({
            id: g.id,
            date: g.date || null,
            description: g.description || "",
            amount: Number(Number(g.amount || 0).toFixed(2)),
          })),
      };

      await addDoc(collection(db, "invoices"), invoicePayload);

      setMsg("✅ Factura creada.");
      onCreated(); // cierras o refrescas arriba
    } catch (e: any) {
      console.error(e);
      setMsg(`❌ Error al crear factura: ${e?.message || "desconocido"}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white w-full max-w-5xl rounded-xl shadow-xl p-4 md:p-6 max-h-[90vh] overflow-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-lg font-semibold">Crear factura</h3>
          <button
            onClick={onClose}
            className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
          >
            Cerrar
          </button>
        </div>

        {/* Datos de factura */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium">Fecha</label>
            <input
              type="date"
              className="w-full border rounded px-2 py-1"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Número</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="FAC-001"
            />
          </div>
          <div className="md:col-span-1">
            <label className="block text-sm font-medium">Descripción</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Comentarios de la factura"
            />
          </div>
        </div>

        {/* Selector de lotes */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Lotes pagados</h4>
            <label className="text-sm flex items-center gap-2">
              <input
                type="checkbox"
                checked={
                  safeBatches.length > 0 &&
                  selectedIds.length === safeBatches.length
                }
                onChange={(e) => selectAllBatches(e.target.checked)}
              />
              Seleccionar todos
            </label>
          </div>

          {safeBatches.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay lotes pagados disponibles en el filtro actual.
            </p>
          ) : (
            <div className="border rounded">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha lote</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Unidad</th>
                    <th className="p-2 border">Cantidad</th>
                    <th className="p-2 border">Precio venta</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Fecha pago</th>
                  </tr>
                </thead>
                <tbody>
                  {safeBatches.map((b) => {
                    const checked = selectedIds.includes(b.id);
                    const line =
                      b.expectedTotal ??
                      Number(
                        (
                          Number(b.quantity || 0) * Number(b.salePrice || 0)
                        ).toFixed(2)
                      );
                    return (
                      <tr key={b.id} className="text-center">
                        <td className="p-2 border">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              toggleBatch(b.id, e.target.checked)
                            }
                          />
                        </td>
                        <td className="p-2 border">{b.date}</td>
                        <td className="p-2 border">{b.productName}</td>
                        <td className="p-2 border">
                          {(b.unit || "").toUpperCase()}
                        </td>
                        <td className="p-2 border">{qty3(b.quantity)}</td>
                        <td className="p-2 border">{money(b.salePrice)}</td>
                        <td className="p-2 border">{money(line)}</td>
                        <td className="p-2 border">
                          {b.paidAt?.toDate
                            ? format(b.paidAt.toDate(), "yyyy-MM-dd")
                            : "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Gastos (opcional) */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Gastos a incluir (opcional)</h4>
            {loadingExpenses && (
              <span className="text-xs text-gray-500">Cargando…</span>
            )}
          </div>

          {expenses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay gastos registrados o no están disponibles.
            </p>
          ) : (
            <div className="border rounded max-h-48 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {expenses.map((g) => {
                    const checked = selectedExpenseIds.includes(g.id);
                    return (
                      <tr key={g.id} className="text-center">
                        <td className="p-2 border">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) =>
                              toggleExpense(g.id, e.target.checked)
                            }
                          />
                        </td>
                        <td className="p-2 border">{g.date || "—"}</td>
                        <td className="p-2 border">{g.description || "—"}</td>
                        <td className="p-2 border">
                          {money(Number(g.amount || 0))}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Totales */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-sm mb-4">
          <div>
            Total libras: <strong>{qty3(totals.totalLbs)}</strong>
          </div>
          <div>
            Total unidades: <strong>{qty3(totals.totalUnits)}</strong>
          </div>
          <div>
            Total monto: <strong>{money(totals.totalAmount)}</strong>
          </div>
          <div>
            Total gastos: <strong>{money(totals.totalGastos)}</strong>
          </div>
          <div className="md:col-span-2">
            Monto final (monto - gastos):{" "}
            <strong>{money(totals.finalAmount)}</strong>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-2">
          <button
            disabled={creating}
            onClick={createInvoice}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? "Creando…" : "Crear factura"}
          </button>
          <button onClick={onClose} className="px-4 py-2 border rounded">
            Cancelar
          </button>
          {msg && <span className="text-sm ml-2">{msg}</span>}
        </div>
      </div>
    </div>
  );
}
