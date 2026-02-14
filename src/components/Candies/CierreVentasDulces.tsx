import React, { useEffect, useRef, useState } from "react";
import { hasRole } from "../../utils/roles";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  addDoc,
  Timestamp,
  query,
  where,
  onSnapshot,
  writeBatch,
  doc,
  updateDoc,
  orderBy,
  deleteDoc,
} from "firebase/firestore";
import { format } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { restoreCandySaleAndDelete } from "../../Services/inventory_candies";

type FireTimestamp = { toDate?: () => Date } | undefined;

// Tipo de venta
type SaleType = "CONTADO" | "CREDITO";

interface SaleDataRaw {
  id?: string;
  productName?: string;
  quantity?: number; // en BD: puede ser unidades totales
  packagesTotal?: number; // total paquetes (root)
  amount?: number;
  amountCharged?: number;
  amountSuggested?: number;
  date?: string;
  userEmail?: string; // email del usuario que hizo la venta
  vendor?: string;
  vendorName?: string;
  vendorId?: string;
  clientName?: string;
  amountReceived?: number;
  change?: string | number;
  status?: "FLOTANTE" | "PROCESADA";
  timestamp?: FireTimestamp;
  items?: any[]; // multi-ítems
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  // tipo de venta en sales_candies
  type?: SaleType;

  // ✅ ya existe en sales_candies del POS
  vendorCommissionAmount?: number;
  vendorCommissionPercent?: number;
  itemsTotal?: number;
  total?: number;

  // ✅ fecha de proceso (cuando se cierra)
  processedDate?: string;
  processedAt?: any;
  closureDate?: string;
}

interface SaleData {
  id: string;
  productName: string;
  quantity: number; // PAQUETES vendidos (para la UI)
  amount: number;
  amountSuggested: number;
  date: string;
  userEmail: string; // etiqueta que mostramos en la tabla (nombre / vendedor)
  sellerEmail?: string; // email real del usuario logueado que hizo la venta
  clientName: string;
  amountReceived: number;
  change: string;
  status: "FLOTANTE" | "PROCESADA";
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  type: SaleType;
  vendorId?: string;

  // ✅ comisión prorrateada por fila
  vendorCommissionAmount?: number;

  // ✅ fecha de proceso
  processedDate?: string;
}

interface ClosureData {
  id: string;
  date: string; // fecha de proceso (hoy)
  createdAt: any;

  // ✅ rango que cerraste
  periodStart?: string;
  periodEnd?: string;

  products: { productName: string; quantity: number; amount: number }[];
  totalUnits: number; // paquetes (legacy)
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

// vendedores dulces
interface SellerCandy {
  id: string;
  name: string;
  commissionPercent: number;
}

// helpers
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const normKey = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

async function deleteARMovesBySaleId(saleId: string) {
  if (!saleId) return;
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
  );
}

// ✅ Normaliza UNA venta en MÚLTIPLES filas si trae items[]
// ✅ Ajuste: prorratea vendorCommissionAmount por línea
const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
  const date =
    raw.date ??
    (raw.timestamp?.toDate
      ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
      : "");
  if (!date) return [];

  const sellerEmail = raw.userEmail ?? ""; // email real del usuario
  const vendedorLabel =
    raw.vendorName ||
    raw.vendor ||
    sellerEmail ||
    raw.vendorId ||
    "(sin vendedor)";

  const type: SaleType = (raw.type || "CONTADO") as SaleType;
  const vendorId = raw.vendorId;

  // Totales root para prorratear comisión en multi-ítem
  const saleTotalRoot =
    Number(
      raw.total ?? raw.itemsTotal ?? raw.amount ?? raw.amountCharged ?? 0,
    ) || 0;
  const saleCommissionRoot = Number(raw.vendorCommissionAmount ?? 0) || 0;

  // ✅ fecha proceso (si existe)
  const processedDate = raw.processedDate ?? raw.closureDate ?? "";

  // Venta multi-ítem
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const qtyPacks = Number(it?.packages ?? it?.qty ?? it?.quantity ?? 0); // PAQUETES
      const lineFinal =
        Number(it?.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPricePackage || it?.unitPrice || 0) * qtyPacks -
            Number(it?.discount || 0),
        );

      // ✅ Comisión por línea (prorrateada)
      let lineCommission = 0;
      if (
        saleCommissionRoot > 0 &&
        saleTotalRoot > 0 &&
        Number(lineFinal || 0) > 0
      ) {
        lineCommission = round2(
          (saleCommissionRoot * Number(lineFinal || 0)) / saleTotalRoot,
        );
      }

      return {
        id: `${id}#${idx}`,
        productName: String(it?.productName ?? "(sin nombre)"),
        quantity: qtyPacks,
        amount: round2(lineFinal),
        amountSuggested: Number(raw.amountSuggested ?? 0),
        date,
        userEmail: vendedorLabel,
        sellerEmail,
        clientName: raw.clientName ?? "",
        amountReceived: Number(raw.amountReceived ?? 0),
        change: String(raw.change ?? "0"),
        status: (raw.status as any) ?? "FLOTANTE",
        allocations: Array.isArray(it?.allocations)
          ? it.allocations
          : raw.allocations,
        avgUnitCost: Number(it?.avgUnitCost ?? raw.avgUnitCost ?? 0),
        cogsAmount: Number(it?.cogsAmount ?? 0),
        type,
        vendorId,
        vendorCommissionAmount: lineCommission,
        processedDate: processedDate || "",
      };
    });
  }

  // Fallback: una sola fila (sin items[])
  const qtyPacksFallback = Number(raw.packagesTotal ?? raw.quantity ?? 0); // paquetes totales
  const amountFallback =
    Number(raw.amount ?? raw.amountCharged ?? raw.total ?? 0) || 0;

  // ⚠️ Aquí lo dejamos tal cual: si es crédito no fuerza 0 (para no cambiar tu lógica)
  let commissionFallback = 0;
  if (type !== "CREDITO") {
    commissionFallback = round2(Number(raw.vendorCommissionAmount ?? 0) || 0);
  } else {
    // si existe, lo dejamos pasar para KPI de crédito (sin tocar tu tabla existente)
    commissionFallback = round2(Number(raw.vendorCommissionAmount ?? 0) || 0);
  }

  return [
    {
      id,
      productName: raw.productName ?? "(sin nombre)",
      quantity: qtyPacksFallback,
      amount: amountFallback,
      amountSuggested: Number(raw.amountSuggested ?? 0),
      date,
      userEmail: vendedorLabel,
      sellerEmail,
      clientName: raw.clientName ?? "",
      amountReceived: Number(raw.amountReceived ?? 0),
      change: String(raw.change ?? "0"),
      status: (raw.status as any) ?? "FLOTANTE",
      allocations: raw.allocations,
      avgUnitCost: raw.avgUnitCost,
      cogsAmount: raw.cogsAmount,
      type,
      vendorId,
      vendorCommissionAmount: commissionFallback,
      processedDate: processedDate || "",
    },
  ];
};

type RoleCandies =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

export default function CierreVentasDulces({
  role,
  currentUserEmail,
  sellerCandyId,
  roles,
}: {
  role?: string;
  currentUserEmail?: string;
  sellerCandyId?: string;
  roles?: string[];
}): React.ReactElement {
  const [salesV2, setSales] = useState<SaleData[]>([]);
  const [closure, setClosure] = useState<ClosureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FLOTANTE" | "PROCESADA">("ALL");

  // ✅ NUEVO: filtro por período
  const today = format(new Date(), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(today);

  // ✅ NUEVO: filtro por vendedor (admin)
  const [vendorFilter, setVendorFilter] = useState<string>("ALL");
  const [productFilter, setProductFilter] = useState<string>("ALL");

  const [editing, setEditing] = useState<null | SaleData>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [editAmount, setEditAmount] = useState<number>(0);
  const [editClient, setEditClient] = useState<string>("");
  const [editPaid, setEditPaid] = useState<number>(0);
  const [editChange, setEditChange] = useState<string>("0");

  // UI: cards colapsables
  const [filtersCardOpen, setFiltersCardOpen] = useState(false);
  const [kpiCardOpen, setKpiCardOpen] = useState(false);
  const [vendorKpiCardOpen, setVendorKpiCardOpen] = useState(false);
  const [cashCardOpen, setCashCardOpen] = useState(false);
  const [creditCardOpen, setCreditCardOpen] = useState(false);
  const [productCardOpen, setProductCardOpen] = useState(false);

  const pdfRef = useRef<HTMLDivElement>(null);

  const subject = roles && roles.length ? roles : role;
  const isAdmin = !subject || hasRole(subject, "admin");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const currentEmailNorm = (currentUserEmail || "").trim().toLowerCase();

  // vendedores para KPI listado + filtro
  const [sellers, setSellers] = useState<SellerCandy[]>([]);

  // catálogo de productos (para mapear categoría)
  const [productCategoryMap, setProductCategoryMap] = useState<
    Record<string, string>
  >({});
  const [categoryOpenMap, setCategoryOpenMap] = useState<
    Record<string, boolean>
  >({});
  const productOptions = React.useMemo(() => {
    const names = new Set<string>();
    salesV2.forEach((s) => {
      const name = (s.productName || "").trim();
      if (name) names.add(name);
    });
    return Array.from(names).sort((a, b) => a.localeCompare(b));
  }, [salesV2]);

  // ✅ Ventas por PERIODO (sin importar estado)
  useEffect(() => {
    if (!startDate || !endDate) return;

    setLoading(true);

    const qSales = query(
      collection(db, "sales_candies"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
      orderBy("date", "asc"),
    );

    const unsub = onSnapshot(
      qSales,
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
  }, [startDate, endDate]);

  // Cierre guardado (informativo) - hoy (fecha proceso)
  useEffect(() => {
    const fetchClosure = async () => {
      const qC = query(
        collection(db, "daily_closures_candies"),
        where("date", "==", today),
      );
      const snapshot = await getDocs(qC);
      if (!snapshot.empty) {
        const d = snapshot.docs[0];
        setClosure({ id: d.id, ...d.data() } as ClosureData);
      } else {
        setClosure(null);
      }
    };
    fetchClosure();
  }, [today]);

  // cargar vendedores
  useEffect(() => {
    const fetchSellers = async () => {
      try {
        const snap = await getDocs(collection(db, "sellers_candies"));
        const list: SellerCandy[] = [];
        snap.forEach((d) => {
          const data = d.data() as any;
          list.push({
            id: d.id,
            name: data.name || "",
            commissionPercent: Number(data.commissionPercent || 0),
          });
        });
        setSellers(list);
      } catch (e) {
        console.error("Error cargando sellers_candies", e);
      }
    };
    fetchSellers();
  }, []);

  // cargar catálogo productos (para consolidado por categoría)
  useEffect(() => {
    const fetchProducts = async () => {
      try {
        const snap = await getDocs(collection(db, "products_candies"));
        const map: Record<string, string> = {};
        snap.forEach((d) => {
          const data = d.data() as any;
          const nameKey = normKey(data?.name);
          if (!nameKey) return;
          const category = String(data?.category || "").trim();
          map[nameKey] = category || "(sin categoría)";
        });
        setProductCategoryMap(map);
      } catch (e) {
        console.error("Error cargando products_candies", e);
      }
    };
    fetchProducts();
  }, []);

  // ✅ helper comisión por venta (YA VIENE EN LA VENTA)
  const getCommissionAmount = (s: SaleData): number => {
    return round2(Number(s.vendorCommissionAmount ?? 0) || 0);
  };

  // ✅ Ventas visibles (filtro estado + rol + vendedor) **sobre el período**
  const visibleSales = React.useMemo(() => {
    let base = [...salesV2];

    if (filter === "FLOTANTE")
      base = base.filter((s) => s.status === "FLOTANTE");
    if (filter === "PROCESADA")
      base = base.filter((s) => s.status === "PROCESADA");

    if (productFilter !== "ALL") {
      base = base.filter((s) => (s.productName || "").trim() === productFilter);
    }

    // filtro por vendedor (solo admin; en vendedor ya viene filtrado abajo)
    if (isAdmin && vendorFilter !== "ALL") {
      base = base.filter((s) => (s.vendorId || "") === vendorFilter);
    }

    // restricción para vendedor_dulces
    if (isVendDulces) {
      if (sellerCandyId) {
        base = base.filter((s) => (s.vendorId || "") === sellerCandyId);
      } else if (currentEmailNorm) {
        base = base.filter(
          (s) => (s.sellerEmail || "").toLowerCase() === currentEmailNorm,
        );
      } else {
        base = [];
      }
    }

    return base;
  }, [
    filter,
    salesV2,
    productFilter,
    isAdmin,
    vendorFilter,
    isVendDulces,
    sellerCandyId,
    currentEmailNorm,
  ]);

  const cashSales = React.useMemo(
    () => visibleSales.filter((s) => s.type !== "CREDITO"),
    [visibleSales],
  );
  const creditSales = React.useMemo(
    () => visibleSales.filter((s) => s.type === "CREDITO"),
    [visibleSales],
  );

  // ✅ KPIs flotantes/procesadas
  const kpiFloCount = React.useMemo(
    () => visibleSales.filter((s) => s.status === "FLOTANTE").length,
    [visibleSales],
  );
  const kpiProCount = React.useMemo(
    () => visibleSales.filter((s) => s.status === "PROCESADA").length,
    [visibleSales],
  );

  // ✅ NUEVO KPI: ventas crédito / cash (conteo)
  const kpiCreditoCount = React.useMemo(
    () => visibleSales.filter((s) => s.type === "CREDITO").length,
    [visibleSales],
  );
  const kpiCashCount = React.useMemo(
    () => visibleSales.filter((s) => s.type !== "CREDITO").length,
    [visibleSales],
  );

  // Totales visibles (quantity = paquetes)
  const totalPaquetes = round3(
    visibleSales.reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalCOGSVisible = round2(
    visibleSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );
  const totalCharged = round2(
    visibleSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );
  const grossProfitVisible = round2(totalCharged - totalCOGSVisible);

  // Totales por tipo + comisión (se mantiene)
  let totalPacksCredito = 0;
  let totalPacksCash = 0;
  let totalPendienteCredito = 0;
  let totalCobradoCash = 0;
  let totalCommission = 0;

  // ✅ NUEVO: comisión separada cash vs crédito
  let totalCommissionCash = 0;
  let totalCommissionCredito = 0;

  visibleSales.forEach((s) => {
    const amt = Number(s.amount || 0);
    const received = Number(s.amountReceived || 0);
    const commission = getCommissionAmount(s);

    totalCommission += commission;

    if (s.type === "CREDITO") {
      totalPacksCredito += s.quantity || 0;
      totalPendienteCredito += amt - received;
      totalCommissionCredito += commission;
    } else {
      totalPacksCash += s.quantity || 0;
      totalCobradoCash += amt;
      totalCommissionCash += commission;
    }
  });

  totalPendienteCredito = round2(totalPendienteCredito);
  totalCobradoCash = round2(totalCobradoCash);
  totalCommission = round2(totalCommission);
  totalCommissionCash = round2(totalCommissionCash);
  totalCommissionCredito = round2(totalCommissionCredito);

  // ✅ KPI: comisiones por vendedor en el periodo (CASH / CRÉDITO separados)
  const vendorCommissionRowsCash = React.useMemo(() => {
    const map: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};
    for (const s of visibleSales) {
      const vid = (s.vendorId || "").trim();
      if (!vid) continue;
      if (s.type === "CREDITO") continue; // ✅ solo cash
      const commission = getCommissionAmount(s);
      if (!map[vid]) {
        const seller = sellers.find((x) => x.id === vid);
        map[vid] = {
          vendorId: vid,
          name: seller?.name || s.userEmail || "(sin vendedor)",
          total: 0,
        };
      }
      map[vid].total = round2(map[vid].total + commission);
    }
    return Object.values(map)
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [visibleSales, sellers]);

  const vendorCommissionRowsCredito = React.useMemo(() => {
    const map: Record<
      string,
      { vendorId: string; name: string; total: number }
    > = {};
    for (const s of visibleSales) {
      const vid = (s.vendorId || "").trim();
      if (!vid) continue;
      if (s.type !== "CREDITO") continue; // ✅ solo crédito
      const commission = getCommissionAmount(s);
      if (!map[vid]) {
        const seller = sellers.find((x) => x.id === vid);
        map[vid] = {
          vendorId: vid,
          name: seller?.name || s.userEmail || "(sin vendedor)",
          total: 0,
        };
      }
      map[vid].total = round2(map[vid].total + commission);
    }
    return Object.values(map)
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [visibleSales, sellers]);

  // Consolidado por producto (en paquetes + comisión)
  const productMap: Record<
    string,
    { totalQuantity: number; totalAmount: number; totalCommission: number }
  > = {};
  visibleSales.forEach((s) => {
    const key = s.productName || "(sin nombre)";
    if (!productMap[key])
      productMap[key] = {
        totalQuantity: 0,
        totalAmount: 0,
        totalCommission: 0,
      };
    productMap[key].totalQuantity = round3(
      productMap[key].totalQuantity + (s.quantity || 0),
    );
    productMap[key].totalAmount = round2(
      productMap[key].totalAmount + (s.amount || 0),
    );
    productMap[key].totalCommission = round2(
      productMap[key].totalCommission + getCommissionAmount(s),
    );
  });

  const productSummaryArray = Object.entries(productMap).map(
    ([productName, v]) => ({
      productName,
      category: productCategoryMap[normKey(productName)] || "(sin categoría)",
      totalQuantity: v.totalQuantity,
      totalAmount: v.totalAmount,
      totalCommission: v.totalCommission,
    }),
  );

  const productSummaryByCategory = React.useMemo(() => {
    const map: Record<
      string,
      {
        category: string;
        rows: typeof productSummaryArray;
        totalQuantity: number;
        totalAmount: number;
        totalCommission: number;
      }
    > = {};

    for (const row of productSummaryArray) {
      const cat = row.category || "(sin categoría)";
      if (!map[cat]) {
        map[cat] = {
          category: cat,
          rows: [],
          totalQuantity: 0,
          totalAmount: 0,
          totalCommission: 0,
        };
      }
      map[cat].rows.push(row);
      map[cat].totalQuantity = round3(
        map[cat].totalQuantity + (row.totalQuantity || 0),
      );
      map[cat].totalAmount = round2(
        map[cat].totalAmount + (row.totalAmount || 0),
      );
      map[cat].totalCommission = round2(
        map[cat].totalCommission + (row.totalCommission || 0),
      );
    }

    return Object.values(map)
      .map((g) => ({
        ...g,
        rows: [...g.rows].sort((a, b) => b.totalAmount - a.totalAmount),
      }))
      .sort((a, b) => b.totalAmount - a.totalAmount);
  }, [productSummaryArray]);

  const toggleCategory = (cat: string) => {
    setCategoryOpenMap((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  // ✅ Guardar cierre (ADMIN):
  // - procesa SOLO FLOTANTES visibles del periodo
  // - fecha proceso = hoy (aunque date venta sea vieja)
  const handleSaveClosure = async () => {
    if (!isAdmin) return;

    try {
      const toProcess = visibleSales.filter((s) => s.status === "FLOTANTE");

      if (toProcess.length === 0) {
        setMessage("No hay ventas flotantes para procesar en este período.");
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
      const split = toProcess.reduce(
        (acc, s) => {
          const qty = Number(s.quantity || 0);
          const amt = Number(s.amount || 0);
          const com = Number(s.vendorCommissionAmount || 0);

          if (s.type === "CREDITO") {
            acc.packsCredit += qty;
            acc.amountCredit += amt;
            acc.comCredit += com;
          } else {
            acc.packsCash += qty;
            acc.amountCash += amt;
            acc.comCash += com;
          }
          return acc;
        },
        {
          packsCash: 0,
          packsCredit: 0,
          amountCash: 0,
          amountCredit: 0,
          comCash: 0,
          comCredit: 0,
        },
      );

      const totalsSplit = {
        totalPacksCash: round3(split.packsCash),
        totalPacksCredit: round3(split.packsCredit),
        totalAmountCash: round2(split.amountCash),
        totalAmountCredit: round2(split.amountCredit),
        totalCommissionCash: round2(split.comCash),
        totalCommissionCredit: round2(split.comCredit),
      };

      const ref = await addDoc(collection(db, "daily_closures_candies"), {
        date: today, // fecha proceso
        createdAt: Timestamp.now(),
        periodStart: startDate,
        periodEnd: endDate,
        totalCharged: totals.totalCharged,
        totalSuggested: totals.totalSuggested,
        totalDifference: diff,
        totalUnits: totals.totalUnits,
        totalCOGS: totals.totalCOGS,
        grossProfit,
        ...totalsSplit,
        products: toProcess.map((s) => ({
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
        })),
        sales: toProcess.map((s) => ({
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
          date: s.date, // fecha venta

          // ✅ NUEVOS (para Liquidaciones)
          type: s.type ?? "CONTADO",
          vendorId: s.vendorId ?? "",
          vendorCommissionAmount: Number(s.vendorCommissionAmount ?? 0) || 0,

          // ✅ proceso
          processedDate: today,
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
        batch.update(doc(db, "sales_candies", s.id.split("#")[0]), {
          status: "PROCESADA",
          closureId: ref.id,
          closureDate: today,
          processedDate: today,
          processedAt: Timestamp.now(),
        });
      });

      await batch.commit();

      setMessage(
        `✅ Cierre guardado. Ventas procesadas: ${toProcess.length}. (Proceso: ${today})`,
      );
    } catch (error) {
      console.error(error);
      setMessage("❌ Error al guardar el cierre de dulces.");
    }
  };

  const handleRevert = async (saleId: string) => {
    if (!isAdmin) return;
    if (
      !window.confirm("¿Revertir esta venta? Esta acción no se puede deshacer.")
    )
      return;

    try {
      await updateDoc(doc(db, "sales_candies", saleId.split("#")[0]), {
        status: "FLOTANTE",
        closureId: null,
        closureDate: null,
        processedDate: null,
        processedAt: null,
      });
      setMessage("↩️ Venta revertida a FLOTANTE.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo revertir la venta.");
    }
  };

  const openEdit = (s: SaleData) => {
    if (!isAdmin) return;
    setEditing(s);
    setEditQty(s.quantity);
    setEditAmount(s.amount);
    setEditClient(s.clientName);
    setEditPaid(s.amountReceived);
    setEditChange(s.change);
  };

  const saveEdit = async () => {
    if (!editing || !isAdmin) return;
    try {
      await updateDoc(doc(db, "sales_candies", editing.id.split("#")[0]), {
        packagesTotal: editQty,
        amount: editAmount,
        amountCharged: editAmount,
        clientName: editClient,
        amountReceived: editPaid,
        change: editChange,
      });
      setEditing(null);
      setMessage("✅ Venta de dulces actualizada.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo actualizar la venta de dulces.");
    }
  };

  const deleteSale = async (saleId: string) => {
    if (!isAdmin) return;
    if (
      !window.confirm(
        "¿Eliminar esta venta? Se restaurará el stock (paquetes) en los lotes asignados.",
      )
    )
      return;
    try {
      const baseSaleId = saleId.split("#")[0];
      const { restored } = await restoreCandySaleAndDelete(baseSaleId);
      await deleteARMovesBySaleId(baseSaleId);
      setMessage(
        `🗑️ Venta eliminada. Stock restaurado (unidades internas): ${Number(
          restored,
        ).toFixed(2)}. Estado de cuenta ajustado.`,
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar la venta de dulces.");
    }
  };

  // ✅ PDF: en PWA se muestra cards, pero para PDF forzamos vista "desktop" (tabla)
  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;

    // fuerza modo PDF (muestra tablas aunque estés en móvil)
    pdfRef.current.classList.add("force-pdf-colors");
    pdfRef.current.classList.add("pdf-print-mode");

    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_dulces_${startDate}_a_${endDate}_proc_${today}.pdf`);
    } finally {
      pdfRef.current.classList.remove("pdf-print-mode");
      pdfRef.current.classList.remove("force-pdf-colors");
    }
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      {/* ✅ CSS interno SOLO para alternar vista en PDF (sin tocar tu data) */}
      <style>{`
        .pdf-print-mode .pdf-desktop { display: block !important; }
        .pdf-print-mode .pdf-mobile  { display: none !important; }
        .pdf-print-mode .collapsible-content { display: block !important; }
      `}</style>

      <h2 className="text-2xl font-bold mb-4">
        Cierre de Ventas de Dulces - Proceso: {today}
      </h2>

      {/* filtros por periodo + estado + vendedor */}
      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setFiltersCardOpen((v) => !v)}
          aria-expanded={filtersCardOpen}
        >
          <span>Filtros</span>
          <span
            className={`transition-transform ${filtersCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        <div
          className={`collapsible-content ${filtersCardOpen ? "block" : "hidden"} border-t p-4`}
        >
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            <div className="flex items-center gap-2">
              <label className="text-sm">Desde:</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm">Hasta:</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-sm">Filtrar:</label>
              <select
                className="border rounded px-2 py-1"
                value={filter}
                onChange={(e) => setFilter(e.target.value as any)}
              >
                <option value="ALL">Todas</option>
                <option value="FLOTANTE">Venta Flotante</option>
                <option value="PROCESADA">Venta Procesada</option>
              </select>
            </div>

            {/* ✅ NUEVO: filtro por vendedor (solo admin) */}
            {isAdmin && (
              <div className="flex items-center gap-2">
                <label className="text-sm">Vendedor:</label>
                <select
                  className="border rounded px-2 py-1"
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
            )}

            <div className="flex items-center gap-2 w-full md:w-auto">
              <label className="text-xs md:text-sm whitespace-nowrap">
                Producto:
              </label>
              <select
                className="border rounded px-2 py-1 text-xs w-full md:w-48 lg:w-56"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
                disabled={productOptions.length === 0}
              >
                <option value="ALL">Todos</option>
                {productOptions.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
      </div>

      {/* KPIs arriba */}
      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setKpiCardOpen((v) => !v)}
          aria-expanded={kpiCardOpen}
        >
          <span>KPIs</span>
          <span
            className={`transition-transform ${kpiCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        <div
          className={`collapsible-content ${kpiCardOpen ? "block" : "hidden"} border-t p-4`}
        >
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">Ventas flotantes</div>
              <div className="text-2xl font-bold">{kpiFloCount}</div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">Ventas procesadas</div>
              <div className="text-2xl font-bold">{kpiProCount}</div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">Ventas crédito</div>
              <div className="text-2xl font-bold">{kpiCreditoCount}</div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">Ventas cash</div>
              <div className="text-2xl font-bold">{kpiCashCount}</div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">
                Comisión cash (período)
              </div>
              <div className="text-2xl font-bold">
                C${money(totalCommissionCash)}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">
                Comisión crédito (período)
              </div>
              <div className="text-2xl font-bold">
                C${money(totalCommissionCredito)}
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* KPIs listados por vendedor (cash / crédito) */}
      <div className="bg-white border rounded shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setVendorKpiCardOpen((v) => !v)}
          aria-expanded={vendorKpiCardOpen}
        >
          <span>KPIs por vendedor</span>
          <span
            className={`transition-transform ${vendorKpiCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        <div
          className={`collapsible-content ${vendorKpiCardOpen ? "block" : "hidden"} border-t p-4`}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="border rounded-xl p-3 shadow-sm bg-gray-50">
              <div className="text-xs text-gray-600">
                Vendedores (comisión CASH del período)
              </div>
              {vendorCommissionRowsCash.length === 0 ? (
                <div className="text-sm text-gray-500 mt-2">—</div>
              ) : (
                <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
                  {vendorCommissionRowsCash.map((v) => (
                    <div
                      key={v.vendorId}
                      className="flex items-center justify-between text-sm"
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
                Vendedores (comisión CRÉDITO del período)
              </div>
              {vendorCommissionRowsCredito.length === 0 ? (
                <div className="text-sm text-gray-500 mt-2">—</div>
              ) : (
                <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
                  {vendorCommissionRowsCredito.map((v) => (
                    <div
                      key={v.vendorId}
                      className="flex items-center justify-between text-sm"
                    >
                      <span className="truncate">{v.name}</span>
                      <strong className="ml-2">C${money(v.total)}</strong>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          <div className="bg-white border rounded shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
              onClick={() => setCashCardOpen((v) => !v)}
              aria-expanded={cashCardOpen}
            >
              <span>Transacciones Cash</span>
              <span
                className={`transition-transform ${cashCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${cashCardOpen ? "block" : "hidden"} border-t p-4`}
            >
              <div className="pdf-desktop hidden md:block">
                <table className="min-w-full border text-sm mb-4 shadow-2xl">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Estado</th>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Tipo</th>
                      <th className="border p-2">Paquetes</th>
                      <th className="border p-2">Monto</th>
                      <th className="border p-2">Comisión</th>
                      <th className="border p-2">Fecha venta</th>
                      <th className="border p-2">Fecha proceso</th>
                      <th className="border p-2">Vendedor</th>
                      <th className="border p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cashSales.map((s) => {
                      const commission = getCommissionAmount(s);
                      const processDate = (s.processedDate || "").trim();

                      return (
                        <tr key={s.id} className="text-center">
                          <td className="border p-1">
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                s.status === "PROCESADA"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-yellow-100 text-yellow-700"
                              }`}
                            >
                              {s.status}
                            </span>
                          </td>
                          <td className="border p-1">{s.productName}</td>
                          <td className="border p-1">Cash</td>
                          <td className="border p-1">{qty3(s.quantity)}</td>
                          <td className="border p-1">C${money(s.amount)}</td>
                          <td className="border p-1">
                            {commission > 0 ? `C$${money(commission)}` : "—"}
                          </td>
                          <td className="border p-1">{s.date}</td>
                          <td className="border p-1">
                            {processDate ? processDate : "—"}
                          </td>
                          <td className="border p-1">{s.userEmail}</td>
                          <td className="border p-1">
                            {s.status === "FLOTANTE" ? (
                              <div className="flex gap-2 justify-center">
                                {isAdmin ? (
                                  <>
                                    <button
                                      onClick={() => openEdit(s)}
                                      className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700"
                                    >
                                      Editar
                                    </button>
                                    <button
                                      onClick={() => deleteSale(s.id)}
                                      className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                                    >
                                      Eliminar
                                    </button>
                                  </>
                                ) : (
                                  <span className="text-gray-400 text-xs">
                                    —
                                  </span>
                                )}
                              </div>
                            ) : s.status === "PROCESADA" ? (
                              <div className="flex gap-2 justify-center">
                                {isAdmin ? (
                                  <button
                                    onClick={() => handleRevert(s.id)}
                                    className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                                  >
                                    Revertir
                                  </button>
                                ) : (
                                  <span className="text-gray-400 text-xs">
                                    —
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-400 text-xs">
                                No options
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {cashSales.length === 0 && (
                      <tr>
                        <td
                          colSpan={10}
                          className="p-3 text-center text-gray-500"
                        >
                          Sin ventas cash para mostrar.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pdf-mobile md:hidden space-y-3 mb-4">
                {cashSales.map((s) => {
                  const commission = getCommissionAmount(s);
                  const processDate = (s.processedDate || "").trim();

                  return (
                    <details
                      key={s.id}
                      className="border rounded-xl bg-white shadow-sm"
                    >
                      <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                        <div className="min-w-0">
                          <div className="font-semibold truncate">
                            {s.productName}
                          </div>
                          <div className="text-xs text-gray-500">
                            Cash • {s.date}
                          </div>
                        </div>

                        <div className="text-right shrink-0 ml-3">
                          <div className="font-bold">C${money(s.amount)}</div>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              s.status === "PROCESADA"
                                ? "bg-green-100 text-green-700"
                                : "bg-yellow-100 text-yellow-700"
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>
                      </summary>

                      <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Paquetes</span>
                          <strong>{qty3(s.quantity)}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Comisión</span>
                          <strong>
                            {commission > 0 ? `C$${money(commission)}` : "—"}
                          </strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Fecha proceso</span>
                          <strong>{processDate || "—"}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Vendedor</span>
                          <strong className="text-right break-all">
                            {s.userEmail}
                          </strong>
                        </div>

                        <div className="pt-2">
                          {s.status === "FLOTANTE" ? (
                            <div className="flex gap-2">
                              {isAdmin ? (
                                <>
                                  <button
                                    onClick={() => openEdit(s)}
                                    className="flex-1 text-xs bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700"
                                  >
                                    Editar
                                  </button>
                                  <button
                                    onClick={() => deleteSale(s.id)}
                                    className="flex-1 text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                                  >
                                    Eliminar
                                  </button>
                                </>
                              ) : (
                                <div className="text-gray-400 text-xs w-full text-center">
                                  —
                                </div>
                              )}
                            </div>
                          ) : s.status === "PROCESADA" ? (
                            <div className="flex gap-2">
                              {isAdmin ? (
                                <button
                                  onClick={() => handleRevert(s.id)}
                                  className="w-full text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                                >
                                  Revertir
                                </button>
                              ) : (
                                <div className="text-gray-400 text-xs w-full text-center">
                                  —
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-gray-400 text-xs w-full text-center">
                              No options
                            </div>
                          )}
                        </div>
                      </div>
                    </details>
                  );
                })}

                {cashSales.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-6">
                    Sin ventas cash para mostrar.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border rounded shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
              onClick={() => setCreditCardOpen((v) => !v)}
              aria-expanded={creditCardOpen}
            >
              <span>Transacciones Crédito</span>
              <span
                className={`transition-transform ${creditCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${creditCardOpen ? "block" : "hidden"} border-t p-4`}
            >
              <div className="pdf-desktop hidden md:block">
                <table className="min-w-full border text-sm mb-4 shadow-2xl">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Estado</th>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Tipo</th>
                      <th className="border p-2">Paquetes</th>
                      <th className="border p-2">Monto</th>
                      <th className="border p-2">Comisión</th>
                      <th className="border p-2">Fecha venta</th>
                      <th className="border p-2">Fecha proceso</th>
                      <th className="border p-2">Vendedor</th>
                      <th className="border p-2">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {creditSales.map((s) => {
                      const commission = getCommissionAmount(s);
                      const processDate = (s.processedDate || "").trim();

                      return (
                        <tr key={s.id} className="text-center">
                          <td className="border p-1">
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                s.status === "PROCESADA"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-yellow-100 text-yellow-700"
                              }`}
                            >
                              {s.status}
                            </span>
                          </td>
                          <td className="border p-1">{s.productName}</td>
                          <td className="border p-1">Crédito</td>
                          <td className="border p-1">{qty3(s.quantity)}</td>
                          <td className="border p-1">C${money(s.amount)}</td>
                          <td className="border p-1">
                            {commission > 0 ? `C$${money(commission)}` : "—"}
                          </td>
                          <td className="border p-1">{s.date}</td>
                          <td className="border p-1">
                            {processDate ? processDate : "—"}
                          </td>
                          <td className="border p-1">{s.userEmail}</td>
                          <td className="border p-1">
                            {s.status === "FLOTANTE" ? (
                              <div className="flex gap-2 justify-center">
                                {isAdmin ? (
                                  <>
                                    <button
                                      onClick={() => openEdit(s)}
                                      className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700"
                                    >
                                      Editar
                                    </button>
                                    <button
                                      onClick={() => deleteSale(s.id)}
                                      className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                                    >
                                      Eliminar
                                    </button>
                                  </>
                                ) : (
                                  <span className="text-gray-400 text-xs">
                                    —
                                  </span>
                                )}
                              </div>
                            ) : s.status === "PROCESADA" ? (
                              <div className="flex gap-2 justify-center">
                                {isAdmin ? (
                                  <button
                                    onClick={() => handleRevert(s.id)}
                                    className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                                  >
                                    Revertir
                                  </button>
                                ) : (
                                  <span className="text-gray-400 text-xs">
                                    —
                                  </span>
                                )}
                              </div>
                            ) : (
                              <span className="text-gray-400 text-xs">
                                No options
                              </span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                    {creditSales.length === 0 && (
                      <tr>
                        <td
                          colSpan={10}
                          className="p-3 text-center text-gray-500"
                        >
                          Sin ventas crédito para mostrar.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              <div className="pdf-mobile md:hidden space-y-3 mb-4">
                {creditSales.map((s) => {
                  const commission = getCommissionAmount(s);
                  const processDate = (s.processedDate || "").trim();

                  return (
                    <details
                      key={s.id}
                      className="border rounded-xl bg-white shadow-sm"
                    >
                      <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                        <div className="min-w-0">
                          <div className="font-semibold truncate">
                            {s.productName}
                          </div>
                          <div className="text-xs text-gray-500">
                            Crédito • {s.date}
                          </div>
                        </div>

                        <div className="text-right shrink-0 ml-3">
                          <div className="font-bold">C${money(s.amount)}</div>
                          <span
                            className={`text-xs px-2 py-0.5 rounded ${
                              s.status === "PROCESADA"
                                ? "bg-green-100 text-green-700"
                                : "bg-yellow-100 text-yellow-700"
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>
                      </summary>

                      <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Paquetes</span>
                          <strong>{qty3(s.quantity)}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Comisión</span>
                          <strong>
                            {commission > 0 ? `C$${money(commission)}` : "—"}
                          </strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Fecha proceso</span>
                          <strong>{processDate || "—"}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-gray-600">Vendedor</span>
                          <strong className="text-right break-all">
                            {s.userEmail}
                          </strong>
                        </div>

                        <div className="pt-2">
                          {s.status === "FLOTANTE" ? (
                            <div className="flex gap-2">
                              {isAdmin ? (
                                <>
                                  <button
                                    onClick={() => openEdit(s)}
                                    className="flex-1 text-xs bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700"
                                  >
                                    Editar
                                  </button>
                                  <button
                                    onClick={() => deleteSale(s.id)}
                                    className="flex-1 text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                                  >
                                    Eliminar
                                  </button>
                                </>
                              ) : (
                                <div className="text-gray-400 text-xs w-full text-center">
                                  —
                                </div>
                              )}
                            </div>
                          ) : s.status === "PROCESADA" ? (
                            <div className="flex gap-2">
                              {isAdmin ? (
                                <button
                                  onClick={() => handleRevert(s.id)}
                                  className="w-full text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                                >
                                  Revertir
                                </button>
                              ) : (
                                <div className="text-gray-400 text-xs w-full text-center">
                                  —
                                </div>
                              )}
                            </div>
                          ) : (
                            <div className="text-gray-400 text-xs w-full text-center">
                              No options
                            </div>
                          )}
                        </div>
                      </div>
                    </details>
                  );
                })}

                {creditSales.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-6">
                    Sin ventas crédito para mostrar.
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Bloque de totales (igual) */}
          <div className="grid grid-cols-1 md:grid-cols-3 lg:grid-cols-5 gap-2 text-sm mb-4">
            <div>
              Total paquetes crédito: <strong>{qty3(totalPacksCredito)}</strong>
            </div>
            <div>
              Total paquetes cash: <strong>{qty3(totalPacksCash)}</strong>
            </div>
            <div>
              Total pendiente crédito:{" "}
              <strong>C${money(totalPendienteCredito)}</strong>
            </div>
            <div>
              Total cobrado cash: <strong>C${money(totalCobradoCash)}</strong>
            </div>
            <div>
              Total comisión: <strong>C${money(totalCommission)}</strong>
            </div>
          </div>

          {(totalCOGSVisible > 0 || grossProfitVisible !== totalCharged) && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm mb-6">
              <div>
                Costo total (COGS): <strong>C${money(totalCOGSVisible)}</strong>
              </div>
              <div>
                Ganancia antes de gasto:{" "}
                <strong>C${money(grossProfitVisible)}</strong>
              </div>
              <div>
                Total paquetes (visibles):{" "}
                <strong>{qty3(totalPaquetes)}</strong>
              </div>
            </div>
          )}

          <div className="bg-white border rounded shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
              onClick={() => setProductCardOpen((v) => !v)}
              aria-expanded={productCardOpen}
            >
              <span>Consolidado por producto</span>
              <span
                className={`transition-transform ${productCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${productCardOpen ? "block" : "hidden"} border-t p-4`}
            >
              <div className="space-y-3">
                {productSummaryByCategory.map((group) => {
                  const isOpen = !!categoryOpenMap[group.category];
                  return (
                    <div
                      key={group.category}
                      className="border rounded-xl bg-white shadow-sm"
                    >
                      <button
                        type="button"
                        className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                        onClick={() => toggleCategory(group.category)}
                        aria-expanded={isOpen}
                      >
                        <div className="min-w-0">
                          <div className="truncate">{group.category}</div>
                          <div className="text-xs text-gray-600">
                            {qty3(group.totalQuantity)} paquetes · C$
                            {money(group.totalAmount)} · Comisión{" "}
                            {group.totalCommission > 0
                              ? `C$${money(group.totalCommission)}`
                              : "—"}
                          </div>
                        </div>
                        <span
                          className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                        >
                          ▼
                        </span>
                      </button>

                      <div
                        className={`collapsible-content ${isOpen ? "block" : "hidden"} border-t p-3`}
                      >
                        <div className="pdf-desktop hidden md:block">
                          <table className="min-w-full border text-sm mb-2">
                            <thead className="bg-gray-100">
                              <tr>
                                <th className="border p-2">Producto</th>
                                <th className="border p-2">Total paquetes</th>
                                <th className="border p-2">Total dinero</th>
                                <th className="border p-2">Comisión</th>
                              </tr>
                            </thead>
                            <tbody>
                              {group.rows.map((row) => (
                                <tr
                                  key={row.productName}
                                  className="text-center"
                                >
                                  <td className="border p-1">
                                    {row.productName}
                                  </td>
                                  <td className="border p-1">
                                    {qty3(row.totalQuantity)}
                                  </td>
                                  <td className="border p-1">
                                    C${money(row.totalAmount)}
                                  </td>
                                  <td className="border p-1">
                                    {row.totalCommission > 0
                                      ? `C$${money(row.totalCommission)}`
                                      : "—"}
                                  </td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        </div>

                        <div className="pdf-mobile md:hidden space-y-2">
                          {group.rows.map((row) => (
                            <div
                              key={row.productName}
                              className="border rounded-xl bg-white shadow-sm p-3"
                            >
                              <div className="font-semibold">
                                {row.productName}
                              </div>
                              <div className="mt-2 text-sm space-y-1">
                                <div className="flex justify-between gap-3">
                                  <span className="text-gray-600">
                                    Total paquetes
                                  </span>
                                  <strong>{qty3(row.totalQuantity)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-gray-600">
                                    Total dinero
                                  </span>
                                  <strong>C${money(row.totalAmount)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-gray-600">
                                    Comisión
                                  </span>
                                  <strong>
                                    {row.totalCommission > 0
                                      ? `C$${money(row.totalCommission)}`
                                      : "—"}
                                  </strong>
                                </div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                  );
                })}

                {productSummaryByCategory.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-6">
                    Sin datos para consolidar.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="flex gap-2 mt-4">
        {isAdmin && (
          <button
            onClick={handleSaveClosure}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            Cerrar ventas del período
          </button>
        )}
        <button
          onClick={handleDownloadPDF}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Descargar PDF
        </button>
      </div>

      {message && <p className="mt-2 text-sm">{message}</p>}

      {/* Panel de edición */}
      {editing && isAdmin && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-4 space-y-3">
            <h4 className="font-semibold text-lg">Editar venta de dulces</h4>
            <div className="text-sm text-gray-500">
              {editing.productName} • {editing.userEmail}
            </div>

            <label className="text-sm">Paquetes</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editQty}
              onChange={(e) => setEditQty(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Monto cobrado</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editAmount}
              onChange={(e) => setEditAmount(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Cliente</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editClient}
              onChange={(e) => setEditClient(e.target.value)}
            />

            <label className="text-sm">Paga con</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editPaid}
              onChange={(e) => setEditPaid(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Vuelto</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editChange}
              onChange={(e) => setEditChange(e.target.value)}
            />

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setEditing(null)}
                className="px-3 py-1 border rounded"
              >
                Cancelar
              </button>
              <button
                onClick={saveEdit}
                className="px-3 py-1 rounded text-white bg-indigo-600 hover:bg-indigo-700"
              >
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
