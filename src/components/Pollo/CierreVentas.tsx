// src/components/CierreVentas.tsx
import React, { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { db, auth } from "../../firebase";
import {
  collection,
  getDocs,
  getDoc,
  addDoc,
  Timestamp,
  query,
  where,
  onSnapshot,
  writeBatch,
  doc,
  updateDoc,
  runTransaction,
} from "firebase/firestore";
import ActionMenu, {
  ActionMenuTrigger,
} from "../../components/common/ActionMenu";
import Toast from "../../components/common/Toast";
import { format, endOfMonth, startOfMonth } from "date-fns";
import { hasRole } from "../../utils/roles";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { restoreSaleAndDelete } from "../../Services/inventory";
import RefreshButton from "../../components/common/RefreshButton";
import Button from "../../components/common/Button";
import MobileHtmlSelect from "../../components/common/MobileHtmlSelect";
import useManualRefresh from "../../hooks/useManualRefresh";
import { canAction } from "../../utils/access";

type FireTimestamp = { toDate?: () => Date } | undefined;

interface SaleDataRaw {
  id?: string;
  productName?: string;
  quantity?: number;
  amount?: number;
  amountCharged?: number;
  amountSuggested?: number;
  measurement?: string;
  type?: "CREDITO" | "CONTADO";
  date?: string;
  userEmail?: string;
  vendor?: string;
  clientName?: string;
  amountReceived?: number;
  change?: string | number;
  status?: "FLOTANTE" | "PROCESADA";
  timestamp?: FireTimestamp;
  createdAt?: FireTimestamp;
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  items?: any[];
  /** Por línea: venta − costo (se guarda desde SaleFormV2). */
  grossProfit?: number;
  unitPrice?: number;
  edited?: boolean;
  editedAt?: FireTimestamp;
  editedBy?: string;
}

interface SaleData {
  id: string;
  productName: string;
  quantity: number;
  amount: number;
  amountSuggested: number;
  date: string;
  createdAt?: string; // fecha+hora de ingreso (creación)
  userEmail: string;
  clientName: string;
  amountReceived: number;
  change: string;
  status: "FLOTANTE" | "PROCESADA";
  type: "CREDITO" | "CONTADO";
  measurement?: string;
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  /** Línea: monto venta − costo FIFO (persistido o derivado). */
  grossProfit?: number;
  unitPrice?: number;
  edited?: boolean;
}

interface ClosureData {
  id: string;
  date: string;
  createdAt: any;
  products: { productName: string; quantity: number; amount: number }[];
  totalUnits: number;
  totalCharged: number;
  totalSuggested: number;
  totalDifference: number;
  salesV2?: any[];
  productSummary?: {
    productName: string;
    totalQuantity: number;
    totalAmount: number;
  }[];
  totalCOGS?: number;
  grossProfit?: number;
}

interface CombinedDailyRow {
  date: string;
  totalLbs: number;
  totalUnits: number;
  totalAmount: number;
  /** Suma U.Bruta del día+producto en el periodo. */
  totalGross: number;
  product?: string;
}

// helpers
const round2 = (n: number) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

/** U.Bruta por fila: usa `grossProfit` guardado o (monto − costo). */
function saleGrossProfit(s: SaleData): number {
  const g = Number(s.grossProfit);
  if (Number.isFinite(g)) return round2(g);
  return round2((s.amount || 0) - Number(s.cogsAmount ?? 0));
}

const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
  const dateFromField = raw.date ? String(raw.date) : "";
  const dateFromTs = raw.timestamp?.toDate
    ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
    : "";

  // ✅ Si hay raw.date pero está desfasada vs timestamp, gana timestamp
  let date = dateFromField || dateFromTs;

  if (dateFromField && dateFromTs) {
    const a = new Date(dateFromField + "T00:00:00").getTime();
    const b = new Date(dateFromTs + "T00:00:00").getTime();
    const diffDays = Math.abs(a - b) / (1000 * 60 * 60 * 24);
    if (isFinite(diffDays) && diffDays > 30) {
      date = dateFromTs;
    }
  }

  if (!date) return [];

  const saleType: "CREDITO" | "CONTADO" = raw.type ?? "CONTADO";

  // compute createdAt datetime from timestamp or createdAt
  const createdAtDt = raw.timestamp?.toDate
    ? format(raw.timestamp.toDate()!, "yyyy-MM-dd HH:mm")
    : raw.createdAt?.toDate
      ? format(raw.createdAt.toDate(), "yyyy-MM-dd HH:mm")
      : "";

  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const qty = Number(it?.qty ?? 0);
      const lineFinal =
        Number(it?.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPrice || 0) * qty - Number(it?.discount || 0),
        );
      const cogsLine = Number(it?.cogsAmount ?? 0);
      const gpStored = Number(it?.grossProfit);
      const grossProfit = Number.isFinite(gpStored)
        ? round2(gpStored)
        : round2(lineFinal - cogsLine);

      return {
        id: `${id}#${idx}`,
        productName: String(it?.productName ?? "(sin nombre)"),
        quantity: qty,
        amount: round2(lineFinal),
        amountSuggested: Number(raw.amountSuggested ?? 0),
        date,
        createdAt: createdAtDt,
        userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
        clientName: raw.clientName ?? "",
        amountReceived: Number(raw.amountReceived ?? 0),
        change: String(raw.change ?? "0"),
        status: (raw.status as any) ?? "FLOTANTE",
        type: saleType,
        measurement: String(it?.measurement ?? raw.measurement ?? ""),
        allocations: Array.isArray(it?.allocations)
          ? it.allocations
          : raw.allocations,
        avgUnitCost: Number(it?.avgUnitCost ?? raw.avgUnitCost ?? 0),
        cogsAmount: cogsLine,
        grossProfit,
        unitPrice: Number(it?.unitPrice || 0),
        edited: !!raw.edited,
      };
    });
  }

  const amt = Number(raw.amount ?? raw.amountCharged ?? 0);
  const cogsLegacy = Number(raw.cogsAmount ?? 0);
  const gpLegacy = Number(raw.grossProfit);
  const grossProfitLegacy = Number.isFinite(gpLegacy)
    ? round2(gpLegacy)
    : round2(amt - cogsLegacy);

  return [
    {
      id,
      productName: raw.productName ?? "(sin nombre)",
      quantity: Number(raw.quantity ?? 0),
      amount: amt,
      amountSuggested: Number(raw.amountSuggested ?? 0),
      date,
      createdAt: createdAtDt,
      userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
      clientName: raw.clientName ?? "",
      amountReceived: Number(raw.amountReceived ?? 0),
      change: String(raw.change ?? "0"),
      status: (raw.status as any) ?? "FLOTANTE",
      type: saleType,
      measurement: String(raw.measurement ?? ""),
      allocations: raw.allocations,
      avgUnitCost: raw.avgUnitCost,
      cogsAmount: cogsLegacy,
      grossProfit: grossProfitLegacy,
      unitPrice: Number(raw.unitPrice || 0),
      edited: !!raw.edited,
    },
  ];
};

const sanitizeDecimal = (v: string, maxDec: number): string => {
  let s = v.replace(/,/g, ".");
  s = s.replace(/[^0-9.]/g, "");
  const parts = s.split(".");
  if (parts.length > 2) s = parts[0] + "." + parts.slice(1).join("");
  if (parts.length === 2 && parts[1].length > maxDec) {
    s = parts[0] + "." + parts[1].slice(0, maxDec);
  }
  return s;
};

/** Más reciente primero: fecha venta desc, luego fecha/hora ingreso desc. */
function compareSaleNewestFirst(a: SaleData, b: SaleData): number {
  const da = String(a.date || "");
  const db = String(b.date || "");
  if (da !== db) return db.localeCompare(da);
  const ca = String(a.createdAt || "");
  const cb = String(b.createdAt || "");
  if (ca !== cb) return cb.localeCompare(ca);
  return String(b.id).localeCompare(String(a.id));
}

export default function CierreVentas({
  role,
  roles,
}: {
  role?: string;
  roles?: string[];
}): React.ReactElement {
  const [salesV2, setSales] = useState<SaleData[]>([]);
  const [floatersExtra, setFloatersExtra] = useState<SaleData[]>([]);
  const [closure, setClosure] = useState<ClosureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FLOTANTE" | "PROCESADA">("ALL");
  const [operationFilter, setOperationFilter] = useState<
    "ALL" | "CREDITO" | "CONTADO"
  >("ALL");
  const [userNameByEmail, setUserNameByEmail] = useState<
    Record<string, string>
  >({});

  const [editing, setEditing] = useState<null | SaleData>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editQty, setEditQty] = useState<string>("");
  const [editPrice, setEditPrice] = useState<string>("");
  const [editClient, setEditClient] = useState<string>("");
  const [editConfirm, setEditConfirm] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editMinDate, setEditMinDate] = useState<string>("");
  const [rowActionMenu, setRowActionMenu] = useState<{
    rect: DOMRect;
    sale: SaleData;
  } | null>(null);
  const [headerToolsMenuRect, setHeaderToolsMenuRect] =
    useState<DOMRect | null>(null);

  const today = format(new Date(), "yyyy-MM-dd");
  const monthStart = format(startOfMonth(new Date()), "yyyy-MM-dd");
  const monthEnd = format(endOfMonth(new Date()), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(monthStart);
  const [endDate, setEndDate] = useState<string>(monthEnd);

  // ✅ NUEVOS: colapsables (todo nace colapsado)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ventasOpen, setVentasOpen] = useState(false);
  const [consolidadoOpen, setConsolidadoOpen] = useState(false);
  const [indicadoresOpen, setIndicadoresOpen] = useState(false);

  // ✅ NUEVO: filtro por producto
  const [productFilter, setProductFilter] = useState<string>("");

  // paginacion (tabla contado y credito)
  const PAGE_SIZE = 25;
  /** Transacciones Contado + Crédito (tabla consolidada diaria) */
  const COMBINED_PAGE_SIZE = 15;
  const [cashPage, setCashPage] = useState(1);
  const [creditPage, setCreditPage] = useState(1);
  const [combinedPage, setCombinedPage] = useState(1);
  const [pdfMode, setPdfMode] = useState(false);
  const [cashTableOpen, setCashTableOpen] = useState(false);
  const [creditTableOpen, setCreditTableOpen] = useState(false);
  const [combinedTableOpen, setCombinedTableOpen] = useState(false);

  const pdfRef = useRef<HTMLDivElement>(null);
  const { refreshKey, refresh } = useManualRefresh();

  //calcular roles
  const subject = roles && roles.length ? roles : role;
  const cierreVentas = canAction(subject, "bills", "cerrarVentas");

  const isAdmin = hasRole(subject, "admin");
  const isContador = hasRole(subject, "contador");
  const canEditSale = isAdmin || isContador;

  const SectionHeader = ({
    title,
    open,
    onToggle,
    right,
  }: {
    title: string;
    open: boolean;
    onToggle: () => void;
    right?: React.ReactNode;
  }) => {
    return (
      <Button
        type="button"
        variant="secondary"
        onClick={onToggle}
        className="!rounded-xl w-full justify-between gap-3 px-4 py-3 font-normal shadow-sm"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate">{title}</span>
          {right ? (
            <span className="text-xs text-gray-600">{right}</span>
          ) : null}
        </div>
        <div className="shrink-0 text-lg font-bold leading-none">
          {open ? "−" : "+"}
        </div>
      </Button>
    );
  };

  // Ventas por PERIODO
  useEffect(() => {
    if (!startDate || !endDate) return;

    setLoading(true);

    const q = query(
      collection(db, "salesV2"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: SaleData[] = [];
        snap.forEach((d) => {
          const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
          rows.push(...parts);
        });
        setSales(rows);
        setLoading(false);
      },
      (err) => {
        console.error("Error cargando ventas por periodo:", err);
        setSales([]);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [startDate, endDate, refreshKey]);

  // FLOTANTE en el período
  useEffect(() => {
    if (!startDate || !endDate) return;

    const qFlo = query(
      collection(db, "salesV2"),
      where("status", "==", "FLOTANTE"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
    );

    const unsub = onSnapshot(qFlo, (snap) => {
      const rows: SaleData[] = [];
      snap.forEach((d) => {
        const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
        rows.push(...parts);
      });
      setFloatersExtra(rows);
    });

    return () => unsub();
  }, [startDate, endDate, refreshKey]);

  // Cargar usuarios para mostrar nombre del vendedor
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, "users"));
        const map: Record<string, string> = {};
        snap.forEach((d) => {
          const u = d.data() as any;
          const email = String(u.email || "")
            .trim()
            .toLowerCase();
          const name = String(u.name || "").trim();
          if (email) map[email] = name || u.email || "";
        });
        setUserNameByEmail(map);
      } catch (e) {
        console.error("Error cargando usuarios:", e);
        setUserNameByEmail({});
      }
    })();
  }, []);

  const displaySeller = (email?: string) => {
    const key = String(email || "")
      .trim()
      .toLowerCase();
    return userNameByEmail[key] || email || "—";
  };

  // Cierre guardado (informativo)
  useEffect(() => {
    const fetchClosure = async () => {
      const q = query(
        collection(db, "daily_closures"),
        where("date", "==", today),
      );
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const d = snapshot.docs[0];
        setClosure({ id: d.id, ...d.data() } as ClosureData);
      } else {
        setClosure(null);
      }
    };
    fetchClosure();
  }, [today, refreshKey]);

  /** Misma base que la tabla pero sin filtrar por producto (para opciones del selector). */
  const salesBaseWithoutProductFilter = React.useMemo(() => {
    let base: SaleData[] = [];

    if (filter === "FLOTANTE") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) if (s.status === "FLOTANTE") map.set(s.id, s);
      base = Array.from(map.values());
    } else if (filter === "ALL") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) map.set(s.id, s);
      base = Array.from(map.values());
    } else {
      base = salesV2.filter((s) => s.status === "PROCESADA");
    }

    if (operationFilter !== "ALL") {
      base = base.filter((s) => s.type === operationFilter);
    }

    return base;
  }, [filter, salesV2, floatersExtra, operationFilter]);

  const productFilterOptions = React.useMemo(() => {
    const names = new Set<string>();
    for (const s of salesBaseWithoutProductFilter) {
      const n = String(s.productName || "").trim();
      if (n) names.add(n);
    }
    const sorted = Array.from(names).sort((a, b) =>
      a.localeCompare(b, "es"),
    );
    return [
      { value: "", label: "Todos los productos" },
      ...sorted.map((name) => ({ value: name, label: name })),
    ];
  }, [salesBaseWithoutProductFilter]);

  /** Si el producto elegido ya no está en la lista (p. ej. tras cambiar filtros), limpiar. */
  useEffect(() => {
    const pf = productFilter.trim();
    if (!pf) return;
    const ok = productFilterOptions.some((o) => o.value === pf);
    if (!ok) setProductFilter("");
  }, [productFilterOptions, productFilter]);

  // Ventas visibles (con filtro por producto = selección exacta)
  const visibleSales = React.useMemo(() => {
    let base = salesBaseWithoutProductFilter;

    const pf = productFilter.trim();
    if (pf) {
      base = base.filter(
        (s) => String(s.productName || "").trim() === pf,
      );
    }

    return base;
  }, [salesBaseWithoutProductFilter, productFilter]);

  const visibleSalesSorted = React.useMemo(
    () => [...visibleSales].sort(compareSaleNewestFirst),
    [visibleSales],
  );

  // Totales visibles
  const totalCharged = round2(
    visibleSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );
  const totalCOGSVisible = round2(
    visibleSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );
  const grossProfitVisible = round2(totalCharged - totalCOGSVisible);

  const editChanges = React.useMemo(() => {
    if (!editing) return [];
    const changes: { label: string; from: string; to: string }[] = [];
    if (editDate !== editing.date) {
      changes.push({ label: "Fecha", from: editing.date, to: editDate });
    }
    const newQty = parseFloat(editQty) || 0;
    if (round3(newQty) !== round3(editing.quantity)) {
      changes.push({
        label: "Cantidad",
        from: qty3(editing.quantity),
        to: qty3(newQty),
      });
    }
    const oldPrice =
      editing.unitPrice && editing.unitPrice > 0
        ? editing.unitPrice
        : editing.quantity > 0
          ? editing.amount / editing.quantity
          : 0;
    const newPrice = parseFloat(editPrice) || 0;
    if (round2(newPrice) !== round2(oldPrice)) {
      changes.push({
        label: "Precio",
        from: `C$${money(oldPrice)}`,
        to: `C$${money(newPrice)}`,
      });
    }
    const newAmount = round2(newQty * newPrice);
    if (round2(newAmount) !== round2(editing.amount)) {
      changes.push({
        label: "Monto",
        from: `C$${money(editing.amount)}`,
        to: `C$${money(newAmount)}`,
      });
    }
    if (editClient !== editing.clientName) {
      changes.push({
        label: "Cliente",
        from: editing.clientName || "—",
        to: editClient || "—",
      });
    }
    return changes;
  }, [editing, editDate, editQty, editPrice, editClient]);

  const isUnitMeasure = (m?: string) =>
    String(m || "")
      .trim()
      .toLowerCase() !== "lb";

  const cashSales = visibleSalesSorted.filter((s) => s.type === "CONTADO");
  const creditSales = visibleSalesSorted.filter((s) => s.type === "CREDITO");

  const cashTotalPages = Math.max(1, Math.ceil(cashSales.length / PAGE_SIZE));
  const creditTotalPages = Math.max(
    1,
    Math.ceil(creditSales.length / PAGE_SIZE),
  );

  const pagedCashSales = React.useMemo(() => {
    const start = (cashPage - 1) * PAGE_SIZE;
    return cashSales.slice(start, start + PAGE_SIZE);
  }, [cashSales, cashPage]);

  const pagedCreditSales = React.useMemo(() => {
    const start = (creditPage - 1) * PAGE_SIZE;
    return creditSales.slice(start, start + PAGE_SIZE);
  }, [creditSales, creditPage]);

  useEffect(() => {
    setCashPage(1);
    setCreditPage(1);
    setCombinedPage(1);
  }, [visibleSales]);

  useEffect(() => {
    setCashPage((p) => Math.min(p, cashTotalPages));
  }, [cashTotalPages]);

  useEffect(() => {
    setCreditPage((p) => Math.min(p, creditTotalPages));
  }, [creditTotalPages]);

  const showCashTable =
    operationFilter === "ALL" || operationFilter === "CONTADO";
  const showCreditTable =
    operationFilter === "ALL" || operationFilter === "CREDITO";
  const showCombinedTable = operationFilter === "ALL";

  const cashOpenEffective = pdfMode ? true : cashTableOpen;
  const creditOpenEffective = pdfMode ? true : creditTableOpen;
  const combinedOpenEffective = pdfMode ? true : combinedTableOpen;

  const cashRowsForTable = pdfMode ? cashSales : pagedCashSales;
  const creditRowsForTable = pdfMode ? creditSales : pagedCreditSales;

  const totalUnitsCash = round3(
    cashSales
      .filter((s) => isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalLbsCash = round3(
    cashSales
      .filter((s) => !isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalUnitsCredit = round3(
    creditSales
      .filter((s) => isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalLbsCredit = round3(
    creditSales
      .filter((s) => !isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );

  const totalSalesCash = round2(
    cashSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );
  const totalSalesCredit = round2(
    creditSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );

  const totalCOGSCash = round2(
    cashSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );
  const totalCOGSCredit = round2(
    creditSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );

  const grossProfitCash = round2(totalSalesCash - totalCOGSCash);
  const grossProfitCredit = round2(totalSalesCredit - totalCOGSCredit);

  const totalUnitsAll = round3(totalUnitsCash + totalUnitsCredit);
  const totalLbsAll = round3(totalLbsCash + totalLbsCredit);
  const totalSalesAll = round2(totalSalesCash + totalSalesCredit);

  const combinedDailyRows = React.useMemo(() => {
    const map: Record<string, CombinedDailyRow> = {};

    visibleSales.forEach((s) => {
      const productName = s.productName || "(sin nombre)";
      const key = `${s.date || "—"}||${productName}`;
      if (!map[key]) {
        map[key] = {
          date: s.date || "—",
          product: productName,
          totalLbs: 0,
          totalUnits: 0,
          totalAmount: 0,
          totalGross: 0,
        };
      }

      if (isUnitMeasure(s.measurement)) {
        map[key].totalUnits = round3(map[key].totalUnits + (s.quantity || 0));
      } else {
        map[key].totalLbs = round3(map[key].totalLbs + (s.quantity || 0));
      }

      map[key].totalAmount = round2(map[key].totalAmount + (s.amount || 0));
      map[key].totalGross = round2(
        map[key].totalGross + saleGrossProfit(s),
      );
    });

    return Object.values(map).sort((a, b) => {
      const byDate = b.date.localeCompare(a.date);
      if (byDate !== 0) return byDate;
      return String(a.product || "").localeCompare(String(b.product || ""));
    });
  }, [visibleSales]);

  const combinedTotalPages = Math.max(
    1,
    Math.ceil(combinedDailyRows.length / COMBINED_PAGE_SIZE),
  );

  const combinedDailyRowsPaged = React.useMemo(() => {
    const start = (combinedPage - 1) * COMBINED_PAGE_SIZE;
    return combinedDailyRows.slice(start, start + COMBINED_PAGE_SIZE);
  }, [combinedDailyRows, combinedPage]);

  useEffect(() => {
    setCombinedPage((p) => Math.min(p, combinedTotalPages));
  }, [combinedTotalPages]);

  // Consolidado por producto
  const productMap: Record<
    string,
    { totalQuantity: number; totalAmount: number; totalGross: number }
  > = {};
  visibleSales.forEach((s) => {
    const key = s.productName || "(sin nombre)";
    if (!productMap[key])
      productMap[key] = { totalQuantity: 0, totalAmount: 0, totalGross: 0 };
    productMap[key].totalQuantity = round3(
      productMap[key].totalQuantity + (s.quantity || 0),
    );
    productMap[key].totalAmount = round2(
      productMap[key].totalAmount + (s.amount || 0),
    );
    productMap[key].totalGross = round2(
      productMap[key].totalGross + saleGrossProfit(s),
    );
  });

  const productSummaryArray = Object.entries(productMap).map(
    ([productName, v]) => ({
      productName,
      totalQuantity: v.totalQuantity,
      totalAmount: v.totalAmount,
      totalGross: v.totalGross,
    }),
  );

  const totalGrossAll = round2(
    visibleSales.reduce((sum, s) => sum + saleGrossProfit(s), 0),
  );

  // Guardar cierre (misma lógica tuya)
  const handleSaveClosure = async () => {
    try {
      const candidatesVisible = visibleSales.filter(
        (s) => s.status === "FLOTANTE",
      );
      const toProcess =
        candidatesVisible.length > 0
          ? candidatesVisible
          : salesV2.filter((s) => s.status !== "PROCESADA");

      if (toProcess.length === 0) {
        setMessage("No hay ventas para procesar.");
        return;
      }

      const totals = {
        totalCharged: round2(
          toProcess.reduce((a, s) => a + (s.amount || 0), 0),
        ),
        totalSuggested: round2(
          toProcess.reduce((a, s) => a + (s.amountSuggested || 0), 0),
        ),
        totalUnits: round3(
          toProcess.reduce((a, s) => a + (s.quantity || 0), 0),
        ),
        totalCOGS: round2(
          toProcess.reduce((a, s) => a + Number(s.cogsAmount ?? 0), 0),
        ),
      };

      const diff = round2(totals.totalCharged - totals.totalSuggested);
      const grossProfit = round2(totals.totalCharged - totals.totalCOGS);

      const ref = await addDoc(collection(db, "daily_closures"), {
        date: today,
        createdAt: Timestamp.now(),
        periodStart: startDate,
        periodEnd: endDate,
        totalCharged: totals.totalCharged,
        totalSuggested: totals.totalSuggested,
        totalDifference: diff,
        totalUnits: totals.totalUnits,
        totalCOGS: totals.totalCOGS,
        grossProfit,
        products: toProcess.map((s) => ({
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
        })),
        salesV2: toProcess.map((s) => ({
          id: s.id,
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
          amountSuggested: s.amountSuggested,
          userEmail: s.userEmail,
          clientName: s.clientName,
          amountReceived: s.amountReceived,
          change: s.change,
          status: s.status,
          cogsAmount: s.cogsAmount ?? 0,
          avgUnitCost: s.avgUnitCost ?? null,
          allocations: s.allocations ?? [],
          date: s.date,
        })),
        productSummary: Object.entries(
          toProcess.reduce(
            (acc, s) => {
              const k = s.productName || "(sin nombre)";
              if (!acc[k]) acc[k] = { totalQuantity: 0, totalAmount: 0 };
              acc[k].totalQuantity = round3(
                acc[k].totalQuantity + (s.quantity || 0),
              );
              acc[k].totalAmount = round2(acc[k].totalAmount + (s.amount || 0));
              return acc;
            },
            {} as Record<
              string,
              { totalQuantity: number; totalAmount: number }
            >,
          ),
        ).map(([productName, v]) => ({
          productName,
          totalQuantity: v.totalQuantity,
          totalAmount: v.totalAmount,
        })),
      });

      const batch = writeBatch(db);
      toProcess.forEach((s) => {
        batch.update(doc(db, "salesV2", s.id.split("#")[0]), {
          status: "PROCESADA",
          closureId: ref.id,
          closureDate: today,
          date: s.date, // ✅ corrige el date malo
        });
      });
      await batch.commit();

      setMessage(`✅ Cierre guardado. Ventas procesadas: ${toProcess.length}.`);
    } catch (error) {
      console.error(error);
      setMessage("❌ Error al guardar el cierre.");
    }
  };

  const handleRevert = async (saleId: string) => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para revertir esta venta.");
      return;
    }
    if (
      !window.confirm("¿Revertir esta venta? Esta acción no se puede deshacer.")
    )
      return;

    try {
      await updateDoc(doc(db, "salesV2", saleId.split("#")[0]), {
        status: "FLOTANTE",
        closureId: null,
        closureDate: null,
      });
      setMessage("↩️ Venta revertida a FLOTANTE.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo revertir la venta.");
    }
  };

  const openEdit = (s: SaleData) => {
    if (!canEditSale) {
      setMessage("❌ No tienes permisos para editar esta venta.");
      return;
    }
    setRowActionMenu(null);
    setEditing(s);
    setEditDate(s.date);
    setEditQty(String(s.quantity));
    const price =
      s.unitPrice && s.unitPrice > 0
        ? s.unitPrice
        : s.quantity > 0
          ? s.amount / s.quantity
          : 0;
    setEditPrice(String(price));
    setEditClient(s.clientName);
    setEditConfirm(false);
    setEditSaving(false);
    setEditMinDate("");

    (async () => {
      const allocs = s.allocations || [];
      if (!allocs.length) return;
      let maxDate = "";
      for (const a of allocs) {
        try {
          const snap = await getDoc(
            doc(db, "inventory_batches", a.batchId),
          );
          if (snap.exists()) {
            const d = String((snap.data() as any).date ?? "");
            if (d && d > maxDate) maxDate = d;
          }
        } catch (_) {
          /* lote eliminado */
        }
      }
      setEditMinDate(maxDate);
    })();
  };

  const saveEdit = async () => {
    if (!canEditSale || !editing) return;

    const qty = round3(parseFloat(editQty) || 0);
    const price = round2(parseFloat(editPrice) || 0);
    if (qty <= 0) {
      setMessage("❌ La cantidad debe ser mayor a 0.");
      return;
    }
    if (price <= 0) {
      setMessage("❌ El precio debe ser mayor a 0.");
      return;
    }
    if (editMinDate && editDate < editMinDate) {
      setMessage(
        `❌ La fecha no puede ser anterior a ${editMinDate} (fecha del lote).`,
      );
      return;
    }

    const newAmount = round2(qty * price);
    const docId = editing.id.split("#")[0];
    const itemIdx = editing.id.includes("#")
      ? parseInt(editing.id.split("#")[1])
      : null;
    const qtyChanged = round3(qty) !== round3(editing.quantity);

    setEditSaving(true);
    try {
      const saleRef = doc(db, "salesV2", docId);
      const editorEmail = auth.currentUser?.email || "admin";

      if (qtyChanged) {
        const productName = editing.productName;
        const batchQ = query(
          collection(db, "inventory_batches"),
          where("productName", "==", productName),
        );
        const batchSnap = await getDocs(batchQ);
        const batchDocIds = batchSnap.docs
          .map((d) => ({
            id: d.id,
            date: ((d.data() as any).date ?? "") as string,
            createdSec: (d.data() as any).createdAt?.seconds ?? 0,
          }))
          .sort((a, b) => {
            if (a.date !== b.date) return a.date < b.date ? -1 : 1;
            return a.createdSec - b.createdSec;
          });
        const batchRefs = batchDocIds.map((b) =>
          doc(db, "inventory_batches", b.id),
        );

        await runTransaction(db, async (tx) => {
          const saleSnap = await tx.get(saleRef);
          if (!saleSnap.exists()) throw new Error("La venta no existe.");
          const saleData = saleSnap.data() as any;

          const batchTxSnaps = await Promise.all(
            batchRefs.map((ref) => tx.get(ref)),
          );

          let oldAllocs: { batchId: string; qty: number }[] = [];
          if (itemIdx !== null && Array.isArray(saleData.items)) {
            const item = saleData.items[itemIdx];
            if (Array.isArray(item?.allocations)) {
              oldAllocs = item.allocations.map((a: any) => ({
                batchId: String(a.batchId),
                qty: Number(a.qty),
              }));
            }
          } else {
            if (Array.isArray(saleData.allocations)) {
              oldAllocs = saleData.allocations.map((a: any) => ({
                batchId: String(a.batchId),
                qty: Number(a.qty),
              }));
            }
          }

          const oldByBatch = new Map<string, number>();
          for (const a of oldAllocs) {
            oldByBatch.set(
              a.batchId,
              (oldByBatch.get(a.batchId) || 0) + a.qty,
            );
          }

          const batchRemaining = new Map<string, number>();
          const batchCost = new Map<string, number>();
          for (let i = 0; i < batchRefs.length; i++) {
            if (!batchTxSnaps[i].exists()) continue;
            const data = batchTxSnaps[i].data() as any;
            let rem = Number(data.remaining ?? 0);
            const restore = oldByBatch.get(batchRefs[i].id) || 0;
            rem = Number((rem + restore).toFixed(3));
            batchRemaining.set(batchRefs[i].id, rem);
            batchCost.set(batchRefs[i].id, Number(data.purchasePrice ?? 0));
          }

          let need = qty;
          const newAllocs: {
            batchId: string;
            qty: number;
            unitCost: number;
            lineCost: number;
          }[] = [];

          for (const b of batchDocIds) {
            if (need <= 0) break;
            const rem = batchRemaining.get(b.id) || 0;
            if (rem <= 0) continue;
            const take = Math.min(rem, need);
            const cost = batchCost.get(b.id) || 0;
            batchRemaining.set(b.id, Number((rem - take).toFixed(3)));
            newAllocs.push({
              batchId: b.id,
              qty: take,
              unitCost: cost,
              lineCost: Number((take * cost).toFixed(2)),
            });
            need = Number((need - take).toFixed(3));
          }

          if (need > 0) {
            throw new Error(
              `Stock insuficiente. Faltan ${need.toFixed(3)} unidades.`,
            );
          }

          for (let i = 0; i < batchRefs.length; i++) {
            if (!batchTxSnaps[i].exists()) continue;
            const origRem = Number(
              (batchTxSnaps[i].data() as any).remaining ?? 0,
            );
            const newRem = batchRemaining.get(batchRefs[i].id);
            if (
              newRem !== undefined &&
              Math.abs(origRem - newRem) > 0.0005
            ) {
              tx.update(batchRefs[i], { remaining: newRem });
            }
          }

          const cogsAmount = Number(
            newAllocs
              .reduce((acc, x) => acc + x.lineCost, 0)
              .toFixed(2),
          );
          const qtySum = newAllocs.reduce((acc, x) => acc + x.qty, 0);
          const avgUnitCost =
            qtySum > 0 ? Number((cogsAmount / qtySum).toFixed(4)) : 0;

          let maxBatchDate = "";
          for (const a of newAllocs) {
            const idx2 = batchDocIds.findIndex((b) => b.id === a.batchId);
            if (idx2 >= 0) {
              const d = batchDocIds[idx2].date;
              if (d > maxBatchDate) maxBatchDate = d;
            }
          }
          if (maxBatchDate && editDate < maxBatchDate) {
            throw new Error(
              `La fecha no puede ser anterior a ${maxBatchDate} (fecha del lote asignado).`,
            );
          }

          if (itemIdx !== null && Array.isArray(saleData.items)) {
            const items = [...saleData.items];
            const lineGross = round2(newAmount - cogsAmount);
            items[itemIdx] = {
              ...items[itemIdx],
              qty,
              unitPrice: price,
              lineFinal: newAmount,
              allocations: newAllocs,
              cogsAmount,
              avgUnitCost,
              grossProfit: lineGross,
            };
            const totalAmt = items.reduce(
              (sum: number, it: any) => sum + Number(it.lineFinal ?? 0),
              0,
            );
            const grossProfitTotal = round2(
              items.reduce(
                (sum: number, it: any) =>
                  sum +
                  (Number.isFinite(Number(it.grossProfit))
                    ? Number(it.grossProfit)
                    : Number(it.lineFinal ?? 0) -
                      Number(it.cogsAmount ?? 0)),
                0,
              ),
            );
            tx.update(saleRef, {
              items,
              amount: round2(totalAmt),
              amountCharged: round2(totalAmt),
              grossProfitTotal,
              clientName: editClient,
              date: editDate,
              edited: true,
              editedAt: Timestamp.now(),
              editedBy: editorEmail,
            });
          } else {
            tx.update(saleRef, {
              quantity: qty,
              unitPrice: price,
              amount: newAmount,
              amountCharged: newAmount,
              clientName: editClient,
              date: editDate,
              allocations: newAllocs,
              cogsAmount,
              avgUnitCost,
              grossProfit: round2(newAmount - cogsAmount),
              edited: true,
              editedAt: Timestamp.now(),
              editedBy: editorEmail,
            });
          }
        });
      } else {
        const editorEmail = auth.currentUser?.email || "admin";
        if (itemIdx !== null) {
          const saleSnap = await getDoc(saleRef);
          if (!saleSnap.exists()) throw new Error("La venta no existe.");
          const saleData = saleSnap.data() as any;
          const items = [...(saleData.items || [])];
          if (items[itemIdx]) {
            const prevCogs = Number(items[itemIdx].cogsAmount ?? 0);
            items[itemIdx] = {
              ...items[itemIdx],
              unitPrice: price,
              lineFinal: newAmount,
              grossProfit: round2(newAmount - prevCogs),
            };
          }
          const totalAmt = items.reduce(
            (sum: number, it: any) => sum + Number(it.lineFinal ?? 0),
            0,
          );
          const grossProfitTotal = round2(
            items.reduce(
              (sum: number, it: any) =>
                sum +
                (Number.isFinite(Number(it.grossProfit))
                  ? Number(it.grossProfit)
                  : Number(it.lineFinal ?? 0) - Number(it.cogsAmount ?? 0)),
              0,
            ),
          );
          await updateDoc(saleRef, {
            items,
            amount: round2(totalAmt),
            amountCharged: round2(totalAmt),
            grossProfitTotal,
            clientName: editClient,
            date: editDate,
            edited: true,
            editedAt: Timestamp.now(),
            editedBy: editorEmail,
          });
        } else {
          const saleSnap = await getDoc(saleRef);
          const prevCogs = saleSnap.exists()
            ? Number((saleSnap.data() as any).cogsAmount ?? 0)
            : 0;
          await updateDoc(saleRef, {
            unitPrice: price,
            amount: newAmount,
            amountCharged: newAmount,
            grossProfit: round2(newAmount - prevCogs),
            clientName: editClient,
            date: editDate,
            edited: true,
            editedAt: Timestamp.now(),
            editedBy: editorEmail,
          });
        }
      }

      const editorEmailLog = auth.currentUser?.email || "admin";
      const oldPrice =
        editing.unitPrice && editing.unitPrice > 0
          ? editing.unitPrice
          : editing.quantity > 0
            ? editing.amount / editing.quantity
            : 0;
      await addDoc(collection(db, "transaction_edition_logs"), {
        saleId: docId,
        saleItemIndex: itemIdx,
        productName: editing.productName,
        editedBy: editorEmailLog,
        editedAt: Timestamp.now(),
        before: {
          date: editing.date,
          quantity: editing.quantity,
          unitPrice: round2(oldPrice),
          amount: editing.amount,
          clientName: editing.clientName || "",
        },
        after: {
          date: editDate,
          quantity: qty,
          unitPrice: price,
          amount: newAmount,
          clientName: editClient,
        },
        changes: editChanges.map((c) => ({
          field: c.label,
          from: c.from,
          to: c.to,
        })),
        quantityChanged: qtyChanged,
      }).catch((err) => console.error("Error guardando log de edición:", err));

      setEditing(null);
      setEditConfirm(false);
      setMessage("✅ Venta actualizada correctamente.");
    } catch (e: any) {
      console.error(e);
      setMessage(
        `❌ ${e?.message || "No se pudo actualizar la venta."}`,
      );
    } finally {
      setEditSaving(false);
    }
  };

  const deleteSale = async (saleId: string) => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para eliminar esta venta.");
      return;
    }
    if (
      !window.confirm(
        "¿Eliminar esta venta? Se restaurará el stock en los lotes asignados.",
      )
    )
      return;

    try {
      const { restored } = await restoreSaleAndDelete(saleId.split("#")[0]);
      setMessage(
        `🗑️ Venta eliminada. Stock restaurado: ${Number(restored).toFixed(2)}.`,
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar la venta.");
    }
  };

  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;

    // ✅ fuerza modo PDF (muestra tabla desktop aunque estés en móvil)
    pdfRef.current.classList.add("force-pdf-colors");
    pdfRef.current.classList.add("pdf-print-mode");
    setPdfMode(true);

    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_${today}.pdf`);
    } finally {
      pdfRef.current.classList.remove("pdf-print-mode");
      pdfRef.current.classList.remove("force-pdf-colors");
      setPdfMode(false);
    }
  };

  const exportToXLSX = () => {
    try {
      const data = visibleSalesSorted.map((s) => ({
        Estado: s.status,
        Fecha_ingreso: s.createdAt || "",
        Fecha_venta: s.date,
        Tipo: s.type === "CREDITO" ? "Crédito" : "Cash",
        Producto: s.productName,
        "Libras - Unidad": s.quantity,
        Monto: s.amount,
        U_Bruta: saleGrossProfit(s),
        Vendedor: displaySeller(s.userEmail),
      }));

      const ws = XLSX.utils.json_to_sheet(data);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Transacciones");
      XLSX.writeFile(wb, `transacciones_${startDate}_to_${endDate}.xlsx`);
    } catch (e) {
      console.error("Error exporting XLSX:", e);
      setMessage("❌ Error al exportar XLSX.");
    }
  };

  const renderProPager = (
    page: number,
    totalPages: number,
    onPage: (p: number) => void,
    totalItems: number,
  ) => {
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
          <Button
            variant="outline"
            size="sm"
            className="!px-2 !py-1"
            onClick={() => onPage(1)}
            disabled={page === 1}
          >
            « Primero
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="!px-2 !py-1"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page === 1}
          >
            ‹ Anterior
          </Button>
          {pages.map((p, idx) =>
            typeof p === "number" ? (
              <Button
                key={idx}
                variant={p === page ? "primary" : "outline"}
                size="sm"
                className="!px-3 !py-1 min-w-[2.25rem]"
                onClick={() => onPage(p)}
              >
                {p}
              </Button>
            ) : (
              <span key={idx} className="px-2">
                …
              </span>
            ),
          )}
          <Button
            variant="outline"
            size="sm"
            className="!px-2 !py-1"
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
          >
            Siguiente ›
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="!px-2 !py-1"
            onClick={() => onPage(totalPages)}
            disabled={page === totalPages}
          >
            Último »
          </Button>
        </div>
        <div className="text-sm text-gray-600">
          Página {page} de {totalPages} • {totalItems} registro(s)
        </div>
      </div>
    );
  };

  const renderSalesTable = (
    rows: SaleData[],
    allRowsForTotals?: SaleData[],
  ) => {
    const totalsSrc = allRowsForTotals ?? rows;
    const totalQty = round3(
      totalsSrc.reduce((sum, s) => sum + (s.quantity || 0), 0),
    );
    const totalAmount = round2(
      totalsSrc.reduce((sum, s) => sum + (s.amount || 0), 0),
    );
    const totalGross = round2(
      totalsSrc.reduce((sum, s) => sum + saleGrossProfit(s), 0),
    );
    const showAllPagesHint =
      totalsSrc.length > rows.length && rows.length > 0;

    return (
      <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr className="text-[11px] uppercase tracking-wider text-slate-600">
              <th className="p-3 border-b text-left">Estado</th>
              <th className="p-3 border-b text-left">Fecha ingreso</th>
              <th className="p-3 border-b text-left">Fecha venta</th>
              <th className="p-3 border-b text-left">Tipo</th>
              <th className="p-3 border-b text-left">Producto</th>
              <th className="p-3 border-b text-right">Precio</th>
              <th className="p-3 border-b text-right">Lbs/Und</th>
              <th className="p-3 border-b text-right">Monto</th>
              <th className="p-3 border-b text-right">U.Bruta</th>
              <th className="p-3 border-b text-left">Vendedor</th>
              <th className="p-3 border-b text-center w-10"></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr
                key={s.id}
                className="text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition"
              >
                <td className="p-3 border-b text-left">
                  <div className="flex items-center gap-1 flex-wrap">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        s.status === "PROCESADA"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                      title={s.status}
                      aria-label={s.status}
                    >
                      {s.status === "PROCESADA" ? (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414-1.414L8 11.172 4.707 7.879a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8z" clipRule="evenodd" />
                        </svg>
                      ) : (
                        <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                          <path d="M6 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1zM14 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1z" />
                        </svg>
                      )}
                    </span>
                    {s.edited && (
                      <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-medium">
                        Editada
                      </span>
                    )}
                  </div>
                </td>
                <td className="p-3 border-b text-left">{s.createdAt || "—"}</td>
                <td className="p-3 border-b text-left">{s.date}</td>
                <td className="p-3 border-b text-left">
                  {s.type === "CREDITO" ? "Crédito" : "Cash"}
                </td>
                <td className="p-3 border-b text-left">{s.productName}</td>
                <td className="p-3 border-b text-right">
                  C${money(s.unitPrice && s.unitPrice > 0 ? s.unitPrice : s.quantity > 0 ? s.amount / s.quantity : 0)}
                </td>
                <td className="p-3 border-b text-right">{qty3(s.quantity)}</td>
                <td className="p-3 border-b text-right">C${money(s.amount)}</td>
                <td className="p-3 border-b text-right tabular-nums">
                  C${money(saleGrossProfit(s))}
                </td>
                <td className="p-3 border-b text-left">
                  {displaySeller(s.userEmail)}
                </td>
                <td className="p-3 border-b text-center">
                  {canEditSale ? (
                    <ActionMenuTrigger
                      className="!h-8 !w-8"
                      title="Acciones"
                      aria-label="Acciones"
                      onClick={(e) => {
                        const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                        setRowActionMenu({ rect, sale: s });
                      }}
                    />
                  ) : (
                    <span className="text-gray-400 text-xs">—</span>
                  )}
                </td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={11} className="p-3 text-center text-gray-500">
                  Sin ventas para mostrar.
                </td>
              </tr>
            )}

            {rows.length > 0 && (
              <tr className="text-center bg-slate-100/70">
                <td
                  colSpan={6}
                  className="p-3 border-b text-left font-semibold"
                >
                  <span>Totales</span>
                  {showAllPagesHint ? (
                    <span className="block text-[10px] font-normal text-slate-500 mt-0.5">
                      Incluye todas las páginas
                    </span>
                  ) : null}
                </td>
                <td className="p-3 border-b text-right font-semibold">
                  {qty3(totalQty)}
                </td>
                <td className="p-3 border-b text-right font-semibold">
                  C${money(totalAmount)}
                </td>
                <td className="p-3 border-b text-right font-semibold tabular-nums">
                  C${money(totalGross)}
                </td>
                <td colSpan={2} />
              </tr>
            )}
          </tbody>
        </table>
      </div>
    );
  };

  const renderCombinedDailyTable = (
    rows: CombinedDailyRow[],
    allRowsForTotals?: CombinedDailyRow[],
  ) => {
    const totalsSrc = allRowsForTotals ?? rows;
    const showAllPagesHint =
      totalsSrc.length > rows.length && rows.length > 0;

    return (
    <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
      <table className="min-w-full w-full text-sm">
        <thead className="bg-slate-100 sticky top-0 z-10">
          <tr className="text-[11px] uppercase tracking-wider text-slate-600">
            <th className="p-3 border-b text-left">Fecha venta</th>
            <th className="p-3 border-b text-left">Producto</th>
            <th className="p-3 border-b text-right">Libras</th>
            <th className="p-3 border-b text-right">Unidades</th>
            <th className="p-3 border-b text-right">Monto</th>
            <th className="p-3 border-b text-right">U.Bruta</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr
              key={`${r.date}||${r.product}`}
              className="text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition"
            >
              <td className="p-3 border-b text-left">{r.date}</td>
              <td className="p-3 border-b text-left">
                {r.product || "(sin nombre)"}
              </td>
              <td className="p-3 border-b text-right">{qty3(r.totalLbs)}</td>
              <td className="p-3 border-b text-right">{qty3(r.totalUnits)}</td>
              <td className="p-3 border-b text-right">
                C${money(r.totalAmount)}
              </td>
              <td className="p-3 border-b text-right tabular-nums">
                C${money(r.totalGross)}
              </td>
            </tr>
          ))}

          {rows.length > 0 && (
            <tr className="text-center bg-slate-100/70">
              <td colSpan={2} className="p-3 border-b text-left font-semibold">
                <span>Totales</span>
                {showAllPagesHint ? (
                  <span className="block text-[10px] font-normal text-slate-500 mt-0.5">
                    Incluye todas las páginas
                  </span>
                ) : null}
              </td>
              <td className="p-3 border-b text-right font-semibold">
                {qty3(totalsSrc.reduce((sum, r) => sum + r.totalLbs, 0))}
              </td>
              <td className="p-3 border-b text-right font-semibold">
                {qty3(totalsSrc.reduce((sum, r) => sum + r.totalUnits, 0))}
              </td>
              <td className="p-3 border-b text-right font-semibold">
                C${money(totalsSrc.reduce((sum, r) => sum + r.totalAmount, 0))}
              </td>
              <td className="p-3 border-b text-right font-semibold tabular-nums">
                C${money(totalsSrc.reduce((sum, r) => sum + r.totalGross, 0))}
              </td>
            </tr>
          )}

          {rows.length === 0 && (
            <tr>
              <td colSpan={6} className="p-3 text-center text-gray-500">
                Sin ventas para mostrar.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
    );
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      {/* ✅ CSS interno para alternar vista en PDF (compat con mobile cards) */}
      <style>{`
        .pdf-print-mode .pdf-desktop { display: block !important; }
        .pdf-print-mode .pdf-mobile  { display: none !important; }
      `}</style>

      <div className="flex items-start justify-between gap-3 mb-4">
        <h2 className="text-lg font-bold">
          Ventas Diarias
        </h2>

        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} />
          <ActionMenuTrigger
            title="Más acciones"
            aria-label="Más acciones"
            className="!h-10 !w-10"
            onClick={(e) => {
              setRowActionMenu(null);
              setHeaderToolsMenuRect(
                e.currentTarget.getBoundingClientRect(),
              );
            }}
          />
        </div>

        <ActionMenu
          anchorRect={headerToolsMenuRect}
          isOpen={!!headerToolsMenuRect}
          onClose={() => setHeaderToolsMenuRect(null)}
          width={220}
        >
          <div className="py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
              disabled={!cierreVentas}
              onClick={() => {
                setHeaderToolsMenuRect(null);
                void handleSaveClosure();
              }}
            >
              Cerrar ventas del día
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
              onClick={() => {
                setHeaderToolsMenuRect(null);
                exportToXLSX();
              }}
            >
              Exportar transacciones (XLSX)
            </Button>
          </div>
        </ActionMenu>
      </div>

      {/* ✅ FILTROS (colapsable, nace cerrado) */}
      <div className="mb-4">
        <SectionHeader
          title="Filtros"
          open={filtersOpen}
          onToggle={() => setFiltersOpen((v) => !v)}
          right={
            <span className="ml-1">
              {startDate} → {endDate}
              {filter !== "ALL" ? ` • ${filter}` : ""}
              {operationFilter !== "ALL"
                ? ` • ${operationFilter === "CREDITO" ? "Crédito" : "Cash"}`
                : ""}
              {productFilter.trim()
                ? ` • ${productFilter.trim()}`
                : ""}
            </span>
          }
        />

        {filtersOpen && (
          <div className="mt-3 border rounded-xl p-3 bg-white">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Periodo desde</label>
                <input
                  type="date"
                  className="border rounded px-2 py-2 w-full"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Hasta</label>
                <input
                  type="date"
                  className="border rounded px-2 py-2 w-full"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <MobileHtmlSelect
                  label="Estado"
                  value={filter}
                  onChange={(v) => setFilter(v as any)}
                  options={[
                    { value: "ALL", label: "Todas" },
                    { value: "FLOTANTE", label: "Venta Flotante" },
                    { value: "PROCESADA", label: "Venta Procesada" },
                  ]}
                  selectClassName="border rounded px-2 py-2 w-full"
                  sheetTitle="Estado"
                />
              </div>

              <div className="flex flex-col gap-1">
                <MobileHtmlSelect
                  label="Tipo Operación"
                  value={operationFilter}
                  onChange={(v) => setOperationFilter(v as any)}
                  options={[
                    { value: "ALL", label: "Todos" },
                    { value: "CREDITO", label: "Crédito" },
                    { value: "CONTADO", label: "Cash" },
                  ]}
                  selectClassName="border rounded px-2 py-2 w-full"
                  sheetTitle="Tipo operación"
                />
              </div>

              <div className="flex flex-col gap-1">
                <MobileHtmlSelect
                  label="Producto"
                  value={productFilter}
                  onChange={setProductFilter}
                  options={productFilterOptions}
                  sheetTitle="Producto"
                  selectClassName="border rounded px-2 py-2 w-full"
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          {/* =========================
              DESKTOP / WEB -> TABLA (igual que antes)
              ========================= */}
          <div className="pdf-desktop hidden md:block">
            <div className="space-y-6">
              {showCashTable && (
                <div className="mt-8">
                  <div className="mb-6">
                    <SectionHeader
                      title="Indicadores financieros"
                      open={pdfMode ? true : indicadoresOpen}
                      onToggle={() => setIndicadoresOpen((v) => !v)}
                      right={
                        <span className="ml-1">
                          Ventas C${money(totalSalesAll)} • U.B. C$
                          {money(totalGrossAll)}
                        </span>
                      }
                    />

                    {(pdfMode || indicadoresOpen) && (
                      <div className="mt-3">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Card 1: Libras & Unidades (cash / credito) */}
                          <div className="p-4 rounded-lg border bg-blue-50 border-blue-200">
                            <div className="text-sm font-semibold text-blue-800">
                              Libras / Unidades
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras Cash
                                </div>
                                <div className="text-xl font-bold text-blue-800">
                                  {qty3(totalLbsCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras Credito
                                </div>
                                <div className="text-xl font-bold text-amber-800">
                                  {qty3(totalLbsCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades Cash
                                </div>
                                <div className="text-xl font-bold text-green-800">
                                  {qty3(totalUnitsCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades Credito
                                </div>
                                <div className="text-xl font-bold text-amber-800">
                                  {qty3(totalUnitsCredit)}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Card 2: Facturado / Vendido / Utilidad bruta */}
                          <div className="p-4 rounded-lg border bg-amber-50 border-amber-200">
                            <div className="text-sm font-semibold text-amber-800">
                              Facturado / Vendido / Utilidad
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Facturado Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-800">
                                  C${money(totalCOGSCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Facturado Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-800">
                                  C${money(totalCOGSCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Vendido Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-900">
                                  C${money(totalSalesCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Vendido Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-900">
                                  C${money(totalSalesCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Utilidad bruta Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-900">
                                  C${money(grossProfitCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Utilidad bruta Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-900">
                                  C${money(grossProfitCredit)}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Card 3: Totales */}
                          <div className="p-4 rounded-lg border bg-indigo-50 border-indigo-200">
                            <div className="text-sm font-semibold text-indigo-800">
                              Totales
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Total facturado (precio compra)
                                </div>
                                <div className="mt-1 text-xl font-bold text-emerald-900">
                                  C${money(totalCOGSVisible)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Ventas total (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-amber-900">
                                  C${money(totalSalesAll)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras totales (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-blue-800">
                                  {qty3(totalLbsAll)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades totales (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-green-800">
                                  {qty3(totalUnitsAll)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border md:col-span-2">
                                <div className="text-xs text-slate-600">
                                  Utilidad bruta total (venta − costo, periodo
                                  filtrado)
                                </div>
                                <div className="mt-1 text-xl font-bold text-violet-900">
                                  C${money(totalGrossAll)}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4">
                    <SectionHeader
                      title="Consolidado por producto"
                      open={consolidadoOpen}
                      onToggle={() => setConsolidadoOpen((v) => !v)}
                      right={
                        <span className="ml-1">
                          {productSummaryArray.length}
                        </span>
                      }
                    />

                    {consolidadoOpen && (
                      <div className="mt-3">
                        <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
                          <table className="min-w-full w-full text-sm">
                            <thead className="bg-slate-100 sticky top-0 z-10">
                              <tr className="text-[11px] uppercase tracking-wider text-slate-600">
                                <th className="p-3 border-b text-left">
                                  Producto
                                </th>
                                <th className="p-3 border-b text-right">
                                  Total libras/unidades
                                </th>
                                <th className="p-3 border-b text-right">
                                  Total dinero
                                </th>
                                <th className="p-3 border-b text-right">
                                  U.Bruta
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {productSummaryArray.map((row) => (
                                <tr
                                  key={row.productName}
                                  className="text-center odd:bg-white even:bg-slate-50"
                                >
                                  <td className="p-3 border-b text-left">
                                    {row.productName}
                                  </td>
                                  <td className="p-3 border-b text-right">
                                    {qty3(row.totalQuantity)}
                                  </td>
                                  <td className="p-3 border-b text-right">
                                    C${money(row.totalAmount)}
                                  </td>
                                  <td className="p-3 border-b text-right tabular-nums">
                                    C${money(row.totalGross)}
                                  </td>
                                </tr>
                              ))}
                              {productSummaryArray.length > 0 && (
                                <tr className="text-center bg-slate-100/70">
                                  <td className="p-3 border-b text-left font-semibold">
                                    Totales
                                  </td>
                                  <td className="p-3 border-b text-right font-semibold">
                                    Lbs: {qty3(totalLbsAll)} • Und:{" "}
                                    {qty3(totalUnitsAll)}
                                  </td>
                                  <td className="p-3 border-b text-right font-semibold">
                                    C${money(totalSalesAll)}
                                  </td>
                                  <td className="p-3 border-b text-right font-semibold tabular-nums">
                                    C${money(totalGrossAll)}
                                  </td>
                                </tr>
                              )}
                              {productSummaryArray.length === 0 && (
                                <tr>
                                  <td
                                    colSpan={4}
                                    className="p-3 text-center text-gray-500"
                                  >
                                    Sin datos para consolidar.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>

                  {showCombinedTable && (
                    <div className="mt-6">
                      <div className="flex items-center justify-between mb-3">
                        <div className="text-sm font-semibold text-slate-700">
                          Transacciones Contado + Crédito
                        </div>
                        <div className="flex items-center gap-2">
                          <div className="text-xs text-slate-500">
                            {combinedDailyRows.length} día(s)
                          </div>
                          <Button
                            type="button"
                            size="sm"
                            variant="primary"
                            onClick={() => setCombinedTableOpen((v) => !v)}
                            className={`text-xs !px-3 !py-1.5 !font-semibold ${
                              combinedOpenEffective
                                ? "!bg-rose-600 hover:!bg-rose-700 !border-rose-600"
                                : "!bg-blue-600 hover:!bg-blue-700 !border-blue-600"
                            }`}
                          >
                            {combinedOpenEffective ? "Cerrar" : "Ver"}
                          </Button>
                        </div>
                      </div>

                      {combinedOpenEffective && (
                        <>
                          {renderCombinedDailyTable(
                            pdfMode ? combinedDailyRows : combinedDailyRowsPaged,
                            combinedDailyRows,
                          )}
                          {!pdfMode &&
                            renderProPager(
                              combinedPage,
                              combinedTotalPages,
                              setCombinedPage,
                              combinedDailyRows.length,
                            )}
                        </>
                      )}
                    </div>
                  )}

                  <div className="mt-6 flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold text-slate-700">
                      Contado
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-slate-500">
                        {cashSales.length} registro(s)
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => setCashTableOpen((v) => !v)}
                        className={`text-xs !px-3 !py-1.5 !font-semibold ${
                          cashOpenEffective
                            ? "!bg-rose-600 hover:!bg-rose-700 !border-rose-600"
                            : "!bg-emerald-600 hover:!bg-emerald-700 !border-emerald-600"
                        }`}
                      >
                        {cashOpenEffective ? "Cerrar" : "Ver"}
                      </Button>
                    </div>
                  </div>
                  {cashOpenEffective && (
                    <>
                      {renderSalesTable(cashRowsForTable, cashSales)}
                      {!pdfMode &&
                        renderProPager(
                          cashPage,
                          cashTotalPages,
                          setCashPage,
                          cashSales.length,
                        )}
                    </>
                  )}
                </div>
              )}

              {showCreditTable && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold text-slate-700">
                      Crédito
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-slate-500">
                        {creditSales.length} registro(s)
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="primary"
                        onClick={() => setCreditTableOpen((v) => !v)}
                        className={`text-xs !px-3 !py-1.5 !font-semibold ${
                          creditOpenEffective
                            ? "!bg-rose-600 hover:!bg-rose-700 !border-rose-600"
                            : "!bg-amber-500 hover:!bg-amber-600 !border-amber-500"
                        }`}
                      >
                        {creditOpenEffective ? "Cerrar" : "Ver"}
                      </Button>
                    </div>
                  </div>
                  {creditOpenEffective && (
                    <>
                      {renderSalesTable(creditRowsForTable, creditSales)}
                      {!pdfMode &&
                        renderProPager(
                          creditPage,
                          creditTotalPages,
                          setCreditPage,
                          creditSales.length,
                        )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* =========================
              MOBILE / PWA -> CONTENEDOR "VENTAS" COLAPSADO
              ========================= */}
          <div className="pdf-mobile md:hidden mb-4">
            <SectionHeader
              title="Ventas"
              open={ventasOpen}
              onToggle={() => setVentasOpen((v) => !v)}
              right={
                <span className="ml-1">
                  {visibleSales.length} • C${money(totalCharged)} • U.B. C$
                  {money(totalGrossAll)}
                </span>
              }
            />

            {ventasOpen && (
              <div className="mt-3 space-y-3">
                {visibleSalesSorted.map((s) => (
                  <details
                    key={s.id}
                    className="border rounded-xl bg-white shadow-sm"
                  >
                    <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {s.productName}
                        </div>
                        <div className="text-xs text-gray-500 flex items-center gap-1.5 mt-0.5">
                          {s.date}
                          {s.edited && (
                            <span className="px-1.5 py-0.5 rounded text-[10px] bg-amber-100 text-amber-700 font-medium">
                              Editada
                            </span>
                          )}
                        </div>
                      </div>

                      <div className="text-right shrink-0 ml-3">
                        <div className="font-bold">C${money(s.amount)}</div>
                        <div className="text-xs text-violet-800 font-semibold">
                          U.B. C${money(saleGrossProfit(s))}
                        </div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            s.status === "PROCESADA"
                              ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700"
                          }`}
                          title={s.status}
                          aria-label={s.status}
                        >
                          {s.status === "PROCESADA" ? (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path fillRule="evenodd" d="M16.707 5.293a1 1 0 00-1.414-1.414L8 11.172 4.707 7.879a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8z" clipRule="evenodd" />
                            </svg>
                          ) : (
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4 inline" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
                              <path d="M6 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1zM14 4a1 1 0 011 1v10a1 1 0 11-2 0V5a1 1 0 011-1z" />
                            </svg>
                          )}
                        </span>
                      </div>
                    </summary>

                      <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Cantidad</span>
                        <strong>{qty3(s.quantity)}</strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">U.Bruta</span>
                        <strong className="text-violet-900">
                          C${money(saleGrossProfit(s))}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Precio</span>
                        <strong>
                          C${money(s.unitPrice && s.unitPrice > 0 ? s.unitPrice : s.quantity > 0 ? s.amount / s.quantity : 0)}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Tipo</span>
                        <strong>
                          {s.type === "CREDITO" ? "Crédito" : "Cash"}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Vendedor</span>
                        <strong className="text-right break-all">
                          {displaySeller(s.userEmail)}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Cliente</span>
                        <strong className="text-right break-all">
                          {s.clientName || "—"}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Fecha ingreso</span>
                        <strong className="text-right break-all">
                          {s.createdAt || "—"}
                        </strong>
                      </div>

                      {canEditSale && (
                        <div className="pt-2 flex justify-end">
                          <ActionMenuTrigger
                            aria-label="Acciones"
                            title="Acciones"
                            onClick={(e) => {
                              const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                              setRowActionMenu({ rect, sale: s });
                            }}
                          />
                        </div>
                      )}
                    </div>
                  </details>
                ))}

                {visibleSales.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-6">
                    Sin ventas para mostrar.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      {message && (
        <Toast message={message} onClose={() => setMessage("")} />
      )}

      {/* ActionMenu de fila */}
      <ActionMenu
        anchorRect={rowActionMenu?.rect ?? null}
        isOpen={!!rowActionMenu}
        onClose={() => setRowActionMenu(null)}
        width={180}
      >
        {rowActionMenu && (
          <div className="py-1">
            {rowActionMenu.sale.status === "FLOTANTE" && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                  onClick={() => {
                    openEdit(rowActionMenu.sale);
                  }}
                >
                  Editar venta
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700 hover:!bg-red-50"
                  onClick={() => {
                    const id = rowActionMenu.sale.id;
                    setRowActionMenu(null);
                    deleteSale(id);
                  }}
                >
                  Eliminar venta
                </Button>
              </>
            )}
            {rowActionMenu.sale.status === "PROCESADA" && (
              <>
                {canEditSale && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                    onClick={() => {
                      openEdit(rowActionMenu.sale);
                    }}
                  >
                    Editar venta
                  </Button>
                )}
                {isAdmin && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700 hover:!bg-red-50"
                    onClick={() => {
                      const id = rowActionMenu.sale.id;
                      setRowActionMenu(null);
                      handleRevert(id);
                    }}
                  >
                    Revertir a flotante
                  </Button>
                )}
              </>
            )}
          </div>
        )}
      </ActionMenu>

      {/* Modal de edición */}
      {editing &&
        createPortal(
          <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-black/40">
            <div
              className="bg-white rounded-2xl shadow-2xl w-full max-w-md max-h-[90vh] flex flex-col"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="sticky top-0 bg-white border-b px-5 py-4 rounded-t-2xl shrink-0">
                <h4 className="font-semibold text-lg">Editar venta</h4>
                <p className="text-sm text-gray-500 mt-0.5">
                  {editing.productName} &bull;{" "}
                  {displaySeller(editing.userEmail)}
                </p>
              </div>

              <div className="px-5 py-4 space-y-4 overflow-y-auto flex-1">
                {!editConfirm ? (
                  <>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Producto
                      </label>
                      <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600">
                        {editing.productName}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Vendedor
                      </label>
                      <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm text-gray-600">
                        {displaySeller(editing.userEmail)}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Fecha venta
                      </label>
                      <input
                        type="date"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        value={editDate}
                        min={editMinDate || undefined}
                        onChange={(e) => setEditDate(e.target.value)}
                      />
                      {editMinDate && (
                        <p className="text-[11px] text-gray-400 mt-1">
                          Mín. permitido: {editMinDate}
                        </p>
                      )}
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Cantidad vendida{" "}
                        {editing.measurement?.toLowerCase() === "lb"
                          ? "(libras, máx 3 dec.)"
                          : "(unidades)"}
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        value={editQty}
                        onChange={(e) =>
                          setEditQty(sanitizeDecimal(e.target.value, 3))
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Precio unitario (máx 2 dec.)
                      </label>
                      <input
                        type="text"
                        inputMode="decimal"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        value={editPrice}
                        onChange={(e) =>
                          setEditPrice(sanitizeDecimal(e.target.value, 2))
                        }
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Monto total
                      </label>
                      <div className="bg-gray-50 rounded-lg px-3 py-2 text-sm font-semibold text-gray-800">
                        C$
                        {money(
                          round2(
                            (parseFloat(editQty) || 0) *
                              (parseFloat(editPrice) || 0),
                          ),
                        )}
                      </div>
                    </div>

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                        Cliente
                      </label>
                      <input
                        type="text"
                        className="w-full border rounded-lg px-3 py-2 text-sm"
                        value={editClient}
                        onChange={(e) => setEditClient(e.target.value)}
                      />
                    </div>
                  </>
                ) : (
                  <div className="bg-amber-50 border border-amber-200 rounded-lg p-4">
                    <p className="font-semibold text-amber-800 mb-3">
                      Confirmar cambios
                    </p>
                    {editChanges.length === 0 ? (
                      <p className="text-sm text-gray-600">
                        No hay cambios.
                      </p>
                    ) : (
                      <div className="space-y-2">
                        {editChanges.map((c, i) => (
                          <div key={i} className="text-sm">
                            <span className="font-medium text-gray-700">
                              {c.label}
                            </span>
                            <div className="flex items-center gap-2 mt-0.5">
                              <span className="line-through text-red-500">
                                {c.from}
                              </span>
                              <span className="text-gray-400">&rarr;</span>
                              <span className="text-green-700 font-medium">
                                {c.to}
                              </span>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                    {round3(parseFloat(editQty) || 0) !==
                      round3(editing.quantity) && (
                      <p className="mt-3 text-xs text-amber-700 border-t border-amber-200 pt-2">
                        Al cambiar la cantidad, se re-asigna el inventario
                        (FIFO).
                      </p>
                    )}
                  </div>
                )}
              </div>

              <div className="sticky bottom-0 bg-white border-t px-5 py-3 flex gap-2 justify-end rounded-b-2xl shrink-0">
                <Button
                  variant="outline"
                  size="md"
                  onClick={() => {
                    if (editConfirm) setEditConfirm(false);
                    else setEditing(null);
                  }}
                  className="!rounded-xl"
                  disabled={editSaving}
                >
                  {editConfirm ? "Volver" : "Cancelar"}
                </Button>
                {(() => {
                  const qtyOk = (parseFloat(editQty) || 0) > 0;
                  const priceOk = (parseFloat(editPrice) || 0) > 0;
                  const fieldsValid = qtyOk && priceOk;
                  return !editConfirm ? (
                    <Button
                      variant="primary"
                      onClick={() => setEditConfirm(true)}
                      className="!rounded-xl !bg-indigo-600 hover:!bg-indigo-700"
                      disabled={!fieldsValid || editChanges.length === 0}
                    >
                      Revisar cambios
                    </Button>
                  ) : (
                    <Button
                      variant="primary"
                      onClick={saveEdit}
                      className="!rounded-xl !bg-green-600 hover:!bg-green-700"
                      disabled={editSaving || !fieldsValid || editChanges.length === 0}
                    >
                      {editSaving ? "Guardando..." : "Confirmar y guardar"}
                    </Button>
                  );
                })()}
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
