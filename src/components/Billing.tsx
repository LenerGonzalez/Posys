// src/pages/Billing.tsx
import React, { useEffect, useState, useRef } from "react";
import { db } from "../firebase";
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
  id: string;
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  salePrice: number;
  amount: number;
  batchDate?: string;
};

type ExpenseItem = {
  id: string;
  description: string;
  date: string;
  amount: number;
};

type InvoiceDoc = {
  id: string;
  date: string;
  number?: string;
  description?: string;
  status: "PENDIENTE" | "PAGADA";
  batches?: BatchItem[];
  expenses?: ExpenseItem[];
  totals?: {
    lbs: number;
    units: number;
    amount: number;
    expenses: number;
    finalAmount: number;
  };
  totalLbs?: number;
  totalUnits?: number;
  totalAmount?: number;
  totalExpenses?: number;
  finalAmount?: number;
};

const money = (n: number) => `C$ ${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);

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
          totals: raw.totals || {
            lbs: raw.totalLbs || 0,
            units: raw.totalUnits || 0,
            amount: raw.totalAmount || 0,
            expenses: raw.totalExpenses || 0,
            finalAmount: raw.finalAmount || 0,
          },
        });
      });
      setRows(list);
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
    const canvas = await html2canvas(el, {
      backgroundColor: "#ffffff",
    });
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");
    const width = pdf.internal.pageSize.getWidth();
    const height = (canvas.height * width) / canvas.width;
    pdf.addImage(imgData, "PNG", 0, 0, width, height);
    pdf.save(`factura_${selected.number || selected.date}.pdf`);
  };

  const getHeaderTotals = (f: InvoiceDoc) =>
    f.totals || {
      lbs: f.totalLbs || 0,
      units: f.totalUnits || 0,
      amount: f.totalAmount || 0,
      expenses: f.totalExpenses || 0,
      finalAmount: f.finalAmount || 0,
    };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded shadow">
      <h2 className="text-2xl font-bold mb-4">Facturación</h2>

      {/* Tabla principal */}
      <div className="bg-white p-2 rounded shadow border w-full mb-4">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">N° factura</th>
              <th className="p-2 border">Descripción</th>
              <th className="p-2 border">Libras</th>
              <th className="p-2 border">Unidades</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Gastos</th>
              <th className="p-2 border">Monto final</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={10} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={10} className="p-4 text-center">
                  Sin facturas
                </td>
              </tr>
            ) : (
              rows.map((f) => {
                const t = getHeaderTotals(f);
                return (
                  <tr key={f.id} className="text-center">
                    <td className="p-2 border">{f.date}</td>
                    <td className="p-2 border">{f.number || "—"}</td>
                    <td className="p-2 border">{f.description || "—"}</td>
                    <td className="p-2 border">{qty3(t.lbs)}</td>
                    <td className="p-2 border">{qty3(t.units)}</td>
                    <td className="p-2 border">{money(t.amount)}</td>
                    <td className="p-2 border">{money(t.expenses)}</td>
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
        <div ref={detailRef} className="bg-white p-4 rounded shadow border">
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
              className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm"
            >
              Imprimir PDF
            </button>
          </div>

          {/* Totales */}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm mb-3">
            <div>
              <span className="font-semibold">Estado:</span> {selected.status}
            </div>
            <div>
              <span className="font-semibold">Libras:</span>{" "}
              {qty3(selected.totals?.lbs || 0)}
            </div>
            <div>
              <span className="font-semibold">Unidades:</span>{" "}
              {qty3(selected.totals?.units || 0)}
            </div>
            <div>
              <span className="font-semibold">Monto:</span>{" "}
              {money(selected.totals?.amount || 0)}
            </div>
            <div>
              <span className="font-semibold">Gastos:</span>{" "}
              {money(selected.totals?.expenses || 0)}
            </div>
            <div>
              <span className="font-semibold">Monto final:</span>{" "}
              {money(selected.totals?.finalAmount || 0)}
            </div>
          </div>

          {/* Items de la factura */}
          <h4 className="font-semibold mb-1">Lotes</h4>
          <table className="min-w-full text-sm mb-4">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Producto</th>
                <th className="p-2 border">Unidad</th>
                <th className="p-2 border">Cantidad</th>
                <th className="p-2 border">Precio venta</th>
                <th className="p-2 border">Total esperado</th>
              </tr>
            </thead>
            <tbody>
              {selected.batches && selected.batches.length > 0 ? (
                selected.batches.map((it, i) => (
                  <tr key={i} className="text-center">
                    <td className="p-2 border">
                      {it.productName || "(sin nombre)"}
                    </td>
                    <td className="p-2 border">
                      {(it.unit || "").toUpperCase()}
                    </td>
                    <td className="p-2 border">{qty3(it.quantity)}</td>
                    <td className="p-2 border">{money(it.salePrice)}</td>
                    <td className="p-2 border">{money(it.amount)}</td>
                  </tr>
                ))
              ) : (
                <tr>
                  <td colSpan={5} className="p-3 text-center text-gray-500">
                    Sin items
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          {/* Gastos */}
          <h4 className="font-semibold mb-1">Gastos</h4>
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Fecha</th>
                <th className="p-2 border">Descripción</th>
                <th className="p-2 border">Monto</th>
              </tr>
            </thead>
            <tbody>
              {selected.expenses && selected.expenses.length > 0 ? (
                selected.expenses.map((ex, i) => (
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
        </div>
      )}
    </div>
  );
}
