// src/components/Candies/TransactionsReportCandies.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format } from "date-fns";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";

type SaleType = "CONTADO" | "CREDITO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

interface Customer {
  id: string;
  name: string;
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;
  quantity: number; // TOTAL de paquetes de la venta (para la UI)
  customerId?: string;
  customerName?: string;
  downPayment?: number;
  vendorId?: string;
  vendorName?: string;
}

// ----------------- Helpers de fecha / normalización -----------------
function ensureDate(x: any): string {
  if (x?.date) return x.date;
  if (x?.createdAt?.toDate) return format(x.createdAt.toDate(), "yyyy-MM-dd");
  return "";
}

/**
 * Normaliza una venta de "sales_candies" a SaleDoc
 * - Soporta ventas con items[] o estructura simple
 * - quantity en SaleDoc SIEMPRE serán PAQUETES para la UI
 */
function normalizeSale(d: any, id: string): SaleDoc | null {
  const date = ensureDate(d);
  if (!date) return null;

  let quantity = 0;
  let total = 0;

  // Si la venta tiene items[] (multi-producto)
  if (Array.isArray(d.items) && d.items.length > 0) {
    // 👇 Paquetes: usamos campo packages, si no, qty/quantity
    quantity = d.items.reduce(
      (acc: number, it: any) =>
        acc + (Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0),
      0
    );
    total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
  } else {
    // Estructura legacy / simple
    quantity =
      Number(
        d.packagesTotal ?? d.quantity ?? d.item?.packages ?? d.item?.qty ?? 0
      ) || 0;
    total = Number(d.total ?? d.item?.total ?? 0) || 0;
  }

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total,
    quantity,
    customerId: d.customerId || undefined,
    customerName: d.customerName || undefined,
    downPayment: Number(d.downPayment || 0),
    vendorId: d.vendorId || undefined,
    vendorName: d.vendorName || d.vendor || undefined,
  };
}

// ============ CUENTAS POR COBRAR (CxC) ============

async function deleteARMovesBySaleId(saleId: string) {
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId)
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id)))
  );
}

// ===== NUEVO: Props para restringir por vendedor / rol =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

interface TransactionsReportCandiesProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

// ==================== UI ====================

export default function TransactionsReportCandies({
  role = "",
  sellerCandyId = "",
}: TransactionsReportCandiesProps) {
  const isVendor = role === "vendedor_dulces";
  const canDelete = role === "admin";
  const columnsCount = canDelete ? 7 : 6;

  // ===== Modal Detalle de Ítems =====
  const [itemsModalOpen, setItemsModalOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number; // paquetes
      unitPrice: number; // precio por paquete
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
        query(collection(db, "sales_candies"), where("__name__", "==", saleId))
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
        // 👇 aquí mostramos PAQUETES en el detalle
        qty: Number(it.packages ?? it.qty ?? it.quantity ?? 0),
        // 👇 y el precio por paquete correcto
        unitPrice: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
        discount: Number(it.discount || 0),
        total: Number(it.total ?? it.lineFinal ?? 0),
      }));
      setItemsModalRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // --------- Estado principal ---------
  const [fromDate, setFromDate] = useState(format(new Date(), "yyyy-MM-01"));
  const [toDate, setToDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<SaleDoc[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros: Cliente y Tipo
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [filterType, setFilterType] = useState<"" | SaleType>("");

  // kebab menú
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // paginación
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  // Carga inicial y recarga al cambiar rango de fechas
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // clientes (dulces)
        const cSnap = await getDocs(collection(db, "customers_candies"));
        const cList: Customer[] = [];
        cSnap.forEach((d) =>
          cList.push({ id: d.id, name: (d.data() as any).name || "" })
        );
        setCustomers(cList);

        // ventas (dulces)
        const sSnap = await getDocs(
          query(collection(db, "sales_candies"), orderBy("createdAt", "desc"))
        );
        const list: SaleDoc[] = [];
        sSnap.forEach((d) => {
          const x = normalizeSale(d.data(), d.id);
          if (!x) return;
          if (x.date >= fromDate && x.date <= toDate) list.push(x);
        });
        setSales(list.sort((a, b) => b.date.localeCompare(a.date)));
        setPage(1);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando transacciones.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate]);

  // === Filtros de tabla (cliente / tipo / vendedor) ===
  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      // Filtro por vendedor cuando es vendedor de dulces
      if (isVendor) {
        if (!sellerCandyId) return false;
        if (!s.vendorId || s.vendorId !== sellerCandyId) return false;
      }
      if (filterCustomerId) {
        if (s.customerId !== filterCustomerId) return false;
      }
      if (filterType) {
        if (s.type !== filterType) return false;
      }
      return true;
    });
  }, [sales, filterCustomerId, filterType, isVendor, sellerCandyId]);

  // KPIs sobre resultado filtrado (cantidad = paquetes)
  const kpis = useMemo(() => {
    let packsCash = 0,
      packsCredito = 0,
      montoCash = 0,
      montoCredito = 0;
    for (const s of filteredSales) {
      if (s.type === "CONTADO") {
        packsCash += s.quantity;
        montoCash += s.total;
      } else {
        packsCredito += s.quantity;
        montoCredito += s.total;
      }
    }
    return { packsCash, packsCredito, montoCash, montoCredito };
  }, [filteredSales]);

  // page slices
  const totalPages = Math.max(1, Math.ceil(filteredSales.length / PAGE_SIZE));
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSales.slice(start, start + PAGE_SIZE);
  }, [filteredSales, page]);

  // --------- Eliminar venta ---------
  const confirmDelete = async (s: SaleDoc) => {
    // Por seguridad, solo admin puede eliminar
    if (!canDelete) return;

    setOpenMenuId(null);
    if (
      !window.confirm(
        "¿Eliminar esta venta de dulces? Se restaurará el inventario asociado."
      )
    )
      return;
    try {
      setLoading(true);
      // 1) Reversar inventario y borrar la venta (dulces)
      await restoreSaleAndDeleteCandy(s.id);
      // 2) Eliminar movimientos de CxC vinculados
      await deleteARMovesBySaleId(s.id);

      // 3) Actualizar UI
      setSales((prev) => prev.filter((x) => x.id !== s.id));
      setMsg("✅ Venta eliminada");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar la venta.");
    } finally {
      setLoading(false);
    }
  };

  // --------- Exportar PDF (usa ventas filtradas) ---------
  const handleExportPDF = () => {
    const title = `Reporte de transacciones (Dulces) — ${fromDate} a ${toDate}`;
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
          <td style="text-align:right">${s.quantity}</td>
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
        <div><b>Paquetes Cash:</b> ${kpis.packsCash}</div>
        <div><b>Paquetes Crédito:</b> ${kpis.packsCredito}</div>
        <div><b>Monto Cash:</b> ${money(kpis.montoCash)}</div>
        <div><b>Monto Crédito:</b> ${money(kpis.montoCredito)}</div>
      </div>
      <table><thead><tr>
        <th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Paquetes</th><th>Monto</th>
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

  // --------- Paginador ---------
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
            )
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

  // ----------------- Render principal -----------------
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">
        Reporte de transacciones (Dulces)
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

        {/* Filtro por Cliente */}
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

        {/* Filtro por Tipo */}
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

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Paquetes Cash</div>
          <div className="text-xl font-semibold">{kpis.packsCash}</div>
        </div>
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Paquetes Crédito</div>
          <div className="text-xl font-semibold">{kpis.packsCredito}</div>
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
              <th className="p-2 border">Paquetes</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Vendedor</th>
              {canDelete && <th className="p-2 border">Acciones</th>}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={columnsCount}>
                  Cargando…
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={columnsCount}>
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
                        title="Ver detalle de productos de esta venta"
                        onClick={() => openItemsModal(s.id)}
                      >
                        {s.quantity}
                      </button>
                    </td>
                    <td className="p-2 border">{money(s.total)}</td>
                    <td className="p-2 border">{s.vendorName || "—"}</td>
                    {canDelete && (
                      <td className="p-2 border relative">
                        <button
                          className="px-2 py-1 rounded border hover:bg-gray-50"
                          onClick={() =>
                            setOpenMenuId((prev) =>
                              prev === s.id ? null : s.id
                            )
                          }
                          title="Acciones"
                        >
                          ⋮
                        </button>
                        {openMenuId === s.id && (
                          <div className="absolute right-2 mt-1 w-28 bg-white border rounded shadow z-10 text-left">
                            {/* Solo eliminar por ahora, para no dañar inventario multi-item */}
                            <button
                              className="block w-full text-left px-3 py-2 hover:bg-gray-100 text-red-600"
                              onClick={() => confirmDelete(s)}
                            >
                              Eliminar
                            </button>
                          </div>
                        )}
                      </td>
                    )}
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

      {/* Modal: Detalle de piezas de la venta */}
      {itemsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Productos/paquetes vendidos{" "}
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
                    <th className="p-2 border text-right">Paquetes</th>
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
