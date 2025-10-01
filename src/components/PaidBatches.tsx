// src/pages/PaidBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  orderBy,
  query,
  updateDoc,
  doc,
  where,
} from "firebase/firestore";
import { db } from "../firebase";
import { format } from "date-fns";
import InvoiceModal from "../components/InvoiceModal";
import RefreshButton from "../components/common/RefreshButton";
import useManualRefresh from "../hooks/useManualRefresh";

type Batch = {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string; // "LB" / "UD" / etc
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  invoiceTotal?: number; // costo (qty * purchasePrice)
  expectedTotal?: number; // venta (qty * salePrice)
  date: string; // yyyy-MM-dd (fecha del lote)
  status: "PENDIENTE" | "PAGADO";
  paidAt?: any; // Timestamp | string
};

const money = (n: number) => `C$ ${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);

const isLB = (u: string) =>
  (u || "").toLowerCase() === "lb" || /libra/.test((u || "").toLowerCase());

export default function PaidBatches() {
  const [rows, setRows] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  // filtros
  const [fromDate, setFromDate] = useState<string>(
    format(
      new Date(new Date().getFullYear(), new Date().getMonth(), 1),
      "yyyy-MM-dd"
    )
  );
  const [toDate, setToDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [product, setProduct] = useState<string>("");

  const [openInvoice, setOpenInvoice] = useState(false);
  const { refreshKey, refresh } = useManualRefresh();

  useEffect(() => {
    (async () => {
      setLoading(true);
      const qy = query(
        collection(db, "inventory_batches"),
        where("status", "==", "PAGADO"),
        orderBy("date", "desc")
      );
      const snap = await getDocs(qy);
      const out: Batch[] = [];

      snap.forEach((d) => {
        const b = d.data() as any;

        // Normalizamos números
        const qty = Number(b.quantity || 0);
        const rem = Number(b.remaining || 0);
        const pBuy = Number(b.purchasePrice || 0);
        const pSell = Number(b.salePrice || 0);

        // 🔧 Derivamos como en InventoryBatches (clave del desfase)
        const derivedInvoice = Number((qty * pBuy).toFixed(2));
        const derivedExpected = Number((qty * pSell).toFixed(2));

        out.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          unit: b.unit,
          quantity: qty,
          remaining: rem,
          purchasePrice: pBuy,
          salePrice: pSell,
          invoiceTotal:
            b.invoiceTotal != null ? Number(b.invoiceTotal) : derivedInvoice,
          expectedTotal:
            b.expectedTotal != null ? Number(b.expectedTotal) : derivedExpected,
          date: b.date,
          status: b.status,
          paidAt: b.paidAt,
        });
      });

      setRows(out);
      setLoading(false);
    })();
  }, [refreshKey]);

  const filtered = useMemo(() => {
    return rows.filter((r) => {
      if (fromDate && r.date < fromDate) return false;
      if (toDate && r.date > toDate) return false;
      if (product && r.productId !== product) return false;
      return true;
    });
  }, [rows, fromDate, toDate, product]);

  // Totales del filtro
  const totals = useMemo(() => {
    let lbsIng = 0,
      lbsRem = 0,
      udsIng = 0,
      udsRem = 0,
      totalEsperado = 0,
      totalFact = 0;

    for (const r of filtered) {
      if (isLB(r.unit)) {
        lbsIng += r.quantity;
        lbsRem += r.remaining;
      } else {
        udsIng += r.quantity;
        udsRem += r.remaining;
      }
      totalEsperado += Number(r.expectedTotal || 0);
      totalFact += Number(r.invoiceTotal || 0);
    }

    return {
      lbsIng,
      lbsRem,
      udsIng,
      udsRem,
      totalEsperado,
      totalFact,
      gross: totalEsperado - totalFact,
    };
  }, [filtered]);

  const markPending = async (b: Batch) => {
    if (
      !window.confirm(`Marcar PENDIENTE el lote ${b.productName} (${b.date})?`)
    )
      return;
    await updateDoc(doc(db, "inventory_batches", b.id), {
      status: "PENDIENTE",
    });
    setRows((prev) =>
      prev.map((x) => (x.id === b.id ? { ...x, status: "PENDIENTE" } : x))
    );
  };

  // productos para filtro
  const productOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    rows.forEach((r) =>
      m.set(r.productId, { id: r.productId, name: r.productName })
    );
    return Array.from(m.values());
  }, [rows]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Pagados</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {/* Filtros */}
      <div className="bg-white p-3 rounded shadow-2xl border mb-4 flex flex-wrap items-end gap-3 text-sm">
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
        <div className="flex flex-col min-w-[240px]">
          <label className="font-semibold">Producto</label>
          <select
            className="border rounded px-2 py-1"
            value={product}
            onChange={(e) => setProduct(e.target.value)}
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
          className="px-3 py-1 rounded-2xl bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProduct("");
          }}
        >
          Quitar filtro
        </button>

        <button
          className="ml-auto px-3 py-1 rounded-2xl bg-blue-600 text-white hover:bg-blue-700"
          onClick={() => setOpenInvoice(true)}
        >
          Crear factura
        </button>
      </div>

      {/* Totales */}
      <div className="bg-gray-50 p-3 rounded-2xl shadow-2xl border mb-3 text-base">
        <div className="grid grid-cols-2 gap-y-2 gap-x-8">
          <div>
            <span className="font-semibold">Libras ingresadas:</span>{" "}
            {qty3(totals.lbsIng)}
          </div>
          <div>
            <span className="font-semibold">Unidades ingresadas:</span>{" "}
            {qty3(totals.udsIng)}
          </div>
          <div>
            <span className="font-semibold">Total esperado en ventas:</span>{" "}
            {money(totals.totalEsperado)}
          </div>

          <div>
            <span className="font-semibold">Libras restantes:</span>{" "}
            {qty3(totals.lbsRem)}
          </div>
          <div>
            <span className="font-semibold">Unidades restantes:</span>{" "}
            {qty3(totals.udsRem)}
          </div>
          <div>
            <span className="font-semibold">Total facturado:</span>{" "}
            {money(totals.totalFact)}
          </div>

          <div className="col-span-3">
            <span className="font-semibold">Ganancia sin gastos:</span>{" "}
            {money(totals.gross)}
          </div>
          <div>
            <span className="font-semibold">
              Cantidad de Lotes (por filtro):
            </span>{" "}
            {filtered.length.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow-2xl border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Tipo</th>
              <th className="p-2 border">Producto</th>
              <th className="p-2 border">Unidad</th>
              <th className="p-2 border">Ingresado</th>
              <th className="p-2 border">Restantes</th>
              <th className="p-2 border">Precio Compra</th>
              <th className="p-2 border">Precio Venta</th>
              <th className="p-2 border">Total factura</th>
              <th className="p-2 border">Total esperado</th>
              <th className="p-2 border">Fecha pago</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin lotes pagados
                </td>
              </tr>
            ) : (
              filtered.map((b) => (
                <tr key={b.id} className="text-center">
                  <td className="p-2 border">{b.date}</td>
                  <td className="p-2 border">
                    {(b.category || "").toUpperCase()}
                  </td>
                  <td className="p-2 border">{b.productName}</td>
                  <td className="p-2 border">{(b.unit || "").toUpperCase()}</td>
                  <td className="p-2 border">{qty3(b.quantity)}</td>
                  <td className="p-2 border">{qty3(b.remaining)}</td>
                  <td className="p-2 border">{money(b.purchasePrice)}</td>
                  <td className="p-2 border">{money(b.salePrice)}</td>
                  <td className="p-2 border">{money(b.invoiceTotal || 0)}</td>
                  <td className="p-2 border">{money(b.expectedTotal || 0)}</td>
                  <td className="p-2 border">
                    {b.paidAt?.toDate
                      ? format(b.paidAt.toDate(), "yyyy-MM-dd")
                      : "—"}
                  </td>
                  <td className="p-2 border">
                    <button
                      className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                      onClick={() => markPending(b)}
                    >
                      Marcar PENDIENTE
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Modal de factura */}
      {openInvoice && (
        <InvoiceModal
          paidBatches={filtered}
          onClose={() => setOpenInvoice(false)}
          onCreated={() => setOpenInvoice(false)}
        />
      )}
    </div>
  );
}
