// src/components/InventoryBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  collection,
  getDocs,
  orderBy,
  query,
  updateDoc,
  deleteDoc,
  doc,
  addDoc, // <-- NUEVO: para crear venta en salesV2
} from "firebase/firestore";
import { db } from "../../firebase";
import { newBatch, markBatchAsPaid } from "../../Services/inventory";
import { Timestamp } from "firebase/firestore";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { roundQty } from "../../Services/decimal";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

interface Product {
  id: string;
  name: string;
  category: string;
  measurement: string;
  price: number;
}

interface Batch {
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
  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
  status: "PENDIENTE" | "PAGADO";
  notes?: string;
  paidAmount?: number;
  paidAt?: Timestamp;
}

export default function InventoryBatches() {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const { refreshKey, refresh } = useManualRefresh();

  // 🔎 Filtro por fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );

  // 🔵 Filtro por producto
  const [productFilterId, setProductFilterId] = useState<string>("");

  // 👉 Modal Crear Lote
  const [showCreateModal, setShowCreateModal] = useState(false);

  // form (crear)
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(0);
  const [salePrice, setSalePrice] = useState<number>(0);
  const [dateStr, setDateStr] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [invoiceTotal, setInvoiceTotal] = useState<number>(0);
  const [expectedTotal, setExpectedTotal] = useState<number>(0);
  const [notes, setNotes] = useState<string>("");

  // edición en tabla (por lote)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editQty, setEditQty] = useState<number>(0);
  const [editPurchase, setEditPurchase] = useState<number>(0);
  const [editSale, setEditSale] = useState<number>(0);
  const [editNotes, setEditNotes] = useState<string>("");
  const [editInvoiceTotal, setEditInvoiceTotal] = useState<number>(0);
  const [editExpectedTotal, setEditExpectedTotal] = useState<number>(0);

  // === NUEVO: estado para diálogo de "Pagar" ===
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [selectedBatch, setSelectedBatch] = useState<Batch | null>(null);

  useEffect(() => {
    (async () => {
      // 🔁 mostrar spinner también cuando se refresca manualmente
      setLoading(true);
      console.log("Refrescando...", refreshKey);

      // cargar products
      const psnap = await getDocs(collection(db, "products"));
      const prods: Product[] = [];
      psnap.forEach((d) => {
        const it = d.data() as any;
        prods.push({
          id: d.id,
          name: it.name ?? it.productName ?? "(sin nombre)",
          category: it.category ?? "(sin categoría)",
          measurement: it.measurement ?? "lb",
          price: Number(it.price ?? 0),
        });
      });
      setProducts(prods);

      // cargar batches
      const qB = query(
        collection(db, "inventory_batches"),
        orderBy("date", "desc")
      );
      const bsnap = await getDocs(qB);
      const rows: Batch[] = [];
      bsnap.forEach((d) => {
        const b = d.data() as any;
        const qty = roundQty(Number(b.quantity || 0));
        const pBuy = Number(b.purchasePrice || 0);
        const pSell = Number(b.salePrice || 0);

        const derivedInvoice = Number((qty * pBuy).toFixed(2));
        const derivedExpected = Number((qty * pSell).toFixed(2));

        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          unit: b.unit,
          quantity: qty,
          remaining: roundQty(Number(b.remaining || 0)),
          purchasePrice: pBuy,
          salePrice: pSell,
          invoiceTotal:
            b.invoiceTotal != null ? Number(b.invoiceTotal) : derivedInvoice,
          expectedTotal:
            b.expectedTotal != null ? Number(b.expectedTotal) : derivedExpected,
          date: b.date,
          createdAt: b.createdAt,
          status: b.status,
          notes: b.notes,
          paidAmount: Number(b.paidAmount || 0),
          paidAt: b.paidAt,
        });
      });
      setBatches(rows);
      setLoading(false);
    })();
  }, [refreshKey]);
  useEffect(() => {
    // sugerir salePrice del producto elegido
    const p = products.find((x) => x.id === productId);
    if (p) setSalePrice(Number(p.price || 0));
  }, [productId, products, refreshKey]);

  // cálculos automáticos (crear)
  useEffect(() => {
    setInvoiceTotal(Math.floor(quantity * purchasePrice * 100) / 100);
  }, [quantity, purchasePrice, refreshKey]);
  useEffect(() => {
    setExpectedTotal(Math.floor(quantity * salePrice * 100) / 100);
  }, [quantity, salePrice, refreshKey]);

  const isPounds = (u: string) => {
    const s = (u || "").toLowerCase();
    return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
  };

  // Filtro en memoria (fecha + producto)
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  // Totales sobre el filtro
  const totals = useMemo(() => {
    const totalFacturado = filteredBatches.reduce(
      (a, b) => a + Number(b.invoiceTotal || 0),
      0
    );
    const totalEsperado = filteredBatches.reduce(
      (a, b) => a + Number(b.expectedTotal || 0),
      0
    );

    let lbsIng = 0,
      lbsRem = 0,
      udsIng = 0,
      udsRem = 0;

    for (const b of filteredBatches) {
      if (isPounds(b.unit)) {
        lbsIng += b.quantity;
        lbsRem += b.remaining;
      } else {
        udsIng += b.quantity;
        udsRem += b.remaining;
      }
    }

    const qty = filteredBatches.reduce((a, b) => a + b.quantity, 0);
    const rem = filteredBatches.reduce((a, b) => a + b.remaining, 0);

    return {
      lbsIng,
      lbsRem,
      udsIng,
      udsRem,
      qty,
      rem,
      totalFacturado,
      totalEsperado,
    };
  }, [filteredBatches]);

  const saveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    const p = products.find((x) => x.id === productId);
    if (!p || quantity <= 0 || purchasePrice <= 0) {
      setMsg("Completa producto, cantidad y costo.");
      return;
    }
    try {
      const qtyR = roundQty(quantity);

      const ref = await newBatch({
        productId: p.id,
        productName: p.name,
        category: p.category,
        unit: p.measurement,
        quantity: qtyR,
        purchasePrice,
        salePrice,
        invoiceTotal,
        expectedTotal,
        date: dateStr,
        notes,
      });
      setBatches((prev) => [
        {
          id: ref.id,
          productId: p.id,
          productName: p.name,
          category: p.category,
          unit: p.measurement,
          quantity: qtyR,
          remaining: qtyR,
          purchasePrice,
          salePrice,
          invoiceTotal,
          expectedTotal,
          date: dateStr,
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
          notes,
        },
        ...prev,
      ]);
      setMsg("✅ Lote creado");
      setProductId("");
      setQuantity(0);
      setPurchasePrice(0);
      setSalePrice(p.price || 0);
      setInvoiceTotal(0);
      setExpectedTotal(0);
      setNotes("");
      setShowCreateModal(false);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al crear lote");
    }
  };
  // ====== Editar / Eliminar lote ======
  const startEdit = (b: Batch) => {
    setEditingId(b.id);
    setEditDate(b.date);
    setEditQty(roundQty(b.quantity));
    setEditPurchase(b.purchasePrice);
    setEditSale(b.salePrice);
    setEditNotes(b.notes || "");
    setEditInvoiceTotal(Number((b.quantity * b.purchasePrice).toFixed(2)));
    setEditExpectedTotal(Number((b.quantity * b.salePrice).toFixed(2)));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDate("");
    setEditQty(0);
    setEditPurchase(0);
    setEditSale(0);
    setEditNotes("");
    setEditInvoiceTotal(0);
    setEditExpectedTotal(0);
  };

  // recalcular totales en edición
  useEffect(() => {
    if (!editingId) return;
    setEditInvoiceTotal(Math.floor(editQty * editPurchase * 100) / 100);
  }, [editingId, editQty, editPurchase, refreshKey]);
  useEffect(() => {
    if (!editingId) return;
    setEditExpectedTotal(Math.floor(editQty * editSale * 100) / 100);
  }, [editingId, editQty, editSale, refreshKey]);

  const saveEdit = async () => {
    if (!editingId) return;
    const old = batches.find((x) => x.id === editingId);
    if (!old) return;

    const consumido = roundQty(old.quantity - old.remaining);
    const newRemaining = Math.max(0, roundQty(editQty - consumido));

    const ref = doc(db, "inventory_batches", editingId);
    await updateDoc(ref, {
      date: editDate,
      quantity: roundQty(editQty),
      purchasePrice: editPurchase,
      salePrice: editSale,
      invoiceTotal: editInvoiceTotal,
      expectedTotal: editExpectedTotal,
      notes: editNotes,
      remaining: newRemaining,
    });

    setBatches((prev) =>
      prev.map((x) =>
        x.id === editingId
          ? {
              ...x,
              date: editDate,
              quantity: roundQty(editQty),
              purchasePrice: editPurchase,
              salePrice: editSale,
              invoiceTotal: editInvoiceTotal,
              expectedTotal: editExpectedTotal,
              notes: editNotes,
              remaining: newRemaining,
            }
          : x
      )
    );
    cancelEdit();
    setMsg("✅ Lote actualizado");
  };

  const deleteBatch = async (b: Batch) => {
    const ok = confirm(`¿Eliminar el lote del ${b.date} (${b.productName})?`);
    if (!ok) return;
    await deleteDoc(doc(db, "inventory_batches", b.id));
    setBatches((prev) => prev.filter((x) => x.id !== b.id));
    setMsg("🗑️ Lote eliminado");
  };
  // ====== FIN edición/eliminación ======

  // ====== Exportar/Imprimir PDF ======
  const handlePrintPDF = () => {
    const titleRange =
      (fromDate ? `Desde ${fromDate}` : "Desde inicio") +
      " — " +
      (toDate ? `Hasta ${toDate}` : "Hasta hoy");

    const rowsHtml = filteredBatches
      .map((b) => {
        const inv = Number(b.invoiceTotal || 0);
        const exp = Number(b.expectedTotal || 0);
        return `
      <tr>
        <td>${b.date}</td>
        <td>${(b.category || "").toUpperCase()}</td>
        <td>${b.productName}</td>
        <td>${(b.unit || "").toUpperCase()}</td>
        <td style="text-align:right">${b.quantity.toFixed(3)}</td>
        <td style="text-align:right">${b.remaining.toFixed(3)}</td>
        <td style="text-align:right">${money(b.purchasePrice)}</td>
        <td style="text-align:right">${money(b.salePrice)}</td>
        <td style="text-align:right">${money(inv)}</td>
        <td style="text-align:right">${money(exp)}</td>
        <td>${b.status}</td>
      </tr>`;
      })
      .join("");

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Inventario por Lotes</title>
 <style>
  * { font-family: Arial, sans-serif; }
  h1 { margin: 0 0 4px; }
  .muted { color: #555; font-size: 12px; margin-bottom: 12px; }

  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th, td { border: 1px solid #ddd; padding: 6px; }
  th { background: #f5f5f5; text-align: left; }

  .totals {
    margin: 10px 0 16px;
    font-size: 12px;
    display: grid;
    grid-template-columns: repeat(2, max-content);
    column-gap: 32px;
    row-gap: 6px;
    align-items: center;
  }
  .totals span {
    margin: 0;
    white-space: nowrap;
  }

  @media print {
    @page { size: A4 landscape; margin: 15mm; }
    button { display: none; }
  }
</style>

</head>

<body>
  <button onclick="window.print()">Imprimir</button>
  <h1>Inventario por Lotes</h1>
<div class="muted">${titleRange}</div>
<div class="totals">
  <span><strong>Libras ingresadas:</strong> ${totals.lbsIng.toFixed(3)}</span>
  <span><strong>Libras restantes:</strong> ${totals.lbsRem.toFixed(3)}</span>

  <span><strong>Unidades ingresadas:</strong> ${totals.udsIng.toFixed(3)}</span>
  <span><strong>Unidades restantes:</strong> ${totals.udsRem.toFixed(3)}</span>

  <span><strong>Total esperado a ganar:</strong> ${money(
    totals.totalEsperado
  )}</span>
  <span><strong>Total facturado:</strong> ${money(totals.totalFacturado)}</span>
  <span><strong>Ganancia sin gastos:</strong> ${money(
    Number((totals.totalEsperado - totals.totalFacturado).toFixed(2))
  )}</span>
</div>

  <table>
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Tipo</th>
        <th>Producto</th>
        <th>Unidad</th>
        <th>Ingresado</th>
        <th>Restantes</th>
        <th>Precio Compra</th>
        <th>Precio Venta</th>
        <th>Total factura</th>
        <th>Total esperado</th>
        <th>Estado</th>
      </tr>
    </thead>
    <tbody>
      ${
        rowsHtml ||
        `<tr><td colspan="11" style="text-align:center">Sin lotes</td></tr>`
      }
    </tbody>
  </table>
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };
  // === Pagar (abre modal visual en lugar de confirm()) ===
  const payBatch = async (b: Batch) => {
    // NO ejecuta lógica aquí; solo abre el diálogo visual
    setSelectedBatch(b);
    setShowPayDialog(true);
  };

  // === Confirmar pago: marca PAGADO, pone remaining=0 y crea venta en salesV2 ===
  const confirmPayNow = async () => {
    if (!selectedBatch) return;
    const b = selectedBatch;

    try {
      // 1) Marcar pagado (tu misma función)
      await markBatchAsPaid(b.id);

      // 2) Debitar libras (remaining -> 0)
      const ref = doc(db, "inventory_batches", b.id);
      await updateDoc(ref, { remaining: 0 });

      // 3) Crear venta en salesV2 (para que el dashboard la cuente)
      const saleDoc = {
        date: b.date,
        productName: b.productName,
        quantity: b.quantity, // venta total del lote
        amount: Number(
          (b.expectedTotal ?? b.salePrice * b.quantity).toFixed(2)
        ),
        allocations: [
          {
            batchId: b.id,
            qty: b.quantity,
            unitCost: b.purchasePrice,
            lineCost: Number((b.purchasePrice * b.quantity).toFixed(2)),
          },
        ],
        avgUnitCost: b.purchasePrice,
        measurement: b.unit,
        createdAt: Timestamp.now(),
        autoGeneratedFromInventory: true,
      };
      await addDoc(collection(db, "salesV2"), saleDoc);

      // 4) Refrescar en UI
      setBatches((prev) =>
        prev.map((x) =>
          x.id === b.id ? { ...x, status: "PAGADO", remaining: 0 } : x
        )
      );
      setMsg("✅ Inventario pagado y reflejado como venta");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al pagar inventario");
    } finally {
      setShowPayDialog(false);
      setSelectedBatch(null);
    }
  };

  const cancelPayDialog = () => {
    setShowPayDialog(false);
    setSelectedBatch(null);
  };

  return (
    <div className="max-w-6xl mx-auto shadows-2xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Inventario (Pollo)</h2>
        <button
          className="px-3 py-2 rounded-2xl bg-blue-600 text-white hover:bg-blue-700"
          type="button"
          onClick={() => setShowCreateModal(true)}
        >
          Crear Lote
        </button>
      </div>

      {/* 🔎 Barra de filtro por fecha */}
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

        {/* Filtro por producto */}
        <div className="flex flex-col min-w-[240px]">
          <label className="font-semibold">Producto</label>
          <select
            className="border rounded px-2 py-1"
            value={productFilterId}
            onChange={(e) => setProductFilterId(e.target.value)}
          >
            <option value="">Todos</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.category}
              </option>
            ))}
          </select>
        </div>

        <button
          className="px-3 rounded-2xl shadow-2xl py-1 bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProductFilterId("");
          }}
        >
          Quitar filtro
        </button>

        {/* 🖨️ Imprimir/Exportar PDF */}
        <button
          className="px-3 py-1 rounded-2xl shadow-2xl bg-blue-600 text-white hover:bg-blue-700"
          onClick={handlePrintPDF}
        >
          Imprimir PDF
        </button>

        {/* 🔄 Refresh manual */}
        <div className="ml-auto">
          <RefreshButton onClick={() => refresh()} loading={loading} />
        </div>
      </div>

      {/* Totales (sobre el filtro) */}
      <div className="bg-gray-50 p-3 rounded-2xl shadow-2xl border mb-3 text-base">
        <div className="grid grid-cols-3 gap-y-2 gap-x-8">
          <div>
            <span className="font-semibold">Libras ingresadas:</span>{" "}
            {totals.lbsIng.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Unidades ingresadas:</span>{" "}
            {totals.udsIng.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Total esperado en ventas:</span> C${" "}
            {totals.totalEsperado.toFixed(2)}
          </div>

          <div>
            <span className="font-semibold">Libras restantes:</span>{" "}
            {totals.lbsRem.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Unidades restantes:</span>{" "}
            {totals.udsRem.toFixed(3)}
          </div>
          <div>
            <span className="font-semibold">Total facturado:</span> C${" "}
            {totals.totalFacturado.toFixed(2)}
          </div>
          <div>
            <span className="font-semibold">Ganancia sin gastos:</span> C${" "}
            {(totals.totalEsperado - totals.totalFacturado).toFixed(2)}
          </div>
          <div>
            <span className="font-semibold">
              Cantidad de Lotes (por filtro):
            </span>{" "}
            {filteredBatches.length.toLocaleString()}
          </div>
        </div>
      </div>

      {/* Tabla de lotes (filtrada) */}
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm shadow-2xl">
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
              <th className="p-2 border">Total ganancia</th>
              <th className="p-2 border">Estado</th>
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
            ) : filteredBatches.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin lotes
                </td>
              </tr>
            ) : (
              filteredBatches.map((b) => {
                const isEditing = editingId === b.id;
                const inv = Number(b.invoiceTotal || 0);
                const exp = Number(b.expectedTotal || 0);
                return (
                  <tr key={b.id} className="text-center">
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="date"
                          className="w-full border p-1 rounded"
                          value={editDate}
                          onChange={(e) => setEditDate(e.target.value)}
                        />
                      ) : (
                        b.date
                      )}
                    </td>
                    <td className="p-2 border">{b.category.toUpperCase()}</td>
                    <td className="p-2 border">{b.productName}</td>
                    <td className="p-2 border">{b.unit.toUpperCase()}</td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-full border p-1 rounded text-right"
                          value={Number.isNaN(editQty) ? "" : editQty}
                          onChange={(e) => {
                            const raw = e.target.value.replace(",", ".");
                            const num = parseFloat(raw);
                            const safe = Number.isFinite(num)
                              ? parseFloat(num.toFixed(3))
                              : 0;
                            setEditQty(Math.max(0, safe));
                          }}
                        />
                      ) : (
                        b.quantity.toFixed(3)
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? b.remaining : b.remaining.toFixed(3)}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-full border p-1 rounded text-right"
                          value={Number.isNaN(editPurchase) ? "" : editPurchase}
                          onChange={(e) => {
                            const raw = e.target.value.replace(",", ".");
                            const num = parseFloat(raw);
                            const safe = Number.isFinite(num)
                              ? parseFloat(num.toFixed(2))
                              : 0;
                            setEditPurchase(Math.max(0, safe));
                          }}
                        />
                      ) : (
                        money(b.purchasePrice)
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-full border p-1 rounded text-right"
                          value={Number.isNaN(editSale) ? "" : editSale}
                          onChange={(e) => {
                            const raw = e.target.value.replace(",", ".");
                            const num = parseFloat(raw);
                            const safe = Number.isFinite(num)
                              ? parseFloat(num.toFixed(2))
                              : 0;
                            setEditSale(Math.max(0, safe));
                          }}
                        />
                      ) : (
                        money(b.salePrice)
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? money(editInvoiceTotal) : money(inv)}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? money(editExpectedTotal) : money(exp)}
                    </td>
                    <td className="p-2 border">
                      {isEditing
                        ? money(editExpectedTotal - editInvoiceTotal)
                        : money(exp - inv)}
                    </td>
                    <td className="p-2 border">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          b.status === "PAGADO"
                            ? "bg-green-100 text-green-700"
                            : "bg-yellow-100 text-yellow-700"
                        }`}
                      >
                        {b.status}
                      </span>
                    </td>
                    <td className="flex space-x-2 justify-center">
                      {isEditing ? (
                        <>
                          <button
                            className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </>
                      ) : (
                        <>
                          {b.status === "PENDIENTE" && (
                            <button
                              onClick={() => payBatch(b)}
                              className="px-2 py-1 rounded text-white bg-green-600 hover:bg-green-700"
                            >
                              Pagar
                            </button>
                          )}
                          <button
                            className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                            onClick={() => startEdit(b)}
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                            onClick={() => deleteBatch(b)}
                          >
                            Borrar
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* ===== Modal: Form Crear Lote (sin cambios) ===== */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-4xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">Crear Lote</h3>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              {/* === Formulario original === */}
              <form
                onSubmit={saveBatch}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Producto
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    <option value="">Selecciona un producto</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.category} — {p.measurement} — Precio:{" "}
                        {money(p.price)}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Fecha del lote
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={dateStr}
                    onChange={(e) => setDateStr(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Cantidad (Lo que esta ingresando)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={quantity === 0 ? "" : quantity}
                    onChange={(e) => {
                      const raw = e.target.value.replace(",", ".");
                      const num = parseFloat(raw);
                      const safe = Number.isFinite(num)
                        ? parseFloat(num.toFixed(3))
                        : 0;
                      setQuantity(safe);
                    }}
                    disabled={!productId}
                    placeholder={
                      !productId ? "Selecciona un producto primero" : ""
                    }
                    title={
                      !productId ? "Selecciona un producto para habilitar" : ""
                    }
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Precio de compra (compra)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={purchasePrice === 0 ? "" : purchasePrice}
                    onChange={(e) => {
                      const raw = e.target.value.replace(",", ".");
                      const num = parseFloat(raw);
                      const safe = Number.isFinite(num)
                        ? parseFloat(num.toFixed(2))
                        : 0;
                      setPurchasePrice(safe);
                    }}
                    disabled={!productId}
                    placeholder={
                      !productId ? "Selecciona un producto primero" : ""
                    }
                    title={
                      !productId ? "Selecciona un producto para habilitar" : ""
                    }
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Precio de venta (venta)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={salePrice === 0 ? "" : salePrice}
                    onChange={(e) => {
                      const raw = e.target.value.replace(",", ".");
                      const num = parseFloat(raw);
                      const safe = Number.isFinite(num)
                        ? parseFloat(num.toFixed(2))
                        : 0;
                      setSalePrice(safe);
                    }}
                    disabled={!productId}
                    placeholder={
                      !productId ? "Selecciona un producto primero" : ""
                    }
                    title={
                      !productId ? "Selecciona un producto para habilitar" : ""
                    }
                  />
                </div>

                {/* campos calculados */}
                <div>
                  <label className="block text-sm font-semibold">
                    Total factura (auto)
                  </label>
                  <input
                    type="text"
                    className="w-full border p-2 rounded bg-gray-100"
                    value={money(invoiceTotal)}
                    readOnly
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Total esperado (auto)
                  </label>
                  <input
                    type="text"
                    className="w-full border p-2 rounded bg-gray-100"
                    value={money(expectedTotal)}
                    readOnly
                  />
                </div>

                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">Notas</label>
                  <input
                    className="w-full border p-2 rounded"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                </div>

                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cancelar
                  </button>
                  <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                    Guardar lote
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body
        )}

      {/* ===== NUEVO: Modal visual Confirmar Pago ===== */}
      {showPayDialog &&
        selectedBatch &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={cancelPayDialog}
            />
            <div className="relative bg-white rounded-xl shadow-2xl border w-[90%] max-w-md p-6">
              <h3 className="text-lg font-bold mb-3 text-center">
                Confirmar pago de inventario
              </h3>
              <p className="text-sm text-gray-700 mb-5 text-center">
                ¿Seguro que quieres pagar este inventario?
                <br />
                <strong>{selectedBatch.productName}</strong> —{" "}
                {selectedBatch.quantity} {selectedBatch.unit}
                <br />
                Ya no habrán libras disponibles al pagar este inventario.
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={confirmPayNow}
                  className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700"
                >
                  Confirmar
                </button>
                <button
                  onClick={cancelPayDialog}
                  className="px-4 py-2 rounded-lg bg-gray-300 hover:bg-gray-400"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </div>
  );
}
