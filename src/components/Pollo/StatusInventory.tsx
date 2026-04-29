import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  addDoc,
  collection,
  serverTimestamp,
  getDoc,
  doc as fsDoc,
  type DocumentSnapshot,
} from "firebase/firestore";
import { format } from "date-fns";
import { db, auth } from "../../firebase";
import allocateFIFOAndUpdateBatches from "../../Services/allocateFIFO";
import RefreshButton from "../common/RefreshButton";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import {
  POLLO_SELECT_COMPACT_DESKTOP_CLASS,
  POLLO_SELECT_COMPACT_MOBILE_CLASS,
  POLLO_SELECT_DESKTOP_CLASS,
  POLLO_SELECT_MOBILE_BUTTON_CLASS,
} from "../common/polloSelectStyles";
import Toast from "../common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";
import Button from "../common/Button";
import PolloChip, { type PolloChipVariant } from "../common/PolloChip";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerDetailDlCard,
  DrawerSectionTitle,
  DrawerStatGrid,
} from "../common/DrawerContentCards";
import * as XLSX from "xlsx";
import {
  fetchGlobalInventoryKpisPollo_debug,
  fetchInventoryProductOptionsPollo,
  fetchProductEvolutionPollo,
  type InvMove,
  type ProductOption,
  type ProductKpis,
} from "../../Services/inventory_evolution_pollo";
import {
  fetchLotGroupsInRange,
  fetchSalesV2ForLotView,
  collectLotSaleAllocHits,
  allocLineAmount,
  allocLineGross,
  lineMatchesProductFilter,
  type LotGroup,
  type LotBatchLine,
  type LotSaleAllocHit,
} from "../../Services/inventory_lotes_pollo";

function tipoMoveChipVariant(t: string): PolloChipVariant {
  switch (t) {
    case "INGRESO":
      return "emerald";
    case "VENTA_CASH":
      return "amber";
    case "VENTA_CREDITO":
      return "violet";
    case "MERMA":
    case "ROBO":
      return "rose";
    default:
      return "neutral";
  }
}

type KpiTone =
  | "slate"
  | "sky"
  | "amber"
  | "violet"
  | "emerald"
  | "rose"
  | "indigo";

const KPI_TONE: Record<KpiTone, string> = {
  slate: "border-slate-200 bg-slate-50/90",
  sky: "border-sky-200 bg-sky-50/90",
  amber: "border-amber-200 bg-amber-50/90",
  violet: "border-violet-200 bg-violet-50/90",
  emerald: "border-emerald-200 bg-emerald-50/90",
  rose: "border-rose-200 bg-rose-50/90",
  indigo: "border-indigo-200 bg-indigo-50/90",
};

function KpiCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: string;
  tone: KpiTone;
}) {
  return (
    <div className={`border rounded-2xl p-3 shadow-sm ${KPI_TONE[tone]}`}>
      <div className="text-xs text-gray-600 font-medium">{title}</div>
      <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");
const monthStart = () =>
  format(new Date(new Date().getFullYear(), new Date().getMonth(), 1), "yyyy-MM-dd");
const moneyFmt = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const normKeyLocal = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

function lotProductChipKeyFromLine(l: LotBatchLine): string {
  return String(l.productId || "").trim() || normKeyLocal(l.productName);
}

/** Una fila por día + producto: ventas desglosadas; restante = total del lote tras ese día (todas las líneas). */
type LotExpandedDailyRow = {
  date: string;
  productKey: string;
  productLabel: string;
  /** Precio unitario de venta (promedio ponderado por lb/und si hay varias líneas ese día). */
  unitSalePrice: number;
  cashQty: number;
  cashMonto: number;
  creditQty: number;
  creditMonto: number;
  restanteTotal: number;
};

function productKeyFromAllocHit(h: LotSaleAllocHit): string {
  return String(h.productId || "").trim() || normKeyLocal(h.productName);
}

function buildLotExpandedDailyRows(
  visLines: LotBatchLine[],
  hits: LotSaleAllocHit[],
): LotExpandedDailyRow[] {
  /** Cantidad asignada a cada batch solo desde ventas cargadas en el rango [from, to]. */
  const allocInRangeByBatch = new Map<string, number>();
  for (const h of hits) {
    const bid = h.batchId;
    allocInRangeByBatch.set(
      bid,
      (allocInRangeByBatch.get(bid) ?? 0) + Number(h.allocQty ?? 0),
    );
  }
  /**
   * Stock simulado al **inicio** del periodo (antes de aplicar ventas del rango):
   * remaining_DB + alloc_en_rango = qty tras ventas anteriores al rango (y cuadra con Σ remaining al final).
   * Antes se inicializaba con `quantity` y solo se restaban ventas del rango → sobrestimaba restante
   * si hubo ventas antes del `from` o consumos no cubiertos por hits (merma, etc.).
   */
  const remSim = new Map<string, number>();
  for (const ln of visLines) {
    const bid = ln.id;
    const allocHere = allocInRangeByBatch.get(bid) ?? 0;
    const remNow = Number(ln.remaining ?? 0);
    remSim.set(bid, round2(remNow + allocHere));
  }
  const sorted = [...hits].sort((a, b) => {
    const c = a.saleDate.localeCompare(b.saleDate);
    if (c !== 0) return c;
    return a.saleId.localeCompare(b.saleId);
  });
  const dates = [...new Set(sorted.map((h) => h.saleDate))].sort();
  const rows: LotExpandedDailyRow[] = [];

  for (const date of dates) {
    const dayHits = sorted.filter((h) => h.saleDate === date);
    const productKeysOrdered: string[] = [];
    const seenPk = new Set<string>();
    for (const h of dayHits) {
      const pk = productKeyFromAllocHit(h);
      if (!seenPk.has(pk)) {
        seenPk.add(pk);
        productKeysOrdered.push(pk);
      }
    }
    const hitsByProduct = new Map<string, LotSaleAllocHit[]>();
    for (const h of dayHits) {
      const pk = productKeyFromAllocHit(h);
      if (!hitsByProduct.has(pk)) hitsByProduct.set(pk, []);
      hitsByProduct.get(pk)!.push(h);
    }

    for (const h of dayHits) {
      const bid = h.batchId;
      const prev = remSim.get(bid) ?? 0;
      remSim.set(bid, Math.max(0, prev - Number(h.allocQty ?? 0)));
    }
    let restanteTotal = 0;
    remSim.forEach((v) => {
      restanteTotal += v;
    });
    restanteTotal = round2(restanteTotal);

    for (const pk of productKeysOrdered) {
      const grp = hitsByProduct.get(pk)!;
      let cashQty = 0;
      let cashMonto = 0;
      let creditQty = 0;
      let creditMonto = 0;
      let priceNumer = 0;
      let priceDenom = 0;
      for (const h of grp) {
        const m = allocLineAmount(h);
        if (h.isCash) {
          cashQty += Number(h.allocQty ?? 0);
          cashMonto += m;
        } else {
          creditQty += Number(h.allocQty ?? 0);
          creditMonto += m;
        }
        const q = Number(h.allocQty ?? 0);
        const up = Number(h.unitPrice ?? 0);
        if (q > 0) {
          priceNumer += q * up;
          priceDenom += q;
        }
      }
      const unitSalePrice =
        priceDenom > 0
          ? round2(priceNumer / priceDenom)
          : round2(Number(grp[0]?.unitPrice ?? 0));
      const label =
        String(grp[0]?.productName || "").trim() ||
        grp.map((x) => String(x.productName || "").trim()).find(Boolean) ||
        "—";
      rows.push({
        date,
        productKey: pk,
        productLabel: label,
        unitSalePrice,
        cashQty: round2(cashQty),
        cashMonto: round2(cashMonto),
        creditQty: round2(creditQty),
        creditMonto: round2(creditMonto),
        restanteTotal,
      });
    }
  }
  return rows;
}

function LotExpandedDailySubtable({
  rows,
  compact,
}: {
  rows: LotExpandedDailyRow[];
  compact?: boolean;
}) {
  if (rows.length === 0) {
    return (
      <span
        className={
          compact ? "text-[11px] text-gray-500" : "text-xs text-gray-600"
        }
      >
        Sin ventas con asignación a este lote en el rango.
      </span>
    );
  }
  const cell = compact
    ? "border border-gray-200 px-2 py-1.5 text-[10px]"
    : "border border-gray-200 px-2 py-2 text-xs sm:text-sm";
  return (
    <div className="w-full min-w-0 overflow-x-auto rounded-lg border border-violet-200/90 bg-white shadow-inner">
      <table className="w-full border-collapse border border-gray-200">
        <thead className="bg-violet-100/90">
          <tr>
            <th
              className={`${cell} text-left font-semibold whitespace-nowrap`}
            >
              Fecha
            </th>
            <th
              className={`${cell} text-left font-semibold whitespace-nowrap min-w-[7rem]`}
            >
              Producto
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Precio venta
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Lb / Und Cash
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Monto
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Lb / Und Crédito
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Monto
            </th>
            <th
              className={`${cell} text-right font-semibold whitespace-nowrap`}
            >
              Restante (Lb / Und)
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={`${row.date}-${row.productKey}`}
              className="odd:bg-white even:bg-violet-50/35"
            >
              <td className={`${cell} font-mono tabular-nums text-left`}>
                {row.date}
              </td>
              <td
                className={`${cell} text-left text-gray-800 max-w-[14rem] truncate`}
                title={row.productLabel}
              >
                {row.productLabel}
              </td>
              <td className={`${cell} text-right tabular-nums`}>
                {moneyFmt(row.unitSalePrice)}
              </td>
              <td className={`${cell} text-right tabular-nums`}>
                {qty3(row.cashQty)}
              </td>
              <td className={`${cell} text-right tabular-nums font-medium`}>
                {moneyFmt(row.cashMonto)}
              </td>
              <td className={`${cell} text-right tabular-nums`}>
                {qty3(row.creditQty)}
              </td>
              <td className={`${cell} text-right tabular-nums font-medium`}>
                {moneyFmt(row.creditMonto)}
              </td>
              <td
                className={`${cell} text-right tabular-nums font-semibold text-emerald-900`}
              >
                {qty3(row.restanteTotal)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function isPolloLbMeasurement(m: string): boolean {
  const s = String(m || "").toLowerCase().trim();
  return s === "lb" || s === "lbs" || s === "libra" || s === "libras";
}

function parseCashQtyLabelForKpis(qtyLabel: string): {
  lbs: number;
  units: number;
} {
  const s = String(qtyLabel).trim();
  if (!s || s === "—") return { lbs: 0, units: 0 };
  const m = s.match(/^([\d.]+)\s*(.*)$/);
  const qty = m ? parseFloat(m[1]) : 0;
  const rest = (m?.[2] || "").toLowerCase().trim();
  if (/\b(lb|lbs|libra|libras)\b/.test(rest) || rest === "lb")
    return { lbs: qty, units: 0 };
  if (!rest) return { lbs: 0, units: qty };
  return { lbs: 0, units: qty };
}

type SaleDrawerLine = {
  id: string;
  date: string;
  productName: string;
  unitPrice: number;
  qtyLabel: string;
  qty: number;
  measurement: string;
  amount: number;
  grossProfit: number;
  seller: string;
};

function lineKpiBucket(line: SaleDrawerLine): "lb" | "unidad" {
  const m = String(line.measurement || "").trim();
  if (m && isPolloLbMeasurement(m)) return "lb";
  if (m && !isPolloLbMeasurement(m)) return "unidad";
  const q = parseCashQtyLabelForKpis(line.qtyLabel);
  if (q.lbs > 0 && q.units === 0) return "lb";
  return "unidad";
}

function aggregateSaleDrawerLines(lines: SaleDrawerLine[]) {
  const products = new Set<string>();
  let lbs = 0;
  let units = 0;
  let amount = 0;
  let grossProfit = 0;
  for (const line of lines) {
    products.add(line.productName);
    amount += line.amount;
    grossProfit += line.grossProfit;
    const qty = Number(line.qty ?? 0);
    if (qty <= 0) continue;
    const bucket = lineKpiBucket(line);
    if (bucket === "lb") lbs += qty;
    else units += qty;
  }
  return {
    productCount: products.size,
    lineCount: lines.length,
    lbs: round2(lbs),
    units: round2(units),
    amount: round2(amount),
    grossProfit: round2(grossProfit),
  };
}

/** Líneas de venta (salesV2) filtradas al producto del evolutivo — mismo criterio que inventory_evolution_pollo. */
function buildSaleDrawerLinesForProduct(
  docId: string,
  x: Record<string, unknown>,
  productKey: string,
  productId: string | undefined,
  productName: string,
): SaleDrawerLine[] {
  const seller =
    String(
      x.userEmail ||
        x.vendor ||
        (x.createdBy as { email?: string } | null)?.email ||
        "—",
    ).trim() || "—";
  const day = String(x.date || "")
    .trim()
    .slice(0, 10);
  if (!day) return [];

  const matchItem = (it: Record<string, unknown>) => {
    const itName = String(it.productName ?? "");
    const itProductId = String(it.productId ?? "").trim();
    return (
      (productId && itProductId && itProductId === productId) ||
      (itProductId && itProductId === productKey) ||
      normKeyLocal(itName) === normKeyLocal(productName) ||
      normKeyLocal(itName) === normKeyLocal(productKey)
    );
  };

  const items = Array.isArray(x.items) ? (x.items as Record<string, unknown>[]) : [];
  const out: SaleDrawerLine[] = [];

  if (items.length > 0) {
    items.forEach((it, idx) => {
      if (!matchItem(it)) return;
      const qty = Number(it.qty ?? 0);
      const lineFinal =
        Number(it.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
        );
      const cogs = Number(it.cogsAmount ?? 0);
      const g = Number(it.grossProfit);
      const gp = Number.isFinite(g) ? round2(g) : round2(lineFinal - cogs);
      const unit = String(it.unit || "").trim();
      const measurement = String(it.measurement ?? it.unit ?? "").trim();
      const qtyLabel =
        `${Number(qty).toFixed(3)}${unit ? ` ${unit}` : ""}`.trim();
      out.push({
        id: `${docId}-${idx}`,
        date: day,
        productName: String(it.productName || "—"),
        unitPrice: Number(it.unitPrice ?? 0),
        qtyLabel,
        qty,
        measurement,
        amount: round2(lineFinal),
        grossProfit: gp,
        seller,
      });
    });
    return out;
  }

  const sName = String(x.productName ?? "");
  const sProductId = String(x.productId ?? "").trim();
  const matchSale =
    (productId && sProductId && sProductId === productId) ||
    (sProductId && sProductId === productKey) ||
    normKeyLocal(sName) === normKeyLocal(productName) ||
    normKeyLocal(sName) === normKeyLocal(productKey);
  if (!matchSale) return [];

  const amt = Number(x.amount ?? x.amountCharged ?? 0);
  const cogs = Number(x.cogsAmount ?? 0);
  const g = Number(x.grossProfit);
  const gp = Number.isFinite(g) ? round2(g) : round2(amt - cogs);
  const qty = Number(x.quantity ?? 0);
  const meas = String(x.measurement || "").trim();
  const qtyLabel =
    qty > 0
      ? `${qty.toFixed(3)}${meas ? ` ${meas}` : ""}`.trim()
      : "—";
  out.push({
    id: docId,
    date: day,
    productName: String(x.productName || "—"),
    unitPrice: Number(x.unitPrice ?? 0),
    qtyLabel,
    qty,
    measurement: meas,
    amount: round2(amt),
    grossProfit: gp,
    seller,
  });
  return out;
}

function batchesHrefForMermaAdj(
  adjId: string | undefined,
  productId: string | undefined,
  detailById: Record<
    string,
    | {
        fifoAllocations: { batchId: string }[];
      }
    | { error: string }
  >,
  fallback: string,
): string {
  if (!adjId?.trim() || !productId?.trim()) return fallback;
  const det = detailById[adjId];
  if (!det || "error" in det || !det.fifoAllocations?.[0]?.batchId)
    return fallback;
  return `../batches?productId=${encodeURIComponent(productId.trim())}&focusBatchId=${encodeURIComponent(det.fifoAllocations[0].batchId)}`;
}

type AdjFifoParsed =
  | {
      fifoAllocations: {
        batchId: string;
        qty: number;
        unitCost: number;
        lineCost: number;
      }[];
      cogsAmount: number;
      avgUnitCost: number;
    }
  | { error: string };

function parseAdjustmentDocumentSnap(snap: DocumentSnapshot): AdjFifoParsed {
  if (!snap.exists()) {
    return { error: "No se encontró el ajuste en inventario." };
  }
  const d = snap.data() as Record<string, unknown>;
  const raw = Array.isArray(d.fifoAllocations)
    ? (d.fifoAllocations as unknown[])
    : [];
  const fifoAllocations = raw.map((x) => {
    const row = x as Record<string, unknown>;
    return {
      batchId: String(row.batchId ?? ""),
      qty: Number(row.qty ?? 0),
      unitCost: Number(row.unitCost ?? 0),
      lineCost: Number(row.lineCost ?? 0),
    };
  });
  return {
    fifoAllocations,
    cogsAmount: Number(d.cogsAmount ?? 0),
    avgUnitCost: Number(d.avgUnitCost ?? 0),
  };
}

type AdjType = "MERMA" | "ROBO";

export default function EvolutivoInventarioPollo({
  role,
  roles,
}: {
  role?: string;
  roles?: string[];
}): React.ReactElement {
  const [from, setFrom] = useState(monthStart());
  const [to, setTo] = useState(today());

  const [loading, setLoading] = useState(true);

  // Productos (solo stock > 0, lo trae el service o lo reforzamos)
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");

  /** Texto para filtrar la lista del select de producto (no sustituye al valor elegido). */
  const [productFilterQuery, setProductFilterQuery] = useState("");

  const selected = useMemo(
    () => products.find((p) => p.key === selectedKey) || null,
    [products, selectedKey],
  );

  // KPIs globales
  const [global, setGlobal] = useState({
    incomingLbs: 0,
    incomingUnits: 0,
    remainingLbs: 0,
    remainingUnits: 0,
  });

  // Evolutivo
  const [moves, setMoves] = useState<InvMove[]>([]);
  /** Saldo al inicio de `from` para cuadrar balance con stock en lotes. */
  const [openingBalance, setOpeningBalance] = useState(0);
  const [productKpis, setProductKpis] = useState<ProductKpis>({
    incoming: 0,
    soldCash: 0,
    soldCredit: 0,
    remaining: 0,
    measurement: "unidad",
  });

  // mapa saleId -> unit price calculado para el producto seleccionado
  const [salePrices, setSalePrices] = useState<Record<string, number>>({});

  // Manual movement form
  const [adjDate, setAdjDate] = useState(today());
  const [adjType, setAdjType] = useState<AdjType>("MERMA");
  const [adjSaving, setAdjSaving] = useState(false);
  const [adjQtyInput, setAdjQtyInput] = useState("");
  const [adjDesc, setAdjDesc] = useState("");
  const [adjModalOpen, setAdjModalOpen] = useState(false);

  const { refreshKey, refresh } = useManualRefresh();

  /** Vista principal: evolutivo por producto vs tabla por lotes */
  const [inventoryView, setInventoryView] = useState<"evolutivo" | "lotes">(
    "evolutivo",
  );

  const [lotGroups, setLotGroups] = useState<LotGroup[]>([]);
  const [lotSales, setLotSales] = useState<
    Array<{ id: string; data: Record<string, unknown> }>
  >([]);
  const [lotLoading, setLotLoading] = useState(false);
  const [lotFilterId, setLotFilterId] = useState("");
  /** Solo un lote expandido a la vez (null = ninguno) */
  const [expandedLotGroupId, setExpandedLotGroupId] = useState<string | null>(
    null,
  );
  const [lotDrawerGroup, setLotDrawerGroup] = useState<LotGroup | null>(null);
  /** Clave estable por producto dentro del lote (productId o nombre normalizado) */
  const [lotDrawerProductKey, setLotDrawerProductKey] = useState("");
  const [lotDrawerPay, setLotDrawerPay] = useState<"CASH" | "CREDITO">(
    "CASH",
  );

  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [priceFilter, setPriceFilter] = useState<string>("ALL");
  const [toastMsg, setToastMsg] = useState("");

  const [ingresoBatchId, setIngresoBatchId] = useState<string | null>(null);
  const [ingresoBatchRow, setIngresoBatchRow] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ingresoBatchLoading, setIngresoBatchLoading] = useState(false);

  /** MERMA/ROBO: drawer con detalle fifoAllocations / cogsAmount */
  const [mermaDrawerAdjId, setMermaDrawerAdjId] = useState<string | null>(null);
  const [adjBatchMetaById, setAdjBatchMetaById] = useState<
    Record<
      string,
      { orderName: string; productName: string; date: string }
    >
  >({});
  const [adjFifoDetailById, setAdjFifoDetailById] = useState<
    Record<
      string,
      | {
          fifoAllocations: {
            batchId: string;
            qty: number;
            unitCost: number;
            lineCost: number;
          }[];
          cogsAmount: number;
          avgUnitCost: number;
        }
      | { error: string }
    >
  >({});
  const [adjFifoLoadingId, setAdjFifoLoadingId] = useState<string | null>(null);

  const [saleDrawerOpen, setSaleDrawerOpen] = useState<{
    id: string;
    invType: InvMove["type"];
  } | null>(null);
  const [saleDrawerDoc, setSaleDrawerDoc] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [saleDrawerLoading, setSaleDrawerLoading] = useState(false);

  // =========================
  // 1) Cargar productos
  // =========================
  useEffect(() => {
    (async () => {
      try {
        const opts = await fetchInventoryProductOptionsPollo();

        // refuerzo: solo stock > 0
        const withStock = (opts || []).filter(
          (p: any) => Number((p as any).remaining || 0) > 0,
        );

        setProducts(withStock);

        // si el seleccionado ya no existe, limpia
        if (selectedKey && !withStock.some((o) => o.key === selectedKey)) {
          setSelectedKey("");
          setProductFilterQuery("");
        }
      } catch (e) {
        console.error("Error products inventory:", e);
        setProducts([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // =========================
  // 2) KPIs globales
  // =========================
  useEffect(() => {
    (async () => {
      try {
        const g = await fetchGlobalInventoryKpisPollo_debug(from, to);
        setGlobal(g);
      } catch (e) {
        console.error("Error global kpis:", e);
        setGlobal({
          incomingLbs: 0,
          incomingUnits: 0,
          remainingLbs: 0,
          remainingUnits: 0,
        });
      }
    })();
  }, [from, to, refreshKey]);

  // =========================
  // 3) Evolutivo por producto
  // =========================
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        if (inventoryView !== "evolutivo" || !selected) {
          setMoves([]);
          setOpeningBalance(0);
          setProductKpis({
            incoming: 0,
            soldCash: 0,
            soldCredit: 0,
            remaining: 0,
            measurement: "unidad",
          });
          setLoading(false);
          return;
        }

        // 🔥 CLAVE: pasar productId (tu service debe usarlo para inventory_batches)
        const res = await fetchProductEvolutionPollo({
          from,
          to,
          productKey: selected.key,
          productId: (selected as any).productId, // requerido
          productName: selected.productName,
          measurement: selected.measurement,
        });

        setMoves(res.moves);
        setOpeningBalance(Number(res.openingBalance ?? 0));
        setProductKpis(res.productKpis);

        // Precios de venta + FIFO merma en paralelo
        try {
          const saleIds = Array.from(
            new Set(
              (res.moves || [])
                .filter((m: any) => (m.type || "").startsWith("VENTA") && m.ref)
                .map((m: any) => String(m.ref)),
            ),
          );
          const mermaIds = Array.from(
            new Set(
              (res.moves || [])
                .filter(
                  (m) => (m.type === "MERMA" || m.type === "ROBO") && m.ref,
                )
                .map((m) => String(m.ref)),
            ),
          );

          const selName = (selected?.productName || "").toLowerCase();
          const selId = (selected as any)?.productId || "";

          const [pricesMap, adjPartial] = await Promise.all([
            (async () => {
              const pricesMap: Record<string, number> = {};
              await Promise.all(
                saleIds.map(async (sid) => {
                  try {
                    const sSnap = await getDoc(fsDoc(db, "salesV2", sid));
                    if (!sSnap.exists()) return;
                    const s = sSnap.data() as any;
                    let unitPrice: number | null = null;
                    if (Array.isArray(s.items) && s.items.length > 0) {
                      for (const it of s.items) {
                        const itPid = String(it.productId ?? "").trim();
                        const itName = String(it.productName ?? "").toLowerCase();
                        if (
                          (selId && itPid && itPid === selId) ||
                          itName === selName
                        ) {
                          unitPrice = Number(
                            it.unitPrice ?? it.price ?? it.regularPrice ?? 0,
                          );
                          break;
                        }
                      }
                    }
                    if (
                      (unitPrice === null || unitPrice === 0) &&
                      s.quantity &&
                      s.amount
                    ) {
                      const q = Number(s.quantity || 0);
                      const a = Number(s.amount || s.amountCharged || 0);
                      if (q > 0 && a) unitPrice = Number((a / q).toFixed(2));
                    }
                    pricesMap[sid] = unitPrice ?? 0;
                  } catch {
                    /* ignore */
                  }
                }),
              );
              return pricesMap;
            })(),
            (async () => {
              if (!mermaIds.length) return {} as Record<string, AdjFifoParsed>;
              const entries = await Promise.all(
                mermaIds.map(async (aid) => {
                  try {
                    const snap = await getDoc(
                      fsDoc(db, "inventory_adjustments_pollo", aid),
                    );
                    return [aid, parseAdjustmentDocumentSnap(snap)] as const;
                  } catch {
                    return [
                      aid,
                      { error: "No se pudo cargar el detalle FIFO." },
                    ] as const;
                  }
                }),
              );
              return Object.fromEntries(entries) as Record<string, AdjFifoParsed>;
            })(),
          ]);

          setSalePrices(pricesMap);
          if (Object.keys(adjPartial).length) {
            setAdjFifoDetailById((prev) => ({ ...prev, ...adjPartial }));
          }
        } catch {
          /* noop */
        }
      } catch (e) {
        console.error("Error product evolution:", e);
        setMoves([]);
        setOpeningBalance(0);
        setProductKpis({
          incoming: 0,
          soldCash: 0,
          soldCredit: 0,
          remaining: 0,
          measurement: selected?.measurement || "unidad",
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, selectedKey, refreshKey, selected, inventoryView]);

  // ——— Vista Lotes: grupos + ventas en rango ———
  useEffect(() => {
    if (inventoryView !== "lotes") return;
    let cancelled = false;
    setLotLoading(true);
    (async () => {
      try {
        const [groups, sales] = await Promise.all([
          fetchLotGroupsInRange(from, to),
          fetchSalesV2ForLotView(from, to),
        ]);
        if (!cancelled) {
          setLotGroups(groups);
          setLotSales(sales);
          setLotFilterId((prev) => {
            if (!prev) return "";
            return groups.some((g) => g.groupId === prev) ? prev : "";
          });
        }
      } catch (e) {
        console.error("Error vista lotes:", e);
        if (!cancelled) {
          setLotGroups([]);
          setLotSales([]);
        }
      } finally {
        if (!cancelled) setLotLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [inventoryView, from, to, refreshKey]);

  const unitLabel = selected?.measurement === "lb" ? "Lbs" : "Unidades";

  const soldCashPlusCredit = useMemo(() => {
    const a = Number(productKpis.soldCash ?? 0);
    const b = Number(productKpis.soldCredit ?? 0);
    return Number((a + b).toFixed(3));
  }, [productKpis.soldCash, productKpis.soldCredit]);

  const lotGroupsFilteredForTable = useMemo(() => {
    let list = lotGroups;
    if (lotFilterId) list = list.filter((g) => g.groupId === lotFilterId);
    if (selected) {
      const pk = selected.key;
      const pid = (selected as { productId?: string }).productId;
      const pn = selected.productName;
      list = list.filter((g) =>
        g.lines.some((ln) => lineMatchesProductFilter(ln, pk, pid, pn)),
      );
    }
    return list;
  }, [lotGroups, lotFilterId, selected]);

  const lotDrawerVisibleLines = useMemo(() => {
    if (!lotDrawerGroup) return [] as LotBatchLine[];
    let lines = lotDrawerGroup.lines;
    if (selected) {
      const pk = selected.key;
      const pid = (selected as { productId?: string }).productId;
      const pn = selected.productName;
      lines = lines.filter((ln) =>
        lineMatchesProductFilter(ln, pk, pid, pn),
      );
    }
    return lines;
  }, [lotDrawerGroup, selected]);

  const lotDrawerChipOptions = useMemo(() => {
    const m = new Map<string, string>();
    for (const l of lotDrawerVisibleLines) {
      const k = lotProductChipKeyFromLine(l);
      if (!m.has(k)) m.set(k, l.productName || k);
    }
    return Array.from(m.entries()).map(([value, label]) => ({
      value,
      label,
    }));
  }, [lotDrawerVisibleLines]);

  /** Ventas con remanente simulado por lote tras cada salida (orden cronológico). */
  const lotDrawerHitsProductEnriched = useMemo(() => {
    if (!lotDrawerGroup || !lotDrawerProductKey)
      return [] as {
        hit: LotSaleAllocHit;
        remainingAfterInLot: number;
      }[];
    const lines = lotDrawerVisibleLines.filter(
      (l) => lotProductChipKeyFromLine(l) === lotDrawerProductKey,
    );
    if (!lines.length) return [];
    const batchIds = new Set(lines.map((l) => l.id));
    const qtyRem = new Map<string, number>(
      lines.map((l) => [l.id, Number(l.quantity || 0)]),
    );
    const hits = collectLotSaleAllocHits(lotSales, batchIds);
    hits.sort((a, b) => {
      const d = a.saleDate.localeCompare(b.saleDate);
      if (d !== 0) return d;
      return a.saleId.localeCompare(b.saleId);
    });
    return hits.map((h) => {
      const bid = h.batchId;
      const before = qtyRem.get(bid) ?? 0;
      const after = Math.max(0, before - Number(h.allocQty));
      qtyRem.set(bid, after);
      return { hit: h, remainingAfterInLot: after };
    });
  }, [lotDrawerGroup, lotDrawerProductKey, lotDrawerVisibleLines, lotSales]);

  const lotDrawerHitsFilteredForDrawer = useMemo(
    () =>
      lotDrawerHitsProductEnriched.filter((x) =>
        lotDrawerPay === "CASH" ? x.hit.isCash : !x.hit.isCash,
      ),
    [lotDrawerHitsProductEnriched, lotDrawerPay],
  );

  const lotDrawerKpisLot = useMemo(() => {
    if (!lotDrawerGroup) return null;
    const lines = lotDrawerGroup.lines;
    const ingresado = lines.reduce((s, l) => s + Number(l.quantity || 0), 0);
    const factCost = lines.reduce(
      (s, l) => s + Number(l.invoiceTotal || 0),
      0,
    );
    const esperado = lines.reduce(
      (s, l) => s + Number(l.expectedTotal || 0),
      0,
    );
    const consumido = lines.reduce(
      (s, l) =>
        s + Math.max(0, Number(l.quantity || 0) - Number(l.remaining || 0)),
      0,
    );
    const restante = lines.reduce((s, l) => s + Number(l.remaining || 0), 0);
    const batchIdsAll = new Set(lines.map((l) => l.id));
    const hitsLot = collectLotSaleAllocHits(lotSales, batchIdsAll);
    const ubVentas = round2(
      hitsLot.reduce((s, h) => s + allocLineGross(h), 0),
    );
    const ubEsperadaIngreso = round2(
      lines.reduce(
        (s, l) =>
          s +
          (Number(l.expectedTotal || 0) - Number(l.invoiceTotal || 0)),
        0,
      ),
    );
    return {
      ingresado,
      factCost,
      esperado,
      consumido,
      restante,
      fecha: lotDrawerGroup.displayDate,
      ubVentas,
      ubEsperadaIngreso,
    };
  }, [lotDrawerGroup, lotSales]);

  const lotDrawerKpisProduct = useMemo(() => {
    if (!lotDrawerGroup || !lotDrawerProductKey) return null;
    const lines = lotDrawerVisibleLines.filter(
      (l) => lotProductChipKeyFromLine(l) === lotDrawerProductKey,
    );
    if (!lines.length) return null;
    const ingresado = lines.reduce((s, l) => s + Number(l.quantity || 0), 0);
    const factCost = lines.reduce(
      (s, l) => s + Number(l.invoiceTotal || 0),
      0,
    );
    const restante = lines.reduce((s, l) => s + Number(l.remaining || 0), 0);
    const batchIds = new Set(lines.map((l) => l.id));
    const hits = collectLotSaleAllocHits(lotSales, batchIds);
    let cashM = 0;
    let credM = 0;
    let cashQ = 0;
    let credQ = 0;
    for (const h of hits) {
      const amt = allocLineAmount(h);
      if (h.isCash) {
        cashM += amt;
        cashQ += h.allocQty;
      } else {
        credM += amt;
        credQ += h.allocQty;
      }
    }
    const u = lines[0]?.unit || "";
    const qtyLbl = isPolloLbMeasurement(u) ? "Libras" : "Unidades";
    const ubVentas = round2(hits.reduce((s, h) => s + allocLineGross(h), 0));
    const ubEsperadaIngreso = round2(
      lines.reduce(
        (s, l) =>
          s +
          (Number(l.expectedTotal || 0) - Number(l.invoiceTotal || 0)),
        0,
      ),
    );
    return {
      ingresado,
      factCost,
      ventasCashMonto: round2(cashM),
      ventasCredMonto: round2(credM),
      qtyCash: round2(cashQ),
      qtyCred: round2(credQ),
      restante,
      qtyLabel: qtyLbl,
      ubVentas,
      ubEsperadaIngreso,
    };
  }, [lotDrawerGroup, lotDrawerProductKey, lotDrawerVisibleLines, lotSales]);

  useEffect(() => {
    const sid = saleDrawerOpen?.id;
    if (!sid) {
      setSaleDrawerDoc(null);
      setSaleDrawerLoading(false);
      return;
    }
    let cancelled = false;
    setSaleDrawerLoading(true);
    setSaleDrawerDoc(null);
    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, "salesV2", sid));
        if (cancelled) return;
        setSaleDrawerDoc(
          snap.exists() ? (snap.data() as Record<string, unknown>) : null,
        );
      } catch {
        if (!cancelled) setSaleDrawerDoc(null);
      } finally {
        if (!cancelled) setSaleDrawerLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [saleDrawerOpen?.id]);

  const saleDrawerIsCredit = saleDrawerOpen?.invType === "VENTA_CREDITO";

  const saleDrawerLines = useMemo(() => {
    const sid = saleDrawerOpen?.id;
    if (!sid || !saleDrawerDoc || !selected) return [];
    return buildSaleDrawerLinesForProduct(
      sid,
      saleDrawerDoc,
      selected.key,
      (selected as { productId?: string }).productId,
      selected.productName,
    );
  }, [saleDrawerOpen?.id, saleDrawerDoc, selected]);

  const saleDrawerKpis = useMemo(
    () => aggregateSaleDrawerLines(saleDrawerLines),
    [saleDrawerLines],
  );

  const saleDrawerCustomer = useMemo(() => {
    if (!saleDrawerDoc) return "—";
    const c = String(
      saleDrawerDoc.customerName || saleDrawerDoc.clientName || "",
    ).trim();
    return c || "—";
  }, [saleDrawerDoc]);

  useEffect(() => {
    if (!ingresoBatchId) {
      setIngresoBatchRow(null);
      setIngresoBatchLoading(false);
      return;
    }
    let cancelled = false;
    setIngresoBatchLoading(true);
    setIngresoBatchRow(null);
    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, "inventory_batches", ingresoBatchId));
        if (cancelled) return;
        setIngresoBatchRow(snap.exists() ? snap.data() : null);
      } catch {
        if (!cancelled) setIngresoBatchRow(null);
      } finally {
        if (!cancelled) setIngresoBatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingresoBatchId]);

  useEffect(() => {
    if (!mermaDrawerAdjId) return;
    const id = mermaDrawerAdjId;
    if (adjFifoDetailById[id] !== undefined) return;

    let cancelled = false;
    setAdjFifoLoadingId(id);
    (async () => {
      try {
        const snap = await getDoc(
          fsDoc(db, "inventory_adjustments_pollo", id),
        );
        if (cancelled) return;
        const parsed = parseAdjustmentDocumentSnap(snap);
        setAdjFifoDetailById((prev) => ({ ...prev, [id]: parsed }));
      } catch {
        if (!cancelled) {
          setAdjFifoDetailById((prev) => ({
            ...prev,
            [id]: { error: "No se pudo cargar el detalle FIFO." },
          }));
        }
      } finally {
        if (!cancelled) setAdjFifoLoadingId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaDrawerAdjId, adjFifoDetailById]);

  useEffect(() => {
    if (!mermaDrawerAdjId) return;
    const det = adjFifoDetailById[mermaDrawerAdjId];
    if (!det || "error" in det) return;
    const ids = [
      ...new Set(
        det.fifoAllocations.map((a) => a.batchId).filter(Boolean),
      ),
    ];
    let cancelled = false;
    (async () => {
      const entries = await Promise.all(
        ids.map(async (bid) => {
          try {
            const s = await getDoc(fsDoc(db, "inventory_batches", bid));
            if (!s.exists()) {
              return [
                bid,
                { orderName: "—", productName: "—", date: "—" },
              ] as const;
            }
            const d = s.data() as Record<string, unknown>;
            return [
              bid,
              {
                orderName: String(d.orderName ?? "").trim() || "—",
                productName: String(d.productName ?? "").trim() || "—",
                date: String(d.date ?? "").trim() || "—",
              },
            ] as const;
          } catch {
            return [
              bid,
              { orderName: "—", productName: "—", date: "—" },
            ] as const;
          }
        }),
      );
      const next = Object.fromEntries(entries) as Record<
        string,
        { orderName: string; productName: string; date: string }
      >;
      if (!cancelled) {
        setAdjBatchMetaById((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaDrawerAdjId, adjFifoDetailById]);

  // Balance: saldo al inicio de `from` + movimientos listados (coincide con lotes si no hay movimientos después de `to`)
  const movesWithBalance = useMemo(() => {
    let bal = Number(openingBalance ?? 0);
    return (moves || []).map((m) => {
      bal += Number(m.qtyIn || 0) - Number(m.qtyOut || 0);
      return { ...m, balance: bal };
    });
  }, [moves, openingBalance]);

  const rowPriceAndMonto = (m: InvMove) => {
    const ref = String(m.ref || "");
    if (
      (m.type === "MERMA" || m.type === "ROBO") &&
      ref &&
      adjFifoDetailById[ref] &&
      !("error" in adjFifoDetailById[ref])
    ) {
      const det = adjFifoDetailById[ref] as {
        avgUnitCost: number;
        cogsAmount: number;
      };
      const q = Number(m.qtyOut || 0);
      const unit = Number(det.avgUnitCost || 0);
      const cog = Number(det.cogsAmount || 0);
      const monto = cog > 0 ? cog : unit * q;
      return { price: unit, monto };
    }
    const p = Number(salePrices[ref] ?? 0);
    return { price: p, monto: p * Number(m.qtyOut || 0) };
  };

  // (no price highlighting) — prices will be shown as currency in UI
  // filtered moves by Tipo y Precio
  const filteredMoves = useMemo(() => {
    if (!movesWithBalance || movesWithBalance.length === 0)
      return [] as typeof movesWithBalance;
    if (typeFilter === "ALL") return movesWithBalance;
    return movesWithBalance.filter((mm) => (mm.type || "") === typeFilter);
  }, [movesWithBalance, typeFilter]);

  const availablePrices = useMemo(() => {
    const s = new Set<string>();
    for (const m of filteredMoves) {
      const { price } = rowPriceAndMonto(m as InvMove);
      s.add(`C$ ${price.toFixed(2)}`);
    }
    return Array.from(s).sort(
      (a, b) =>
        Number(b.replace(/[^0-9.-]+/g, "")) -
        Number(a.replace(/[^0-9.-]+/g, "")),
    );
  }, [filteredMoves, salePrices, adjFifoDetailById]);

  const typeFilterSelectOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      { value: "INGRESO", label: "INGRESO" },
      { value: "VENTA_CASH", label: "VENTA_CASH" },
      { value: "VENTA_CREDITO", label: "VENTA_CREDITO" },
      { value: "MERMA", label: "MERMA" },
      { value: "ROBO", label: "ROBO" },
    ],
    [],
  );

  const priceFilterSelectOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      ...availablePrices.map((p) => ({ value: p, label: p })),
    ],
    [availablePrices],
  );

  const adjTypeSelectOptions = useMemo(
    () => [
      { value: "MERMA", label: "Merma por peso" },
      { value: "ROBO", label: "Pérdida/Robo" },
    ],
    [],
  );

  const displayedMoves = useMemo(() => {
    if (!filteredMoves || filteredMoves.length === 0)
      return [] as typeof filteredMoves;
    if (!priceFilter || priceFilter === "ALL") return filteredMoves;
    return filteredMoves.filter((m) => {
      const { price } = rowPriceAndMonto(m as InvMove);
      return `C$ ${price.toFixed(2)}` === priceFilter;
    });
  }, [filteredMoves, priceFilter, salePrices, adjFifoDetailById]);

  const handleExportExcel = () => {
    const rows = (displayedMoves || []).map((m) => {
      const { price, monto } = rowPriceAndMonto(m as InvMove);
      return {
        Fecha: m.date || "",
        Tipo: m.type || "",
        Descripción: m.description || "",
        Ref: m.ref || "",
        Entrada: Number(m.qtyIn || 0),
        Salida: Number(m.qtyOut || 0),
        Precio: `C$ ${price.toFixed(2)}`,
        Monto: `C$ ${monto.toFixed(2)}`,
        Balance: Number((m as any).balance || 0),
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        "Fecha",
        "Tipo",
        "Descripción",
        "Ref",
        "Entrada",
        "Salida",
        "Precio",
        "Monto",
        "Balance",
      ],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Movimientos");

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (selected?.productName || "evolutivo").replace(
      /[^a-z0-9]/gi,
      "_",
    );
    a.download = `${safeName}_movimientos_${from}_${to}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const openLotConsumidoDrawer = (g: LotGroup) => {
    setLotDrawerGroup(g);
    const vis = selected
      ? g.lines.filter((ln) =>
          lineMatchesProductFilter(
            ln,
            selected.key,
            (selected as { productId?: string }).productId,
            selected.productName,
          ),
        )
      : g.lines.slice();
    const keys = [...new Set(vis.map(lotProductChipKeyFromLine))];
    setLotDrawerProductKey(keys[0] || "");
    setLotDrawerPay("CASH");
  };

  // ================
  // Dropdown helpers
  // ================
  const norm = (s: string) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

  const filteredProductSelectOptions = useMemo(() => {
    const q = norm(productFilterQuery);
    const rows = products
      .filter((p: any) => {
        if (selectedKey && p.key === selectedKey) return true;
        if (!q) return true;
        const name = norm(p.productName || "");
        const key = norm(p.key || "");
        return name.includes(q) || key.includes(q);
      })
      .map((p: any) => ({
        value: p.key,
        label: `${p.productName} — ${
          p.measurement === "lb" ? "Lbs" : "Unid"
        } · stock ${qty3((p as any).remaining)}`,
      }));
    return [
      { value: "", label: "— Elegir producto —" },
      ...rows,
    ];
  }, [products, productFilterQuery, selectedKey]);

  const lotFilterSelectOptions = useMemo(() => {
    const opts = lotGroups.map((g) => ({
      value: g.groupId,
      label: `${g.orderName} · ${g.displayDate}${
        g.lines.length > 1 ? ` (${g.lines.length} prod.)` : ""
      }`,
    }));
    return [
      { value: "", label: "Todos los lotes (rango de fechas)" },
      ...opts,
    ];
  }, [lotGroups]);

  const inventoryBatchesHref = useMemo(() => {
    const pid = selected?.productId?.trim();
    return pid
      ? `../batches?productId=${encodeURIComponent(pid)}`
      : "../batches";
  }, [selected]);

  const mermaDrawerTitle = useMemo(() => {
    if (!mermaDrawerAdjId) return "";
    const mm = (moves || []).find((x) => x.ref === mermaDrawerAdjId);
    return mm
      ? `${mm.type} · ${mm.date}`
      : "Merma / pérdida";
  }, [mermaDrawerAdjId, moves]);

  const mermaDrawerBatchesHref = useMemo(() => {
    const pid = selected?.productId?.trim();
    if (!pid || !mermaDrawerAdjId) return inventoryBatchesHref;
    const det = adjFifoDetailById[mermaDrawerAdjId];
    if (!det || "error" in det || !det.fifoAllocations.length) {
      return `../batches?productId=${encodeURIComponent(pid)}`;
    }
    const bid = det.fifoAllocations[0].batchId;
    return `../batches?productId=${encodeURIComponent(pid)}&focusBatchId=${encodeURIComponent(bid)}`;
  }, [
    selected,
    mermaDrawerAdjId,
    adjFifoDetailById,
    inventoryBatchesHref,
  ]);

  // =========================
  // Guardar ajuste: descuenta lotes por FIFO (igual que venta) + registro
  // =========================
  const saveAdjustment = async (): Promise<boolean> => {
    if (!selected) {
      setToastMsg("⚠️ Seleccioná un producto primero.");
      return false;
    }

    const q = Number(String(adjQtyInput || "").replace(",", "."));
    if (!Number.isFinite(q) || q <= 0) {
      setToastMsg("⚠️ Ingresá una cantidad mayor a 0.");
      return false;
    }
    if (!adjDate) {
      setToastMsg("⚠️ Seleccioná fecha.");
      return false;
    }

    const user = auth.currentUser;
    setAdjSaving(true);
    try {
      const alloc = await allocateFIFOAndUpdateBatches(
        db,
        selected.productName,
        q,
        false,
      );

      await addDoc(collection(db, "inventory_adjustments_pollo"), {
        date: adjDate,
        type: adjType,
        qty: q,
        productKey: selected.key,
        productId: (selected as any).productId ?? null,
        productName: selected.productName,
        measurement: selected.measurement,
        description: adjDesc?.trim() || null,
        createdAt: serverTimestamp(),
        createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
        periodFrom: from,
        periodTo: to,
        fifoAllocations: alloc.allocations,
        cogsAmount: alloc.cogsAmount,
        avgUnitCost: alloc.avgUnitCost,
      });

      setAdjQtyInput("");
      setAdjDesc("");
      refresh();
      setToastMsg(
        `✅ Merma aplicada. Valor a costo retirado: C$ ${Number(alloc.cogsAmount || 0).toFixed(2)} (ver lotes en Inventario).`,
      );
      return true;
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "No se pudo aplicar el ajuste (¿stock insuficiente?).";
      setToastMsg(`❌ ${msg}`);
      return false;
    } finally {
      setAdjSaving(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">
          Evolutivo Inventario (Pollo)
        </h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <button
            type="button"
            onClick={() => setInventoryView("evolutivo")}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
              inventoryView === "evolutivo"
                ? "border-sky-500 bg-sky-100 text-sky-900"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Evolutivo
          </button>
          <button
            type="button"
            onClick={() => setInventoryView("lotes")}
            className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide transition-colors ${
              inventoryView === "lotes"
                ? "border-violet-500 bg-violet-100 text-violet-900"
                : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
            }`}
          >
            Lotes
          </button>
          <RefreshButton
            onClick={refresh}
            loading={inventoryView === "lotes" ? lotLoading : loading}
          />
        </div>
      </div>

      {/* rango */}
      {/* Mobile: fecha dentro de card */}
      <div className="sm:hidden mb-3">
        <div className="border rounded-2xl p-3 bg-white">
          <div className="text-xs text-gray-500 mb-2">Rango de fechas</div>
          <div className="grid grid-cols-1 gap-2">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Desde</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Hasta</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs globales */}
      {/* Mobile: KPIs inside a card */}
      <div className="sm:hidden mb-4">
        <div className="border rounded-2xl p-3 bg-white space-y-2">
          <div className="text-xs text-gray-500">KPIs</div>
          <div className="grid grid-cols-2 gap-2">
            <KpiCard
              tone="sky"
              title="Ingresado (Lbs)"
              value={qty3(global.incomingLbs)}
            />
            <KpiCard
              tone="slate"
              title="Ingresado (Unid)"
              value={qty3(global.incomingUnits)}
            />
            <KpiCard
              tone="emerald"
              title="Existente (Lbs)"
              value={qty3(global.remainingLbs)}
            />
            <KpiCard
              tone="violet"
              title="Existente (Unid)"
              value={qty3(global.remainingUnits)}
            />
          </div>
        </div>
      </div>

      {/* Desktop KPIs */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <KpiCard
          tone="sky"
          title="Ingresado (Lbs) en rango"
          value={qty3(global.incomingLbs)}
        />
        <KpiCard
          tone="slate"
          title="Ingresado (Unidades) en rango"
          value={qty3(global.incomingUnits)}
        />
        <KpiCard
          tone="emerald"
          title="Existente (Lbs) general"
          value={qty3(global.remainingLbs)}
        />
        <KpiCard
          tone="violet"
          title="Existente (Unidades) general"
          value={qty3(global.remainingUnits)}
        />
      </div>

      {/* selector obligatorio */}
      {/* Mobile: producto + filtros + tabla inside a card */}
      <div className="sm:hidden mb-4">
        <div className="border rounded-2xl p-2 bg-white space-y-2">
          <div className="space-y-2">
            <div className="text-xs text-gray-500 mb-1">
              Producto (solo con stock)
            </div>
            <input
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-full min-w-0 shadow-sm"
              placeholder="Buscar para filtrar lista…"
              value={productFilterQuery}
              onChange={(e) => setProductFilterQuery(e.target.value)}
            />
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <MobileHtmlSelect
                  value={selectedKey}
                  onChange={(v) => {
                    setSelectedKey(v);
                    setProductFilterQuery("");
                  }}
                  options={filteredProductSelectOptions}
                  sheetTitle="Producto"
                  triggerIcon="menu"
                  selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                  buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                />
              </div>
              {selectedKey ? (
                <Button
                  type="button"
                  aria-label="Limpiar producto"
                  title="Limpiar producto"
                  onClick={() => {
                    setSelectedKey("");
                    setProductFilterQuery("");
                  }}
                  variant="secondary"
                  size="sm"
                  className="!rounded-xl shrink-0 flex items-center justify-center !px-2 !py-2 hover:!bg-gray-200"
                >
                  <span>🧹</span>
                </Button>
              ) : null}
            </div>

            {selected ? (
              <>
                <div className="mt-2 border rounded p-2">
                  <div className="text-xs text-gray-500">Seleccionado</div>
                  <div className="font-semibold">{selected.productName}</div>
                  <div className="text-xs text-gray-500">
                    Medida:{" "}
                    <b>{selected.measurement === "lb" ? "Lbs" : "Unidades"}</b>{" "}
                    • Stock: <b>{qty3((selected as any).remaining)}</b>
                  </div>
                </div>

                {/* Product KPIs (mobile) */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <KpiCard
                    tone="sky"
                    title={`${unitLabel} ingresadas (rango)`}
                    value={qty3(productKpis.incoming)}
                  />
                  <KpiCard
                    tone="amber"
                    title={`${unitLabel} vendidas Cash`}
                    value={qty3(productKpis.soldCash)}
                  />
                  <KpiCard
                    tone="violet"
                    title={`${unitLabel} vendidas Crédito`}
                    value={qty3(productKpis.soldCredit)}
                  />
                  <KpiCard
                    tone="indigo"
                    title={`${unitLabel} vendidas (cash + crédito)`}
                    value={qty3(soldCashPlusCredit)}
                  />
                  <div className="col-span-2">
                    <KpiCard
                      tone="emerald"
                      title={`${unitLabel} existentes`}
                      value={qty3(productKpis.remaining)}
                    />
                  </div>
                </div>

                {inventoryView === "evolutivo" ? (
                  <p className="text-[11px] text-slate-600 mt-2 leading-snug">
                    Saldo al <span className="font-mono">{from}</span> (base del
                    balance):{" "}
                    <span className="font-semibold tabular-nums">
                      {qty3(openingBalance)}
                    </span>{" "}
                    {unitLabel}
                    <span className="block mt-0.5 text-slate-500">
                      El último balance = existencias en lotes solo si no hay
                      ventas/mermas después de{" "}
                      <span className="font-mono">{to}</span>.
                    </span>
                  </p>
                ) : null}
              </>
            ) : null}
          </div>

          {inventoryView === "lotes" ? (
            <div className="pt-2 border-t border-slate-100 space-y-1">
              <div className="text-xs text-gray-500">
                Lote (ingresado en el rango)
              </div>
              <MobileHtmlSelect
                value={lotFilterId}
                onChange={setLotFilterId}
                options={lotFilterSelectOptions}
                sheetTitle="Lote"
                triggerIcon="menu"
                selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
              />
            </div>
          ) : null}

          {inventoryView === "evolutivo" ? (
            <>
              <div className="flex items-center gap-2">
                <Button
                  type="button"
                  onClick={() => setAdjModalOpen(true)}
                  variant="primary"
                  className="!rounded-lg text-sm sm:text-base"
                  disabled={!selectedKey}
                >
                  Crear Movimiento
                </Button>
                <Button
                  type="button"
                  onClick={handleExportExcel}
                  variant="primary"
                  className="!bg-green-600 hover:!bg-green-700 !text-white !rounded-lg text-sm sm:text-base"
                  disabled={!selectedKey}
                >
                  Exportar Excel
                </Button>
              </div>

              <div className="grid grid-cols-2 gap-2 w-full items-end">
                <MobileHtmlSelect
                  label="Tipo"
                  value={typeFilter}
                  onChange={setTypeFilter}
                  options={typeFilterSelectOptions}
                  sheetTitle="Filtrar por tipo"
                  triggerIcon="menu"
                  selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                  buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                />
                <MobileHtmlSelect
                  label="Precio"
                  value={priceFilter}
                  onChange={setPriceFilter}
                  options={priceFilterSelectOptions}
                  sheetTitle="Filtrar por precio"
                  triggerIcon="menu"
                  selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                  buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                />
              </div>

              {/* Mobile: listado como cards */}
              <div className="space-y-2">
                {displayedMoves && displayedMoves.length === 0 ? (
                  <div className="text-sm text-gray-500">
                    No hay movimientos en el rango para este producto.
                  </div>
                ) : (
                  (displayedMoves || []).map((m, idx) => {
                const { price, monto } = rowPriceAndMonto(m as InvMove);
                const openIngreso =
                  m.type === "INGRESO" && m.ref
                    ? () => setIngresoBatchId(String(m.ref))
                    : undefined;
                const openMerma =
                  (m.type === "MERMA" || m.type === "ROBO") && m.ref
                    ? () => setMermaDrawerAdjId(String(m.ref))
                    : undefined;
                const openVenta =
                  (m.type === "VENTA_CASH" || m.type === "VENTA_CREDITO") &&
                  m.ref
                    ? () =>
                        setSaleDrawerOpen({
                          id: String(m.ref),
                          invType: m.type as InvMove["type"],
                        })
                    : undefined;
                const cardInteractive = !!(openIngreso || openMerma || openVenta);
                const handleCardActivate = () => {
                  if (openIngreso) openIngreso();
                  else if (openMerma) openMerma();
                  else if (openVenta) openVenta();
                };
                return (
                  <div
                    key={`${m.ref || idx}-${m.date}`}
                    role={cardInteractive ? "button" : undefined}
                    tabIndex={cardInteractive ? 0 : undefined}
                    onClick={cardInteractive ? handleCardActivate : undefined}
                    onKeyDown={
                      cardInteractive
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleCardActivate();
                            }
                          }
                        : undefined
                    }
                    className={`border rounded p-2 bg-white text-sm ${
                      openIngreso
                        ? "cursor-pointer hover:border-sky-300 hover:bg-sky-50/40"
                        : openMerma
                          ? "cursor-pointer hover:border-rose-200 hover:bg-rose-50/30"
                          : openVenta
                            ? "cursor-pointer hover:border-amber-200 hover:bg-amber-50/35"
                            : ""
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-[11px] text-gray-500">{m.date}</div>
                      <PolloChip variant={tipoMoveChipVariant(String(m.type))}>
                        {m.type}
                      </PolloChip>
                    </div>
                    <div className="mt-1 text-sm text-gray-700">
                      {m.description}
                    </div>
                    <div className="mt-1 grid grid-cols-3 gap-1 text-sm">
                      <div>
                        <div className="text-[11px] text-gray-500">Entrada</div>
                        <div className="font-medium">{qty3(m.qtyIn)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-500">Salida</div>
                        <div className="font-medium">{qty3(m.qtyOut)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-500">Balance</div>
                        <div className="font-medium">
                          {qty3((m as any).balance)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-1 flex justify-between items-center text-sm">
                      <div className="font-semibold text-black">
                        Precio: C${" "}
                        {m.type === "MERMA" || m.type === "ROBO"
                          ? price.toFixed(4)
                          : price.toFixed(2)}
                      </div>
                      <div className="font-semibold text-black">
                        Monto: C$ {monto.toFixed(2)}
                      </div>
                    </div>
                    {(m.type === "MERMA" || m.type === "ROBO") &&
                    selected &&
                    m.ref ? (
                      <div
                        className="mt-2 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-[11px] text-rose-700/90">
                          Tocá la tarjeta para ver el detalle FIFO (drawer).
                        </p>
                        <Link
                          to={batchesHrefForMermaAdj(
                            String(m.ref),
                            (selected as { productId?: string }).productId,
                            adjFifoDetailById,
                            inventoryBatchesHref,
                          )}
                          className="inline-flex items-center rounded-full border border-green-600 bg-green-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-green-800 hover:bg-green-100"
                        >
                          Ver lotes (inventario)
                        </Link>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
            </>
          ) : inventoryView === "lotes" ? (
            <div className="space-y-2">
              {lotLoading ? (
                <div className="text-sm text-gray-500">Cargando lotes…</div>
              ) : lotGroupsFilteredForTable.length === 0 ? (
                <div className="text-sm text-gray-500">
                  No hay lotes ingresados en este rango
                  {selected ? " para el producto elegido" : ""}.
                </div>
              ) : (
                lotGroupsFilteredForTable.map((g) => {
                  const pk = selected?.key || "";
                  const pid = (selected as { productId?: string })?.productId;
                  const pn = selected?.productName;
                  const vis = selected
                    ? g.lines.filter((ln) =>
                        lineMatchesProductFilter(ln, pk, pid, pn),
                      )
                    : g.lines.slice();
                  const inicial = vis.reduce(
                    (s, l) => s + Number(l.quantity || 0),
                    0,
                  );
                  const consumido = vis.reduce(
                    (s, l) =>
                      s +
                      Math.max(
                        0,
                        Number(l.quantity || 0) -
                          Number(l.remaining || 0),
                      ),
                    0,
                  );
                  const batchIds = new Set(vis.map((l) => l.id));
                  const hitsAll = collectLotSaleAllocHits(lotSales, batchIds);
                  const expandedDailyRows = buildLotExpandedDailyRows(
                    vis,
                    hitsAll,
                  );
                  const restanteVis = vis.reduce(
                    (s, l) => s + Number(l.remaining || 0),
                    0,
                  );
                  const ubVentasCard = round2(
                    hitsAll.reduce((s, h) => s + allocLineGross(h), 0),
                  );
                  const expanded = expandedLotGroupId === g.groupId;
                  const names = [
                    ...new Set(
                      vis.map((l) => l.productName || "").filter(Boolean),
                    ),
                  ];
                  return (
                    <div
                      key={g.groupId}
                      className={`rounded-xl border p-3 bg-white text-sm shadow-sm space-y-2 transition-shadow ${
                        expanded
                          ? "border-violet-300 ring-1 ring-violet-200"
                          : "border-gray-200 hover:border-gray-300"
                      }`}
                    >
                      <div className="flex justify-between gap-2 items-start">
                        <div>
                          <div className="text-[11px] text-gray-500">
                            {g.displayDate}
                          </div>
                          <div className="font-semibold">{g.orderName}</div>
                          <div className="text-xs text-gray-600 mt-0.5">
                            {names.join(" · ") || "—"}
                          </div>
                        </div>
                        <button
                          type="button"
                          className="text-xs font-semibold text-amber-800 underline shrink-0"
                          onClick={() => openLotConsumidoDrawer(g)}
                        >
                          Cons.: {qty3(consumido)}
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1.5 text-xs">
                        <div>
                          <span className="text-gray-500">Inicial</span>{" "}
                          <span className="font-medium tabular-nums">
                            {qty3(inicial)}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Restante</span>{" "}
                          <span className="font-medium tabular-nums text-emerald-900">
                            {qty3(restanteVis)}
                          </span>
                        </div>
                        <div>
                          <span className="text-gray-500">Consumido</span>{" "}
                          <button
                            type="button"
                            className="font-medium tabular-nums text-amber-900 underline"
                            onClick={() => openLotConsumidoDrawer(g)}
                          >
                            {qty3(consumido)}
                          </button>
                        </div>
                        <div className="text-right">
                          <span className="text-gray-500 block text-[10px]">
                            U.B. ventas
                          </span>
                          <span className="font-semibold tabular-nums text-violet-900">
                            {moneyFmt(ubVentasCard)}
                          </span>
                        </div>
                      </div>
                      <button
                        type="button"
                        className="w-full text-left text-[11px] text-violet-800 font-medium flex justify-between items-center border border-violet-100 rounded-lg px-2 py-1 bg-violet-50/50"
                        onClick={() =>
                          setExpandedLotGroupId((cur) =>
                            cur === g.groupId ? null : g.groupId,
                          )
                        }
                      >
                        <span>Evolutivo por día</span>
                        <span>{expanded ? "▼" : "▶"}</span>
                      </button>
                      {expanded ? (
                        <div className="mt-1 w-full min-w-0 -mx-0.5">
                          <LotExpandedDailySubtable
                            rows={expandedDailyRows}
                            compact
                          />
                        </div>
                      ) : null}
                    </div>
                  );
                })
              )}
            </div>
          ) : null}
        </div>
      </div>

      {/* Desktop: producto + resumen */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div className="space-y-2 min-w-0">
          <label className="block text-sm text-gray-600 mb-1">
            Producto (solo con stock)
          </label>
          <input
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-full min-w-0 shadow-sm"
            placeholder="Buscar para filtrar lista…"
            value={productFilterQuery}
            onChange={(e) => setProductFilterQuery(e.target.value)}
          />
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <MobileHtmlSelect
                value={selectedKey}
                onChange={(v) => {
                  setSelectedKey(v);
                  setProductFilterQuery("");
                }}
                options={filteredProductSelectOptions}
                sheetTitle="Producto"
                triggerIcon="menu"
                selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
              />
            </div>
            {selectedKey ? (
              <Button
                type="button"
                aria-label="Limpiar producto"
                title="Limpiar producto"
                onClick={() => {
                  setSelectedKey("");
                  setProductFilterQuery("");
                }}
                variant="secondary"
                size="sm"
                className="!rounded-xl shrink-0 !px-3 !py-2"
              >
                Limpiar
              </Button>
            ) : null}
          </div>

          {!selectedKey ? (
            inventoryView === "evolutivo" ? (
              <div className="mt-1 text-xs text-red-600">
                Debés seleccionar un producto para ver el evolutivo.
              </div>
            ) : (
              <div className="mt-1 text-xs text-slate-500">
                Producto opcional: si elegís uno, la tabla solo muestra ese
                producto por lote.
              </div>
            )
          ) : null}
        </div>

        <div className="text-sm text-gray-700 flex items-end">
          {selected ? (
            <Button
              type="button"
              onClick={() => {
                setSelectedKey("");
                setProductFilterQuery("");
              }}
              variant="outline"
              className="w-full !rounded-xl bg-white p-3 text-left !justify-start font-normal"
            >
              <div className="text-xs text-gray-500">
                Seleccionado (clic para limpiar)
              </div>
              <div className="font-semibold">{selected.productName}</div>
              <div className="text-xs text-gray-500">
                Medida:{" "}
                <b>{selected.measurement === "lb" ? "Lbs" : "Unidades"}</b> •
                Stock actual: <b>{qty3((selected as any).remaining)}</b>
              </div>
            </Button>
          ) : (
            <div className="w-full text-gray-500">
              {inventoryView === "evolutivo"
                ? "Para ver el evolutivo tenés que seleccionar un producto."
                : "Podés filtrar por producto o ver todos los productos por lote."}
            </div>
          )}
        </div>
      </div>

      {inventoryView === "lotes" ? (
        <div className="hidden sm:block mb-4 max-w-xl">
          <label className="block text-sm text-gray-600 mb-1">
            Lote (ingresado en el rango de fechas)
          </label>
          <MobileHtmlSelect
            value={lotFilterId}
            onChange={setLotFilterId}
            options={lotFilterSelectOptions}
            sheetTitle="Lote"
            triggerIcon="menu"
            selectClassName={POLLO_SELECT_DESKTOP_CLASS}
            buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
          />
        </div>
      ) : null}

      {/* KPIs por producto */}
      {selected && (
        <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <KpiCard
            tone="sky"
            title={`${unitLabel} ingresadas (rango)`}
            value={qty3(productKpis.incoming)}
          />
          <KpiCard
            tone="amber"
            title={`${unitLabel} vendidas Cash (rango)`}
            value={qty3(productKpis.soldCash)}
          />
          <KpiCard
            tone="violet"
            title={`${unitLabel} vendidas Crédito (rango)`}
            value={qty3(productKpis.soldCredit)}
          />
          <KpiCard
            tone="indigo"
            title={`${unitLabel} vendidas (cash + crédito)`}
            value={qty3(soldCashPlusCredit)}
          />
          <KpiCard
            tone="emerald"
            title={`${unitLabel} existentes (stock actual)`}
            value={qty3(productKpis.remaining)}
          />
        </div>
      )}

      {/* movimientos manuales (botón + modal) */}
      {selected && inventoryView === "evolutivo" && (
        <>
          <div className="mb-4 hidden sm:flex gap-2 items-center">
            <Button
              type="button"
              onClick={() => setAdjModalOpen(true)}
              variant="primary"
              className="!rounded-lg text-sm sm:text-base"
            >
              Crear Movimiento
            </Button>

            <Button
              type="button"
              onClick={handleExportExcel}
              variant="primary"
              className="!bg-green-600 hover:!bg-green-700 !text-white !rounded-lg text-sm sm:text-base"
            >
              Exportar Excel
            </Button>

            <div className="grid grid-cols-2 gap-2 ml-0 sm:ml-2 min-w-0 w-full max-w-md shrink-0">
              <MobileHtmlSelect
                label="Tipo"
                value={typeFilter}
                onChange={setTypeFilter}
                options={typeFilterSelectOptions}
                sheetTitle="Filtrar por tipo"
                triggerIcon="menu"
                selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} min-w-0 w-full`}
                buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} min-w-0 w-full`}
              />

              <MobileHtmlSelect
                label="Precio"
                value={priceFilter}
                onChange={setPriceFilter}
                options={priceFilterSelectOptions}
                sheetTitle="Filtrar por precio"
                triggerIcon="menu"
                selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} min-w-0 w-full`}
                buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} min-w-0 w-full`}
              />
            </div>
          </div>

          {adjModalOpen && (
            <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
              <div
                className="absolute inset-0 bg-black opacity-40"
                onClick={() => setAdjModalOpen(false)}
              />

              <div className="relative bg-white rounded-t-2xl sm:rounded-2xl p-3 sm:p-4 z-10 w-full max-w-2xl h-[85vh] sm:h-auto shadow-lg overflow-auto text-sm">
                <div className="font-semibold mb-3">Crear Movimiento</div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Fecha
                    </label>
                    <input
                      type="date"
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjDate}
                      onChange={(e) => setAdjDate(e.target.value)}
                    />
                  </div>

                  <div>
                    <MobileHtmlSelect
                      label="Tipo"
                      value={adjType}
                      onChange={(v) => setAdjType(v as AdjType)}
                      options={adjTypeSelectOptions}
                      sheetTitle="Tipo de ajuste"
                      triggerIcon="menu"
                      selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                      buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Cantidad ({unitLabel})
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      className="border rounded px-3 py-2 w-full text-sm tabular-nums"
                      value={adjQtyInput}
                      onChange={(e) => {
                        const v = e.target.value.replace(/,/g, ".");
                        if (v === "" || /^\d*\.?\d*$/.test(v))
                          setAdjQtyInput(v);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === ",") e.preventDefault();
                      }}
                      placeholder="0"
                    />
                  </div>

                  <div className="flex items-end">
                    <Button
                      type="button"
                      disabled={adjSaving}
                      onClick={async () => {
                        const ok = await saveAdjustment();
                        if (ok) setAdjModalOpen(false);
                      }}
                      variant="primary"
                      className="w-full !rounded-lg text-sm"
                    >
                      {adjSaving ? "Aplicando…" : "Guardar"}
                    </Button>
                  </div>

                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="block text-sm text-gray-600 mb-1">
                      Descripción
                    </label>
                    <input
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjDesc}
                      onChange={(e) => setAdjDesc(e.target.value)}
                      placeholder="Ej: se dañó por temperatura / pérdida en traslado..."
                    />
                  </div>
                </div>

                <p className="mt-3 text-xs text-slate-600 leading-relaxed">
                  Al guardar se <strong>descuenta el stock en los lotes</strong>{" "}
                  (mismo criterio FIFO que una venta). En Firestore queda el
                  detalle en <code className="text-[11px]">fifoAllocations</code>{" "}
                  y <strong>cogsAmount</strong> = valor a costo de lo que sacaste
                  (lo que habías facturado al proveedor y aún no vendías). No
                  genera ingreso en caja.
                </p>

                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => setAdjModalOpen(false)}
                    variant="outline"
                    size="sm"
                    className="!rounded-md sm:!px-4 sm:!py-2 text-sm hover:!bg-gray-50"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {inventoryView === "evolutivo" ? (
      <>
      {/* listado evolutivo */}
      {/* Desktop table (hidden on mobile) */}
      <div className="hidden sm:block space-y-1">
        {selected ? (
          <div className="text-xs text-slate-600 space-y-0.5">
            <p>
              Saldo al <span className="font-mono">{from}</span> (base del
              balance):{" "}
              <span className="font-semibold tabular-nums">
                {qty3(openingBalance)}
              </span>{" "}
              {unitLabel}
            </p>
            <p className="text-[11px] text-slate-500">
              Último balance = existencias en lotes si no hay movimientos después
              de <span className="font-mono">{to}</span>.
            </p>
          </div>
        ) : null}
        <div className="sm:overflow-x-auto">
        <table className="min-w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Tipo</th>
              <th className="border p-2">Descripción</th>
              <th className="border p-2">Entrada (+)</th>
              <th className="border p-2">Salida (−)</th>
              <th className="border p-2">Precio</th>
              <th className="border p-2">Monto</th>
              <th className="border p-2">Balance (rango)</th>
              <th className="border p-2">Inventario</th>
            </tr>
          </thead>
          <tbody>
            {!selected ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  Seleccioná un producto para ver su evolutivo.
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  Cargando movimientos…
                </td>
              </tr>
            ) : displayedMoves.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  No hay movimientos en el rango para este producto.
                </td>
              </tr>
            ) : (
              displayedMoves.map((m, idx) => {
                const { price, monto } = rowPriceAndMonto(m as InvMove);
                const openVenta =
                  (m.type === "VENTA_CASH" || m.type === "VENTA_CREDITO") &&
                  m.ref
                    ? () =>
                        setSaleDrawerOpen({
                          id: String(m.ref),
                          invType: m.type as InvMove["type"],
                        })
                    : undefined;
                return (
                <React.Fragment key={`${m.ref || idx}-${m.date}`}>
                  <tr
                    className={`text-center ${
                      m.type === "INGRESO" && m.ref
                        ? "cursor-pointer hover:bg-sky-50/80"
                        : (m.type === "MERMA" || m.type === "ROBO") && m.ref
                          ? "cursor-pointer hover:bg-rose-50/35"
                          : openVenta
                            ? "cursor-pointer hover:bg-amber-50/50"
                            : ""
                    }`}
                    onClick={() => {
                      if (m.type === "INGRESO" && m.ref)
                        setIngresoBatchId(String(m.ref));
                      else if (
                        (m.type === "MERMA" || m.type === "ROBO") &&
                        m.ref
                      )
                        setMermaDrawerAdjId(String(m.ref));
                      else if (openVenta) openVenta();
                    }}
                  >
                    <td className="border p-1">{m.date}</td>
                    <td className="border p-1">
                      <div className="flex justify-center">
                        <PolloChip
                          variant={tipoMoveChipVariant(String(m.type))}
                        >
                          {m.type}
                        </PolloChip>
                      </div>
                    </td>
                    <td className="border p-1 text-left">{m.description}</td>
                    <td className="border p-1">
                      <span
                        className={
                          Number(m.qtyIn || 0) > 0
                            ? "text-green-600 font-semibold"
                            : "text-black"
                        }
                      >
                        {qty3(m.qtyIn)}
                      </span>
                    </td>
                    <td className="border p-1">
                      <span
                        className={
                          Number(m.qtyOut || 0) > 0
                            ? "text-red-600 font-semibold"
                            : "text-black"
                        }
                      >
                        {qty3(m.qtyOut)}
                      </span>
                    </td>
                    <td className="border p-1 font-semibold text-black">
                      {m.type === "MERMA" || m.type === "ROBO"
                        ? `C$ ${price.toFixed(4)}`
                        : `C$ ${price.toFixed(2)}`}
                    </td>
                    <td className="border p-1 font-semibold text-black">
                      {`C$ ${monto.toFixed(2)}`}
                    </td>
                    <td className="border p-1 font-semibold">
                      {qty3((m as any).balance)}
                    </td>
                    <td
                      className="border p-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {(m.type === "MERMA" || m.type === "ROBO") && m.ref ? (
                        <Link
                          to={batchesHrefForMermaAdj(
                            String(m.ref),
                            selected?.productId,
                            adjFifoDetailById,
                            inventoryBatchesHref,
                          )}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center rounded-full border border-green-600 bg-green-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 hover:bg-green-100 whitespace-nowrap"
                        >
                          Lotes
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                </React.Fragment>
                );
              })
            )}
          </tbody>
        </table>
        </div>
      </div>
      </>
      ) : inventoryView === "lotes" ? (
      <div className="hidden sm:block w-full overflow-x-auto overflow-y-visible rounded-lg border border-gray-200 bg-white shadow-sm mb-4 overscroll-x-contain [scrollbar-gutter:stable]">
        <p className="px-2 py-1.5 text-[11px] text-gray-500 border-b border-gray-100 bg-gray-50/80">
          Lotes ingresados en el rango. Al expandir uno se cierra el anterior.
        </p>
        {lotLoading ? (
          <p className="p-4 text-sm text-gray-500">Cargando lotes…</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1020px] border-collapse border border-gray-200 text-sm">
              <thead className="bg-gray-100 sticky top-0 z-10">
                <tr>
                  <th
                    className="border border-gray-200 px-2 py-2.5 text-center text-xs font-semibold whitespace-nowrap w-12"
                    aria-label="Expandir"
                  />
                  <th className="border border-gray-200 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap min-w-[6.5rem]">
                    Fecha
                  </th>
                  <th className="border border-gray-200 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap min-w-[8rem]">
                    Lote
                  </th>
                  <th className="border border-gray-200 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap min-w-[12rem] w-[22%]">
                    Productos
                  </th>
                  <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[6rem]">
                    Inicial
                  </th>
                  <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[6rem]">
                    Consumido
                  </th>
                  <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[6rem]">
                    Restante
                  </th>
                  <th
                    className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[7rem] bg-violet-50/90"
                    title="Utilidad bruta (FIFO) del rango"
                  >
                    U.B. ventas
                  </th>
                </tr>
              </thead>
              <tbody>
                {lotGroupsFilteredForTable.length === 0 ? (
                  <tr>
                    <td
                      colSpan={8}
                      className="border border-gray-200 px-3 py-4 text-center text-gray-500"
                    >
                      No hay lotes ingresados en este rango
                      {selected ? " para el producto elegido" : ""}.
                    </td>
                  </tr>
                ) : (
                  lotGroupsFilteredForTable.map((g, rowIdx) => {
                    const pk = selected?.key || "";
                    const pid = (selected as { productId?: string })?.productId;
                    const pn = selected?.productName;
                    const vis = selected
                      ? g.lines.filter((ln) =>
                          lineMatchesProductFilter(ln, pk, pid, pn),
                        )
                      : g.lines.slice();
                    const inicial = vis.reduce(
                      (s, l) => s + Number(l.quantity || 0),
                      0,
                    );
                    const consumido = vis.reduce(
                      (s, l) =>
                        s +
                        Math.max(
                          0,
                          Number(l.quantity || 0) -
                            Number(l.remaining || 0),
                        ),
                      0,
                    );
                    const restanteVis = vis.reduce(
                      (s, l) => s + Number(l.remaining || 0),
                      0,
                    );
                    const batchIds = new Set(vis.map((l) => l.id));
                    const hitsAll = collectLotSaleAllocHits(
                      lotSales,
                      batchIds,
                    );
                    const expandedDailyRows = buildLotExpandedDailyRows(
                      vis,
                      hitsAll,
                    );
                    const ubVentasRow = round2(
                      hitsAll.reduce((s, h) => s + allocLineGross(h), 0),
                    );
                    const expanded = expandedLotGroupId === g.groupId;
                    const names = [
                      ...new Set(
                        vis.map((l) => l.productName || "").filter(Boolean),
                      ),
                    ];
                    const zebra =
                      rowIdx % 2 === 0 ? "bg-white" : "bg-slate-50/50";
                    return (
                      <React.Fragment key={g.groupId}>
                        <tr
                          className={`text-center ${zebra} border-t border-gray-100 hover:bg-sky-50/40 transition-colors`}
                        >
                          <td className="border border-gray-200 px-2 py-2.5 align-middle">
                            <button
                              type="button"
                              className="text-violet-800 font-mono text-xs px-1 rounded hover:bg-violet-100/80"
                              aria-expanded={expanded}
                              title={
                                expanded
                                  ? "Colapsar evolutivo"
                                  : "Ver por día"
                              }
                              onClick={() =>
                                setExpandedLotGroupId((cur) =>
                                  cur === g.groupId ? null : g.groupId,
                                )
                              }
                            >
                              {expanded ? "▼" : "▶"}
                            </button>
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle tabular-nums text-left">
                            {g.displayDate}
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm align-middle text-left font-medium text-gray-900">
                            {g.orderName}
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-xs align-middle text-left text-gray-700 min-w-0">
                            <span
                              className="line-clamp-2"
                              title={names.join(" · ")}
                            >
                              {names.join(" · ") || "—"}
                            </span>
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm align-middle tabular-nums text-right">
                            {qty3(inicial)}
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm align-middle text-right">
                            <button
                              type="button"
                              className="text-amber-900 font-semibold tabular-nums underline hover:text-amber-950"
                              onClick={() => openLotConsumidoDrawer(g)}
                            >
                              {qty3(consumido)}
                            </button>
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm align-middle tabular-nums text-right font-medium text-emerald-900">
                            {qty3(restanteVis)}
                          </td>
                          <td className="border border-gray-200 px-3 py-2.5 text-sm align-middle text-right tabular-nums font-semibold text-violet-900 bg-violet-50/40">
                            {moneyFmt(ubVentasRow)}
                          </td>
                        </tr>
                        {expanded ? (
                          <tr className="bg-violet-50/70">
                            <td
                              colSpan={8}
                              className="border border-gray-200 p-2 sm:p-3 align-top bg-violet-50/40"
                            >
                              <LotExpandedDailySubtable
                                rows={expandedDailyRows}
                              />
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        )}
      </div>
      ) : null}

      {/* Mobile: already rendered above inside card (sm:hidden) */}
      <SlideOverDrawer
        open={ingresoBatchId !== null}
        onClose={() => {
          setIngresoBatchId(null);
          setIngresoBatchRow(null);
        }}
        title="Detalle de lote (ingreso)"
        subtitle={ingresoBatchId || undefined}
        titleId="status-inv-ingreso-lote-title"
        panelMaxWidthClassName="max-w-lg"
      >
        {ingresoBatchLoading ? (
          <p className="text-sm text-gray-500">Cargando…</p>
        ) : !ingresoBatchRow ? (
          <p className="text-sm text-gray-500">
            No se encontró el lote o no hay permisos.
          </p>
        ) : (
          <DrawerDetailDlCard
            title={String(ingresoBatchRow.productName ?? "Lote")}
            rows={[
              {
                label: "Fecha",
                value: String(
                  ingresoBatchRow.date ??
                    ingresoBatchRow.batchDate ??
                    "—",
                ),
              },
              {
                label: "Producto",
                value: String(ingresoBatchRow.productName ?? "—"),
              },
              {
                label: "Cantidad",
                value: qty3(ingresoBatchRow.quantity),
              },
              {
                label: "Precio costo",
                value: `C$ ${Number(ingresoBatchRow.purchasePrice ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums",
              },
              {
                label: "Facturado",
                value: `C$ ${Number(ingresoBatchRow.invoiceTotal ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums font-semibold",
              },
              {
                label: "Precio venta",
                value: `C$ ${Number(ingresoBatchRow.salePrice ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums",
              },
              {
                label: "Esperado",
                value: `C$ ${Number(ingresoBatchRow.expectedTotal ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums text-emerald-900 font-semibold",
              },
              {
                label: "Utilidad bruta",
                value: `C$ ${Number(
                  ingresoBatchRow.utilidadBruta != null &&
                    Number.isFinite(Number(ingresoBatchRow.utilidadBruta))
                    ? Number(ingresoBatchRow.utilidadBruta)
                    : Number(ingresoBatchRow.expectedTotal ?? 0) -
                        Number(ingresoBatchRow.invoiceTotal ?? 0),
                ).toFixed(2)}`,
                ddClassName:
                  "tabular-nums text-violet-900 font-semibold",
              },
            ]}
          />
        )}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={saleDrawerOpen !== null}
        onClose={() => {
          setSaleDrawerOpen(null);
          setSaleDrawerDoc(null);
        }}
        title={
          saleDrawerIsCredit
            ? "Venta crédito · detalle"
            : "Venta contado · detalle"
        }
        subtitle={saleDrawerOpen?.id || undefined}
        titleId="status-inv-sale-drawer-title"
        panelMaxWidthClassName="max-w-2xl"
      >
        {saleDrawerLoading ? (
          <p className="text-sm text-gray-500">Cargando venta…</p>
        ) : saleDrawerLines.length === 0 ? (
          <p className="text-sm text-gray-500">
            Sin líneas de este producto en esta venta.
          </p>
        ) : (
          <div className="space-y-3">
            {saleDrawerIsCredit ? (
              <p className="text-sm font-medium text-violet-900 bg-violet-50/80 border border-violet-200 rounded-lg px-3 py-2">
                Cliente: {saleDrawerCustomer}
              </p>
            ) : null}
            <DrawerStatGrid
              items={[
                {
                  label: "Cant. productos (distintos)",
                  value: saleDrawerKpis.productCount,
                  tone: "slate",
                },
                {
                  label: "Líneas",
                  value: saleDrawerKpis.lineCount,
                  tone: "sky",
                },
                {
                  label: "Libras (tipo libra)",
                  value: qty3(saleDrawerKpis.lbs),
                  tone: "amber",
                },
                {
                  label: "Unidades (no libra)",
                  value: qty3(saleDrawerKpis.units),
                  tone: "violet",
                },
                {
                  label: "Monto",
                  value: moneyFmt(saleDrawerKpis.amount),
                  tone: "indigo",
                },
                {
                  label: "Utilidad bruta",
                  value: moneyFmt(saleDrawerKpis.grossProfit),
                  tone: "emerald",
                },
              ]}
            />
            <DrawerSectionTitle className="mt-0">
              {saleDrawerLines.length} línea(s) ·{" "}
              {saleDrawerIsCredit ? "crédito" : "contado"}
            </DrawerSectionTitle>
            {saleDrawerLines.map((line) => (
              <DrawerDetailDlCard
                key={line.id}
                title={line.productName}
                rows={[
                  { label: "Fecha venta", value: line.date },
                  {
                    label: "Precio",
                    value: moneyFmt(line.unitPrice),
                    ddClassName: "tabular-nums",
                  },
                  { label: "Cantidad", value: line.qtyLabel },
                  {
                    label: "Monto",
                    value: moneyFmt(line.amount),
                    ddClassName: "tabular-nums font-semibold",
                  },
                  {
                    label: "U. bruta",
                    value: moneyFmt(line.grossProfit),
                    ddClassName:
                      "tabular-nums text-violet-800 font-semibold",
                  },
                  {
                    label: "Vendedor",
                    value: line.seller,
                    ddClassName: "text-sm break-all",
                  },
                ]}
              />
            ))}
          </div>
        )}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={mermaDrawerAdjId !== null}
        onClose={() => setMermaDrawerAdjId(null)}
        title={mermaDrawerTitle}
        subtitle={
          selected
            ? `${selected.productName} · ${unitLabel}`
            : undefined
        }
        titleId="status-inv-merma-drawer-title"
        panelMaxWidthClassName="max-w-2xl"
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end w-full">
            <Link
              to={mermaDrawerBatchesHref}
              onClick={() => setMermaDrawerAdjId(null)}
              className="inline-flex justify-center items-center rounded-xl border border-green-600 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-800 hover:bg-green-100"
            >
              Ir al lote (inventario)
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl shadow-none"
              onClick={() => setMermaDrawerAdjId(null)}
            >
              Cerrar
            </Button>
          </div>
        }
      >
        {!mermaDrawerAdjId ? null : adjFifoLoadingId === mermaDrawerAdjId ? (
          <p className="text-sm text-gray-600">Cargando detalle FIFO…</p>
        ) : (() => {
            const det = adjFifoDetailById[mermaDrawerAdjId];
            if (!det) {
              return (
                <p className="text-sm text-gray-500">Sin datos aún.</p>
              );
            }
            if ("error" in det) {
              return (
                <p className="text-sm text-rose-700">{det.error}</p>
              );
            }
            return (
              <div className="space-y-4">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Cada fila usa el <strong>precio de compra del lote</strong>{" "}
                  (lo facturado al proveedor en ese ingreso), no un promedio del
                  producto.
                </p>
                <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3 text-sm">
                  <div className="font-semibold text-rose-900">
                    Facturado a costo (Σ cantidad × precio costo del lote)
                  </div>
                  <div className="text-lg font-bold tabular-nums text-rose-950 mt-1">
                    C$ {det.cogsAmount.toFixed(2)}
                  </div>
                  <p className="text-[11px] text-rose-800/80 mt-1">
                    Coincide con el valor retirado del inventario (COGS de esta
                    merma).
                  </p>
                </div>
                <div className="overflow-x-auto rounded-lg border border-rose-200/80 bg-white">
                  <table className="min-w-full text-xs sm:text-sm">
                    <thead className="bg-rose-100/80 text-left">
                      <tr>
                        <th className="p-2 font-semibold">Nombre de lote</th>
                        <th className="p-2 font-semibold">Fecha</th>
                        <th className="p-2 font-semibold font-mono text-[10px]">
                          Id
                        </th>
                        <th className="p-2 font-semibold text-right">
                          Cantidad
                        </th>
                        <th className="p-2 font-semibold text-right">
                          P. costo lote
                        </th>
                        <th className="p-2 font-semibold text-right">
                          Facturado
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {det.fifoAllocations.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-2 text-gray-500">
                            Sin líneas en fifoAllocations.
                          </td>
                        </tr>
                      ) : (
                        det.fifoAllocations.map((row, i) => {
                          const meta = adjBatchMetaById[row.batchId];
                          const lotTitle = meta
                            ? `${meta.orderName} · ${meta.productName}`
                            : row.batchId;
                          return (
                            <tr
                              key={`${row.batchId}-${i}`}
                              className="border-t border-rose-100"
                            >
                              <td className="p-2 text-gray-900 max-w-[10rem]">
                                <span
                                  className="line-clamp-2"
                                  title={lotTitle}
                                >
                                  {lotTitle}
                                </span>
                              </td>
                              <td className="p-2 tabular-nums whitespace-nowrap">
                                {meta?.date ?? "—"}
                              </td>
                              <td
                                className="p-2 font-mono text-[10px] text-slate-600 max-w-[5rem] truncate"
                                title={row.batchId}
                              >
                                {row.batchId}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {qty3(row.qty)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                C$ {row.unitCost.toFixed(4)}
                              </td>
                              <td className="p-2 text-right tabular-nums font-medium">
                                C$ {row.lineCost.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={lotDrawerGroup !== null}
        onClose={() => {
          setLotDrawerGroup(null);
          setLotDrawerProductKey("");
        }}
        title="Consumido — ventas por lote"
        subtitle={
          lotDrawerGroup
            ? `${lotDrawerGroup.orderName} · ${lotDrawerGroup.displayDate}`
            : undefined
        }
        titleId="status-inv-lot-cons-drawer-title"
        panelMaxWidthClassName="max-w-2xl"
      >
        {!lotDrawerGroup ? null : !lotDrawerKpisLot ? (
          <p className="text-sm text-gray-500">Sin datos de lote.</p>
        ) : (
          <div className="space-y-4">
            <DrawerSectionTitle>Datos de lote</DrawerSectionTitle>
            <DrawerStatGrid
              items={[
                {
                  label: "Fecha de lote",
                  value: lotDrawerKpisLot.fecha || "—",
                  tone: "slate",
                },
                {
                  label: "Ingresado",
                  value: qty3(lotDrawerKpisLot.ingresado),
                  tone: "sky",
                },
                {
                  label: "Facturado al costo",
                  value: moneyFmt(lotDrawerKpisLot.factCost),
                  tone: "amber",
                },
                {
                  label: "Esperado ventas",
                  value: moneyFmt(lotDrawerKpisLot.esperado),
                  tone: "emerald",
                },
                {
                  label: "Consumido",
                  value: qty3(lotDrawerKpisLot.consumido),
                  tone: "rose",
                },
                {
                  label: "Restante",
                  value: qty3(lotDrawerKpisLot.restante),
                  tone: "violet",
                },
                {
                  label: "U.B. ventas (FIFO)",
                  value: moneyFmt(lotDrawerKpisLot.ubVentas),
                  tone: "indigo",
                },
                {
                  label: "U.B. esperada (ingreso)",
                  value: moneyFmt(lotDrawerKpisLot.ubEsperadaIngreso),
                  tone: "emerald",
                },
              ]}
            />

            {lotDrawerChipOptions.length > 1 ? (
              <div>
                <DrawerSectionTitle>Producto</DrawerSectionTitle>
                <div className="flex flex-wrap gap-1.5">
                  {lotDrawerChipOptions.map((opt) => (
                    <button
                      key={opt.value}
                      type="button"
                      onClick={() => setLotDrawerProductKey(opt.value)}
                      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                        lotDrawerProductKey === opt.value
                          ? "border-violet-500 bg-violet-100 text-violet-900"
                          : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                      }`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
            ) : null}

            {lotDrawerKpisProduct ? (
              <>
                <DrawerSectionTitle>Datos de producto</DrawerSectionTitle>
                <DrawerStatGrid
                  items={[
                    {
                      label: "Ingresado",
                      value: qty3(lotDrawerKpisProduct.ingresado),
                      tone: "sky",
                    },
                    {
                      label: "Facturado al costo",
                      value: moneyFmt(lotDrawerKpisProduct.factCost),
                      tone: "amber",
                    },
                    {
                      label: "Ventas cash (monto)",
                      value: moneyFmt(lotDrawerKpisProduct.ventasCashMonto),
                      tone: "indigo",
                    },
                    {
                      label: `${lotDrawerKpisProduct.qtyLabel} vendidas (cash)`,
                      value: qty3(lotDrawerKpisProduct.qtyCash),
                      tone: "amber",
                    },
                    {
                      label: "Ventas crédito (monto)",
                      value: moneyFmt(lotDrawerKpisProduct.ventasCredMonto),
                      tone: "violet",
                    },
                    {
                      label: `${lotDrawerKpisProduct.qtyLabel} vendidas (crédito)`,
                      value: qty3(lotDrawerKpisProduct.qtyCred),
                      tone: "violet",
                    },
                    {
                      label: `${lotDrawerKpisProduct.qtyLabel} restantes`,
                      value: qty3(lotDrawerKpisProduct.restante),
                      tone: "emerald",
                    },
                    {
                      label: "U.B. ventas (FIFO)",
                      value: moneyFmt(lotDrawerKpisProduct.ubVentas),
                      tone: "indigo",
                    },
                    {
                      label: "U.B. esperada (ingreso)",
                      value: moneyFmt(lotDrawerKpisProduct.ubEsperadaIngreso),
                      tone: "emerald",
                    },
                  ]}
                />
              </>
            ) : (
              <p className="text-xs text-gray-500">
                Elegí un producto para ver KPIs detallados.
              </p>
            )}

            <div>
              <DrawerSectionTitle>Listado de ventas</DrawerSectionTitle>
              <div className="flex flex-wrap gap-1.5 mb-3">
                <button
                  type="button"
                  onClick={() => setLotDrawerPay("CASH")}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                    lotDrawerPay === "CASH"
                      ? "border-amber-500 bg-amber-100 text-amber-900"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  Cash
                </button>
                <button
                  type="button"
                  onClick={() => setLotDrawerPay("CREDITO")}
                  className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ${
                    lotDrawerPay === "CREDITO"
                      ? "border-violet-500 bg-violet-100 text-violet-900"
                      : "border-gray-200 bg-white text-gray-600 hover:bg-gray-50"
                  }`}
                >
                  Crédito
                </button>
              </div>

              {lotDrawerHitsFilteredForDrawer.length === 0 ? (
                <p className="text-sm text-gray-500">
                  No hay líneas con asignación a este lote para este producto y
                  tipo de pago (ventas sin FIFO en ítems no aparecen).
                </p>
              ) : (
                <div className="space-y-3">
                  {lotDrawerHitsFilteredForDrawer.map((row, hi) => {
                    const h = row.hit;
                    return (
                    <div
                      key={`${h.saleId}-${h.itemIndex}-${hi}`}
                      className={`rounded-xl border p-3 shadow-sm ${
                        h.isCash
                          ? "border-amber-200/90 bg-amber-50/90"
                          : "border-violet-200/90 bg-violet-50/90"
                      }`}
                    >
                      <DrawerDetailDlCard
                        title={h.productName || "Producto"}
                        rows={[
                          { label: "Id venta", value: h.saleId },
                          { label: "Fecha venta", value: h.saleDate },
                          {
                            label: "Tipo",
                            value: h.isCash ? "CONTADO" : "CRÉDITO",
                          },
                          ...(h.isCash
                            ? ([] as { label: string; value: string; ddClassName?: string }[])
                            : [
                                {
                                  label: "Cliente",
                                  value: h.customerLabel || "—",
                                },
                                {
                                  label: "Restante en lote tras esta venta",
                                  value: qty3(row.remainingAfterInLot),
                                  ddClassName:
                                    "tabular-nums font-semibold text-emerald-900",
                                },
                              ]),
                          {
                            label: "Cantidad (asignada al lote)",
                            value: `${qty3(h.allocQty)}${
                              h.measurement ? ` ${h.measurement}` : ""
                            }`,
                          },
                          {
                            label: "Precio unit.",
                            value: moneyFmt(h.unitPrice),
                            ddClassName: "tabular-nums",
                          },
                          {
                            label: "Monto (prorrateo línea)",
                            value: moneyFmt(allocLineAmount(h)),
                            ddClassName: "tabular-nums font-semibold",
                          },
                          {
                            label: "U. bruta (prorrateo)",
                            value: moneyFmt(allocLineGross(h)),
                            ddClassName:
                              "tabular-nums text-violet-800 font-semibold",
                          },
                          ...(h.isCash
                            ? [
                                {
                                  label: "Restante en lote tras esta venta",
                                  value: qty3(row.remainingAfterInLot),
                                  ddClassName:
                                    "tabular-nums font-semibold text-emerald-900",
                                },
                              ]
                            : []),
                          {
                            label: "Vendedor",
                            value: h.seller,
                            ddClassName: "text-sm break-all",
                          },
                        ]}
                      />
                    </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </SlideOverDrawer>

      {toastMsg && (
        <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      )}
    </div>
  );
}
