// src/components/Candies/DataCenterCandies.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  where,
} from "firebase/firestore";
import { format } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

type RoleCandies =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";
type SaleStatus = "FLOTANTE" | "PROCESADA";
type SaleType = "CONTADO" | "CREDITO";
type GroupBy = "DIA" | "VENDEDOR" | "PRODUCTO" | "SUCURSAL";

type FireTimestamp = { toDate?: () => Date } | undefined;

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

const normalizeBranch = (b: any): Branch | "" => {
  const s = String(b || "")
    .toUpperCase()
    .trim();
  if (s === "RIVAS") return "RIVAS";
  if (s === "SAN_JORGE" || s === "SANJORGE" || s === "SJ") return "SAN_JORGE";
  if (s === "ISLA" || s === "OMETEPE") return "ISLA";
  return "";
};

interface SellerCandy {
  id: string; // vendorId
  name: string;
  commissionPercent: number;
  branch?: string;
}

interface SaleDataRaw {
  date?: string;
  timestamp?: FireTimestamp;
  status?: SaleStatus;
  type?: SaleType;

  vendorId?: string;
  vendorName?: string;
  userEmail?: string;

  // ✅ a veces viene customerId
  customerId?: string;

  customerName?: string;
  clientName?: string;

  branch?: Branch | string;
  vendorBranch?: Branch | string;
  vendorBranchLabel?: string;

  total?: number;
  itemsTotal?: number;
  packagesTotal?: number;
  amount?: number;
  amountCharged?: number;

  vendorCommissionAmount?: number;
  vendorCommissionPercent?: number;

  processedDate?: string;
  processedAt?: any;
  closureDate?: string;

  items?: Array<{
    productId?: string;
    productName?: string;
    packages?: number;
    qty?: number;
    unitsPerPackage?: number;
    unitPricePackage?: number;
    total?: number;
    discount?: number;
    branch?: Branch | string;
  }>;
}

interface SaleRow {
  id: string; // docId#idx
  docId: string;

  productId: string;
  productName: string;

  date: string;
  processedDate: string;
  status: SaleStatus;
  type: SaleType;

  vendorId: string;
  vendorName: string;

  customerId: string;
  customerName: string;

  branch: Branch | "";
  packages: number;
  amount: number;
  commission: number;
}

const normalizeSalesMany = (raw: SaleDataRaw, docId: string): SaleRow[] => {
  const date =
    raw.date ??
    (raw.timestamp?.toDate
      ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
      : "");
  if (!date) return [];

  const processedDate = String(
    raw.processedDate ?? raw.closureDate ?? ""
  ).trim();

  const status: SaleStatus = (raw.status as any) ?? "FLOTANTE";
  const type: SaleType = (raw.type || "CONTADO") as SaleType;

  const vendorId = String(raw.vendorId ?? "").trim();
  const vendorName =
    String(raw.vendorName ?? "").trim() ||
    String(raw.userEmail ?? "").trim() ||
    vendorId ||
    "(sin vendedor)";

  const customerId = String(raw.customerId ?? "").trim();

  const customerName =
    String(raw.customerName ?? "").trim() ||
    String(raw.clientName ?? "").trim() ||
    "";

  const saleTotalRoot =
    Number(
      raw.total ?? raw.itemsTotal ?? raw.amount ?? raw.amountCharged ?? 0
    ) || 0;
  const saleCommissionRoot = Number(raw.vendorCommissionAmount ?? 0) || 0;

  const rootBranch = normalizeBranch(raw.branch ?? raw.vendorBranch);

  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const packages = Number(it?.packages ?? 0) || 0;

      const lineAmount =
        Number(it?.total ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPricePackage || 0) * packages -
            Number(it?.discount || 0)
        );

      const branch = normalizeBranch(it?.branch) || rootBranch;

      let commission = 0;
      if (saleCommissionRoot > 0 && saleTotalRoot > 0 && lineAmount > 0) {
        commission = round2((saleCommissionRoot * lineAmount) / saleTotalRoot);
      }

      return {
        id: `${docId}#${idx}`,
        docId,
        productId: String(it?.productId ?? ""),
        productName: String(it?.productName ?? "(sin nombre)"),
        date,
        processedDate,
        status,
        type,
        vendorId,
        vendorName,
        customerId,
        customerName,
        branch: branch || "",
        packages,
        amount: round2(lineAmount),
        commission: round2(commission),
      };
    });
  }

  const packages = Number(raw.packagesTotal ?? 0) || 0;
  const amount = Number(raw.total ?? raw.amount ?? raw.amountCharged ?? 0) || 0;
  const commission = round2(Number(raw.vendorCommissionAmount ?? 0) || 0);

  return [
    {
      id: `${docId}#0`,
      docId,
      productId: "",
      productName: "(sin nombre)",
      date,
      processedDate,
      status,
      type,
      vendorId,
      vendorName,
      customerId,
      customerName,
      branch: rootBranch || "",
      packages,
      amount: round2(amount),
      commission: round2(commission),
    },
  ];
};

type MainOrderItem = {
  name?: string;
  id?: string;
  subtotal?: number; // proveedor
  totalRivas?: number;
  totalSanJorge?: number;
  totalIsla?: number;
  gainRivas?: number;
  gainSanJorge?: number;
  gainIsla?: number;
  packages?: number;
  remainingPackages?: number;
};

type MainOrderDoc = {
  id: string;
  date?: string; // "yyyy-MM-dd"
  items?: MainOrderItem[];
  subtotal?: number; // fallback
  totalPackages?: number; // fallback
};

type VendorOrderDoc = {
  id: string;
  date?: string;
  sellerId?: string;
  sellerName?: string;
  packages?: number;
  remainingPackages?: number;
  subtotal?: number; // proveedor

  // ⚠️ en tu colección sellers existen estos a veces:
  remainingUnits?: number;
  remaining?: number;
  unitsPerPackage?: number;
};

type CustomerDoc = {
  id: string;
  name?: string;
};

type ARMovement = {
  id: string;
  customerId?: string;
  date?: string; // "yyyy-MM-dd"
  amount?: number;
  type?: "CARGO" | "ABONO";
};

// ======================
//  CHARTS (sin librerías)
// ======================
function clamp01(n: number) {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

function LineChartSimple({
  title,
  series,
  valuePrefix = "C$",
}: {
  title: string;
  series: Array<{ label: string; value: number }>;
  valuePrefix?: string;
}) {
  const W = 900;
  const H = 260;
  const padL = 44;
  const padR = 16;
  const padT = 18;
  const padB = 38;

  const values = series.map((x) => Number(x.value || 0));
  const minV = values.length ? Math.min(...values) : 0;
  const maxV = values.length ? Math.max(...values) : 0;
  const range = maxV - minV || 1;

  const innerW = W - padL - padR;
  const innerH = H - padT - padB;

  const points = series.map((p, i) => {
    const x =
      padL +
      (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
    const y = padT + (1 - (Number(p.value || 0) - minV) / range) * innerH;
    return { x, y, ...p };
  });

  const path = points
    .map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`)
    .join(" ");

  const last = points[points.length - 1];
  const lastValue = last ? last.value : 0;

  return (
    <div className="border rounded-2xl p-3 shadow-sm bg-white">
      <div className="flex items-start justify-between gap-2 mb-2">
        <div className="font-semibold text-sm sm:text-base">{title}</div>
        <div className="text-xs text-gray-600 whitespace-nowrap">
          Último: <strong>{valuePrefix + money(lastValue)}</strong>
        </div>
      </div>

      <div className="w-full overflow-x-auto">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          className="min-w-[720px] w-full h-auto"
          role="img"
          aria-label={title}
        >
          {/* grid */}
          {[0, 1, 2, 3].map((i) => {
            const y = padT + (i / 3) * innerH;
            return (
              <line
                key={i}
                x1={padL}
                y1={y}
                x2={W - padR}
                y2={y}
                stroke="#e5e7eb"
                strokeWidth="1"
              />
            );
          })}

          {/* axis labels (min/max) */}
          <text x={8} y={padT + 10} fontSize="12" fill="#6b7280">
            {valuePrefix}
            {money(maxV)}
          </text>
          <text x={8} y={padT + innerH} fontSize="12" fill="#6b7280">
            {valuePrefix}
            {money(minV)}
          </text>

          {/* line */}
          <path d={path} fill="none" stroke="#111827" strokeWidth="2.5" />

          {/* points */}
          {points.map((p, idx) => (
            <circle key={idx} cx={p.x} cy={p.y} r="3.5" fill="#111827" />
          ))}

          {/* x labels (primer/último) */}
          {series.length > 0 && (
            <>
              <text
                x={padL}
                y={H - 14}
                fontSize="12"
                fill="#6b7280"
                textAnchor="start"
              >
                {series[0].label}
              </text>
              <text
                x={W - padR}
                y={H - 14}
                fontSize="12"
                fill="#6b7280"
                textAnchor="end"
              >
                {series[series.length - 1].label}
              </text>
            </>
          )}
        </svg>
      </div>
    </div>
  );
}

function PieChartSimple({
  title,
  items,
}: {
  title: string;
  items: Array<{ label: string; value: number }>;
}) {
  const total = items.reduce((s, x) => s + Number(x.value || 0), 0);
  const size = 240;
  const r = 86;
  const cx = 120;
  const cy = 120;

  const safeTotal = total > 0 ? total : 1;
  let acc = 0;

  // Monochrome palette (grays) para no pelear con tema/estilo
  const shades = ["#111827", "#374151", "#6b7280", "#9ca3af"];

  const arcs = items.map((it, idx) => {
    const v = Math.max(0, Number(it.value || 0));
    const start = acc / safeTotal;
    const frac = v / safeTotal;
    acc += v;

    const end = start + frac;

    const a0 = start * Math.PI * 2 - Math.PI / 2;
    const a1 = end * Math.PI * 2 - Math.PI / 2;

    const x0 = cx + r * Math.cos(a0);
    const y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1);
    const y1 = cy + r * Math.sin(a1);

    const largeArc = frac > 0.5 ? 1 : 0;

    const d = [
      `M ${cx} ${cy}`,
      `L ${x0.toFixed(2)} ${y0.toFixed(2)}`,
      `A ${r} ${r} 0 ${largeArc} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`,
      "Z",
    ].join(" ");

    return { d, fill: shades[idx % shades.length], ...it, frac };
  });

  return (
    <div className="border rounded-2xl p-3 shadow-sm bg-white">
      <div className="font-semibold text-sm sm:text-base mb-2">{title}</div>

      <div className="flex flex-col md:flex-row gap-3 md:items-center">
        <div className="w-full md:w-auto overflow-x-auto">
          <svg
            viewBox={`0 0 ${size} ${size}`}
            className="min-w-[240px] w-[260px] h-auto"
            role="img"
            aria-label={title}
          >
            {arcs.map((a, i) => (
              <path key={i} d={a.d} fill={a.fill} />
            ))}
            <circle cx={cx} cy={cy} r="48" fill="#ffffff" />
            <text
              x={cx}
              y={cy - 4}
              textAnchor="middle"
              fontSize="12"
              fill="#6b7280"
            >
              Total
            </text>
            <text
              x={cx}
              y={cy + 16}
              textAnchor="middle"
              fontSize="14"
              fill="#111827"
              fontWeight="700"
            >
              C${money(total)}
            </text>
          </svg>
        </div>

        <div className="flex-1">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {items.map((it, idx) => {
              const v = Number(it.value || 0);
              const pct = clamp01(v / (total || 1)) * 100;
              return (
                <div
                  key={it.label}
                  className="border rounded-xl p-2 bg-gray-50"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-sm font-semibold truncate">
                      {it.label}
                    </div>
                    <div className="text-sm font-bold whitespace-nowrap">
                      C${money(v)}
                    </div>
                  </div>
                  <div className="text-xs text-gray-600 mt-1">
                    {pct.toFixed(1)}%
                  </div>
                  <div className="h-2 bg-white border rounded-full mt-2 overflow-hidden">
                    <div
                      className="h-full"
                      style={{
                        width: `${pct}%`,
                        background: shades[idx % shades.length],
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>

          <div className="text-xs text-gray-500 mt-2">
            *Distribución basada en ventas del período con los filtros actuales.
          </div>
        </div>
      </div>
    </div>
  );
}

export default function DataCenterCandies({
  role,
}: {
  role?: RoleCandies;
}): React.ReactElement {
  const isAdmin = !role || role === "admin";

  const today = format(new Date(), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(today);

  const [statusFilter, setStatusFilter] = useState<"TODAS" | SaleStatus>(
    "TODAS"
  );
  const [typeFilter, setTypeFilter] = useState<"AMBAS" | "CASH" | "CREDITO">(
    "AMBAS"
  );
  const [vendorFilter, setVendorFilter] = useState<string>("ALL");
  const [branchFilter, setBranchFilter] = useState<"ALL" | Branch>("ALL");
  const [productFilter, setProductFilter] = useState<string>("");
  const [customerFilter, setCustomerFilter] = useState<string>("");

  const [minAmount, setMinAmount] = useState<string>("");
  const [maxAmount, setMaxAmount] = useState<string>("");

  const [groupBy, setGroupBy] = useState<GroupBy>("DIA");

  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [salesRows, setSalesRows] = useState<SaleRow[]>([]);
  const [sellers, setSellers] = useState<SellerCandy[]>([]);
  const [mainOrders, setMainOrders] = useState<MainOrderDoc[]>([]);
  const [vendorOrders, setVendorOrders] = useState<VendorOrderDoc[]>([]);
  const [customers, setCustomers] = useState<CustomerDoc[]>([]);
  const [movements, setMovements] = useState<ARMovement[]>([]);

  // ✅ GLOBAL existencias (todas las órdenes / actuales)
  const [allMasterInventory, setAllMasterInventory] = useState<any[]>([]);
  const [allVendorInventory, setAllVendorInventory] = useState<any[]>([]);

  const [detailKey, setDetailKey] = useState<string>("");
  const pdfRef = useRef<HTMLDivElement>(null);

  const [invCandiesAll, setInvCandiesAll] = useState<any[]>([]);

  // ✅ TABS/CHIPS: Macro vs Detalle
  const [dataView, setDataView] = useState<"MACRO" | "DETALLE">("DETALLE");

  // ✅ Gastos del período (input manual para que admin lo capture)
  const [otherExpenses, setOtherExpenses] = useState<string>("");

  const customersMap = useMemo(() => {
    const map: Record<string, string> = {};
    customers.forEach((c) => {
      map[c.id] = String(c.name || "").trim();
    });
    return map;
  }, [customers]);

  const displayCustomerName = (r: SaleRow) => {
    const byId = r.customerId ? customersMap[r.customerId] : "";
    const name = (r.customerName || byId || "").trim();
    return (
      name ||
      (r.customerId ? customersMap[r.customerId] || r.customerId : "") ||
      ""
    );
  };

  useEffect(() => {
    if (!isAdmin) return;

    const fetchInvAll = async () => {
      try {
        const snap = await getDocs(collection(db, "inventory_candies"));
        const rows: any[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setInvCandiesAll(rows);
      } catch (e) {
        console.error("inventory_candies all error:", e);
        setInvCandiesAll([]);
      }
    };

    fetchInvAll();
  }, [isAdmin]);

  // --- sellers ---
  useEffect(() => {
    const fetchSellers = async () => {
      try {
        const snap = await getDocs(collection(db, "sellers_candies"));
        const list: SellerCandy[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          list.push({
            id: d.id,
            name: String(data.name || "").trim(),
            commissionPercent: Number(data.commissionPercent || 0),
            branch: data.branch || "",
          });
        });
        const map = new Map<string, SellerCandy>();
        list.forEach((s) => map.set(s.id, s));
        setSellers(
          Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name))
        );
      } catch (e) {
        console.error(e);
      }
    };
    fetchSellers();
  }, []);

  // --- sales_candies periodo ---
  useEffect(() => {
    if (!isAdmin) return;
    if (!startDate || !endDate) return;

    setLoading(true);
    setMessage("");

    const qSales = query(
      collection(db, "sales_candies"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
      orderBy("date", "asc")
    );

    const unsub = onSnapshot(
      qSales,
      (snap) => {
        const rows: SaleRow[] = [];
        snap.forEach((d) =>
          rows.push(...normalizeSalesMany(d.data() as SaleDataRaw, d.id))
        );
        setSalesRows(rows);
        setLoading(false);
      },
      (err) => {
        console.error("sales_candies periodo error:", err);
        setSalesRows([]);
        setLoading(false);
        setMessage(
          "❌ Error cargando ventas del período (revisá índices si aplica)."
        );
      }
    );

    return () => unsub();
  }, [isAdmin, startDate, endDate]);

  // --- candy_main_orders periodo ---
  useEffect(() => {
    if (!isAdmin) return;

    const fetchOrders = async () => {
      try {
        const qy = query(
          collection(db, "candy_main_orders"),
          where("date", ">=", startDate),
          where("date", "<=", endDate)
        );
        const snap = await getDocs(qy);
        const rows: MainOrderDoc[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setMainOrders(rows);
      } catch (e) {
        console.error("candy_main_orders error:", e);
        setMainOrders([]);
      }
    };

    fetchOrders();
  }, [isAdmin, startDate, endDate]);

  // --- inventory_candies_sellers periodo (órdenes vendedor) ---
  useEffect(() => {
    if (!isAdmin) return;

    const fetchVendorOrders = async () => {
      try {
        const qy = query(
          collection(db, "inventory_candies_sellers"),
          where("date", ">=", startDate),
          where("date", "<=", endDate)
        );
        const snap = await getDocs(qy);
        const rows: VendorOrderDoc[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setVendorOrders(rows);
      } catch (e) {
        console.error("inventory_candies_sellers error:", e);
        setVendorOrders([]);
      }
    };

    fetchVendorOrders();
  }, [isAdmin, startDate, endDate]);

  // ✅ GLOBAL: inventory_candies (existencias maestras actuales)
  useEffect(() => {
    if (!isAdmin) return;

    const fetchAllMasterInventory = async () => {
      try {
        const snap = await getDocs(collection(db, "inventory_candies"));
        const rows: any[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setAllMasterInventory(rows);
      } catch (e) {
        console.error("inventory_candies global error:", e);
        setAllMasterInventory([]);
      }
    };

    fetchAllMasterInventory();
  }, [isAdmin]);

  // ✅ GLOBAL: inventory_candies_sellers (existencias vendedores actuales)
  useEffect(() => {
    if (!isAdmin) return;

    const fetchAllVendorInventory = async () => {
      try {
        const snap = await getDocs(collection(db, "inventory_candies_sellers"));
        const rows: any[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setAllVendorInventory(rows);
      } catch (e) {
        console.error("inventory_candies_sellers global error:", e);
        setAllVendorInventory([]);
      }
    };

    fetchAllVendorInventory();
  }, [isAdmin]);

  // --- customers (para nombres) EN TIEMPO REAL ---
  useEffect(() => {
    if (!isAdmin) return;

    const qCustomers = query(collection(db, "customers_candies"));

    const unsub = onSnapshot(
      qCustomers,
      (snap) => {
        const rows: CustomerDoc[] = [];
        snap.forEach((d) =>
          rows.push({
            id: d.id,
            name: String((d.data() as any)?.name || "").trim(),
          })
        );
        setCustomers(rows);
      },
      (err) => {
        console.error("customers_candies snapshot error:", err);
        setCustomers([]);
      }
    );

    return () => unsub();
  }, [isAdmin]);

  // --- ar_movements ---
  useEffect(() => {
    if (!isAdmin) return;

    const fetchMovements = async () => {
      try {
        const qy = query(
          collection(db, "ar_movements"),
          where("date", "<=", endDate),
          orderBy("date", "asc")
        );
        const snap = await getDocs(qy);
        const rows: ARMovement[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setMovements(rows);
      } catch (e) {
        console.warn("ar_movements sin índice, usando fallback:", e);
        try {
          const snap = await getDocs(collection(db, "ar_movements"));
          const rows: ARMovement[] = [];
          snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
          setMovements(rows.filter((m) => String(m.date || "") <= endDate));
        } catch (e2) {
          console.error(e2);
          setMovements([]);
        }
      }
    };

    fetchMovements();
  }, [isAdmin, endDate]);

  // --- filtros ventas ---
  const filteredRows = useMemo(() => {
    let base = [...salesRows];

    if (statusFilter !== "TODAS")
      base = base.filter((r) => r.status === statusFilter);

    if (typeFilter === "CASH") base = base.filter((r) => r.type === "CONTADO");
    if (typeFilter === "CREDITO")
      base = base.filter((r) => r.type === "CREDITO");

    if (vendorFilter !== "ALL")
      base = base.filter((r) => (r.vendorId || "") === vendorFilter);

    if (branchFilter !== "ALL")
      base = base.filter((r) => r.branch === branchFilter);

    if (productFilter.trim()) {
      const p = productFilter.trim().toLowerCase();
      base = base.filter((r) =>
        (r.productName || "").toLowerCase().includes(p)
      );
    }

    if (customerFilter.trim()) {
      const c = customerFilter.trim().toLowerCase();
      base = base.filter((r) =>
        (displayCustomerName(r) || "").toLowerCase().includes(c)
      );
    }

    const min = minAmount.trim() ? Number(minAmount) : null;
    const max = maxAmount.trim() ? Number(maxAmount) : null;
    if (min !== null && !Number.isNaN(min))
      base = base.filter((r) => (r.amount || 0) >= min);
    if (max !== null && !Number.isNaN(max))
      base = base.filter((r) => (r.amount || 0) <= max);

    return base;
  }, [
    salesRows,
    statusFilter,
    typeFilter,
    vendorFilter,
    branchFilter,
    productFilter,
    customerFilter,
    minAmount,
    maxAmount,
    customersMap,
  ]);

  // --- KPIs base ---
  const kpis = useMemo(() => {
    let packsCash = 0;
    let packsCredit = 0;
    let salesCash = 0;
    let salesCredit = 0;
    let commCash = 0;
    let commCredit = 0;

    for (const r of filteredRows) {
      const packs = Number(r.packages || 0);
      const amt = Number(r.amount || 0);
      const com = Number(r.commission || 0);

      if (r.type === "CREDITO") {
        packsCredit += packs;
        salesCredit += amt;
        commCredit += com;
      } else {
        packsCash += packs;
        salesCash += amt;
        commCash += com;
      }
    }

    const salesTotal = round2(salesCash + salesCredit);

    return {
      packsCash: round3(packsCash),
      packsCredit: round3(packsCredit),
      salesCash: round2(salesCash),
      salesCredit: round2(salesCredit),
      salesTotal,
      commCash: round2(commCash),
      commCredit: round2(commCredit),
    };
  }, [filteredRows]);

  // --- expected + gross por sucursal (maestras) ---
  const expectedAndGross = useMemo(() => {
    let expR = 0,
      expSJ = 0,
      expI = 0;
    let gpR = 0,
      gpSJ = 0,
      gpI = 0;

    for (const o of mainOrders) {
      const items = Array.isArray(o.items) ? o.items : [];
      for (const it of items) {
        expR += Number(it.totalRivas ?? 0);
        expSJ += Number(it.totalSanJorge ?? 0);
        expI += Number(it.totalIsla ?? 0);

        gpR += Number(it.gainRivas ?? 0);
        gpSJ += Number(it.gainSanJorge ?? 0);
        gpI += Number(it.gainIsla ?? 0);
      }
    }

    return {
      expectedRivas: round2(expR),
      expectedSanJorge: round2(expSJ),
      expectedIsla: round2(expI),
      grossRivas: round2(gpR),
      grossSanJorge: round2(gpSJ),
      grossIsla: round2(gpI),
      grossTotal: round2(gpR + gpSJ + gpI),
      expectedTotal: round2(expR + expSJ + expI),
    };
  }, [mainOrders]);

  // --- actual por sucursal desde ventas ---
  const actualByBranch = useMemo(() => {
    const map: Record<Branch, { sales: number; packages: number }> = {
      RIVAS: { sales: 0, packages: 0 },
      SAN_JORGE: { sales: 0, packages: 0 },
      ISLA: { sales: 0, packages: 0 },
    };

    for (const r of filteredRows) {
      const b = r.branch;
      if (!b) continue;
      map[b].sales += Number(r.amount || 0);
      map[b].packages += Number(r.packages || 0);
    }

    return {
      RIVAS: {
        sales: round2(map.RIVAS.sales),
        packages: round3(map.RIVAS.packages),
      },
      SAN_JORGE: {
        sales: round2(map.SAN_JORGE.sales),
        packages: round3(map.SAN_JORGE.packages),
      },
      ISLA: {
        sales: round2(map.ISLA.sales),
        packages: round3(map.ISLA.packages),
      },
    };
  }, [filteredRows]);

  const diffVsExpected = useMemo(() => {
    return {
      RIVAS: round2(
        actualByBranch.RIVAS.sales - expectedAndGross.expectedRivas
      ),
      SAN_JORGE: round2(
        actualByBranch.SAN_JORGE.sales - expectedAndGross.expectedSanJorge
      ),
      ISLA: round2(actualByBranch.ISLA.sales - expectedAndGross.expectedIsla),
    };
  }, [actualByBranch, expectedAndGross]);

  // --- KPI vendedores (comisión cash / crédito) ---
  const vendorsKpi = useMemo(() => {
    const cash: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};
    const credit: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};

    for (const r of filteredRows) {
      const vid = (r.vendorId || "").trim();
      if (!vid) continue;

      const seller = sellers.find((x) => x.id === vid);
      const name = seller?.name || r.vendorName || "(sin vendedor)";
      const com = Number(r.commission || 0);

      if (r.type === "CREDITO") {
        if (!credit[vid]) credit[vid] = { vendorId: vid, name, total: 0 };
        credit[vid].total = round2(credit[vid].total + com);
      } else {
        if (!cash[vid]) cash[vid] = { vendorId: vid, name, total: 0 };
        cash[vid].total = round2(cash[vid].total + com);
      }
    }

    const cashArr = Object.values(cash).sort((a, b) => b.total - a.total);
    const creditArr = Object.values(credit).sort((a, b) => b.total - a.total);

    return { cashArr, creditArr };
  }, [filteredRows, sellers]);

  // ✅ NUEVOS KPIs pedidos (proveedor + paquetes maestras/vendedor + por vendedor)
  const providerAndPackagesKpis = useMemo(() => {
    const sumNumber = (arr: any[], key: string) =>
      arr.reduce((s, x) => s + Number(x?.[key] ?? 0), 0);

    const remainingFromItemsNoDup = (items: any[]) => {
      const vals = items
        .map((it) => Number(it?.remainingPackages ?? 0))
        .filter((v) => Number.isFinite(v));
      if (vals.length === 0) return 0;
      const allSame = vals.every((v) => v === vals[0]);
      if (allSame) return vals[0]; // ✅ no duplicar
      return vals.reduce((s, v) => s + v, 0);
    };

    const orderedFromOrder = (o: any) => {
      const root = Number(o?.totalPackages ?? 0);
      if (root > 0) return root;
      const items = Array.isArray(o?.items) ? o.items : [];
      return sumNumber(items, "packages");
    };

    const remainingFromOrder = (o: any) => {
      const root = Number(o?.remainingPackages ?? 0);
      if (root > 0) return root;
      const items = Array.isArray(o?.items) ? o.items : [];
      return remainingFromItemsNoDup(items);
    };

    const safeInt = (n: any) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return 0;
      return Math.floor(x);
    };

    const getRemainingPackagesVendorDoc = (v: any) => {
      const rp = Number(v?.remainingPackages);
      if (Number.isFinite(rp) && rp > 0) return Math.floor(rp);

      const unitsPerPackage = Math.max(1, safeInt(v?.unitsPerPackage ?? 1));
      const remainingUnits = safeInt(v?.remainingUnits ?? v?.remaining ?? 0);
      if (remainingUnits > 0)
        return Math.max(0, Math.floor(remainingUnits / unitsPerPackage));
      return 0;
    };

    let providerTotalMaster = 0;
    let orderedPacksMaster = 0;
    let remainingPacksMaster = 0;

    for (const o of mainOrders) {
      const items = Array.isArray((o as any).items) ? (o as any).items : [];
      if (items.length) {
        for (const it of items)
          providerTotalMaster += Number(it?.subtotal ?? 0);
      } else {
        providerTotalMaster += Number((o as any).subtotal ?? 0);
      }

      orderedPacksMaster += orderedFromOrder(o);
      remainingPacksMaster += remainingFromOrder(o);
    }

    let providerTotalVendor = 0;
    let orderedPacksVendor = 0;
    let remainingPacksVendor = 0;

    const byVendor: Record<
      string,
      {
        sellerId: string;
        sellerName: string;
        ordered: number;
        remaining: number;
      }
    > = {};

    for (const v of vendorOrders) {
      providerTotalVendor += Number(v.subtotal ?? 0);
      orderedPacksVendor += Number(v.packages ?? 0);

      const remainingVendorPkgs = getRemainingPackagesVendorDoc(v);
      remainingPacksVendor += remainingVendorPkgs;

      const sid = String(v.sellerId || "").trim();
      if (!sid) continue;

      const sname = String(v.sellerName || "").trim() || "(sin vendedor)";
      if (!byVendor[sid])
        byVendor[sid] = {
          sellerId: sid,
          sellerName: sname,
          ordered: 0,
          remaining: 0,
        };

      byVendor[sid].ordered += Number(v.packages ?? 0);
      byVendor[sid].remaining += remainingVendorPkgs;
    }

    const vendorRowsOrdered = Object.values(byVendor)
      .map((x) => ({
        ...x,
        ordered: round3(x.ordered),
        remaining: round3(x.remaining),
      }))
      .sort((a, b) => b.ordered - a.ordered);

    const vendorRowsRemaining = [...vendorRowsOrdered].sort(
      (a, b) => b.remaining - a.remaining
    );

    const globalRemainingMaster = remainingPacksMaster;
    const globalRemainingVendor = remainingPacksVendor;

    const periodOrderIds = new Set(
      mainOrders
        .filter(
          (o) =>
            String(o.date || "") >= startDate && String(o.date || "") <= endDate
        )
        .map((o) => o.id)
    );

    let remainingPacksMasterPeriod = 0;
    for (const inv of invCandiesAll) {
      const oid = String(inv.orderId || "").trim();
      if (!oid) continue;
      if (!periodOrderIds.has(oid)) continue;
      remainingPacksMasterPeriod += Number(inv.remainingPackages ?? 0);
    }

    return {
      providerTotalMaster: round2(providerTotalMaster),
      providerTotalVendor: round2(providerTotalVendor),

      orderedPacksMaster: round3(orderedPacksMaster),
      remainingPacksMaster: round3(remainingPacksMasterPeriod),

      orderedPacksVendor: round3(orderedPacksVendor),
      remainingPacksVendor: round3(remainingPacksVendor),

      globalRemainingMaster: round3(globalRemainingMaster),
      globalRemainingVendor: round3(globalRemainingVendor),

      vendorRowsOrdered,
      vendorRowsRemaining,
    };
  }, [mainOrders, vendorOrders, invCandiesAll, startDate, endDate]);

  // ✅ KPI EXISTENCIAS GLOBALES
  const globalStockKpis = useMemo(() => {
    const masterRemainingPackages = allMasterInventory.reduce(
      (s, x) => s + Number(x.remainingPackages ?? 0),
      0
    );

    const vendorRemainingPackages = allVendorInventory.reduce(
      (s, x) => s + Number(x.remainingPackages ?? 0),
      0
    );

    return {
      masterRemainingPackages: round3(masterRemainingPackages),
      vendorRemainingPackages: round3(vendorRemainingPackages),
    };
  }, [allMasterInventory, allVendorInventory]);

  // --- tabla principal group by ---
  const grouped = useMemo(() => {
    type Agg = {
      key: string;
      label: string;
      packsCash: number;
      packsCredit: number;
      salesCash: number;
      salesCredit: number;
      commCash: number;
      commCredit: number;
      rows: SaleRow[];
    };

    const map = new Map<string, Agg>();

    const getKeyLabel = (r: SaleRow): { key: string; label: string } => {
      if (groupBy === "DIA") return { key: r.date, label: r.date };
      if (groupBy === "VENDEDOR")
        return { key: r.vendorId || "—", label: r.vendorName || "—" };
      if (groupBy === "PRODUCTO")
        return { key: r.productName || "—", label: r.productName || "—" };
      return { key: r.branch || "—", label: r.branch || "—" };
    };

    for (const r of filteredRows) {
      const { key, label } = getKeyLabel(r);
      if (!map.has(key)) {
        map.set(key, {
          key,
          label,
          packsCash: 0,
          packsCredit: 0,
          salesCash: 0,
          salesCredit: 0,
          commCash: 0,
          commCredit: 0,
          rows: [],
        });
      }
      const agg = map.get(key)!;
      agg.rows.push(r);

      if (r.type === "CREDITO") {
        agg.packsCredit += Number(r.packages || 0);
        agg.salesCredit += Number(r.amount || 0);
        agg.commCredit += Number(r.commission || 0);
      } else {
        agg.packsCash += Number(r.packages || 0);
        agg.salesCash += Number(r.amount || 0);
        agg.commCash += Number(r.commission || 0);
      }
    }

    const arr = Array.from(map.values()).map((a) => ({
      ...a,
      packsCash: round3(a.packsCash),
      packsCredit: round3(a.packsCredit),
      salesCash: round2(a.salesCash),
      salesCredit: round2(a.salesCredit),
      commCash: round2(a.commCash),
      commCredit: round2(a.commCredit),
    }));

    if (groupBy === "DIA") arr.sort((a, b) => (a.key < b.key ? 1 : -1));
    else
      arr.sort(
        (a, b) => b.salesCash + b.salesCredit - (a.salesCash + a.salesCredit)
      );

    return arr;
  }, [filteredRows, groupBy]);

  const detailRows = useMemo(() => {
    if (!detailKey) return [];
    const g = grouped.find((x) => x.key === detailKey);
    return g?.rows || [];
  }, [detailKey, grouped]);

  const detailProductSummary = useMemo(() => {
    const map: Record<
      string,
      {
        productName: string;
        packsCash: number;
        packsCredit: number;
        salesCash: number;
        salesCredit: number;
        commCash: number;
        commCredit: number;
      }
    > = {};

    for (const r of detailRows) {
      const k = r.productName || "(sin nombre)";
      if (!map[k]) {
        map[k] = {
          productName: k,
          packsCash: 0,
          packsCredit: 0,
          salesCash: 0,
          salesCredit: 0,
          commCash: 0,
          commCredit: 0,
        };
      }
      if (r.type === "CREDITO") {
        map[k].packsCredit += Number(r.packages || 0);
        map[k].salesCredit += Number(r.amount || 0);
        map[k].commCredit += Number(r.commission || 0);
      } else {
        map[k].packsCash += Number(r.packages || 0);
        map[k].salesCash += Number(r.amount || 0);
        map[k].commCash += Number(r.commission || 0);
      }
    }

    return Object.values(map)
      .map((x) => ({
        ...x,
        packsCash: round3(x.packsCash),
        packsCredit: round3(x.packsCredit),
        salesCash: round2(x.salesCash),
        salesCredit: round2(x.salesCredit),
        commCash: round2(x.commCash),
        commCredit: round2(x.commCredit),
      }))
      .sort(
        (a, b) => b.salesCash + b.salesCredit - (a.salesCash + a.salesCredit)
      );
  }, [detailRows]);

  const arSummary = useMemo(() => {
    const byCustomer: Record<
      string,
      { customerId: string; name: string; balance: number; lastPayment: string }
    > = {};

    const nameOf = (id: string) => (customersMap[id] || "").trim() || id;

    for (const m of movements) {
      const cid = String(m.customerId || "").trim();
      if (!cid) continue;
      const d = String(m.date || "");
      if (d && d > endDate) continue;

      if (!byCustomer[cid]) {
        byCustomer[cid] = {
          customerId: cid,
          name: nameOf(cid),
          balance: 0,
          lastPayment: "",
        };
      }

      const amt = Number(m.amount || 0);
      if (m.type === "CARGO") byCustomer[cid].balance += amt;
      if (m.type === "ABONO") {
        byCustomer[cid].balance -= amt;
        if (!byCustomer[cid].lastPayment || d > byCustomer[cid].lastPayment) {
          byCustomer[cid].lastPayment = d;
        }
      }
    }

    const list = Object.values(byCustomer)
      .map((x) => ({ ...x, balance: round2(x.balance) }))
      .filter((x) => x.balance > 0)
      .sort((a, b) => b.balance - a.balance);

    const totalPending = round2(list.reduce((s, x) => s + x.balance, 0));

    return { count: list.length, totalPending, list: list.slice(0, 20) };
  }, [movements, customersMap, endDate]);

  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;
    pdfRef.current.classList.add("force-pdf-colors");
    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`data_center_dulces_${startDate}_a_${endDate}.pdf`);
    } finally {
      pdfRef.current.classList.remove("force-pdf-colors");
    }
  };

  const exportCSV = () => {
    const headers = [
      "date",
      "processedDate",
      "status",
      "type",
      "vendorId",
      "vendorName",
      "branch",
      "productName",
      "packages",
      "amount",
      "commission",
      "customerId",
      "customerName",
    ];

    const lines = [
      headers.join(","),
      ...filteredRows.map((r) =>
        [
          r.date,
          r.processedDate || "",
          r.status,
          r.type,
          r.vendorId,
          `"${String(r.vendorName || "").replace(/"/g, '""')}"`,
          r.branch || "",
          `"${String(r.productName || "").replace(/"/g, '""')}"`,
          qty3(r.packages),
          money(r.amount),
          money(r.commission),
          r.customerId || "",
          `"${String(displayCustomerName(r) || "").replace(/"/g, '""')}"`,
        ].join(",")
      ),
    ];

    const blob = new Blob([lines.join("\n")], {
      type: "text/csv;charset=utf-8;",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `data_center_dulces_${startDate}_a_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (!isAdmin) {
    return (
      <div className="max-w-5xl mx-auto p-3 sm:p-4 md:p-6 bg-white rounded-2xl shadow-2xl">
        <h2 className="text-lg md:text-xl font-bold">Data Center - Dulces</h2>
        <p className="text-sm text-gray-600 mt-2">No autorizado.</p>
      </div>
    );
  }

  // ======================
  //  DATA MACRO (KPIs)
  // ======================
  const macro = useMemo(() => {
    const ingreso = round2(kpis.salesTotal);
    const comision = round2(kpis.commCash + kpis.commCredit);

    // Margen % estimado desde órdenes maestras (gross / expected)
    // Si no hay data, margen 0 para no inventar.
    const expectedTotal = Number(expectedAndGross.expectedTotal || 0);
    const grossTotal = Number(expectedAndGross.grossTotal || 0);
    const marginPct =
      expectedTotal > 0
        ? Math.max(0, Math.min(1, grossTotal / expectedTotal))
        : 0;

    // Costo estimado vendido = ingreso * (1 - margen)
    // (Esto es estimación basada en tus órdenes maestras, porque tus ventas no traen costo unitario real por línea)
    const costoProducto = round2(ingreso * (1 - marginPct));

    const gastos = (() => {
      const x = Number(otherExpenses || 0);
      return Number.isFinite(x) ? round2(Math.max(0, x)) : 0;
    })();

    const gananciaBruta = round2(ingreso - costoProducto);
    const gananciaNeta = round2(gananciaBruta - comision - gastos);

    return {
      ingreso,
      costoProducto,
      gananciaBruta,
      comision,
      gastos,
      gananciaNeta,
      marginPct,
      hasEstimation: expectedTotal > 0,
    };
  }, [kpis, expectedAndGross, otherExpenses]);

  // ======================
  //  SERIES para gráficas
  // ======================
  const seriesByDay = useMemo(() => {
    const map: Record<
      string,
      { date: string; ingreso: number; comision: number }
    > = {};
    for (const r of filteredRows) {
      const d = r.date;
      if (!d) continue;
      if (!map[d]) map[d] = { date: d, ingreso: 0, comision: 0 };
      map[d].ingreso += Number(r.amount || 0);
      map[d].comision += Number(r.commission || 0);
    }

    const dates = Object.keys(map).sort((a, b) => (a < b ? -1 : 1));
    const totalIngreso = dates.reduce((s, d) => s + map[d].ingreso, 0) || 1;

    // Distribución proporcional de gastos a nivel día (según ingreso del día)
    const gastos = Number(macro.gastos || 0);

    // Costo estimado proporcional a ingreso del día
    const costoTotal = Number(macro.costoProducto || 0);
    const comisionTotal = Number(macro.comision || 0);

    const seriesIngreso = dates.map((d) => ({
      label: d.slice(5), // MM-dd para compacto
      value: round2(map[d].ingreso),
    }));

    const seriesNeta = dates.map((d) => {
      const ingresoDia = map[d].ingreso;
      const share = ingresoDia / totalIngreso;

      const costoDia = costoTotal * share;
      const comDia = comisionTotal * share; // comisiones ya vienen por día, pero mantenemos consistencia proporcional
      const gastosDia = gastos * share;

      const netaDia = ingresoDia - costoDia - comDia - gastosDia;
      return {
        label: d.slice(5),
        value: round2(netaDia),
      };
    });

    return { seriesIngreso, seriesNeta, datesCount: dates.length };
  }, [filteredRows, macro]);

  const pieSalesByBranch = useMemo(() => {
    return [
      { label: "Rivas", value: Number(actualByBranch.RIVAS.sales || 0) },
      {
        label: "San Jorge",
        value: Number(actualByBranch.SAN_JORGE.sales || 0),
      },
      { label: "Isla", value: Number(actualByBranch.ISLA.sales || 0) },
    ].map((x) => ({ ...x, value: round2(x.value) }));
  }, [actualByBranch]);

  return (
    <div className="max-w-7xl mx-auto px-2 sm:px-4 md:px-0">
      <div className="bg-white p-3 sm:p-4 md:p-6 rounded-2xl shadow-2xl">
        {/* HEADER (mobile-first) */}
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between mb-4">
          <h2 className="text-lg sm:text-xl md:text-2xl font-bold">
            Data Center - Dulces
          </h2>

          <div className="flex flex-col sm:flex-row gap-2 sm:items-center sm:justify-end">
            <button
              onClick={handleDownloadPDF}
              className="
                inline-flex items-center justify-center gap-2
                w-full sm:w-auto
                px-3 py-2 text-sm font-semibold
                rounded-lg md:rounded-md
                bg-green-600 text-white hover:bg-green-700 transition-colors
              "
            >
              Exportar PDF
            </button>

            <button
              onClick={exportCSV}
              className="
                inline-flex items-center justify-center gap-2
                w-full sm:w-auto
                px-3 py-2 text-sm font-semibold
                rounded-lg md:rounded-md
                bg-gray-800 text-white hover:bg-black transition-colors
              "
            >
              Exportar CSV
            </button>
          </div>
        </div>

        {/* FILTROS (mobile-first) */}
        <div className="rounded-2xl border border-gray-100 p-3 sm:p-4 mb-3 shadow-sm bg-white">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
            <div>
              <label className="block text-xs text-gray-600">Desde</label>
              <input
                type="date"
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600">Hasta</label>
              <input
                type="date"
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600">Estado</label>
              <select
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as any)}
              >
                <option value="TODAS">Todas</option>
                <option value="FLOTANTE">Flotante</option>
                <option value="PROCESADA">Procesada</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-600">Tipo</label>
              <select
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={typeFilter}
                onChange={(e) => setTypeFilter(e.target.value as any)}
              >
                <option value="AMBAS">Ambas</option>
                <option value="CASH">Cash</option>
                <option value="CREDITO">Crédito</option>
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-600">Vendedor</label>
              <select
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={vendorFilter}
                onChange={(e) => setVendorFilter(e.target.value)}
              >
                <option value="ALL">Todos</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name || s.id}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-xs text-gray-600">Sucursal</label>
              <select
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={branchFilter}
                onChange={(e) => setBranchFilter(e.target.value as any)}
              >
                <option value="ALL">Todas</option>
                <option value="RIVAS">Rivas</option>
                <option value="SAN_JORGE">San Jorge</option>
                <option value="ISLA">Isla</option>
              </select>
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-xs text-gray-600">
                Producto (opcional)
              </label>
              <input
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
                placeholder="Ej: Conitos"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-3">
              <label className="block text-xs text-gray-600">
                Cliente (opcional)
              </label>
              <input
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={customerFilter}
                onChange={(e) => setCustomerFilter(e.target.value)}
                placeholder="Ej: Javier"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600">Monto min</label>
              <input
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={minAmount}
                onChange={(e) => setMinAmount(e.target.value)}
                placeholder="0"
              />
            </div>

            <div>
              <label className="block text-xs text-gray-600">Monto max</label>
              <input
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={maxAmount}
                onChange={(e) => setMaxAmount(e.target.value)}
                placeholder="999999"
              />
            </div>

            <div className="sm:col-span-2 lg:col-span-2">
              <label className="block text-xs text-gray-600">Agrupar por</label>
              <select
                className="border rounded-lg px-3 py-2 w-full text-sm"
                value={groupBy}
                onChange={(e) => {
                  setDetailKey("");
                  setGroupBy(e.target.value as any);
                }}
              >
                <option value="DIA">Día</option>
                <option value="VENDEDOR">Vendedor</option>
                <option value="PRODUCTO">Producto</option>
                <option value="SUCURSAL">Sucursal</option>
              </select>
            </div>
          </div>
        </div>

        {/* CHIPS/TABS (debajo de filtros, arriba de KPIs) */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => setDataView("MACRO")}
              className={[
                "px-3 py-2 rounded-full text-sm font-semibold border transition-colors",
                dataView === "MACRO"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-800 border-gray-200 hover:bg-gray-50",
              ].join(" ")}
            >
              Data Macro
            </button>
            <button
              onClick={() => setDataView("DETALLE")}
              className={[
                "px-3 py-2 rounded-full text-sm font-semibold border transition-colors",
                dataView === "DETALLE"
                  ? "bg-gray-900 text-white border-gray-900"
                  : "bg-white text-gray-800 border-gray-200 hover:bg-gray-50",
              ].join(" ")}
            >
              Data Detalle
            </button>
          </div>

          {/* Gastos período (solo relevante en Macro, pero lo dejamos visible siempre por simplicidad) */}
          <div className="flex flex-col sm:flex-row gap-2 sm:items-center">
            <div className="text-xs text-gray-600">
              Gastos del período (manual)
            </div>
            <input
              value={otherExpenses}
              onChange={(e) => setOtherExpenses(e.target.value)}
              className="border rounded-lg px-3 py-2 w-full sm:w-56 text-sm"
              placeholder="0"
              inputMode="decimal"
            />
          </div>
        </div>

        {/* CONTENIDO PDF */}
        <div ref={pdfRef}>
          {/* =======================
              DATA MACRO (nuevo)
             ======================= */}
          {dataView === "MACRO" && (
            <>
              {/* KPIs Macro */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Ingreso (ventas)</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(macro.ingreso)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Costo producto{" "}
                    <span className="text-gray-400">(estimado)</span>
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    -C${money(macro.costoProducto)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Margen ref:{" "}
                    <strong>
                      {macro.hasEstimation
                        ? (macro.marginPct * 100).toFixed(1)
                        : "0.0"}
                      %
                    </strong>{" "}
                    (órdenes maestras)
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Ganancia bruta</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(macro.gananciaBruta)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Ingreso − Costo producto
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Comisión vendedor</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    -C${money(macro.comision)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Cash: C${money(kpis.commCash)} • Crédito: C$
                    {money(kpis.commCredit)}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Ganancia neta</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(macro.gananciaNeta)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Bruta − Comisiones − Gastos
                  </div>
                </div>
              </div>

              {/* Nota de estimación */}
              <div className="border rounded-2xl p-3 sm:p-4 mb-4 bg-white border-gray-100 shadow-sm">
                <div className="text-sm font-semibold">Notas rápidas</div>
                <ul className="text-xs text-gray-600 mt-2 space-y-1 list-disc pl-4">
                  <li>
                    <strong>Costo producto</strong> se muestra como{" "}
                    <strong>estimado</strong> porque tus ventas no traen el
                    costo real por línea (COGS). Se calcula usando el margen de{" "}
                    <strong>órdenes maestras</strong>.
                  </li>
                  <li>
                    <strong>Gastos del período</strong> es un campo manual para
                    que puedas incluir transporte, bolsas, pagos, etc. (si no
                    aplica, dejalo en 0).
                  </li>
                </ul>
              </div>

              {/* Gráficas: 2 líneas + 1 pastel */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
                <LineChartSimple
                  title="Ventas por día (Ingreso)"
                  series={seriesByDay.seriesIngreso}
                  valuePrefix="C$"
                />
                <LineChartSimple
                  title="Ganancia neta estimada por día"
                  series={seriesByDay.seriesNeta}
                  valuePrefix="C$"
                />
              </div>

              <div className="mb-6">
                <PieChartSimple
                  title="Distribución de ventas por sucursal"
                  items={pieSalesByBranch}
                />
              </div>
            </>
          )}

          {/* =======================
              DATA DETALLE (existente)
             ======================= */}
          {dataView === "DETALLE" && (
            <>
              {/* KPIs (mobile-first) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Paquetes cash</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(kpis.packsCash)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Paquetes crédito</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(kpis.packsCredit)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Ventas totales</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(kpis.salesTotal)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Cash: C${money(kpis.salesCash)} • Crédito: C$
                    {money(kpis.salesCredit)}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Comisión</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(kpis.commCash + kpis.commCredit)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Cash: C${money(kpis.commCash)} • Crédito: C$
                    {money(kpis.commCredit)}
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Gross Profit total (órdenes maestras)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(expectedAndGross.grossTotal)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    R: {money(expectedAndGross.grossRivas)} • SJ:{" "}
                    {money(expectedAndGross.grossSanJorge)} • I:{" "}
                    {money(expectedAndGross.grossIsla)}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Expected Total (Rivas/SJ/Isla)
                  </div>
                  <div className="text-sm mt-2 space-y-1">
                    <div className="flex justify-between">
                      <span>Rivas</span>
                      <strong>C${money(expectedAndGross.expectedRivas)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>San Jorge</span>
                      <strong>
                        C${money(expectedAndGross.expectedSanJorge)}
                      </strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Isla</span>
                      <strong>C${money(expectedAndGross.expectedIsla)}</strong>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Actual ventas por sucursal
                  </div>
                  <div className="text-sm mt-2 space-y-1">
                    <div className="flex justify-between">
                      <span>Rivas</span>
                      <strong>C${money(actualByBranch.RIVAS.sales)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>San Jorge</span>
                      <strong>C${money(actualByBranch.SAN_JORGE.sales)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Isla</span>
                      <strong>C${money(actualByBranch.ISLA.sales)}</strong>
                    </div>
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Diferencia vs expected
                  </div>
                  <div className="text-sm mt-2 space-y-1">
                    <div className="flex justify-between">
                      <span>Rivas</span>
                      <strong>C${money(diffVsExpected.RIVAS)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>San Jorge</span>
                      <strong>C${money(diffVsExpected.SAN_JORGE)}</strong>
                    </div>
                    <div className="flex justify-between">
                      <span>Isla</span>
                      <strong>C${money(diffVsExpected.ISLA)}</strong>
                    </div>
                  </div>
                </div>
              </div>

              {/* NUEVOS KPIs pedidos */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total facturado a precio proveedor (órdenes maestras)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(providerAndPackagesKpis.providerTotalMaster)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total facturado a precio proveedor (órdenes vendedor)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(providerAndPackagesKpis.providerTotalVendor)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes ordenados (maestras)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(providerAndPackagesKpis.orderedPacksMaster)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Restantes (período):{" "}
                    <strong>
                      {qty3(providerAndPackagesKpis.remainingPacksMaster)}
                    </strong>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Existencia global (todas):{" "}
                    <strong>
                      {qty3(globalStockKpis.masterRemainingPackages)}
                    </strong>
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes ordenados (órdenes vendedor)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(providerAndPackagesKpis.orderedPacksVendor)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Restantes (período):{" "}
                    <strong>
                      {qty3(providerAndPackagesKpis.remainingPacksVendor)}
                    </strong>
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Existencia global (todas):{" "}
                    <strong>
                      {qty3(globalStockKpis.vendorRemainingPackages)}
                    </strong>
                  </div>
                </div>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes ordenados por vendedor (período)
                  </div>
                  {providerAndPackagesKpis.vendorRowsOrdered.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                      {providerAndPackagesKpis.vendorRowsOrdered.map((v) => (
                        <div
                          key={v.sellerId}
                          className="flex justify-between text-sm"
                        >
                          <span className="truncate">{v.sellerName}</span>
                          <strong className="ml-2">{qty3(v.ordered)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes existentes por vendedor (período)
                  </div>
                  {providerAndPackagesKpis.vendorRowsRemaining.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                      {providerAndPackagesKpis.vendorRowsRemaining.map((v) => (
                        <div
                          key={v.sellerId}
                          className="flex justify-between text-sm"
                        >
                          <span className="truncate">{v.sellerName}</span>
                          <strong className="ml-2">{qty3(v.remaining)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* KPI vendedores comisión */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Vendedores (comisión cash)
                  </div>
                  {vendorsKpi.cashArr.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                      {vendorsKpi.cashArr.map((v) => (
                        <div
                          key={v.vendorId}
                          className="flex justify-between text-sm"
                        >
                          <span className="truncate">{v.name}</span>
                          <strong className="ml-2">C${money(v.total)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Vendedores (comisión crédito)
                  </div>
                  {vendorsKpi.creditArr.length === 0 ? (
                    <div className="text-sm text-gray-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-40 overflow-auto pr-1">
                      {vendorsKpi.creditArr.map((v) => (
                        <div
                          key={v.vendorId}
                          className="flex justify-between text-sm"
                        >
                          <span className="truncate">{v.name}</span>
                          <strong className="ml-2">C${money(v.total)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              {/* CARTERA */}
              <div className="border rounded-2xl p-3 sm:p-4 mb-6 shadow-sm bg-white border-gray-100">
                <h3 className="font-semibold mb-2 text-sm sm:text-base">
                  Cartera (saldo pendiente hasta {endDate})
                </h3>

                <div className="grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm mb-3">
                  <div>
                    Clientes con saldo: <strong>{arSummary.count}</strong>
                  </div>
                  <div>
                    Saldo total pendiente:{" "}
                    <strong>C${money(arSummary.totalPending)}</strong>
                  </div>
                  <div className="text-gray-500">*Muestra top 20 por monto</div>
                </div>

                {arSummary.list.length === 0 ? (
                  <div className="text-sm text-gray-500">—</div>
                ) : (
                  <>
                    {/* MOBILE: cards */}
                    <div className="md:hidden space-y-2">
                      {arSummary.list.map((c) => (
                        <div
                          key={c.customerId}
                          className="border rounded-xl p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold truncate">
                              {c.name}
                            </div>
                            <div className="text-sm font-bold whitespace-nowrap">
                              C${money(c.balance)}
                            </div>
                          </div>
                          <div className="text-xs text-gray-600 mt-1">
                            Último abono:{" "}
                            <span className="font-medium">
                              {c.lastPayment || "—"}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* DESKTOP: tabla */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="min-w-full border text-sm">
                        <thead className="bg-gray-100">
                          <tr>
                            <th className="border p-2 text-left">Cliente</th>
                            <th className="border p-2">Saldo</th>
                            <th className="border p-2">Último abono</th>
                          </tr>
                        </thead>
                        <tbody>
                          {arSummary.list.map((c) => (
                            <tr key={c.customerId} className="text-center">
                              <td className="border p-2 text-left">{c.name}</td>
                              <td className="border p-2">
                                C${money(c.balance)}
                              </td>
                              <td className="border p-2">
                                {c.lastPayment || "—"}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </>
                )}
              </div>

              {/* TABLA PRINCIPAL */}
              <div className="mb-3 flex flex-col sm:flex-row sm:items-center gap-2">
                <h3 className="font-semibold text-sm sm:text-base">
                  Tabla principal (Agrupar por: {groupBy})
                </h3>
                <span className="text-xs text-gray-500 sm:ml-auto">
                  Tap/Click en “Ver detalle” para drill-down
                </span>
              </div>

              {loading ? (
                <p className="text-sm">Cargando...</p>
              ) : (
                <>
                  {/* MOBILE: cards para evitar scroll horizontal */}
                  <div className="md:hidden space-y-2 mb-6">
                    {grouped.length === 0 ? (
                      <div className="border rounded-xl p-3 text-center text-gray-500">
                        Sin datos con los filtros seleccionados.
                      </div>
                    ) : (
                      grouped.map((g) => (
                        <div
                          key={g.key}
                          className="border rounded-2xl p-3 shadow-sm bg-white"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold truncate">
                              {g.label}
                            </div>
                            <button
                              className="px-3 py-2 rounded-lg bg-gray-800 text-white text-sm font-semibold"
                              onClick={() => setDetailKey(g.key)}
                            >
                              Ver detalle
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Paquetes cash
                              </div>
                              <div className="font-bold">
                                {qty3(g.packsCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Paquetes crédito
                              </div>
                              <div className="font-bold">
                                {qty3(g.packsCredit)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Ventas cash
                              </div>
                              <div className="font-bold">
                                C${money(g.salesCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Ventas crédito
                              </div>
                              <div className="font-bold">
                                C${money(g.salesCredit)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Comisión cash
                              </div>
                              <div className="font-bold">
                                C${money(g.commCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Comisión crédito
                              </div>
                              <div className="font-bold">
                                C${money(g.commCredit)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* DESKTOP: tabla */}
                  <div className="hidden md:block overflow-x-auto mb-6 shadow-2xl rounded-xl border">
                    <table className="min-w-full border text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="border p-2 text-left">
                            {groupBy === "DIA"
                              ? "Día"
                              : groupBy === "VENDEDOR"
                              ? "Vendedor"
                              : groupBy === "PRODUCTO"
                              ? "Producto"
                              : "Sucursal"}
                          </th>
                          <th className="border p-2">Paquetes cash</th>
                          <th className="border p-2">Paquetes crédito</th>
                          <th className="border p-2">Ventas cash</th>
                          <th className="border p-2">Ventas crédito</th>
                          <th className="border p-2">Comisión cash</th>
                          <th className="border p-2">Comisión crédito</th>
                          <th className="border p-2">Opciones</th>
                        </tr>
                      </thead>
                      <tbody>
                        {grouped.map((g) => (
                          <tr key={g.key} className="text-center">
                            <td className="border p-2 text-left">{g.label}</td>
                            <td className="border p-2">{qty3(g.packsCash)}</td>
                            <td className="border p-2">
                              {qty3(g.packsCredit)}
                            </td>
                            <td className="border p-2">
                              C${money(g.salesCash)}
                            </td>
                            <td className="border p-2">
                              C${money(g.salesCredit)}
                            </td>
                            <td className="border p-2">
                              C${money(g.commCash)}
                            </td>
                            <td className="border p-2">
                              C${money(g.commCredit)}
                            </td>
                            <td className="border p-2">
                              <button
                                className="text-xs bg-gray-800 text-white px-3 py-2 rounded-lg hover:bg-black"
                                onClick={() => setDetailKey(g.key)}
                              >
                                Ver detalle
                              </button>
                            </td>
                          </tr>
                        ))}
                        {grouped.length === 0 && (
                          <tr>
                            <td
                              colSpan={8}
                              className="p-4 text-center text-gray-500"
                            >
                              Sin datos con los filtros seleccionados.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              {/* DRILL-DOWN */}
              {detailKey && (
                <div className="rounded-2xl shadow-lg p-3 sm:p-4 bg-white border-solid border-2 border-gray-100">
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
                    <h2 className="text-base sm:text-xl font-semibold truncate">
                      Detalle •{" "}
                      {grouped.find((x) => x.key === detailKey)?.label ||
                        detailKey}
                    </h2>

                    <button
                      onClick={() => setDetailKey("")}
                      className="
                        w-full sm:w-auto
                        text-sm px-3 py-2 border rounded-lg
                        hover:bg-gray-50
                      "
                    >
                      Cerrar
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2 text-sm mb-4">
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total Ventas cash:{" "}
                      <strong>
                        C$
                        {money(
                          detailRows
                            .filter((r) => r.type === "CONTADO")
                            .reduce((s, r) => s + Number(r.amount || 0), 0)
                        )}
                      </strong>
                    </div>
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total Ventas crédito:{" "}
                      <strong>
                        C$
                        {money(
                          detailRows
                            .filter((r) => r.type === "CREDITO")
                            .reduce((s, r) => s + Number(r.amount || 0), 0)
                        )}
                      </strong>
                    </div>
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total paquetes cash:{" "}
                      <strong>
                        {qty3(
                          detailRows
                            .filter((r) => r.type === "CONTADO")
                            .reduce((s, r) => s + Number(r.packages || 0), 0)
                        )}
                      </strong>
                    </div>
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total paquetes crédito:{" "}
                      <strong>
                        {qty3(
                          detailRows
                            .filter((r) => r.type === "CREDITO")
                            .reduce((s, r) => s + Number(r.packages || 0), 0)
                        )}
                      </strong>
                    </div>
                  </div>

                  <h3 className="font-semibold mb-2 text-sm sm:text-base">
                    Ventas incluidas
                  </h3>

                  {/* MOBILE: cards */}
                  <div className="md:hidden space-y-2 mb-4">
                    {detailRows.length === 0 ? (
                      <div className="border rounded-xl p-3 text-center text-gray-500">
                        Sin detalle.
                      </div>
                    ) : (
                      detailRows.map((r) => (
                        <div key={r.id} className="border rounded-2xl p-3">
                          <div className="flex items-start justify-between gap-2">
                            <div className="font-semibold truncate">
                              {r.productName}
                            </div>
                            <div className="text-sm font-bold whitespace-nowrap">
                              C${money(r.amount)}
                            </div>
                          </div>

                          <div className="text-xs text-gray-600 mt-1">
                            Vendedor:{" "}
                            <span className="font-medium">{r.vendorName}</span>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">Tipo</div>
                              <div className="font-bold">
                                {r.type === "CREDITO" ? "Crédito" : "Cash"}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Sucursal
                              </div>
                              <div className="font-bold">{r.branch || "—"}</div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Paquetes
                              </div>
                              <div className="font-bold">
                                {qty3(r.packages)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Comisión
                              </div>
                              <div className="font-bold">
                                C${money(r.commission)}
                              </div>
                            </div>
                          </div>

                          <div className="text-xs text-gray-500 mt-2">
                            Fecha: {r.date}
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* DESKTOP: tabla */}
                  <div className="hidden md:block overflow-x-auto mb-4">
                    <table className="min-w-full border text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="border p-2">Vendedor</th>
                          <th className="border p-2">Producto</th>
                          <th className="border p-2">Tipo</th>
                          <th className="border p-2">Sucursal</th>
                          <th className="border p-2">Paquetes</th>
                          <th className="border p-2">Monto</th>
                          <th className="border p-2">Comisión</th>
                          <th className="border p-2">Fecha venta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailRows.map((r) => (
                          <tr key={r.id} className="text-center">
                            <td className="border p-2">{r.vendorName}</td>
                            <td className="border p-2">{r.productName}</td>
                            <td className="border p-2">
                              {r.type === "CREDITO" ? "Crédito" : "Cash"}
                            </td>
                            <td className="border p-2">{r.branch || "—"}</td>
                            <td className="border p-2">{qty3(r.packages)}</td>
                            <td className="border p-2">C${money(r.amount)}</td>
                            <td className="border p-2">
                              C${money(r.commission)}
                            </td>
                            <td className="border p-2">{r.date}</td>
                          </tr>
                        ))}
                        {detailRows.length === 0 && (
                          <tr>
                            <td
                              colSpan={8}
                              className="p-4 text-center text-gray-500"
                            >
                              Sin detalle.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <h3 className="font-semibold mb-2 text-sm sm:text-base">
                    Consolidado por producto
                  </h3>

                  {/* MOBILE: cards */}
                  <div className="md:hidden space-y-2">
                    {detailProductSummary.length === 0 ? (
                      <div className="border rounded-xl p-3 text-center text-gray-500">
                        Sin consolidado.
                      </div>
                    ) : (
                      detailProductSummary.map((p) => (
                        <div
                          key={p.productName}
                          className="border rounded-2xl p-3"
                        >
                          <div className="font-semibold">{p.productName}</div>
                          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Paq cash
                              </div>
                              <div className="font-bold">
                                {qty3(p.packsCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Paq crédito
                              </div>
                              <div className="font-bold">
                                {qty3(p.packsCredit)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Ventas cash
                              </div>
                              <div className="font-bold">
                                C${money(p.salesCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Ventas crédito
                              </div>
                              <div className="font-bold">
                                C${money(p.salesCredit)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Com cash
                              </div>
                              <div className="font-bold">
                                C${money(p.commCash)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Com crédito
                              </div>
                              <div className="font-bold">
                                C${money(p.commCredit)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* DESKTOP: tabla */}
                  <div className="hidden md:block overflow-x-auto">
                    <table className="min-w-full border text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="border p-2">Producto</th>
                          <th className="border p-2">Total paquetes cash</th>
                          <th className="border p-2">Total paquetes crédito</th>
                          <th className="border p-2">Ventas cash</th>
                          <th className="border p-2">Ventas crédito</th>
                          <th className="border p-2">Comisión cash</th>
                          <th className="border p-2">Comisión crédito</th>
                        </tr>
                      </thead>
                      <tbody>
                        {detailProductSummary.map((p) => (
                          <tr key={p.productName} className="text-center">
                            <td className="border p-2 text-left">
                              {p.productName}
                            </td>
                            <td className="border p-2">{qty3(p.packsCash)}</td>
                            <td className="border p-2">
                              {qty3(p.packsCredit)}
                            </td>
                            <td className="border p-2">
                              C${money(p.salesCash)}
                            </td>
                            <td className="border p-2">
                              C${money(p.salesCredit)}
                            </td>
                            <td className="border p-2">
                              C${money(p.commCash)}
                            </td>
                            <td className="border p-2">
                              C${money(p.commCredit)}
                            </td>
                          </tr>
                        ))}
                        {detailProductSummary.length === 0 && (
                          <tr>
                            <td
                              colSpan={7}
                              className="p-4 text-center text-gray-500"
                            >
                              Sin consolidado.
                            </td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        {message && <p className="mt-3 text-sm">{message}</p>}
      </div>
    </div>
  );
}
