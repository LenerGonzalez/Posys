// src/pages/Billing.tsx
import React, { useEffect, useState, useRef } from "react";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  orderBy,
  query,
  updateDoc,
  deleteDoc,
  doc,
  getDoc,
  writeBatch,
} from "firebase/firestore";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

type BatchItem = {
  id?: string; // id del lote (a veces viene como id)
  batchId?: string; // o como batchId
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  salePrice: number; // precio de venta
  amount: number; // compat antiguo (no lo usamos para facturado)
  purchasePrice?: number; // ⬅️ precio compra (lo rellenamos desde inventory_batches si falta)
  invoiceTotal?: number; // total facturado (si lo guardas)
  expectedTotal?: number; // total esperado (si lo guardas)
  batchDate?: string;
};

type ExpenseItem = {
  id: string;
  description: string;
  date: string;
  amount: number;
};

type AdjustmentItem = {
  id?: string;
  description: string;
  type: "DEBITO" | "CREDITO";
  amount: number;
  // La fecha de creación no se guardó por ítem, usamos la fecha de la factura para mostrarla
};

type InvoiceDoc = {
  id: string;
  date: string;
  number?: string;
  description?: string;
  status: "PENDIENTE" | "PAGADA";
  batches?: BatchItem[];
  expenses?: ExpenseItem[];
  adjustments?: AdjustmentItem[];

  totals?: {
    lbs: number;
    units: number;
    amount: number; // esperado (ventas)
    expenses: number;
    finalAmount: number; // en docs viejos puede no incluir deb/cred
    invoiceTotal?: number; // facturado (costo)
  };

  // compat campos sueltos
  totalLbs?: number;
  totalUnits?: number;
  totalAmount?: number;
  totalExpenses?: number;
  finalAmount?: number;
  invoiceTotal?: number;

  // desde el modal nuevo
  totalDebits?: number;
  totalCredits?: number;
};

const money = (n: unknown) => `C$ ${Number(n ?? 0).toFixed(2)}`;
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

/** Carga purchasePrice desde inventory_batches para los lotes que no lo traen */
async function enrichBatchesWithPurchasePrice(invoices: InvoiceDoc[]) {
  const ids = new Set<string>();
  for (const inv of invoices) {
    for (const it of inv.batches || []) {
      const lotId = (it.batchId || it.id || "").trim();
      if (!lotId) continue;
      const needsCost =
        (it.purchasePrice === undefined || it.purchasePrice === null) &&
        (it.invoiceTotal === undefined || it.invoiceTotal === null);
      if (needsCost) ids.add(lotId);
    }
  }
  if (ids.size === 0) return invoices;

  const costMap = new Map<string, number>();
  await Promise.all(
    Array.from(ids).map(async (lotId) => {
      try {
        const snap = await getDoc(doc(db, "inventory_batches", lotId));
        if (snap.exists()) {
          const d = snap.data() as any;
          costMap.set(lotId, Number(d.purchasePrice || 0));
        }
      } catch {
        /* ignore */
      }
    })
  );

  return invoices.map((inv) => ({
    ...inv,
    batches: (inv.batches || []).map((it) => {
      if (
        (it.purchasePrice === undefined || it.purchasePrice === null) &&
        (it.invoiceTotal === undefined || it.invoiceTotal === null)
      ) {
        const lotId = (it.batchId || it.id || "").trim();
        const pp = lotId ? costMap.get(lotId) : undefined;
        if (pp !== undefined) {
          return { ...it, purchasePrice: pp };
        }
      }
      return it;
    }),
  }));
}

/** Totales consistentes:
 *  Esperado (ventas)   = qty * salePrice       (o expectedTotal)
 *  Facturado (costo)   = qty * purchasePrice   (o invoiceTotal)
 *  Ganancia bruta      = Esperado - Facturado
 *  Final               = Esperado - Gastos - Débitos + Créditos
 */
function computeTotalsFromDoc(inv: InvoiceDoc) {
  const batches = inv.batches || [];
  const expensesArr = inv.expenses || [];
  const adjustments = inv.adjustments || [];

  const lbs = Number(inv.totals?.lbs ?? inv.totalLbs ?? 0);
  const units = Number(inv.totals?.units ?? inv.totalUnits ?? 0);

  let expectedSum = 0; // ventas
  let invoicedSum = 0; // costo facturado

  for (const it of batches) {
    const qty = Number(it.quantity ?? 0);

    // esperado (ventas)
    let expected =
      it.expectedTotal !== undefined && it.expectedTotal !== null
        ? Number(it.expectedTotal)
        : qty * Number(it.salePrice ?? 0);
    if (!isFinite(expected)) expected = 0;

    // facturado (costo)
    let facturado = qty * Number(it.purchasePrice ?? Number.NaN);
    if (!isFinite(facturado)) {
      facturado =
        it.invoiceTotal !== undefined && it.invoiceTotal !== null
          ? Number(it.invoiceTotal)
          : 0;
    }

    expectedSum += expected;
    invoicedSum += facturado;
  }

  const expenses = expensesArr.reduce((a, e) => a + Number(e.amount || 0), 0);

  // sumas de ajustes guardados (o 0 si no existen)
  const debitsFromArray = adjustments
    .filter((a) => a.type === "DEBITO")
    .reduce((s, a) => s + Number(a.amount || 0), 0);
  const creditsFromArray = adjustments
    .filter((a) => a.type === "CREDITO")
    .reduce((s, a) => s + Number(a.amount || 0), 0);

  // si el doc guardó totalDebits/totalCredits, preferirlos sobre sumas calculadas
  const debits =
    inv.totalDebits !== undefined ? Number(inv.totalDebits) : debitsFromArray;
  const credits =
    inv.totalCredits !== undefined
      ? Number(inv.totalCredits)
      : creditsFromArray;

  const grossProfit = expectedSum - invoicedSum;
  const finalAmount = expectedSum - expenses - debits + credits;

  return {
    lbs,
    units,
    expectedSum,
    invoicedSum,
    expenses,
    debits,
    credits,
    grossProfit,
    finalAmount,
  };
}

export default function Billing() {
  const [rows, setRows] = useState<InvoiceDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<InvoiceDoc | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      const qy = query(collection(db, "invoices"), orderBy("date", "desc"));
      const snap = await getDocs(qy);
      const list: InvoiceDoc[] = [];
      snap.forEach((d) => {
        const raw = d.data() as any;
        list.push({
          id: d.id,
          ...raw,
          batches: raw.batches || [],
          expenses: raw.expenses || [],
          adjustments: raw.adjustments || [],
          totals: raw.totals || {
            lbs: raw.totalLbs || 0,
            units: raw.totalUnits || 0,
            amount: raw.totalAmount || 0,
            expenses: raw.totalExpenses || 0,
            finalAmount: raw.finalAmount || 0,
            invoiceTotal: raw.invoiceTotal || 0,
          },
          totalDebits: raw.totalDebits || 0,
          totalCredits: raw.totalCredits || 0,
        });
      });

      const enriched = await enrichBatchesWithPurchasePrice(list);
      setRows(enriched);
      setLoading(false);
    })();
  }, []);

  const toggleStatus = async (inv: InvoiceDoc) => {
    const next = inv.status === "PAGADA" ? "PENDIENTE" : "PAGADA";
    await updateDoc(doc(db, "invoices", inv.id), { status: next });
    setRows((prev) =>
      prev.map((x) => (x.id === inv.id ? { ...x, status: next } : x))
    );
    if (selected?.id === inv.id) setSelected({ ...inv, status: next });
  };

  const removeInvoice = async (inv: InvoiceDoc) => {
    if (!window.confirm(`¿Eliminar factura del ${inv.date}?`)) return;

    try {
      const invRef = doc(db, "invoices", inv.id);
      const snap = await getDoc(invRef);
      const data = snap.exists() ? (snap.data() as any) : null;

      const batch = writeBatch(db);
      const batchesFromInvoice: Array<{ id?: string; batchId?: string }> =
        data?.batches || [];

      for (const it of batchesFromInvoice) {
        const lotId = it.batchId || it.id;
        if (!lotId) continue;
        const lotRef = doc(db, "inventory_batches", lotId);
        batch.update(lotRef, {
          invoiceId: null,
          invoiceNumber: null,
          invoiceTotal: null,
        });
      }

      batch.delete(invRef);
      await batch.commit();

      setRows((prev) => prev.filter((x) => x.id !== inv.id));
      if (selected?.id === inv.id) setSelected(null);
    } catch (e) {
      console.error(e);
      alert("No se pudo eliminar la factura por completo.");
    }
  };

  const handleDownloadPDF = async () => {
    if (!detailRef.current || !selected) return;
    const el = detailRef.current;

    // Fuerza fondo blanco al rasterizar y evita sombras
    const canvas = await html2canvas(el, {
      backgroundColor: "#ffffff",
      onclone: (doc) => {
        const root = doc.body as HTMLElement;
        root.style.background = "#ffffff";
        root.querySelectorAll<HTMLElement>("*").forEach((n) => {
          // elimina sombras que se ven grises en pdf
          const s = doc.defaultView!.getComputedStyle(n);
          if (s.boxShadow && s.boxShadow !== "none") n.style.boxShadow = "none";
        });
      },
      scale: 2,
    });

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const width = pdf.internal.pageSize.getWidth();
    const height = (canvas.height * width) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 0, width, height);
    pdf.save(`factura_${selected.number || selected.date}.pdf`);
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded shadow">
      <h2 className="text-2xl font-bold mb-4">Facturación</h2>

      {/* Tabla principal */}
      <div className="bg-white p-2 rounded shadow border w-full mb-4">
        <table className="min-w-full w-full- text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">N° factura</th>
              <th className="p-2 border">Descripción</th>
              <th className="p-2 border">Libras</th>
              <th className="p-2 border">Unidades</th>
              <th className="p-2 border">Facturado</th>
              <th className="p-2 border">Ventas</th>
              <th className="p-2 border">Gastos</th>
              <th className="p-2 border">Débitos</th>
              <th className="p-2 border">Créditos</th>
              <th className="p-2 border">Monto final</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={13} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={13} className="p-4 text-center">
                  Sin facturas
                </td>
              </tr>
            ) : (
              rows.map((f) => {
                const t = computeTotalsFromDoc(f);
                return (
                  <tr key={f.id} className="text-center">
                    <td className="p-2 border">{f.date}</td>
                    <td className="p-2 border">{f.number || "—"}</td>
                    <td className="p-2 border">{f.description || "—"}</td>
                    <td className="p-2 border">{qty3(t.lbs)}</td>
                    <td className="p-2 border">{qty3(t.units)}</td>
                    <td className="p-2 border">{money(t.invoicedSum)}</td>
                    <td className="p-2 border">{money(t.expectedSum)}</td>
                    <td className="p-2 border">{money(t.expenses)}</td>
                    <td className="p-2 border">{money(t.debits)}</td>
                    <td className="p-2 border">{money(t.credits)}</td>
                    <td className="p-2 border">{money(t.finalAmount)}</td>
                    <td className="p-2 border">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          f.status === "PAGADA"
                            ? "bg-green-100 text-green-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {f.status}
                      </span>
                    </td>
                    <td className="p-2 border">
                      <div className="flex gap-2 justify-center">
                        <button
                          className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700"
                          onClick={() => setSelected(f)}
                        >
                          Ver
                        </button>
                        <button
                          className="text-xs bg-blue-600 text-white px-2 py-1 rounded hover:bg-blue-700"
                          onClick={() => toggleStatus(f)}
                        >
                          {f.status === "PAGADA"
                            ? "Marcar PENDIENTE"
                            : "Marcar PAGADA"}
                        </button>
                        <button
                          className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                          onClick={() => removeInvoice(f)}
                        >
                          Eliminar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Detalle */}
      {selected && (
        <div ref={detailRef} className="bg-white p-4 rounded shadow-2xl">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-lg font-semibold">
              Detalle {selected.date}{" "}
              {selected.number ? `— ${selected.number}` : ""}
            </h3>
            <button
              className="ml-auto px-3 py-1 border rounded"
              onClick={() => setSelected(null)}
            >
              Cerrar
            </button>
            <button
              onClick={handleDownloadPDF}
              className="bg-green-600 text-white px-3 py-1 rounded-2xl hover:bg-green-700 text-sm"
            >
              Imprimir PDF
            </button>
          </div>

          {/* Resumen breve */}
          {(() => {
            const t = computeTotalsFromDoc(selected);
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mb-4">
                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Estado:</span>{" "}
                    {selected.status}
                  </div>
                  <div>
                    <span className="font-semibold">Libras:</span> {qty3(t.lbs)}
                  </div>
                  <div>
                    <span className="font-semibold">Unidades:</span>{" "}
                    {qty3(t.units)}
                  </div>
                </div>

                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Monto Facturado:</span>{" "}
                    {money(t.invoicedSum)}
                  </div>
                  <div>
                    <span className="font-semibold">
                      Monto Ventas (Esperado):
                    </span>{" "}
                    {money(t.expectedSum)}
                  </div>
                  <div>
                    <span className="font-semibold">Ganancia Bruta:</span>{" "}
                    {money(t.grossProfit)}
                  </div>
                </div>

                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Gastos:</span>{" "}
                    {money(t.expenses)}
                  </div>
                  <div>
                    <span className="font-semibold">Débitos:</span>{" "}
                    {money(t.debits)}
                  </div>
                  <div>
                    <span className="font-semibold">Créditos:</span>{" "}
                    {money(t.credits)}
                  </div>
                </div>
              </div>
            );
          })()}

          {/* Lotes */}
          <h4 className="font-semibold mb-1">Lotes</h4>
          <table className="min-w-full text-sm mb-4 shadow-2xl">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Producto</th>
                <th className="p-2 border">Unidad</th>
                <th className="p-2 border">Cantidad</th>
                <th className="p-2 border">Precio venta</th>
                <th className="p-2 border">Total facturado</th>
                <th className="p-2 border">Total esperado</th>
                <th className="p-2 border">Ganancia bruta</th>
              </tr>
            </thead>
            <tbody>
              {(selected.batches || []).map((it, i) => {
                const qty = Number(it.quantity ?? 0);
                const expected =
                  it.expectedTotal !== undefined && it.expectedTotal !== null
                    ? Number(it.expectedTotal)
                    : qty * Number(it.salePrice ?? 0);

                let facturado = qty * Number(it.purchasePrice ?? Number.NaN);
                if (!isFinite(facturado)) {
                  facturado =
                    it.invoiceTotal !== undefined && it.invoiceTotal !== null
                      ? Number(it.invoiceTotal)
                      : 0;
                }

                const gross = expected - facturado;

                return (
                  <tr key={i} className="text-center">
                    <td className="p-2 border">
                      {it.productName || "(sin nombre)"}
                    </td>
                    <td className="p-2 border">
                      {(it.unit || "").toUpperCase()}
                    </td>
                    <td className="p-2 border">{qty3(it.quantity)}</td>
                    <td className="p-2 border">{money(it.salePrice)}</td>
                    <td className="p-2 border">{money(facturado)}</td>
                    <td className="p-2 border">{money(expected)}</td>
                    <td className="p-2 border">{money(gross)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          {/* Gastos */}
          <h4 className="font-semibold mb-1">Gastos</h4>
          <table className="min-w-full text-sm shadow-xl mb-4">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Fecha</th>
                <th className="p-2 border">Descripción</th>
                <th className="p-2 border">Monto</th>
              </tr>
            </thead>
            <tbody>
              {(selected.expenses || []).length > 0 ? (
                (selected.expenses || []).map((ex, i) => (
                  <tr key={i} className="text-center">
                    <td className="p-2 border">{ex.date}</td>
                    <td className="p-2 border">{ex.description}</td>
                    <td className="p-2 border">{money(ex.amount)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={3} className="p-3 text-center text-gray-500">
                    Sin gastos
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Cargos extras */}
          <h4 className="font-semibold mb-1">
            Cargos extras (Notas crédito/débito)
          </h4>
          <table className="min-w-full text-sm shadow-xl mb-4">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Descripción</th>
                <th className="p-2 border">Tipo de cargo</th>
                <th className="p-2 border">Monto</th>
                <th className="p-2 border">Fecha</th>
              </tr>
            </thead>
            <tbody>
              {(selected.adjustments || []).length > 0 ? (
                (selected.adjustments || []).map((a, i) => (
                  <tr key={i} className="text-center">
                    <td className="p-2 border">{a.description}</td>
                    <td className="p-2 border">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          a.type === "DEBITO"
                            ? "bg-red-100 text-red-700"
                            : "bg-green-100 text-green-700"
                        }`}
                      >
                        {a.type}
                      </span>
                    </td>
                    <td className="p-2 border">{money(a.amount)}</td>
                    <td className="p-2 border">{selected.date}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={4} className="p-3 text-center text-gray-500">
                    Sin cargos extras
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Consolidados al fondo (3 columnas + KPI) */}
          {(() => {
            const t = computeTotalsFromDoc(selected);
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 text-sm mb-2 justify-between">
                {/* Columna 1 */}
                <div className="space-y-1">
                  <div>
                    Total libras: <strong>{qty3(t.lbs)}</strong>
                  </div>
                  <div>
                    Total unidades: <strong>{qty3(t.units)}</strong>
                  </div>
                </div>

                {/* Columna 2 */}
                <div className="space-y-1 text-center">
                  <div>
                    Total facturado (costo):{" "}
                    <strong>{money(t.invoicedSum)}</strong>
                  </div>
                  <div>
                    Total esperado (ventas):{" "}
                    <strong>{money(t.expectedSum)}</strong>
                  </div>
                  <div>
                    Ganancia bruta (esperado − facturado):{" "}
                    <strong>{money(t.grossProfit)}</strong>
                  </div>
                </div>

                {/* Columna 3 */}
                <div className="space-y-1 text-right">
                  <div>
                    Gastos: <strong>{money(t.expenses)}</strong>
                  </div>
                  <div>
                    Débitos: <strong>{money(t.debits)}</strong>
                  </div>
                  <div>
                    Créditos: <strong>{money(t.credits)}</strong>
                  </div>
                </div>

                {/* KPI Final */}
                <div className="md:col-span-3 mt-3">
                  <div className="bg-blue-50 border border-blue-300 rounded-lg p-4 text-center">
                    <span className="block text-lg font-semibold text-gray-800">
                      Monto final (esperado − gastos − débitos + créditos):
                    </span>
                    <span className="block text-2xl font-bold text-blue-700 mt-1">
                      {money(t.finalAmount)}
                    </span>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
}
