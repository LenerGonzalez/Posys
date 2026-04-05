// src/components/InventoryBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  updateDoc,
  deleteDoc,
  doc,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { newBatch, markBatchAsPaid } from "../../Services/inventory";
import {
  parseBatchStockStatus,
  labelEstadoStock,
  summarizeGroupStockStatus,
  type BatchStockStatus,
  type GroupStockStatusSummary,
} from "../../Services/batchStockStatus";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { roundQty } from "../../Services/decimal";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { FiChevronDown, FiInfo, FiMenu } from "react-icons/fi";
import ActionMenu, { ActionMenuTrigger } from "../common/ActionMenu";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import {
  POLLO_SELECT_COMPACT_DESKTOP_CLASS,
  POLLO_SELECT_COMPACT_MOBILE_CLASS,
  POLLO_SELECT_DESKTOP_CLASS,
  POLLO_SELECT_MOBILE_BUTTON_CLASS,
} from "../common/polloSelectStyles";
import Button from "../common/Button";
import Toast from "../common/Toast";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerDetailDlCard,
  DrawerMoneyStrip,
  DrawerSectionTitle,
  DrawerStatGrid,
} from "../common/DrawerContentCards";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

function groupStockBadgeClass(s: GroupStockStatusSummary): string {
  if (s === "activa") return "bg-emerald-100 text-emerald-800";
  if (s === "pendiente") return "bg-amber-100 text-amber-800";
  return "bg-slate-100 text-slate-700";
}

function groupStockBadgeLabel(s: GroupStockStatusSummary): string {
  if (s === "activa") return "Activa";
  if (s === "pendiente") return "Pendiente";
  return "Mixto";
}

const fmtExistRemQty = (n: number) => Number(n || 0).toFixed(3);

/** Mismo criterio que ventas FIFO: lote más antiguo primero. */
function sortBatchesFifoOrder(loots: Batch[]): Batch[] {
  return [...loots].sort((a, b) => {
    const da = String(a.date || "");
    const db = String(b.date || "");
    if (da !== db) return da < db ? -1 : 1;
    const ca = a.createdAt?.seconds ?? 0;
    const cb = b.createdAt?.seconds ?? 0;
    return ca - cb;
  });
}

/**
 * Costo unitario ponderado del stock restante entre varios lotes del mismo producto:
 * Σ(remaining × purchasePrice) / Σ(remaining).
 * Sirve para valorar inventario y comparar con el costo FIFO que usa cada venta.
 */
function weightedAvgUnitCostRemaining(loots: Batch[]): number | null {
  let remSum = 0;
  let costSum = 0;
  for (const b of loots) {
    const rem = Number(b.remaining || 0);
    if (rem <= 0) continue;
    const cost = Number(b.purchasePrice || 0);
    remSum += rem;
    costSum += rem * cost;
  }
  if (remSum <= 0) return null;
  return Number((costSum / remSum).toFixed(4));
}

/**
 * Precio de venta ponderado del stock restante:
 * Σ(remaining × salePrice) / Σ(remaining).
 * Incluye opcionalmente un lote "nuevo" (qty + salePrice) que aún no está en BD.
 */
function weightedAvgSalePriceRemaining(
  loots: Batch[],
  newQty = 0,
  newSalePrice = 0,
): number | null {
  let remSum = 0;
  let saleSum = 0;
  for (const b of loots) {
    const rem = Number(b.remaining || 0);
    if (rem <= 0) continue;
    const sp = Number(b.salePrice || 0);
    remSum += rem;
    saleSum += rem * sp;
  }
  if (newQty > 0 && newSalePrice > 0) {
    remSum += newQty;
    saleSum += newQty * newSalePrice;
  }
  if (remSum <= 0) return null;
  return Number((saleSum / remSum).toFixed(2));
}

type WeightedCostLotLine = {
  batchId: string;
  date: string;
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  orderName?: string;
};

type WeightedCostRow = {
  key: string;
  productId: string;
  productName: string;
  unit: string;
  quantityRemaining: number;
  weightedAvgUnitCost: number;
  weightedAvgSalePrice: number;
  margin: number;
  inventoryValueAtCost: number;
  inventoryValueAtSale: number;
  lotCount: number;
  lots: WeightedCostLotLine[];
};

/** Agrupa lotes por producto + unidad y calcula costo ponderado del disponible. */
function weightedCostRowsByProduct(batches: Batch[]): WeightedCostRow[] {
  const groups = new Map<string, Batch[]>();
  for (const b of batches) {
    const rem = Number(b.remaining || 0);
    if (rem <= 0) continue;
    const key = `${b.productId}|||${String(b.unit || "").toLowerCase()}`;
    const arr = groups.get(key) || [];
    arr.push(b);
    groups.set(key, arr);
  }
  const rows: WeightedCostRow[] = [];
  for (const [key, loots] of groups) {
    const wac = weightedAvgUnitCostRemaining(loots);
    if (wac == null) continue;
    const sorted = sortBatchesFifoOrder(loots);
    const lots: WeightedCostLotLine[] = sorted.map((b) => ({
      batchId: b.id,
      date: String(b.date || ""),
      quantity: roundQty(Number(b.quantity || 0)),
      remaining: roundQty(Number(b.remaining || 0)),
      purchasePrice: Number(b.purchasePrice || 0),
      salePrice: Number(b.salePrice || 0),
      orderName: String(b.orderName || "").trim() || undefined,
    }));
    const rem = roundQty(
      loots.reduce((a, b) => a + Number(b.remaining || 0), 0),
    );
    const wasp = weightedAvgSalePriceRemaining(loots) ?? 0;
    const first = sorted[0];
    rows.push({
      key,
      productId: first.productId,
      productName: first.productName,
      unit: first.unit,
      quantityRemaining: rem,
      weightedAvgUnitCost: wac,
      weightedAvgSalePrice: wasp,
      margin: Number((wasp - wac).toFixed(2)),
      inventoryValueAtCost: Number((rem * wac).toFixed(2)),
      inventoryValueAtSale: Number((rem * wasp).toFixed(2)),
      lotCount: lots.length,
      lots,
    });
  }
  rows.sort((a, b) =>
    a.productName.localeCompare(b.productName, "es", {
      sensitivity: "base",
    }),
  );
  return rows;
}

// ===== Types =====
interface Product {
  id: string;
  name: string;
  category: string;
  measurement: string; // lb / unidad / etc.
  price: number;
  providerPrice?: number;
  /** false = no aparece al crear pedidos; los lotes existentes siguen listándose */
  active?: boolean;
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

  // ✅ metadata grupo/pedido
  batchGroupId?: string;
  orderName?: string;
  /** Activo = vendible; Pendiente = no se debita en ventas */
  estadoStock: BatchStockStatus;
}

type GroupRow = {
  groupId: string;
  orderName: string;
  date: string;
  typeLabel: string;
  status: "PENDIENTE" | "PAGADO";
  stockStatusSummary: GroupStockStatusSummary;

  lbsIn: number;
  lbsRem: number;
  udsIn: number;
  udsRem: number;
  cajillasIn: number;
  cajillasRem: number;

  totalFacturado: number;
  totalEsperado: number;
  utilidadBruta: number;

  items: Batch[];
};

/** El pedido tiene al menos una línea con existencia &gt; 0 (lb, un o cajilla). */
function groupHasStockRemaining(g: GroupRow): boolean {
  return g.lbsRem > 0 || g.udsRem > 0 || g.cajillasRem > 0;
}

// ===== helpers =====
function uid(prefix = "LOT") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ===== Props =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface InventoryBatchesProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function InventoryBatches({
  role = "",
  roles,
  sellerCandyId = "",
  currentUserEmail,
}: InventoryBatchesProps & { roles?: RoleProp[] | string[] }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const { refreshKey, refresh } = useManualRefresh();

  const subject = (roles && (roles as any).length ? roles : role) as any;
  const isAdmin = hasRole(subject, "admin");
  const canCreateBatch = isAdmin || hasRole(subject, "contador");

  // 🔎 Filtro por fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd"),
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd"),
  );

  // 🔵 Filtro por producto
  const [productFilterId, setProductFilterId] = useState<string>("");

  // 👉 Modal Crear Pedido/Lote
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ===== Form header del pedido =====
  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );

  // ===== Filtro unidad ANTES de seleccionar producto =====
  const [unitFilter, setUnitFilter] = useState<string>("lb");

  // ===== Inputs para agregar producto al pedido =====
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(NaN);
  const [salePrice, setSalePrice] = useState<number>(0);
  const [lineEstadoStock, setLineEstadoStock] =
    useState<BatchStockStatus>("ACTIVO");

  // items agregados al pedido
  type OrderItem = {
    tempId: string;
    productId: string;
    productName: string;
    category: string;
    unit: string;

    quantity: number;
    remaining: number;

    purchasePrice: number;
    salePrice: number;

    invoiceTotal: number;
    expectedTotal: number;
    utilidadBruta: number;
    estadoStock: BatchStockStatus;
  };

  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupItems, setEditingGroupItems] = useState<Batch[]>([]);

  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailGroup, setDetailGroup] = useState<GroupRow | null>(null);
  /** Web (md+): panel lateral con detalle del pedido (evita tabla ancha con scroll horizontal). */
  const [desktopDrawerGroup, setDesktopDrawerGroup] = useState<GroupRow | null>(
    null,
  );

  // confirmar pago
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupRow | null>(null);
  /** Confirmar cambio Activa / Pendiente (solo lotes con existencia &gt; 0). */
  const [estadoStockConfirm, setEstadoStockConfirm] = useState<{
    group: GroupRow;
    estado: BatchStockStatus;
  } | null>(null);
  // acordeón móvil: id del grupo expandido (null = ninguno)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const toggleGroupExpand = (groupId: string) =>
    setExpandedGroupId((prev) => (prev === groupId ? null : groupId));

  // estado para KPIs colapsable
  /** Panel de KPIs (Resumen / Finanzas / Cobros): visible por defecto. */
  const [kpisExpanded, setKpisExpanded] = useState<boolean>(true);

  type AvailabilityFilter = "all" | "with" | "without";
  const [availabilityFilter, setAvailabilityFilter] =
    useState<AvailabilityFilter>("all");
  /** Fila expandida en tabla de costo ponderado (detalle de lotes). */
  const [weightedCostDetailKey, setWeightedCostDetailKey] = useState<
    string | null
  >(null);
  /** Modal: explicación sencilla del costo ponderado. */
  const [ponderadoInfoOpen, setPonderadoInfoOpen] = useState(false);
  const [salePonderadoDetailKey, setSalePonderadoDetailKey] = useState<
    string | null
  >(null);
  /** Paneles de costo/venta ponderados: visibles por defecto. */
  const [weightedCostPanelExpanded, setWeightedCostPanelExpanded] =
    useState(true);
  const [saleVsCostPanelExpanded, setSaleVsCostPanelExpanded] = useState(true);
  /** Menú ⋮ junto a Refrescar (exportar / crear lote). */
  const [mainToolsMenuRect, setMainToolsMenuRect] =
    useState<DOMRect | null>(null);
  /** Menú ⋮ por fila de pedido/lote. */
  const [rowActionMenu, setRowActionMenu] = useState<{
    groupId: string;
    rect: DOMRect;
  } | null>(null);
  const [mobileTypeOpen, setMobileTypeOpen] = useState<Record<string, boolean>>(
    {},
  );
  const toggleMobileType = (type: string) =>
    setMobileTypeOpen((prev) => ({
      ...prev,
      [type]: !(prev[type] ?? false),
    }));

  // ===== Precio vigente: panel al crear/editar lote =====
  const [showPriceInfoModal, setShowPriceInfoModal] = useState(false);
  const [priceInfoProductId, setPriceInfoProductId] = useState<string>("");

  const formatQtyLabel = (lbs: number, uds: number) => {
    const parts: string[] = [];
    if (lbs > 0) parts.push(`${lbs.toFixed(3)} lb`);
    if (uds > 0) parts.push(`${uds.toFixed(3)} un`);
    if (parts.length === 0) return "0";
    return parts.join(" • ");
  };

  /** Resumen por fila de pedido: lb / un / caj (solo partes > 0). */
  const formatGroupQtyLine = (lbs: number, uds: number, caj: number) => {
    const parts: string[] = [];
    if (lbs > 0) parts.push(`${lbs.toFixed(3)} lb`);
    if (uds > 0) parts.push(`${uds.toFixed(3)} un`);
    if (caj > 0) parts.push(`${caj.toFixed(3)} caj`);
    if (parts.length === 0) return "0";
    return parts.join(" • ");
  };

  const isPounds = (u: string) => {
    const s = (u || "").toLowerCase();
    return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
  };

  /** Suma de existencias (`remaining`) por producto: lotes con fecha en el periodo (from–to). Incluye resumen lb/un/caj para "Todos". */
  const existenciasPeriodoPorProducto = useMemo(() => {
    const map = new Map<string, number>();
    let lbsRem = 0;
    let udsRem = 0;
    let cajRem = 0;
    const isCajilla = (u: string) =>
      String(u || "")
        .toLowerCase()
        .trim() === "cajilla";
    for (const b of batches) {
      if (fromDate && b.date < fromDate) continue;
      if (toDate && b.date > toDate) continue;
      const r = Number(b.remaining || 0);
      map.set(b.productId, (map.get(b.productId) || 0) + r);
      if (isPounds(b.unit)) lbsRem += r;
      else if (isCajilla(b.unit)) cajRem += r;
      else udsRem += r;
    }
    const todosExistLine = formatGroupQtyLine(lbsRem, udsRem, cajRem);
    return { map, todosExistLine };
  }, [batches, fromDate, toDate]);

  const productFilterLabel = useMemo(() => {
    if (!productFilterId) {
      return `Todos (exist. ${existenciasPeriodoPorProducto.todosExistLine})`;
    }
    const prod = products.find((p) => p.id === productFilterId);
    if (!prod) return "Filtro activo";
    const ex = existenciasPeriodoPorProducto.map.get(productFilterId) ?? 0;
    return `${prod.name} — ${prod.category} (existencia: ${fmtExistRemQty(ex)})`;
  }, [productFilterId, products, existenciasPeriodoPorProducto]);

  // ===== Load =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");

      // products
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
          providerPrice: Object.prototype.hasOwnProperty.call(
            it,
            "providerPrice",
          )
            ? Number(it.providerPrice)
            : undefined,
          active: it.active !== false,
        });
      });
      setProducts(prods);

      // batches
      const qB = query(
        collection(db, "inventory_batches"),
        orderBy("date", "desc"),
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

          batchGroupId: b.batchGroupId,
          orderName: b.orderName,
          estadoStock: parseBatchStockStatus(b.estadoStock),
        });
      });

      setBatches(rows);
      setLoading(false);
    })();
  }, [refreshKey]);

  // ===== Filtro en memoria =====
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  // ===== Totales arriba =====
  const totals = useMemo(() => {
    const totalFacturado = filteredBatches.reduce(
      (a, b) => a + Number(b.invoiceTotal || 0),
      0,
    );
    const totalEsperado = filteredBatches.reduce(
      (a, b) => a + Number(b.expectedTotal || 0),
      0,
    );

    const totalExistenciasMonetarias = Number(
      filteredBatches
        .reduce(
          (acc, b) => acc + Number(b.remaining || 0) * Number(b.salePrice || 0),
          0,
        )
        .toFixed(2),
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
      totalExistenciasMonetarias,
    };
  }, [filteredBatches]);

  /** Costo ponderado por producto (solo lotes con remaining > 0 en el filtro actual). */
  const weightedCostInventoryRows = useMemo(
    () => weightedCostRowsByProduct(filteredBatches),
    [filteredBatches],
  );

  const totalInventoryAtWeightedCost = useMemo(
    () =>
      Number(
        weightedCostInventoryRows
          .reduce((a, r) => a + r.inventoryValueAtCost, 0)
          .toFixed(2),
      ),
    [weightedCostInventoryRows],
  );

  useEffect(() => {
    if (!weightedCostDetailKey) return;
    const onDown = (ev: MouseEvent) => {
      const root = document.querySelector("[data-weighted-cost-root]");
      if (root && !root.contains(ev.target as Node)) {
        setWeightedCostDetailKey(null);
      }
    };
    const t = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
    }, 0);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
    };
  }, [weightedCostDetailKey]);

  const [ventasRealizadas, setVentasRealizadas] = useState<number>(0);
  const [ventasCount, setVentasCount] = useState<number>(0);
  const [abonosFecha, setAbonosFecha] = useState<number>(0);
  const [cuentasPorCobrar, setCuentasPorCobrar] = useState<number>(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setVentasRealizadas(0);
        setAbonosFecha(0);

        if (!fromDate || !toDate) return;

        // 1) Ventas (salesV2) en rango — expand items into rows like FinancialDashboard
        const qs = query(
          collection(db, "salesV2"),
          // date is stored as yyyy-MM-dd
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          where("date", ">=", fromDate),
          // @ts-ignore
          where("date", "<=", toDate),
        );
        const sSnap = await getDocs(qs);
        const sRows: Array<any> = [];
        sSnap.forEach((d) => {
          const x = d.data() as any;
          const baseDate = x.date ?? "";

          // If sale has items[], create ONE row per item
          if (Array.isArray(x.items) && x.items.length > 0) {
            x.items.forEach((it: any, idx: number) => {
              const prod = String(it.productName ?? "(sin nombre)");
              const qty = Number(it.qty ?? 0);
              const lineFinal =
                Number(it.lineFinal ?? 0) ||
                Math.max(
                  0,
                  Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
                );
              sRows.push({
                id: `${d.id}#${idx}`,
                date: baseDate,
                productName: prod,
                quantity: qty,
                amount: lineFinal,
                allocations: Array.isArray(it.allocations)
                  ? it.allocations
                  : x.allocations,
                avgUnitCost: Number(it.avgUnitCost ?? x.avgUnitCost ?? 0),
                measurement: it.measurement ?? x.measurement ?? "",
                type: x.type ?? "CONTADO",
              });
            });
            return;
          }

          // Fallback to old shape
          sRows.push({
            id: d.id,
            date: baseDate,
            productName: x.productName ?? "(sin nombre)",
            quantity: Number(x.quantity ?? 0),
            amount: Number(x.amount ?? x.amountCharged ?? 0),
            allocations: Array.isArray(x.allocations) ? x.allocations : [],
            avgUnitCost: Number(x.avgUnitCost ?? 0),
            measurement: x.measurement ?? "",
            type: x.type ?? "CONTADO",
          });
        });

        // Sum only cash rows to match FinancialDashboard (type === 'CONTADO')
        let ventasSum = 0;
        let ventasDocsCount = 0;
        sRows.forEach((r) => {
          if (String(r.type ?? "").toUpperCase() === "CONTADO") {
            ventasSum += Number(r.amount || 0);
            // count unique sale ids (by splitting id before #)
            const saleId = String(r.id || "").split("#")[0];
            ventasDocsCount = ventasDocsCount || 0; // keep as number
          }
        });
        // For ventasDocsCount, count unique sale ids among cash rows
        const cashSaleIds = new Set<string>();
        sRows.forEach((r) => {
          if (String(r.type ?? "").toUpperCase() === "CONTADO") {
            const saleId = String(r.id || "").split("#")[0];
            if (saleId) cashSaleIds.add(saleId);
          }
        });
        ventasDocsCount = cashSaleIds.size;

        // 2) Abonos (ar_movements_pollo) - fetch all and resolve date (like FinancialDashboard)
        const aSnap = await getDocs(collection(db, "ar_movements_pollo"));
        let abonosSum = 0;
        const resolveMovementDate = (m: any) => {
          if (m?.date) return String(m.date);
          if (m?.createdAt?.toDate)
            return format(m.createdAt.toDate(), "yyyy-MM-dd");
          return "";
        };

        // accumulate balances and last movement date per customer
        const balanceByCustomer: Record<string, number> = {};
        const lastMoveByCustomer: Record<string, string> = {};

        aSnap.forEach((d) => {
          const m = d.data() as any;
          const amount = Number(m.amount || 0);
          const customerId = String(m.customerId ?? "").trim();
          if (customerId) {
            balanceByCustomer[customerId] =
              (balanceByCustomer[customerId] || 0) + amount;
            const md = resolveMovementDate(m);
            if (md) {
              const prev = lastMoveByCustomer[customerId] || "";
              if (!prev || md > prev) lastMoveByCustomer[customerId] = md;
            }
          }

          const type = String(m.type ?? "").toUpperCase();
          if (type !== "ABONO") return;
          const moveDate = resolveMovementDate(m);
          if (!moveDate) return;
          if (moveDate >= fromDate && moveDate <= toDate) {
            abonosSum += Math.abs(amount);
          }
        });

        // cuentas por cobrar: sum positive balances whose last movement falls in the period
        let cuentasSum = 0;
        Object.keys(balanceByCustomer).forEach((cid) => {
          const bal = Number(balanceByCustomer[cid] || 0);
          const last = lastMoveByCustomer[cid] || "";
          if (bal > 0 && last && last >= fromDate && last <= toDate) {
            cuentasSum += bal;
          }
        });

        if (!mounted) return;
        setVentasRealizadas(Number(ventasSum.toFixed(2)));
        setVentasCount(ventasDocsCount);
        setAbonosFecha(Number(abonosSum.toFixed(2)));
        setCuentasPorCobrar(Number(cuentasSum.toFixed(2)));
      } catch (e) {
        console.error("Error cargando ventas/abonos para KPIs:", e);
        if (mounted) {
          setVentasRealizadas(0);
          setAbonosFecha(0);
          setCuentasPorCobrar(0);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [fromDate, toDate, refreshKey]);

  // ===== Agrupar en pedidos/lotes =====
  const groupedRows = useMemo<GroupRow[]>(() => {
    const map = new Map<string, Batch[]>();

    for (const b of filteredBatches) {
      const gid = (b.batchGroupId && String(b.batchGroupId).trim()) || b.id;
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid)!.push(b);
    }

    const rows: GroupRow[] = [];
    for (const [groupId, items] of map.entries()) {
      const ordered = [...items].sort((a, b) => {
        const sa = a.createdAt?.seconds ?? 0;
        const sb = b.createdAt?.seconds ?? 0;
        return sb - sa;
      });

      const date = ordered[0]?.date || "";

      const orderNameLocal =
        String(ordered[0]?.orderName || "").trim() ||
        `Pedido ${date || ""}`.trim() ||
        "Pedido";

      const cats = new Set(
        ordered.map((x) => String(x.category || "").trim()).filter(Boolean),
      );
      const typeLabel =
        cats.size === 1 ? Array.from(cats)[0].toUpperCase() : "MIXTO";

      const status: "PENDIENTE" | "PAGADO" = ordered.some(
        (x) => x.status === "PENDIENTE",
      )
        ? "PENDIENTE"
        : "PAGADO";

      const isCajilla = (u: string) =>
        String(u || "")
          .toLowerCase()
          .trim() === "cajilla";

      const lbsIn = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.quantity || 0) : 0),
          0,
        ),
      );
      const lbsRem = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.remaining || 0) : 0),
          0,
        ),
      );

      const cajillasIn = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isCajilla(x.unit) ? Number(x.quantity || 0) : 0),
          0,
        ),
      );
      const cajillasRem = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isCajilla(x.unit) ? Number(x.remaining || 0) : 0),
          0,
        ),
      );

      const udsIn = roundQty(
        ordered.reduce(
          (acc, x) =>
            acc +
            (!isPounds(x.unit) && !isCajilla(x.unit)
              ? Number(x.quantity || 0)
              : 0),
          0,
        ),
      );
      const udsRem = roundQty(
        ordered.reduce(
          (acc, x) =>
            acc +
            (!isPounds(x.unit) && !isCajilla(x.unit)
              ? Number(x.remaining || 0)
              : 0),
          0,
        ),
      );

      const totalFacturado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.invoiceTotal || 0), 0)
          .toFixed(2),
      );
      const totalEsperado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.expectedTotal || 0), 0)
          .toFixed(2),
      );
      const utilidadBruta = Number((totalEsperado - totalFacturado).toFixed(2));

      const stockStatusSummary = summarizeGroupStockStatus(ordered);

      rows.push({
        groupId,
        orderName: orderNameLocal,
        date,
        typeLabel,
        status,
        stockStatusSummary,
        lbsIn,
        lbsRem,
        udsIn,
        udsRem,
        cajillasIn,
        cajillasRem,
        totalFacturado,
        totalEsperado,
        utilidadBruta,
        items: ordered,
      });
    }

    rows.sort((a, b) =>
      a.date === b.date
        ? a.groupId < b.groupId
          ? 1
          : -1
        : a.date < b.date
          ? 1
          : -1,
    );

    return rows;
  }, [filteredBatches]);

  const groupedRowsMobile = useMemo(() => {
    if (availabilityFilter === "all") return groupedRows;
    return groupedRows.filter((g) => {
      const available = g.lbsRem > 0 || g.udsRem > 0;
      return availabilityFilter === "with" ? available : !available;
    });
  }, [groupedRows, availabilityFilter]);

  const groupedRowsMobileByType = useMemo(() => {
    const map = new Map<string, GroupRow[]>();
    groupedRowsMobile.forEach((g) => {
      const key = g.typeLabel || "MIXTO";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(g);
    });
    return Array.from(map.entries()).map(([type, items]) => ({ type, items }));
  }, [groupedRowsMobile]);

  /** Productos que se pueden agregar a un pedido nuevo (excluye inactivos). */
  const productsOrderable = useMemo(
    () => products.filter((p) => p.active !== false),
    [products],
  );

  // ===== productos filtrados por unidad =====
  const productsByUnit = useMemo(() => {
    const u = String(unitFilter || "")
      .toLowerCase()
      .trim();
    const list = productsOrderable.filter(
      (p) =>
        String(p.measurement || "")
          .toLowerCase()
          .trim() === u,
    );
    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [productsOrderable, unitFilter]);

  const productFilterSelectOptions = useMemo(() => {
    const { map, todosExistLine } = existenciasPeriodoPorProducto;
    return [
      { value: "", label: `Todos (exist. ${todosExistLine})` },
      ...products.map((p) => ({
        value: p.id,
        label: `${p.name}${p.active === false ? " (inactivo)" : ""} ${p.price ? `(${money(p.price)})` : ""} — existencia: ${fmtExistRemQty(map.get(p.id) ?? 0)}`,
      })),
    ];
  }, [products, existenciasPeriodoPorProducto]);

  const unitFilterOptions = useMemo(
    () => [
      { value: "lb", label: "Libras" },
      { value: "unidad", label: "Unidad" },
      { value: "cajilla", label: "Cajilla" },
      { value: "kg", label: "Kilogramo" },
    ],
    [],
  );

  const estadoStockSelectOptions = useMemo(
    () => [
      { value: "ACTIVO", label: "Activa" },
      { value: "PENDIENTE", label: "Pendiente" },
    ],
    [],
  );

  const productByUnitSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un producto", disabled: true },
      ...productsByUnit.map((p) => ({
        value: p.id,
        label: `${p.name} — ${p.category} — ${p.measurement}`,
      })),
    ],
    [productsByUnit],
  );

  // autocompletar precio proveedor si el producto tiene `providerPrice`
  useEffect(() => {
    const existing = orderItems.find((it) => it.productId === productId);
    if (existing) {
      setQuantity(Number(existing.quantity || 0));
      setPurchasePrice(Number(existing.purchasePrice || 0));
      setSalePrice(Number(existing.salePrice || 0));
      setLineEstadoStock(parseBatchStockStatus(existing.estadoStock));
      return;
    }

    const p = products.find((x) => x.id === productId);
    if (p) {
      setLineEstadoStock("ACTIVO");
      setQuantity(0);
      setSalePrice(Number(p.price || 0));
      if (p.providerPrice != null && Number.isFinite(Number(p.providerPrice))) {
        setPurchasePrice(Number(p.providerPrice));
      } else {
        setPurchasePrice(NaN);
      }
    } else {
      setLineEstadoStock("ACTIVO");
      setQuantity(0);
      setSalePrice(0);
      setPurchasePrice(NaN);
    }
  }, [productId, products, refreshKey, orderItems]);

  /**
   * Para cada producto del pedido actual, calcula stock existente en otros lotes
   * y precio de venta ponderado (existente + lo que se va a agregar).
   */
  const existingStockByProduct = useMemo(() => {
    const editingBatchIds = new Set(editingGroupItems.map((b) => b.id));
    const map: Record<
      string,
      {
        totalRemaining: number;
        weightedSalePrice: number | null;
        weightedCost: number | null;
        lots: Array<{
          batchId: string;
          date: string;
          remaining: number;
          purchasePrice: number;
          salePrice: number;
          orderName?: string;
        }>;
      }
    > = {};
    const productIds = new Set(orderItems.map((it) => it.productId));
    for (const pid of productIds) {
      const matching = batches.filter(
        (b) =>
          b.productId === pid &&
          Number(b.remaining || 0) > 0 &&
          !editingBatchIds.has(b.id),
      );
      const sorted = sortBatchesFifoOrder(matching);
      const lots = sorted.map((b) => ({
        batchId: b.id,
        date: String(b.date || ""),
        remaining: roundQty(Number(b.remaining || 0)),
        purchasePrice: Number(b.purchasePrice || 0),
        salePrice: Number(b.salePrice || 0),
        orderName: String(b.orderName || "").trim() || undefined,
      }));
      const totalRemaining = roundQty(
        matching.reduce((a, b) => a + Number(b.remaining || 0), 0),
      );
      const oi = orderItems.find((x) => x.productId === pid);
      const newQty = oi ? roundQty(oi.quantity) : 0;
      const newSP = oi ? Number(oi.salePrice || 0) : 0;
      map[pid] = {
        totalRemaining,
        weightedSalePrice: weightedAvgSalePriceRemaining(
          matching,
          newQty,
          newSP,
        ),
        weightedCost: weightedAvgUnitCostRemaining(matching),
        lots,
      };
    }
    return map;
  }, [orderItems, batches, editingGroupItems]);

  // ===== Crear pedido: agregar item =====
  const addItemToOrder = () => {
    setMsg("");

    const p = products.find((x) => x.id === productId);
    if (!p) return setMsg("Selecciona un producto.");
    if (quantity <= 0 || !Number.isFinite(purchasePrice) || purchasePrice <= 0)
      return setMsg("Completa libras a ingresar y precio proveedor.");

    const qtyR = roundQty(quantity);
    const unit = p.measurement;

    const inv = Number((qtyR * Number(purchasePrice || 0)).toFixed(2));
    const exp = Number((qtyR * Number(salePrice || 0)).toFixed(2));
    const util = Number((exp - inv).toFixed(2));

    const existingIndex = orderItems.findIndex((it) => it.productId === p.id);
    if (existingIndex >= 0) {
      setOrderItems((prev) =>
        prev.map((it, idx) =>
          idx !== existingIndex
            ? it
            : {
                ...it,
                quantity: qtyR,
                remaining: qtyR,
                purchasePrice: Number(purchasePrice || 0),
                salePrice: Number(salePrice || 0),
                invoiceTotal: inv,
                expectedTotal: exp,
                utilidadBruta: util,
                estadoStock: lineEstadoStock,
              },
        ),
      );
    } else {
      setOrderItems((prev) => [
        ...prev,
        {
          tempId: uid("IT"),
          productId: p.id,
          productName: p.name,
          category: p.category,
          unit,
          quantity: qtyR,
          remaining: qtyR,
          purchasePrice: Number(purchasePrice || 0),
          salePrice: Number(salePrice || 0),
          invoiceTotal: inv,
          expectedTotal: exp,
          utilidadBruta: util,
          estadoStock: lineEstadoStock,
        },
      ]);
    }

    setProductId("");
    setQuantity(NaN);
    setPurchasePrice(NaN);
    setSalePrice(0);
    setLineEstadoStock("ACTIVO");
  };

  const removeOrderItem = (tempId: string) => {
    setOrderItems((prev) => prev.filter((x) => x.tempId !== tempId));
  };

  const updateOrderItemField = (
    tempId: string,
    field: "quantity" | "purchasePrice" | "salePrice",
    value: number,
  ) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.tempId !== tempId) return it;

        const updated = { ...it } as OrderItem;

        if (field === "quantity") {
          updated.quantity = roundQty(Math.max(0, value));
          // en creación = iguales
          if (!editingGroupId) updated.remaining = updated.quantity;
        }
        if (field === "purchasePrice")
          updated.purchasePrice = Math.max(0, Number(value || 0));
        if (field === "salePrice")
          updated.salePrice = Math.max(0, Number(value || 0));

        updated.invoiceTotal = Number(
          (updated.quantity * updated.purchasePrice).toFixed(2),
        );
        updated.expectedTotal = Number(
          (updated.quantity * updated.salePrice).toFixed(2),
        );
        updated.utilidadBruta = Number(
          (updated.expectedTotal - updated.invoiceTotal).toFixed(2),
        );

        return updated;
      }),
    );
  };

  const updateOrderItemEstadoStock = (
    tempId: string,
    estado: BatchStockStatus,
  ) => {
    setOrderItems((prev) =>
      prev.map((it) =>
        it.tempId === tempId ? { ...it, estadoStock: estado } : it,
      ),
    );
  };

  const orderKpis = useMemo(() => {
    const lbsIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const lbsRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );
    const isCajilla = (u: string) =>
      String(u || "")
        .toLowerCase()
        .trim() === "cajilla";
    const isUnit = (u: string) => !isPounds(u) && !isCajilla(u);

    const unitsIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isUnit(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const unitsRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isUnit(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );

    const cajillasIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isCajilla(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const cajillasRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isCajilla(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );

    const totalFacturado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.invoiceTotal || 0), 0)
        .toFixed(2),
    );
    const totalEsperado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.expectedTotal || 0), 0)
        .toFixed(2),
    );
    const utilidadBruta = Number((totalEsperado - totalFacturado).toFixed(2));

    return {
      lbsIn,
      lbsRem,
      unitsIn,
      unitsRem,
      cajillasIn,
      cajillasRem,
      totalFacturado,
      totalEsperado,
      utilidadBruta,
    };
  }, [orderItems]);

  const resetOrderModal = () => {
    setEditingGroupId(null);
    setEditingGroupItems([]);
    setOrderName("");
    setOrderDate(format(new Date(), "yyyy-MM-dd"));
    setUnitFilter("lb");
    setProductId("");
    setQuantity(0);
    setPurchasePrice(NaN);
    setSalePrice(0);
    setLineEstadoStock("ACTIVO");
    setOrderItems([]);
  };

  // ===== Guardar pedido =====
  const saveOrder = async () => {
    setMsg("");
    if (!orderItems.length)
      return setMsg("Agrega al menos un producto al pedido.");

    const dateStr = orderDate || format(new Date(), "yyyy-MM-dd");
    const name = String(orderName || "").trim() || `Pedido ${dateStr}`;
    const groupId = editingGroupId || uid("BATCH");

    try {
      // crear
      if (!editingGroupId) {
        for (const it of orderItems) {
          await newBatch({
            productId: it.productId,
            productName: it.productName,
            category: it.category,
            unit: it.unit,
            quantity: roundQty(it.quantity),
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            date: dateStr,
            notes: "",
            batchGroupId: groupId,
            orderName: name,
            estadoStock: parseBatchStockStatus(it.estadoStock),
          });
        }

        for (const it of orderItems) {
          try {
            await updateDoc(doc(db, "products", it.productId), {
              activeSalePrice: Number(it.salePrice || 0),
            });
          } catch {}
        }

        setMsg("✅ Pedido creado");
        setShowCreateModal(false);
        resetOrderModal();
        refresh();
        return;
      }

      // editar (upsert + deletes)
      const existing = editingGroupItems;
      const existingByProduct = new Map<string, Batch>();
      for (const b of existing) existingByProduct.set(b.productId, b);

      const productIdsNew = new Set(orderItems.map((x) => x.productId));

      // update/create
      for (const it of orderItems) {
        const oldDoc = existingByProduct.get(it.productId);
        const qtyR = roundQty(it.quantity);

        if (oldDoc) {
          const consumido = roundQty(oldDoc.quantity - oldDoc.remaining);
          const newRemaining = Math.max(0, roundQty(qtyR - consumido));

          await updateDoc(doc(db, "inventory_batches", oldDoc.id), {
            date: dateStr,
            orderName: name,
            batchGroupId: groupId,
            quantity: qtyR,
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            remaining: newRemaining,
            estadoStock: parseBatchStockStatus(it.estadoStock),
          });
        } else {
          await newBatch({
            productId: it.productId,
            productName: it.productName,
            category: it.category,
            unit: it.unit,
            quantity: qtyR,
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            date: dateStr,
            notes: "",
            batchGroupId: groupId,
            orderName: name,
            estadoStock: parseBatchStockStatus(it.estadoStock),
          });
        }
      }

      // delete removed
      for (const b of existing) {
        if (!productIdsNew.has(b.productId)) {
          await deleteDoc(doc(db, "inventory_batches", b.id));
        }
      }

      for (const it of orderItems) {
        try {
          await updateDoc(doc(db, "products", it.productId), {
            activeSalePrice: Number(it.salePrice || 0),
          });
        } catch {}
      }

      setMsg("✅ Pedido actualizado");
      setShowCreateModal(false);
      resetOrderModal();
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al guardar pedido");
    }
  };

  // ===== Acciones de grupo =====
  const openDetail = (g: GroupRow) => {
    if (
      typeof window !== "undefined" &&
      window.matchMedia("(min-width: 768px)").matches
    ) {
      setDesktopDrawerGroup(g);
      return;
    }
    setDetailGroup(g);
    setShowDetailModal(true);
  };

  const openForEdit = (g: GroupRow) => {
    setDesktopDrawerGroup(null);
    setEditingGroupId(g.groupId);
    setEditingGroupItems(g.items);

    setOrderName(g.orderName);
    setOrderDate(g.date || format(new Date(), "yyyy-MM-dd"));

    const items: OrderItem[] = g.items.map((b) => {
      const inv = Number(b.invoiceTotal || 0);
      const exp = Number(b.expectedTotal || 0);
      return {
        tempId: uid("IT"),
        productId: b.productId,
        productName: b.productName,
        category: b.category,
        unit: b.unit,
        quantity: roundQty(b.quantity),
        remaining: roundQty(b.remaining),
        purchasePrice: Number(b.purchasePrice || 0),
        salePrice: Number(b.salePrice || 0),
        invoiceTotal: inv,
        expectedTotal: exp,
        utilidadBruta: Number((exp - inv).toFixed(2)),
        estadoStock: parseBatchStockStatus(b.estadoStock),
      };
    });

    setOrderItems(items);
    setShowCreateModal(true);
  };

  const requestEstadoStockChange = (
    g: GroupRow,
    estado: BatchStockStatus,
  ) => {
    setRowActionMenu(null);
    setEstadoStockConfirm({ group: g, estado });
  };

  const cancelEstadoStockConfirm = () => setEstadoStockConfirm(null);

  const confirmEstadoStockChange = async () => {
    if (!estadoStockConfirm) return;
    const { group: g, estado } = estadoStockConfirm;
    setEstadoStockConfirm(null);
    await executeSetGroupEstadoStock(g, estado);
  };

  const executeSetGroupEstadoStock = async (
    g: GroupRow,
    estado: BatchStockStatus,
  ) => {
    setMsg("");
    const targets = g.items.filter(
      (b) => roundQty(Number(b.remaining || 0)) > 0,
    );
    if (!targets.length) {
      setMsg("No hay lotes con existencia mayor a 0 para actualizar.");
      return;
    }
    try {
      for (const b of targets) {
        await updateDoc(doc(db, "inventory_batches", b.id), {
          estadoStock: estado,
        });
      }
      const n = targets.length;
      setMsg(
        estado === "ACTIVO"
          ? `✅ ${n} lote(s) con existencia activado(s) para ventas`
          : `✅ ${n} lote(s) con existencia pasado(s) a pendiente (ventas)`,
      );
      setRowActionMenu(null);
      setDesktopDrawerGroup((prev) =>
        prev && prev.groupId === g.groupId ? null : prev,
      );
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al actualizar estado de inventario");
    }
  };

  const deleteGroup = async (g: GroupRow) => {
    const ok = confirm(`¿Eliminar el pedido "${g.orderName}" del ${g.date}?`);
    if (!ok) return;

    try {
      for (const b of g.items) {
        await deleteDoc(doc(db, "inventory_batches", b.id));
      }
      setMsg("🗑️ Pedido eliminado");
      setDesktopDrawerGroup(null);
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar pedido");
    }
  };

  const payGroup = (g: GroupRow) => {
    setDesktopDrawerGroup(null);
    setSelectedGroup(g);
    setShowPayDialog(true);
  };

  const confirmPayGroupNow = async () => {
    if (!selectedGroup) return;

    try {
      for (const b of selectedGroup.items) {
        if (b.status !== "PENDIENTE") continue;

        await markBatchAsPaid(b.id);
        await updateDoc(doc(db, "inventory_batches", b.id), { remaining: 0 });

        /* Disabled: do not auto-create a sale when paying a batch.
           Previously this block created a salesV2 document for the paid batch.
           We keep marking the batch as paid and setting remaining: 0 only.

        // const saleDoc = {
        //   date: b.date,
        //   productName: b.productName,
        //   quantity: b.quantity,
        //   amount: Number(
        //     (b.expectedTotal ?? b.salePrice * b.quantity).toFixed(2),
        //   ),
        //   allocations: [
        //     {
        //       batchId: b.id,
        //       qty: b.quantity,
        //       unitCost: b.purchasePrice,
        //       lineCost: Number((b.purchasePrice * b.quantity).toFixed(2)),
        //     },
        //   ],
        //   avgUnitCost: b.purchasePrice,
        //   measurement: b.unit,
        //   createdAt: Timestamp.now(),
        //   autoGeneratedFromInventory: true,
        // };
        // await addDoc(collection(db, "salesV2"), saleDoc);
        */
      }

      setMsg("✅ Pedido pagado y reflejado como venta");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al pagar pedido");
    } finally {
      setShowPayDialog(false);
      setSelectedGroup(null);
    }
  };

  const cancelPayDialog = () => {
    setShowPayDialog(false);
    setSelectedGroup(null);
  };

  const handleExportInventoryPdf = () => {
    const doc = new jsPDF({
      unit: "pt",
      format: "a4",
      orientation: "landscape",
    });
    const title = "Inventario de Pollo";
    const subtitle = `Rango: ${fromDate || "(sin inicio)"} a ${
      toDate || "(sin fin)"
    }`;
    const productLine = `Producto: ${productFilterLabel}`;
    const qtyFmt = (n: number) => Number(n || 0).toFixed(3);

    let cursorY = 40;

    doc.setFontSize(16);
    doc.text(title, 40, cursorY);
    cursorY += 16;

    doc.setFontSize(10);
    doc.text(subtitle, 40, cursorY);
    cursorY += 12;
    doc.text(productLine, 40, cursorY);
    cursorY += 14;

    const bumpCursor = () => {
      cursorY = (doc as any).lastAutoTable?.finalY
        ? (doc as any).lastAutoTable.finalY + 18
        : cursorY + 18;
    };

    autoTable(doc, {
      startY: cursorY,
      head: [["KPI", "Valor"]],
      body: [
        ["Libras ingresadas", qtyFmt(totals.lbsIng)],
        ["Libras restantes", qtyFmt(totals.lbsRem)],
        ["Unidades ingresadas", qtyFmt(totals.udsIng)],
        ["Unidades restantes", qtyFmt(totals.udsRem)],
        ["Total esperado", money(totals.totalEsperado)],
        ["Total facturado", money(totals.totalFacturado)],
        [
          "Ganancia sin gastos",
          money(totals.totalEsperado - totals.totalFacturado),
        ],
        ["Existencias monetarias", money(totals.totalExistenciasMonetarias)],
        ["Cantidad de lotes", filteredBatches.length.toString()],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    bumpCursor();

    autoTable(doc, {
      startY: cursorY,
      head: [
        [
          "Fecha",
          "Pedido",
          "Tipo",
          "Lb In",
          "Lb Rem",
          "Ud In",
          "Ud Rem",
          "Facturado",
          "Esperado",
          "Utilidad",
          "Estado pago",
          "Estado inventario",
        ],
      ],
      body: groupedRows.map((g) => [
        g.date,
        g.orderName,
        g.typeLabel,
        qtyFmt(g.lbsIn),
        qtyFmt(g.lbsRem),
        qtyFmt(g.udsIn),
        qtyFmt(g.udsRem),
        money(g.totalFacturado),
        money(g.totalEsperado),
        money(g.utilidadBruta),
        g.status,
        groupStockBadgeLabel(g.stockStatusSummary),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    bumpCursor();

    groupedRows.forEach((group) => {
      doc.setFontSize(11);
      doc.text(
        `Pedido: ${group.orderName} (${group.date}) — ${group.typeLabel}`,
        40,
        cursorY,
      );
      cursorY += 12;

      autoTable(doc, {
        startY: cursorY,
        head: [
          [
            "Producto",
            "Unidad",
            "Ingresado",
            "Restante",
            "Precio compra",
            "Precio venta",
            "Total facturado",
            "Total esperado",
            "Utilidad",
            "Estado pago",
            "Estado inventario",
          ],
        ],
        body: group.items.map((item) => [
          item.productName,
          (item.unit || "").toUpperCase(),
          qtyFmt(item.quantity),
          qtyFmt(item.remaining),
          money(item.purchasePrice),
          money(item.salePrice),
          money(item.invoiceTotal || item.purchasePrice * item.quantity),
          money(item.expectedTotal || item.salePrice * item.quantity),
          money(
            (item.expectedTotal || item.salePrice * item.quantity) -
              (item.invoiceTotal || item.purchasePrice * item.quantity),
          ),
          item.status,
          labelEstadoStock(item.estadoStock),
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [230, 230, 230], textColor: [0, 0, 0] },
      });

      bumpCursor();
    });

    doc.save(
      `inventario_pollo_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.pdf`,
    );
  };

  const handleExportInventoryCsv = () => {
    try {
      const headers = [
        "batchId",
        "batchGroupId",
        "orderName",
        "date",
        "productId",
        "productName",
        "category",
        "unit",
        "quantity",
        "remaining",
        "purchasePrice",
        "salePrice",
        "invoiceTotal",
        "expectedTotal",
        "utilidadBruta",
        "status",
        "estadoStock",
        "notes",
        "paidAmount",
        "paidAt",
      ];

      const csvEscape = (v: any) => {
        if (v == null) return "";
        const s = String(v);
        return `"${s.replace(/"/g, '""')}"`;
      };

      const rows = filteredBatches.map((b) => {
        const paidAtStr = (b as any).paidAt
          ? typeof (b as any).paidAt?.toDate === "function"
            ? (b as any).paidAt.toDate().toISOString()
            : String((b as any).paidAt)
          : "";

        const utilidad = Number(
          (Number(b.expectedTotal || 0) - Number(b.invoiceTotal || 0)).toFixed(
            2,
          ),
        );

        return [
          b.id,
          b.batchGroupId || "",
          b.orderName || "",
          b.date || "",
          b.productId || "",
          b.productName || "",
          b.category || "",
          b.unit || "",
          b.quantity ?? "",
          b.remaining ?? "",
          b.purchasePrice ?? "",
          b.salePrice ?? "",
          b.invoiceTotal ?? "",
          b.expectedTotal ?? "",
          utilidad,
          b.status || "",
          b.estadoStock || "ACTIVO",
          b.notes || "",
          b.paidAmount ?? "",
          paidAtStr,
        ]
          .map(csvEscape)
          .join(",");
      });

      const csvContent = `\uFEFF${headers.map(csvEscape).join(",")}\r\n${rows.join("\r\n")}`;

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filename = `inventario_pollo_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.csv`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg(`✅ CSV exportado: ${filename}`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al exportar CSV");
    }
  };

  const handleExportInventoryXlsx = () => {
    try {
      const rows: any[] = [];

      // Flatten groupedRows -> each item inside a group becomes one row
      groupedRows.forEach((g) => {
        for (const b of g.items) {
          const utilidad = Number(
            (
              Number(b.expectedTotal || 0) - Number(b.invoiceTotal || 0)
            ).toFixed(2),
          );

          const paidAtStr = (b as any).paidAt
            ? typeof (b as any).paidAt?.toDate === "function"
              ? (b as any).paidAt.toDate().toISOString()
              : String((b as any).paidAt)
            : "";

          rows.push({
            groupId: g.groupId,
            orderName: g.orderName,
            groupDate: g.date,
            productId: b.productId,
            productName: b.productName,
            category: b.category,
            unit: b.unit,
            quantity: b.quantity,
            remaining: b.remaining,
            purchasePrice: b.purchasePrice,
            salePrice: b.salePrice,
            invoiceTotal: b.invoiceTotal,
            expectedTotal: b.expectedTotal,
            utilidadBruta: utilidad,
            status: b.status,
            estadoStock: b.estadoStock,
            notes: b.notes || "",
            paidAmount: b.paidAmount || "",
            paidAt: paidAtStr,
          });
        }
      });

      if (!rows.length) {
        setMsg("Sin datos para exportar XLSX.");
        return;
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Inventario");

      const filename = `inventario_pollo_sabana_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.xlsx`;
      XLSX.writeFile(wb, filename);
      setMsg(`✅ XLSX exportado: ${filename}`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al exportar XLSX");
    }
  };

  // ===== UI =====
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-2xl font-bold">Inventario</h2>
      </div>

      {/* 🔎 Filtros */}
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

        <Button
          type="button"
          variant="secondary"
          size="sm"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProductFilterId("");
          }}
        >
          Quitar filtro
        </Button>

        <div className="ml-auto flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-10 w-10 shrink-0 rounded-xl p-0 shadow-none !text-base"
            title="¿Qué es el costo ponderado?"
            aria-label="Información sobre costo ponderado"
            onClick={() => {
              setRowActionMenu(null);
              setMainToolsMenuRect(null);
              setPonderadoInfoOpen(true);
            }}
          >
            <FiInfo size={22} className="shrink-0" aria-hidden />
          </Button>
          <RefreshButton onClick={() => refresh()} loading={loading} />
          <ActionMenuTrigger
            className="!h-10 !w-10 shrink-0"
            title="Más acciones"
            aria-label="Menú de acciones"
            iconClassName="h-[22px] w-[22px] text-gray-700"
            onClick={(e) => {
              setRowActionMenu(null);
              setMainToolsMenuRect(e.currentTarget.getBoundingClientRect());
            }}
          />
        </div>
      </div>

      <ActionMenu
        anchorRect={mainToolsMenuRect}
        isOpen={!!mainToolsMenuRect}
        onClose={() => setMainToolsMenuRect(null)}
        width={240}
      >
        <div className="py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            disabled={loading}
            onClick={() => {
              setMainToolsMenuRect(null);
              handleExportInventoryCsv();
            }}
          >
            Exportar productos (CSV)
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            disabled={loading}
            onClick={() => {
              setMainToolsMenuRect(null);
              handleExportInventoryXlsx();
            }}
          >
            Exportar lotes (Excel)
          </Button>
          {canCreateBatch && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
              onClick={() => {
                setMainToolsMenuRect(null);
                resetOrderModal();
                setShowCreateModal(true);
              }}
            >
              Crear lote
            </Button>
          )}
        </div>
      </ActionMenu>

      <ActionMenu
        anchorRect={rowActionMenu?.rect ?? null}
        isOpen={!!rowActionMenu}
        onClose={() => setRowActionMenu(null)}
        width={220}
      >
        <div className="py-1">
          {rowActionMenu &&
            (() => {
              const g = groupedRows.find(
                (x) => x.groupId === rowActionMenu.groupId,
              );
              if (!g) {
                return (
                  <div className="px-3 py-2 text-sm text-gray-500">
                    No se encontró el pedido.
                  </div>
                );
              }
              return (
                <>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                    onClick={() => {
                      openDetail(g);
                      setRowActionMenu(null);
                    }}
                  >
                    Ver detalle
                  </Button>
                  {isAdmin && g.status === "PENDIENTE" && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-medium text-green-800"
                      onClick={() => {
                        payGroup(g);
                        setRowActionMenu(null);
                      }}
                    >
                      Pagar inventario
                    </Button>
                  )}
                  {isAdmin &&
                    groupHasStockRemaining(g) &&
                    g.stockStatusSummary !== "pendiente" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                        onClick={() =>
                          requestEstadoStockChange(g, "PENDIENTE")
                        }
                      >
                        Poner pendiente (ventas)
                      </Button>
                    )}
                  {isAdmin &&
                    groupHasStockRemaining(g) &&
                    g.stockStatusSummary !== "activa" && (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal text-emerald-900"
                        onClick={() => requestEstadoStockChange(g, "ACTIVO")}
                      >
                        Activar (ventas)
                      </Button>
                    )}
                  {isAdmin && (
                    <>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                        onClick={() => {
                          openForEdit(g);
                          setRowActionMenu(null);
                        }}
                      >
                        Editar pedido
                      </Button>
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700"
                        onClick={() => {
                          deleteGroup(g);
                          setRowActionMenu(null);
                        }}
                      >
                        Borrar pedido
                      </Button>
                    </>
                  )}
                </>
              );
            })()}
        </div>
      </ActionMenu>

      {/* KPIs: 3 tarjetas dentro de panel colapsable */}
      <div className="mb-4 border border-slate-200 rounded-2xl bg-slate-50 p-4 shadow-sm">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="w-full justify-between gap-3 rounded-xl -m-1 p-1 text-left font-normal shadow-none ring-offset-0 transition-colors hover:bg-slate-100/80"
          aria-expanded={kpisExpanded}
          onClick={() => setKpisExpanded((v) => !v)}
        >
          <span className="font-semibold text-slate-800">
            Indicadores de contabilidad y administración
          </span>
          <FiChevronDown
            className={`shrink-0 w-5 h-5 text-slate-500 transition-transform ${
              kpisExpanded ? "rotate-180" : ""
            }`}
            aria-hidden
          />
        </Button>
        {kpisExpanded && (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M21 16V8a2 2 0 0 0-2-2h-3V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v2H5a2 2 0 0 0-2 2v8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect
                x="3"
                y="12"
                width="18"
                height="8"
                rx="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="text-xl font-semibold opacity-90">
              Resumen cantidades
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex justify-between">
              <span>Libras ingresadas</span>
              <span className="font-semibold">{totals.lbsIng.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Libras restantes</span>
              <span className="font-semibold">{totals.lbsRem.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Unidades ingresadas</span>
              <span className="font-semibold">{totals.udsIng.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Unidades restantes</span>
              <span className="font-semibold">{totals.udsRem.toFixed(3)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-white/30">
              <span>Cantidad de lotes (filtro)</span>
              <span className="font-semibold">
                {filteredBatches.length.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M12 1v4M17 7H7a4 4 0 0 0 0 8h10a4 4 0 0 0 0-8z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M12 11v6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="text-xl font-semibold opacity-90">Finanzas</div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex justify-between">
              <span>Total esperado (ventas)</span>
              <span className="font-semibold">
                {money(totals.totalEsperado)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Total facturado</span>
              <span className="font-semibold">
                {money(totals.totalFacturado)}
              </span>
            </div>
            <div className="flex justify-between items-start gap-2">
              <div>
                <span>Utilidad bruta</span>
                <div className="text-[11px] opacity-85 font-normal leading-snug mt-0.5 max-w-[14rem]">
                  Margen teórico al registrar el pedido (no es la ganancia de
                  ventas).
                </div>
              </div>
              <span className="font-semibold shrink-0">
                {money(totals.totalEsperado - totals.totalFacturado)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Existencias a precio venta</span>
              <span className="font-semibold">
                {money(totals.totalExistenciasMonetarias)}
              </span>
            </div>
            <div className="flex justify-between border-t border-white/25 pt-2">
              <div>
                <span>Inventario a costo ponderado</span>
                <div className="text-[11px] opacity-85 font-normal leading-snug mt-0.5 max-w-[14rem]">
                  Σ(cant. restante × costo de compra) por producto.
                </div>
              </div>
              <span className="font-semibold shrink-0">
                {money(totalInventoryAtWeightedCost)}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 12V8a5 5 0 0 1 10 0v4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 17v.01"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="text-xl font-semibold opacity-90">
              Cobros y Abonos
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex flex-col">
              <div className="flex justify-between items-baseline">
                <span>Ventas realizadas</span>
                <span className="font-semibold">{money(ventasRealizadas)}</span>
              </div>
              <div className="text-xs opacity-90 mt-1">
                Ventas (cash): {ventasCount}
              </div>
            </div>
            <div className="flex justify-between">
              <span>Abonos a la fecha</span>
              <span className="font-semibold">{money(abonosFecha)}</span>
            </div>
            <div className="flex justify-between">
              <span>Cuentas por cobrar</span>
              <span className="font-semibold">{money(cuentasPorCobrar)}</span>
            </div>
          </div>
        </div>
          </div>
        )}
      </div>

      {weightedCostInventoryRows.length > 0 && (
        <div
          className="mb-4 border border-slate-200 rounded-2xl bg-slate-50 p-4 shadow-sm"
          data-weighted-cost-root
        >
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-between gap-3 rounded-xl -m-1 p-1 text-left font-normal shadow-none ring-offset-0 transition-colors hover:bg-slate-100/80"
            aria-expanded={weightedCostPanelExpanded}
            onClick={() => {
              setWeightedCostPanelExpanded((v) => {
                const next = !v;
                if (!next) setWeightedCostDetailKey(null);
                return next;
              });
            }}
          >
            <span className="font-semibold text-slate-800">
              Costo de compra ponderado (stock disponible)
            </span>
            <FiChevronDown
              className={`shrink-0 w-5 h-5 text-slate-500 transition-transform ${
                weightedCostPanelExpanded ? "rotate-180" : ""
              }`}
              aria-hidden
            />
          </Button>
          {weightedCostPanelExpanded && (
            <>
          <p className="text-xs text-slate-600 mb-3 leading-relaxed mt-2">
            Si hay varios lotes del mismo producto con distinto costo, aquí ves
            el costo unitario medio del inventario restante. En la venta, el
            descuento de inventario sigue el orden{" "}
            <strong>FIFO</strong> (lote más antiguo primero); el costo de
            venta y la ganancia en cierre usan ese costo real por lote, no el
            precio del último pedido.
          </p>
          <div className="overflow-x-auto rounded-lg border border-slate-200 bg-white">
            <table className="min-w-[640px] w-full text-sm text-slate-800">
              <thead className="bg-slate-100 text-left">
                <tr>
                  <th className="p-2 border-b">Producto</th>
                  <th className="p-2 border-b">Unidad</th>
                  <th className="p-2 border-b text-right">Existencias</th>
                  <th className="p-2 border-b text-right">Costo Ponderado</th>
                  <th className="p-2 border-b text-right">Valor a costo</th>
                </tr>
              </thead>
              <tbody>
                {weightedCostInventoryRows.map((r) => (
                  <React.Fragment key={r.key}>
                    <tr className="border-b border-slate-100">
                      <td className="p-2">
                        <div className="flex items-start gap-2">
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className={`mt-0.5 h-7 w-7 shrink-0 rounded-full border p-0 shadow-none !text-base transition-colors ${
                              weightedCostDetailKey === r.key
                                ? "border-blue-600 bg-blue-50 text-blue-700"
                                : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                            }`}
                            title="Ver lotes incluidos en el ponderado"
                            aria-expanded={weightedCostDetailKey === r.key}
                            aria-label={`Detalle de ${r.lotCount} inventario(s) para ${r.productName}`}
                            onClick={() =>
                              setWeightedCostDetailKey((k) =>
                                k === r.key ? null : r.key,
                              )
                            }
                          >
                            <FiInfo size={18} className="shrink-0" aria-hidden />
                          </Button>
                          <span className="min-w-0 leading-snug">
                            {r.productName}
                          </span>
                        </div>
                      </td>
                      <td className="p-2">{(r.unit || "").toUpperCase()}</td>
                      <td className="p-2 text-right tabular-nums">
                        {r.quantityRemaining.toFixed(3)}
                      </td>
                      <td className="p-2 text-right tabular-nums">
                        {money(r.weightedAvgUnitCost)}
                      </td>
                      <td className="p-2 text-right tabular-nums font-medium">
                        {money(r.inventoryValueAtCost)}
                      </td>
                    </tr>
                    {weightedCostDetailKey === r.key && (
                      <tr className="border-b border-slate-200 bg-slate-100/80">
                        <td colSpan={5} className="p-0">
                          <div className="p-3 text-left">
                            <div className="text-xs font-semibold text-slate-700 mb-2">
                              {r.lotCount === 1
                                ? "1 inventario (lote) con saldo entra en el promedio."
                                : `${r.lotCount} inventarios (lotes) con saldo entran en el promedio (orden FIFO para referencia).`}
                            </div>
                            <div className="overflow-x-auto rounded border border-slate-200 bg-white">
                              <table className="min-w-[520px] w-full text-xs text-slate-800">
                                <thead className="bg-slate-50">
                                  <tr>
                                    <th className="p-2 text-left font-semibold">
                                      Fecha lote
                                    </th>
                                    <th className="p-2 text-left font-semibold">
                                      Pedido
                                    </th>
                                    <th className="p-2 text-left font-mono font-semibold">
                                      Id lote
                                    </th>
                                    <th className="p-2 text-right font-semibold">
                                      Existencias
                                    </th>
                                    <th className="p-2 text-right font-semibold">
                                      Costo compra
                                    </th>
                                    <th className="p-2 text-right font-semibold">
                                      Precio venta
                                    </th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {r.lots.map((lot) => (
                                    <tr
                                      key={lot.batchId}
                                      className="border-t border-slate-100"
                                    >
                                      <td className="p-2 tabular-nums">
                                        {lot.date || "—"}
                                      </td>
                                      <td className="p-2 max-w-[140px] truncate" title={lot.orderName}>
                                        {lot.orderName || "—"}
                                      </td>
                                      <td
                                        className="p-2 font-mono text-[11px] text-slate-600 max-w-[120px] truncate"
                                        title={lot.batchId}
                                      >
                                        {lot.batchId}
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {lot.remaining.toFixed(3)}
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {money(lot.purchasePrice)}
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {money(lot.salePrice)}
                                      </td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>
            </>
          )}
        </div>
      )}

      {/* ===== PANEL: Precio de venta ponderado + margen (con lotes) ===== */}
      {weightedCostInventoryRows.length > 0 && (
        <div className="mb-4 border border-indigo-200 rounded-2xl bg-indigo-50/50 p-4 shadow-sm">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-between gap-3 rounded-xl -m-1 p-1 text-left font-normal shadow-none ring-offset-0 transition-colors hover:bg-indigo-100/60"
            aria-expanded={saleVsCostPanelExpanded}
            onClick={() => {
              setSaleVsCostPanelExpanded((v) => {
                const next = !v;
                if (!next) setSalePonderadoDetailKey(null);
                return next;
              });
            }}
          >
            <span className="font-semibold text-indigo-900">
              Precio de venta ponderado vs costo (stock disponible)
            </span>
            <FiChevronDown
              className={`shrink-0 w-5 h-5 text-indigo-600 transition-transform ${
                saleVsCostPanelExpanded ? "rotate-180" : ""
              }`}
              aria-hidden
            />
          </Button>
          {saleVsCostPanelExpanded && (
            <>
          <p className="text-xs text-indigo-700/70 mb-3 leading-relaxed mt-2">
            Compara el precio de venta ponderado con el costo ponderado de cada
            producto. Toca <strong>ℹ</strong> para ver cada lote individual y
            comparar precios entre lote viejo y lote nuevo. El{" "}
            <strong>margen</strong> indica ganancia por unidad; rojo = pérdida,
            amarillo = margen bajo (&lt;3), verde = saludable.
          </p>
          <div className="overflow-x-auto rounded-lg border border-indigo-200 bg-white">
            <table className="min-w-[780px] w-full text-sm text-slate-800">
              <thead className="bg-indigo-100/60 text-left">
                <tr>
                  <th className="p-2 border-b">Producto</th>
                  <th className="p-2 border-b">Unidad</th>
                  <th className="p-2 border-b text-right">Cantidad</th>
                  <th className="p-2 border-b text-right">P. Costo Pond.</th>
                  <th className="p-2 border-b text-right">P. Venta Pond.</th>
                  <th className="p-2 border-b text-right">Margen</th>
                </tr>
              </thead>
              <tbody>
                {weightedCostInventoryRows.map((r) => {
                  const marginColor =
                    r.margin < 0
                      ? "text-red-700 bg-red-50"
                      : r.margin < 3
                        ? "text-amber-700 bg-amber-50"
                        : "text-green-700 bg-green-50";
                  const isExpanded = salePonderadoDetailKey === r.key;
                  return (
                    <React.Fragment key={r.key}>
                      <tr className="border-b border-slate-100">
                        <td className="p-2">
                          <div className="flex items-start gap-2">
                            <Button
                              type="button"
                              variant="outline"
                              size="sm"
                              className={`mt-0.5 h-7 w-7 shrink-0 rounded-full border p-0 shadow-none !text-base transition-colors ${
                                isExpanded
                                  ? "border-indigo-600 bg-indigo-50 text-indigo-700"
                                  : "border-slate-300 bg-white text-slate-600 hover:bg-slate-100"
                              }`}
                              title="Ver lotes individuales"
                              aria-expanded={isExpanded}
                              onClick={() =>
                                setSalePonderadoDetailKey((k) =>
                                  k === r.key ? null : r.key,
                                )
                              }
                            >
                              <FiInfo size={18} className="shrink-0" aria-hidden />
                            </Button>
                            <span className="min-w-0 leading-snug font-medium">
                              {r.productName}
                              {r.lotCount > 1 && (
                                <span className="ml-1.5 text-[11px] font-normal text-indigo-600">
                                  {r.lotCount} lotes
                                </span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td className="p-2">
                          {(r.unit || "").toUpperCase()}
                        </td>
                        <td className="p-2 text-right tabular-nums">
                          {r.quantityRemaining.toFixed(3)}
                        </td>
                        <td className="p-2 text-right tabular-nums font-medium">
                          {money(r.weightedAvgUnitCost)}
                        </td>
                        <td className="p-2 text-right tabular-nums font-medium">
                          {money(r.weightedAvgSalePrice)}
                        </td>
                        <td
                          className={`p-2 text-right tabular-nums font-bold rounded ${marginColor}`}
                        >
                          {money(r.margin)}
                        </td>
                      </tr>

                      {isExpanded && (
                        <tr className="border-b border-indigo-200 bg-indigo-50/40">
                          <td colSpan={6} className="p-0">
                            <div className="p-3">
                              <div className="text-xs font-semibold text-indigo-800 mb-2">
                                Detalle por lote — {r.productName} (
                                {r.lotCount}{" "}
                                {r.lotCount === 1 ? "lote" : "lotes"} con stock,
                                orden FIFO)
                              </div>
                              <div className="overflow-x-auto rounded border border-indigo-200 bg-white">
                                <table className="min-w-[600px] w-full text-xs text-slate-800">
                                  <thead className="bg-indigo-50">
                                    <tr>
                                      <th className="p-2 text-left font-semibold">
                                        Fecha
                                      </th>
                                      <th className="p-2 text-right font-semibold">
                                        Cantidad
                                      </th>
                                      <th className="p-2 text-right font-semibold">
                                        Existencias
                                      </th>
                                      <th className="p-2 text-right font-semibold">
                                        P. Costo
                                      </th>
                                      <th className="p-2 text-right font-semibold">
                                        P. Venta
                                      </th>
                                      <th className="p-2 text-right font-semibold">
                                        Margen
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {r.lots.map((lot, idx) => {
                                      const lotMargin =
                                        lot.salePrice - lot.purchasePrice;
                                      const lotMarginColor =
                                        lotMargin < 0
                                          ? "text-red-700"
                                          : lotMargin < 3
                                            ? "text-amber-700"
                                            : "text-green-700";
                                      return (
                                        <tr
                                          key={lot.batchId}
                                          className={`border-t border-slate-100 ${idx === 0 ? "bg-amber-50/40" : ""}`}
                                        >
                                          <td className="p-2 tabular-nums">
                                            {lot.date || "—"}
                                            {idx === 0 && r.lotCount > 1 && (
                                              <span className="ml-1 text-[10px] text-amber-700 font-semibold">
                                                MÁS VIEJO
                                              </span>
                                            )}
                                            {idx === r.lotCount - 1 &&
                                              r.lotCount > 1 && (
                                                <span className="ml-1 text-[10px] text-blue-700 font-semibold">
                                                  MÁS NUEVO
                                                </span>
                                              )}
                                          </td>
                                          <td className="p-2 text-right tabular-nums">
                                            {lot.quantity.toFixed(3)}
                                          </td>
                                          <td className="p-2 text-right tabular-nums">
                                            {lot.remaining.toFixed(3)}
                                          </td>
                                          <td className="p-2 text-right tabular-nums">
                                            {money(lot.purchasePrice)}
                                          </td>
                                          <td className="p-2 text-right tabular-nums">
                                            {money(lot.salePrice)}
                                          </td>
                                          <td
                                            className={`p-2 text-right tabular-nums font-semibold ${lotMarginColor}`}
                                          >
                                            {money(lotMargin)}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                  <tfoot className="bg-indigo-50/60">
                                    <tr className="font-semibold border-t border-indigo-200">
                                      <td colSpan={2} className="p-2">
                                        Ponderado
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {r.quantityRemaining.toFixed(3)}
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {money(r.weightedAvgUnitCost)}
                                      </td>
                                      <td className="p-2 text-right tabular-nums">
                                        {money(r.weightedAvgSalePrice)}
                                      </td>
                                      <td
                                        className={`p-2 text-right tabular-nums font-bold ${
                                          r.margin < 0
                                            ? "text-red-700"
                                            : r.margin < 3
                                              ? "text-amber-700"
                                              : "text-green-700"
                                        }`}
                                      >
                                        {money(r.margin)}
                                      </td>
                                    </tr>
                                  </tfoot>
                                </table>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </React.Fragment>
                  );
                })}
              </tbody>
              <tfoot className="bg-indigo-50/80">
                <tr className="font-semibold text-sm">
                  <td colSpan={2} className="p-2 border-t">
                    Totales
                  </td>
                  <td className="p-2 border-t text-right tabular-nums">
                    {roundQty(
                      weightedCostInventoryRows.reduce(
                        (a, r) => a + r.quantityRemaining,
                        0,
                      ),
                    ).toFixed(3)}
                  </td>
                  <td className="p-2 border-t text-right tabular-nums">
                    {money(
                      weightedCostInventoryRows.reduce(
                        (a, r) => a + r.inventoryValueAtCost,
                        0,
                      ),
                    )}
                  </td>
                  <td className="p-2 border-t text-right tabular-nums">
                    {money(
                      weightedCostInventoryRows.reduce(
                        (a, r) => a + r.inventoryValueAtSale,
                        0,
                      ),
                    )}
                  </td>
                  <td className="p-2 border-t text-right tabular-nums font-bold">
                    {money(
                      weightedCostInventoryRows.reduce(
                        (a, r) => a + r.inventoryValueAtSale,
                        0,
                      ) -
                        weightedCostInventoryRows.reduce(
                          (a, r) => a + r.inventoryValueAtCost,
                          0,
                        ),
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
            </>
          )}
        </div>
      )}

      {/* ===================== */}
      {/* ✅ MOBILE FIRST: CARDS */}
      {/* ===================== */}
      <div className="md:hidden space-y-3">
        <div className="bg-white p-3 rounded-xl border shadow-sm">
          <MobileHtmlSelect
            label="Filtrar por producto"
            value={productFilterId}
            onChange={setProductFilterId}
            options={productFilterSelectOptions}
            sheetTitle="Filtrar por producto"
            triggerIcon="menu"
            selectClassName={POLLO_SELECT_DESKTOP_CLASS}
            buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
          />
        </div>
        <div className="flex gap-2">
          {(
            [
              { key: "all", label: "Todos" },
              { key: "with", label: "Con disponibilidad" },
              { key: "without", label: "Sin disponibilidad" },
            ] as const
          ).map((opt) => {
            const active = availabilityFilter === opt.key;
            return (
              <Button
                key={opt.key}
                type="button"
                variant={active ? "primary" : "secondary"}
                size="sm"
                className="flex-1 !rounded-[25px]"
                onClick={() => setAvailabilityFilter(opt.key)}
              >
                {opt.label}
              </Button>
            );
          })}
        </div>

        {loading ? (
          <div className="bg-white border rounded-2xl p-4 shadow">
            Cargando…
          </div>
        ) : groupedRowsMobile.length === 0 ? (
          <div className="bg-white border rounded-2xl p-4 shadow text-center">
            {availabilityFilter === "with"
              ? "Sin lotes con disponibilidad."
              : availabilityFilter === "without"
                ? "Sin lotes sin disponibilidad."
                : "Sin lotes"}
          </div>
        ) : (
          groupedRowsMobileByType.map(({ type, items }) => {
            const openType = mobileTypeOpen[type] ?? false;
            return (
              <div key={type} className="bg-white border rounded-2xl">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => toggleMobileType(type)}
                  className="w-full justify-between px-4 py-3 text-left font-normal shadow-none ring-offset-0"
                >
                  <div>
                    <div className="font-semibold">{type}</div>
                    <div className="text-xs text-gray-500">
                      {items.length} {items.length === 1 ? "lote" : "lotes"}
                    </div>
                  </div>
                  <span className="text-xs text-gray-500">
                    {openType ? "Cerrar" : "Ver"}
                  </span>
                </Button>

                {openType && (
                  <div className="space-y-3 px-2 pb-4">
                    {items.map((g) => {
                      const expanded = expandedGroupId === g.groupId;
                      const hasRemaining = g.lbsRem > 0 || g.udsRem > 0;
                      return (
                        <div
                          key={g.groupId}
                          className="bg-gray-50 border rounded-2xl"
                        >
                          <div
                            className="p-4 flex items-start justify-between gap-3 cursor-pointer"
                            onClick={() => toggleGroupExpand(g.groupId)}
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-lg">
                                {g.date}
                                <div className="text-sm text-gray-500">
                                  Producto: {g.typeLabel}
                                </div>
                              </div>
                              <div className="text-sm text-gray-400 mt-1 truncate">
                                <span className="text-sm text-gray-500 mr-1">
                                  {g.orderName}
                                </span>
                                <span className="text-sm text-gray-500">
                                  {Array.from(
                                    new Set(
                                      g.items.map((it) =>
                                        String(it.productName || "").trim(),
                                      ),
                                    ),
                                  )
                                    .filter(Boolean)
                                    .slice(0, 6)
                                    .join(", ")}
                                  {g.items.length > 6 ? "…" : ""}
                                </span>
                              </div>
                            </div>

                            <div className="flex flex-col items-end gap-1.5">
                              <span
                                className={`px-2 py-1 rounded text-xs shrink-0 ${
                                  g.status === "PAGADO"
                                    ? "bg-green-100 text-green-700"
                                    : "bg-yellow-100 text-yellow-700"
                                }`}
                              >
                                {g.status}
                              </span>
                              <span
                                className={`px-2 py-1 rounded text-xs shrink-0 font-medium ${groupStockBadgeClass(
                                  g.stockStatusSummary,
                                )}`}
                              >
                                {groupStockBadgeLabel(g.stockStatusSummary)}
                              </span>
                            </div>
                          </div>
                          <div className="pb-4 p-4 flex items-start justify-between gap-1 cursor-pointer">
                            <div className="px-2 py-1 rounded text-xs shrink-0 bg-green-100 font-semibold text-gray-700">
                              Ingresado: {formatQtyLabel(g.lbsIn, g.udsIn)}
                            </div>
                            <span
                              className={`px-2 py-1 rounded text-xs shrink-0 ${
                                hasRemaining
                                  ? "bg-green-100 font-semibold text-gray-700"
                                  : "bg-red-100 font-semibold text-red-700"
                              }`}
                            >
                              Disponible: {formatQtyLabel(g.lbsRem, g.udsRem)}
                            </span>
                          </div>

                          {expanded && (
                            <div className="p-4 pt-0">
                              <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Tipo
                                  </div>
                                  <div className="font-semibold">
                                    {g.typeLabel}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Utilidad bruta
                                  </div>
                                  <div className="font-semibold">
                                    {money(g.utilidadBruta)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Lbs ingresadas
                                  </div>
                                  <div className="font-semibold">
                                    {g.lbsIn.toFixed(3)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Lbs restantes
                                  </div>
                                  <div className="font-semibold">
                                    {g.lbsRem.toFixed(3)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2 col-span-2">
                                  <div className="flex justify-between text-[11px] text-gray-500">
                                    <span>Total facturado</span>
                                    <span>Total esperado</span>
                                  </div>
                                  <div className="flex justify-between font-semibold">
                                    <span>{money(g.totalFacturado)}</span>
                                    <span>{money(g.totalEsperado)}</span>
                                  </div>
                                </div>

                                {g.items.length > 0 && (
                                  <div className="bg-gray-50 rounded-xl p-2 col-span-2 border border-gray-100">
                                    <div className="text-[11px] text-gray-500 mb-2">
                                      Productos asociados
                                    </div>
                                    <div className="space-y-1">
                                      {g.items.map((item) => (
                                        <div
                                          key={item.id}
                                          className="flex items-center text-xs justify-between gap-2"
                                        >
                                          <div className="font-semibold text-gray-800 truncate flex items-center gap-1.5 min-w-0">
                                            <span className="truncate">
                                              {item.productName}
                                            </span>
                                            <span
                                              className={`shrink-0 px-1.5 py-0.5 rounded-[6px] text-[10px] font-semibold ${groupStockBadgeClass(
                                                item.estadoStock === "ACTIVO"
                                                  ? "activa"
                                                  : "pendiente",
                                              )}`}
                                            >
                                              {labelEstadoStock(
                                                item.estadoStock,
                                              )}
                                            </span>
                                          </div>
                                          <div className="text-gray-600 text-right">
                                            <div>
                                              Ingresado:{" "}
                                              {item.quantity.toFixed(3)}
                                            </div>
                                            <div>
                                              Restante:{" "}
                                              {item.remaining.toFixed(3)}
                                            </div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3 flex justify-end">
                                <Button
                                  type="button"
                                  variant="outline"
                                  size="sm"
                                  className="rounded-xl shadow-none !text-base"
                                  onClick={(e) => {
                                    setMainToolsMenuRect(null);
                                    setRowActionMenu({
                                      groupId: g.groupId,
                                      rect: e.currentTarget.getBoundingClientRect(),
                                    });
                                  }}
                                >
                                  <FiMenu size={20} className="shrink-0" aria-hidden />
                                  Acciones
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ===================== */}
      {/* DESKTOP (md+): lista compacta + drawer lateral */}
      {/* ===================== */}
      <div className="hidden md:block bg-white p-4 rounded-lg shadow-lg border w-full">
        <table className="w-full table-fixed text-sm border-collapse">
          <colgroup>
            <col className="w-[5.25rem]" />
            <col />
            <col className="w-[6.25rem]" />
            <col className="w-[6.25rem]" />
            <col className="w-[9rem]" />
            <col className="w-10" />
          </colgroup>
          <thead>
            <tr className="border-b border-gray-200 bg-white">
              <td colSpan={2} className="px-2 py-2 align-bottom min-w-0">
                <MobileHtmlSelect
                  label="Filtrar por producto"
                  value={productFilterId}
                  onChange={setProductFilterId}
                  options={productFilterSelectOptions}
                  sheetTitle="Filtrar por producto"
                  triggerIcon="menu"
                  selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} w-full min-w-0`}
                  buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} w-full min-w-0`}
                />
              </td>
              <td colSpan={4} className="p-0" aria-hidden />
            </tr>
            <tr className="text-left text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50 border-b border-gray-200">
              <th className="px-2 py-2.5">Fecha</th>
              <th className="px-3 py-2.5 min-w-0">Pedido</th>
              <th className="px-1.5 py-2.5 text-right text-[11px] leading-tight">
                Ingresado
              </th>
              <th className="px-1.5 py-2.5 text-right text-[11px] leading-tight">
                Existencia
              </th>
              <th className="px-2 py-2.5 text-right text-[11px] leading-tight whitespace-nowrap">
                Esperado
              </th>
              <th className="px-1 py-2.5 text-center w-10" aria-label="Acciones" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {loading ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-500">
                  Cargando…
                </td>
              </tr>
            ) : groupedRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center text-gray-500">
                  Sin lotes
                </td>
              </tr>
            ) : (
              groupedRows.map((g) => {
                const ingresadoLine = formatGroupQtyLine(
                  g.lbsIn,
                  g.udsIn,
                  g.cajillasIn,
                );
                const existenciaLine = formatGroupQtyLine(
                  g.lbsRem,
                  g.udsRem,
                  g.cajillasRem,
                );
                const hasExistencia =
                  g.lbsRem > 0 || g.udsRem > 0 || g.cajillasRem > 0;
                const existenciaColorClass = hasExistencia
                  ? "text-green-600"
                  : "text-red-600";
                return (
                <tr
                  key={g.groupId}
                  role="button"
                  tabIndex={0}
                  className="hover:bg-gray-50 cursor-pointer transition-colors"
                  onClick={() => setDesktopDrawerGroup(g)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setDesktopDrawerGroup(g);
                    }
                  }}
                >
                  <td className="px-2 py-2.5 align-middle whitespace-nowrap text-gray-800 text-[13px]">
                    {g.date}
                  </td>
                  <td className="px-3 py-2.5 align-middle min-w-0">
                    <div
                      className="font-medium text-gray-900 truncate flex flex-wrap items-center gap-1.5"
                      title={g.orderName}
                    >
                      <span className="truncate">{g.orderName}</span>
                      <span
                        className={`shrink-0 px-1.5 py-0.5 rounded text-[10px] font-semibold uppercase tracking-wide ${groupStockBadgeClass(
                          g.stockStatusSummary,
                        )}`}
                      >
                        {groupStockBadgeLabel(g.stockStatusSummary)}
                      </span>
                    </div>
                    <div
                      className="text-xs text-gray-500 truncate mt-0.5"
                      title={Array.from(
                        new Set(
                          g.items.map((it) =>
                            String(it.productName || "").trim(),
                          ),
                        ),
                      )
                        .filter(Boolean)
                        .join(", ")}
                    >
                      {Array.from(
                        new Set(
                          g.items.map((it) =>
                            String(it.productName || "").trim(),
                          ),
                        ),
                      )
                        .filter(Boolean)
                        .slice(0, 4)
                        .join(", ")}
                      {g.items.length > 4 ? "…" : ""}
                    </div>
                  </td>
                  <td
                    className="px-1.5 py-2 align-middle text-right text-sm font-semibold tabular-nums leading-snug text-gray-900"
                    title={ingresadoLine}
                  >
                    {ingresadoLine}
                  </td>
                  <td
                    className={`px-1.5 py-2 align-middle text-right text-sm font-semibold tabular-nums leading-snug ${existenciaColorClass}`}
                    title={existenciaLine}
                  >
                    {existenciaLine}
                  </td>
                  <td className="px-2 py-2 align-middle text-right text-sm font-semibold tabular-nums whitespace-nowrap text-gray-900">
                    {money(g.totalEsperado)}
                  </td>
                  <td className="px-1 py-2 align-middle text-center">
                    <ActionMenuTrigger
                      className="!h-8 !w-8"
                      title="Acciones del pedido"
                      aria-label={`Acciones: ${g.orderName}`}
                      iconClassName="h-5 w-5 text-gray-700"
                      onClick={(e) => {
                        e.stopPropagation();
                        setMainToolsMenuRect(null);
                        setRowActionMenu({
                          groupId: g.groupId,
                          rect: e.currentTarget.getBoundingClientRect(),
                        });
                      }}
                    />
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <SlideOverDrawer
        open={desktopDrawerGroup != null}
        onClose={() => setDesktopDrawerGroup(null)}
        title={desktopDrawerGroup?.orderName ?? ""}
        subtitle={desktopDrawerGroup?.date}
        titleId="inv-batch-drawer-title"
        badge={
          desktopDrawerGroup ? (
            <span className="flex flex-wrap items-center gap-1.5">
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs ${
                  desktopDrawerGroup.status === "PAGADO"
                    ? "bg-green-100 text-green-700"
                    : "bg-yellow-100 text-yellow-700"
                }`}
              >
                Pago: {desktopDrawerGroup.status}
              </span>
              <span
                className={`inline-block px-2 py-0.5 rounded text-xs font-medium ${groupStockBadgeClass(
                  desktopDrawerGroup.stockStatusSummary,
                )}`}
              >
                {groupStockBadgeLabel(desktopDrawerGroup.stockStatusSummary)}
              </span>
            </span>
          ) : null
        }
        footer={
          desktopDrawerGroup ? (
            <>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="rounded-lg shadow-none"
                onClick={() => {
                  const g = desktopDrawerGroup;
                  setDetailGroup(g);
                  setShowDetailModal(true);
                  setDesktopDrawerGroup(null);
                }}
              >
                Ver en modal
              </Button>
              {isAdmin && desktopDrawerGroup.status === "PENDIENTE" && (
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="rounded-lg bg-green-600 shadow-none hover:bg-green-700 active:bg-green-800"
                  onClick={() => payGroup(desktopDrawerGroup)}
                >
                  Pagar inventario
                </Button>
              )}
              {isAdmin && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="rounded-lg shadow-none"
                    onClick={() => openForEdit(desktopDrawerGroup)}
                  >
                    Editar pedido
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    className="rounded-lg shadow-none"
                    onClick={() => deleteGroup(desktopDrawerGroup)}
                  >
                    Borrar pedido
                  </Button>
                </>
              )}
            </>
          ) : null
        }
      >
        {desktopDrawerGroup ? (
          <>
            <DrawerStatGrid
              items={[
                {
                  label: "Lb ingresadas",
                  value: desktopDrawerGroup.lbsIn.toFixed(3),
                },
                {
                  label: "Lb restantes",
                  value: desktopDrawerGroup.lbsRem.toFixed(3),
                },
                {
                  label: "Un. ingresadas",
                  value: desktopDrawerGroup.udsIn.toFixed(3),
                },
                {
                  label: "Un. restantes",
                  value: desktopDrawerGroup.udsRem.toFixed(3),
                },
                {
                  label: "Caj. ingresadas",
                  value: desktopDrawerGroup.cajillasIn.toFixed(3),
                },
                {
                  label: "Caj. restantes",
                  value: desktopDrawerGroup.cajillasRem.toFixed(3),
                },
              ]}
            />

            <DrawerMoneyStrip
              items={[
                {
                  label: "Total facturado",
                  value: money(desktopDrawerGroup.totalFacturado),
                  tone: "blue",
                },
                {
                  label: "Total esperado",
                  value: money(desktopDrawerGroup.totalEsperado),
                  tone: "slate",
                },
                {
                  label: "Utilidad bruta",
                  value: money(desktopDrawerGroup.utilidadBruta),
                  tone: "emerald",
                },
              ]}
            />

            <DrawerSectionTitle>Productos del pedido</DrawerSectionTitle>
            <div className="mt-2 space-y-3">
              {desktopDrawerGroup.items.map((b) => {
                const inv = Number(b.invoiceTotal || 0);
                const exp = Number(b.expectedTotal || 0);
                const remQty = Number(b.remaining) || 0;
                const existenciaColorClass =
                  remQty <= 0 ? "text-red-600" : "text-green-600";
                return (
                  <DrawerDetailDlCard
                    key={b.id}
                    title={b.productName}
                    rows={[
                      {
                        label: "Unidad",
                        value: (b.unit || "").toUpperCase(),
                        ddClassName: "text-sm font-medium text-gray-900",
                      },
                      {
                        label: "Ingresado",
                        value: b.quantity.toFixed(3),
                      },
                      {
                        label: "Restantes",
                        value: b.remaining.toFixed(3),
                        ddClassName: `text-sm font-semibold tabular-nums ${existenciaColorClass}`,
                      },
                      {
                        label: "P. compra",
                        value: money(b.purchasePrice),
                      },
                      {
                        label: "P. venta",
                        value: money(b.salePrice),
                      },
                      {
                        label: "Estado pago",
                        value: b.status,
                        ddClassName: "text-sm font-medium text-gray-900",
                      },
                      {
                        label: "Estado inventario",
                        value: labelEstadoStock(b.estadoStock),
                        ddClassName: "text-sm font-medium text-gray-900",
                      },
                      {
                        label: "Total factura",
                        value: money(inv),
                      },
                      {
                        label: "Total esperado",
                        value: money(exp),
                      },
                      {
                        label: "Utilidad",
                        value: money(exp - inv),
                        ddClassName:
                          "text-sm font-semibold tabular-nums text-emerald-800",
                      },
                    ]}
                  />
                );
              })}
            </div>
          </>
        ) : null}
      </SlideOverDrawer>

      {msg && <Toast message={msg} onClose={() => setMsg("")} />}

      {ponderadoInfoOpen &&
        createPortal(
          <div className="fixed inset-0 z-[95] flex items-center justify-center p-4">
            <Button
              type="button"
              variant="ghost"
              aria-label="Cerrar"
              className="absolute inset-0 z-0 min-h-full w-full cursor-default rounded-none border-0 bg-black/45 p-0 shadow-none ring-0 hover:bg-black/50 focus-visible:ring-0"
              onClick={() => setPonderadoInfoOpen(false)}
            />
            <div
              className="relative bg-white rounded-2xl shadow-xl max-w-lg w-full p-5 sm:p-6 max-h-[88vh] overflow-y-auto"
              role="dialog"
              aria-labelledby="ponderado-info-title"
            >
              <h3
                id="ponderado-info-title"
                className="text-lg font-bold text-slate-900 mb-3 pr-8"
              >
                ¿Qué es el costo ponderado? (explicación sencilla)
              </h3>
              <div className="text-sm text-slate-800 space-y-3 leading-relaxed">
                <p>
                  A veces compras pollo varias veces y cada compra te cuesta
                  distinto. Además, de cada compra te puede quedar más o menos
                  cantidad en el congelador o en la vitrina.
                </p>
                <p>
                  El <strong>costo ponderado</strong> es un número que el sistema
                  saca así: mira <strong>cuánto te queda</strong> de cada
                  compra, multiplica eso por <strong>lo que te costó en su
                  momento</strong>, suma todo y lo divide entre la cantidad
                  total que te queda. Así sale un &quot;precio medio&quot; por
                  libra o por unidad, solo para que sepas más o menos cuánto
                  dinero tienes metido en mercadería.
                </p>
                <p>
                  <strong>Eso no es lo que cobras al cliente.</strong> Es para
                  tener una idea del valor del inventario a costo.
                </p>
                <p>
                  Cuando <strong>vendes</strong>, el programa no usa ese promedio
                  para el costo de la venta: primero descuenta del{" "}
                  <strong>lote más viejo</strong> que tenga saldo (así se
                  acostumbra en negocio: lo primero que entró es lo primero que
                  sale). Por eso el costo real de esa venta es el precio de
                  compra <strong>de ese lote</strong>, no el promedio.
                </p>
                <p className="text-slate-600">
                  <strong>No tienes que escribir el ponderado a mano.</strong>{" "}
                  Solo cargas el costo de cada pedido cuando lo das de alta; el
                  sistema hace el resto.
                </p>
              </div>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="mt-5 w-full rounded-xl py-2.5 shadow-none"
                onClick={() => setPonderadoInfoOpen(false)}
              >
                Entendido
              </Button>
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL CREAR/EDITAR */}
      {/* ======================= */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-6xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">
                  {editingGroupId ? "Editar pedido" : "Crear pedido"}
                </h3>
                <div className="flex items-center gap-2">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded shadow-none"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cancelar
                  </Button>

                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="rounded shadow-none"
                    onClick={saveOrder}
                    disabled={orderItems.length === 0}
                  >
                    {editingGroupId ? "Editar pedido" : "Crear pedido"}
                  </Button>

                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="rounded shadow-none"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cerrar
                  </Button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Nombre de pedido
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    value={orderName}
                    onChange={(e) => setOrderName(e.target.value)}
                    placeholder="Ej: Pedido Pollo - Semana 1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Fecha de lote
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="border rounded p-3 bg-gray-50 mb-4">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                  <div>
                    <MobileHtmlSelect
                      label="Unidad"
                      value={unitFilter}
                      onChange={(v) => {
                        setUnitFilter(v);
                        setProductId("");
                        setQuantity(0);
                        setPurchasePrice(NaN);
                        setSalePrice(0);
                      }}
                      options={unitFilterOptions}
                      sheetTitle="Unidad"
                      triggerIcon="menu"
                      selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                      buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                    />
                  </div>

                  <div className="md:col-span-2">
                    <MobileHtmlSelect
                      label="Producto (solo activos)"
                      value={productId}
                      onChange={setProductId}
                      options={productByUnitSelectOptions}
                      sheetTitle="Producto"
                      triggerIcon="menu"
                      selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                      buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Ingrese cantidad
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={Number.isNaN(quantity) ? "" : quantity}
                      onFocus={() => {
                        if (quantity === 0) setQuantity(NaN);
                      }}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(3))
                          : 0;
                        setQuantity(Math.max(0, safe));
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing) {
                          updateOrderItemField(
                            existing.tempId,
                            "quantity",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Precio proveedor
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={Number.isNaN(purchasePrice) ? "" : purchasePrice}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        if (raw === "") return setPurchasePrice(NaN);
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(2))
                          : NaN;
                        setPurchasePrice(
                          Number.isFinite(safe) ? Math.max(0, safe) : NaN,
                        );
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing && Number.isFinite(safe)) {
                          updateOrderItemField(
                            existing.tempId,
                            "purchasePrice",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Precio venta (editable)
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
                        setSalePrice(Math.max(0, safe));
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing) {
                          updateOrderItemField(
                            existing.tempId,
                            "salePrice",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>
                </div>

                <div className="mt-3 max-w-xs">
                  <MobileHtmlSelect
                    label="Estado"
                    value={lineEstadoStock}
                    onChange={(v) =>
                      setLineEstadoStock(parseBatchStockStatus(v))
                    }
                    options={estadoStockSelectOptions}
                    sheetTitle="Estado del ingreso"
                    triggerIcon="menu"
                    selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                    buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                  />
                  <p className="mt-1 text-[11px] text-gray-500">
                    Activa: se puede vender. Pendiente: no debita en ventas.
                  </p>
                </div>

                <div className="flex justify-end mt-3">
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    onClick={addItemToOrder}
                    disabled={
                      !(
                        productId &&
                        Number(quantity) > 0 &&
                        Number.isFinite(Number(purchasePrice)) &&
                        Number(purchasePrice) > 0
                      )
                    }
                    className="rounded shadow-none disabled:cursor-not-allowed"
                  >
                    Agregar producto al pedido
                  </Button>
                </div>
              </div>

              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1200px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Ingresado</th>
                      <th className="p-2 border">Existencias</th>
                      <th className="p-2 border">Precio proveedor</th>
                      <th className="p-2 border">Precio venta</th>
                      <th className="p-2 border">Total facturado</th>
                      <th className="p-2 border">Total esperado</th>
                      <th className="p-2 border">Utilidad bruta</th>
                      <th className="p-2 border">Estado</th>
                      <th className="p-2 border">Acciones</th>
                    </tr>
                  </thead>

                  <tbody>
                    {orderItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay productos agregados.
                        </td>
                      </tr>
                    ) : (
                      orderItems.map((it) => (
                        <tr
                          key={it.tempId}
                          className="text-center whitespace-nowrap"
                        >
                          <td className="p-2 border text-left">
                            {it.productName}
                            <div className="text-[11px] text-gray-500">
                              {it.category} — {it.unit}
                            </div>
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.quantity}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(3))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "quantity",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            {Number(it.remaining || 0).toFixed(3)}
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.purchasePrice}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(2))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "purchasePrice",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.salePrice}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(2))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "salePrice",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            {money(it.invoiceTotal)}
                          </td>
                          <td className="p-2 border">
                            {money(it.expectedTotal)}
                          </td>
                          <td className="p-2 border">
                            {money(it.utilidadBruta)}
                          </td>

                          <td className="p-2 border text-left min-w-[8.5rem]">
                            <MobileHtmlSelect
                              label=""
                              value={it.estadoStock}
                              onChange={(v) =>
                                updateOrderItemEstadoStock(
                                  it.tempId,
                                  parseBatchStockStatus(v),
                                )
                              }
                              options={estadoStockSelectOptions}
                              sheetTitle="Estado"
                              triggerIcon="menu"
                              selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} w-full`}
                              buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} w-full`}
                            />
                          </td>

                          <td className="p-2 border">
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              className="rounded px-2 py-1 text-xs shadow-none"
                              onClick={() => removeOrderItem(it.tempId)}
                            >
                              Quitar
                            </Button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* ===== PANEL PRECIO VIGENTE ===== */}
              {orderItems.length > 0 && (
                <div className="mt-4 space-y-3">
                  {orderItems.map((oi) => {
                    const info = existingStockByProduct[oi.productId];
                    if (!info || info.totalRemaining <= 0) return null;
                    const wsp = info.weightedSalePrice;
                    const wc = info.weightedCost;
                    const currentSP = Number(oi.salePrice || 0);
                    const margin =
                      wc != null && currentSP > 0 ? currentSP - wc : null;
                    const totalQty = roundQty(
                      info.totalRemaining + Number(oi.quantity || 0),
                    );
                    const projectedRevenue =
                      currentSP > 0 ? currentSP * totalQty : 0;
                    const projectedRevenueWeighted =
                      wsp != null ? wsp * totalQty : 0;

                    let color = "border-green-300 bg-green-50";
                    let label = "Margen saludable";
                    if (margin != null) {
                      if (margin < 0) {
                        color = "border-red-400 bg-red-50";
                        label = "Precio bajo costo ponderado";
                      } else if (margin < 3) {
                        color = "border-amber-300 bg-amber-50";
                        label = "Margen mínimo";
                      }
                    }

                    return (
                      <div
                        key={oi.productId}
                        className={`border rounded-lg p-3 ${color}`}
                      >
                        <div className="flex items-center justify-between gap-2 mb-2">
                          <div className="font-semibold text-sm">
                            {oi.productName}{" "}
                            <span className="text-xs font-normal text-gray-600">
                              — stock existente + nuevo lote
                            </span>
                          </div>
                          <div className="flex items-center gap-2">
                            <span
                              className={`text-xs font-semibold px-2 py-0.5 rounded-full ${
                                margin != null && margin < 0
                                  ? "bg-red-200 text-red-800"
                                  : margin != null && margin < 3
                                    ? "bg-amber-200 text-amber-800"
                                    : "bg-green-200 text-green-800"
                              }`}
                            >
                              {label}
                            </span>
                            <Button
                              type="button"
                              variant="ghost"
                              size="sm"
                              className="rounded p-1 shadow-none !text-base ring-offset-0 hover:bg-white/60"
                              aria-label="Ver detalle de lotes"
                              title="Ver detalle de lotes"
                              onClick={() => {
                                setPriceInfoProductId(oi.productId);
                                setShowPriceInfoModal(true);
                              }}
                            >
                              <FiInfo
                                size={18}
                                className="shrink-0 text-gray-700"
                                aria-hidden
                              />
                            </Button>
                          </div>
                        </div>

                        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
                          <div>
                            <div className="text-gray-600">Stock existente</div>
                            <div className="font-semibold text-base">
                              {info.totalRemaining.toFixed(3)} {oi.unit}
                            </div>
                          </div>
                          <div>
                            <div className="text-gray-600">Nuevo lote</div>
                            <div className="font-semibold text-base">
                              {roundQty(oi.quantity).toFixed(3)} {oi.unit}
                            </div>
                          </div>
                          <div>
                            <div className="text-gray-600">
                              Precio venta ponderado
                            </div>
                            <div className="font-semibold text-base">
                              {wsp != null ? money(wsp) : "—"}
                            </div>
                          </div>
                          <div>
                            <div className="text-gray-600">
                              Tu precio de venta
                            </div>
                            <div className="font-semibold text-base">
                              {currentSP > 0 ? money(currentSP) : "—"}
                            </div>
                          </div>
                        </div>

                        {margin != null && (
                          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs mt-2">
                            <div>
                              <div className="text-gray-600">
                                Costo ponderado
                              </div>
                              <div className="font-semibold">
                                {wc != null ? money(wc) : "—"}/{oi.unit}
                              </div>
                            </div>
                            <div>
                              <div className="text-gray-600">
                                Margen por {oi.unit}
                              </div>
                              <div
                                className={`font-semibold ${margin < 0 ? "text-red-700" : margin < 3 ? "text-amber-700" : "text-green-700"}`}
                              >
                                {money(margin)}
                              </div>
                            </div>
                            <div>
                              <div className="text-gray-600">
                                Ingreso total estimado
                              </div>
                              <div className="font-semibold">
                                {money(projectedRevenue)}
                              </div>
                            </div>
                            <div>
                              <div className="text-gray-600">
                                Ingreso si usaras ponderado
                              </div>
                              <div className="font-semibold text-gray-500">
                                {money(projectedRevenueWeighted)}
                              </div>
                            </div>
                          </div>
                        )}

                        {margin != null && margin < 0 && (
                          <div className="mt-2 p-2 rounded bg-red-100 text-red-800 text-xs font-semibold">
                            ⚠️ Estás C${Math.abs(margin).toFixed(2)}/{oi.unit}{" "}
                            por debajo del costo. Pérdida estimada:{" "}
                            {money(Math.abs(margin) * totalQty)} en {totalQty.toFixed(3)}{" "}
                            {oi.unit}.
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="mt-0 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="text-xs text-gray-600">
                      Libras ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.lbsIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Libras restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.lbsRem.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Unidades ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.unitsIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Unidades restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.unitsRem.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Cajillas ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.cajillasIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Cajillas restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.cajillasRem.toFixed(3)}
                    </div>
                  </div>
                </div>

                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Total facturado</div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.totalFacturado)}
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Total esperado
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.totalEsperado)}
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Utilidad bruta
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.utilidadBruta)}
                  </div>
                </div>
              </div>

              {/* Footer buttons moved to header for quicker access */}
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL ℹ️ DETALLE DE LOTES POR PRODUCTO */}
      {/* ======================= */}
      {showPriceInfoModal &&
        priceInfoProductId &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowPriceInfoModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-lg max-h-[80vh] overflow-auto p-4">
              {(() => {
                const info = existingStockByProduct[priceInfoProductId];
                const oi = orderItems.find(
                  (x) => x.productId === priceInfoProductId,
                );
                const pName = oi?.productName || priceInfoProductId;
                const unit = oi?.unit || "";
                if (!info || info.lots.length === 0) {
                  return (
                    <div className="text-sm text-gray-500 text-center py-4">
                      No hay lotes existentes con stock para {pName}.
                    </div>
                  );
                }
                return (
                  <>
                    <div className="flex items-center justify-between mb-3">
                      <h3 className="text-base font-bold">
                        Lotes con stock: {pName}
                      </h3>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        className="rounded text-sm shadow-none"
                        onClick={() => setShowPriceInfoModal(false)}
                      >
                        Cerrar
                      </Button>
                    </div>
                    <div className="text-xs text-gray-600 mb-3">
                      Estos son los lotes con existencias pendientes de vender.
                      El precio de venta ponderado combina todos estos lotes +
                      el nuevo que estás creando.
                    </div>
                    <table className="w-full text-xs border">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="p-2 border text-left">Fecha</th>
                          <th className="p-2 border text-left">Pedido</th>
                          <th className="p-2 border text-right">Restante</th>
                          <th className="p-2 border text-right">P. Costo</th>
                          <th className="p-2 border text-right">P. Venta</th>
                        </tr>
                      </thead>
                      <tbody>
                        {info.lots.map((lot) => (
                          <tr key={lot.batchId}>
                            <td className="p-2 border">{lot.date || "—"}</td>
                            <td className="p-2 border">
                              {lot.orderName || "—"}
                            </td>
                            <td className="p-2 border text-right">
                              {lot.remaining.toFixed(3)} {unit}
                            </td>
                            <td className="p-2 border text-right">
                              {money(lot.purchasePrice)}
                            </td>
                            <td className="p-2 border text-right">
                              {money(lot.salePrice)}
                            </td>
                          </tr>
                        ))}
                        {oi && (
                          <tr className="bg-blue-50 font-semibold">
                            <td className="p-2 border">
                              {orderDate || "nuevo"}
                            </td>
                            <td className="p-2 border">
                              {orderName || "Este pedido"}
                            </td>
                            <td className="p-2 border text-right">
                              {roundQty(oi.quantity).toFixed(3)} {unit}
                            </td>
                            <td className="p-2 border text-right">
                              {money(oi.purchasePrice)}
                            </td>
                            <td className="p-2 border text-right">
                              {money(oi.salePrice)}
                            </td>
                          </tr>
                        )}
                      </tbody>
                      <tfoot className="bg-gray-50">
                        <tr className="font-semibold text-sm">
                          <td colSpan={2} className="p-2 border">
                            Total
                          </td>
                          <td className="p-2 border text-right">
                            {roundQty(
                              info.totalRemaining + Number(oi?.quantity || 0),
                            ).toFixed(3)}{" "}
                            {unit}
                          </td>
                          <td className="p-2 border text-right text-gray-600">
                            {info.weightedCost != null
                              ? money(info.weightedCost)
                              : "—"}
                          </td>
                          <td className="p-2 border text-right">
                            {info.weightedSalePrice != null
                              ? money(info.weightedSalePrice)
                              : "—"}
                          </td>
                        </tr>
                      </tfoot>
                    </table>
                  </>
                );
              })()}
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL DETALLE */}
      {/* ======================= */}
      {showDetailModal &&
        detailGroup &&
        createPortal(
          <div className="fixed inset-0 z-[75] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => {
                setShowDetailModal(false);
                setDetailGroup(null);
              }}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-6xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-lg font-bold">Detalle del pedido</h3>
                  <div className="text-sm text-gray-600">
                    <strong>{detailGroup.orderName}</strong> —{" "}
                    {detailGroup.date}
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded shadow-none"
                  onClick={() => {
                    setShowDetailModal(false);
                    setDetailGroup(null);
                  }}
                >
                  Cerrar
                </Button>
              </div>

              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1200px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Unidad</th>
                      <th className="p-2 border">Ingresado</th>
                      <th className="p-2 border">Restantes</th>
                      <th className="p-2 border">Precio Compra</th>
                      <th className="p-2 border">Precio Venta</th>
                      <th className="p-2 border">Total factura</th>
                      <th className="p-2 border">Total esperado</th>
                      <th className="p-2 border">Utilidad</th>
                      <th className="p-2 border">Estado pago</th>
                      <th className="p-2 border">Estado inventario</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailGroup.items.map((b) => {
                      const inv = Number(b.invoiceTotal || 0);
                      const exp = Number(b.expectedTotal || 0);
                      return (
                        <tr
                          key={b.id}
                          className="text-center whitespace-nowrap"
                        >
                          <td className="p-2 border text-left">
                            {b.productName}
                          </td>
                          <td className="p-2 border">
                            {(b.unit || "").toUpperCase()}
                          </td>
                          <td className="p-2 border">
                            {b.quantity.toFixed(3)}
                          </td>
                          <td className="p-2 border">
                            {b.remaining.toFixed(3)}
                          </td>
                          <td className="p-2 border">
                            {money(b.purchasePrice)}
                          </td>
                          <td className="p-2 border">{money(b.salePrice)}</td>
                          <td className="p-2 border">{money(inv)}</td>
                          <td className="p-2 border">{money(exp)}</td>
                          <td className="p-2 border">{money(exp - inv)}</td>
                          <td className="p-2 border">{b.status}</td>
                          <td className="p-2 border">
                            {labelEstadoStock(b.estadoStock)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Libras ingresadas</div>
                  <div className="text-lg font-semibold">
                    {detailGroup.lbsIn.toFixed(3)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Libras restantes</div>
                  <div className="text-lg font-semibold">
                    {detailGroup.lbsRem.toFixed(3)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Utilidad bruta</div>
                  <div className="text-lg font-semibold">
                    {money(detailGroup.utilidadBruta)}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL CONFIRMAR PAGO */}
      {/* ======================= */}
      {showPayDialog &&
        selectedGroup &&
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
                ¿Seguro que quieres pagar este pedido?
                <br />
                <strong>{selectedGroup.orderName}</strong> —{" "}
                {selectedGroup.date}
                <br />
                Ya no habrán libras disponibles al pagar este inventario.
              </p>
              <div className="flex justify-center gap-4">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="rounded-lg bg-green-600 shadow-none hover:bg-green-700 active:bg-green-800"
                  onClick={confirmPayGroupNow}
                >
                  Confirmar
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-lg shadow-none hover:bg-slate-300"
                  onClick={cancelPayDialog}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {estadoStockConfirm &&
        createPortal(
          <div className="fixed inset-0 z-[81] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={cancelEstadoStockConfirm}
              aria-hidden
            />
            <div
              className="relative bg-white rounded-xl shadow-2xl border w-[90%] max-w-md p-6"
              role="alertdialog"
              aria-labelledby="estado-stock-confirm-title"
              aria-describedby="estado-stock-confirm-desc"
            >
              <h3
                id="estado-stock-confirm-title"
                className="text-lg font-bold mb-3 text-center text-gray-900"
              >
                {estadoStockConfirm.estado === "ACTIVO"
                  ? "Activar lotes para ventas"
                  : "Poner lotes en pendiente (ventas)"}
              </h3>
              <p
                id="estado-stock-confirm-desc"
                className="text-sm text-gray-700 mb-5 text-center leading-relaxed"
              >
                <strong>{estadoStockConfirm.group.orderName}</strong> —{" "}
                {estadoStockConfirm.group.date}
                <br />
                <br />
                {estadoStockConfirm.estado === "ACTIVO" ? (
                  <>
                    ¿Confirmas activar para ventas todos los{" "}
                    <strong>lotes con existencia mayor a 0</strong> de este
                    pedido? Podrán descontarse en el formulario de venta.
                  </>
                ) : (
                  <>
                    ¿Confirmas marcar como pendiente todos los{" "}
                    <strong>lotes con existencia mayor a 0</strong>? Ese stock no
                    se podrá vender hasta que lo actives de nuevo.
                  </>
                )}
              </p>
              <div className="flex flex-wrap justify-center gap-3">
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className={
                    estadoStockConfirm.estado === "ACTIVO"
                      ? "rounded-lg bg-emerald-600 shadow-none hover:bg-emerald-700 active:bg-emerald-800"
                      : "rounded-lg shadow-none"
                  }
                  onClick={() => void confirmEstadoStockChange()}
                >
                  Confirmar
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="rounded-lg shadow-none hover:bg-slate-300"
                  onClick={cancelEstadoStockConfirm}
                >
                  Cancelar
                </Button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
