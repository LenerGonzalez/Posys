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
  deleteDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format } from "date-fns";
import InvoiceModal from "../../components/Pollo/InvoiceModal";
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

type Batch = {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string;
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  invoiceTotal?: number;
  expectedTotal?: number;
  date: string;
  status: "PENDIENTE" | "PAGADO";
  paidAt?: any;
};

const money = (n: number) => `C$ ${Number(n || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);

const isLB = (u: string) =>
  (u || "").toLowerCase() === "lb" || /libra/.test((u || "").toLowerCase());

export default function PaidBatches() {
  const [rows, setRows] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);

  const [showConfirm, setShowConfirm] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);

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

        const qty = Number(b.quantity || 0);
        const rem = Number(b.remaining || 0);
        const pBuy = Number(b.purchasePrice || 0);
        const pSell = Number(b.salePrice || 0);

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

  const askMarkPending = (b: Batch) => {
    setSelectedBatch(b);
    setShowConfirm(true);
  };

  const confirmMarkPending = async () => {
    if (!selectedBatch) return;
    try {
      const batchRef = doc(db, "inventory_batches", selectedBatch.id);
      await updateDoc(batchRef, {
        status: "PENDIENTE",
        remaining: selectedBatch.quantity,
      });

      const salesRef = collection(db, "salesV2");
      const salesSnap1 = await getDocs(
        query(salesRef, where("batchId", "==", selectedBatch.id))
      );
      const salesSnap2 = await getDocs(
        query(
          salesRef,
          where("productName", "==", selectedBatch.productName),
          where("date", "==", selectedBatch.date)
        )
      );

      const allSales = [...salesSnap1.docs, ...salesSnap2.docs];
      for (const s of allSales) {
        await deleteDoc(doc(db, "salesV2", s.id));
      }

      setShowConfirm(false);
      setSelectedBatch(null);
      refresh();
    } catch (e) {
      console.error("Error al marcar pendiente:", e);
    }
  };

  const productOptions = useMemo(() => {
    const m = new Map<string, { id: string; name: string }>();
    rows.forEach((r) =>
      m.set(r.productId, { id: r.productId, name: r.productName })
    );
    return Array.from(m.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [rows]);

  return (
    <div className="max-w-7xl mx-auto px-3 sm:px-0">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Pagados</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {/* Filtros */}
      <div className="bg-white p-3 rounded-2xl shadow-2xl border mb-4 flex flex-col sm:flex-row sm:items-end gap-3 text-sm">
        <div className="flex flex-wrap gap-3">
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
            type="button"
            className="px-3 py-1 rounded-2xl bg-gray-200 hover:bg-gray-300"
            onClick={() => {
              setFromDate("");
              setToDate("");
              setProduct("");
            }}
          >
            Quitar filtro
          </button>
        </div>

        <button
          type="button"
          className="sm:ml-auto px-3 py-2 rounded-2xl bg-blue-600 text-white hover:bg-blue-700"
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
          <div className="col-span-2">
            <span className="font-semibold">Ganancia sin gastos:</span>{" "}
            {money(totals.gross)}
          </div>
          <div>
            <span className="font-semibold">Cantidad de Lotes:</span>{" "}
            {filtered.length.toLocaleString()}
          </div>
        </div>
      </div>

      {/* ✅ MOBILE FIRST: Cards en móvil */}
      <div className="block md:hidden space-y-3">
        {loading ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            Cargando…
          </div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            Sin lotes pagados
          </div>
        ) : (
          filtered.map((b) => (
            <div key={b.id} className="bg-white border rounded-2xl shadow p-3">
              <div className="flex items-start justify-between gap-2">
                <div>
                  <div className="font-semibold">{b.productName}</div>
                  <div className="text-xs text-gray-500">
                    {(b.category || "").toUpperCase()} • {b.date} •{" "}
                    {(b.unit || "").toUpperCase()}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold">
                    {money(b.expectedTotal || 0)}
                  </div>
                  <div className="text-[11px] text-gray-500">Esperado</div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                <div className="bg-gray-50 border rounded-xl p-2">
                  <div className="text-xs text-gray-500">Ingresado</div>
                  <div className="font-semibold">{qty3(b.quantity)}</div>
                </div>
                <div className="bg-gray-50 border rounded-xl p-2">
                  <div className="text-xs text-gray-500">Restantes</div>
                  <div className="font-semibold">{qty3(b.remaining)}</div>
                </div>
                <div className="bg-gray-50 border rounded-xl p-2">
                  <div className="text-xs text-gray-500">Costo</div>
                  <div className="font-semibold">
                    {money(b.invoiceTotal || 0)}
                  </div>
                </div>
                <div className="bg-gray-50 border rounded-xl p-2">
                  <div className="text-xs text-gray-500">Fecha pago</div>
                  <div className="font-semibold">
                    {b.paidAt?.toDate
                      ? format(b.paidAt.toDate(), "yyyy-MM-dd")
                      : "—"}
                  </div>
                </div>
              </div>

              <div className="mt-3">
                <button
                  type="button"
                  className="w-full px-3 py-2 rounded-xl text-white bg-yellow-600 hover:bg-yellow-700"
                  onClick={() => askMarkPending(b)}
                >
                  Marcar PENDIENTE
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* ✅ Tabla solo md+ */}
      <div className="hidden md:block bg-white p-2 rounded shadow-2xl border w-full">
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
                      type="button"
                      className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                      onClick={() => askMarkPending(b)}
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
          paidBatches={rows} // ✅ todos los pagados, el modal filtra adentro
          onClose={() => setOpenInvoice(false)}
          onCreated={() => setOpenInvoice(false)}
        />
      )}

      {/* Confirmación */}
      {showConfirm && selectedBatch && (
        <div className="fixed inset-0 flex items-center justify-center bg-black/50 z-50 p-3">
          <div className="bg-white rounded-2xl shadow-2xl p-6 w-full max-w-md">
            <h3 className="text-lg font-semibold mb-3">Confirmar acción</h3>
            <p className="text-gray-700 mb-4">
              ¿Seguro que quieres marcar pendiente este inventario?
              <br />
              Al hacerlo, las libras se restaurarán y se eliminarán las ventas
              generadas.
            </p>
            <div className="flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowConfirm(false)}
                className="px-4 py-2 bg-gray-200 hover:bg-gray-300 rounded-xl"
              >
                Cancelar
              </button>
              <button
                type="button"
                onClick={confirmMarkPending}
                className="px-4 py-2 bg-yellow-600 text-white hover:bg-yellow-700 rounded-xl"
              >
                Confirmar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
