// src/pages/BillingCandies.tsx
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
} from "firebase/firestore";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import InvoiceCandiesModal from "./FacturasCandies";

type TransactionItem = {
  id: string;
  date: string;
  vendorId?: string | null;
  vendorName: string;
  sellerEmail?: string | null;
  productId: string;
  productName: string;
  packages: number;
  providerPricePack: number;
  salePricePack: number;
  totalProvider: number;
  totalSale: number;
  commissionPercent?: number;
  commissionAmount?: number;
};

type ExpenseItem = {
  id: string;
  description: string;
  date: string | null;
  amount: number;
};

type AdjustmentItem = {
  id: string;
  description: string;
  type: "DEBITO" | "CREDITO";
  amount: number;
};

type CandyInvoice = {
  id: string;
  date: string;
  number?: string;
  description?: string;
  status: "PENDIENTE" | "PAGADA";

  // Totales guardados
  totalPackages?: number;
  totalProvider?: number;
  totalSale?: number;
  totalExpenses?: number;
  totalDebits?: number;
  totalCredits?: number;
  totalCommissionVendors?: number;
  finalAmount?: number;
  branchFactorPercent?: number;
  branchProfit?: number;

  // Detalle
  transactions?: TransactionItem[];
  expenses?: ExpenseItem[];
  adjustments?: AdjustmentItem[];
};

const money = (n: unknown) => `C$ ${Number(n ?? 0).toFixed(2)}`;
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

/**
 * Recalcula totales de forma consistente a partir del doc.
 * Si algún total viene en el doc, se respeta; si no, se calcula desde transactions.
 */
function computeTotals(inv: CandyInvoice) {
  const txs = inv.transactions || [];
  let totalPackages = Number(inv.totalPackages ?? 0);
  let totalProvider = Number(inv.totalProvider ?? 0);
  let totalSale = Number(inv.totalSale ?? 0);
  let commissionTotal = Number(inv.totalCommissionVendors ?? 0);

  // Si no hay totales guardados, los calculamos
  if (txs.length > 0 && (totalSale === 0 || totalPackages === 0)) {
    totalPackages = 0;
    totalProvider = 0;
    totalSale = 0;
    commissionTotal = 0;

    for (const t of txs) {
      const pk = Number(t.packages ?? 0);
      totalPackages += pk;
      totalProvider += Number(
        t.totalProvider ?? pk * (t.providerPricePack ?? 0)
      );
      totalSale += Number(t.totalSale ?? pk * (t.salePricePack ?? 0));
      const commission =
        t.commissionAmount ??
        (Number(t.totalSale ?? 0) * Number(t.commissionPercent ?? 0)) / 100;
      commissionTotal += Number(commission || 0);
    }
  }

  const expensesArr = inv.expenses || [];
  const adjustments = inv.adjustments || [];

  const expenses =
    inv.totalExpenses !== undefined
      ? Number(inv.totalExpenses)
      : expensesArr.reduce((a, e) => a + Number(e.amount || 0), 0);

  const debitsFromArray = adjustments
    .filter((a) => a.type === "DEBITO")
    .reduce((s, a) => s + Number(a.amount || 0), 0);
  const creditsFromArray = adjustments
    .filter((a) => a.type === "CREDITO")
    .reduce((s, a) => s + Number(a.amount || 0), 0);

  const debits =
    inv.totalDebits !== undefined ? Number(inv.totalDebits) : debitsFromArray;
  const credits =
    inv.totalCredits !== undefined
      ? Number(inv.totalCredits)
      : creditsFromArray;

  const grossProfit = totalSale - totalProvider;

  const factor = Number(inv.branchFactorPercent ?? 0);
  const branchProfit =
    inv.branchProfit !== undefined
      ? Number(inv.branchProfit)
      : Number(((grossProfit * factor) / 100).toFixed(2));

  // Total final = sub total − comisión − gastos − débitos + créditos
  const finalAmount =
    inv.finalAmount !== undefined
      ? Number(inv.finalAmount)
      : totalSale - commissionTotal - expenses - debits + credits;

  return {
    totalPackages,
    totalProvider,
    totalSale,
    commissionTotal,
    expenses,
    debits,
    credits,
    grossProfit,
    branchProfit,
    finalAmount,
  };
}

/** Deriva un "Vendedor" principal: si todos son el mismo, lo muestra; si no, "Varios". */
function getInvoiceVendorName(inv: CandyInvoice): string {
  const txs = inv.transactions || [];
  if (txs.length === 0) return "—";
  const names = Array.from(
    new Set(txs.map((t) => t.vendorName || "Sin nombre"))
  );
  if (names.length === 1) return names[0];
  return "Varios";
}

export default function BillingCandies() {
  const [rows, setRows] = useState<CandyInvoice[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<CandyInvoice | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);

  const [showModal, setShowModal] = useState(false);

  const loadInvoices = async () => {
    setLoading(true);
    const qy = query(
      collection(db, "invoicesCandies"),
      orderBy("date", "desc")
    );
    const snap = await getDocs(qy);
    const list: CandyInvoice[] = [];
    snap.forEach((d) => {
      const raw = d.data() as any;
      list.push({
        id: d.id,
        date: raw.date,
        number: raw.number,
        description: raw.description,
        status: raw.status || "PENDIENTE",
        totalPackages: raw.totalPackages || 0,
        totalProvider: raw.totalProvider || 0,
        totalSale: raw.totalSale || 0,
        totalExpenses: raw.totalExpenses || 0,
        totalDebits: raw.totalDebits || 0,
        totalCredits: raw.totalCredits || 0,
        totalCommissionVendors: raw.totalCommissionVendors || 0,
        finalAmount: raw.finalAmount || 0,
        branchFactorPercent: raw.branchFactorPercent || 0,
        branchProfit: raw.branchProfit || 0,
        transactions: (raw.transactions || []).map((t: any) => ({
          id: t.id,
          date: t.date,
          vendorId: t.vendorId || null,
          vendorName: t.vendorName || "Sin nombre",
          sellerEmail: t.sellerEmail || null,
          productId: t.productId,
          productName: t.productName || "Sin nombre",
          packages: Number(t.packages || 0),
          providerPricePack: Number(t.providerPricePack || 0),
          salePricePack: Number(t.salePricePack || 0),
          totalProvider: Number(t.totalProvider || 0),
          totalSale: Number(t.totalSale || 0),
          commissionPercent: Number(t.commissionPercent || 0),
          commissionAmount: Number(t.commissionAmount || 0),
        })),
        expenses: (raw.expenses || []).map((e: any) => ({
          id: e.id,
          description: e.description || "",
          date: e.date || null,
          amount: Number(e.amount || 0),
        })),
        adjustments: (raw.adjustments || []).map((a: any) => ({
          id: a.id,
          description: a.description || "",
          type: a.type || "DEBITO",
          amount: Number(a.amount || 0),
        })),
      });
    });

    setRows(list);
    setLoading(false);
  };

  useEffect(() => {
    loadInvoices();
  }, []);

  const toggleStatus = async (inv: CandyInvoice) => {
    const next = inv.status === "PAGADA" ? "PENDIENTE" : "PAGADA";
    await updateDoc(doc(db, "invoicesCandies", inv.id), { status: next });
    setRows((prev) =>
      prev.map((x) => (x.id === inv.id ? { ...x, status: next } : x))
    );
    if (selected?.id === inv.id) setSelected({ ...inv, status: next });
  };

  const removeInvoice = async (inv: CandyInvoice) => {
    if (!window.confirm(`¿Eliminar factura del ${inv.date}?`)) return;

    try {
      await deleteDoc(doc(db, "invoicesCandies", inv.id));
      setRows((prev) => prev.filter((x) => x.id !== inv.id));
      if (selected?.id === inv.id) setSelected(null);
    } catch (e) {
      console.error(e);
      alert("No se pudo eliminar la factura.");
    }
  };

  const handleDownloadPDF = async () => {
    if (!detailRef.current || !selected) return;
    const el = detailRef.current;

    const canvas = await html2canvas(el, {
      backgroundColor: "#ffffff",
      onclone: (doc) => {
        const root = doc.body as HTMLElement;
        root.style.background = "#ffffff";
        root.querySelectorAll<HTMLElement>("*").forEach((n) => {
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
    pdf.save(`factura_candy_${selected.number || selected.date}.pdf`);
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded shadow">
      <div className="flex items-center mb-4 gap-3">
        <h2 className="text-2xl font-bold">Facturación CandyShop</h2>
        <button
          className="ml-auto bg-blue-600 text-white px-4 py-2 rounded-2xl hover:bg-blue-700 text-sm"
          onClick={() => setShowModal(true)}
        >
          Crear factura Candy
        </button>
      </div>

      {/* Modal de creación */}
      {showModal && (
        <InvoiceCandiesModal
          onClose={() => setShowModal(false)}
          onCreated={() => {
            setShowModal(false);
            loadInvoices();
          }}
        />
      )}

      {/* Tabla principal (sin wrap, scroll horizontal) */}
      <div className="bg-white p-2 rounded shadow border w-full mb-4 overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border whitespace-nowrap">Fecha</th>
              <th className="p-2 border whitespace-nowrap">N° factura</th>
              <th className="p-2 border whitespace-nowrap">Vendedor</th>
              <th className="p-2 border whitespace-nowrap">Comisión total</th>
              <th className="p-2 border whitespace-nowrap">Paquetes</th>
              <th className="p-2 border whitespace-nowrap">
                Sub total (sin gastos/ajustes)
              </th>
              <th className="p-2 border whitespace-nowrap">Gastos</th>
              <th className="p-2 border whitespace-nowrap">Débitos</th>
              <th className="p-2 border whitespace-nowrap">Créditos</th>
              <th className="p-2 border whitespace-nowrap">Total</th>
              <th className="p-2 border whitespace-nowrap">Estado</th>
              <th className="p-2 border whitespace-nowrap">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin facturas
                </td>
              </tr>
            ) : (
              rows.map((f) => {
                const t = computeTotals(f);
                const vendorName = getInvoiceVendorName(f);

                return (
                  <tr key={f.id} className="text-center">
                    <td className="p-2 border whitespace-nowrap">{f.date}</td>
                    <td className="p-2 border whitespace-nowrap">
                      {f.number || "—"}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {vendorName}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.commissionTotal)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {qty3(t.totalPackages)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.totalSale)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.expenses)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.debits)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.credits)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
                      {money(t.finalAmount)}
                    </td>
                    <td className="p-2 border whitespace-nowrap">
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
                    <td className="p-2 border whitespace-nowrap">
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

          {(() => {
            const t = computeTotals(selected);
            const vendorName = getInvoiceVendorName(selected);
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 text-sm mb-4">
                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Estado:</span>{" "}
                    {selected.status}
                  </div>
                  <div>
                    <span className="font-semibold">Vendedor:</span>{" "}
                    {vendorName}
                  </div>
                  <div>
                    <span className="font-semibold">Paquetes:</span>{" "}
                    {qty3(t.totalPackages)}
                  </div>
                </div>

                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Total proveedor:</span>{" "}
                    {money(t.totalProvider)}
                  </div>
                  <div>
                    <span className="font-semibold">Sub total ventas:</span>{" "}
                    {money(t.totalSale)}
                  </div>
                  <div>
                    <span className="font-semibold">Ganancia bruta:</span>{" "}
                    {money(t.grossProfit)}
                  </div>
                </div>

                <div className="space-y-1">
                  <div>
                    <span className="font-semibold">Comisión vendedores:</span>{" "}
                    {money(t.commissionTotal)}
                  </div>
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

          {/* Transacciones */}
          <h4 className="font-semibold mb-1">Transacciones</h4>
          <div className="overflow-x-auto mb-4">
            <table className="min-w-full text-sm shadow-2xl">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 border whitespace-nowrap">Fecha</th>
                  <th className="p-2 border whitespace-nowrap">Vendedor</th>
                  <th className="p-2 border whitespace-nowrap">Producto</th>
                  <th className="p-2 border whitespace-nowrap">Paquetes</th>
                  <th className="p-2 border whitespace-nowrap">
                    Precio proveedor
                  </th>
                  <th className="p-2 border whitespace-nowrap">Precio venta</th>
                  <th className="p-2 border whitespace-nowrap">
                    Total proveedor
                  </th>
                  <th className="p-2 border whitespace-nowrap">Total venta</th>
                  <th className="p-2 border whitespace-nowrap">
                    Comisión venta
                  </th>
                </tr>
              </thead>
              <tbody>
                {(selected.transactions || []).length > 0 ? (
                  (selected.transactions || []).map((it, i) => (
                    <tr key={i} className="text-center">
                      <td className="p-2 border whitespace-nowrap">
                        {it.date}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {it.vendorName}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {it.productName}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {qty3(it.packages)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(it.providerPricePack)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(it.salePricePack)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(it.totalProvider)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(it.totalSale)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(it.commissionAmount || 0)}
                        {it.commissionPercent
                          ? ` (${it.commissionPercent.toFixed(2)}%)`
                          : ""}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={9}
                      className="p-3 text-center text-gray-500 whitespace-nowrap"
                    >
                      Sin transacciones
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Gastos */}
          <h4 className="font-semibold mb-1">Gastos</h4>
          <div className="overflow-x-auto mb-4">
            <table className="min-w-full text-sm shadow-xl">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 border whitespace-nowrap">Fecha</th>
                  <th className="p-2 border whitespace-nowrap">Descripción</th>
                  <th className="p-2 border whitespace-nowrap">Monto</th>
                </tr>
              </thead>
              <tbody>
                {(selected.expenses || []).length > 0 ? (
                  (selected.expenses || []).map((ex, i) => (
                    <tr key={i} className="text-center">
                      <td className="p-2 border whitespace-nowrap">
                        {ex.date || "—"}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {ex.description || "—"}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {money(ex.amount)}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={3}
                      className="p-3 text-center text-gray-500 whitespace-nowrap"
                    >
                      Sin gastos
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Cargos extras */}
          <h4 className="font-semibold mb-1">
            Cargos extras (Notas crédito/débito)
          </h4>
          <div className="overflow-x-auto mb-4">
            <table className="min-w-full text-sm shadow-xl">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-2 border whitespace-nowrap">Descripción</th>
                  <th className="p-2 border whitespace-nowrap">
                    Tipo de cargo
                  </th>
                  <th className="p-2 border whitespace-nowrap">Monto</th>
                  <th className="p-2 border whitespace-nowrap">Fecha</th>
                </tr>
              </thead>
              <tbody>
                {(selected.adjustments || []).length > 0 ? (
                  (selected.adjustments || []).map((a, i) => (
                    <tr key={i} className="text-center">
                      <td className="p-2 border whitespace-nowrap">
                        {a.description}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
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
                      <td className="p-2 border whitespace-nowrap">
                        {money(a.amount)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {selected.date}
                      </td>
                    </tr>
                  ))
                ) : (
                  <tr>
                    <td
                      colSpan={4}
                      className="p-3 text-center text-gray-500 whitespace-nowrap"
                    >
                      Sin cargos extras
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Consolidados al fondo */}
          {(() => {
            const t = computeTotals(selected);
            return (
              <div className="grid grid-cols-1 md:grid-cols-3 text-sm mb-2 justify-between">
                {/* Columna 1 */}
                <div className="space-y-1">
                  <div>
                    Total paquetes: <strong>{qty3(t.totalPackages)}</strong>
                  </div>
                  <div>
                    Total proveedor: <strong>{money(t.totalProvider)}</strong>
                  </div>
                </div>

                {/* Columna 2 */}
                <div className="space-y-1 text-center">
                  <div>
                    Sub total ventas: <strong>{money(t.totalSale)}</strong>
                  </div>
                  <div>
                    Ganancia bruta: <strong>{money(t.grossProfit)}</strong>
                  </div>
                  <div>
                    Ganancia sucursal: <strong>{money(t.branchProfit)}</strong>
                  </div>
                </div>

                {/* Columna 3 */}
                <div className="space-y-1 text-right">
                  <div>
                    Comisión vendedores:{" "}
                    <strong>{money(t.commissionTotal)}</strong>
                  </div>
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
                      Total (sub total − comisión − gastos − débitos +
                      créditos):
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
