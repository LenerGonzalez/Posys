// src/components/Pollo/InvoiceModal.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase";
import ExpenseFormModal from "./ExpenseFormModal";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
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
      m.set(b.productId, { id: b.productId, name: b.productName }),
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
    () => `FAC-${Date.now().toString().slice(-6)}`,
  );
  const [description, setDescription] = useState<string>("");

  // ✅ Selección de lotes (FIX: coherencia con filtros)
  // Nota: reemplazamos la selección de lotes por consolidado de ventas cash
  // Los datos consolidados por producto se calculan en el efecto más abajo.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  // ========= Gastos con filtro independiente =========
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState<boolean>(false);
  const [expFrom, setExpFrom] = useState<string>(firstDayOfMonth());
  const [expTo, setExpTo] = useState<string>(todayStr());
  const [openExpenseModal, setOpenExpenseModal] = useState(false);

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

  // Handler para agregar gasto desde el modal
  const handleExpenseCreated = (expense: Expense) => {
    setExpenses((prev) => [expense, ...prev]);
    setSelectedExpenseIds((prev) => [expense.id, ...prev]);
  };

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
    "DEBITO",
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
          : x,
      ),
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
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  };
  const selectAllBatches = (checked: boolean) => {
    setSelectedIds(checked ? filteredBatches.map((b) => b.id) : []);
  };
  const toggleExpense = (id: string, checked: boolean) => {
    setSelectedExpenseIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  };

  // ========= Consolidado de ventas CASH y abonos para el rango lotFrom..lotTo =========
  const [consolidatedRows, setConsolidatedRows] = useState<
    {
      productName: string;
      measurement: string;
      totalQuantity: number;
      totalExpected: number;
      totalInvoiced: number;
      grossProfit: number;
    }[]
  >([]);
  const [abonosRangeTotal, setAbonosRangeTotal] = useState<number>(0);

  const consolidatedTotals = useMemo(() => {
    let lbs = 0;
    let units = 0;
    let expected = 0;
    let facturado = 0;
    for (const r of consolidatedRows) {
      const q = Number(r.totalQuantity || 0);
      if (isLB(r.measurement || "")) lbs += q;
      else units += q;
      expected += Number(r.totalExpected || 0);
      facturado += Number(r.totalInvoiced || 0);
    }
    return {
      totalLbs: lbs,
      totalUnits: units,
      totalExpected: Number(expected.toFixed(2)),
      totalFacturado: Number(facturado.toFixed(2)),
      grossProfit: Number((expected - facturado).toFixed(2)),
    };
  }, [consolidatedRows]);

  // Gross profit considering Cash + Abonos as revenue
  const consolidatedGrossWithAbonos = useMemo(() => {
    return Number(
      (
        (consolidatedTotals.totalExpected || 0) +
        (abonosRangeTotal || 0) -
        (consolidatedTotals.totalFacturado || 0)
      ).toFixed(2),
    );
  }, [consolidatedTotals, abonosRangeTotal]);

  useEffect(() => {
    const loadConsolidated = async () => {
      if (!lotFrom || !lotTo) {
        setConsolidatedRows([]);
        setAbonosRangeTotal(0);
        return;
      }

      try {
        // Ventas (salesV2) por rango
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", lotFrom),
          where("date", "<=", lotTo),
        );
        const sSnap = await getDocs(qs);
        const map: Record<
          string,
          {
            measurement: string;
            totalQuantity: number;
            totalExpected: number;
            totalInvoiced: number;
          }
        > = {};

        sSnap.forEach((d) => {
          const x = d.data() as any;
          const baseDate = x.date ?? "";

          // Only include cash sales (CONTADO)
          const saleType = String(x.type ?? "CONTADO").toUpperCase();
          if (saleType !== "CONTADO") return;

          const pushLine = (
            prod: string,
            meas: string,
            qty: number,
            expected: number,
            invoiced: number,
          ) => {
            const key = `${prod}||${meas}`;
            if (!map[key]) {
              map[key] = {
                measurement: meas || "",
                totalQuantity: 0,
                totalExpected: 0,
                totalInvoiced: 0,
              };
            }
            map[key].totalQuantity += qty;
            map[key].totalExpected += expected;
            map[key].totalInvoiced += invoiced;
          };

          if (Array.isArray(x.items) && x.items.length > 0) {
            x.items.forEach((it: any) => {
              const prod = String(it.productName ?? "(sin nombre)");
              const qty = Number(it.qty ?? it.quantity ?? 0);
              const unitPrice = Number(
                it.unitPrice ?? it.price ?? x.amountSuggested ?? 0,
              );
              const lineFinal =
                Number(it.lineFinal ?? 0) ||
                Math.max(
                  0,
                  Number(unitPrice || 0) * qty - Number(it.discount || 0),
                );
              const revenueLine = Number(lineFinal || 0);

              // COGS: prefer allocations' lineCost, fallback to avgUnitCost * qty
              const allocs = Array.isArray(it.allocations)
                ? it.allocations
                : Array.isArray(x.allocations)
                  ? x.allocations
                  : [];
              let costLine = 0;
              if (allocs && allocs.length) {
                costLine = allocs.reduce(
                  (s: number, a: any) => s + Number(a.lineCost || 0),
                  0,
                );
              } else {
                const avgUnit = Number(it.avgUnitCost ?? x.avgUnitCost ?? 0);
                costLine = avgUnit * qty;
              }

              pushLine(
                prod,
                it.measurement ?? x.measurement ?? "",
                qty,
                revenueLine,
                costLine,
              );
            });
            return;
          }

          const prod = String(x.productName ?? "(sin nombre)");
          const qty = Number(x.quantity ?? 0);
          const revenueLine =
            Number(x.amount ?? x.amountCharged ?? 0) ||
            Number(x.amountSuggested ?? x.unitPrice ?? 0) * qty;

          const allocs = Array.isArray(x.allocations) ? x.allocations : [];
          let costLine = 0;
          if (allocs && allocs.length) {
            costLine = allocs.reduce(
              (s: number, a: any) => s + Number(a.lineCost || 0),
              0,
            );
          } else {
            const avgUnit = Number(x.avgUnitCost ?? 0);
            costLine = avgUnit * qty;
          }

          pushLine(prod, x.measurement ?? "", qty, revenueLine, costLine);
        });

        const rows = Object.entries(map).map(([k, v]) => {
          const [productName] = k.split("||");
          const gross = Number((v.totalExpected - v.totalInvoiced).toFixed(2));
          return {
            productName,
            measurement: v.measurement,
            totalQuantity: Number(v.totalQuantity.toFixed(3)),
            totalExpected: Number(v.totalExpected.toFixed(2)),
            totalInvoiced: Number(v.totalInvoiced.toFixed(2)),
            grossProfit: gross,
          };
        });

        setConsolidatedRows(
          rows.sort((a, b) => b.totalInvoiced - a.totalInvoiced),
        );

        // Recaudado (abonos) por rango — coleccion ar_movements_pollo
        const movementsSnap = await getDocs(
          collection(db, "ar_movements_pollo"),
        );
        let abonosRangeSum = 0;
        movementsSnap.forEach((d) => {
          const m = d.data() as any;
          const type = String(m.type ?? "").toUpperCase();
          if (type !== "ABONO") return;
          const amount = Math.abs(Number(m.amount ?? 0));
          const moveDate = m?.date
            ? String(m.date)
            : m?.createdAt?.toDate
              ? format(m.createdAt.toDate(), "yyyy-MM-dd")
              : "";
          if (moveDate && moveDate >= lotFrom && moveDate <= lotTo) {
            abonosRangeSum += amount;
          }
        });
        setAbonosRangeTotal(Number(abonosRangeSum.toFixed(2)));
      } catch (e) {
        console.error("Error cargando consolidado de ventas/abonos:", e);
        setConsolidatedRows([]);
        setAbonosRangeTotal(0);
      }
    };

    loadConsolidated();
  }, [lotFrom, lotTo]);

  // ========= Cálculos =========
  const selectedBatches = useMemo(
    () => filteredBatches.filter((b) => selectedIds.includes(b.id)),
    [filteredBatches, selectedIds],
  );

  const debitsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "DEBITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments],
  );
  const creditsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "CREDITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments],
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
                2,
              ),
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
      totalExpected: Number(expected.toFixed(2)),
      totalInvoiced: Number(facturado.toFixed(2)),
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
    const useConsolidated =
      Array.isArray(consolidatedRows) && consolidatedRows.length > 0;
    if (!useConsolidated && selectedBatches.length === 0) {
      setMsg("Selecciona al menos 1 lote pagado o genera un consolidado.");
      return;
    }
    try {
      setCreating(true);

      // Build payload using consolidated values when available
      const consolidatedProducts = (consolidatedRows || []).map((r) => ({
        productName: r.productName,
        measurement: r.measurement,
        quantity: Number(qty3(r.totalQuantity)),
        expectedTotal: Number(r.totalExpected),
        invoiceTotal: Number(r.totalInvoiced),
      }));

      const totalLbs = useConsolidated
        ? Number(qty3(consolidatedTotals.totalLbs))
        : Number(qty3(totals.totalLbs));
      const totalUnits = useConsolidated
        ? Number(qty3(consolidatedTotals.totalUnits))
        : Number(qty3(totals.totalUnits));

      const totalAmount = useConsolidated
        ? Number(
            (consolidatedTotals.totalExpected + abonosRangeTotal).toFixed(2),
          )
        : totals.totalExpected;

      const invoiceTotal = useConsolidated
        ? consolidatedTotals.totalFacturado
        : totals.totalInvoiced;

      const finalAmount = Number(
        (
          (totalAmount || 0) -
          Number(totals.totalGastos || 0) -
          Number(totals.debits || 0) +
          Number(totals.credits || 0)
        ).toFixed(2),
      );

      const invoicePayload = {
        number: invoiceNumber.trim(),
        date: invoiceDate,
        description: description.trim(),
        status: "PENDIENTE" as const,
        createdAt: Timestamp.now(),

        totalLbs,
        totalUnits,
        totalAmount,
        invoiceTotal,
        totalExpenses: totals.totalGastos,
        totalDebits: totals.debits,
        totalCredits: totals.credits,
        finalAmount,

        // keep legacy `batches` when user selected explicit batches
        batches: (!useConsolidated ? selectedBatches : []).map((b) => ({
          id: b.id,
          productId: b.productId,
          productName: b.productName,
          unit: b.unit,
          quantity: Number(qty3(b.quantity)),
          salePrice: Number(Number(b.salePrice || 0).toFixed(2)),
          purchasePrice: Number(Number(b.purchasePrice || 0).toFixed(2)),
          expectedTotal: Number(
            (Number(b.quantity || 0) * Number(b.salePrice || 0)).toFixed(2),
          ),
          invoiceTotal:
            b.invoiceTotal !== undefined && b.invoiceTotal !== null
              ? Number(b.invoiceTotal)
              : Number(
                  (
                    Number(b.quantity || 0) * Number(b.purchasePrice || 0)
                  ).toFixed(2),
                ),
          batchDate: b.date,
          paidAt: b.paidAt?.toDate
            ? format(b.paidAt.toDate(), "yyyy-MM-dd")
            : null,
        })),

        // consolidated products (when using consolidated invoicing)
        consolidatedProducts: consolidatedProducts,

        expenses: filteredExpenses
          .filter((g) => selectedExpenseIds.includes(g.id))
          .map((g) => ({
            id: g.id,
            date: g.date || null,
            description: g.description || "",
            amount: Number(Number(g.amount || 0).toFixed(2)),
          })),

        adjustments: adjustments.map((a) => ({
          id: a.id,
          description: a.description,
          type: a.type,
          amount: Number(a.amount.toFixed(2)),
        })),
      };

      const invRef = await addDoc(collection(db, "invoices"), invoicePayload);

      // Save consolidated report document when using consolidated invoicing
      if (useConsolidated) {
        try {
          await addDoc(collection(db, "consolidated_reports"), {
            invoiceId: invRef.id,
            lotFrom,
            lotTo,
            consolidatedProducts,
            consolidatedTotals: {
              totalLbs: consolidatedTotals.totalLbs,
              totalUnits: consolidatedTotals.totalUnits,
              totalExpected: consolidatedTotals.totalExpected,
              totalFacturado: consolidatedTotals.totalFacturado,
              grossProfit: consolidatedTotals.grossProfit,
            },
            abonosRangeTotal,
            createdAt: Timestamp.now(),
          });
        } catch (err) {
          console.error("Error saving consolidated report:", err);
        }
      }

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
            type="button"
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
              type="button"
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

        {/* Consolidado de ventas CASH por producto (Periodo: lotFrom → lotTo) */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Consolidado ventas (CASH)</h4>
            <div className="text-sm text-gray-600 ml-auto">
              Periodo: {lotFrom} → {lotTo}
            </div>
          </div>

          {/* Totales consolidados */}
          <div className="flex gap-3 mb-3 items-stretch">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center min-w-[120px]">
              <div className="text-xs text-blue-700 font-semibold">
                Total libras
              </div>
              <div className="text-xl font-bold text-blue-900">
                {qty3(consolidatedTotals.totalLbs)}
              </div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-center min-w-[120px]">
              <div className="text-xs text-blue-700 font-semibold">
                Total unidades
              </div>
              <div className="text-xl font-bold text-blue-900">
                {qty3(consolidatedTotals.totalUnits)}
              </div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center min-w-[180px]">
              <div className="text-xs text-green-700 font-semibold">
                Total facturado
              </div>
              <div className="text-xl font-bold text-green-900">
                {money(consolidatedTotals.totalFacturado)}
              </div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl p-3 text-center min-w-[200px]">
              <div className="text-xs text-green-700 font-semibold">
                Total esperado
              </div>
              <div className="text-xl font-bold text-green-900">
                {money(consolidatedTotals.totalExpected)}
              </div>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-3 text-center min-w-[180px]">
              <div className="text-xs text-yellow-700 font-semibold">
                Utilidad bruta
              </div>
              <div className="text-xl font-bold text-yellow-900">
                {money(consolidatedGrossWithAbonos)}
              </div>
            </div>
          </div>

          {consolidatedRows.length === 0 ? (
            <p className="text-sm text-gray-500">
              Sin ventas cash en el periodo.
            </p>
          ) : (
            <div className="border rounded max-h-80 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Unidad</th>
                    <th className="p-2 border text-right">Cantidad</th>
                    <th className="p-2 border text-right">Total facturado</th>
                    <th className="p-2 border text-right">Total esperado</th>
                    <th className="p-2 border text-right">Ganancia bruta</th>
                  </tr>
                </thead>
                <tbody>
                  {consolidatedRows.map((r) => (
                    <tr key={r.productName} className="text-center">
                      <td className="p-2 border text-left">{r.productName}</td>
                      <td className="p-2 border">{r.measurement || "—"}</td>
                      <td className="p-2 border text-right">
                        {qty3(r.totalQuantity)}
                      </td>
                      <td className="p-2 border text-right">
                        {money(r.totalInvoiced)}
                      </td>
                      <td className="p-2 border text-right">
                        {money(r.totalExpected)}
                      </td>
                      <td className="p-2 border text-right">
                        {money(r.grossProfit)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Abonos */}
          <div className="mt-3">
            <h4 className="font-semibold">Abonos (Periodo)</h4>
            <div className="mt-2">
              <div className="p-3 border rounded bg-white inline-block">
                <div className="text-sm text-gray-600">Periodo</div>
                <div className="font-semibold">
                  {lotFrom} → {lotTo}
                </div>
              </div>
              <div className="p-3 border rounded bg-white inline-block ml-3">
                <div className="text-sm text-gray-600">Total recaudado</div>
                <div className="font-semibold">{money(abonosRangeTotal)}</div>
              </div>
            </div>
          </div>
        </div>

        {/* Filtro + Tabla de Gastos */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Gastos a incluir (opcional)</h4>
            {loadingExpenses && (
              <span className="text-xs text-gray-500">Cargando…</span>
            )}
            <button
              type="button"
              className="ml-auto px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => setOpenExpenseModal(true)}
            >
              Crear gasto
            </button>
            <div className="flex items-end gap-3">
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

          {/* Modal para crear gasto */}
          {openExpenseModal && (
            <ExpenseFormModal
              onCreated={handleExpenseCreated}
              onClose={() => setOpenExpenseModal(false)}
            />
          )}
        </div>

        {/* Notas Crédito/Débito */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">
              Notas Crédito/Débito (Cargos extras)
            </h4>
            <button
              type="button"
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

                        <td className="p-2 border">
                          {isEditing ? (
                            <select
                              className="w-full border rounded px-2 py-1"
                              value={editAdjType}
                              onChange={(e) =>
                                setEditAdjType(
                                  e.target.value as "DEBITO" | "CREDITO",
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

                        <td className="p-2 border">
                          {isEditing ? (
                            <div className="flex gap-2 justify-center">
                              <button
                                type="button"
                                className="px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-xs"
                                onClick={saveEditAdjustment}
                              >
                                Guardar
                              </button>
                              <button
                                type="button"
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                                onClick={cancelEditAdjustment}
                              >
                                Cancelar
                              </button>
                              <button
                                type="button"
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-2 justify-center">
                              <button
                                type="button"
                                className="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-xs"
                                onClick={() => beginEditAdjustment(a)}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
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

        {/* Totales en cards visuales */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <div className="flex flex-col gap-4">
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-blue-700 font-semibold mb-1">
                Total libras
              </div>
              <div className="text-2xl font-bold text-blue-900">
                {qty3(consolidatedTotals.totalLbs)}
              </div>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-blue-700 font-semibold mb-1">
                Total unidades
              </div>
              <div className="text-2xl font-bold text-blue-900">
                {qty3(consolidatedTotals.totalUnits)}
              </div>
            </div>
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-green-700 font-semibold mb-1">
                Total facturado
              </div>
              <div className="text-2xl font-bold text-green-900">
                {money(consolidatedTotals.totalFacturado)}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="bg-red-50 border border-red-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-red-700 font-semibold mb-1">
                Gastos
              </div>
              <div className="text-2xl font-bold text-red-900">
                {money(totals.totalGastos)}
              </div>
            </div>
            <div className="bg-orange-50 border border-orange-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-orange-700 font-semibold mb-1">
                Débitos
              </div>
              <div className="text-2xl font-bold text-orange-900">
                {money(totals.debits)}
              </div>
            </div>
            <div className="bg-lime-50 border border-lime-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-lime-700 font-semibold mb-1">
                Créditos
              </div>
              <div className="text-2xl font-bold text-lime-900">
                {money(totals.credits)}
              </div>
            </div>
          </div>
          <div className="flex flex-col gap-4">
            <div className="bg-green-50 border border-green-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-green-700 font-semibold mb-1">
                Total Cash + Abonos
              </div>
              <div className="text-2xl font-bold text-green-900">
                {money(consolidatedTotals.totalExpected + abonosRangeTotal)}
              </div>
            </div>
            <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-yellow-700 font-semibold mb-1">
                Ganancia bruta
              </div>
              <div className="text-2xl font-bold text-yellow-900">
                {money(consolidatedGrossWithAbonos)}
              </div>
            </div>
            <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 shadow text-center">
              <div className="text-xs text-purple-700 font-semibold mb-1">
                Ganancia neta
              </div>
              <div className="text-2xl font-bold text-purple-900">
                {money(
                  consolidatedGrossWithAbonos -
                    totals.totalGastos -
                    totals.debits,
                )}
              </div>
            </div>
          </div>
        </div>

        {/* Card de monto final */}
        <div className="md:col-span-3 mt-3">
          <div className="p-4 bg-blue-100 border border-blue-300 rounded-xl text-center font-semibold text-lg shadow">
            Monto final (esperado − gastos − débitos + créditos):{" "}
            <span className="text-blue-700">{money(totals.finalAmount)}</span>
          </div>
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-2">
          <button
            type="button"
            disabled={creating}
            onClick={createInvoice}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? "Creando…" : "Crear factura"}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 border rounded"
          >
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
                type="button"
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
                  type="button"
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
