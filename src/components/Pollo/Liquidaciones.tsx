// src/components/Liquidaciones.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  allocationsByBatchInRange,
  markBatchAsPaid,
} from "../../Services/inventory";
import { doc, getDoc } from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

interface BatchRow {
  batchId: string;
  batchDate: string;
  productName: string;
  soldQty: number;
  soldAmount: number;
  status: "PENDIENTE" | "PAGADO";
  purchasePrice: number; // costo unitario
  salePrice: number;
  supplier?: string;
}

export default function Liquidaciones() {
  // Por defecto, mes anterior
  const defaultMonth = subMonths(new Date(), 1);
  const [month, setMonth] = useState<string>(format(defaultMonth, "yyyy-MM")); // YYYY-MM

  const [rows, setRows] = useState<BatchRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  // 👉 contenedor para exportar a PDF
  const pdfRef = useRef<HTMLDivElement>(null);

  const range = useMemo(() => {
    const [y, m] = month.split("-").map((x) => parseInt(x, 10));
    const from = format(startOfMonth(new Date(y, m - 1, 1)), "yyyy-MM-dd");
    const to = format(endOfMonth(new Date(y, m - 1, 1)), "yyyy-MM-dd");
    return { from, to };
  }, [month]);

  const loadLiquidations = async () => {
    setLoading(true);
    try {
      // 1) Sumarios por batchId en el rango
      const allocs = await allocationsByBatchInRange(range.from, range.to);

      // 2) Enriquecer con info del batch (estado/precios/proveedor)
      const enriched: BatchRow[] = [];
      for (const a of allocs) {
        const bRef = doc(db, "inventory_batches", a.batchId);
        const bSnap = await getDoc(bRef);
        if (!bSnap.exists()) continue;
        const b = bSnap.data() as any;

        enriched.push({
          batchId: a.batchId,
          batchDate: a.batchDate,
          productName: a.productName,
          soldQty: Number(a.quantity || 0),
          soldAmount: Number(a.amountCharged || 0),
          status: (b.status as any) ?? "PENDIENTE",
          purchasePrice: Number(b.purchasePrice || 0), // costo unitario
          salePrice: Number(b.salePrice || 0),
          supplier: b.supplier,
        });
      }
      setRows(enriched);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al cargar liquidaciones");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadLiquidations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [month]);

  const pay = async (batchId: string) => {
    const ok = confirm("Marcar este lote como PAGADO?");
    if (!ok) return;
    await markBatchAsPaid(batchId);
    setRows((prev) =>
      prev.map((r) => (r.batchId === batchId ? { ...r, status: "PAGADO" } : r))
    );
  };

  // Totales del periodo (cantidad, ingreso, costo, utilidad)
  const totals = useMemo(() => {
    const q = rows.reduce((a, r) => a + r.soldQty, 0);
    const amt = rows.reduce((a, r) => a + r.soldAmount, 0);
    const cogs = rows.reduce((a, r) => a + r.soldQty * r.purchasePrice, 0);
    const profit = amt - cogs;
    return { q, amt, cogs, profit };
  }, [rows]);

  // 🔹 Agregado: consolidado por producto (usa las mismas filas)
  const byProduct = useMemo(() => {
    type Row = {
      productName: string;
      qty: number;
      revenue: number;
      cogs: number;
      profit: number;
    };
    const map = new Map<string, Row>();
    for (const r of rows) {
      const key = r.productName || "(sin nombre)";
      if (!map.has(key)) {
        map.set(key, {
          productName: key,
          qty: 0,
          revenue: 0,
          cogs: 0,
          profit: 0,
        });
      }
      const acc = map.get(key)!;
      acc.qty += r.soldQty;
      acc.revenue += r.soldAmount;
      const cogs = r.soldQty * r.purchasePrice;
      acc.cogs += cogs;
      acc.profit = acc.revenue - acc.cogs;
    }
    return Array.from(map.values()).sort((a, b) =>
      a.productName.localeCompare(b.productName)
    );
  }, [rows]);

  // 🔹 Exportar a PDF (captura el contenedor completo)
  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;
    const el = pdfRef.current;

    // Forzar colores visibles en rasterizado (opcional)
    el.classList.add("force-pdf-colors");

    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);

      const canvas = await html2canvas(el, {
        backgroundColor: "#ffffff",
        scale: 2,
      });

      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF("p", "mm", "a4");

      // Ajuste a ancho A4 manteniendo proporción
      const pageWidth = 210 - 20; // 10mm margen izq/der
      const imgProps = (pdf as any).getImageProperties(imgData);
      const imgWidth = pageWidth;
      const imgHeight = (imgProps.height * imgWidth) / imgProps.width;

      pdf.addImage(imgData, "PNG", 10, 10, imgWidth, imgHeight);
      pdf.save(`liquidaciones_${month}.pdf`);
    } catch (e) {
      console.error(e);
      alert("No se pudo generar el PDF");
    } finally {
      el.classList.remove("force-pdf-colors");
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h2 className="text-2xl font-bold">Liquidaciones por lote</h2>

        {/* Botón PDF */}
        <button
          onClick={handleDownloadPDF}
          className="bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700"
        >
          Descargar PDF
        </button>
      </div>

      {/* Selector de mes */}
      <div className="bg-white p-3 rounded shadow border mb-4 flex flex-wrap items-center gap-3">
        <label className="text-sm font-semibold">Mes:</label>
        <input
          type="month"
          className="border rounded px-2 py-1"
          value={month}
          onChange={(e) => setMonth(e.target.value)}
        />
        <button
          onClick={loadLiquidations}
          className="bg-gray-800 text-white px-3 py-1 rounded"
        >
          Aplicar
        </button>
      </div>

      {/* Todo lo imprimible va aquí */}
      <div ref={pdfRef}>
        {/* Resumen */}
        <div className="bg-white p-3 rounded shadow border mb-3 text-sm">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
            <div>
              <span className="font-semibold">Total vendido (cantidad):</span>{" "}
              {totals.q}
            </div>
            <div>
              <span className="font-semibold">Monto vendido:</span>{" "}
              {money(totals.amt)}
            </div>
            <div>
              <span className="font-semibold">Costo (COGS):</span>{" "}
              {money(totals.cogs)}
            </div>
            <div>
              <span className="font-semibold">Utilidad:</span>{" "}
              {money(totals.profit)}
            </div>
          </div>
        </div>

        {/* Tabla por lote */}
        <div className="bg-white p-2 rounded shadow border overflow-x-auto mb-6">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Lote (fecha)</th>
                <th className="p-2 border">Producto</th>
                <th className="p-2 border">Proveedor</th>
                <th className="p-2 border">Vendido</th>
                <th className="p-2 border">Monto vendido</th>
                <th className="p-2 border">COGS</th>
                <th className="p-2 border">Utilidad</th>
                <th className="p-2 border">Estado</th>
                <th className="p-2 border">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={9} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : rows.length === 0 ? (
                <tr>
                  <td colSpan={9} className="p-4 text-center">
                    Sin datos
                  </td>
                </tr>
              ) : (
                rows.map((r) => {
                  const cogs = r.soldQty * r.purchasePrice;
                  const profit = r.soldAmount - cogs;
                  return (
                    <tr key={r.batchId} className="text-center">
                      <td className="p-2 border">{r.batchDate}</td>
                      <td className="p-2 border">{r.productName}</td>
                      <td className="p-2 border">{r.supplier || "-"}</td>
                      <td className="p-2 border">{r.soldQty}</td>
                      <td className="p-2 border">{money(r.soldAmount)}</td>
                      <td className="p-2 border">{money(cogs)}</td>
                      <td
                        className={`p-2 border ${
                          profit >= 0 ? "text-green-700" : "text-red-700"
                        }`}
                      >
                        {money(profit)}
                      </td>
                      <td className="p-2 border">
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
                      <td className="p-2 border">
                        {r.status === "PENDIENTE" && (
                          <button
                            onClick={() => pay(r.batchId)}
                            className="px-2 py-1 rounded text-white bg-green-600 hover:bg-green-700"
                          >
                            Marcar pagado
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* 🔹 NUEVO: Consolidado por producto */}
        <h3 className="font-semibold mb-2">Utilidad por producto</h3>
        <div className="bg-white p-2 rounded shadow border overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-100">
              <tr>
                <th className="p-2 border">Producto</th>
                <th className="p-2 border">Cantidad vendida</th>
                <th className="p-2 border">Ingreso</th>
                <th className="p-2 border">COGS</th>
                <th className="p-2 border">Utilidad</th>
              </tr>
            </thead>
            <tbody>
              {byProduct.length === 0 ? (
                <tr>
                  <td colSpan={5} className="p-4 text-center">
                    Sin datos
                  </td>
                </tr>
              ) : (
                byProduct.map((r) => (
                  <tr key={r.productName} className="text-center">
                    <td className="p-2 border">{r.productName}</td>
                    <td className="p-2 border">{r.qty}</td>
                    <td className="p-2 border">{money(r.revenue)}</td>
                    <td className="p-2 border">{money(r.cogs)}</td>
                    <td
                      className={`p-2 border ${
                        r.profit >= 0 ? "text-green-700" : "text-red-700"
                      }`}
                    >
                      {money(r.profit)}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
