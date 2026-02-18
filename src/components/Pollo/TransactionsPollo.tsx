// TransactionsPollo: Adaptación de Transacciones para Pollo
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { format, isValid, parse } from "date-fns";
import { restoreSaleAndDelete } from "../../Services/inventory";
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

type SaleType = "CONTADO" | "CREDITO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);

interface Customer {
  id: string;
  name: string;
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  // en Pollo usamos type para indicar CONTADO/CREDITO
  type: SaleType;
  total: number; // ventas
  // cantidad en libras/unidades
  quantity: number;
  customerId?: string;
  customerName?: string;
  _raw?: any;
}

const getSaleCustomerName = (
  s: SaleDoc,
  customersById: Record<string, string>,
) => {
  const raw = s._raw || {};
  const cashName =
    s.customerName ||
    raw.customerName ||
    raw.customer?.name ||
    raw.clientName ||
    raw.client?.name ||
    "";

  if (s.type === "CONTADO" && cashName) return cashName;

  return (
    (s.customerId ? customersById[s.customerId] : "") ||
    s.customerName ||
    raw.customerName ||
    raw.customer?.name ||
    raw.clientName ||
    raw.client?.name ||
    "Nombre cliente"
  );
};

const getSaleDateTs = (s: SaleDoc) => {
  const direct = toDateNumber(s.date);
  if (isFinite(direct)) return direct;
  const raw = s._raw || {};
  const candidates = [
    raw.date,
    raw.closureDate,
    raw.processedDate,
    raw.createdAt,
    raw.timestamp,
  ];
  for (const c of candidates) {
    const ts = toDateNumber(c);
    if (isFinite(ts)) return ts;
  }
  return NaN;
};

const getSaleDateTsByStatus = (s: SaleDoc) => {
  const raw = s._raw || {};
  const normalized = ensureSaleDate(raw) || s.date;
  const d = toDateNumber(normalized);
  if (isFinite(d)) return d;
  return NaN;
};

const getEstadoLabel = (raw: any): "PROCESADA" | "FLOTANTE" => {
  const status = String(raw?.status || "").toUpperCase();
  if (status === "PROCESADA") return "PROCESADA";
  if (raw?.closureId || raw?.closureDate || raw?.processedDate) {
    return "PROCESADA";
  }
  return "FLOTANTE";
};

const mStr = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .trim();

const isLb = (m: unknown) => ["lb", "lbs", "libra", "libras"].includes(mStr(m));

const getQty = (x: any) => Number(x?.qty ?? x?.quantity ?? 0) || 0;

const getLbsFromSaleRaw = (raw: any) => {
  if (!raw) return 0;
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.reduce((acc: number, it: any) => {
      return isLb(it?.measurement ?? raw?.measurement) ? acc + getQty(it) : acc;
    }, 0);
  }
  return isLb(raw?.measurement) ? getQty(raw) : 0;
};

function normalizeDateString(raw: any): string {
  if (!raw) return "";
  if (raw?.toDate) return format(raw.toDate(), "yyyy-MM-dd");
  const s = String(raw).trim();
  if (!s) return "";

  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  const tryFormats = [
    "dd/MM/yyyy",
    "d/M/yyyy",
    "MM/dd/yyyy",
    "M/d/yyyy",
    "yyyy/MM/dd",
    "yyyy-M-d",
    "yyyy/M/d",
    "yyyy-MM-dd'T'HH:mm:ss",
    "yyyy-MM-dd'T'HH:mm:ss.SSSX",
  ];

  for (const f of tryFormats) {
    const parsed = parse(s, f, new Date());
    if (isValid(parsed)) return format(parsed, "yyyy-MM-dd");
  }

  const asDate = new Date(s);
  if (!isNaN(asDate.getTime())) return format(asDate, "yyyy-MM-dd");
  return "";
}

function toDateNumber(raw: any): number {
  const normalized = normalizeDateString(raw);
  if (!normalized) return NaN;
  const parsed = parse(normalized, "yyyy-MM-dd", new Date());
  return isValid(parsed) ? parsed.getTime() : NaN;
}

function ensureSaleDate(x: any): string {
  const fromDateField = normalizeDateString(x?.date);
  const createdAt = x?.createdAt?.toDate ? x.createdAt.toDate() : null;

  // Si existe date pero es inconsistente con createdAt, usar createdAt
  if (fromDateField && createdAt) {
    const dateTs = toDateNumber(fromDateField);
    const createdTs = createdAt.getTime();

    const diffDays = Math.abs(createdTs - dateTs) / (1000 * 60 * 60 * 24);

    // si difiere más de 30 días, date está mal guardado
    if (diffDays > 30) {
      return format(createdAt, "yyyy-MM-dd");
    }
  }

  // si date es válido y coherente, usarlo
  if (fromDateField) return fromDateField;

  // fallback real
  if (x?.timestamp?.toDate) return format(x.timestamp.toDate(), "yyyy-MM-dd");

  if (createdAt) return format(createdAt, "yyyy-MM-dd");

  return "";
}

function normalizeSale(d: any, id: string): SaleDoc | null {
  const date = ensureSaleDate(d);
  if (!date) return null;
  let quantity = 0;
  let total = 0;

  if (Array.isArray(d.items) && d.items.length > 0) {
    quantity = d.items.reduce(
      (acc: number, it: any) =>
        acc + (Number(it.qty ?? it.quantity ?? it.lbs ?? 0) || 0),
      0,
    );
    total = Number(d.amount ?? d.total ?? 0) || 0;
  } else {
    quantity = Number(d.quantity ?? d.lbs ?? d.weight ?? 0) || 0;
    total = Number(d.amount ?? d.total ?? 0) || 0;
  }

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total,
    quantity,
    customerId:
      d.customerId ||
      d.customer?.id ||
      d.customer?.customerId ||
      d.clientId ||
      undefined,
    customerName:
      d.customerName ||
      d.customer?.name ||
      d.clientName ||
      d.client?.name ||
      undefined,
    _raw: d,
  };
}

// ============ CUENTAS POR COBRAR (CxC) ============
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

// ===== NUEVO: Props para restringir por vendedor / rol =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface TransactionsReportPolloProps {
  role?: RoleProp;
  roles?: RoleProp[] | string[];
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function TransactionsPollo({
  role = "",
  sellerCandyId = "",
  roles,
}: TransactionsReportPolloProps) {
  // para Pollo no manejamos vendedores con comisión en este reporte
  const subject = (roles && (roles as any).length ? roles : role) as any;
  const isVendor = hasRole(subject, "vendedor_pollo");
  // Solo administradores tienen permiso de eliminar/editar
  const canDelete = hasRole(subject, "admin");

  // acceso: admin, vendedores de pollo y supervisores
  if (
    !(
      hasRole(subject, "admin") ||
      hasRole(subject, "vendedor_pollo") ||
      hasRole(subject, "supervisor_pollo") ||
      hasRole(subject, "contador")
    )
  ) {
    return (
      <div className="p-6 max-w-4xl mx-auto text-center text-red-600">
        Acceso restringido — Solo administradores, vendedores y supervisores de
        pollo.
      </div>
    );
  }

  // columnas: Fecha, Estado, Cliente, Producto, Libras, Ventas, (Acciones opcionales)
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
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);

    try {
      const docSnap = await getDoc(doc(db, "salesV2", saleId));
      const data = docSnap.exists() ? (docSnap.data() as any) : null;
      if (!data) {
        setItemsModalRows([]);
        return;
      }

      // Extraer items intentando varias formas que aparecen en distintos documentos
      let arr: any[] = [];

      // 1) items como array
      if (Array.isArray(data.items) && data.items.length > 0) {
        arr = data.items;
      }

      // 2) items como objeto map -> convertir a array
      else if (data.items && typeof data.items === "object") {
        try {
          arr = Object.values(data.items);
        } catch (e) {
          arr = [];
        }
      }

      // 3) item único en `item`
      else if (data.item) {
        arr = [data.item];
      }

      // 4) otros nombres comunes: products, lines, detalles
      else if (Array.isArray(data.products) && data.products.length > 0) {
        arr = data.products;
      } else if (Array.isArray(data.lines) && data.lines.length > 0) {
        arr = data.lines;
      } else if (Array.isArray(data.detalles) && data.detalles.length > 0) {
        arr = data.detalles;
      }

      // 5) si no hay array, pero hay campos de producto a nivel raíz
      else if (data.productName || data.product) {
        arr = [
          {
            productName: data.productName || data.product || "",
            qty: data.qty ?? data.quantity ?? data.lbs ?? 0,
            unitPrice: data.unitPrice ?? data.price ?? 0,
            discount: data.discount ?? 0,
            total: data.total ?? data.amount ?? 0,
          },
        ];
      }

      // Si hay allocations por lote, traer precios desde inventory_batches
      // Helper: parse numbers tolerantly (strip currency, thousands separators)
      const parseNum = (v: any) => {
        if (v === undefined || v === null) return NaN;
        if (typeof v === "number") return v;
        let s = String(v).trim();
        if (!s) return NaN;
        // remove currency symbols and letters
        s = s.replace(/[^0-9.,-]/g, "");
        if (!s) return NaN;
        // If contains both . and ,, assume commas are thousands separators
        if (s.indexOf(".") > -1 && s.indexOf(",") > -1) {
          s = s.replace(/,/g, "");
        } else if (s.indexOf(",") > -1 && s.indexOf(".") === -1) {
          s = s.replace(/,/g, ".");
        }
        const n = Number(s);
        return isNaN(n) ? NaN : n;
      };
      const batchIds = new Set<string>();
      // colectar batchIds desde items.allocations y raíz data.allocations
      for (const it of arr) {
        if (Array.isArray(it?.allocations)) {
          for (const a of it.allocations) {
            const id = String(a?.batchId || "").trim();
            if (id) batchIds.add(id);
          }
        }
        // allocations como objeto map
        else if (it?.allocations && typeof it.allocations === "object") {
          try {
            for (const a of Object.values(it.allocations)) {
              const id = String((a as any)?.batchId || "").trim();
              if (id) batchIds.add(id);
            }
          } catch (e) {}
        }
      }

      if (Array.isArray(data?.allocations)) {
        for (const a of data.allocations) {
          const id = String(a?.batchId || "").trim();
          if (id) batchIds.add(id);
        }
      }

      const batchPriceMap: Record<string, number> = {};
      if (batchIds.size > 0) {
        await Promise.all(
          Array.from(batchIds).map(async (bid) => {
            try {
              const bSnap = await getDoc(doc(db, "inventory_batches", bid));
              if (bSnap.exists()) {
                const b = bSnap.data() as any;
                batchPriceMap[bid] = Number(
                  b.salePrice ?? b.sale_price ?? b.price ?? 0,
                );
              }
            } catch (e) {
              /* ignore */
            }
          }),
        );
      }

      const rows = arr.map((it: any) => {
        const productName = String(
          it.productName || it.product || it.name || "(sin nombre)",
        );

        const qty =
          Number(it.qty ?? it.quantity ?? it.lbs ?? it.weight ?? 0) || 0;

        // intentar leer un total declarado en el item (para derivar precio por unidad)
        const totalCandidate =
          parseNum(
            it.total ?? it.lineFinal ?? it.amount ?? it.monto ?? it.line_total,
          ) || 0;

        // Preferir precios que vienen directamente en la venta (varias claves posibles)
        let unitPrice = 0;
        const priceCandidates = [
          it.unitPrice,
          it.unitPricePackage,
          it.salePrice,
          it.sale_price,
          it.price,
          it.unit_price,
          it.pricePerUnit,
          it.price_per_unit,
        ];
        for (const p of priceCandidates) {
          const n = parseNum(p);
          if (!isNaN(n) && n !== 0) {
            unitPrice = n;
            break;
          }
        }

        // Si no hay precio en el item, verificar si la venta (data) tiene un precio aplicable
        if (!unitPrice) {
          const saleLevelRaw =
            data?.salePrice ??
            data?.sale_price ??
            data?.unitPrice ??
            data?.unit_price ??
            data?.price ??
            data?.pricePerUnit;
          const saleLevel = parseNum(saleLevelRaw);
          if (!isNaN(saleLevel) && saleLevel !== 0) unitPrice = saleLevel;
        }

        // si no hay precio, intentar por allocations -> batch price
        if (!unitPrice) {
          const firstAlloc = Array.isArray(it.allocations)
            ? it.allocations[0]
            : it.allocations && typeof it.allocations === "object"
              ? Object.values(it.allocations)[0]
              : null;
          const bid = firstAlloc ? String(firstAlloc.batchId || "").trim() : "";
          if (bid && batchPriceMap[bid]) unitPrice = batchPriceMap[bid] || 0;
        }

        // fallback por productId
        if (!unitPrice && it.productId) {
          unitPrice = productPriceMap[String(it.productId)] || 0;
        }

        // Si aún no hay unitPrice pero hay total declarado y qty>0, derivar unitPrice = total/qty
        if ((!unitPrice || unitPrice === 0) && totalCandidate > 0 && qty > 0) {
          unitPrice = totalCandidate / qty;
        }

        const discount = parseNum(it.discount ?? it.desc ?? 0) || 0;

        // Calcular total de forma explícita para evitar ambigüedades con operadores
        let total = totalCandidate;
        if (!total || total === 0) {
          total = Number(unitPrice * qty || 0);
        }
        total = Number(total) || 0;

        return { productName, qty, unitPrice, discount, total };
      });

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
  const [products, setProducts] = useState<string[]>([]);

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const { refreshKey, refresh } = useManualRefresh();

  // Filtros: Cliente, Tipo y Producto
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [filterType, setFilterType] = useState<"" | SaleType>("");
  const [productFilter, setProductFilter] = useState<string>("ALL");
  const [statusFilter, setStatusFilter] = useState<
    "" | "PROCESADA" | "FLOTANTE"
  >("");

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

  useEffect(() => {
    if (productFilter !== "ALL" && !products.includes(productFilter)) {
      setProductFilter("ALL");
    }
  }, [products, productFilter]);

  // no manejamos comisiones ni vendedores en este reporte Pollo

  // Carga inicial y recarga al cambiar rango de fechas
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // clientes (colección específica para Pollo)
        // Si el usuario es vendedor, cargar solo sus clientes (vendorId === sellerCandyId)
        const cList: Customer[] = [];
        if (isVendor && sellerCandyId) {
          const q = query(
            collection(db, "customers_pollo"),
            where("vendorId", "==", sellerCandyId),
            orderBy("createdAt", "desc"),
          );
          const cSnap = await getDocs(q);
          cSnap.forEach((d) =>
            cList.push({ id: d.id, name: (d.data() as any).name || "" }),
          );
        } else {
          const cSnap = await getDocs(
            query(
              collection(db, "customers_pollo"),
              orderBy("createdAt", "desc"),
            ),
          );
          cSnap.forEach((d) =>
            cList.push({ id: d.id, name: (d.data() as any).name || "" }),
          );
        }
        setCustomers(cList);
        const customersByIdLocal: Record<string, string> = {};
        cList.forEach((c) => {
          customersByIdLocal[c.id] = c.name;
        });

        // ventas (salesV2) para Pollo
        // el estado PROCESADA viene de daily_closures, así que lo mezclamos
        const [sSnap, cSnap, mSnap] = await Promise.all([
          getDocs(
            query(collection(db, "salesV2"), orderBy("timestamp", "desc")),
          ),
          getDocs(
            query(
              collection(db, "daily_closures"),
              orderBy("createdAt", "desc"),
            ),
          ),
          getDocs(
            query(
              collection(db, "ar_movements_pollo"),
              where("date", ">=", fromDate),
              where("date", "<=", toDate),
            ),
          ),
        ]);

        const saleCustomerMap = new Map<string, string>();
        mSnap.forEach((m) => {
          const x = m.data() as any;
          const saleId = String(x?.ref?.saleId || "").trim();
          const custId = String(x?.customerId || "").trim();
          if (saleId && custId) saleCustomerMap.set(saleId, custId);
        });

        const processedMap = new Map<
          string,
          { closureDate?: any; processedDate?: any }
        >();

        cSnap.forEach((cl) => {
          const closure = cl.data() as any;
          const arr = Array.isArray(closure?.salesV2) ? closure.salesV2 : [];
          for (const rawSale of arr) {
            const rawId = String(rawSale?.id || "").trim();
            if (!rawId) continue;
            const baseId = rawId.split("#")[0];
            const status = String(rawSale?.status || "").toUpperCase();
            if (
              status === "PROCESADA" ||
              rawSale?.closureDate ||
              rawSale?.processedDate
            ) {
              processedMap.set(baseId, {
                closureDate: rawSale?.closureDate,
                processedDate: rawSale?.processedDate,
              });
            }
          }
        });

        const list: SaleDoc[] = [];

        sSnap.forEach((d) => {
          const data = d.data() as any;
          const processed = processedMap.get(d.id);
          const fallbackCustomerId = saleCustomerMap.get(d.id);
          if (!data.customerId && fallbackCustomerId) {
            data.customerId = fallbackCustomerId;
          }
          if (!data.customerName && fallbackCustomerId) {
            data.customerName = customersByIdLocal[fallbackCustomerId] || "";
          }
          if (processed) {
            data.status = "PROCESADA";
            if (!data.closureDate && processed.closureDate) {
              data.closureDate = processed.closureDate;
            }
            if (!data.processedDate && processed.processedDate) {
              data.processedDate = processed.processedDate;
            }
          }
          const x = normalizeSale(data, d.id);
          if (!x) return;
          list.push(x);
        });

        const sorted = list.sort((a, b) => b.date.localeCompare(a.date));
        setSales(sorted);

        const startTs = toDateNumber(fromDate);
        const endTs = toDateNumber(toDate);
        setProducts(
          Array.from(
            new Set(
              sorted
                .filter((s) => {
                  const saleTs = getSaleDateTsByStatus(s);
                  if (!isFinite(saleTs)) return false;
                  if (isFinite(startTs) && saleTs < startTs) return false;
                  if (isFinite(endTs) && saleTs > endTs) return false;
                  return true;
                })
                .map(
                  (s) =>
                    s._raw?.productName ||
                    s._raw?.items?.[0]?.productName ||
                    "(sin producto)",
                ),
            ),
          ).sort(),
        );
        setPage(1);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando transacciones.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate, refreshKey]);

  // === Filtros por rango de fecha (para KPIs) ===
  const dateFilteredSales = useMemo(() => {
    const startTs = toDateNumber(fromDate);
    const endTs = toDateNumber(toDate);
    return sales.filter((s) => {
      const saleTs = getSaleDateTsByStatus(s);
      if (!isFinite(saleTs)) return false;
      if (isFinite(startTs) && saleTs < startTs) return false;
      if (isFinite(endTs) && saleTs > endTs) return false;
      return true;
    });
  }, [sales, fromDate, toDate]);

  // === Filtros de tabla (cliente / tipo / producto) ===
  const filteredSales = useMemo(() => {
    return dateFilteredSales.filter((s) => {
      // no filtramos por vendedor aquí para Pollo (acceso controlado por `role`)
      if (filterCustomerId) {
        if (s.customerId !== filterCustomerId) return false;
      }
      if (filterType) {
        if (s.type !== filterType) return false;
      }
      if (productFilter && productFilter !== "ALL") {
        const prod =
          s._raw?.productName || s._raw?.items?.[0]?.productName || "";
        if (!prod || prod !== productFilter) return false;
      }
      if (statusFilter) {
        const estadoLabel = getEstadoLabel(s._raw);
        if (estadoLabel !== statusFilter) return false;
      }
      return true;
    });
  }, [
    dateFilteredSales,
    filterCustomerId,
    filterType,
    productFilter,
    statusFilter,
  ]);

  // KPIs sobre el mismo conjunto visible (rango + filtros)
  const kpis = useMemo(() => {
    let packsCash = 0,
      packsCredito = 0,
      montoCash = 0,
      montoCredito = 0;
    for (const s of filteredSales) {
      const lbs = getLbsFromSaleRaw(s._raw);
      if (s.type === "CONTADO") {
        packsCash += lbs;
        montoCash += s.total;
      } else {
        packsCredito += lbs;
        montoCredito += s.total;
      }
    }
    const packsTotal = packsCash + packsCredito;
    const montoTotal = montoCash + montoCredito;
    return {
      packsCash,
      packsCredito,
      packsTotal,
      montoCash,
      montoCredito,
      montoTotal,
    };
  }, [filteredSales]);

  // === KPIs de unidades (usando s.quantity, no libras) ===
  const kpisUnidades = useMemo(() => {
    let unidadesCash = 0,
      unidadesCredito = 0;
    for (const s of filteredSales) {
      if (s.type === "CONTADO") {
        unidadesCash += s.quantity;
      } else {
        unidadesCredito += s.quantity;
      }
    }
    const unidadesTotal = unidadesCash + unidadesCredito;
    return {
      unidadesCash,
      unidadesCredito,
      unidadesTotal,
    };
  }, [filteredSales]);

  // page slices
  const totalPages = Math.max(1, Math.ceil(filteredSales.length / PAGE_SIZE));
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSales.slice(start, start + PAGE_SIZE);
  }, [filteredSales, page]);

  const [filtersCardOpen, setFiltersCardOpen] = useState(false);
  const [kpisCardOpen, setKpisCardOpen] = useState(false);
  const [transactionsCardOpen, setTransactionsCardOpen] = useState(false);

  const mobileGroups = useMemo(() => {
    const map = new Map<string, { cash: SaleDoc[]; credit: SaleDoc[] }>();
    paged.forEach((s) => {
      const category =
        s._raw?.productName ||
        s._raw?.items?.[0]?.productName ||
        "(sin producto)";
      if (!map.has(category)) {
        map.set(category, { cash: [], credit: [] });
      }
      const grp = map.get(category)!;
      if (s.type === "CONTADO") grp.cash.push(s);
      else grp.credit.push(s);
    });

    return Array.from(map.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [paged]);

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
        "¿Eliminar esta venta? Se restaurará el inventario asociado.",
      )
    )
      return;
    try {
      setLoading(true);
      await restoreSaleAndDelete(s.id);
      await deleteARMovesBySaleId(s.id);

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
    const title = `Ventas del dia — ${fromDate} a ${toDate}`;
    const esc = (s: string) =>
      (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const rows = filteredSales
      .map((s) => {
        const name = getSaleCustomerName(s, customersById);
        const productName =
          s._raw?.productName ||
          s._raw?.items?.[0]?.productName ||
          "(sin producto)";
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

      
        <div><b>Unidades Cash:</b> ${qty3(kpisUnidades.unidadesCash)}</div>
        <div><b>Unidades Crédito:</b> ${qty3(kpisUnidades.unidadesCredito)}</div>
        <div><b>Total Unidades:</b> ${qty3(kpisUnidades.unidadesTotal)}</div>
      </div>

      <div class="kpis">
        <div><b>Libras Cash:</b> ${kpis.packsCash}</div>
        <div><b>Libras Crédito:</b> ${kpis.packsCredito}</div>
        <div><b>Ventas Cash:</b> ${money(kpis.montoCash)}</div>
        <div><b>Ventas Crédito:</b> ${money(kpis.montoCredito)}</div>
      </div>

      <table><thead><tr>
        <th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Libras</th><th>Ventas</th>
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

  const renderMobileSaleCard = (s: SaleDoc) => {
    const name = getSaleCustomerName(s, customersById);
    // Mostrar todos los productos vendidos en la venta
    let productName = "(sin producto)";
    if (Array.isArray(s._raw?.items) && s._raw.items.length > 0) {
      productName = s._raw.items
        .map(
          (it: any) =>
            it.productName || it.product || it.name || "(sin nombre)",
        )
        .join(", ");
    } else if (s._raw?.productName) {
      productName = s._raw.productName;
    } else if (s._raw?.items?.[0]?.productName) {
      productName = s._raw.items[0].productName;
    }
    const estadoLabel = getEstadoLabel(s._raw);

    return (
      <div key={s.id} className="bg-white border rounded-xl shadow">
        <details className="group">
          <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
            <div className="flex-1 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <div className="font-semibold truncate">{name}</div>
                <div className="text-xs text-gray-600 shrink-0">{s.date}</div>
              </div>

              <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                <span
                  className={`px-2 py-1 rounded-full border ${
                    estadoLabel === "PROCESADA"
                      ? "bg-blue-50 border-blue-200 text-blue-700"
                      : "bg-gray-50 border-gray-200 text-gray-700"
                  }`}
                >
                  {estadoLabel}
                </span>
                <span
                  className={`px-2 py-1 rounded-full border ${
                    s.type === "CREDITO"
                      ? "bg-yellow-50 border-yellow-200 text-yellow-700"
                      : "bg-green-50 border-green-200 text-green-700"
                  }`}
                >
                  {s.type === "CREDITO" ? "Crédito" : "Cash"}
                </span>

                <span className="text-gray-700">
                  <b>Libras:</b>{" "}
                  <button
                    type="button"
                    className="underline text-blue-600"
                    onClick={(e) => {
                      e.preventDefault();
                      openItemsModal(s.id);
                    }}
                    title="Ver detalle"
                  >
                    {qty3(s.quantity)}
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
                <span className="font-medium text-right">{name}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Producto</span>
                <span className="font-medium text-right">{productName}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Fecha</span>
                <span className="font-medium">{s.date}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Estado</span>
                <span className="font-medium">{estadoLabel}</span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Tipo</span>
                <span className="font-medium">
                  {s.type === "CREDITO" ? "Crédito" : "Cash"}
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Libras</span>
                <span className="font-medium">
                  <button
                    type="button"
                    className="underline text-blue-600"
                    onClick={() => openItemsModal(s.id)}
                    title="Ver detalle"
                  >
                    {qty3(s.quantity)}
                  </button>
                </span>
              </div>

              <div className="flex items-center justify-between">
                <span className="text-gray-600">Monto</span>
                <span className="font-semibold">{money(s.total)}</span>
              </div>

              <div className="flex items-center justify-between">
                {canDelete && (
                  <div className="pt-2 flex items-center justify-end gap-2 w-full">
                    <button
                      className="px-3 py-2 rounded border hover:bg-gray-50"
                      onClick={() =>
                        setOpenMenuId((prev) => (prev === s.id ? null : s.id))
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
          </div>
        </details>
      </div>
    );
  };

  // ----------------- Render principal -----------------
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Ventas del dia</h2>

      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setFiltersCardOpen((prev) => !prev)}
          aria-expanded={filtersCardOpen}
        >
          <span>Filtros de búsqueda</span>
          <span
            className={`transition-transform ${filtersCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {filtersCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-7 gap-3 items-end text-sm">
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
                  value={productFilter}
                  onChange={(e) => {
                    setProductFilter(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="ALL">Todos</option>
                  {products.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block font-semibold">Estado</label>
                <select
                  className="border rounded px-2 py-1 w-full"
                  value={statusFilter}
                  onChange={(e) => {
                    setStatusFilter(
                      e.target.value as "" | "PROCESADA" | "FLOTANTE",
                    );
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  <option value="FLOTANTE">FLOTANTE</option>
                  <option value="PROCESADA">PROCESADA</option>
                </select>
              </div>

              <button
                className="sm:col-span-2 lg:col-span-1 px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 w-full"
                onClick={handleExportPDF}
              >
                Exportar PDF
              </button>
              <div className="sm:col-span-2 lg:col-span-1 flex">
                <RefreshButton
                  onClick={refresh}
                  loading={loading}
                  className="w-full justify-center"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setKpisCardOpen((prev) => !prev)}
          aria-expanded={kpisCardOpen}
        >
          <span>KPIs</span>
          <span
            className={`transition-transform ${kpisCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {kpisCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {/* <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Unidades Cash</div>
                <div className="text-xl font-semibold">
                  {qty3(kpisUnidades.unidadesCash)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Unidades Crédito</div>
                <div className="text-xl font-semibold">
                  {qty3(kpisUnidades.unidadesCredito)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Total Unidades</div>
                <div className="text-xl font-semibold">
                  {qty3(kpisUnidades.unidadesTotal)}
                </div>
              </div> */}
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Libras Cash</div>
                <div className="text-xl font-semibold">
                  {qty3(kpis.packsCash)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Libras Crédito</div>
                <div className="text-xl font-semibold">
                  {qty3(kpis.packsCredito)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Ventas Cash</div>
                <div className="text-xl font-semibold">
                  {money(kpis.montoCash)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Ventas Crédito</div>
                <div className="text-xl font-semibold">
                  {money(kpis.montoCredito)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Ventas Total</div>
                <div className="text-xl font-semibold">
                  {money(kpis.montoTotal)}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="bg-white border rounded shadow-sm">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setTransactionsCardOpen((prev) => !prev)}
          aria-expanded={transactionsCardOpen}
        >
          <span>Transacciones</span>
          <span
            className={`transition-transform ${transactionsCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {transactionsCardOpen && (
          <div className="p-3 border-t space-y-4">
            <div className="block md:hidden space-y-3">
              {loading ? (
                <div className="bg-white border rounded-lg p-4 shadow">
                  Cargando…
                </div>
              ) : paged.length === 0 ? (
                <div className="bg-white border rounded-lg p-4 shadow">
                  Sin transacciones en el rango.
                </div>
              ) : (
                mobileGroups.map(([category, grp]) => (
                  <div
                    key={category}
                    className="bg-white border rounded-xl shadow"
                  >
                    <details className="group">
                      <summary className="list-none cursor-pointer p-3 flex items-center justify-between">
                        <div className="font-semibold">
                          Categoría: {category}
                        </div>
                        <div className="text-xs text-gray-500">
                          {grp.cash.length + grp.credit.length} transacción(es)
                        </div>
                      </summary>

                      <div className="p-3 pt-0 space-y-3">
                        <div className="bg-gray-50 border rounded-lg">
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-center justify-between">
                              <div className="font-semibold">Cash</div>
                              <div className="text-xs text-gray-500">
                                {grp.cash.length} item(s)
                              </div>
                            </summary>
                            <div className="px-3 pb-3 space-y-3">
                              {grp.cash.length === 0 ? (
                                <div className="text-sm text-gray-500">
                                  Sin transacciones cash.
                                </div>
                              ) : (
                                grp.cash.map(renderMobileSaleCard)
                              )}
                            </div>
                          </details>
                        </div>

                        <div className="bg-gray-50 border rounded-lg">
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-center justify-between">
                              <div className="font-semibold">Crédito</div>
                              <div className="text-xs text-gray-500">
                                {grp.credit.length} item(s)
                              </div>
                            </summary>
                            <div className="px-3 pb-3 space-y-3">
                              {grp.credit.length === 0 ? (
                                <div className="text-sm text-gray-500">
                                  Sin transacciones crédito.
                                </div>
                              ) : (
                                grp.credit.map(renderMobileSaleCard)
                              )}
                            </div>
                          </details>
                        </div>
                      </div>
                    </details>
                  </div>
                ))
              )}

              <div className="bg-white p-3 rounded shadow border">
                {renderPager()}
              </div>
            </div>

            <div className="hidden md:block bg-white p-2 rounded shadow border w-full">
              <table className="min-w-full w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Estado</th>
                    <th className="p-2 border">Cliente</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Tipo</th>
                    <th className="p-2 border">Libras</th>
                    <th className="p-2 border">Ventas</th>
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
                      const name = getSaleCustomerName(s, customersById);
                      // Mostrar todos los productos vendidos en la venta
                      let productName = "(sin producto)";
                      if (
                        Array.isArray(s._raw?.items) &&
                        s._raw.items.length > 0
                      ) {
                        productName = s._raw.items
                          .map(
                            (it: any) =>
                              it.productName ||
                              it.product ||
                              it.name ||
                              "(sin nombre)",
                          )
                          .join(", ");
                      } else if (s._raw?.productName) {
                        productName = s._raw.productName;
                      } else if (s._raw?.items?.[0]?.productName) {
                        productName = s._raw.items[0].productName;
                      }
                      const estadoLabel = getEstadoLabel(s._raw);

                      return (
                        <tr key={s.id} className="text-center">
                          <td className="p-2 border">{s.date}</td>
                          <td className="p-2 border">{estadoLabel}</td>
                          <td className="p-2 border">{name}</td>
                          <td className="p-2 border">{productName}</td>
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
                              {qty3(s.quantity)}
                            </button>
                          </td>
                          <td className="p-2 border">{money(s.total)}</td>

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

              {renderPager()}
            </div>
          </div>
        )}
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal: Detalle de piezas de la venta */}
      {itemsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl p-4">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-lg font-bold">
                  Productos vendidos{" "}
                  {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""}
                </h3>

                {/* no mostramos comisión en Pollo */}
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
                    <th className="p-2 border text-right">Libras</th>
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
