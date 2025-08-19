// src/components/Liquidaciones.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  allocationsByBatchInRange,
  markBatchAsPaid,
} from "../Services/inventory";
import { collection, doc, getDoc } from "firebase/firestore";
import { db } from "../firebase";
import { format, startOfMonth, endOfMonth, subMonths } from "date-fns";
import { getDocs, query, where } from "firebase/firestore";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

interface BatchInfo {
  id: string;
  date: string;
  productName: string;
  status: "PENDIENTE" | "PAGADO";
  purchasePrice: number;
  salePrice: number;
  supplier?: string;
}

export default function Liquidaciones() {
  // Por defecto, mes anterior
  const defaultMonth = subMonths(new Date(), 1);
  const [month, setMonth] = useState<string>(format(defaultMonth, "yyyy-MM")); // YYYY-MM

  const [rows, setRows] = useState<
    Array<{
      batchId: string;
      batchDate: string;
      productName: string;
      soldQty: number;
      soldAmount: number;
      status: "PENDIENTE" | "PAGADO";
      purchasePrice: number;
      salePrice: number;
      supplier?: string;
    }>
  >([]);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState("");

  const range = useMemo(() => {
    // Si elige 2025-08 → from=2025-08-01, to=2025-08-31
    const [y, m] = month.split("-").map((x) => parseInt(x, 10));
    const from = format(startOfMonth(new Date(y, m - 1, 1)), "yyyy-MM-dd");
    const to = format(endOfMonth(new Date(y, m - 1, 1)), "yyyy-MM-dd");
    return { from, to };
  }, [month]);

  const loadLiquidations = async () => {
    setLoading(true);
    try {
      // 1) Traer sumarios por batchId en el rango
      const allocs = await allocationsByBatchInRange(range.from, range.to);
      // 2) Enriquecer con info del batch (estado/precios/proveedor)
      const enriched: typeof rows = [];
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
          purchasePrice: Number(b.purchasePrice || 0),
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

  // Totales del periodo
  const totals = useMemo(() => {
    const q = rows.reduce((a, r) => a + r.soldQty, 0);
    const amt = rows.reduce((a, r) => a + r.soldAmount, 0);
    return { q, amt };
  }, [rows]);

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Liquidaciones por lote</h2>

      {/* Selector de mes */}
      <div className="bg-white p-3 rounded shadow border mb-4 flex items-center gap-3">
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
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Lote (fecha)</th>
              <th className="p-2 border">Producto</th>
              <th className="p-2 border">Proveedor</th>
              <th className="p-2 border">Vendido</th>
              <th className="p-2 border">Monto vendido</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={7} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={7} className="p-4 text-center">
                  Sin datos
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.batchId} className="text-center">
                  <td className="p-2 border">{r.batchDate}</td>
                  <td className="p-2 border">{r.productName}</td>
                  <td className="p-2 border">{r.supplier || "-"}</td>
                  <td className="p-2 border">{r.soldQty}</td>
                  <td className="p-2 border">{money(r.soldAmount)}</td>
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
              ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
