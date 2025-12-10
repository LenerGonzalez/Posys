// src/components/InvoiceModal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  getDoc,
  doc,
} from "firebase/firestore";
import { format } from "date-fns";

type Batch = {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string; // "LB" o "UNIDAD"
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
};

type Adjustment = {
  id: string;
  description: string;
  type: "DEBITO" | "CREDITO";
  amount: number;
};

const money = (n: number | string) => `C$${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number | string) => Number(n || 0).toFixed(3);

const isLB = (u: string) =>
  (u || "").toLowerCase() === "lb" || /libra/.test((u || "").toLowerCase());

const firstDayOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};
const todayStr = () => format(new Date(), "yyyy-MM-dd");

export default function InvoiceModal({
  paidBatches = [],
  onClose,
  onCreated,
}: {
  paidBatches?: Batch[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // ========= Data base =========
  const safeBatches: Batch[] = Array.isArray(paidBatches) ? paidBatches : [];

  // ========= Filtros de Lotes =========
  const [lotFrom, setLotFrom] = useState<string>(firstDayOfMonth());
  const [lotTo, setLotTo] = useState<string>(todayStr());
  const [productFilter, setProductFilter] = useState<string>("");

  const productOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    safeBatches.forEach((b) =>
      m.set(b.productId, { id: b.productId, name: b.productName })
    );
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [safeBatches]);

  const filteredBatches = useMemo(() => {
    return safeBatches.filter((b) => {
      if (lotFrom && b.date < lotFrom) return false;
      if (lotTo && b.date > lotTo) return false;
      if (productFilter && b.productId !== productFilter) return false;
      return true;
    });
  }, [safeBatches, lotFrom, lotTo, productFilter]);

  // ========= Datos de factura =========
  const [invoiceDate, setInvoiceDate] = useState<string>(todayStr());
  const [invoiceNumber, setInvoiceNumber] = useState<string>(
    () => `FAC-${Date.now().toString().slice(-6)}`
  );
  const [description, setDescription] = useState<string>("");

  // Selección de lotes
  const [selectedIds, setSelectedIds] = useState<string[]>(() =>
    filteredBatches.map((b) => b.id)
  );
  // Mantener coherencia al cambiar filtros
  useEffect(() => {
    setSelectedIds((prev) =>
      prev.filter((id) => filteredBatches.some((b) => b.id === id))
    );
  }, [filteredBatches]);

  // ========= Gastos con filtro independiente =========
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState<boolean>(false);
  const [expFrom, setExpFrom] = useState<string>(firstDayOfMonth());
  const [expTo, setExpTo] = useState<string>(todayStr());

  useEffect(() => {
    (async () => {
      try {
        setLoadingExpenses(true);
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

  const filteredExpenses = useMemo(() => {
    return expenses.filter((g) => {
      if (!g.date) return false;
      if (expFrom && g.date < expFrom) return false;
      if (expTo && g.date > expTo) return false;
      return true;
    });
  }, [expenses, expFrom, expTo]);

  // ========= Notas Crédito/Débito =========
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [openAdjModal, setOpenAdjModal] = useState<boolean>(false);
  const [adjDesc, setAdjDesc] = useState<string>("");
  const [adjType, setAdjType] = useState<"DEBITO" | "CREDITO">("DEBITO");
  const [adjAmount, setAdjAmount] = useState<string>("");

  const addAdjustment = () => {
    const amt = Number(adjAmount);
    if (!adjDesc.trim() || !isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${prev.length + 1}`,
        description: adjDesc.trim(),
        type: adjType,
        amount: Number(amt.toFixed(2)),
      },
    ]);
    setAdjDesc("");
    setAdjAmount("");
  };

  // Edición/eliminación en tabla
  const [editingAdjId, setEditingAdjId] = useState<string | null>(null);
  const [editAdjDesc, setEditAdjDesc] = useState<string>("");
  const [editAdjType, setEditAdjType] = useState<"DEBITO" | "CREDITO">(
    "DEBITO"
  );
  const [editAdjAmount, setEditAdjAmount] = useState<string>("");

  const beginEditAdjustment = (a: Adjustment) => {
    setEditingAdjId(a.id);
    setEditAdjDesc(a.description);
    setEditAdjType(a.type);
    setEditAdjAmount(a.amount.toFixed(2));
  };
  const cancelEditAdjustment = () => {
    setEditingAdjId(null);
    setEditAdjDesc("");
    setEditAdjType("DEBITO");
    setEditAdjAmount("");
  };
  const saveEditAdjustment = () => {
    if (!editingAdjId) return;
    const amt = Number(editAdjAmount);
    if (!isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) =>
      prev.map((x) =>
        x.id === editingAdjId
          ? {
              ...x,
              description: editAdjDesc.trim(),
              type: editAdjType,
              amount: Number(amt.toFixed(2)),
            }
          : x
      )
    );
    cancelEditAdjustment();
  };
  const removeAdjustment = (id: string) => {
    setAdjustments((prev) => prev.filter((x) => x.id !== id));
    if (editingAdjId === id) cancelEditAdjustment();
  };

  // ========= Selección =========
  const toggleBatch = (id: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };
  const selectAllBatches = (checked: boolean) => {
    setSelectedIds(checked ? filteredBatches.map((b) => b.id) : []);
  };
  const toggleExpense = (id: string, checked: boolean) => {
    setSelectedExpenseIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id)
    );
  };

  // ========= Cálculos =========
  const selectedBatches = useMemo(
    () => filteredBatches.filter((b) => selectedIds.includes(b.id)),
    [filteredBatches, selectedIds]
  );

  const debitsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "DEBITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments]
  );
  const creditsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "CREDITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments]
  );

  const totals = useMemo(() => {
    let lbs = 0,
      uds = 0,
      expected = 0,
      facturado = 0;

    for (const b of selectedBatches) {
      if (isLB(b.unit)) lbs += Number(b.quantity || 0);
      else uds += Number(b.quantity || 0);

      const lineExpected =
        b.expectedTotal ??
        Number((Number(b.quantity || 0) * Number(b.salePrice || 0)).toFixed(2));

      const lineFacturado =
        b.invoiceTotal !== undefined && b.invoiceTotal !== null
          ? Number(b.invoiceTotal)
          : Number(
              (Number(b.quantity || 0) * Number(b.purchasePrice || 0)).toFixed(
                2
              )
            );

      expected += Number(lineExpected || 0);
      facturado += Number(lineFacturado || 0);
    }

    const totalGastos = filteredExpenses
      .filter((g) => selectedExpenseIds.includes(g.id))
      .reduce((a, g) => a + Number(g.amount || 0), 0);

    const finalAmount = expected - totalGastos - debitsSum + creditsSum;

    return {
      totalLbs: lbs,
      totalUnits: uds,
      totalExpected: Number(expected.toFixed(2)), // ventas
      totalInvoiced: Number(facturado.toFixed(2)), // costo
      totalGastos: Number(totalGastos.toFixed(2)),
      debits: Number(debitsSum.toFixed(2)),
      credits: Number(creditsSum.toFixed(2)),
      finalAmount: Number(finalAmount.toFixed(2)),
      grossProfit: Number((expected - facturado).toFixed(2)),
    };
  }, [
    selectedBatches,
    filteredExpenses,
    selectedExpenseIds,
    debitsSum,
    creditsSum,
  ]);

  // ========= Guardar =========
  const [creating, setCreating] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  const createInvoice = async () => {
    setMsg("");
    if (selectedBatches.length === 0) {
      setMsg("Selecciona al menos 1 lote pagado.");
      return;
    }
    try {
      setCreating(true);

      const invoicePayload = {
        number: invoiceNumber.trim(),
        date: invoiceDate,
        description: description.trim(),
        status: "PENDIENTE" as const,
        createdAt: Timestamp.now(),

        // Totales (guardamos ambos: esperado e “invoiceTotal” costo)
        totalLbs: Number(qty3(totals.totalLbs)),
        totalUnits: Number(qty3(totals.totalUnits)),
        totalAmount: totals.totalExpected, // ventas (esperado)
        invoiceTotal: totals.totalInvoiced, // facturado (costo)
        totalExpenses: totals.totalGastos,
        totalDebits: totals.debits,
        totalCredits: totals.credits,
        finalAmount: totals.finalAmount, // esperado - gastos - débitos + créditos

        // Detalle lotes
        batches: selectedBatches.map((b) => ({
          id: b.id,
          productId: b.productId,
          productName: b.productName,
          unit: b.unit,
          quantity: Number(qty3(b.quantity)),
          salePrice: Number(Number(b.salePrice || 0).toFixed(2)),
          purchasePrice: Number(Number(b.purchasePrice || 0).toFixed(2)),
          expectedTotal: Number(
            (Number(b.quantity || 0) * Number(b.salePrice || 0)).toFixed(2)
          ),
          invoiceTotal:
            b.invoiceTotal !== undefined && b.invoiceTotal !== null
              ? Number(b.invoiceTotal)
              : Number(
                  (
                    Number(b.quantity || 0) * Number(b.purchasePrice || 0)
                  ).toFixed(2)
                ),
          batchDate: b.date,
          paidAt: b.paidAt?.toDate
            ? format(b.paidAt.toDate(), "yyyy-MM-dd")
            : null,
        })),

        // Gastos
        expenses: filteredExpenses
          .filter((g) => selectedExpenseIds.includes(g.id))
          .map((g) => ({
            id: g.id,
            date: g.date || null,
            description: g.description || "",
            amount: Number(Number(g.amount || 0).toFixed(2)),
          })),

        // Ajustes
        adjustments: adjustments.map((a) => ({
          id: a.id,
          description: a.description,
          type: a.type,
          amount: Number(a.amount.toFixed(2)),
        })),
      };

      await addDoc(collection(db, "invoices"), invoicePayload);

      setMsg("✅ Factura creada.");
      onCreated();
    } catch (e: any) {
      console.error(e);
      setMsg(`❌ Error al crear factura: ${e?.message || "desconocido"}`);
    } finally {
      setCreating(false);
    }
  };

  // ========= UI =========
  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white w-full max-w-6xl rounded-xl shadow-xl p-4 md:p-6 max-h-[90vh] overflow-auto relative">
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

        {/* Filtros de Lotes */}
        <div className="bg-gray-50 border rounded p-3 mb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium">Desde (lote)</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={lotFrom}
                onChange={(e) => setLotFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Hasta (lote)</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={lotTo}
                onChange={(e) => setLotTo(e.target.value)}
              />
            </div>
            <div className="min-w-[220px]">
              <label className="block text-sm font-medium">Producto</label>
              <select
                className="border rounded px-2 py-1 w-full"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
              >
                <option value="">Todos</option>
                {productOptions.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="ml-auto px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
              onClick={() => {
                setLotFrom(firstDayOfMonth());
                setLotTo(todayStr());
                setProductFilter("");
              }}
            >
              Quitar filtro
            </button>
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
                  filteredBatches.length > 0 &&
                  selectedIds.length === filteredBatches.length
                }
                onChange={(e) => selectAllBatches(e.target.checked)}
              />
              Seleccionar todos (sobre el filtro)
            </label>
          </div>

          {filteredBatches.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay lotes pagados disponibles en el filtro actual.
            </p>
          ) : (
            <div className="border rounded max-h-80 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha lote</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Unidad</th>
                    <th className="p-2 border">Cantidad</th>
                    <th className="p-2 border">Precio venta</th>
                    <th className="p-2 border">Total facturado</th>
                    <th className="p-2 border">Total esperado</th>
                    <th className="p-2 border">Ganancia bruta</th>
                    <th className="p-2 border">Fecha pago</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredBatches.map((b) => {
                    const checked = selectedIds.includes(b.id);

                    const expected =
                      b.expectedTotal ??
                      Number(
                        (
                          Number(b.quantity || 0) * Number(b.salePrice || 0)
                        ).toFixed(2)
                      );

                    const facturado =
                      b.invoiceTotal !== undefined && b.invoiceTotal !== null
                        ? Number(b.invoiceTotal)
                        : Number(
                            (
                              Number(b.quantity || 0) *
                              Number(b.purchasePrice || 0)
                            ).toFixed(2)
                          );

                    const gross = expected - facturado;

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
                        <td className="p-2 border">{money(facturado)}</td>
                        <td className="p-2 border">{money(expected)}</td>
                        <td className="p-2 border">{money(gross)}</td>
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

        {/* Filtro + Tabla de Gastos */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Gastos a incluir (opcional)</h4>
            {loadingExpenses && (
              <span className="text-xs text-gray-500">Cargando…</span>
            )}
            <div className="ml-auto flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600">
                  Desde (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expFrom}
                  onChange={(e) => setExpFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600">
                  Hasta (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expTo}
                  onChange={(e) => setExpTo(e.target.value)}
                />
              </div>
            </div>
          </div>

          {filteredExpenses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay gastos en el rango seleccionado.
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
                  {filteredExpenses.map((g) => {
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

        {/* Notas Crédito/Débito */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">
              Notas Crédito/Débito (Cargos extras)
            </h4>
            <button
              className="ml-auto px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => setOpenAdjModal(true)}
            >
              Crear Cargo
            </button>
          </div>

          {adjustments.length === 0 ? (
            <p className="text-sm text-gray-500">Sin cargos agregados.</p>
          ) : (
            <div className="border rounded max-h-40 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Tipo</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => {
                    const isEditing = editingAdjId === a.id;
                    return (
                      <tr key={a.id} className="text-center">
                        {/* Descripción */}
                        <td className="p-2 border">
                          {isEditing ? (
                            <textarea
                              className="w-full border rounded px-2 py-1 min-h-[70px]"
                              value={editAdjDesc}
                              onChange={(e) => setEditAdjDesc(e.target.value)}
                            />
                          ) : (
                            <span title={a.description}>
                              {a.description.length > 60
                                ? `${a.description.slice(0, 60)}…`
                                : a.description}
                            </span>
                          )}
                        </td>

                        {/* Tipo */}
                        <td className="p-2 border">
                          {isEditing ? (
                            <select
                              className="w-full border rounded px-2 py-1"
                              value={editAdjType}
                              onChange={(e) =>
                                setEditAdjType(
                                  e.target.value as "DEBITO" | "CREDITO"
                                )
                              }
                            >
                              <option value="DEBITO">Débito</option>
                              <option value="CREDITO">Crédito</option>
                            </select>
                          ) : (
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                a.type === "DEBITO"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-green-100 text-green-700"
                              }`}
                            >
                              {a.type}
                            </span>
                          )}
                        </td>

                        {/* Monto */}
                        <td className="p-2 border">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              className="w-full border rounded px-2 py-1 text-right"
                              value={editAdjAmount}
                              onChange={(e) => setEditAdjAmount(e.target.value)}
                            />
                          ) : (
                            money(a.amount)
                          )}
                        </td>

                        {/* Acciones */}
                        <td className="p-2 border">
                          {isEditing ? (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-xs"
                                onClick={saveEditAdjustment}
                              >
                                Guardar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                                onClick={cancelEditAdjustment}
                              >
                                Cancelar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-xs"
                                onClick={() => beginEditAdjustment(a)}
                              >
                                Editar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          )}
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
        <div className="grid grid-cols-1 md:grid-cols-3 text-sm mb-4 justify-between">
          {/* Columna 1 */}
          <div className="space-y-1">
            <div>
              Total libras: <strong>{qty3(totals.totalLbs)}</strong>
            </div>
            <div>
              Total unidades: <strong>{qty3(totals.totalUnits)}</strong>
            </div>
          </div>

          {/* Columna 2 */}
          <div className="space-y-1 text-center">
            <div>
              Total facturado (costo):{" "}
              <strong>{money(totals.totalInvoiced)}</strong>
            </div>
            <div>
              Total esperado (ventas):{" "}
              <strong>{money(totals.totalExpected)}</strong>
            </div>
            <div>
              Ganancia bruta (esperado − facturado):{" "}
              <strong>{money(totals.grossProfit)}</strong>
            </div>
          </div>

          {/* Columna 3 */}
          <div className="space-y-1 text-right">
            <div>
              Gastos: <strong>{money(totals.totalGastos)}</strong>
            </div>
            <div>
              Débitos: <strong>{money(totals.debits)}</strong>
            </div>
            <div>
              Créditos: <strong>{money(totals.credits)}</strong>
            </div>
          </div>

          {/* Monto final en toda la fila */}
          <div className="md:col-span-3 mt-3">
            <div className="p-3 bg-blue-50 border border-blue-200 rounded text-center font-semibold text-lg">
              Monto final (esperado − gastos − débitos + créditos):{" "}
              <span className="text-blue-700">{money(totals.finalAmount)}</span>
            </div>
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

        {/* Overlay de carga */}
        {creating && (
          <div className="absolute inset-0 z-[11000] bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <svg
              className="animate-spin h-8 w-8 text-blue-600"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <div className="text-sm font-medium text-blue-700">
              Creando factura…
            </div>
          </div>
        )}
      </div>

      {/* Modal de creación de cargo */}
      {openAdjModal && (
        <div className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-3">
          <div className="bg-white w-full max-w-lg rounded-xl shadow-xl p-4">
            <div className="flex items-center mb-3">
              <h4 className="font-semibold">Nuevo cargo</h4>
              <button
                className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
                onClick={() => setOpenAdjModal(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Descripción
                </label>
                <textarea
                  className="w-full border rounded px-2 py-1 min-h-[90px]"
                  value={adjDesc}
                  onChange={(e) => setAdjDesc(e.target.value)}
                  placeholder="Detalle del cargo"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium">
                    Tipo de cargo
                  </label>
                  <select
                    className="w-full border rounded px-2 py-1"
                    value={adjType}
                    onChange={(e) =>
                      setAdjType(e.target.value as "DEBITO" | "CREDITO")
                    }
                  >
                    <option value="DEBITO">Débito</option>
                    <option value="CREDITO">Crédito</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium">Monto</label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full border rounded px-2 py-1"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  onClick={addAdjustment}
                >
                  Agregar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
