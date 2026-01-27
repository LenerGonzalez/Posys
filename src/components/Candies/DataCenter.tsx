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
import { hasRole } from "../../utils/roles";
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

const safeNum = (v: any) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

const normalizeDateKey = (value: any) => {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const m = raw.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  return raw;
};

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

          <text x={8} y={padT + 10} fontSize="12" fill="#6b7280">
            {valuePrefix}
            {money(maxV)}
          </text>
          <text x={8} y={padT + innerH} fontSize="12" fill="#6b7280">
            {valuePrefix}
            {money(minV)}
          </text>

          <path d={path} fill="none" stroke="#111827" strokeWidth="2.5" />

          {points.map((p, idx) => (
            <circle key={idx} cx={p.x} cy={p.y} r="3.5" fill="#111827" />
          ))}

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
    raw.processedDate ?? raw.closureDate ?? "",
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
      raw.total ?? raw.itemsTotal ?? raw.amount ?? raw.amountCharged ?? 0,
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
            Number(it?.discount || 0),
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

type VendorPriceCatalog = Record<
  string,
  {
    unitPriceRivas: number;
    unitPriceSanJorge: number;
    unitPriceIsla: number;
    key: string;
  }
>;

type VendorOrderLineDoc = {
  id: string;

  // agrupación
  orderId?: string; // ORD-...
  date?: string;

  // vendedor
  sellerId?: string;
  sellerName?: string;

  // producto (en tu colección normalmente existe)
  productId?: string;
  productName?: string;
  category?: string;

  // cantidades
  packages?: number;
  remainingPackages?: number;
  totalUnits?: number;
  remainingUnits?: number;
  unitsPerPackage?: number;

  // valores
  subtotal?: number; // proveedor (costo)
  totalVendor?: number; // total al precio de venta (si existe)
  unitPriceVendor?: number; // precio unitario de venta (si existe)

  // por sucursal (a veces existen)
  totalRivas?: number;
  totalSanJorge?: number;
  totalIsla?: number;
};

type CustomerDoc = {
  id: string;
  name?: string;
  initialDebt?: number;
  initialDebtDate?: string;
};

type ARMovement = {
  id: string;
  customerId?: string;
  date?: string; // "yyyy-MM-dd"
  amount?: number;
  type?: "CARGO" | "ABONO";
  ref?: { saleId?: string };
};

type ARCustomerRow = {
  customerId: string;
  name: string;
  balance: number;
  lastPayment: string;
  lastPaymentAmount: number;
};

type ExpenseCandy = {
  id: string;
  date?: string; // yyyy-MM-dd
  amount?: number;
  description?: string;
  category?: string;
};

export default function DataCenterCandies({
  role,
  roles,
}: {
  role?: string;
  roles?: string[];
}): React.ReactElement {
  const subject = roles && roles.length ? roles : role;
  const isAdmin = !subject || hasRole(subject, "admin");

  const today = format(new Date(), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(today);

  const [statusFilter, setStatusFilter] = useState<"TODAS" | SaleStatus>(
    "TODAS",
  );
  const [typeFilter, setTypeFilter] = useState<"AMBAS" | "CASH" | "CREDITO">(
    "AMBAS",
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
  const [vendorPriceCatalog, setVendorPriceCatalog] =
    useState<VendorPriceCatalog>({});
  const [vendorOrdersLines, setVendorOrdersLines] = useState<
    VendorOrderLineDoc[]
  >([]);
  const [customers, setCustomers] = useState<CustomerDoc[]>([]);
  const [movements, setMovements] = useState<ARMovement[]>([]);
  const [expenses, setExpenses] = useState<ExpenseCandy[]>([]);

  const [allMasterInventory, setAllMasterInventory] = useState<any[]>([]);
  const [allVendorInventory, setAllVendorInventory] = useState<any[]>([]);

  const [detailKey, setDetailKey] = useState<string>("");
  const [vendorOrderKey, setVendorOrderKey] = useState<string>(""); // ✅ detalle por orden de vendedor
  const [arOpen, setArOpen] = useState<ARCustomerRow | null>(null);
  const pdfRef = useRef<HTMLDivElement>(null);

  const [invCandiesAll, setInvCandiesAll] = useState<any[]>([]);

  const [dataView, setDataView] = useState<"MACRO" | "DETALLE">("DETALLE");

  const customersMap = useMemo(() => {
    const map: Record<string, string> = {};
    customers.forEach((c) => (map[c.id] = String(c.name || "").trim()));
    return map;
  }, [customers]);

  const sellersMap = useMemo(() => {
    const map: Record<string, SellerCandy> = {};
    sellers.forEach((s) => (map[s.id] = s));
    return map;
  }, [sellers]);

  const displayCustomerName = (r: SaleRow) => {
    const byId = r.customerId ? customersMap[r.customerId] : "";
    const name = (r.customerName || byId || "").trim();
    return (
      name ||
      (r.customerId ? customersMap[r.customerId] || r.customerId : "") ||
      ""
    );
  };

  // ==========================
  //  CARGAS (sin tocar lo que funciona)
  // ==========================

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
          Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name)),
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
      orderBy("date", "asc"),
    );

    const unsub = onSnapshot(
      qSales,
      (snap) => {
        const rows: SaleRow[] = [];
        snap.forEach((d) =>
          rows.push(...normalizeSalesMany(d.data() as SaleDataRaw, d.id)),
        );
        setSalesRows(rows);
        setLoading(false);
      },
      (err) => {
        console.error("sales_candies periodo error:", err);
        setSalesRows([]);
        setLoading(false);
        setMessage(
          "❌ Error cargando ventas del período (revisá índices si aplica).",
        );
      },
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
          where("date", "<=", endDate),
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

  // --- catálogo de precios (candy_main_orders completo, último precio por producto) ---
  useEffect(() => {
    if (!isAdmin) return;

    const fetchVendorPriceCatalog = async () => {
      try {
        const snap = await getDocs(
          query(
            collection(db, "candy_main_orders"),
            orderBy("createdAt", "desc"),
          ),
        );

        const pick: VendorPriceCatalog = {};

        const makeKey = (dateStr: string, createdAtSec: number) =>
          `${dateStr}#${String(createdAtSec).padStart(10, "0")}`;

        snap.forEach((d) => {
          const x = d.data() as any;
          const createdAtSec = Number(x.createdAt?.seconds ?? 0);
          const dateStr = String(x.date || "");
          const key = makeKey(dateStr, createdAtSec);

          const items = Array.isArray(x.items) ? x.items : [];
          for (const it of items) {
            const pid = String(it.id || it.productId || "");
            if (!pid) continue;

            const cand = {
              unitPriceRivas: Number(it.unitPriceRivas || 0),
              unitPriceSanJorge: Number(it.unitPriceSanJorge || 0),
              unitPriceIsla: Number(it.unitPriceIsla || 0),
              key,
            };

            const prev = pick[pid];
            if (!prev || cand.key > prev.key) pick[pid] = cand;
          }
        });

        setVendorPriceCatalog(pick);
      } catch (e) {
        console.error("candy_main_orders catalog error:", e);
        setVendorPriceCatalog({});
      }
    };

    fetchVendorPriceCatalog();
  }, [isAdmin]);

  // --- inventory_candies_sellers periodo (líneas de órdenes vendedor) ---
  useEffect(() => {
    if (!isAdmin) return;

    const qy = query(
      collection(db, "inventory_candies_sellers"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
    );

    const unsub = onSnapshot(
      qy,
      (snap) => {
        const rows: VendorOrderLineDoc[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setVendorOrdersLines(rows);
      },
      (err) => {
        console.error("inventory_candies_sellers error:", err);
        setVendorOrdersLines([]);
      },
    );

    return () => unsub();
  }, [isAdmin, startDate, endDate]);

  // ✅ expenses_candies (sin manual)
  useEffect(() => {
    if (!isAdmin) return;

    const fetchExpenses = async () => {
      try {
        const qy = query(
          collection(db, "expenses_candies"),
          where("date", ">=", startDate),
          where("date", "<=", endDate),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qy);
        const rows: ExpenseCandy[] = [];
        snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
        setExpenses(rows);
      } catch (e) {
        // fallback si no hay índice
        console.warn("expenses_candies sin índice, usando fallback:", e);
        try {
          const snap = await getDocs(collection(db, "expenses_candies"));
          const rows: ExpenseCandy[] = [];
          snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
          setExpenses(
            rows.filter(
              (x) =>
                String(x.date || "") >= startDate &&
                String(x.date || "") <= endDate,
            ),
          );
        } catch (e2) {
          console.error(e2);
          setExpenses([]);
        }
      }
    };

    fetchExpenses();
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
            initialDebt: Number((d.data() as any)?.initialDebt || 0),
            initialDebtDate: String(
              (d.data() as any)?.initialDebtDate || "",
            ).trim(),
          }),
        );
        setCustomers(rows);
      },
      (err) => {
        console.error("customers_candies snapshot error:", err);
        setCustomers([]);
      },
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
          orderBy("date", "asc"),
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

  // ==========================
  //  FILTROS VENTAS
  // ==========================
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
        (r.productName || "").toLowerCase().includes(p),
      );
    }

    if (customerFilter.trim()) {
      const c = customerFilter.trim().toLowerCase();
      base = base.filter((r) =>
        (displayCustomerName(r) || "").toLowerCase().includes(c),
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

  // ==========================
  //  KPIs base (ventas)
  // ==========================
  const kpis = useMemo(() => {
    let packsCash = 0;
    let packsCredit = 0;
    let salesCash = 0;
    let salesCredit = 0;
    let commCash = 0;
    let commCredit = 0;

    for (const r of filteredRows) {
      const packs = safeNum(r.packages);
      const amt = safeNum(r.amount);
      const com = safeNum(r.commission);

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
      commTotal: round2(commCash + commCredit),
    };
  }, [filteredRows]);

  // ==========================
  //  expected + gross por sucursal (maestras)
  // ==========================
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
        expR += safeNum(it.totalRivas);
        expSJ += safeNum(it.totalSanJorge);
        expI += safeNum(it.totalIsla);

        gpR += safeNum(it.gainRivas);
        gpSJ += safeNum(it.gainSanJorge);
        gpI += safeNum(it.gainIsla);
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

  // ==========================
  //  actual por sucursal desde ventas
  // ==========================
  const actualByBranch = useMemo(() => {
    const map: Record<Branch, { sales: number; packages: number }> = {
      RIVAS: { sales: 0, packages: 0 },
      SAN_JORGE: { sales: 0, packages: 0 },
      ISLA: { sales: 0, packages: 0 },
    };

    for (const r of filteredRows) {
      const b = r.branch;
      if (!b) continue;
      map[b].sales += safeNum(r.amount);
      map[b].packages += safeNum(r.packages);
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
        actualByBranch.RIVAS.sales - expectedAndGross.expectedRivas,
      ),
      SAN_JORGE: round2(
        actualByBranch.SAN_JORGE.sales - expectedAndGross.expectedSanJorge,
      ),
      ISLA: round2(actualByBranch.ISLA.sales - expectedAndGross.expectedIsla),
    };
  }, [actualByBranch, expectedAndGross]);

  // ==========================
  //  KPI vendedores (comisión cash / crédito) - ya existía
  // ==========================
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
      const com = safeNum(r.commission);

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

  // ==========================
  //  ✅ VOLVIENDO LOS KPIs QUE SE HABÍAN QUITADO (los del screenshot)
  // ==========================
  const providerAndPackagesKpis = useMemo(() => {
    const sumNumber = (arr: any[], key: string) =>
      arr.reduce((s, x) => s + Number(x?.[key] ?? 0), 0);

    const safeInt = (n: any) => {
      const x = Number(n);
      if (!Number.isFinite(x)) return 0;
      return Math.floor(x);
    };

    const orderedFromOrder = (o: any) => {
      const root = Number(o?.totalPackages ?? 0);
      if (root > 0) return root;
      const items = Array.isArray(o?.items) ? o.items : [];
      return sumNumber(items, "packages");
    };

    // Total facturado proveedor (maestras)
    let providerTotalMaster = 0;
    let orderedPacksMaster = 0;
    for (const o of mainOrders) {
      const items = Array.isArray((o as any).items) ? (o as any).items : [];
      if (items.length) {
        for (const it of items)
          providerTotalMaster += Number(it?.subtotal ?? 0);
      } else {
        providerTotalMaster += Number((o as any).subtotal ?? 0);
      }
      orderedPacksMaster += orderedFromOrder(o);
    }

    // Total facturado proveedor (órdenes vendedor) + paquetes ordenados vendedor
    let providerTotalVendor = 0;
    let orderedPacksVendor = 0;
    let remainingPacksVendor = 0;

    const getRemainingPackagesVendorDoc = (v: any) => {
      const rp = Number(v?.remainingPackages);
      if (Number.isFinite(rp) && rp > 0) return Math.floor(rp);

      const unitsPerPackage = Math.max(1, safeInt(v?.unitsPerPackage ?? 1));
      const remainingUnits = safeInt(v?.remainingUnits ?? v?.remaining ?? 0);
      if (remainingUnits > 0)
        return Math.max(0, Math.floor(remainingUnits / unitsPerPackage));
      return 0;
    };

    for (const v of vendorOrdersLines) {
      providerTotalVendor += Number(v.subtotal ?? 0);
      orderedPacksVendor += Number(v.packages ?? 0);
      remainingPacksVendor += getRemainingPackagesVendorDoc(v);
    }

    // Restantes (período) maestras = remainingPackages de inventory_candies
    // asociados a órdenes maestras del período
    const periodOrderIds = new Set(
      mainOrders
        .filter(
          (o) =>
            String(o.date || "") >= startDate &&
            String(o.date || "") <= endDate,
        )
        .map((o) => o.id),
    );

    let remainingPacksMasterPeriod = 0;
    for (const inv of invCandiesAll) {
      const oid = String(inv.orderId || "").trim();
      if (!oid) continue;
      if (!periodOrderIds.has(oid)) continue;
      remainingPacksMasterPeriod += Number(inv.remainingPackages ?? 0);
    }

    // Existencia global (todas)
    const globalRemainingMaster = allMasterInventory.reduce(
      (s, x) => s + safeNum(x.remainingPackages),
      0,
    );
    const globalRemainingVendor = allVendorInventory.reduce(
      (s, x) => s + safeNum(x.remainingPackages),
      0,
    );

    return {
      providerTotalMaster: round2(providerTotalMaster),
      providerTotalVendor: round2(providerTotalVendor),

      orderedPacksMaster: round3(orderedPacksMaster),
      remainingPacksMaster: round3(remainingPacksMasterPeriod),

      orderedPacksVendor: round3(orderedPacksVendor),
      remainingPacksVendor: round3(remainingPacksVendor),

      globalRemainingMaster: round3(globalRemainingMaster),
      globalRemainingVendor: round3(globalRemainingVendor),
    };
  }, [
    mainOrders,
    vendorOrdersLines,
    invCandiesAll,
    startDate,
    endDate,
    allMasterInventory,
    allVendorInventory,
  ]);

  // ==========================
  //  ✅ NUEVO: Gastos del período desde expenses_candies
  // ==========================
  const expensesKpi = useMemo(() => {
    const byDay: Record<string, number> = {};
    let total = 0;

    for (const e of expenses) {
      const d = String(e.date || "").trim();
      if (!d) continue;
      const amt = Math.max(0, safeNum(e.amount));
      total += amt;
      byDay[d] = round2((byDay[d] || 0) + amt);
    }

    return { total: round2(total), byDay };
  }, [expenses]);

  // ==========================
  //  ✅ NUEVO: Total facturado (proveedor) = sumatoria órdenes maestras (costo)
  // ==========================
  const totalFacturadoProveedor = useMemo(() => {
    let total = 0;
    for (const o of mainOrders) {
      const items = Array.isArray((o as any).items) ? (o as any).items : [];
      if (items.length) {
        for (const it of items) total += safeNum(it?.subtotal);
      } else {
        total += safeNum((o as any).subtotal);
      }
    }
    return round2(total);
  }, [mainOrders]);

  // ==========================
  //  ✅ NUEVO: KPIs de Órdenes de Vendedores (vista global + por orden)
  // ==========================
  const vendorOrdersKpis = useMemo(() => {
    // Agrupar líneas por orderId (si no existe, caemos a docId)
    type Agg = {
      orderKey: string; // orderId o fallback
      orderId: string;
      date: string;
      sellerId: string;
      sellerName: string;
      branch: Branch | "";
      totalOrden: number; // dinero asociado (venta)
      vendido: number; // dinero vendido
      restante: number; // dinero restante
      comision: number; // comisión total (sobre totalOrden)
      totalEsperado: number; // totalOrden - comision
      lines: Array<
        VendorOrderLineDoc & {
          orderedUnits: number;
          soldUnits: number;
          remainingUnits: number;
          lineTotal: number;
          lineSoldValue: number;
          lineRemainingValue: number;
        }
      >;
    };

    const getUnits = (l: VendorOrderLineDoc) => {
      const upp = Math.max(1, Math.floor(safeNum(l.unitsPerPackage || 1)));
      const orderedUnits =
        safeNum(l.totalUnits) > 0
          ? safeNum(l.totalUnits)
          : safeNum(l.packages) * upp;

      let remainingUnits = 0;
      if (safeNum(l.remainingUnits) > 0)
        remainingUnits = safeNum(l.remainingUnits);
      else if (safeNum(l.remainingPackages) > 0)
        remainingUnits = safeNum(l.remainingPackages) * upp;
      else remainingUnits = 0;

      const soldUnits = Math.max(0, orderedUnits - remainingUnits);
      return { orderedUnits, remainingUnits, soldUnits, upp };
    };

    const pickBranch = (sellerId: string): Branch | "" => {
      const s = sellersMap[sellerId];
      return normalizeBranch(s?.branch) || "ISLA";
    };

    const getPricePerPackage = (l: VendorOrderLineDoc, b: Branch | "") => {
      if (b === "ISLA")
        return safeNum(
          vendorPriceCatalog[String(l.productId || "")]?.unitPriceIsla ??
            l.unitPriceIsla,
        );
      if (b === "RIVAS")
        return safeNum(
          vendorPriceCatalog[String(l.productId || "")]?.unitPriceRivas ??
            l.unitPriceRivas,
        );
      if (b === "SAN_JORGE")
        return safeNum(
          vendorPriceCatalog[String(l.productId || "")]?.unitPriceSanJorge ??
            l.unitPriceSanJorge,
        );
      return 0;
    };

    const pickLineTotalVenta = (l: VendorOrderLineDoc, b: Branch | "") => {
      const packs = Math.max(0, Math.floor(safeNum(l.packages)));
      const pricePerPackage = getPricePerPackage(l, b);
      const byPrice = round2(pricePerPackage * packs);
      if (byPrice > 0) return byPrice;

      const direct =
        safeNum(l.totalVendor) ||
        (b === "ISLA"
          ? safeNum(l.totalIsla)
          : b === "RIVAS"
            ? safeNum(l.totalRivas)
            : b === "SAN_JORGE"
              ? safeNum(l.totalSanJorge)
              : 0);

      if (direct > 0) return direct;

      // fallback: si hay unitPriceVendor (unitario), multiplicamos por unidades asociadas
      const upv = safeNum(l.unitPriceVendor);
      if (upv > 0) {
        const { orderedUnits } = getUnits(l);
        return upv * orderedUnits;
      }

      return 0;
    };

    const getUnitPriceFromLine = (l: VendorOrderLineDoc, b: Branch | "") => {
      const pricePerPackage = getPricePerPackage(l, b);
      const { orderedUnits, upp } = getUnits(l);
      if (pricePerPackage > 0 && upp > 0) return pricePerPackage / upp;

      const upv = safeNum(l.unitPriceVendor);
      if (upv > 0) return upv;

      // si no hay unitario, lo derivamos del total / unidades
      const total = pickLineTotalVenta(l, b);
      if (total > 0 && orderedUnits > 0) return total / orderedUnits;

      return 0;
    };

    const map = new Map<string, Agg>();

    for (const l of vendorOrdersLines) {
      const orderId = String(l.orderId || "").trim();
      const orderKey = orderId || `DOC:${l.id}`; // fallback estable

      const sellerId = String(l.sellerId || "").trim();
      const sellerName =
        String(l.sellerName || "").trim() ||
        (sellerId ? sellersMap[sellerId]?.name || "" : "") ||
        "(sin vendedor)";

      const date = String(l.date || "").trim();

      const branch = sellerId ? pickBranch(sellerId) : "";

      const { orderedUnits, remainingUnits, soldUnits } = getUnits(l);
      const lineTotal = pickLineTotalVenta(l, branch);
      const unitPrice = getUnitPriceFromLine(l, branch);

      const lineSoldValue =
        unitPrice > 0
          ? unitPrice * soldUnits
          : orderedUnits > 0
            ? (lineTotal * soldUnits) / orderedUnits
            : 0;

      const lineRemainingValue = round2(lineTotal - lineSoldValue);

      if (!map.has(orderKey)) {
        map.set(orderKey, {
          orderKey,
          orderId: orderId || orderKey,
          date,
          sellerId,
          sellerName,
          branch,
          totalOrden: 0,
          vendido: 0,
          restante: 0,
          comision: 0,
          totalEsperado: 0,
          lines: [],
        });
      }

      const agg = map.get(orderKey)!;
      agg.lines.push({
        ...l,
        orderedUnits,
        soldUnits,
        remainingUnits,
        lineTotal: round2(lineTotal),
        lineSoldValue: round2(lineSoldValue),
        lineRemainingValue: round2(lineRemainingValue),
      });

      agg.totalOrden += lineTotal;
      agg.vendido += lineSoldValue;
      agg.restante += lineRemainingValue;
      agg.comision += safeNum(
        (l as any).uVendor ?? (l as any).vendorProfit ?? (l as any).gainVendor,
      );
    }

    // comisiones por orden = utilidad de vendedor ya calculada
    for (const agg of map.values()) {
      agg.comision = round2(agg.comision);
      agg.totalEsperado = round2(agg.totalOrden - agg.comision);

      agg.totalOrden = round2(agg.totalOrden);
      agg.vendido = round2(agg.vendido);
      agg.restante = round2(agg.restante);
    }

    const orders = Array.from(map.values()).sort((a, b) => {
      // más recientes primero si hay date, si no por total
      if (a.date && b.date) return a.date < b.date ? 1 : -1;
      return b.totalOrden - a.totalOrden;
    });

    const global = orders.reduce(
      (acc, o) => {
        acc.totalOrden += safeNum(o.totalOrden);
        acc.vendido += safeNum(o.vendido);
        acc.restante += safeNum(o.restante);
        acc.comision += safeNum(o.comision);
        acc.totalEsperado += safeNum(o.totalEsperado);
        return acc;
      },
      { totalOrden: 0, vendido: 0, restante: 0, comision: 0, totalEsperado: 0 },
    );

    return {
      global: {
        totalOrden: round2(global.totalOrden),
        vendido: round2(global.vendido),
        restante: round2(global.restante),
        comision: round2(global.comision),
        totalEsperado: round2(global.totalEsperado),
      },
      orders,
    };
  }, [vendorOrdersLines, sellersMap, vendorPriceCatalog]);

  // ==========================
  //  ✅ NUEVO: Dispersado a vendedores (precio de venta) + Total existente (Isla)
  // ==========================
  const dispersedKpis = useMemo(() => {
    // “Productos dispersados”: suma del total esperado de órdenes de vendedor (precio venta)
    // Mismo cálculo que OrdenVendedor: precio por paquete * paquetes (precio actual del producto)
    // “Total existente”: expectedIsla - dispersadoIsla
    let dispersedTotal = 0;
    let dispersedIsla = 0;

    for (const line of vendorOrdersLines) {
      const sid = String(line.sellerId || "").trim();
      const seller = sid ? sellersMap[sid] : undefined;
      const b = normalizeBranch(seller?.branch) || "ISLA";

      const packs = Math.max(0, Math.floor(safeNum(line.packages)));
      if (!packs) continue;

      const pricePerPackage =
        b === "ISLA"
          ? safeNum(
              vendorPriceCatalog[String(line.productId || "")]?.unitPriceIsla ??
                line.unitPriceIsla,
            )
          : b === "RIVAS"
            ? safeNum(
                vendorPriceCatalog[String(line.productId || "")]
                  ?.unitPriceRivas ?? line.unitPriceRivas,
              )
            : safeNum(
                vendorPriceCatalog[String(line.productId || "")]
                  ?.unitPriceSanJorge ?? line.unitPriceSanJorge,
              );

      let totalEsperado = round2(pricePerPackage * packs);
      if (!totalEsperado) {
        totalEsperado =
          b === "ISLA"
            ? safeNum(line.totalIsla)
            : b === "RIVAS"
              ? safeNum(line.totalRivas)
              : safeNum(line.totalSanJorge);
      }

      if (!totalEsperado) continue;

      dispersedTotal += totalEsperado;
      dispersedIsla += totalEsperado; // solo existe ISLA
    }

    const totalExistenteIsla = round2(
      safeNum(expectedAndGross.expectedIsla) - dispersedIsla,
    );

    return {
      dispersedTotal: round2(dispersedTotal),
      dispersedIsla: round2(dispersedIsla),
      totalExistenteIsla,
    };
  }, [
    vendorOrdersLines,
    sellersMap,
    expectedAndGross.expectedIsla,
    vendorPriceCatalog,
  ]);

  const vendorOrdersNetKpi = useMemo(() => {
    const net = round2(
      vendorOrdersLines.reduce((s, l) => {
        const rawUNeta = (l as any).uNeta;
        const direct = safeNum(rawUNeta);
        if (direct !== 0 || rawUNeta === 0) return s + direct;

        const gross = safeNum((l as any).grossProfit);
        const gastos = safeNum(
          (l as any).logisticAllocated ?? (l as any).gastos ?? (l as any).gasto,
        );
        const uVendor = safeNum((l as any).uVendor ?? (l as any).vendorProfit);
        return s + (gross - gastos - uVendor);
      }, 0),
    );
    return { net };
  }, [vendorOrdersLines]);

  // ==========================
  //  ✅ NUEVO: KPI CxC + Recaudación + Utilidad bruta crédito
  // ==========================
  const creditKpis = useMemo(() => {
    let cxc = 0;
    let utilidadBruta = 0;
    let recaudado = 0;

    for (const r of filteredRows) {
      if (r.type !== "CREDITO") continue;
      const amt = safeNum(r.amount);
      const com = safeNum(r.commission);
      cxc += amt;
      utilidadBruta += amt - com;
    }

    for (const m of movements) {
      const d = String(m.date || "").trim();
      if (!d) continue;
      if (d < startDate || d > endDate) continue;

      const amt = safeNum(m.amount);
      const type = m.type || (amt < 0 ? "ABONO" : "CARGO");
      if (type === "ABONO") recaudado += Math.abs(amt);
    }

    return {
      cxc: round2(cxc),
      recaudado: round2(recaudado),
      utilidadBruta: round2(utilidadBruta),
    };
  }, [filteredRows, movements, startDate, endDate]);

  const vendorOrderDetail = useMemo(() => {
    if (!vendorOrderKey) return null;
    const o = vendorOrdersKpis.orders.find(
      (x) => x.orderKey === vendorOrderKey,
    );
    if (!o) return null;

    // resumen por producto: Asociados / Vendidos / Restantes (contadores en PAQUETES)
    const byProduct: Record<
      string,
      {
        productName: string;
        asociados: number;
        vendidos: number;
        restantes: number;
      }
    > = {};

    for (const l of o.lines) {
      const name = String(l.productName || "(sin nombre)");
      if (!byProduct[name])
        byProduct[name] = {
          productName: name,
          asociados: 0,
          vendidos: 0,
          restantes: 0,
        };

      const packs = Math.max(0, Math.floor(safeNum(l.packages)));
      const upp = Math.max(1, Math.floor(safeNum(l.unitsPerPackage || 1)));

      const remainingPacks = Math.max(
        0,
        Math.floor(
          safeNum(l.remainingPackages) ||
            (safeNum(l.remainingUnits) > 0
              ? safeNum(l.remainingUnits) / upp
              : 0),
        ),
      );

      const soldPacks = Math.max(0, packs - remainingPacks);

      byProduct[name].asociados += packs;
      byProduct[name].vendidos += soldPacks;
      byProduct[name].restantes += remainingPacks;
    }

    const products = Object.values(byProduct)
      .map((p) => ({
        ...p,
        asociados: Math.floor(p.asociados),
        vendidos: Math.floor(p.vendidos),
        restantes: Math.floor(p.restantes),
      }))
      .sort((a, b) => b.asociados - a.asociados);

    return { ...o, products };
  }, [vendorOrderKey, vendorOrdersKpis.orders]);

  // ✅ KPI EXISTENCIAS GLOBALES
  const globalStockKpis = useMemo(() => {
    const masterRemainingPackages = allMasterInventory.reduce(
      (s, x) => s + safeNum(x.remainingPackages),
      0,
    );

    const vendorRemainingPackages = allVendorInventory.reduce(
      (s, x) => s + safeNum(x.remainingPackages),
      0,
    );

    return {
      masterRemainingPackages: round3(masterRemainingPackages),
      vendorRemainingPackages: round3(vendorRemainingPackages),
    };
  }, [allMasterInventory, allVendorInventory]);

  // ==========================
  //  TABLA PRINCIPAL (group by)
  // ==========================
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
        agg.packsCredit += safeNum(r.packages);
        agg.salesCredit += safeNum(r.amount);
        agg.commCredit += safeNum(r.commission);
      } else {
        agg.packsCash += safeNum(r.packages);
        agg.salesCash += safeNum(r.amount);
        agg.commCash += safeNum(r.commission);
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
        (a, b) => b.salesCash + b.salesCredit - (a.salesCash + a.salesCredit),
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
        map[k].packsCredit += safeNum(r.packages);
        map[k].salesCredit += safeNum(r.amount);
        map[k].commCredit += safeNum(r.commission);
      } else {
        map[k].packsCash += safeNum(r.packages);
        map[k].salesCash += safeNum(r.amount);
        map[k].commCash += safeNum(r.commission);
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
        (a, b) => b.salesCash + b.salesCredit - (a.salesCash + a.salesCredit),
      );
  }, [detailRows]);

  const arSummary = useMemo(() => {
    const byCustomer: Record<
      string,
      ARCustomerRow & {
        initialDebt: number;
        initialDebtDate: string;
        movements: ARMovement[];
      }
    > = {};

    const nameOf = (id: string) => (customersMap[id] || "").trim() || id;

    for (const c of customers) {
      const cid = String(c.id || "").trim();
      if (!cid) continue;
      byCustomer[cid] = {
        customerId: cid,
        name: nameOf(cid),
        balance: 0,
        lastPayment: "",
        lastPaymentAmount: 0,
        initialDebt: safeNum(c.initialDebt),
        initialDebtDate: String(c.initialDebtDate || "").trim(),
        movements: [],
      };
    }

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
          lastPaymentAmount: 0,
          initialDebt: 0,
          initialDebtDate: "",
          movements: [],
        };
      }

      byCustomer[cid].movements.push(m);
    }

    const getEffectiveInitialDebt = (
      initialDebtValue: number,
      initialDebtDate: string,
      list: ARMovement[],
    ) => {
      const init = Number(initialDebtValue || 0);
      if (!init) return 0;

      const initDate = String(initialDebtDate || "").trim();
      if (!initDate) return init;

      const hasDup = list.some((m) => {
        const amt = Number(m.amount || 0);
        if (!(amt > 0)) return false;
        const sameAmount = Math.abs(amt - init) < 0.01;
        const sameDate = String(m.date || "").trim() === initDate;
        const hasSale = Boolean(m.ref?.saleId);
        return sameAmount && sameDate && hasSale;
      });

      return hasDup ? 0 : init;
    };

    const list = Object.values(byCustomer)
      .map((x) => {
        const sumMov = x.movements.reduce(
          (acc, it) => acc + safeNum(it.amount),
          0,
        );
        const effectiveInit = getEffectiveInitialDebt(
          x.initialDebt,
          x.initialDebtDate,
          x.movements,
        );
        let lastPayment = "";
        let lastPaymentAmount = 0;

        for (const m of x.movements) {
          const type = m.type || (safeNum(m.amount) < 0 ? "ABONO" : "CARGO");
          const d = String(m.date || "");
          if (type === "ABONO") {
            const amt = Math.abs(safeNum(m.amount));
            if (!lastPayment || d > lastPayment) {
              lastPayment = d;
              lastPaymentAmount = amt;
            }
          }
        }

        return {
          customerId: x.customerId,
          name: x.name,
          balance: round2(effectiveInit + sumMov),
          lastPayment,
          lastPaymentAmount: round2(lastPaymentAmount),
        };
      })
      .filter((x) => x.balance > 0)
      .sort((a, b) => b.balance - a.balance);

    const totalPending = round2(list.reduce((s, x) => s + x.balance, 0));
    return { count: list.length, totalPending, list: list.slice(0, 20) };
  }, [movements, customersMap, customers, endDate]);

  const arDetailRows = useMemo(() => {
    if (!arOpen)
      return [] as Array<{
        id: string;
        date: string;
        type: string;
        amount: number;
        running: number;
      }>;

    const rows = movements
      .filter((m) => (m.customerId || "").trim() === arOpen.customerId)
      .filter((m) => !m.date || String(m.date) <= endDate)
      .map((m) => ({
        id: m.id,
        date: String(m.date || ""),
        type: String(m.type || ""),
        amount: round2(safeNum(m.amount)),
      }))
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    let running = 0;
    return rows.map((r) => {
      const delta = r.type === "ABONO" ? -r.amount : r.amount;
      running = round2(running + delta);
      return { ...r, running };
    });
  }, [arOpen, movements, endDate]);

  const arSalesRows = useMemo(() => {
    if (!arOpen) return [] as SaleRow[];
    return salesRows
      .filter((r) => (r.customerId || "").trim() === arOpen.customerId)
      .filter((r) => !r.date || String(r.date) <= endDate)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }, [arOpen, salesRows, endDate]);

  // ==========================
  //  ✅ MACRO (SIN estimaciones)
  // ==========================
  const macro = useMemo(() => {
    const ingreso = round2(kpis.salesTotal);
    const comision = round2(kpis.commTotal);
    const gastos = round2(expensesKpi.total);

    const gananciaNeta = round2(ingreso - comision - gastos);

    // promedio por día (no estimado, es promedio real del período filtrado)
    const daysSet = new Set<string>();
    for (const r of filteredRows) if (r.date) daysSet.add(r.date);
    const daysCount = Math.max(1, daysSet.size);

    const ingresoDia = round2(ingreso / daysCount);
    const comisionDia = round2(comision / daysCount);
    const gastosDia = round2(gastos / daysCount);
    const netaDia = round2(gananciaNeta / daysCount);

    return {
      ingreso,
      comision,
      gastos,
      gananciaNeta,
      daysCount,
      ingresoDia,
      comisionDia,
      gastosDia,
      netaDia,
    };
  }, [kpis, expensesKpi.total, filteredRows]);

  // ==========================
  //  SERIES (ventas/neto por día) - NO estimado
  // ==========================
  const seriesByDay = useMemo(() => {
    const map: Record<
      string,
      { date: string; ingreso: number; comision: number }
    > = {};
    for (const r of filteredRows) {
      const d = r.date;
      if (!d) continue;
      if (!map[d]) map[d] = { date: d, ingreso: 0, comision: 0 };
      map[d].ingreso += safeNum(r.amount);
      map[d].comision += safeNum(r.commission);
    }

    const dates = Object.keys(map).sort((a, b) => (a < b ? -1 : 1));

    const seriesIngreso = dates.map((d) => ({
      label: d.slice(5),
      value: round2(map[d].ingreso),
    }));

    const seriesNeta = dates.map((d) => {
      const ingresoDia = safeNum(map[d]?.ingreso);
      const comDia = safeNum(map[d]?.comision);
      const gastosDia = safeNum(expensesKpi.byDay[d] || 0);
      const netaDia = ingresoDia - comDia - gastosDia;
      return { label: d.slice(5), value: round2(netaDia) };
    });

    return { seriesIngreso, seriesNeta, datesCount: dates.length };
  }, [filteredRows, expensesKpi.byDay]);

  const pieSalesByBranch = useMemo(() => {
    return [
      { label: "Rivas", value: safeNum(actualByBranch.RIVAS.sales) },
      { label: "San Jorge", value: safeNum(actualByBranch.SAN_JORGE.sales) },
      { label: "Isla", value: safeNum(actualByBranch.ISLA.sales) },
    ].map((x) => ({ ...x, value: round2(x.value) }));
  }, [actualByBranch]);

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
        ].join(","),
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

  return (
    <div className="max-w-7xl mx-auto px-2 sm:px-4 md:px-0">
      <div className="bg-white p-3 sm:p-4 md:p-6 rounded-2xl shadow-2xl">
        {/* HEADER */}
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

        {/* FILTROS */}
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

        {/* CHIPS/TABS */}
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between mb-4">
          <div className="flex gap-2">
            <button
              onClick={() => {
                setVendorOrderKey("");
                setDataView("MACRO");
              }}
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
              onClick={() => {
                setVendorOrderKey("");
                setDataView("DETALLE");
              }}
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

          {/* ✅ Gastos ya NO son manuales */}
          <div className="text-xs text-gray-600">
            Gastos del período (expenses_candies):{" "}
            <strong>C${money(expensesKpi.total)}</strong>
          </div>
        </div>

        {/* CONTENIDO PDF */}
        <div ref={pdfRef}>
          {/* =======================
              DATA MACRO
             ======================= */}
          {dataView === "MACRO" && (
            <>
              {/* KPIs Macro */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
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
                    Comisión vendedor (ventas)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    -C${money(macro.comision)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Cash: C${money(kpis.commCash)} • Crédito: C$
                    {money(kpis.commCredit)}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Gastos (expenses_candies)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    -C${money(macro.gastos)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Se calcula automático por fechas
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Ganancia neta (real)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(macro.gananciaNeta)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Ingreso − Comisión − Gastos
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Promedio neto por día
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(macro.netaDia)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Días con ventas: <strong>{macro.daysCount}</strong>
                  </div>
                </div>
              </div>

              {/* Gráficas */}
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-3 mb-3">
                <LineChartSimple
                  title="Ventas por día (Ingreso)"
                  series={seriesByDay.seriesIngreso}
                  valuePrefix="C$"
                />
                <LineChartSimple
                  title="Ganancia neta por día (real)"
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
              DATA DETALLE
             ======================= */}
          {dataView === "DETALLE" && (
            <>
              {/* KPIs ventas */}
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
                    C${money(kpis.commTotal)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Cash: C${money(kpis.commCash)} • Crédito: C$
                    {money(kpis.commCredit)}
                  </div>
                </div>
              </div>

              {/* expected + actual + diff */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Utilidad Bruta Aprox. (órdenes maestras)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(expectedAndGross.grossIsla)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Isla Ometepe</div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total esperado (Isla)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold mt-2">
                    C${money(expectedAndGross.expectedIsla)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Isla Ometepe</div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Actual ventas (Isla)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold mt-2">
                    C${money(actualByBranch.ISLA.sales)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Isla Ometepe</div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Diferencia vs esperado (Isla)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold mt-2">
                    C${money(diffVsExpected.ISLA)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">Isla Ometepe</div>
                </div>
              </div>

              {/* ✅ RESTAURADO: los 3 KPIs del screenshot */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total facturado (precio proveedor)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(totalFacturadoProveedor)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Sumatoria órdenes maestras (período)
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Utilidad neta (órdenes vendedor)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(vendorOrdersNetKpi.net)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    U bruta − Gastos − U vendedor
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

              {/* ✅ KPIs pedidos: Total facturado + Dispersado + Total existente (Isla) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
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
                    Productos dispersados (precio venta)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(dispersedKpis.dispersedTotal)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Sumatoria órdenes de vendedores (período)
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Dispersado Isla (precio venta)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(dispersedKpis.dispersedIsla)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Usado para “Total existente”
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total existente en productos (Isla)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(dispersedKpis.totalExistenteIsla)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Esperado Isla − Dispersado Isla
                  </div>
                </div>
              </div>

              {/* ✅ NUEVO: KPIs CxC + Recaudación + Utilidad bruta crédito */}
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    CxC (ventas crédito)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(creditKpis.cxc)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">Comisión crédito</div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(kpis.commCredit)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    {startDate} → {endDate}
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Recaudación (abonos)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(creditKpis.recaudado)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    abonos en ar_movements
                  </div>
                </div>

                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Utilidad bruta crédito (ventas − comisión)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    C${money(creditKpis.utilidadBruta)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    Paquetes vendidos al crédito
                  </div>
                </div>
              </div>

              {/* ✅ NUEVO: KPIs Órdenes de Vendedores (vista global) */}
              <div className="border rounded-2xl p-3 sm:p-4 mb-4 shadow-sm bg-white border-gray-100">
                <div className="flex items-start justify-between gap-2 mb-2">
                  <h3 className="font-semibold text-sm sm:text-base">
                    Órdenes de vendedores (Global)
                  </h3>
                  <div className="text-xs text-gray-500">
                    Basado en <strong>precio de venta</strong> (por sucursal del
                    vendedor)
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-sm">
                  <div className="border rounded-xl p-3 bg-gray-50">
                    Total orden:{" "}
                    <strong>
                      C${money(vendorOrdersKpis.global.totalOrden)}
                    </strong>
                  </div>
                  <div className="border rounded-xl p-3 bg-gray-50">
                    Vendido:{" "}
                    <strong>C${money(vendorOrdersKpis.global.vendido)}</strong>
                  </div>
                  <div className="border rounded-xl p-3 bg-gray-50">
                    Restante:{" "}
                    <strong>C${money(vendorOrdersKpis.global.restante)}</strong>
                  </div>
                  <div className="border rounded-xl p-3 bg-gray-50">
                    Comisión:{" "}
                    <strong>C${money(vendorOrdersKpis.global.comision)}</strong>
                  </div>
                  <div className="border rounded-xl p-3 bg-gray-50">
                    Total esperado:{" "}
                    <strong>
                      C${money(vendorOrdersKpis.global.totalEsperado)}
                    </strong>
                  </div>
                </div>
              </div>

              {/* ✅ NUEVO: Lista de órdenes de vendedores (clic para detalle) */}
              <div className="border rounded-2xl p-3 sm:p-4 mb-6 shadow-sm bg-white border-gray-100">
                <div className="flex items-center justify-between gap-2 mb-3">
                  <h3 className="font-semibold text-sm sm:text-base">
                    Órdenes de vendedores (Detalle por orden)
                  </h3>
                  <div className="text-xs text-gray-500">
                    Click/Tap en una orden para ver productos
                    asociados/vendidos/restantes
                  </div>
                </div>

                {vendorOrdersKpis.orders.length === 0 ? (
                  <div className="text-sm text-gray-500">—</div>
                ) : (
                  <>
                    {/* MOBILE: cards */}
                    <div className="md:hidden space-y-2">
                      {vendorOrdersKpis.orders.map((o) => (
                        <div
                          key={o.orderKey}
                          className="border rounded-2xl p-3"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <div className="font-semibold truncate">
                                {o.orderId}
                              </div>
                              <div className="text-xs text-gray-600 mt-1 truncate">
                                {o.sellerName} {o.branch ? `• ${o.branch}` : ""}{" "}
                                {o.date ? `• ${o.date}` : ""}
                              </div>
                            </div>
                            <button
                              className="px-3 py-2 rounded-lg bg-gray-800 text-white text-sm font-semibold"
                              onClick={() => setVendorOrderKey(o.orderKey)}
                            >
                              Ver
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">Total</div>
                              <div className="font-bold">
                                C${money(o.totalOrden)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Vendido
                              </div>
                              <div className="font-bold">
                                C${money(o.vendido)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Restante
                              </div>
                              <div className="font-bold">
                                C${money(o.restante)}
                              </div>
                            </div>
                            <div className="bg-gray-50 rounded-xl p-2">
                              <div className="text-xs text-gray-600">
                                Comisión
                              </div>
                              <div className="font-bold">
                                C${money(o.comision)}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>

                    {/* DESKTOP: tabla */}
                    <div className="hidden md:block overflow-x-auto">
                      <table className="min-w-full border text-sm">
                        <thead className="bg-gray-100">
                          <tr>
                            {/* <th className="border p-2 text-left">Orden</th> */}
                            <th className="border p-2 text-left">Vendedor</th>
                            <th className="border p-2">Sucursal</th>
                            <th className="border p-2">Fecha</th>
                            <th className="border p-2">Total orden</th>
                            <th className="border p-2">Vendido</th>
                            <th className="border p-2">Restante</th>
                            <th className="border p-2">Comisión</th>
                            <th className="border p-2">Total esperado</th>
                            <th className="border p-2">Acción</th>
                          </tr>
                        </thead>
                        <tbody>
                          {vendorOrdersKpis.orders.map((o) => (
                            <tr key={o.orderKey} className="text-center">
                              {/* <td className="border p-2 text-left">
                                {o.orderId}
                              </td> */}
                              <td className="border p-2 text-left">
                                {o.sellerName}
                              </td>
                              <td className="border p-2">{o.branch || "—"}</td>
                              <td className="border p-2">{o.date || "—"}</td>
                              <td className="border p-2">
                                C${money(o.totalOrden)}
                              </td>
                              <td className="border p-2">
                                C${money(o.vendido)}
                              </td>
                              <td className="border p-2">
                                C${money(o.restante)}
                              </td>
                              <td className="border p-2">
                                C${money(o.comision)}
                              </td>
                              <td className="border p-2">
                                C${money(o.totalEsperado)}
                              </td>
                              <td className="border p-2">
                                <button
                                  className="text-xs bg-gray-800 text-white px-3 py-2 rounded-lg hover:bg-black"
                                  onClick={() => setVendorOrderKey(o.orderKey)}
                                >
                                  Ver detalle
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    {/* DETALLE POR ORDEN */}
                    {vendorOrderDetail && (
                      <div className="mt-4 rounded-2xl border-2 border-gray-100 p-3 sm:p-4 shadow-lg bg-white">
                        <div className="flex flex-col sm:flex-row sm:items-center gap-2 mb-3">
                          <h4 className="text-base sm:text-xl font-semibold truncate">
                            Detalle orden vendedor • {vendorOrderDetail.orderId}
                          </h4>
                          <button
                            onClick={() => setVendorOrderKey("")}
                            className="w-full sm:w-auto text-sm px-3 py-2 border rounded-lg hover:bg-gray-50"
                          >
                            Cerrar
                          </button>
                        </div>

                        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2 text-sm mb-4">
                          <div className="border rounded-xl p-3 bg-gray-50">
                            Total orden:{" "}
                            <strong>
                              C${money(vendorOrderDetail.totalOrden)}
                            </strong>
                          </div>
                          <div className="border rounded-xl p-3 bg-gray-50">
                            Vendido:{" "}
                            <strong>
                              C${money(vendorOrderDetail.vendido)}
                            </strong>
                          </div>
                          <div className="border rounded-xl p-3 bg-gray-50">
                            Restante:{" "}
                            <strong>
                              C${money(vendorOrderDetail.restante)}
                            </strong>
                          </div>
                          <div className="border rounded-xl p-3 bg-gray-50">
                            Comisión:{" "}
                            <strong>
                              C${money(vendorOrderDetail.comision)}
                            </strong>
                          </div>
                          <div className="border rounded-xl p-3 bg-gray-50">
                            Total esperado:{" "}
                            <strong>
                              C${money(vendorOrderDetail.totalEsperado)}
                            </strong>
                          </div>
                        </div>

                        <h5 className="font-semibold mb-2 text-sm sm:text-base">
                          Productos asociados (Nombre - Asociados - Vendidos -
                          Restantes)
                        </h5>

                        {/* MOBILE: cards */}
                        <div className="md:hidden space-y-2">
                          {vendorOrderDetail.products.map((p) => (
                            <div
                              key={p.productName}
                              className="border rounded-2xl p-3"
                            >
                              <div className="font-semibold">
                                {p.productName}
                              </div>
                              <div className="grid grid-cols-3 gap-2 mt-3 text-sm">
                                <div className="bg-gray-50 rounded-xl p-2 text-center">
                                  <div className="text-xs text-gray-600">
                                    Asociados
                                  </div>
                                  <div className="font-bold">{p.asociados}</div>
                                </div>
                                <div className="bg-gray-50 rounded-xl p-2 text-center">
                                  <div className="text-xs text-gray-600">
                                    Vendidos
                                  </div>
                                  <div className="font-bold">{p.vendidos}</div>
                                </div>
                                <div className="bg-gray-50 rounded-xl p-2 text-center">
                                  <div className="text-xs text-gray-600">
                                    Restantes
                                  </div>
                                  <div className="font-bold">{p.restantes}</div>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* DESKTOP: tabla */}
                        <div className="hidden md:block overflow-x-auto">
                          <table className="min-w-full border text-sm">
                            <thead className="bg-gray-100">
                              <tr>
                                <th className="border p-2 text-left">
                                  Nombre producto
                                </th>
                                <th className="border p-2">Asociados</th>
                                <th className="border p-2">Vendidos</th>
                                <th className="border p-2">Restantes</th>
                              </tr>
                            </thead>
                            <tbody>
                              {vendorOrderDetail.products.map((p) => (
                                <tr key={p.productName} className="text-center">
                                  <td className="border p-2 text-left">
                                    {p.productName}
                                  </td>
                                  <td className="border p-2">{p.asociados}</td>
                                  <td className="border p-2">{p.vendidos}</td>
                                  <td className="border p-2">{p.restantes}</td>
                                </tr>
                              ))}
                              {vendorOrderDetail.products.length === 0 && (
                                <tr>
                                  <td
                                    colSpan={4}
                                    className="p-4 text-center text-gray-500"
                                  >
                                    Sin productos.
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

              {/* KPI existencias globales (lo que ya tenías) */}
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Existencia global (maestras)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(globalStockKpis.masterRemainingPackages)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    remainingPackages (todas)
                  </div>
                </div>
                <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Existencia global (vendedores)
                  </div>
                  <div className="text-xl sm:text-2xl font-bold">
                    {qty3(globalStockKpis.vendorRemainingPackages)}
                  </div>
                  <div className="text-xs text-gray-500 mt-1">
                    remainingPackages (todas)
                  </div>
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
                  Saldos pendientes (hasta {endDate})
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
                            Último abono: <b>C${money(c.lastPaymentAmount)}</b>
                          </div>
                          <div className="text-xs text-gray-600">
                            Fecha ult. abono:{" "}
                            <span className="font-medium">
                              {c.lastPayment || "—"}
                            </span>
                          </div>
                          <div className="mt-2">
                            <button
                              type="button"
                              onClick={() => setArOpen(c)}
                              className="px-3 py-1 rounded bg-indigo-600 text-white text-xs hover:bg-indigo-700"
                            >
                              Ver
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>

                    <div className="hidden md:block overflow-x-auto">
                      <table className="min-w-full border text-sm">
                        <thead className="bg-gray-100">
                          <tr>
                            <th className="border p-2 text-left">Cliente</th>
                            <th className="border p-2">Saldo pendiente</th>
                            <th className="border p-2">Último abono</th>
                            <th className="border p-2">Fecha ult. abono</th>
                            <th className="border p-2">Ver</th>
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
                                C${money(c.lastPaymentAmount)}
                              </td>
                              <td className="border p-2">
                                {c.lastPayment || "—"}
                              </td>
                              <td className="border p-2">
                                <button
                                  type="button"
                                  onClick={() => setArOpen(c)}
                                  className="px-3 py-1 rounded bg-indigo-600 text-white text-xs hover:bg-indigo-700"
                                >
                                  Ver
                                </button>
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
                  {/* MOBILE: cards */}
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
                      className="w-full sm:w-auto text-sm px-3 py-2 border rounded-lg hover:bg-gray-50"
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
                            .reduce((s, r) => s + safeNum(r.amount), 0),
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
                            .reduce((s, r) => s + safeNum(r.amount), 0),
                        )}
                      </strong>
                    </div>
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total paquetes cash:{" "}
                      <strong>
                        {qty3(
                          detailRows
                            .filter((r) => r.type === "CONTADO")
                            .reduce((s, r) => s + safeNum(r.packages), 0),
                        )}
                      </strong>
                    </div>
                    <div className="border rounded-xl p-3 bg-gray-50">
                      Total paquetes crédito:{" "}
                      <strong>
                        {qty3(
                          detailRows
                            .filter((r) => r.type === "CREDITO")
                            .reduce((s, r) => s + safeNum(r.packages), 0),
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

      {arOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-3xl p-4">
            <div className="flex items-center justify-between mb-3">
              <div>
                <h4 className="font-semibold text-lg">{arOpen.name}</h4>
                <div className="text-xs text-gray-600">
                  Saldo pendiente: <b>C${money(arOpen.balance)}</b>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setArOpen(null)}
                className="text-sm text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Fecha</th>
                    <th className="border p-2">Tipo</th>
                    <th className="border p-2">Monto</th>
                    <th className="border p-2">Saldo</th>
                  </tr>
                </thead>
                <tbody>
                  {arDetailRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="border p-2 text-center text-gray-500"
                      >
                        Sin movimientos.
                      </td>
                    </tr>
                  ) : (
                    arDetailRows.map((r) => (
                      <tr key={r.id} className="text-center">
                        <td className="border p-1">{r.date || "—"}</td>
                        <td className="border p-1">{r.type || "—"}</td>
                        <td className="border p-1">C${money(r.amount)}</td>
                        <td className="border p-1">C${money(r.running)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            <div className="mt-4 overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Fecha</th>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Vendedor</th>
                    <th className="border p-2">Tipo</th>
                    <th className="border p-2">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {arSalesRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={5}
                        className="border p-2 text-center text-gray-500"
                      >
                        Sin ventas asociadas.
                      </td>
                    </tr>
                  ) : (
                    arSalesRows.map((r) => (
                      <tr key={r.id} className="text-center">
                        <td className="border p-1">{r.date || "—"}</td>
                        <td className="border p-1">{r.productName || "—"}</td>
                        <td className="border p-1">{r.vendorName || "—"}</td>
                        <td className="border p-1">{r.type || "—"}</td>
                        <td className="border p-1">C${money(r.amount)}</td>
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
