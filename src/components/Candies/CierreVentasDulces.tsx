import React, { useEffect, useRef, useState, useCallback } from "react";
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
import { format, startOfMonth } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import * as XLSX from "xlsx";
import { restoreCandySaleAndDelete } from "../../Services/inventory_candies";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Toast from "../common/Toast";
import ActionMenu from "../common/ActionMenu";
import RefreshButton from "../common/RefreshButton";
import { FiMoreVertical } from "react-icons/fi";

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
  // suma de margenVendedor por items (para reconciliar con vendorCommissionAmount)
  price?: number;
  commissionFromItems?: number;
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
  // utilidades y márgenes que puede traer la venta (opcional)
  margenVendedor?: number;
  uBruta?: number;
  grossProfit?: number;
  prorrateo?: number;
  uvXpaq?: number;
  upaquete?: number;
  uNeta?: number;
  uNetaPorPaquete?: number;
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
  // fecha y hora de registro (si disponible)
  registeredAt?: string | null;
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

  // utilidad del vendedor por fila (margen asignado al vendedor)
  vendorUtility?: number;

  // utilidad neta del ítem después de prorrateos y resto de descuentos
  vendorNetUtility?: number;

  // suma de margenVendedor por items (para reconciliar con vendorCommissionAmount)
  commissionFromItems?: number;

  // uvxpaq calculado en la venta (si existe)
  price?: number;
  uvXpaq?: number;

  // fallback legacy
  upaquete?: number;

  // optional net utility fields
  uNeta?: number;
  uNetaPorPaquete?: number;

  // Ganancia total del vendedor (uvXpaq * paquetes) si está persistida
  vendorGain?: number;

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
const qty3 = (n: unknown) => Math.trunc(Number(n ?? 0)).toString();
const maybeMoney = (n: unknown) =>
  Number.isFinite(Number(n)) ? `C$${money(n)}` : "—";
const normKey = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();
const UVXPAQ_CUTOFF_DATE = "2026-02-25";

function pickAmountAR(x: any): number {
  const n = Number(x?.amount ?? 0);
  if (Number.isFinite(n) && n !== 0) return Math.abs(n);

  const candidates = [
    x.amountPaid,
    x.paidAmount,
    x.paymentAmount,
    x.value,
    x.total,
    x.inAmount,
  ];

  for (const c of candidates) {
    const v = Number(c);
    if (Number.isFinite(v) && v !== 0) return Math.abs(v);
  }

  return 0;
}

function getARKind(x: any): "ABONO" | "CARGO" | "OTHER" {
  const raw = String(
    x.kind ?? x.type ?? x.movement ?? x.movementType ?? x.action ?? "",
  )
    .trim()
    .toUpperCase();

  if (raw === "ABONO" || raw === "PAGO" || raw === "PAYMENT") return "ABONO";
  if (raw === "CARGO" || raw === "CHARGE") return "CARGO";
  return "OTHER";
}

interface AbonoRow {
  id: string;
  date: string;
  customerId?: string;
  customerName?: string;
  amount: number;
  saleId?: string;
  vendorId?: string;
  balanceBefore?: number;
  balanceAfter?: number;
  saleRemainingBefore?: number;
  saleRemainingAfter?: number;
  comment?: string;
}

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
const normalizeMany = (
  raw: SaleDataRaw,
  id: string,
  upaqueteMap: Record<string, Record<string, number>>,
): SaleData[] => {
  const date =
    raw.date ??
    (raw.timestamp?.toDate
      ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
      : "");
  if (!date) return [];

  function extractRegisteredAt(obj: any): string {
    const cand =
      obj?.registeredAt || obj?.createdAt || obj?.timestamp || obj?.processedAt;
    if (!cand) return format(new Date(), "yyyy-MM-dd HH:mm");
    try {
      let d: any = cand;
      if (typeof d === "object" && typeof d.toDate === "function")
        d = d.toDate();
      if (typeof d === "number") d = new Date(d);
      if (typeof d === "string") {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) return format(parsed, "yyyy-MM-dd HH:mm");
        return d;
      }
      if (d instanceof Date && !isNaN(d.getTime()))
        return format(d, "yyyy-MM-dd HH:mm");
    } catch (e) {
      return format(new Date(), "yyyy-MM-dd HH:mm");
    }
    return format(new Date(), "yyyy-MM-dd HH:mm");
  }

  const sellerEmail = raw.userEmail ?? ""; // email real del usuario
  // Busca el nombre actualizado del vendedor usando vendorId
  let vendedorLabel = "(sin vendedor)";
  if (
    raw.vendorId &&
    typeof window !== "undefined" &&
    (window as any).__SELLERS__
  ) {
    const seller = (window as any).__SELLERS__.find(
      (s: any) => s.id === raw.vendorId,
    );
    if (seller && seller.name) {
      vendedorLabel = seller.name;
    } else {
      vendedorLabel =
        raw.vendorName ||
        raw.vendor ||
        sellerEmail ||
        raw.vendorId ||
        "(sin vendedor)";
    }
  } else {
    vendedorLabel =
      raw.vendorName ||
      raw.vendor ||
      sellerEmail ||
      raw.vendorId ||
      "(sin vendedor)";
  }

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

      const vendorUtil =
        Number(it?.margenVendedor ?? it?.uBruta ?? it?.grossProfit ?? 0) || 0;

      // prorrateo (puede no existir)
      const prorrateo = Number(it?.prorrateo ?? 0) || 0;

      // utilidad neta: uBruta - prorrateo - margenVendedor
      const uBrutaItem = Number(it?.uBruta ?? 0) || 0;
      const vendorNet = round2(uBrutaItem - prorrateo - vendorUtil);
      const uvXpaqFromItem = Number(it?.uvXpaq ?? it?.upaquete ?? NaN);

      // Calcular/utilizar utilidad neta por paquete:
      // 1) preferir si viene precomputada en el item (uNetaPorPaquete)
      // 2) luego buscar en upaqueteMap por vendedor/producto
      // 3) fallback: si viene uNeta y packages, dividir uNeta / packages
      let uNetaPorPaquete: number | undefined = undefined;
      try {
        if (
          it?.uNetaPorPaquete !== undefined &&
          Number.isFinite(Number(it.uNetaPorPaquete))
        ) {
          uNetaPorPaquete = Number(it.uNetaPorPaquete);
        }
        const vendedorId = String(
          vendorId || raw.vendorId || it.vendorId || "",
        ).trim();
        const prodKey = normKey(it.productName || it.productId || "");
        const upaMap = typeof upaqueteMap !== "undefined" ? upaqueteMap : {};
        let foundKey = null;
        if (!uNetaPorPaquete && upaMap[vendedorId]) {
          // Mostrar todas las claves disponibles para ese vendedor
          const allKeys = Object.keys(upaMap[vendedorId]);
          console.log(
            "[CierreVentasDulces] Claves en upaqueteMap para vendedor",
            vendedorId,
            allKeys,
          );
          // Buscar match exacto
          if (upaMap[vendedorId][prodKey] !== undefined) {
            foundKey = prodKey;
          } else {
            // Buscar por similitud (ignorando espacios y mayúsculas)
            const match = allKeys.find(
              (k) => k.replace(/\s+/g, "") === prodKey.replace(/\s+/g, ""),
            );
            if (match) foundKey = match;
          }
          if (foundKey) {
            uNetaPorPaquete = Number(upaMap[vendedorId][foundKey]);
            console.log(
              "[CierreVentasDulces] Match clave producto:",
              foundKey,
              "valor:",
              uNetaPorPaquete,
            );
          }
        }
        if (
          uNetaPorPaquete === undefined &&
          typeof it.uNeta === "number" &&
          Number(it.packages) > 0
        ) {
          uNetaPorPaquete = round2(Number(it.uNeta) / Number(it.packages));
        }
        console.log(
          "[CierreVentasDulces] uNetaPorPaquete:",
          uNetaPorPaquete,
          "vendedor:",
          vendedorId,
          "producto:",
          prodKey,
        );
      } catch (e) {
        uNetaPorPaquete = undefined;
      }
      return {
        id: `${id}#${idx}`,
        registeredAt: extractRegisteredAt(it) || extractRegisteredAt(raw),
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
        vendorUtility: vendorUtil,
        vendorNetUtility: vendorNet,
        commissionFromItems: Number(it?.margenVendedor ?? 0) || 0,
        uvXpaq: Number.isFinite(uvXpaqFromItem)
          ? Number(uvXpaqFromItem)
          : undefined,
        uNetaPorPaquete,
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
  const vendorUtilityFallback =
    Number(raw.margenVendedor ?? raw.uBruta ?? raw.grossProfit ?? 0) || 0;

  const prorrateoFallback = Number(raw.prorrateo ?? 0) || 0;
  const uBrutaFallback = Number(raw.uBruta ?? 0) || 0;
  const vendorNetFallback = round2(
    uBrutaFallback - prorrateoFallback - vendorUtilityFallback,
  );
  const uvXpaqFallback = Number(raw.uvXpaq ?? raw.upaquete ?? NaN);

  return [
    {
      id,
      registeredAt: extractRegisteredAt(raw),
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
      vendorUtility: vendorUtilityFallback,
      vendorNetUtility: vendorNetFallback,
      commissionFromItems: Number(raw.margenVendedor ?? 0) || 0,
      uvXpaq: Number.isFinite(uvXpaqFallback)
        ? Number(uvXpaqFallback)
        : undefined,
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

  // ✅ NUEVO: filtro por período (por defecto: desde el 1er día del mes actual hasta hoy)
  const todayDate = new Date();
  const today = format(todayDate, "yyyy-MM-dd");
  const firstDayOfMonth = format(startOfMonth(todayDate), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(firstDayOfMonth);
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
  const [abonosCardOpen, setAbonosCardOpen] = useState(false);
  const [isBackfillingUv, setIsBackfillingUv] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [mobileActionsOpen, setMobileActionsOpen] = useState(false);
  // bulk revert preview state
  const [bulkPreviewOpen, setBulkPreviewOpen] = useState(false);
  const [bulkPreviewItems, setBulkPreviewItems] = useState<SaleData[]>([]);
  const [bulkPreviewForCredit, setBulkPreviewForCredit] = useState(false);
  const [bulkPreviewCount, setBulkPreviewCount] = useState(0);
  // bulk delete preview state
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);
  const [bulkDeleteItems, setBulkDeleteItems] = useState<SaleData[]>([]);
  const [bulkDeleteForCredit, setBulkDeleteForCredit] = useState(false);
  const [bulkDeleteCount, setBulkDeleteCount] = useState(0);
  const [bulkDeleting, setBulkDeleting] = useState(false);
  const [cierreSaleMenu, setCierreSaleMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  const [bulkDeleteProgress, setBulkDeleteProgress] = useState(0);
  // processing (guardar cierre) preview + progress
  const [processPreviewOpen, setProcessPreviewOpen] = useState(false);
  const [processPreviewItems, setProcessPreviewItems] = useState<SaleData[]>(
    [],
  );
  const [processPreviewCount, setProcessPreviewCount] = useState(0);
  const [processing, setProcessing] = useState(false);
  const [processingProgress, setProcessingProgress] = useState(0);

  // generic single-operation working overlay
  const [working, setWorking] = useState(false);
  const [workingMessage, setWorkingMessage] = useState("");

  const pdfRef = useRef<HTMLDivElement>(null);

  const [refreshKey, setRefreshKey] = useState(0);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const handleRefresh = useCallback(() => {
    setIsRefreshing(true);
    setRefreshKey((k) => k + 1);
    setTimeout(() => setIsRefreshing(false), 1200);
  }, []);

  const subject = roles && roles.length ? roles : role;
  const isAdmin = !subject || hasRole(subject, "admin");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const currentEmailNorm = (currentUserEmail || "").trim().toLowerCase();

  // vendedores para KPI listado + filtro
  const [sellers, setSellers] = useState<SellerCandy[]>([]);
  // Hacer accesible la lista de sellers globalmente para normalizeMany
  if (typeof window !== "undefined") {
    (window as any).__SELLERS__ = sellers;
  }

  const sellersMap = React.useMemo(() => {
    const m: Record<string, SellerCandy> = {};
    sellers.forEach((x) => {
      if (x && x.id) m[x.id] = x;
    });
    return m;
  }, [sellers]);

  const getSellerDisplayName = (s: SaleData): string => {
    const vid = (s.vendorId || "").trim();
    // 1) intentar match por vendorId (id del doc)
    if (vid) {
      const seller = sellersMap[vid];
      if (seller && seller.name) return seller.name;
    }

    // 2) intentar match por userEmail (algunas ventas guardan email o nombre)
    const user = (s.userEmail || "").trim();
    if (user) {
      const byId = sellers.find((x) => x.id === user);
      if (byId && byId.name) return byId.name;

      const byNameExact = sellers.find(
        (x) => (x.name || "").trim().toLowerCase() === user.toLowerCase(),
      );
      if (byNameExact && byNameExact.name) return byNameExact.name;

      const byNamePartial = sellers.find((x) =>
        (x.name || "").toLowerCase().includes(user.toLowerCase()),
      );
      if (byNamePartial && byNamePartial.name) return byNamePartial.name;
    }

    // 3) intentar match por vendorId tratado como nombre
    if (vid) {
      const byNameFromVid = sellers.find(
        (x) => (x.name || "").trim().toLowerCase() === vid.toLowerCase(),
      );
      if (byNameFromVid && byNameFromVid.name) return byNameFromVid.name;
    }

    // fallback: mostrar lo que venga en la venta
    return s.userEmail || s.vendorId || "(sin vendedor)";
  };

  const [customersById, setCustomersById] = useState<Record<string, string>>(
    {},
  );
  const [abonosRows, setAbonosRows] = useState<AbonoRow[]>([]);
  const [abonosLoading, setAbonosLoading] = useState(false);

  // catálogo de productos (para mapear categoría)
  const [productCategoryMap, setProductCategoryMap] = useState<
    Record<string, string>
  >({});
  // mapa upaquete por vendedor -> producto (normalizado)
  const [upaqueteMap, setUpaqueteMap] = useState<
    Record<string, Record<string, number>>
  >({});
  const [uvxpaqMap, setUvxpaqMap] = useState<
    Record<string, Record<string, number>>
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
          const parts = normalizeMany(
            d.data() as SaleDataRaw,
            d.id,
            upaqueteMap,
          );
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
  // cargar vendedores (suscripción en tiempo real para reflejar cambios)
  useEffect(() => {
    const col = collection(db, "sellers_candies");
    const unsub = onSnapshot(
      col,
      (snap) => {
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
      },
      (err) => {
        console.error("Error cargando sellers_candies", err);
      },
    );
    return () => unsub();
  }, []);

  // cargar clientes (para nombre en abonos)
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, "customers_candies"));
        const map: Record<string, string> = {};
        snap.forEach((d) => {
          const data = d.data() as any;
          map[d.id] = String(data?.name || "");
        });
        setCustomersById(map);
      } catch (e) {
        console.error("Error cargando customers_candies", e);
        setCustomersById({});
      }
    })();
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

  const getSalePriceLabel = (s: SaleData): string => {
    if (typeof s.price === "number" && !Number.isNaN(s.price)) {
      return `C$${money(s.price)}`;
    }

    const qty = Number(s.quantity || 0);
    if (qty > 0 && typeof s.amount === "number") {
      return `C$${money(s.amount / qty)}`;
    }

    return "—";
  };

  const getSaleCommissionLabel = (s: SaleData): string => {
    const commission = getUvXpaqForSale(s);
    return commission > 0 ? `C$${money(round2(commission))}` : "—";
  };

  // Ganancia total del vendedor para la venta (vendorGain)
  const getVendorGain = (s: SaleData): number => {
    const explicit = Number(s.vendorGain ?? NaN);
    if (Number.isFinite(explicit)) return round2(explicit);
    const uv = getUvXpaqForSale(s);
    const qty = Number(s.quantity || 0);
    if (!uv || qty <= 0) return 0;
    return round2(uv * qty);
  };

  const getVendorGainLabel = (s: SaleData): string => {
    const g = getVendorGain(s);
    return g > 0 ? `C$${money(g)}` : "—";
  };

  // Origen de la comisión: 'venta' si la venta trae vendorCommissionAmount, sino 'uvxpaq' calculada
  const getCommissionOrigin = (s: SaleData): "venta" | "uvxpaq" => {
    const explicit = Number(s.vendorCommissionAmount ?? NaN);
    return Number.isFinite(explicit) ? "venta" : "uvxpaq";
  };

  // utilidad del vendedor (helper)
  const getVendorUtility = (s: SaleData): number => {
    return round2(Number(s.vendorUtility ?? 0) || 0);
  };

  const getVendorNetUtility = (s: SaleData): number => {
    return round2(Number(s.vendorNetUtility ?? 0) || 0);
  };

  const getCommissionFromItems = (s: SaleData): number => {
    return round2(Number(s.commissionFromItems ?? 0) || 0);
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

  // Cargar U. Paquete y UVxPaq desde órdenes de vendedor (inventory_candies_sellers)
  useEffect(() => {
    (async () => {
      try {
        const vendorIds = Array.from(
          new Set(
            visibleSales.map((s) => (s.vendorId || "").trim()).filter(Boolean),
          ),
        );
        if (!vendorIds.length) {
          setUpaqueteMap({});
          setUvxpaqMap({});
          return;
        }

        // Firestore 'in' accepts max 10 items; chunk vendorIds
        const chunk = (arr: string[], size = 10) => {
          const out: string[][] = [];
          for (let i = 0; i < arr.length; i += size)
            out.push(arr.slice(i, i + size));
          return out;
        };

        const mapUpa: Record<string, Record<string, number>> = {};
        const mapUv: Record<string, Record<string, number>> = {};
        const chunks = chunk(vendorIds, 10);
        for (const c of chunks) {
          const q = query(
            collection(db, "inventory_candies_sellers"),
            where("sellerId", "in", c),
          );
          const snap = await getDocs(q);
          snap.forEach((d) => {
            const x = d.data() as any;
            const sid = String(x.sellerId || "").trim();
            if (!sid) return;
            mapUpa[sid] = mapUpa[sid] || {};
            mapUv[sid] = mapUv[sid] || {};
            // Normalize product key: prefer productName, fallback to productId
            const pname = String(
              x.productName || x.productName?.toString() || "",
            );
            const key = pname ? normKey(pname) : String(x.productId || "");
            // usar SOLO el campo uNetaPorPaquete de Firestore
            const valUpa = Number(x.uNetaPorPaquete ?? NaN);
            if (Number.isFinite(valUpa)) {
              mapUpa[sid][key] = valUpa;
            }
            // El resto igual para mapUv
            const explicitUv = Number(
              x.uvXpaq ?? x.uvxpaq ?? x.uVxPaq ?? x.u_vxpaq ?? NaN,
            );
            let valUv = NaN as number;
            if (Number.isFinite(explicitUv)) valUv = explicitUv;
            else {
              const uVend = Number(x.uVendor ?? x.vendorProfit ?? 0);
              const packs = Math.max(1, Number(x.packages ?? 0));
              valUv = packs > 0 ? uVend / packs : 0;
            }
            mapUv[sid][key] = Number(valUv || 0);
          });
        }
        setUpaqueteMap(mapUpa);
        setUvxpaqMap(mapUv);
      } catch (e) {
        console.error("Error cargando U. Paquete:", e);
        setUpaqueteMap({});
        setUvxpaqMap({});
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleSales]);

  useEffect(() => {
    if (!startDate || !endDate) return;

    (async () => {
      try {
        setAbonosLoading(true);

        const qAr = query(
          collection(db, "ar_movements"),
          where("date", ">=", startDate),
          where("date", "<=", endDate),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qAr);

        const rows: AbonoRow[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          if (getARKind(x) !== "ABONO") return;

          const amount = pickAmountAR(x);
          if (!(amount > 0)) return;

          const vendorId = String(x.vendorId || "");
          if (isAdmin && vendorFilter !== "ALL" && vendorId !== vendorFilter) {
            return;
          }
          if (isVendDulces && sellerCandyId && vendorId !== sellerCandyId) {
            return;
          }

          const custId = String(x.customerId || "").trim();
          const customerName = customersById[custId] || "";
          const saleId = String(
            x?.ref?.saleId || x?.ref?.id || x?.saleId || x?.reference || "",
          ).trim();

          rows.push({
            id: d.id,
            date: String(x.date || ""),
            customerId: custId || undefined,
            customerName,
            amount,
            saleId: saleId || undefined,
            vendorId: vendorId || undefined,
            balanceBefore: Number(x.balanceBefore ?? NaN),
            balanceAfter: Number(x.balanceAfter ?? NaN),
            saleRemainingBefore: Number(x.saleRemainingBefore ?? NaN),
            saleRemainingAfter: Number(x.saleRemainingAfter ?? NaN),
            comment: String(x.comment || ""),
          });
        });

        setAbonosRows(
          rows.sort((a, b) => (b.date || "").localeCompare(a.date || "")),
        );
      } catch (e) {
        console.error("Error cargando abonos:", e);
        setAbonosRows([]);
      } finally {
        setAbonosLoading(false);
      }
    })();
  }, [
    startDate,
    endDate,
    vendorFilter,
    isAdmin,
    isVendDulces,
    sellerCandyId,
    customersById,
  ]);

  const getUpaqueteForSale = (s: SaleData | undefined): number | null => {
    if (!s) return null;
    const key = normKey(s.productName || "");

    // Prefer explicit upaquete stored on the sale item (if exists)
    try {
      if (Array.isArray((s as any).items) && (s as any).items.length > 0) {
        const it = (s as any).items[0];
        const fromItem = Number(it?.upaquete ?? NaN);
        if (Number.isFinite(fromItem)) return Number(fromItem || 0);
      }
    } catch (e) {
      // ignore
    }

    const candidates = [s.vendorId || "", sellerCandyId || ""].filter(Boolean);
    for (const cid of candidates) {
      const vmap = upaqueteMap[cid || ""];
      const val = vmap ? vmap[key] : undefined;
      if (val !== undefined && val !== null) return Number(val || 0);
    }

    return null;
  };

  const getUvXpaqForSale = (s: SaleData | undefined): number => {
    if (!s) return 0;
    const key = normKey(s.productName || "");
    const candidates = [s.vendorId || "", sellerCandyId || ""].filter(Boolean);
    const isHistoric = String(s.date || "") <= UVXPAQ_CUTOFF_DATE;
    if (isHistoric) {
      for (const cid of candidates) {
        const vmap = uvxpaqMap[cid || ""];
        const val = vmap ? vmap[key] : undefined;
        if (val !== undefined && val !== null) return round2(Number(val || 0));
      }
    } else {
      const explicit = Number(s.uvXpaq ?? NaN);
      if (Number.isFinite(explicit)) return round2(Number(explicit || 0));
    }

    const qty = Math.max(1, Number(s.quantity || 0));
    const uVend = Number(getCommissionFromItems(s) || 0);
    return uVend > 0 ? round2(uVend / qty) : 0;
  };

  const buildUpaqueteMap = async (vendorIds: string[]) => {
    const chunk = (arr: string[], size = 10) => {
      const out: string[][] = [];
      for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
      return out;
    };

    const map: Record<string, Record<string, number>> = {};
    const chunks = chunk(vendorIds, 10);
    for (const c of chunks) {
      const q = query(
        collection(db, "inventory_candies_sellers"),
        where("sellerId", "in", c),
      );
      const snap = await getDocs(q);
      snap.forEach((d) => {
        const x = d.data() as any;
        const sid = String(x.sellerId || "").trim();
        if (!sid) return;
        map[sid] = map[sid] || {};
        const pname = String(x.productName || x.productName?.toString() || "");
        const key = pname ? normKey(pname) : String(x.productId || "");
        const explicit = Number(
          x.upaquete ?? x.uPaquete ?? x.u_per_package ?? NaN,
        );
        let val = NaN as number;
        if (Number.isFinite(explicit)) val = explicit;
        else {
          const gross = Number(x.grossProfit ?? x.gainVendor ?? 0);
          const packs = Math.max(1, Number(x.packages ?? 0));
          val = packs > 0 ? gross / packs : 0;
        }
        map[sid][key] = Number(val || 0);
      });
    }
    return map;
  };

  const buildUvxpaqMap = async (vendorIds: string[]) => {
    const chunk = (arr: string[], size = 10) => {
      const out: string[][] = [];
      for (let i = 0; i < arr.length; i += size)
        out.push(arr.slice(i, i + size));
      return out;
    };

    const map: Record<string, Record<string, number>> = {};
    const chunks = chunk(vendorIds, 10);
    for (const c of chunks) {
      const q = query(
        collection(db, "inventory_candies_sellers"),
        where("sellerId", "in", c),
      );
      const snap = await getDocs(q);
      snap.forEach((d) => {
        const x = d.data() as any;
        const sid = String(x.sellerId || "").trim();
        if (!sid) return;
        map[sid] = map[sid] || {};
        const pname = String(x.productName || x.productName?.toString() || "");
        const key = pname ? normKey(pname) : String(x.productId || "");
        const explicit = Number(
          x.uvXpaq ?? x.uvxpaq ?? x.uVxPaq ?? x.u_vxpaq ?? NaN,
        );
        let val = NaN as number;
        if (Number.isFinite(explicit)) val = explicit;
        else {
          const uVend = Number(x.uVendor ?? x.vendorProfit ?? 0);
          const packs = Math.max(1, Number(x.packages ?? 0));
          val = packs > 0 ? uVend / packs : 0;
        }
        map[sid][key] = Number(val || 0);
      });
    }
    return map;
  };

  const backfillUvXpaqInSales = async () => {
    if (!isAdmin) return;
    if (isBackfillingUv) return;

    if (
      !window.confirm(
        "¿Actualizar UVxPaq en las ventas del periodo seleccionado?",
      )
    )
      return;

    try {
      setIsBackfillingUv(true);
      setMessage("");

      const qSales = query(
        collection(db, "sales_candies"),
        where("date", ">=", startDate),
        where("date", "<=", endDate),
        orderBy("date", "asc"),
      );
      const snap = await getDocs(qSales);

      const vendorIds = Array.from(
        new Set(
          snap.docs
            .map((d) => String((d.data() as any)?.vendorId || "").trim())
            .filter(Boolean),
        ),
      );

      const map = vendorIds.length ? await buildUvxpaqMap(vendorIds) : {};

      let batch = writeBatch(db);
      let pending = 0;
      let updatedDocs = 0;
      let updatedItems = 0;

      snap.docs.forEach((d) => {
        const data = d.data() as any;
        const vendorId = String(data?.vendorId || "").trim();
        const items = Array.isArray(data?.items) ? data.items : [];

        if (items.length > 0) {
          let changed = false;
          const nextItems = items.map((it: any) => {
            const pname = String(it?.productName || data?.productName || "");
            const key = normKey(pname);
            const val = map?.[vendorId]?.[key];
            if (!Number.isFinite(Number(val))) return it;
            const current = Number(it?.uvXpaq ?? NaN);
            if (Number.isFinite(current)) return it;
            changed = true;
            updatedItems += 1;
            return { ...it, uvXpaq: round2(Number(val || 0)) };
          });

          if (changed) {
            batch.update(doc(db, "sales_candies", d.id), {
              items: nextItems,
              uvxpaqUpdatedAt: Timestamp.now(),
            });
            pending += 1;
            updatedDocs += 1;
          }
        } else {
          const pname = String(data?.productName || "");
          const key = normKey(pname);
          const val = map?.[vendorId]?.[key];
          if (Number.isFinite(Number(val))) {
            batch.update(doc(db, "sales_candies", d.id), {
              uvXpaq: round2(Number(val || 0)),
              uvxpaqUpdatedAt: Timestamp.now(),
            });
            pending += 1;
            updatedDocs += 1;
          }
        }

        if (pending >= 400) {
          batch.commit();
          batch = writeBatch(db);
          pending = 0;
        }
      });

      if (pending > 0) await batch.commit();

      setMessage(
        `✅ UVxPaq actualizado. Docs: ${updatedDocs}. Items: ${updatedItems}.`,
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ Error actualizando UVxPaq.");
    } finally {
      setIsBackfillingUv(false);
    }
  };

  const backfillLegacySales = async () => {
    if (!isAdmin) return;
    if (
      !window.confirm(
        "¿Backfill: calcular y persistir uNetaPorPaquete, vendorGain, inversorGain en ventas del periodo?",
      )
    )
      return;

    try {
      setMessage("");
      const qSales = query(
        collection(db, "sales_candies"),
        where("date", ">=", startDate),
        where("date", "<=", endDate),
        orderBy("date", "asc"),
      );
      const snap = await getDocs(qSales);

      const vendorIds = Array.from(
        new Set(
          snap.docs
            .map((d) => String((d.data() as any)?.vendorId || "").trim())
            .filter(Boolean),
        ),
      );

      const upaMap = vendorIds.length ? await buildUpaqueteMap(vendorIds) : {};
      const uvMap = vendorIds.length ? await buildUvxpaqMap(vendorIds) : {};

      let batch = writeBatch(db);
      let pending = 0;
      let updatedDocs = 0;

      for (const d of snap.docs) {
        const data = d.data() as any;
        const vendorId = String(data?.vendorId || "").trim();
        const items = Array.isArray(data?.items) ? data.items : [];

        let changed = false;
        const nextItems = items.map((it: any) => {
          const qtyPaq = Number(it?.packages ?? it?.qty ?? it?.quantity ?? 0);
          const pname = String(it?.productName || data?.productName || "");
          const key = normKey(pname);

          const uNetaFromMap = upaMap?.[vendorId]?.[key];
          const uNetaPorPaquete = Number.isFinite(Number(uNetaFromMap))
            ? Number(uNetaFromMap)
            : Number.isFinite(Number(it?.uNetaPorPaquete ?? NaN))
              ? Number(it.uNetaPorPaquete)
              : Number.isFinite(Number(it?.uNeta ?? NaN)) && qtyPaq > 0
                ? round2(Number(it.uNeta) / qtyPaq)
                : undefined;

          const uvFromMap = uvMap?.[vendorId]?.[key];
          const uvxpaqFinal = Number.isFinite(Number(it?.uvXpaq ?? NaN))
            ? Number(it.uvXpaq)
            : Number.isFinite(Number(uvFromMap))
              ? Number(uvFromMap)
              : undefined;

          const vendorGain = round2(
            Number(uvxpaqFinal || 0) * Number(qtyPaq || 0),
          );
          const inversorGain = round2(
            Number(uNetaPorPaquete || 0) * Number(qtyPaq || 0),
          );

          const provider = Number(it?.providerPricePerPackage ?? 0);
          const unitPrice = Number(it?.unitPricePackage ?? it?.unitPrice ?? 0);
          const computedUBruta = round2((unitPrice - provider) * qtyPaq);

          const newIt = {
            ...it,
            uNetaPorPaquete: uNetaPorPaquete ?? it.uNetaPorPaquete,
            uvXpaq: Number.isFinite(Number(uvxpaqFinal))
              ? round2(Number(uvxpaqFinal))
              : it.uvXpaq,
            vendorGain,
            inversorGain,
            uBruta: it.uBruta || computedUBruta,
          };

          if (
            newIt.uNetaPorPaquete !== it.uNetaPorPaquete ||
            newIt.uvXpaq !== it.uvXpaq ||
            newIt.vendorGain !== it.vendorGain ||
            newIt.inversorGain !== it.inversorGain ||
            newIt.uBruta !== it.uBruta
          ) {
            changed = true;
          }

          return newIt;
        });

        if (changed) {
          batch.update(doc(db, "sales_candies", d.id), {
            items: nextItems,
            legacyCorrected: true,
            uvxpaqUpdatedAt: Timestamp.now(),
          });
          pending += 1;
          updatedDocs += 1;
        }

        if (pending >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          pending = 0;
        }
      }

      if (pending > 0) await batch.commit();

      setMessage(`✅ Backfill completo. Docs actualizados: ${updatedDocs}`);
    } catch (e) {
      console.error(e);
      setMessage("❌ Error durante backfill de ventas.");
    }
  };

  const cashSales = React.useMemo(() => {
    return [...visibleSales]
      .filter((s) => s.type !== "CREDITO")
      .sort((a, b) => {
        const d = (b.date || "").localeCompare(a.date || "");
        if (d !== 0) return d;
        return String(b.registeredAt || "").localeCompare(
          String(a.registeredAt || ""),
        );
      });
  }, [visibleSales]);
  const creditSales = React.useMemo(() => {
    return [...visibleSales]
      .filter((s) => s.type === "CREDITO")
      .sort((a, b) => {
        const d = (b.date || "").localeCompare(a.date || "");
        if (d !== 0) return d;
        return String(b.registeredAt || "").localeCompare(
          String(a.registeredAt || ""),
        );
      });
  }, [visibleSales]);

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

  const hasVisibleSales = visibleSales.length > 0;

  // ✅ Contadores para acciones masivas (usados en los botones)
  const bulkRevertCashCount = React.useMemo(
    () =>
      visibleSales.filter(
        (s) => s.status === "PROCESADA" && s.type !== "CREDITO",
      ).length,
    [visibleSales],
  );
  const bulkRevertCreditCount = React.useMemo(
    () =>
      visibleSales.filter(
        (s) => s.status === "PROCESADA" && s.type === "CREDITO",
      ).length,
    [visibleSales],
  );
  const bulkDeleteCashCount = React.useMemo(
    () =>
      visibleSales.filter(
        (s) => s.status === "FLOTANTE" && s.type !== "CREDITO",
      ).length,
    [visibleSales],
  );
  const bulkDeleteCreditCount = React.useMemo(
    () =>
      visibleSales.filter(
        (s) => s.status === "FLOTANTE" && s.type === "CREDITO",
      ).length,
    [visibleSales],
  );

  // Totales visibles (quantity = paquetes)
  const totalPaquetes = Math.round(
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

    if (s.type === "CREDITO") {
      totalPacksCredito += Math.round(s.quantity || 0);
      totalPendienteCredito += amt - received;
    } else {
      totalPacksCash += Math.round(s.quantity || 0);
      totalCobradoCash += amt;
    }
  });

  // Calcular comisiones totales por venta: usar vendorGain (persistido) o uvxpaq*paquetes
  let tCommCash = 0;
  let tCommCredito = 0;
  visibleSales.forEach((s) => {
    const saleComm = round2(getVendorGain(s));
    if (s.type === "CREDITO") tCommCredito += saleComm;
    else tCommCash += saleComm;
  });
  totalCommissionCash = round2(tCommCash);
  totalCommissionCredito = round2(tCommCredito);
  totalCommission = round2(totalCommissionCash + totalCommissionCredito);

  totalPendienteCredito = round2(totalPendienteCredito);
  totalCobradoCash = round2(totalCobradoCash);
  totalCommissionCash = round2(totalCommissionCash);
  totalCommissionCredito = round2(totalCommissionCredito);

  const totalAbonos = round2(
    abonosRows.reduce((sum, r) => sum + Number(r.amount || 0), 0),
  );
  const totalCobrado = round2(totalCobradoCash + totalAbonos);

  // ✅ KPI: comisiones por vendedor en el periodo (CASH / CRÉDITO separados)
  const vendorCommissionRowsCash = React.useMemo(() => {
    const map = new Map<
      string,
      {
        vendorId: string;
        name: string;
        total: number;
        products: Map<
          string,
          { qty: number; sample: SaleData; commission?: number }
        >;
      }
    >();
    for (const s of visibleSales) {
      const vid = (s.vendorId || "").trim();
      if (!vid) continue;
      if (s.type === "CREDITO") continue; // solo cash
      const seller = sellers.find((x) => x.id === vid);
      if (!map.has(vid)) {
        map.set(vid, {
          vendorId: vid,
          name: seller?.name || s.userEmail || "(sin vendedor)",
          total: 0,
          products: new Map(),
        });
      }
      const entry = map.get(vid)!;
      const pkey = normKey(s.productName || "");
      const current = entry.products.get(pkey);
      // Comisión KPI: usar vendorGain (persistido) o uvxpaq * paquetes como fallback
      const saleComm = round2(getVendorGain(s));

      if (current) {
        current.qty += Math.round(s.quantity || 0);
        current.commission = round2((current.commission || 0) + saleComm);
      } else {
        entry.products.set(pkey, {
          qty: Math.round(s.quantity || 0),
          sample: s,
          commission: saleComm,
        });
      }
      entry.total = round2((entry.total || 0) + saleComm);
    }
    return Array.from(map.values())
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [visibleSales, sellers]);

  const vendorCommissionRowsCredito = React.useMemo(() => {
    const map = new Map<
      string,
      {
        vendorId: string;
        name: string;
        total: number;
        products: Map<
          string,
          { qty: number; sample: SaleData; commission?: number }
        >;
      }
    >();
    for (const s of visibleSales) {
      const vid = (s.vendorId || "").trim();
      if (!vid) continue;
      if (s.type !== "CREDITO") continue; // solo crédito
      const seller = sellers.find((x) => x.id === vid);
      if (!map.has(vid)) {
        map.set(vid, {
          vendorId: vid,
          name: seller?.name || s.userEmail || "(sin vendedor)",
          total: 0,
          products: new Map(),
        });
      }
      const entry = map.get(vid)!;
      const pkey = normKey(s.productName || "");
      const current = entry.products.get(pkey);
      // Comisión KPI: usar vendorGain (persistido) o uvxpaq * paquetes como fallback
      const saleComm = round2(getVendorGain(s));

      if (current) {
        current.qty += Math.round(s.quantity || 0);
        current.commission = round2((current.commission || 0) + saleComm);
      } else {
        entry.products.set(pkey, {
          qty: Math.round(s.quantity || 0),
          sample: s,
          commission: saleComm,
        });
      }
      entry.total = round2((entry.total || 0) + saleComm);
    }
    return Array.from(map.values())
      .filter((x) => x.total > 0)
      .sort((a, b) => b.total - a.total);
  }, [visibleSales, sellers]);

  // Consolidado por producto (desglose Cash / Crédito)
  const productMap: Record<
    string,
    {
      paqCash: number;
      paqCredito: number;
      montoCash: number;
      montoCredito: number;
      commCash: number;
      commCredito: number;
    }
  > = {};

  visibleSales.forEach((s) => {
    const key = s.productName || "(sin nombre)";
    if (!productMap[key])
      productMap[key] = {
        paqCash: 0,
        paqCredito: 0,
        montoCash: 0,
        montoCredito: 0,
        commCash: 0,
        commCredito: 0,
      };

    const qty = Math.round(s.quantity || 0);
    const amt = Number(s.amount || 0);
    // Comision en consolidado: UV x Paquetes (no usar vendorCommissionAmount)
    const comm = round2(getUvXpaqForSale(s) * Number(s.quantity || 0));

    if (s.type === "CREDITO") {
      productMap[key].paqCredito = Math.round(productMap[key].paqCredito + qty);
      productMap[key].montoCredito = round2(productMap[key].montoCredito + amt);
      productMap[key].commCredito = round2(productMap[key].commCredito + comm);
    } else {
      productMap[key].paqCash = Math.round(productMap[key].paqCash + qty);
      productMap[key].montoCash = round2(productMap[key].montoCash + amt);
      productMap[key].commCash = round2(productMap[key].commCash + comm);
    }
  });

  const productSummaryArray = Object.entries(productMap).map(
    ([productName, v]) => ({
      productName,
      category: productCategoryMap[normKey(productName)] || "(sin categoría)",
      paqCash: Math.round(v.paqCash),
      paqCredito: Math.round(v.paqCredito),
      montoCash: round2(v.montoCash),
      montoCredito: round2(v.montoCredito),
      commCash: round2(v.commCash),
      commCredito: round2(v.commCredito),
      totalQuantity: Math.round(v.paqCash + v.paqCredito),
      totalAmount: round2(v.montoCash + v.montoCredito),
      totalCommission: round2(v.commCash + v.commCredito),
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
      map[cat].totalQuantity = Math.round(
        map[cat].totalQuantity + Math.round(row.totalQuantity || 0),
      );
      map[cat].totalAmount = round2(
        map[cat].totalAmount + (row.montoCash || 0) + (row.montoCredito || 0),
      );
      map[cat].totalCommission = round2(
        map[cat].totalCommission + (row.commCash || 0) + (row.commCredito || 0),
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
    // Open preview modal instead of immediate processing
    if (!isAdmin) return;
    const toProcess = visibleSales.filter((s) => s.status === "FLOTANTE");
    if (toProcess.length === 0) {
      setMessage("No hay ventas flotantes para procesar en este período.");
      return;
    }

    setProcessPreviewItems(toProcess.slice(0, 10));
    setProcessPreviewCount(toProcess.length);
    setProcessPreviewOpen(true);
  };

  // perform processing after confirm in modal
  const performProcessClosure = async () => {
    if (!isAdmin) return;
    const toProcess = visibleSales.filter((s) => s.status === "FLOTANTE");
    if (toProcess.length === 0) {
      setMessage("No hay ventas flotantes para procesar en este período.");
      setProcessPreviewOpen(false);
      return;
    }

    try {
      setProcessing(true);
      setProcessingProgress(0);
      // create closure doc first
      const totals = {
        totalCharged: round2(
          toProcess.reduce((a, s) => a + (s.amount || 0), 0),
        ),
        totalSuggested: round2(
          toProcess.reduce((a, s) => a + (s.amountSuggested || 0), 0),
        ),
        totalUnits: Math.round(
          toProcess.reduce((a, s) => a + Math.round(s.quantity || 0), 0),
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
          // Para KPIs y totales del cierre, usar UV x Paquetes
          const com = round2(getUvXpaqForSale(s) * qty);

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
        totalPacksCash: Math.round(split.packsCash),
        totalPacksCredit: Math.round(split.packsCredit),
        totalAmountCash: round2(split.amountCash),
        totalAmountCredit: round2(split.amountCredit),
        totalCommissionCash: round2(split.comCash),
        totalCommissionCredit: round2(split.comCredit),
      };

      const ref = await addDoc(collection(db, "daily_closures_candies"), {
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
        ...totalsSplit,
        products: toProcess.map((s) => ({
          productName: s.productName,
          quantity: Math.round(s.quantity),
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
          date: s.date,
          type: s.type ?? "CONTADO",
          vendorId: s.vendorId ?? "",
          vendorCommissionAmount: Number(s.vendorCommissionAmount ?? 0) || 0,
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

      // Log closure creation
      try {
        await addDoc(collection(db, "events"), {
          type: "closure_candies",
          action: "create",
          entity: "daily_closures_candies",
          entityId: ref.id,
          user: currentUserEmail || null,
          createdAt: Timestamp.now(),
          meta: { periodStart: startDate, periodEnd: endDate },
        });
      } catch (e) {
        console.warn("No se pudo registrar evento de cierre", e);
      }

      // update each sale individually to provide progress feedback
      let processed = 0;
      for (const s of toProcess) {
        try {
          await updateDoc(doc(db, "sales_candies", s.id.split("#")[0]), {
            status: "PROCESADA",
            closureId: ref.id,
            closureDate: today,
            processedDate: today,
            processedAt: Timestamp.now(),
          });
          // Log sale processed
          try {
            await addDoc(collection(db, "events"), {
              type: "sale_candy",
              action: "process",
              entity: "sales_candies",
              entityId: s.id.split("#")[0],
              user: currentUserEmail || null,
              createdAt: Timestamp.now(),
              meta: { closureId: ref.id },
            });
          } catch (e) {
            console.warn("No se pudo registrar evento de proceso de venta", e);
          }
        } catch (e) {
          console.error("Error procesando venta", s.id, e);
        }
        processed += 1;
        setProcessingProgress(processed);
      }

      setMessage(
        `✅ Cierre guardado. Ventas procesadas: ${toProcess.length}. (Proceso: ${today})`,
      );
    } catch (error) {
      console.error(error);
      setMessage("❌ Error al guardar el cierre de dulces.");
    } finally {
      setProcessing(false);
      setProcessingProgress(0);
      setProcessPreviewOpen(false);
    }
  };

  const handleRevert = async (saleId: string) => {
    if (!isAdmin) return;
    if (
      !window.confirm("¿Revertir esta venta? Esta acción no se puede deshacer.")
    )
      return;
    try {
      setWorking(true);
      setWorkingMessage("Revirtiendo venta...");
      await updateDoc(doc(db, "sales_candies", saleId.split("#")[0]), {
        status: "FLOTANTE",
        closureId: null,
        closureDate: null,
        processedDate: null,
        processedAt: null,
      });
      setMessage("↩️ Venta revertida a FLOTANTE.");
      try {
        await addDoc(collection(db, "events"), {
          type: "sale_candy",
          action: "revert",
          entity: "sales_candies",
          entityId: saleId.split("#")[0],
          user: currentUserEmail || null,
          createdAt: Timestamp.now(),
        });
      } catch (e) {
        console.warn("No se pudo registrar evento de revertir venta", e);
      }
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo revertir la venta.");
    } finally {
      setWorking(false);
      setWorkingMessage("");
    }
  };

  // Revertir ventas procesadas en lote (por tipo) — ahora abre un modal de previsualización
  const handleBulkRevert = async (forCredit: boolean) => {
    if (!isAdmin) return;
    const toRevert = visibleSales.filter(
      (s) =>
        s.status === "PROCESADA" &&
        (forCredit ? s.type === "CREDITO" : s.type !== "CREDITO"),
    );

    if (toRevert.length === 0) {
      const label = forCredit ? "Crédito" : "Cash";
      setMessage(`No hay ventas procesadas de ${label} para revertir.`);
      return;
    }

    // Mostrar modal con previsualización (hasta 10 filas)
    setBulkPreviewItems(toRevert.slice(0, 10));
    setBulkPreviewCount(toRevert.length);
    setBulkPreviewForCredit(forCredit);
    setBulkPreviewOpen(true);
  };

  // Ejecuta la reversión después de confirmación en modal
  const performBulkRevert = async () => {
    if (!isAdmin) return;
    const forCredit = bulkPreviewForCredit;
    const toRevert = visibleSales.filter(
      (s) =>
        s.status === "PROCESADA" &&
        (forCredit ? s.type === "CREDITO" : s.type !== "CREDITO"),
    );
    if (toRevert.length === 0) {
      setMessage("No hay ventas para revertir.");
      setBulkPreviewOpen(false);
      return;
    }
    try {
      setWorking(true);
      setWorkingMessage("Revirtiendo ventas...");
      const batch = writeBatch(db);
      toRevert.forEach((s) => {
        batch.update(doc(db, "sales_candies", s.id.split("#")[0]), {
          status: "FLOTANTE",
          closureId: null,
          closureDate: null,
          processedDate: null,
          processedAt: null,
        });
      });
      await batch.commit();
      setMessage(
        `↩️ Revertidas ${toRevert.length} ventas (${forCredit ? "Crédito" : "Cash"}).`,
      );
      // Log bulk revert events
      try {
        for (const s of toRevert) {
          await addDoc(collection(db, "events"), {
            type: "sale_candy",
            action: "revert",
            entity: "sales_candies",
            entityId: s.id.split("#")[0],
            user: currentUserEmail || null,
            createdAt: Timestamp.now(),
          });
        }
      } catch (e) {
        console.warn("No se pudieron registrar eventos de revertir en lote", e);
      }
    } catch (e) {
      console.error(e);
      setMessage("❌ Error al revertir ventas en lote.");
    } finally {
      setBulkPreviewOpen(false);
      setWorking(false);
      setWorkingMessage("");
    }
  };

  // Ejecuta la eliminación masiva (usa mismo proceso que el botón individual)
  const performBulkDelete = async () => {
    if (!isAdmin) return;
    setBulkDeleting(true);
    setBulkDeleteProgress(0);
    const forCredit = bulkDeleteForCredit;
    const toDelete = (forCredit ? creditSales : cashSales).filter(
      (s) => s.status === "FLOTANTE",
    );

    if (toDelete.length === 0) {
      setMessage("No hay ventas para eliminar.");
      setBulkDeleteOpen(false);
      setBulkDeleting(false);
      return;
    }

    let restoredTotal = 0;
    let successCount = 0;
    let failCount = 0;
    let processed = 0;

    for (const s of toDelete) {
      const baseSaleId = (s.id || "").split("#")[0];
      try {
        const { restored } = await restoreCandySaleAndDelete(baseSaleId);
        await deleteARMovesBySaleId(baseSaleId);
        restoredTotal += Number(restored || 0);
        successCount += 1;
        // log deletion
        try {
          await addDoc(collection(db, "events"), {
            type: "sale_candy",
            action: "delete",
            entity: "sales_candies",
            entityId: baseSaleId,
            user: currentUserEmail || null,
            createdAt: Timestamp.now(),
          });
        } catch (e) {
          console.warn("No se pudo registrar evento de eliminación", e);
        }
      } catch (e) {
        console.error("Error eliminando", baseSaleId, e);
        failCount += 1;
      }
      processed += 1;
      setBulkDeleteProgress(processed);
    }

    setMessage(
      `🗑️ Eliminadas ${successCount} ventas. Restauradas unidades: ${restoredTotal}. Errores: ${failCount}`,
    );
    setBulkDeleting(false);
    setBulkDeleteOpen(false);
    setBulkDeleteProgress(0);
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
      setWorking(true);
      setWorkingMessage("Eliminando venta y restaurando stock...");
      const baseSaleId = saleId.split("#")[0];
      const { restored } = await restoreCandySaleAndDelete(baseSaleId);
      await deleteARMovesBySaleId(baseSaleId);
      // log single deletion
      try {
        await addDoc(collection(db, "events"), {
          type: "sale_candy",
          action: "delete",
          entity: "sales_candies",
          entityId: baseSaleId,
          user: currentUserEmail || null,
          createdAt: Timestamp.now(),
        });
      } catch (e) {
        console.warn("No se pudo registrar evento de eliminación", e);
      }
      setMessage(
        `🗑️ Venta eliminada. Stock restaurado (unidades internas): ${Number(
          restored,
        ).toFixed(2)}. Estado de cuenta ajustado.`,
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar la venta de dulces.");
    } finally {
      setWorking(false);
      setWorkingMessage("");
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

  // Export visible sales as CSV
  const csvEscape = (v: unknown) => `"${String(v ?? "").replace(/\"/g, '""')}"`;

  const handleExportCSV = () => {
    const headers = [
      "id",
      "productName",
      "type",
      "quantity",
      "amount",
      "commissionFromItems",
      "vendorNetUtility",

      "date",
      "processedDate",
      "vendor",
      "status",
    ];

    const rows = visibleSales.map((s) => [
      s.id,
      s.productName,
      s.type,
      s.quantity ?? 0,
      Number(s.amount ?? 0).toFixed(2),
      Number(s.commissionFromItems ?? 0).toFixed(2),
      Number(s.vendorNetUtility ?? 0).toFixed(2),
      s.date,
      s.processedDate ?? "",
      getSellerDisplayName(s),
      s.status,
    ]);

    const csv = [
      headers.join(","),
      ...rows.map((r) => r.map(csvEscape).join(",")),
    ].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cierre_dulces_${startDate}_a_${endDate}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  // Export visible sales as real Excel (.xlsx) using SheetJS
  const handleExportXLSX = () => {
    // Columnas igual que la UI (cash/credito):
    // Estado, Producto, Tipo, Paquetes, Precio, Monto, UN x Paq, UV x Paq, Comision, U. Neta, Fecha venta, Vendedor
    const rows = visibleSales.map((s) => {
      const key = normKey(s.productName || "");
      const qty = Number(s.quantity || 0);

      // Precio (numérico)
      let precioNum: number | null = null;
      if (typeof s.price === "number" && !isNaN(s.price)) {
        precioNum = round2(s.price);
      } else if (qty > 0 && typeof s.amount === "number") {
        precioNum = round2(s.amount / qty);
      }

      // UN x Paq: preferir valor de la venta, fallback al mapa
      const fromSaleUn = Number(s.uNetaPorPaquete ?? NaN);
      const u = Number.isFinite(fromSaleUn) && fromSaleUn !== 0
        ? fromSaleUn
        : upaqueteMap[s.vendorId || ""]?.[key];
      // UV x Paq (numérico)
      const uv = getUvXpaqForSale(s);
      // Comision: prefer vendorCommissionAmount, fallback to uv*qty
      const explicit = Number(s.vendorCommissionAmount ?? NaN);
      const saleComm = Number.isFinite(explicit)
        ? round2(explicit)
        : uv > 0
          ? round2(uv * qty)
          : null;
      // U. Neta (numérico)
      const uneta = u && qty > 0 ? round2(Number(u) * qty) : null;

      const origenComision = Number.isFinite(
        Number(s.vendorCommissionAmount ?? NaN),
      )
        ? "venta"
        : "uvxpaq";

      const base: Record<string, unknown> = {
        Estado: s.status,
        Producto: s.productName,
        Tipo: s.type === "CREDITO" ? "Crédito" : "Cash",
        Paquetes: qty,
        Precio: precioNum,
        Monto: round2(Number(s.amount || 0)),
        Comisión: round2(getVendorGain(s)),
        "Origen Comisión": origenComision,
        "Fecha venta": s.date,
        Vendedor: getSellerDisplayName(s),
      };

      if (isAdmin) {
        base["UN x Paq"] = Number.isFinite(Number(u))
          ? round2(Number(u))
          : null;
        base["UV x Paq"] = uv > 0 ? round2(uv) : null;
        base["U. Neta"] = uneta !== null ? round2(Number(uneta)) : null;
      }

      return base;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Ventas");

    // Construir consolidado por producto usando `productSummaryArray` (mismas columnas que la tabla web)
    const prodData: any[] = [
      ["Producto", "Paq cash", "Paq credito", "Monto cash", "Monto credito"],
    ];

    productSummaryArray
      .slice()
      .sort((a, b) => (a.productName || "").localeCompare(b.productName || ""))
      .forEach((row) => {
        prodData.push([
          row.productName,
          Number(row.paqCash || 0),
          Number(row.paqCredito || 0),
          Number(row.montoCash || 0),
          Number(row.montoCredito || 0),
        ]);
      });

    const prodWs = XLSX.utils.aoa_to_sheet(prodData);
    XLSX.utils.book_append_sheet(wb, prodWs, "Consolidado por producto");

    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `cierre_dulces_${startDate}_a_${endDate}.xlsx`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const aggregateSaleTotals = (list: SaleData[]) => {
    let n = 0;
    let packs = 0;
    let amount = 0;
    let unTotal = 0;
    let uvTotal = 0;
    let comm = 0;
    let uNeta = 0;
    for (const s of list) {
      n++;
      const q = Math.max(0, Number(s.quantity || 0));
      packs += q;
      amount += Number(s.amount || 0);
      const key = normKey(s.productName || "");
      const fromSale = Number(s.uNetaPorPaquete ?? NaN);
      const un = Number.isFinite(fromSale) && fromSale !== 0
        ? fromSale
        : upaqueteMap[s.vendorId || ""]?.[key];
      if (un && Number(un) !== 0 && q) unTotal += Number(un) * q;
      const uv = getUvXpaqForSale(s);
      if (uv > 0 && q) uvTotal += uv * q;
      comm += getVendorGain(s);
      if (isAdmin && un && q) uNeta += Number(un) * q;
    }
    return { n, packs, amount, unTotal, uvTotal, comm, uNeta };
  };

  const cashSalesTableTotals = aggregateSaleTotals(cashSales);
  const creditSalesTableTotals = aggregateSaleTotals(creditSales);

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      {/* ✅ CSS interno SOLO para alternar vista en PDF (sin tocar tu data) */}
      <style>{`
        .pdf-print-mode .pdf-desktop { display: block !important; }
        .pdf-print-mode .pdf-mobile  { display: none !important; }
        .pdf-print-mode .collapsible-content { display: block !important; }
      `}</style>

      <div className="flex items-center justify-between mb-4">
        <h2 className="text-xl font-bold">Ventas Diarias</h2>
        <RefreshButton onClick={handleRefresh} loading={isRefreshing} />
      </div>

      {/* Botones de acción arriba de filtros */}
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="relative">
          <button
            type="button"
            onClick={() => setActionsOpen((v) => !v)}
            disabled={!hasVisibleSales}
            title={
              hasVisibleSales
                ? "Ver acciones disponibles para las ventas visibles"
                : "No hay datos en pantalla para ejecutar acciones"
            }
            className={`inline-flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
              hasVisibleSales
                ? "bg-slate-800 text-white hover:bg-slate-900"
                : "bg-slate-500 text-white opacity-60 cursor-not-allowed"
            }`}
          >
            Acciones
            <span
              className={`text-[10px] transition-transform ${
                actionsOpen ? "rotate-180" : ""
              }`}
            >
              ▼
            </span>
          </button>

          {actionsOpen && (
            <div className="absolute z-30 mt-2 w-64 rounded-xl bg-white shadow-lg border border-slate-200 p-2 space-y-2">
              {isAdmin && (
                <button
                  onClick={handleSaveClosure}
                  disabled={!hasVisibleSales || !kpiFloCount || processing}
                  title={
                    !hasVisibleSales
                      ? "No hay datos en pantalla para procesar"
                      : kpiFloCount
                        ? `Procesar ${kpiFloCount} ventas flotantes visibles`
                        : "No hay ventas flotantes en este período para procesar"
                  }
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    !hasVisibleSales || !kpiFloCount || processing
                      ? "bg-blue-400 text-white opacity-60 cursor-not-allowed"
                      : "bg-blue-600 text-white hover:bg-blue-700"
                  }`}
                >
                  <span>Procesar cierre</span>
                  {kpiFloCount ? (
                    <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                      {kpiFloCount}
                    </span>
                  ) : null}
                </button>
              )}

              {isAdmin && (
                <button
                  onClick={backfillUvXpaqInSales}
                  disabled={!hasVisibleSales || isBackfillingUv}
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    !hasVisibleSales || isBackfillingUv
                      ? "bg-emerald-400 text-white opacity-60 cursor-not-allowed"
                      : "bg-emerald-600 text-white hover:bg-emerald-700"
                  }`}
                >
                  <span>
                    {isBackfillingUv
                      ? "Actualizando UVxPaq..."
                      : "Actualizar UVxPaq"}
                  </span>
                </button>
              )}

              {isAdmin && (
                <button
                  onClick={backfillLegacySales}
                  disabled={!hasVisibleSales}
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    hasVisibleSales
                      ? "bg-rose-600 text-white hover:bg-rose-700"
                      : "bg-rose-300 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Backfill ventas (legacy)</span>
                </button>
              )}

              <button
                onClick={handleDownloadPDF}
                disabled={!hasVisibleSales}
                className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                  hasVisibleSales
                    ? "bg-green-600 text-white hover:bg-green-700"
                    : "bg-green-400 text-white opacity-60 cursor-not-allowed"
                }`}
              >
                <span>PDF</span>
              </button>
              <button
                onClick={handleExportCSV}
                disabled={!hasVisibleSales}
                className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                  hasVisibleSales
                    ? "bg-slate-700 text-white hover:bg-slate-800"
                    : "bg-slate-500 text-white opacity-60 cursor-not-allowed"
                }`}
              >
                <span>CSV</span>
              </button>
              <button
                onClick={handleExportXLSX}
                disabled={!hasVisibleSales}
                className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                  hasVisibleSales
                    ? "bg-amber-600 text-white hover:bg-amber-700"
                    : "bg-amber-400 text-white opacity-60 cursor-not-allowed"
                }`}
              >
                <span>Excel</span>
              </button>

              {isAdmin && (
                <button
                  onClick={() => handleBulkRevert(false)}
                  disabled={!bulkRevertCashCount}
                  title={
                    bulkRevertCashCount
                      ? `Revertir ${bulkRevertCashCount} ventas Cash procesadas visibles`
                      : "No hay ventas Cash procesadas en la tabla para revertir"
                  }
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    bulkRevertCashCount
                      ? "bg-rose-600 text-white hover:bg-rose-700"
                      : "bg-rose-300 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Revertir Cash (masivo)</span>
                  {bulkRevertCashCount ? (
                    <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                      {bulkRevertCashCount}
                    </span>
                  ) : null}
                </button>
              )}

              {isAdmin && (
                <button
                  onClick={() => handleBulkRevert(true)}
                  disabled={!bulkRevertCreditCount}
                  title={
                    bulkRevertCreditCount
                      ? `Revertir ${bulkRevertCreditCount} ventas Crédito procesadas visibles`
                      : "No hay ventas Crédito procesadas en la tabla para revertir"
                  }
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    bulkRevertCreditCount
                      ? "bg-rose-700 text-white hover:bg-rose-800"
                      : "bg-rose-300 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Revertir Crédito (masivo)</span>
                  {bulkRevertCreditCount ? (
                    <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                      {bulkRevertCreditCount}
                    </span>
                  ) : null}
                </button>
              )}

              {isAdmin && (
                <button
                  onClick={() => {
                    const forCredit = false;
                    const toDelete = (
                      forCredit ? creditSales : cashSales
                    ).filter((s) => s.status === "FLOTANTE");
                    if (toDelete.length === 0) {
                      setMessage(
                        "No hay ventas en FLOTANTE de Cash para eliminar.",
                      );
                      return;
                    }
                    setBulkDeleteItems(toDelete.slice(0, 10));
                    setBulkDeleteCount(toDelete.length);
                    setBulkDeleteForCredit(forCredit);
                    setBulkDeleteOpen(true);
                  }}
                  disabled={!bulkDeleteCashCount}
                  title={
                    bulkDeleteCashCount
                      ? `Eliminar ${bulkDeleteCashCount} ventas Cash flotantes visibles`
                      : "No hay ventas Cash flotantes en la tabla para eliminar"
                  }
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    bulkDeleteCashCount
                      ? "bg-red-600 text-white hover:bg-red-700"
                      : "bg-red-300 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Eliminar Cash (masivo)</span>
                  {bulkDeleteCashCount ? (
                    <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                      {bulkDeleteCashCount}
                    </span>
                  ) : null}
                </button>
              )}

              {isAdmin && (
                <button
                  onClick={() => {
                    const forCredit = true;
                    const toDelete = (
                      forCredit ? creditSales : cashSales
                    ).filter((s) => s.status === "FLOTANTE");
                    if (toDelete.length === 0) {
                      setMessage(
                        "No hay ventas en FLOTANTE de Crédito para eliminar.",
                      );
                      return;
                    }
                    setBulkDeleteItems(toDelete.slice(0, 10));
                    setBulkDeleteCount(toDelete.length);
                    setBulkDeleteForCredit(forCredit);
                    setBulkDeleteOpen(true);
                  }}
                  disabled={!bulkDeleteCreditCount}
                  title={
                    bulkDeleteCreditCount
                      ? `Eliminar ${bulkDeleteCreditCount} ventas Crédito flotantes visibles`
                      : "No hay ventas Crédito flotantes en la tabla para eliminar"
                  }
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    bulkDeleteCreditCount
                      ? "bg-red-700 text-white hover:bg-red-800"
                      : "bg-red-300 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Eliminar Crédito (masivo)</span>
                  {bulkDeleteCreditCount ? (
                    <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                      {bulkDeleteCreditCount}
                    </span>
                  ) : null}
                </button>
              )}
            </div>
          )}
        </div>
      </div>

      {/* filtros por periodo + estado + vendedor */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
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
          {/* Botones de acción también dentro del card de filtros en mobile */}
          <div className="mb-4 md:hidden space-y-2">
            {/* <button
              type="button"
              onClick={() => setMobileActionsOpen((v) => !v)}
              disabled={!hasVisibleSales}
              title={
                hasVisibleSales
                  ? "Ver acciones disponibles para las ventas visibles"
                  : "No hay datos en pantalla para ejecutar acciones"
              }
              className={`w-full inline-flex items-center justify-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                hasVisibleSales
                  ? "bg-slate-800 text-white hover:bg-slate-900"
                  : "bg-slate-500 text-white opacity-60 cursor-not-allowed"
              }`}
            >
              Opciones
              <span
                className={`text-[10px] transition-transform ${
                  mobileActionsOpen ? "rotate-180" : ""
                }`}
              >
                ▼
              </span>
            </button> */}

            {mobileActionsOpen && (
              <div className="space-y-2">
                {isAdmin && (
                  <button
                    onClick={handleSaveClosure}
                    disabled={!hasVisibleSales || !kpiFloCount || processing}
                    title={
                      !hasVisibleSales
                        ? "No hay datos en pantalla para procesar"
                        : kpiFloCount
                          ? `Procesar ${kpiFloCount} ventas flotantes visibles`
                          : "No hay ventas flotantes en este período para procesar"
                    }
                    className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                      !hasVisibleSales || !kpiFloCount || processing
                        ? "bg-blue-400 text-white opacity-60 cursor-not-allowed"
                        : "bg-blue-600 text-white hover:bg-blue-700"
                    }`}
                  >
                    <span>Procesar cierre</span>
                    {kpiFloCount ? (
                      <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                        {kpiFloCount}
                      </span>
                    ) : null}
                  </button>
                )}

                <button
                  onClick={handleDownloadPDF}
                  disabled={!hasVisibleSales}
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    hasVisibleSales
                      ? "bg-green-600 text-white hover:bg-green-700"
                      : "bg-green-400 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>PDF</span>
                </button>
                <button
                  onClick={handleExportCSV}
                  disabled={!hasVisibleSales}
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    hasVisibleSales
                      ? "bg-slate-700 text-white hover:bg-slate-800"
                      : "bg-slate-500 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>CSV</span>
                </button>
                <button
                  onClick={handleExportXLSX}
                  disabled={!hasVisibleSales}
                  className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                    hasVisibleSales
                      ? "bg-amber-600 text-white hover:bg-amber-700"
                      : "bg-amber-400 text-white opacity-60 cursor-not-allowed"
                  }`}
                >
                  <span>Excel</span>
                </button>

                {isAdmin && (
                  <button
                    onClick={() => {
                      const forCredit = false;
                      const toDelete = (
                        forCredit ? creditSales : cashSales
                      ).filter((s) => s.status === "FLOTANTE");
                      if (toDelete.length === 0) {
                        setMessage(
                          "No hay ventas en FLOTANTE de Cash para eliminar.",
                        );
                        return;
                      }
                      setBulkDeleteItems(toDelete.slice(0, 10));
                      setBulkDeleteCount(toDelete.length);
                      setBulkDeleteForCredit(forCredit);
                      setBulkDeleteOpen(true);
                    }}
                    disabled={!bulkDeleteCashCount}
                    title={
                      bulkDeleteCashCount
                        ? `Eliminar ${bulkDeleteCashCount} ventas Cash flotantes visibles`
                        : "No hay ventas Cash flotantes en la tabla para eliminar"
                    }
                    className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                      bulkDeleteCashCount
                        ? "bg-red-600 text-white hover:bg-red-700"
                        : "bg-red-300 text-white opacity-60 cursor-not-allowed"
                    }`}
                  >
                    <span>Eliminar Cash (masivo)</span>
                    {bulkDeleteCashCount ? (
                      <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                        {bulkDeleteCashCount}
                      </span>
                    ) : null}
                  </button>
                )}

                {isAdmin && (
                  <button
                    onClick={() => {
                      const forCredit = true;
                      const toDelete = (
                        forCredit ? creditSales : cashSales
                      ).filter((s) => s.status === "FLOTANTE");
                      if (toDelete.length === 0) {
                        setMessage(
                          "No hay ventas en FLOTANTE de Crédito para eliminar.",
                        );
                        return;
                      }
                      setBulkDeleteItems(toDelete.slice(0, 10));
                      setBulkDeleteCount(toDelete.length);
                      setBulkDeleteForCredit(forCredit);
                      setBulkDeleteOpen(true);
                    }}
                    disabled={!bulkDeleteCreditCount}
                    title={
                      bulkDeleteCreditCount
                        ? `Eliminar ${bulkDeleteCreditCount} ventas Crédito flotantes visibles`
                        : "No hay ventas Crédito flotantes en la tabla para eliminar"
                    }
                    className={`w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm transition-colors ${
                      bulkDeleteCreditCount
                        ? "bg-red-700 text-white hover:bg-red-800"
                        : "bg-red-300 text-white opacity-60 cursor-not-allowed"
                    }`}
                  >
                    <span>Eliminar Crédito (masivo)</span>
                    {bulkDeleteCreditCount ? (
                      <span className="ml-2 text-[10px] bg-white/20 px-2 py-0.5 rounded-full">
                        {bulkDeleteCreditCount}
                      </span>
                    ) : null}
                  </button>
                )}

                {isAdmin && (
                  <button
                    onClick={() => handleBulkRevert(false)}
                    className="w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm bg-rose-600 text-white hover:bg-rose-700 transition-colors"
                  >
                    <span>Revertir Cash (masivo)</span>
                  </button>
                )}

                {isAdmin && (
                  <button
                    onClick={() => handleBulkRevert(true)}
                    className="w-full inline-flex items-center justify-between px-3 py-1.5 text-xs font-semibold rounded-full shadow-sm bg-rose-700 text-white hover:bg-rose-800 transition-colors"
                  >
                    <span>Revertir Crédito (masivo)</span>
                  </button>
                )}
              </div>
            )}
          </div>
          <div className="flex flex-col md:flex-row md:items-end gap-3">
            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-slate-700">
                Desde
              </label>
              <input
                type="date"
                className="border rounded-md px-3 py-2"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            </div>

            <div className="flex items-center gap-2">
              <label className="text-xs font-semibold text-slate-700">
                Hasta
              </label>
              <input
                type="date"
                className="border rounded-md px-3 py-2"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
              />
            </div>

            <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full md:w-auto min-w-0">
              <MobileHtmlSelect
                label="Filtrar"
                value={filter}
                onChange={(v) => setFilter(v as any)}
                options={[
                  { value: "ALL", label: "Todas" },
                  { value: "FLOTANTE", label: "Venta Flotante" },
                  { value: "PROCESADA", label: "Venta Procesada" },
                ]}
                selectClassName="border rounded-md px-3 py-2 text-sm w-full md:w-48"
                buttonClassName="border rounded-md px-3 py-2 text-sm w-full md:w-48 text-left flex items-center justify-between gap-2 bg-white"
                sheetTitle="Filtrar ventas"
              />
            </div>

            {/* ✅ NUEVO: filtro por vendedor (solo admin) */}
            {isAdmin && (
              <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full md:w-auto min-w-0">
                <MobileHtmlSelect
                  label="Vendedor"
                  value={vendorFilter}
                  onChange={setVendorFilter}
                  options={[
                    { value: "ALL", label: "Todos" },
                    ...sellers.map((s) => ({
                      value: s.id,
                      label: s.name || s.id,
                    })),
                  ]}
                  selectClassName="border rounded-md px-3 py-2 text-sm w-full md:w-56"
                  buttonClassName="border rounded-md px-3 py-2 text-sm w-full md:w-56 text-left flex items-center justify-between gap-2 bg-white"
                  sheetTitle="Vendedor"
                />
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full md:w-auto min-w-0">
              <MobileHtmlSelect
                label="Productos"
                value={productFilter}
                onChange={setProductFilter}
                disabled={productOptions.length === 0}
                options={[
                  { value: "ALL", label: "Todos" },
                  ...productOptions.map((name) => ({
                    value: name,
                    label: name,
                  })),
                ]}
                selectClassName="border rounded-md px-3 py-2 text-xs w-full md:w-48 lg:w-56"
                buttonClassName="border rounded-md px-3 py-2 text-xs w-full md:w-48 lg:w-56 text-left flex items-center justify-between gap-2 bg-white"
                sheetTitle="Productos"
              />
            </div>
          </div>
        </div>
      </div>

      {/* KPIs arriba (con KPIs por vendedor adentro) */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
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
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 w-full">
            {/* Card 1: Ventas flotantes y procesadas */}
            <div className="border rounded-xl p-3 shadow-sm bg-blue-50 border-blue-200 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Kite icon outline */}
                <svg
                  className="text-blue-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M4 20l8-16 8 16" />
                  <path d="M12 4v16" />
                </svg>
                <span className="text-xs text-blue-700 font-semibold">
                  Ventas flotantes
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {kpiFloCount}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Check icon outline */}
                <svg
                  className="text-green-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M5 13l4 4L19 7" />
                </svg>
                <span className="text-xs text-green-700 font-semibold">
                  Ventas procesadas
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {kpiProCount}
                </span>
              </div>
              <div className="text-xs text-blue-700/70 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            {/* Card 2: Ventas cash y crédito */}
            <div className="border rounded-xl p-3 shadow-sm bg-emerald-50 border-emerald-200 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Cash icon outline */}
                <svg
                  className="text-emerald-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect x="2" y="7" width="20" height="10" rx="2" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
                <span className="text-xs text-emerald-700 font-semibold">
                  Ventas cash
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {kpiCashCount}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Credit card icon outline */}
                <svg
                  className="text-amber-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect x="2" y="6" width="20" height="12" rx="2" />
                  <path d="M2 10h20" />
                </svg>
                <span className="text-xs text-amber-700 font-semibold">
                  Ventas crédito
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {kpiCreditoCount}
                </span>
              </div>
              <div className="text-xs text-emerald-700/70 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            {/* Card 3: Paquetes cash y crédito */}
            <div className="border rounded-xl p-3 shadow-sm bg-purple-50 border-purple-200 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Box icon outline */}
                <svg
                  className="text-purple-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect x="3" y="3" width="18" height="18" rx="2" />
                  <path d="M3 9h18" />
                  <path d="M9 21V9" />
                </svg>
                <span className="text-xs text-purple-700 font-semibold">
                  Paquetes cash
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {qty3(totalPacksCash)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Gift icon outline */}
                <svg
                  className="text-pink-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <rect x="2" y="7" width="20" height="10" rx="2" />
                  <path d="M12 7v10" />
                  <path d="M7 7c0-2.5 5-2.5 5 0" />
                  <path d="M17 7c0-2.5-5-2.5-5 0" />
                </svg>
                <span className="text-xs text-pink-700 font-semibold">
                  Paquetes crédito
                </span>
                <span className="text-2xl font-bold ml-auto">
                  {qty3(totalPacksCredito)}
                </span>
              </div>
              <div className="text-xs text-purple-700/70 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>

            {/* Card 4: Comisión cash y crédito */}
            <div className="border rounded-xl p-3 shadow-sm bg-yellow-50 border-yellow-200 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Money bag icon outline */}
                <svg
                  className="text-yellow-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <path d="M12 2v2" />
                  <path d="M7 7c0 5 10 5 10 0" />
                  <ellipse cx="12" cy="17" rx="7" ry="5" />
                </svg>
                <span className="text-xs text-yellow-700 font-semibold">
                  Comisión cash
                </span>
                <span className="text-2xl font-bold ml-auto">
                  C${money(totalCommissionCash)}
                </span>
              </div>
              <div className="flex items-center gap-2">
                {/* Coin icon outline */}
                <svg
                  className="text-orange-600 w-6 h-6"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  viewBox="0 0 24 24"
                >
                  <circle cx="12" cy="12" r="8" />
                  <path d="M12 8v8" />
                  <path d="M8 12h8" />
                </svg>
                <span className="text-xs text-orange-700 font-semibold">
                  Comisión crédito
                </span>
                <span className="text-2xl font-bold ml-auto">
                  C${money(totalCommissionCredito)}
                </span>
              </div>
              <div className="text-xs text-yellow-700/70 mt-1">
                Período: {startDate} → {endDate}
              </div>
            </div>
          </div>
          {/* KPIs por vendedor ahora dentro del card de KPIs */}
          <div className="mt-6">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              onClick={() => setVendorKpiCardOpen((v) => !v)}
              aria-expanded={vendorKpiCardOpen}
            >
              <span>KPIs por vendedor</span>
              <span
                className={`text-slate-400 transition-transform ${vendorKpiCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${vendorKpiCardOpen ? "block" : "hidden"} border-t border-slate-100 p-4`}
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div className="border border-slate-200 rounded-xl p-3 shadow-sm bg-slate-50">
                  <div className="text-xs text-slate-600">
                    Vendedores (comisión CASH del período)
                  </div>
                  {vendorCommissionRowsCash.length === 0 ? (
                    <div className="text-sm text-slate-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
                      {vendorCommissionRowsCash.map((v) => (
                        <div
                          key={v.vendorId}
                          className="flex items-center justify-between text-sm text-slate-700"
                        >
                          <span className="truncate">{v.name}</span>
                          <strong className="ml-2">C${money(v.total)}</strong>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="border border-slate-200 rounded-xl p-3 shadow-sm bg-slate-50">
                  <div className="text-xs text-slate-600">
                    Vendedores (comisión CRÉDITO del período)
                  </div>
                  {vendorCommissionRowsCredito.length === 0 ? (
                    <div className="text-sm text-slate-500 mt-2">—</div>
                  ) : (
                    <div className="mt-2 space-y-1 max-h-28 overflow-auto pr-1">
                      {vendorCommissionRowsCredito.map((v) => (
                        <div
                          key={v.vendorId}
                          className="flex items-center justify-between text-sm text-slate-700"
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
        </div>
      </div>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          {/* Unified KPIs: moved above Transacciones Cash */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 md:gap-3 mb-4">
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 md:p-4 shadow-sm">
              <div className="text-xs md:text-xs font-semibold text-amber-700">
                Paquetes
              </div>
              <div className="mt-1.5 md:mt-3 grid grid-cols-2 gap-1.5 md:gap-4 items-center">
                <div className="text-center">
                  <div className="text-xs md:text-sm text-amber-600">Cash</div>
                  <div className="text-xl md:text-2xl font-extrabold text-amber-800 leading-none">
                    {qty3(totalPacksCash)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs md:text-sm text-amber-600">
                    Crédito
                  </div>
                  <div className="text-xl md:text-2xl font-extrabold text-amber-800 leading-none">
                    {qty3(totalPacksCredito)}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-2.5 md:p-4 shadow-sm">
              <div className="text-xs md:text-xs font-semibold text-emerald-700">
                Total pendiente crédito
              </div>
              <div className="mt-1.5 md:mt-3 grid grid-cols-2 gap-1.5 md:gap-4 items-center">
                <div className="text-center">
                  <div className="text-xs md:text-sm text-emerald-600">
                    Pendiente
                  </div>
                  <div className="text-lg md:text-3xl font-extrabold text-emerald-800 leading-none">
                    C${money(totalPendienteCredito)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs md:text-sm text-emerald-600">
                    Abonos
                  </div>
                  <div className="text-base md:text-lg font-semibold text-emerald-700 leading-none">
                    C${money(totalAbonos)}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-xl border border-indigo-200 bg-indigo-50 p-2.5 md:p-4 shadow-sm">
              <div className="text-xs md:text-xs font-semibold text-indigo-700">
                Total cobrado
              </div>
              <div className="mt-1.5 md:mt-3 grid grid-cols-2 gap-1.5 md:gap-4 items-center">
                <div className="text-center">
                  <div className="text-xs md:text-sm text-indigo-600">
                    Cobrado
                  </div>
                  <div className="text-lg md:text-3xl font-extrabold text-indigo-800 leading-none">
                    C${money(totalCobrado)}
                  </div>
                </div>
                <div className="text-center">
                  <div className="text-xs md:text-sm text-indigo-600">
                    Comisión
                  </div>
                  <div className="text-base md:text-lg font-semibold text-indigo-700 leading-none">
                    C${money(totalCommission)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              onClick={() => setCashCardOpen((v) => !v)}
              aria-expanded={cashCardOpen}
            >
              <span>Transacciones Cash</span>
              <span
                className={`text-slate-400 transition-transform ${cashCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${cashCardOpen ? "block" : "hidden"} border-t border-slate-100 p-4`}
            >
              <div className="pdf-desktop hidden md:block">
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Estado
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Fecha
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Registro
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Producto
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Tipo
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Paquetes
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Precio
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Monto
                        </th>
                        {isAdmin && (
                          <th
                            title="Calcula la Utilidad Neta por paquete"
                            className="px-3 py-2 text-left text-xs font-semibold"
                          >
                            UNPaquete
                          </th>
                        )}
                        <th
                          title="Calcula la Utilidad vendedor por paquete"
                          className="px-3 py-2 text-left text-xs font-semibold"
                        >
                          UVPaquete
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Comision
                        </th>
                        {/* Columna 'Comision' oculta por solicitud del usuario */}
                        {isAdmin && (
                          <th className="px-3 py-2 text-left text-xs font-semibold">
                            U. Neta
                          </th>
                        )}

                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Vendedor
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Acciones
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {cashSales.map((s) => {
                        const commission = getCommissionAmount(s);
                        const vendUtil = getVendorUtility(s);
                        const processDate = (s.processedDate || "").trim();

                        return (
                          <tr
                            key={s.id}
                            className="text-center odd:bg-white even:bg-slate-50/50"
                          >
                            <td className="px-3 py-2">
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                                  s.status === "PROCESADA"
                                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                    : "bg-amber-50 text-amber-700 ring-amber-200"
                                }`}
                              >
                                {s.status === "PROCESADA" ? (
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="h-3 w-3"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    role="img"
                                    aria-label="Procesada"
                                  >
                                    <title>Procesada</title>
                                    <path
                                      fillRule="evenodd"
                                      d="M16.707 5.293a1 1 0 00-1.414-1.414L8 11.172 4.707 7.879a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="h-3 w-3"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    role="img"
                                    aria-label="Flotante"
                                  >
                                    <title>Flotante</title>
                                    <path d="M6 4h2v12H6zM12 4h2v12h-2z" />
                                  </svg>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2">{s.date}</td>
                            <td className="px-3 py-2">
                              {s.registeredAt || "—"}
                            </td>
                            <td className="px-3 py-2 text-left text-slate-700">
                              {s.productName}
                            </td>
                            <td className="px-3 py-2">Cash</td>
                            <td className="px-3 py-2">{qty3(s.quantity)}</td>
                            <td className="px-3 py-2">
                              {(() => {
                                // Si existe s.price, úsalo. Si no, calcula unitario por producto
                                if (
                                  typeof s.price === "number" &&
                                  !isNaN(s.price)
                                ) {
                                  return `C$${money(s.price)}`;
                                }
                                // Si no existe, intenta calcularlo
                                const qty = Number(s.quantity || 0);
                                if (qty > 0 && typeof s.amount === "number") {
                                  return `C$${money(s.amount / qty)}`;
                                }
                                return "—";
                              })()}
                            </td>
                            <td className="px-3 py-2">C${money(s.amount)}</td>
                            {isAdmin && (
                              <td className="px-3 py-2">
                                {(() => {
                                  const fromSale = Number(s.uNetaPorPaquete ?? NaN);
                                  if (Number.isFinite(fromSale) && fromSale !== 0)
                                    return `C$${money(round2(fromSale))}`;
                                  const key = normKey(s.productName || "");
                                  const u =
                                    upaqueteMap[s.vendorId || ""]?.[key];
                                  return u && Number(u) !== 0
                                    ? `C$${money(round2(Number(u)))}`
                                    : "—";
                                })()}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              {(() => {
                                const uv = getUvXpaqForSale(s);
                                return uv > 0 ? `C$${money(round2(uv))}` : "—";
                              })()}
                            </td>
                            <td className="px-3 py-2">
                              {(() => {
                                const v = getVendorGainLabel(s);
                                return v && v !== "—" ? (
                                  <span className="text-amber-800 font-bold">
                                    {v}
                                  </span>
                                ) : (
                                  "—"
                                );
                              })()}
                            </td>
                            {/* Columna 'Comision' oculta */}

                            {isAdmin && (
                              <td className="px-3 py-2">
                                {(() => {
                                  const fromSale = Number(s.uNetaPorPaquete ?? NaN);
                                  const key = normKey(s.productName || "");
                                  const un = Number.isFinite(fromSale) && fromSale !== 0
                                    ? fromSale
                                    : upaqueteMap[s.vendorId || ""]?.[key];
                                  const qty = Number(s.quantity || 0);
                                  const total = Number(un || 0) * qty;
                                  return un && total > 0 ? (
                                    <span className="text-emerald-700 font-bold">{`C$${money(round2(total))}`}</span>
                                  ) : (
                                    "—"
                                  );
                                })()}
                              </td>
                            )}

                            <td className="px-3 py-2 text-left">
                              {getSellerDisplayName(s)}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                className="p-2 rounded border border-slate-200 hover:bg-slate-50 inline-flex mx-auto"
                                aria-label="Acciones"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCierreSaleMenu({
                                    id: s.id,
                                    rect: (
                                      e.currentTarget as HTMLElement
                                    ).getBoundingClientRect(),
                                  });
                                }}
                              >
                                <FiMoreVertical className="w-5 h-5 text-slate-700" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {cashSales.length === 0 && (
                        <tr>
                          <td
                            colSpan={isAdmin ? 13 : 11}
                            className="px-3 py-6 text-center text-slate-500"
                          >
                            Sin ventas cash para mostrar.
                          </td>
                        </tr>
                      )}
                    </tbody>
                    {cashSales.length > 0 && (
                      <tfoot className="bg-slate-100 font-semibold text-slate-800 border-t-2 border-slate-300">
                        <tr>
                          <td
                            colSpan={5}
                            className="px-3 py-2 text-left text-xs uppercase tracking-wide"
                          >
                            Totales ({cashSalesTableTotals.n} ventas)
                          </td>
                          <td className="px-3 py-2">
                            {qty3(cashSalesTableTotals.packs)}
                          </td>
                          <td className="px-3 py-2">—</td>
                          <td className="px-3 py-2">
                            C${money(cashSalesTableTotals.amount)}
                          </td>
                          {isAdmin && (
                            <td className="px-3 py-2">
                              {cashSalesTableTotals.unTotal > 0
                                ? `C$${money(round2(cashSalesTableTotals.unTotal))}`
                                : "—"}
                            </td>
                          )}
                          <td className="px-3 py-2">
                            {cashSalesTableTotals.uvTotal > 0
                              ? `C$${money(round2(cashSalesTableTotals.uvTotal))}`
                              : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {cashSalesTableTotals.comm > 0
                              ? `C$${money(round2(cashSalesTableTotals.comm))}`
                              : "—"}
                          </td>
                          {isAdmin && (
                            <td className="px-3 py-2">
                              {cashSalesTableTotals.uNeta > 0
                                ? `C$${money(round2(cashSalesTableTotals.uNeta))}`
                                : "—"}
                            </td>
                          )}
                          <td className="px-3 py-2">—</td>
                          <td className="px-3 py-2">—</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              <div className="pdf-mobile md:hidden space-y-3 mb-4">
                {cashSales.map((s) => {
                  const commission = getCommissionAmount(s);
                  const vendUtil = getVendorUtility(s);
                  const processDate = (s.processedDate || "").trim();

                  return (
                    <details
                      key={s.id}
                      className="border border-slate-200 rounded-xl bg-white shadow-sm"
                    >
                      <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {s.productName}
                          </div>
                          <div className="text-xs text-slate-500">
                            Cash • {s.date}
                          </div>
                        </div>

                        <div className="text-right shrink-0 ml-3">
                          <div className="font-bold">C${money(s.amount)}</div>
                          <span
                            className={`text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset ${
                              s.status === "PROCESADA"
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                : "bg-amber-50 text-amber-700 ring-amber-200"
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>
                      </summary>

                      <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Paquetes</span>
                          <strong>{Math.trunc(Number(s.quantity || 0))}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Precio</span>
                          <strong>{getSalePriceLabel(s)}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Uv x Paquete</span>
                          <strong>{getSaleCommissionLabel(s)}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Comision</span>
                          <strong className="text-amber-800 font-bold">
                            {getVendorGainLabel(s)}
                          </strong>
                        </div>

                        {/* <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Vendedor</span>
                          <strong>
                            {getCommissionFromItems(s) > 0
                              ? `C$${money(getCommissionFromItems(s))}`
                              : "—"}
                          </strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Neta</span>
                          <strong>
                            {getVendorNetUtility(s) > 0
                              ? `C$${money(getVendorNetUtility(s))}`
                              : "—"}
                          </strong>
                        </div> */}

                        {/* Se oculta detalle 'Comisión' en vista móvil */}

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Vendedor</span>
                          <strong className="text-right break-all">
                            {getSellerDisplayName(s)}
                          </strong>
                        </div>

                        <div className="pt-2 flex justify-end">
                          <button
                            type="button"
                            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50"
                            aria-label="Acciones"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCierreSaleMenu({
                                id: s.id,
                                rect: (
                                  e.currentTarget as HTMLElement
                                ).getBoundingClientRect(),
                              });
                            }}
                          >
                            <FiMoreVertical className="w-5 h-5 text-slate-700" />
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}

                {cashSales.length === 0 && (
                  <div className="text-center text-slate-500 text-sm py-6">
                    Sin ventas cash para mostrar.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              onClick={() => setCreditCardOpen((v) => !v)}
              aria-expanded={creditCardOpen}
            >
              <span>Transacciones Crédito</span>
              <span
                className={`text-slate-400 transition-transform ${creditCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${creditCardOpen ? "block" : "hidden"} border-t border-slate-100 p-4`}
            >
              <div className="pdf-desktop hidden md:block">
                <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                  <table className="min-w-full text-sm">
                    <thead className="bg-slate-50 text-slate-600">
                      <tr>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Estado
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Producto
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Tipo
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Paquetes
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Precio
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Monto
                        </th>
                        {isAdmin && (
                          <th
                            title="Calcula la Utilidad Neta por paquete"
                            className="px-3 py-2 text-left text-xs font-semibold"
                          >
                            Un.Paq
                          </th>
                        )}
                        <th
                          title="Calcula la Utilidad vendedor por paquete"
                          className="px-3 py-2 text-left text-xs font-semibold"
                        >
                          UvPaquete
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Gan. vendedor
                        </th>
                        {/* Columna 'Comision' oculta por solicitud del usuario */}
                        {isAdmin && (
                          <th className="px-3 py-2 text-left text-xs font-semibold">
                            U. Neta
                          </th>
                        )}
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Fecha
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Registro
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Vendedor
                        </th>
                        <th className="px-3 py-2 text-left text-xs font-semibold">
                          Acciones
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {creditSales.map((s) => {
                        const commission = getCommissionAmount(s);
                        const vendUtil = getVendorUtility(s);
                        const processDate = (s.processedDate || "").trim();

                        return (
                          <tr
                            key={s.id}
                            className="text-center odd:bg-white even:bg-slate-50/50"
                          >
                            <td className="px-3 py-2">
                              <span
                                className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${
                                  s.status === "PROCESADA"
                                    ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                    : "bg-amber-50 text-amber-700 ring-amber-200"
                                }`}
                              >
                                {s.status === "PROCESADA" ? (
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="h-4 w-4"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    aria-hidden="true"
                                  >
                                    <path
                                      fillRule="evenodd"
                                      d="M16.707 5.293a1 1 0 00-1.414-1.414L8 11.172 4.707 7.879a1 1 0 00-1.414 1.414l4 4a1 1 0 001.414 0l8-8z"
                                      clipRule="evenodd"
                                    />
                                  </svg>
                                ) : (
                                  <svg
                                    xmlns="http://www.w3.org/2000/svg"
                                    className="h-4 w-4"
                                    viewBox="0 0 20 20"
                                    fill="currentColor"
                                    aria-hidden="true"
                                  >
                                    <path d="M6 4h2v12H6zM12 4h2v12h-2z" />
                                  </svg>
                                )}
                              </span>
                            </td>
                            <td className="px-3 py-2 text-left text-slate-700">
                              {s.productName}
                            </td>
                            <td className="px-3 py-2">Crédito</td>
                            <td className="px-3 py-2">{qty3(s.quantity)}</td>
                            <td className="px-3 py-2">
                              {(() => {
                                if (
                                  typeof s.price === "number" &&
                                  !isNaN(s.price)
                                ) {
                                  return `C$${money(s.price)}`;
                                }
                                const qty = Number(s.quantity || 0);
                                if (qty > 0 && typeof s.amount === "number") {
                                  return `C$${money(s.amount / qty)}`;
                                }
                                return "—";
                              })()}
                            </td>
                            <td className="px-3 py-2">C${money(s.amount)}</td>
                            {isAdmin && (
                              <td className="px-3 py-2">
                                {(() => {
                                  const fromSale = Number(s.uNetaPorPaquete ?? NaN);
                                  if (Number.isFinite(fromSale) && fromSale !== 0)
                                    return `C$${money(round2(fromSale))}`;
                                  const key = normKey(s.productName || "");
                                  const u =
                                    upaqueteMap[s.vendorId || ""]?.[key];
                                  return u && Number(u) !== 0
                                    ? `C$${money(round2(Number(u)))}`
                                    : "—";
                                })()}
                              </td>
                            )}
                            <td className="px-3 py-2">
                              {(() => {
                                const uv = getUvXpaqForSale(s);
                                return uv > 0 ? `C$${money(round2(uv))}` : "—";
                              })()}
                            </td>
                            {/* Columna 'Comision' oculta */}
                            {isAdmin && (
                              <td className="px-3 py-2">
                                {(() => {
                                  const fromSale = Number(s.uNetaPorPaquete ?? NaN);
                                  const key = normKey(s.productName || "");
                                  const un = Number.isFinite(fromSale) && fromSale !== 0
                                    ? fromSale
                                    : upaqueteMap[s.vendorId || ""]?.[key];
                                  const qty = Number(s.quantity || 0);
                                  const total = Number(un || 0) * qty;
                                  return un && total > 0
                                    ? `C$${money(round2(total))}`
                                    : "—";
                                })()}
                              </td>
                            )}
                            <td className="px-3 py-2">{s.date}</td>
                            <td className="px-3 py-2">
                              {s.registeredAt || "—"}
                            </td>
                            <td className="px-3 py-2 text-left">
                              {getSellerDisplayName(s)}
                            </td>
                            <td className="px-3 py-2">
                              <button
                                type="button"
                                className="p-2 rounded border border-slate-200 hover:bg-slate-50 inline-flex mx-auto"
                                aria-label="Acciones"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setCierreSaleMenu({
                                    id: s.id,
                                    rect: (
                                      e.currentTarget as HTMLElement
                                    ).getBoundingClientRect(),
                                  });
                                }}
                              >
                                <FiMoreVertical className="w-5 h-5 text-slate-700" />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                      {creditSales.length === 0 && (
                        <tr>
                          <td
                            colSpan={isAdmin ? 13 : 11}
                            className="px-3 py-6 text-center text-slate-500"
                          >
                            Sin ventas crédito para mostrar.
                          </td>
                        </tr>
                      )}
                    </tbody>
                    {creditSales.length > 0 && (
                      <tfoot className="bg-slate-100 font-semibold text-slate-800 border-t-2 border-slate-300">
                        <tr>
                          <td
                            colSpan={3}
                            className="px-3 py-2 text-left text-xs uppercase tracking-wide"
                          >
                            Totales ({creditSalesTableTotals.n} ventas)
                          </td>
                          <td className="px-3 py-2">
                            {qty3(creditSalesTableTotals.packs)}
                          </td>
                          <td className="px-3 py-2">—</td>
                          <td className="px-3 py-2">
                            C${money(creditSalesTableTotals.amount)}
                          </td>
                          {isAdmin && (
                            <td className="px-3 py-2">
                              {creditSalesTableTotals.unTotal > 0
                                ? `C$${money(round2(creditSalesTableTotals.unTotal))}`
                                : "—"}
                            </td>
                          )}
                          <td className="px-3 py-2">
                            {creditSalesTableTotals.uvTotal > 0
                              ? `C$${money(round2(creditSalesTableTotals.uvTotal))}`
                              : "—"}
                          </td>
                          <td className="px-3 py-2">
                            {creditSalesTableTotals.comm > 0
                              ? `C$${money(round2(creditSalesTableTotals.comm))}`
                              : "—"}
                          </td>
                          {isAdmin && (
                            <td className="px-3 py-2">
                              {creditSalesTableTotals.uNeta > 0
                                ? `C$${money(round2(creditSalesTableTotals.uNeta))}`
                                : "—"}
                            </td>
                          )}
                          <td colSpan={3} className="px-3 py-2">
                            —
                          </td>
                          <td className="px-3 py-2">—</td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
              </div>

              <div className="pdf-mobile md:hidden space-y-3 mb-4">
                {creditSales.map((s) => {
                  const commission = getCommissionAmount(s);
                  const vendUtil = getVendorUtility(s);
                  const processDate = (s.processedDate || "").trim();

                  return (
                    <details
                      key={s.id}
                      className="border border-slate-200 rounded-xl bg-white shadow-sm"
                    >
                      <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                        <div className="min-w-0">
                          <div className="text-sm font-semibold truncate">
                            {s.productName}
                          </div>
                          <div className="text-xs text-slate-500">
                            Crédito • {s.date}
                          </div>
                        </div>

                        <div className="text-right shrink-0 ml-3">
                          <div className="font-bold">C${money(s.amount)}</div>
                          <span
                            className={`text-xs font-semibold px-2 py-0.5 rounded-full ring-1 ring-inset ${
                              s.status === "PROCESADA"
                                ? "bg-emerald-50 text-emerald-700 ring-emerald-200"
                                : "bg-amber-50 text-amber-700 ring-amber-200"
                            }`}
                          >
                            {s.status}
                          </span>
                        </div>
                      </summary>

                      <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Paquetes</span>
                          <strong>{Math.trunc(Number(s.quantity || 0))}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Precio</span>
                          <strong>{getSalePriceLabel(s)}</strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">UvPaquete</span>
                          <strong>{getSaleCommissionLabel(s)}</strong>
                        </div>

                        {/* <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Vendedor</span>
                          <strong>
                            {vendUtil > 0 ? `C$${money(vendUtil)}` : "—"}
                          </strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Vendedor</span>
                          <strong>
                            {getCommissionFromItems(s) > 0
                              ? `C$${money(getCommissionFromItems(s))}`
                              : "—"}
                          </strong>
                        </div>

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Neta</span>
                          <strong>
                            {getVendorNetUtility(s) > 0
                              ? `C$${money(getVendorNetUtility(s))}`
                              : "—"}
                          </strong>
                        </div> */}

                        {/* Se oculta detalle 'Comisión' en vista móvil */}

                        {/* <div className="flex justify-between gap-3">
                          <span className="text-slate-600">U. Vendedor</span>
                          <strong>
                            {vendUtil > 0 ? `C$${money(vendUtil)}` : "—"}
                          </strong>
                        </div> */}

                        <div className="flex justify-between gap-3">
                          <span className="text-slate-600">Vendedor</span>
                          <strong className="text-right break-all">
                            {getSellerDisplayName(s)}
                          </strong>
                        </div>

                        <div className="pt-2 flex justify-end">
                          <button
                            type="button"
                            className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50"
                            aria-label="Acciones"
                            onClick={(e) => {
                              e.stopPropagation();
                              setCierreSaleMenu({
                                id: s.id,
                                rect: (
                                  e.currentTarget as HTMLElement
                                ).getBoundingClientRect(),
                              });
                            }}
                          >
                            <FiMoreVertical className="w-5 h-5 text-slate-700" />
                          </button>
                        </div>
                      </div>
                    </details>
                  );
                })}

                {creditSales.length === 0 && (
                  <div className="text-center text-slate-500 text-sm py-6">
                    Sin ventas crédito para mostrar.
                  </div>
                )}
              </div>
            </div>
          </div>

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              onClick={() => setAbonosCardOpen((v) => !v)}
              aria-expanded={abonosCardOpen}
            >
              <span>Abonos (período)</span>
              <span
                className={`text-slate-400 transition-transform ${abonosCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${abonosCardOpen ? "block" : "hidden"} border-t border-slate-100 p-4`}
            >
              {abonosLoading ? (
                <div className="text-sm text-slate-500">Cargando abonos...</div>
              ) : (
                <>
                  <div className="pdf-desktop hidden md:block">
                    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                      <table className="min-w-full text-sm">
                        <thead className="bg-slate-50 text-slate-600">
                          <tr>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Fecha
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Cliente
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Venta
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Saldo pendiente
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Abono
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Saldo final
                            </th>
                            <th className="px-3 py-2 text-left text-xs font-semibold">
                              Comentario
                            </th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {abonosRows.map((r) => {
                            const pending = Number.isFinite(
                              Number(r.saleRemainingBefore),
                            )
                              ? r.saleRemainingBefore
                              : Number.isFinite(Number(r.balanceBefore))
                                ? r.balanceBefore
                                : undefined;
                            const after = Number.isFinite(
                              Number(r.saleRemainingAfter),
                            )
                              ? r.saleRemainingAfter
                              : Number.isFinite(Number(r.balanceAfter))
                                ? r.balanceAfter
                                : undefined;

                            return (
                              <tr
                                key={r.id}
                                className="text-center odd:bg-white even:bg-slate-50/50"
                              >
                                <td className="px-3 py-2">{r.date}</td>
                                <td className="px-3 py-2 text-left">
                                  {r.customerName || "—"}
                                </td>
                                <td className="px-3 py-2 text-left">
                                  {r.saleId || "—"}
                                </td>
                                <td className="px-3 py-2">
                                  {maybeMoney(pending)}
                                </td>
                                <td className="px-3 py-2">
                                  C${money(r.amount)}
                                </td>
                                <td className="px-3 py-2">
                                  {maybeMoney(after)}
                                </td>
                                <td className="px-3 py-2 text-left">
                                  {r.comment || "—"}
                                </td>
                              </tr>
                            );
                          })}
                          {abonosRows.length === 0 && (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-3 py-6 text-center text-slate-500"
                              >
                                Sin abonos para mostrar.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                  </div>

                  <div className="pdf-mobile md:hidden space-y-3 mb-4">
                    {abonosRows.map((r) => {
                      const pending = Number.isFinite(
                        Number(r.saleRemainingBefore),
                      )
                        ? r.saleRemainingBefore
                        : Number.isFinite(Number(r.balanceBefore))
                          ? r.balanceBefore
                          : undefined;
                      const after = Number.isFinite(
                        Number(r.saleRemainingAfter),
                      )
                        ? r.saleRemainingAfter
                        : Number.isFinite(Number(r.balanceAfter))
                          ? r.balanceAfter
                          : undefined;

                      return (
                        <div
                          key={r.id}
                          className="border border-slate-200 rounded-xl bg-white shadow-sm p-3"
                        >
                          <div className="flex justify-between gap-3">
                            <div className="min-w-0">
                              <div className="font-semibold truncate">
                                {r.customerName || "Cliente"}
                              </div>
                              <div className="text-xs text-slate-500">
                                {r.date}
                              </div>
                            </div>
                            <div className="text-right">
                              <div className="font-bold">
                                C${money(r.amount)}
                              </div>
                            </div>
                          </div>

                          <div className="mt-2 text-sm space-y-1">
                            <div className="flex justify-between gap-3">
                              <span className="text-slate-600">Venta</span>
                              <strong className="text-right break-all">
                                {r.saleId || "—"}
                              </strong>
                            </div>
                            <div className="flex justify-between gap-3">
                              <span className="text-slate-600">
                                Saldo pendiente
                              </span>
                              <strong>{maybeMoney(pending)}</strong>
                            </div>
                            <div className="flex justify-between gap-3">
                              <span className="text-slate-600">
                                Saldo final
                              </span>
                              <strong>{maybeMoney(after)}</strong>
                            </div>
                            {r.comment && (
                              <div className="text-xs text-slate-600">
                                {r.comment}
                              </div>
                            )}
                          </div>
                        </div>
                      );
                    })}

                    {abonosRows.length === 0 && (
                      <div className="text-center text-slate-500 text-sm py-6">
                        Sin abonos para mostrar.
                      </div>
                    )}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* (old KPIs removed - unified KPIs moved above Transacciones Cash) */}

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

          <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
            <button
              type="button"
              className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
              onClick={() => setProductCardOpen((v) => !v)}
              aria-expanded={productCardOpen}
            >
              <span>Consolidado por producto</span>
              <span
                className={`text-slate-400 transition-transform ${productCardOpen ? "rotate-180" : ""}`}
              >
                ▼
              </span>
            </button>
            <div
              className={`collapsible-content ${productCardOpen ? "block" : "hidden"} border-t border-slate-100 p-4`}
            >
              <div className="space-y-3">
                {productSummaryByCategory.map((group) => {
                  const isOpen = !!categoryOpenMap[group.category];
                  return (
                    <div
                      key={group.category}
                      className="border border-slate-200 rounded-xl bg-white shadow-sm"
                    >
                      <button
                        type="button"
                        className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold text-slate-800 transition-colors hover:bg-slate-50"
                        onClick={() => toggleCategory(group.category)}
                        aria-expanded={isOpen}
                      >
                        <div className="min-w-0">
                          <div className="truncate">{group.category}</div>
                          <div className="text-xs text-slate-600">
                            {qty3(group.totalQuantity)} paquetes · C$
                            {money(group.totalAmount)} · Comisión{" "}
                            {group.totalCommission > 0
                              ? `C$${money(group.totalCommission)}`
                              : "—"}
                          </div>
                        </div>
                        <span
                          className={`text-slate-400 transition-transform ${isOpen ? "rotate-180" : ""}`}
                        >
                          ▼
                        </span>
                      </button>

                      <div
                        className={`collapsible-content ${isOpen ? "block" : "hidden"} border-t border-slate-100 p-3`}
                      >
                        <div className="pdf-desktop hidden md:block">
                          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
                            <table className="min-w-full text-sm">
                              <thead className="bg-slate-50 text-slate-600">
                                <tr>
                                  <th className="px-3 py-2 text-left text-xs font-semibold">
                                    Producto
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-semibold">
                                    Paq cash
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-semibold">
                                    Paq credito
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-semibold">
                                    Monto cash
                                  </th>
                                  <th className="px-3 py-2 text-left text-xs font-semibold">
                                    Monto credito
                                  </th>
                                  <th
                                    title="Calcula la Utilidad vendedor por paquete"
                                    className="px-3 py-2 text-left text-xs font-semibold"
                                  >
                                    Comision cash
                                  </th>
                                  <th
                                    title="Calcula la Utilidad vendedor por paquete"
                                    className="px-3 py-2 text-left text-xs font-semibold"
                                  >
                                    Comision credito
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {group.rows.map((row) => (
                                  <tr
                                    key={row.productName}
                                    className="text-center odd:bg-white even:bg-slate-50/50"
                                  >
                                    <td className="px-3 py-2 text-left">
                                      {row.productName}
                                    </td>
                                    <td className="px-3 py-2">
                                      {qty3(row.paqCash)}
                                    </td>
                                    <td className="px-3 py-2">
                                      {qty3(row.paqCredito)}
                                    </td>
                                    <td className="px-3 py-2">
                                      C${money(row.montoCash)}
                                    </td>
                                    <td className="px-3 py-2">
                                      C${money(row.montoCredito)}
                                    </td>
                                    <td className="px-3 py-2">
                                      {row.commCash > 0
                                        ? `C$${money(row.commCash)}`
                                        : "—"}
                                    </td>
                                    <td className="px-3 py-2">
                                      {row.commCredito > 0
                                        ? `C$${money(row.commCredito)}`
                                        : "—"}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>

                        <div className="pdf-mobile md:hidden space-y-2">
                          {group.rows.map((row) => (
                            <div
                              key={row.productName}
                              className="border border-slate-200 rounded-xl bg-white shadow-sm p-3"
                            >
                              <div className="font-semibold">
                                {row.productName}
                              </div>
                              <div className="mt-2 text-sm space-y-1">
                                <div className="flex justify-between gap-3">
                                  <span className="text-slate-600">
                                    Paq cash
                                  </span>
                                  <strong>{qty3(row.paqCash)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-slate-600">
                                    Paq credito
                                  </span>
                                  <strong>{qty3(row.paqCredito)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-slate-600">
                                    Monto cash
                                  </span>
                                  <strong>C${money(row.montoCash)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span className="text-slate-600">
                                    Monto credito
                                  </span>
                                  <strong>C${money(row.montoCredito)}</strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span
                                    title="Calcula la Utilidad vendedor por paquete"
                                    className="text-slate-600"
                                  >
                                    Comision cash
                                  </span>
                                  <strong>
                                    {row.commCash > 0
                                      ? `C$${money(row.commCash)}`
                                      : "—"}
                                  </strong>
                                </div>
                                <div className="flex justify-between gap-3">
                                  <span
                                    title="Calcula la Utilidad vendedor por paquete"
                                    className="text-slate-600"
                                  >
                                    Comision credito
                                  </span>
                                  <strong>
                                    {row.commCredito > 0
                                      ? `C$${money(row.commCredito)}`
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
                  <div className="text-center text-slate-500 text-sm py-6">
                    Sin datos para consolidar.
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Eliminado: botones ahora están arriba */}

      {message && (
        <Toast message={message} onClose={() => setMessage("")} />
      )}

      {/* Modal de previsualización para PROCESAR cierre (Guardar) */}
      {processPreviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-4 relative">
            <h4 className="font-semibold text-lg">Confirmar procesar ventas</h4>
            <div className="text-sm text-slate-600 mt-2">
              Se van a procesar <strong>{processPreviewCount}</strong> ventas
              (estado FLOTANTE) en el período seleccionado.
            </div>
            <div className="mt-3 text-xs text-slate-600">
              Muestras (hasta 10 filas):
            </div>
            <div className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm bg-slate-50">
              {processPreviewItems.length === 0 ? (
                <div className="text-slate-500">Sin filas a mostrar.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">ID</th>
                      <th className="text-left">Producto</th>
                      <th className="text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {processPreviewItems.map((s) => (
                      <tr key={s.id}>
                        <td className="pr-2">{(s.id || "").split("#")[0]}</td>
                        <td className="pr-2">
                          {s.productName || "(sin producto)"}
                        </td>
                        <td className="text-right">
                          C${money(Number(s.amount || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {processing && (
              <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
                <div className="text-center">
                  <div className="font-semibold mb-2">Procesando ventas...</div>
                  <div className="text-sm text-slate-600">
                    {processingProgress} / {processPreviewCount}
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setProcessPreviewOpen(false)}
                disabled={processing}
                className={`px-3 py-1 border rounded text-sm ${processing ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                Cancelar
              </button>
              <button
                onClick={performProcessClosure}
                disabled={processing}
                className={`px-3 py-1 bg-blue-600 text-white rounded text-sm ${processing ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {processing
                  ? `Procesando ${processingProgress}/${processPreviewCount}`
                  : `Procesar ${processPreviewCount} ventas`}
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal de previsualización para reversión masiva */}
      {bulkPreviewOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-4 relative">
            <h4 className="font-semibold text-lg">
              Confirmar reversión masiva
            </h4>
            <div className="text-sm text-slate-600 mt-2">
              Se van a revertir <strong>{bulkPreviewCount}</strong> ventas de{" "}
              <strong>{bulkPreviewForCredit ? "Crédito" : "Cash"}</strong> que
              aparecen en la tabla.
            </div>
            <div className="mt-3 text-xs text-slate-600">
              Muestras (hasta 10 filas):
            </div>
            <div className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm bg-slate-50">
              {bulkPreviewItems.length === 0 ? (
                <div className="text-slate-500">Sin filas a mostrar.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">ID</th>
                      <th className="text-left">Producto</th>
                      <th className="text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkPreviewItems.map((s) => (
                      <tr key={s.id}>
                        <td className="pr-2">{(s.id || "").split("#")[0]}</td>
                        <td className="pr-2">
                          {s.productName || "(sin producto)"}
                        </td>
                        <td className="text-right">
                          C${money(Number(s.amount || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setBulkPreviewOpen(false)}
                className="px-3 py-1 border rounded text-sm"
              >
                Cancelar
              </button>
              <button
                onClick={performBulkRevert}
                className="px-3 py-1 bg-rose-600 text-white rounded text-sm"
              >
                Revertir {bulkPreviewCount} ventas
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Modal de previsualización para ELIMINAR masivo */}
      {bulkDeleteOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-lg p-4">
            <h4 className="font-semibold text-lg">
              Confirmar eliminación masiva
            </h4>
            <div className="text-sm text-slate-600 mt-2">
              Se van a eliminar <strong>{bulkDeleteCount}</strong> ventas de{" "}
              <strong>{bulkDeleteForCredit ? "Crédito" : "Cash"}</strong> que
              aparecen en la tabla. Esto restaurará el stock y eliminará los
              documentos de venta.
            </div>
            <div className="mt-3 text-xs text-slate-600">
              Muestras (hasta 10 filas):
            </div>
            <div className="mt-2 max-h-48 overflow-auto border rounded p-2 text-sm bg-slate-50">
              {bulkDeleteItems.length === 0 ? (
                <div className="text-slate-500">Sin filas a mostrar.</div>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left">ID</th>
                      <th className="text-left">Producto</th>
                      <th className="text-right">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkDeleteItems.map((s) => (
                      <tr key={s.id}>
                        <td className="pr-2">{(s.id || "").split("#")[0]}</td>
                        <td className="pr-2">
                          {s.productName || "(sin producto)"}
                        </td>
                        <td className="text-right">
                          C${money(Number(s.amount || 0))}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {bulkDeleting && (
              <div className="absolute inset-0 bg-white/80 flex items-center justify-center">
                <div className="text-center">
                  <div className="font-semibold mb-2">Eliminando ventas...</div>
                  <div className="text-sm text-slate-600">
                    {bulkDeleteProgress} / {bulkDeleteCount}
                  </div>
                </div>
              </div>
            )}

            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => setBulkDeleteOpen(false)}
                disabled={bulkDeleting}
                className={`px-3 py-1 border rounded text-sm ${bulkDeleting ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                Cancelar
              </button>
              <button
                onClick={performBulkDelete}
                disabled={bulkDeleting}
                className={`px-3 py-1 bg-red-600 text-white rounded text-sm ${bulkDeleting ? "opacity-60 cursor-not-allowed" : ""}`}
              >
                {bulkDeleting
                  ? `Eliminando ${bulkDeleteProgress}/${bulkDeleteCount}`
                  : `Eliminar ${bulkDeleteCount} ventas`}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Global working overlay for single/bulk operations */}
      {working && (
        <div className="fixed inset-0 z-60 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 text-center">
            <div className="font-semibold mb-2">
              {workingMessage || "Procesando..."}
            </div>
            <div className="text-sm text-slate-600">Por favor espere.</div>
          </div>
        </div>
      )}

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

      <ActionMenu
        anchorRect={cierreSaleMenu?.rect ?? null}
        isOpen={!!cierreSaleMenu}
        onClose={() => setCierreSaleMenu(null)}
        width={220}
      >
        {cierreSaleMenu &&
          (() => {
            const sale = visibleSales.find((x) => x.id === cierreSaleMenu.id);
            if (!sale) {
              return (
                <div className="px-3 py-2 text-sm text-slate-500">
                  Sin datos
                </div>
              );
            }
            return (
              <div className="py-1">
                {!isAdmin && (
                  <div className="px-3 py-2 text-sm text-slate-500">
                    Sin acciones disponibles
                  </div>
                )}
                {isAdmin && sale.status === "FLOTANTE" && (
                  <>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                      onClick={() => {
                        setCierreSaleMenu(null);
                        openEdit(sale);
                      }}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-700 font-semibold"
                      onClick={() => {
                        setCierreSaleMenu(null);
                        void deleteSale(sale.id);
                      }}
                    >
                      Eliminar
                    </button>
                  </>
                )}
                {isAdmin && sale.status === "PROCESADA" && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-amber-800 font-semibold"
                    onClick={() => {
                      setCierreSaleMenu(null);
                      void handleRevert(sale.id);
                    }}
                  >
                    Revertir
                  </button>
                )}
              </div>
            );
          })()}
      </ActionMenu>
    </div>
  );
}
