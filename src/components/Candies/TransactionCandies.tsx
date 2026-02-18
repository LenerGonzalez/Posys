// src/components/Candies/TransactionsReportCandies.tsx
import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { format } from "date-fns";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";

type SaleType = "CONTADO" | "CREDITO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

interface Customer {
  id: string;
  name: string;
}

// === Nuevo: mismo seller que en consolidado de vendedores (dulces) ===
interface Seller {
  id: string;
  name: string;
  commissionPercent: number;
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;

  // TOTAL de PAQUETES para UI
  quantity: number;
  productNames: string[];

  customerId?: string;
  customerName?: string;
  downPayment?: number;

  vendorId?: string;
  vendorName?: string;

  // ✅ NUEVO: si viene guardado en la venta, lo usamos para histórico
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number;
  // Suma de margenVendedor por ítems (cuando la venta tiene items[])
  commissionFromItems?: number;
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

  let quantity = 0; // paquetes
  let total = 0;
  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];

  const productNames = itemsArray.length
    ? itemsArray
        .map((it: any) => String(it.productName || it.name || "").trim())
        .filter(Boolean)
    : d.productName
      ? [String(d.productName).trim()]
      : [];

  // Si la venta tiene items[] (multi-producto)
  let commissionFromItems = 0;
  if (itemsArray.length > 0) {
    // 👇 Paquetes: usamos campo packages, si no, qty/quantity (fallback)
    quantity = itemsArray.reduce(
      (acc: number, it: any) =>
        acc + (Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0),
      0,
    );
    total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
    if (!total) {
      total = itemsArray.reduce(
        (acc: number, it: any) =>
          acc + (Number(it.total ?? it.lineFinal ?? 0) || 0),
        0,
      );
    }
    // Suma de margenVendedor por ítem (si existe)
    commissionFromItems = itemsArray.reduce(
      (acc: number, it: any) => acc + (Number(it.margenVendedor || 0) || 0),
      0,
    );
  } else {
    // Estructura legacy / simple
    quantity =
      Number(
        d.packagesTotal ?? d.quantity ?? d.item?.packages ?? d.item?.qty ?? 0,
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

    // ✅ HISTÓRICO desde la venta
    vendorCommissionPercent: Number(d.vendorCommissionPercent || 0) || 0,
    vendorCommissionAmount: Number(d.vendorCommissionAmount || 0) || 0,
    commissionFromItems: Number(commissionFromItems || 0) || 0,
    productNames,
  };
}

// ============ CUENTAS POR COBRAR (CxC) ============
async function deleteARMovesBySaleId(saleId: string) {
  const saleIdSafe = (saleId || "").trim();
  if (!saleIdSafe) return;
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleIdSafe),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
  );
}

// ===== NUEVO: Props para restringir por vendedor / rol =====

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface TransactionsReportCandiesProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function TransactionsReportCandies({
  role = "",
  sellerCandyId = "",
  roles,
}: TransactionsReportCandiesProps & { roles?: string[] }) {
  const subject = roles && roles.length ? roles : role;
  const isVendor = hasRole(subject, "vendedor_dulces");
  const canDelete = hasRole(subject, "admin");

  // NUEVO: ahora hay una columna extra (Comisión)
  const columnsCount = canDelete ? 8 : 7;

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
      commission?: number;
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);

    try {
      const docSnap = await getDoc(doc(db, "sales_candies", saleId));
      const data = docSnap.exists() ? (docSnap.data() as any) : null;
      if (!data) {
        setItemsModalRows([]);
        return;
      }

      const arr = Array.isArray(data?.items)
        ? data.items
        : data?.item
          ? [data.item]
          : [];

      const rows = arr.map((it: any) => ({
        productName: String(it.productName || ""),
        qty: Number(it.packages ?? it.qty ?? it.quantity ?? 0),
        unitPrice: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
        discount: Number(it.discount || 0),
        total: Number(it.total ?? it.lineFinal ?? 0),
        commission: Number(it.margenVendedor || 0),
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
  const [filterProduct, setFilterProduct] = useState<string>("");

  // NUEVO: vendedores con comisión (mismo esquema que consolidado)
  const [sellers, setSellers] = useState<Seller[]>([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros: Cliente y Tipo
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [filterType, setFilterType] = useState<"" | SaleType>("");
  const [filterSellerId, setFilterSellerId] = useState<string>("");

  // kebab menú
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // paginación
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  // UI: cards colapsables
  const [filtersCardOpen, setFiltersCardOpen] = useState(false);
  const [kpisCardOpen, setKpisCardOpen] = useState(false);
  const [cashCardOpen, setCashCardOpen] = useState(false);
  const [creditCardOpen, setCreditCardOpen] = useState(false);

  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  const sellersById = useMemo(() => {
    const m: Record<string, Seller> = {};
    sellers.forEach((v) => {
      m[v.id] = v;
    });
    return m;
  }, [sellers]);

  const productOptions = useMemo(() => {
    const set = new Set<string>();
    sales.forEach((s) => {
      (s.productNames || []).forEach((name) => set.add(name));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sales]);

  // Export: lista (sábana) de todos los productos vendidos en filteredSales
  const handleExportXLSXAllProducts = async () => {
    setLoading(true);
    setMsg("");
    try {
      const rows: any[] = [];
      for (const s of filteredSales) {
        try {
          const docSnap = await getDoc(doc(db, "sales_candies", s.id));
          const data = docSnap.exists() ? (docSnap.data() as any) : null;
          if (!data) continue;

          const arr = Array.isArray(data.items)
            ? data.items
            : data.item
              ? [data.item]
              : [];

          if (arr.length > 0) {
            for (const it of arr) {
              rows.push({
                Fecha: s.date,
                Venta: s.id,
                Tipo: s.type,
                Cliente: s.customerName || "",
                Vendedor: s.vendorName || "",
                Producto: it.productName || it.name || "",
                Paquetes: Number(it.packages ?? it.qty ?? it.quantity ?? 0),
                Precio: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
                Descuento: Number(it.discount || 0),
                Monto: Number(it.total ?? it.lineFinal ?? 0),
                Comision: Number(it.margenVendedor || 0),
              });
            }
          } else {
            rows.push({
              Fecha: s.date,
              Venta: s.id,
              Tipo: s.type,
              Cliente: s.customerName || "",
              Vendedor: s.vendorName || "",
              Producto:
                s.productNames && s.productNames[0] ? s.productNames[0] : "",
              Paquetes: s.quantity,
              Precio: s.total,
              Descuento: 0,
              Monto: s.total,
              Comision: Number(
                (s as any).commissionFromItems || s.vendorCommissionAmount || 0,
              ),
            });
          }
        } catch (e) {
          console.error("Error leyendo venta", s.id, e);
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Productos");
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ventas_productos_${fromDate}_a_${toDate}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`✅ Exportado ${rows.length} fila(s)`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error exportando a Excel");
    } finally {
      setLoading(false);
    }
  };

  // ✅ Comisión HISTÓRICA desde la venta (si existe),
  // fallback a cálculo por sellers_candies
  const getCommissionAmount = (s: SaleDoc): number => {
    // Prefer item-level commission when available
    const itemsCommission = Number((s as any).commissionFromItems || 0);
    if (itemsCommission > 0) return Number(itemsCommission.toFixed(2));

    const stored = Number((s as any).vendorCommissionAmount || 0);
    if (stored > 0) return Number(stored.toFixed(2));

    if (!s.vendorId) return 0;
    const v = sellersById[s.vendorId];
    if (!v || !v.commissionPercent) return 0;

    const calc =
      ((Number(s.total) || 0) * (Number(v.commissionPercent) || 0)) / 100;
    return Number(calc.toFixed(2));
  };

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
          cList.push({ id: d.id, name: (d.data() as any).name || "" }),
        );
        setCustomers(cList);

        // vendedores (dulces) con comisión (fallback si no viene en venta)
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const vList: Seller[] = [];
        vSnap.forEach((d) => {
          const data = d.data() as any;
          vList.push({
            id: d.id,
            name: data.name || "",
            commissionPercent: Number(data.commissionPercent || 0),
          });
        });
        setSellers(vList);

        // ventas (dulces)
        const sSnap = await getDocs(
          query(collection(db, "sales_candies"), orderBy("createdAt", "desc")),
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
      // Filtro por vendedor desde el selector (admin/visor)
      if (filterSellerId) {
        if (!s.vendorId || s.vendorId !== filterSellerId) return false;
      }
      if (filterCustomerId) {
        if (s.customerId !== filterCustomerId) return false;
      }
      if (filterType) {
        if (s.type !== filterType) return false;
      }
      if (filterProduct) {
        if (!s.productNames || !s.productNames.includes(filterProduct))
          return false;
      }
      return true;
    });
  }, [
    sales,
    filterCustomerId,
    filterType,
    filterProduct,
    filterSellerId,
    isVendor,
    sellerCandyId,
  ]);

  // KPIs sobre resultado filtrado (cantidad = paquetes)
  const kpis = useMemo(() => {
    let packsCash = 0,
      packsCredito = 0,
      montoCash = 0,
      montoCredito = 0,
      comisionCash = 0,
      comisionCredito = 0;
    for (const s of filteredSales) {
      if (s.type === "CONTADO") {
        packsCash += s.quantity;
        montoCash += s.total;
        comisionCash += getCommissionAmount(s);
      } else {
        packsCredito += s.quantity;
        montoCredito += s.total;
        comisionCredito += getCommissionAmount(s);
      }
    }
    return {
      packsCash,
      packsCredito,
      montoCash,
      montoCredito,
      comisionCash,
      comisionCredito,
    };
  }, [filteredSales]);

  // page slices
  const totalPages = Math.max(1, Math.ceil(filteredSales.length / PAGE_SIZE));
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSales.slice(start, start + PAGE_SIZE);
  }, [filteredSales, page]);

  const cashPaged = useMemo(
    () => paged.filter((s) => s.type === "CONTADO"),
    [paged],
  );
  const creditPaged = useMemo(
    () => paged.filter((s) => s.type === "CREDITO"),
    [paged],
  );

  // venta actual del modal (para mostrar comisión en el detalle)
  const modalSale = useMemo(
    () =>
      itemsModalSaleId
        ? sales.find((s) => s.id === itemsModalSaleId) || null
        : null,
    [itemsModalSaleId, sales],
  );

  // --------- Eliminar venta ---------
  const confirmDelete = async (s: SaleDoc) => {
    if (!canDelete) return;

    setOpenMenuId(null);
    if (
      !window.confirm(
        "¿Eliminar esta venta de dulces? Se restaurará el inventario asociado.",
      )
    )
      return;
    try {
      setLoading(true);
      const baseSaleId = s.id.split("#")[0];
      await restoreSaleAndDeleteCandy(baseSaleId);
      await deleteARMovesBySaleId(baseSaleId);

      setSales((prev) => prev.filter((x) => x.id !== s.id));
      setMsg("✅ Venta eliminada y saldo del cliente ajustado");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar la venta.");
    } finally {
      setLoading(false);
    }
  };

  // --------- Exportar PDF (usa ventas filtradas) ---------
  const handleExportPDF = () => {
    const title = `Ventas del dia — ${fromDate} a ${toDate}`;
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
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mt-3">
        <div className="flex items-center gap-1 flex-wrap">
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

  // ----------------- Render principal -----------------
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Ventas del dia</h2>

      {/* Filtros (colapsables) */}
      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setFiltersCardOpen((prev) => !prev)}
          aria-expanded={filtersCardOpen}
        >
          <span>Filtros</span>
          <span
            className={`transition-transform ${filtersCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {filtersCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end text-sm">
              <div>
                <label className="block font-semibold">Desde</label>
                <input
                  type="date"
                  className="border rounded px-2 py-1 w-full"
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
                  className="border rounded px-2 py-1 w-full"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-2">
                <label className="block font-semibold">Cliente (crédito)</label>
                <select
                  className="border rounded px-2 py-1 w-full"
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

              <div className="sm:col-span-2 lg:col-span-2">
                <label className="block font-semibold">Vendedor</label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={filterSellerId}
                  onChange={(e) => {
                    setFilterSellerId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  {sellers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold">Tipo</label>
                <select
                  className="border rounded px-2 py-1 w-full"
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

              <div>
                <label className="block font-semibold">Producto</label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={filterProduct}
                  onChange={(e) => {
                    setFilterProduct(e.target.value);
                    setPage(1);
                  }}
                  disabled={productOptions.length === 0}
                >
                  <option value="">Todos</option>
                  {productOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              <button
                className="sm:col-span-2 lg:col-span-1 px-2 py-1 text-sm sm:px-3 sm:py-2 rounded bg-blue-600 text-white hover:bg-blue-700 w-full"
                onClick={handleExportPDF}
              >
                Exportar PDF
              </button>
              <button
                className="sm:col-span-2 lg:col-span-1 px-2 py-1 text-sm sm:px-3 sm:py-2 rounded bg-green-600 text-white hover:bg-green-700 w-full"
                onClick={handleExportXLSXAllProducts}
              >
                Exportar Excel (Sábana)
              </button>
            </div>
          </div>
        )}
      </div>

      {/* KPIs (colapsables) */}
      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setKpisCardOpen((prev) => !prev)}
          aria-expanded={kpisCardOpen}
        >
          <span>Indicadores</span>
          <span
            className={`transition-transform ${kpisCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {kpisCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
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
                <div className="text-xl font-semibold">
                  {money(kpis.montoCash)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Monto Crédito</div>
                <div className="text-xl font-semibold">
                  {money(kpis.montoCredito)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Comisión Cash</div>
                <div className="text-xl font-semibold">
                  {money(kpis.comisionCash)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Comisión Crédito</div>
                <div className="text-xl font-semibold">
                  {money(kpis.comisionCredito)}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== MOBILE: Cards expandibles (sin perder datos) ===== */}
      <div className="block md:hidden space-y-3">
        {loading ? (
          <div className="bg-white border rounded-lg p-4 shadow">Cargando…</div>
        ) : paged.length === 0 ? (
          <div className="bg-white border rounded-lg p-4 shadow">
            Sin transacciones en el rango.
          </div>
        ) : (
          <>
            <div className="bg-white border rounded-xl shadow">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                onClick={() => setCashCardOpen((prev) => !prev)}
                aria-expanded={cashCardOpen}
              >
                <span>Cash</span>
                <span
                  className={`transition-transform ${cashCardOpen ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
              </button>
              {cashCardOpen && (
                <div className="p-3 border-t space-y-3">
                  {cashPaged.length === 0 ? (
                    <div className="text-sm text-gray-500">
                      Sin transacciones cash.
                    </div>
                  ) : (
                    cashPaged.map((s) => {
                      const name =
                        s.customerName ||
                        (s.customerId ? customersById[s.customerId] : "") ||
                        "Nombre cliente";
                      const commissionAmount = getCommissionAmount(s);

                      return (
                        <div
                          key={s.id}
                          className="bg-white border rounded-xl shadow"
                        >
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-semibold truncate">
                                    {name}
                                  </div>
                                  <div className="text-xs text-gray-600 shrink-0">
                                    {s.date}
                                  </div>
                                </div>

                                <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                                  <span className="px-2 py-1 rounded-full border bg-green-50 border-green-200 text-green-700">
                                    Cash
                                  </span>

                                  <span className="text-gray-700">
                                    <b>Paquetes:</b>{" "}
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        openItemsModal(s.id);
                                      }}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>

                                  <span className="text-gray-700">
                                    <b>Monto:</b> {money(s.total)}
                                  </span>
                                </div>
                              </div>

                              <div className="text-gray-500 mt-1">
                                <span className="inline-block transition-transform group-open:rotate-180">
                                  ▼
                                </span>
                              </div>
                            </summary>

                            <div className="px-3 pb-3 pt-0 text-sm">
                              <div className="grid grid-cols-1 gap-2 border-t pt-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Cliente</span>
                                  <span className="font-medium text-right">
                                    {name}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Fecha</span>
                                  <span className="font-medium">{s.date}</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Tipo</span>
                                  <span className="font-medium">Cash</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Paquetes
                                  </span>
                                  <span className="font-medium">
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={() => openItemsModal(s.id)}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Monto</span>
                                  <span className="font-semibold">
                                    {money(s.total)}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Comisión
                                  </span>
                                  <span className="font-medium">
                                    {commissionAmount > 0
                                      ? money(commissionAmount)
                                      : "—"}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Vendedor
                                  </span>
                                  <span className="font-medium">
                                    {s.vendorName || "—"}
                                  </span>
                                </div>

                                {canDelete && (
                                  <div className="pt-2 flex items-center justify-end gap-2">
                                    <button
                                      className="px-3 py-2 rounded border hover:bg-gray-50"
                                      onClick={() =>
                                        setOpenMenuId((prev) =>
                                          prev === s.id ? null : s.id,
                                        )
                                      }
                                    >
                                      ⋮ Acciones
                                    </button>

                                    {openMenuId === s.id && (
                                      <button
                                        className="px-3 py-2 rounded bg-red-600 text-white hover:bg-red-700"
                                        onClick={() => confirmDelete(s)}
                                      >
                                        Eliminar
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div className="bg-white border rounded-xl shadow">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                onClick={() => setCreditCardOpen((prev) => !prev)}
                aria-expanded={creditCardOpen}
              >
                <span>Crédito</span>
                <span
                  className={`transition-transform ${creditCardOpen ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
              </button>
              {creditCardOpen && (
                <div className="p-3 border-t space-y-3">
                  {creditPaged.length === 0 ? (
                    <div className="text-sm text-gray-500">
                      Sin transacciones crédito.
                    </div>
                  ) : (
                    creditPaged.map((s) => {
                      const name =
                        s.customerName ||
                        (s.customerId ? customersById[s.customerId] : "") ||
                        "Nombre cliente";
                      const commissionAmount = getCommissionAmount(s);

                      return (
                        <div
                          key={s.id}
                          className="bg-white border rounded-xl shadow"
                        >
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-semibold truncate">
                                    {name}
                                  </div>
                                  <div className="text-xs text-gray-600 shrink-0">
                                    {s.date}
                                  </div>
                                </div>

                                <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                                  <span className="px-2 py-1 rounded-full border bg-yellow-50 border-yellow-200 text-yellow-700">
                                    Crédito
                                  </span>

                                  <span className="text-gray-700">
                                    <b>Paquetes:</b>{" "}
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        openItemsModal(s.id);
                                      }}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>

                                  <span className="text-gray-700">
                                    <b>Monto:</b> {money(s.total)}
                                  </span>
                                </div>
                              </div>

                              <div className="text-gray-500 mt-1">
                                <span className="inline-block transition-transform group-open:rotate-180">
                                  ▼
                                </span>
                              </div>
                            </summary>

                            <div className="px-3 pb-3 pt-0 text-sm">
                              <div className="grid grid-cols-1 gap-2 border-t pt-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Cliente</span>
                                  <span className="font-medium text-right">
                                    {name}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Fecha</span>
                                  <span className="font-medium">{s.date}</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Tipo</span>
                                  <span className="font-medium">Crédito</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Paquetes
                                  </span>
                                  <span className="font-medium">
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={() => openItemsModal(s.id)}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">Monto</span>
                                  <span className="font-semibold">
                                    {money(s.total)}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Comisión
                                  </span>
                                  <span className="font-medium">
                                    {commissionAmount > 0
                                      ? money(commissionAmount)
                                      : "—"}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-gray-600">
                                    Vendedor
                                  </span>
                                  <span className="font-medium">
                                    {s.vendorName || "—"}
                                  </span>
                                </div>

                                {canDelete && (
                                  <div className="pt-2 flex items-center justify-end gap-2">
                                    <button
                                      className="px-3 py-2 rounded border hover:bg-gray-50"
                                      onClick={() =>
                                        setOpenMenuId((prev) =>
                                          prev === s.id ? null : s.id,
                                        )
                                      }
                                    >
                                      ⋮ Acciones
                                    </button>

                                    {openMenuId === s.id && (
                                      <button
                                        className="px-3 py-2 rounded bg-red-600 text-white hover:bg-red-700"
                                        onClick={() => confirmDelete(s)}
                                      >
                                        Eliminar
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div className="bg-white p-3 rounded shadow border">
          {renderPager()}
        </div>
      </div>

      {/* ===== DESKTOP: Tabla original ===== */}
      <div className="hidden md:block bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Cliente</th>
              <th className="p-2 border">Tipo</th>
              <th className="p-2 border">Paquetes</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Comisión</th>
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
                const commissionAmount = getCommissionAmount(s);

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
                    <td className="p-2 border">
                      {commissionAmount > 0 ? money(commissionAmount) : "—"}
                    </td>
                    <td className="p-2 border">{s.vendorName || "—"}</td>

                    {canDelete && (
                      <td className="p-2 border relative">
                        <button
                          className="px-2 py-1 rounded border hover:bg-gray-50"
                          onClick={() =>
                            setOpenMenuId((prev) =>
                              prev === s.id ? null : s.id,
                            )
                          }
                          title="Acciones"
                        >
                          ⋮
                        </button>
                        {openMenuId === s.id && (
                          <div className="absolute right-2 mt-1 w-28 bg-white border rounded shadow z-10 text-left">
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
              <div>
                <h3 className="text-lg font-bold">
                  Productos/paquetes vendidos{" "}
                  {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""}
                </h3>

                {modalSale && (
                  <div className="text-sm text-gray-700 mt-1">
                    Comisión de vendedor:{" "}
                    <span className="font-semibold">
                      {getCommissionAmount(modalSale) > 0
                        ? money(getCommissionAmount(modalSale))
                        : "—"}
                    </span>
                  </div>
                )}
              </div>

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
                    <th className="p-2 border text-right">Comisión</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsModalLoading ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : itemsModalRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
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
                        <td className="p-2 border text-right">
                          {money(it.commission || 0)}
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
