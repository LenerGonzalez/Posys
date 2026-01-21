import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format } from "date-fns";
import { restoreSaleAndDeleteClothes } from "../../Services/inventory_clothes"; // 👈 NUEVO import

type SaleType = "CONTADO" | "CREDITO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

interface Customer {
  id: string;
  name: string;
}

interface SaleItem {
  productId: string;
  productName: string;
  sku?: string;
  qty: number;
  unitPrice: number;
  total: number;
}
interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;
  quantity: number;
  customerId?: string;
  customerName?: string;
  downPayment?: number;
  item: SaleItem;
}

interface BatchRow {
  id: string;
  productId: string;
  date: string;
  quantity: number;
  remaining: number;
}

function ensureDate(x: any): string {
  if (x?.date) return x.date;
  if (x?.createdAt?.toDate) return format(x.createdAt.toDate(), "yyyy-MM-dd");
  return "";
}
function normalizeSale(d: any, id: string): SaleDoc | null {
  const date = ensureDate(d);
  if (!date) return null;

  const item = d.item || {};
  const qty = Number(item?.qty ?? d.quantity ?? 0) || 0;
  const lineTotal = Number(item?.total ?? d.total ?? 0) || 0;
  const unitPrice =
    Number(item?.unitPrice ?? (qty > 0 ? lineTotal / qty : 0)) || 0;

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total: Number(d.total || 0),
    quantity: Number(d.quantity || qty || 0),
    customerId: d.customerId || undefined,
    customerName: d.customerName || undefined,
    downPayment: Number(d.downPayment || 0),
    item: {
      productId: String(item?.productId || d.productId || ""),
      productName: String(item?.productName || d.productName || ""),
      sku: item?.sku || d.sku || "",
      qty,
      unitPrice,
      total: qty * unitPrice,
    },
  };
}

// ============ INVENTARIO ============
async function consumeFIFO(productId: string, qty: number) {
  if (qty <= 0) return;
  const qB = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId),
  );
  const snap = await getDocs(qB);
  const lots: BatchRow[] = [];
  snap.forEach((d) => {
    const x = d.data() as any;
    lots.push({
      id: d.id,
      productId: x.productId,
      date: x.date || "",
      quantity: Number(x.quantity || 0),
      remaining: Number(x.remaining || 0),
    });
  });
  lots.sort((a, b) => a.date.localeCompare(b.date));
  let need = qty;
  for (const lot of lots) {
    if (need <= 0) break;
    if (lot.remaining <= 0) continue;
    const take = Math.min(lot.remaining, need);
    need -= take;
    await updateDoc(doc(db, "inventory_clothes_batches", lot.id), {
      remaining: Math.max(0, Number((lot.remaining - take).toFixed(0))),
    });
  }
  if (need > 0) console.warn("consumeFIFO: faltó inventario", need);
}
async function restoreFIFO(productId: string, qty: number) {
  if (qty <= 0) return;
  const qB = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId),
  );
  const snap = await getDocs(qB);
  const lots: BatchRow[] = [];
  snap.forEach((d) => {
    const x = d.data() as any;
    lots.push({
      id: d.id,
      productId: x.productId,
      date: x.date || "",
      quantity: Number(x.quantity || 0),
      remaining: Number(x.remaining || 0),
    });
  });
  lots.sort((a, b) => a.date.localeCompare(b.date));
  let toReturn = qty;
  for (const lot of lots) {
    if (toReturn <= 0) break;
    const used = Math.max(0, lot.quantity - lot.remaining);
    if (used <= 0) continue;
    const addBack = Math.min(used, toReturn);
    toReturn -= addBack;
    await updateDoc(doc(db, "inventory_clothes_batches", lot.id), {
      remaining: Number((lot.remaining + addBack).toFixed(0)),
    });
  }
  if (toReturn > 0) console.warn("restoreFIFO: no se devolvió todo", toReturn);
}

// ============ CUENTAS POR COBRAR ============
async function deleteARMovesBySaleId(saleId: string) {
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
  );
}
async function upsertARMovesOnEdit(
  sale: SaleDoc,
  newTotal: number,
  newDownPayment?: number,
) {
  await deleteARMovesBySaleId(sale.id);
  if (sale.type !== "CREDITO" || !sale.customerId) return;
  const base = {
    customerId: sale.customerId!,
    date: sale.date,
    createdAt: Timestamp.now(),
    ref: { saleId: sale.id },
  };
  const { addDoc } = await import("firebase/firestore");
  await addDoc(collection(db, "ar_movements"), {
    ...base,
    type: "CARGO",
    amount: Number(newTotal) || 0,
  });
  const dp = Math.max(0, Number(newDownPayment ?? sale.downPayment ?? 0));
  if (dp > 0)
    await addDoc(collection(db, "ar_movements"), {
      ...base,
      type: "ABONO",
      amount: -dp,
    });
}

// ==================== UI ====================
export default function TransactionsReportClothes() {
  // ===== Modal Detalle de Ítems =====
  const [itemsModalOpen, setItemsModalOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number;
      unitPrice: number;
      discount?: number;
      total: number;
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);
    try {
      const snap = await getDocs(
        query(collection(db, "sales_clothes"), where("__name__", "==", saleId)),
      );
      const docSnap = snap.docs[0];
      const data = docSnap?.data() as any;
      const arr = Array.isArray(data?.items)
        ? data.items
        : data?.item
          ? [data.item]
          : [];
      const rows = arr.map((it: any) => ({
        productName: String(it.productName || ""),
        qty: Number(it.qty || 0),
        unitPrice: Number(it.unitPrice || 0),
        discount: Number(it.discount || 0),
        total: Number(it.total || 0),
      }));
      setItemsModalRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // Filtro por FECHA (global, como ya estaba)
  const [fromDate, setFromDate] = useState(format(new Date(), "yyyy-MM-01"));
  const [toDate, setToDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<SaleDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros NUEVOS: Cliente y Tipo
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [filterType, setFilterType] = useState<"" | SaleType>("");

  // kebab
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // editar
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<SaleDoc | null>(null);
  const [editQty, setEditQty] = useState<number>(0);

  // paginación
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // clientes
        const cSnap = await getDocs(collection(db, "customers_clothes"));
        const cList: Customer[] = [];
        cSnap.forEach((d) =>
          cList.push({ id: d.id, name: (d.data() as any).name || "" }),
        );
        setCustomers(cList);

        // ventas
        const sSnap = await getDocs(
          query(collection(db, "sales_clothes"), orderBy("createdAt", "desc")),
        );
        const list: SaleDoc[] = [];
        sSnap.forEach((d) => {
          const x = normalizeSale(d.data(), d.id);
          if (!x) return;
          if (x.date >= fromDate && x.date <= toDate) list.push(x);
        });
        setSales(list.sort((a, b) => b.date.localeCompare(a.date)));
        setPage(1); // reset a primera página al cambiar rango
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando transacciones.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate]);

  // === APLICAR FILTROS DE TABLA (cliente/tipo) ===
  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      if (filterCustomerId) {
        // Solo matchea ventas con customerId (crédito) igual al seleccionado
        if (s.customerId !== filterCustomerId) return false;
      }
      if (filterType) {
        if (s.type !== filterType) return false;
      }
      return true;
    });
  }, [sales, filterCustomerId, filterType]);

  // KPIs sobre el resultado filtrado
  const kpis = useMemo(() => {
    let piezasCash = 0,
      piezasCredito = 0,
      montoCash = 0,
      montoCredito = 0;
    for (const s of filteredSales) {
      if (s.type === "CONTADO") {
        piezasCash += s.item.qty;
        montoCash += s.total;
      } else {
        piezasCredito += s.item.qty;
        montoCredito += s.total;
      }
    }
    return { piezasCash, piezasCredito, montoCash, montoCredito };
  }, [filteredSales]);

  // page slices (sobre filtrado)
  const totalPages = Math.max(1, Math.ceil(filteredSales.length / PAGE_SIZE));
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSales.slice(start, start + PAGE_SIZE);
  }, [filteredSales, page]);

  const requestEdit = (s: SaleDoc) => {
    setOpenMenuId(null);
    setEditing(s);
    setEditQty(s.item.qty || 0);
    setEditOpen(true);
  };

  const confirmDelete = async (s: SaleDoc) => {
    setOpenMenuId(null);
    if (
      !window.confirm("¿Eliminar esta venta? Esta acción no se puede deshacer.")
    )
      return;
    try {
      setLoading(true);
      // 👇 Reversar inventario por allocations / FIFO y borrar la venta
      await restoreSaleAndDeleteClothes(s.id);
      // 👇 Limpiar movimientos de CxC vinculados
      await deleteARMovesBySaleId(s.id);

      // UI
      setSales((prev) => prev.filter((x) => x.id !== s.id));
      setMsg("✅ Venta eliminada");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar la venta.");
    } finally {
      setLoading(false);
    }
  };

  const saveEdit = async () => {
    if (!editing) return;
    const oldQty = Number(editing.item.qty || 0);
    const newQty = Math.max(1, Math.floor(Number(editQty) || 0));
    if (newQty === oldQty) {
      setEditOpen(false);
      return;
    }

    const unitPrice = Number(editing.item.unitPrice || 0);
    const newTotal = Number((unitPrice * newQty).toFixed(2));
    try {
      setLoading(true);
      const delta = newQty - oldQty;
      if (delta > 0) await consumeFIFO(editing.item.productId, delta);
      else if (delta < 0) await restoreFIFO(editing.item.productId, -delta);

      const saleRef = doc(db, "sales_clothes", editing.id);
      await updateDoc(saleRef, {
        quantity: newQty,
        total: newTotal,
        itemsTotal: newTotal,
        "item.qty": newQty,
        "item.total": newTotal,
        updatedAt: Timestamp.now(),
      });

      const newDP = Math.min(Number(editing.downPayment || 0), newTotal);
      await upsertARMovesOnEdit(editing, newTotal, newDP);

      setSales((prev) =>
        prev.map((x) =>
          x.id === editing.id
            ? {
                ...x,
                quantity: newQty,
                total: newTotal,
                item: { ...x.item, qty: newQty, total: newTotal },
                downPayment: newDP,
              }
            : x,
        ),
      );
      setMsg("✅ Venta actualizada");
      setEditOpen(false);
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo actualizar la venta.");
    } finally {
      setLoading(false);
    }
  };

  // ===== Exportar PDF (usa ventas filtradas) =====
  const handleExportPDF = () => {
    const title = `Reporte de transacciones (Ropa) — ${fromDate} a ${toDate}`;
    const esc = (s: string) =>
      (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
    const rows = filteredSales
      .map((s) => {
        const name =
          s.customerName ||
          (s.customerId ? customersById[s.customerId] : "") ||
          "Nombre cliente";
        return `<tr>
          <td>${s.date}</td>
          <td>${esc(name)}</td>
          <td>${s.type === "CREDITO" ? "Crédito" : "Cash"}</td>
          <td style="text-align:right">${s.item.qty}</td>
          <td style="text-align:right">${money(s.total)}</td>
        </tr>`;
      })
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8" />
    <title>${esc(title)}</title>
    <style>
      *{font-family:Arial, sans-serif} h1{margin:0 0 8px}
      .muted{color:#555;font-size:12px;margin-bottom:12px}
      .kpis{display:grid;grid-template-columns:repeat(2,max-content);gap:8px 28px;margin:10px 0 14px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ddd;padding:6px}
      th{background:#f5f5f5;text-align:left}
      @media print{@page{size:A4;margin:12mm}}
    </style></head><body>
      <h1>${esc(title)}</h1>
      <div class="kpis">
        <div><b>Piezas Cash:</b> ${kpis.piezasCash}</div>
        <div><b>Piezas Crédito:</b> ${kpis.piezasCredito}</div>
        <div><b>Monto Cash:</b> ${money(kpis.montoCash)}</div>
        <div><b>Monto Crédito:</b> ${money(kpis.montoCredito)}</div>
      </div>
      <table><thead><tr>
        <th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Piezas</th><th>Monto</th>
      </tr></thead><tbody>
      ${
        rows ||
        `<tr><td colspan="5" style="text-align:center">Sin transacciones</td></tr>`
      }
      </tbody></table>
      <script>window.print()</script>
    </body></html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  // paginador
  const goFirst = () => setPage(1);
  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));
  const goLast = () => setPage(totalPages);

  const renderPager = () => {
    const pages: number[] = [];
    const maxBtns = 7;
    if (totalPages <= maxBtns) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      const left = Math.max(1, page - 2);
      const right = Math.min(totalPages, page + 2);
      pages.push(1);
      if (left > 2) pages.push(-1 as any);
      for (let i = left; i <= right; i++)
        if (i !== 1 && i !== totalPages) pages.push(i);
      if (right < totalPages - 1) pages.push(-2 as any);
      pages.push(totalPages);
    }

    return (
      <div className="flex items-center gap-1 justify-between mt-3">
        <div className="flex items-center gap-1">
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={goFirst}
            disabled={page === 1}
          >
            « Primero
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={goPrev}
            disabled={page === 1}
          >
            ‹ Anterior
          </button>
          {pages.map((p, idx) =>
            typeof p === "number" ? (
              <button
                key={idx}
                className={`px-3 py-1 border rounded ${
                  p === page ? "bg-blue-600 text-white" : ""
                }`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ) : (
              <span key={idx} className="px-2">
                …
              </span>
            ),
          )}
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={goNext}
            disabled={page === totalPages}
          >
            Siguiente ›
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={goLast}
            disabled={page === totalPages}
          >
            Último »
          </button>
        </div>
        <div className="text-sm text-gray-600">
          Página {page} de {totalPages} • {filteredSales.length} transacción(es)
        </div>
      </div>
    );
  };

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">
        Reporte de transacciones (Ropa)
      </h2>

      {/* Filtros */}
      <div className="bg-white p-3 rounded shadow border mb-4 flex flex-wrap gap-3 items-end text-sm">
        <div>
          <label className="block font-semibold">Desde</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={fromDate}
            onChange={(e) => {
              setFromDate(e.target.value);
              setPage(1);
            }}
          />
        </div>
        <div>
          <label className="block font-semibold">Hasta</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={toDate}
            onChange={(e) => {
              setToDate(e.target.value);
              setPage(1);
            }}
          />
        </div>

        {/* NUEVO: filtro por Cliente */}
        <div>
          <label className="block font-semibold">Cliente (crédito)</label>
          <select
            className="border rounded px-2 py-1 min-w-[220px]"
            value={filterCustomerId}
            onChange={(e) => {
              setFilterCustomerId(e.target.value);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            {customers.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </div>

        {/* NUEVO: filtro por Tipo */}
        <div>
          <label className="block font-semibold">Tipo</label>
          <select
            className="border rounded px-2 py-1"
            value={filterType}
            onChange={(e) => {
              setFilterType(e.target.value as "" | SaleType);
              setPage(1);
            }}
          >
            <option value="">Todos</option>
            <option value="CONTADO">Cash</option>
            <option value="CREDITO">Crédito</option>
          </select>
        </div>

        <button
          className="ml-auto px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
          onClick={handleExportPDF}
        >
          Exportar PDF
        </button>
      </div>

      {/* KPIs (sobre filtrado) */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Piezas Cash</div>
          <div className="text-xl font-semibold">{kpis.piezasCash}</div>
        </div>
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Piezas Crédito</div>
          <div className="text-xl font-semibold">{kpis.piezasCredito}</div>
        </div>
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Monto Cash</div>
          <div className="text-xl font-semibold">{money(kpis.montoCash)}</div>
        </div>
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Monto Crédito</div>
          <div className="text-xl font-semibold">
            {money(kpis.montoCredito)}
          </div>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Cliente</th>
              <th className="p-2 border">Tipo</th>
              <th className="p-2 border">Piezas</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={6}>
                  Cargando…
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={6}>
                  Sin transacciones en el rango.
                </td>
              </tr>
            ) : (
              paged.map((s) => {
                const name =
                  s.customerName ||
                  (s.customerId ? customersById[s.customerId] : "") ||
                  "Nombre cliente";
                return (
                  <tr key={s.id} className="text-center">
                    <td className="p-2 border">{s.date}</td>
                    <td className="p-2 border">{name}</td>
                    <td className="p-2 border">
                      {s.type === "CREDITO" ? "Crédito" : "Cash"}
                    </td>
                    <td className="p-2 border">
                      <button
                        type="button"
                        className="underline text-blue-600 hover:text-blue-800"
                        title="Ver piezas de esta transacción"
                        onClick={() => openItemsModal(s.id)}
                      >
                        {s.item.qty}
                      </button>
                    </td>

                    <td className="p-2 border">{money(s.total)}</td>
                    <td className="p-2 border relative">
                      <button
                        className="px-2 py-1 rounded border hover:bg-gray-50"
                        onClick={() =>
                          setOpenMenuId((prev) => (prev === s.id ? null : s.id))
                        }
                        title="Acciones"
                      >
                        ⋮
                      </button>
                      {openMenuId === s.id && (
                        <div className="absolute right-2 mt-1 w-28 bg-white border rounded shadow z-10 text-left">
                          <button
                            className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                            onClick={() => requestEdit(s)}
                          >
                            Editar
                          </button>
                          <button
                            className="block w-full text-left px-3 py-2 hover:bg-gray-100 text-red-600"
                            onClick={() => confirmDelete(s)}
                          >
                            Eliminar
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Paginación */}
        {renderPager()}
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal editar */}
      {editOpen && editing && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-md p-4">
            <h3 className="text-lg font-bold mb-2">Editar venta</h3>
            <div className="space-y-2">
              <div>
                <div className="text-xs text-gray-600">Producto</div>
                <div className="font-semibold">
                  {editing.item.productName}{" "}
                  {editing.item.sku ? `— ${editing.item.sku}` : ""}
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Cantidad (piezas)
                </label>
                <input
                  type="number"
                  step="1"
                  min={1}
                  className="w-full border p-2 rounded"
                  value={editQty}
                  onChange={(e) =>
                    setEditQty(
                      Math.max(1, Math.floor(Number(e.target.value || 0))),
                    )
                  }
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-2 rounded bg-gray-50 border">
                  <div className="text-xs text-gray-600">P. Unit</div>
                  <div className="text-lg font-semibold">
                    {money(editing.item.unitPrice)}
                  </div>
                </div>
                <div className="p-2 rounded bg-gray-50 border">
                  <div className="text-xs text-gray-600">Nuevo total</div>
                  <div className="text-lg font-semibold">
                    {money(
                      Number(editing.item.unitPrice) * Number(editQty || 0),
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => {
                  setEditOpen(false);
                  setEditing(null);
                }}
              >
                Cancelar
              </button>
              <button
                className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
                onClick={saveEdit}
              >
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal: Detalle de piezas de la venta */}
      {itemsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Piezas vendidas{" "}
                {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setItemsModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border text-right">Cantidad</th>
                    <th className="p-2 border text-right">Precio</th>
                    <th className="p-2 border text-right">Descuento</th>
                    <th className="p-2 border text-right">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsModalLoading ? (
                    <tr>
                      <td colSpan={5} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : itemsModalRows.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="p-4 text-center">
                        Sin ítems en esta venta.
                      </td>
                    </tr>
                  ) : (
                    itemsModalRows.map((it, idx) => (
                      <tr key={idx} className="text-center">
                        <td className="p-2 border text-left">
                          {it.productName}
                        </td>
                        <td className="p-2 border text-right">{it.qty}</td>
                        <td className="p-2 border text-right">
                          {money(it.unitPrice)}
                        </td>
                        <td className="p-2 border text-right">
                          {money(it.discount || 0)}
                        </td>
                        <td className="p-2 border text-right">
                          {money(it.total)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
