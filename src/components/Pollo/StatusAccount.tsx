import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
  getDoc,
  orderBy,
  query,
  serverTimestamp,
  where,
  deleteDoc,
  deleteField,
  doc,
  updateDoc,
} from "firebase/firestore";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import Button from "../common/Button";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import {
  POLLO_SELECT_COMPACT_DESKTOP_CLASS,
  POLLO_SELECT_COMPACT_MOBILE_CLASS,
  POLLO_SELECT_DESKTOP_CLASS,
  POLLO_SELECT_MOBILE_BUTTON_CLASS,
} from "../common/polloSelectStyles";
import Toast from "../common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";
import ActionMenu, {
  ActionMenuTrigger,
  actionMenuItemClass,
  actionMenuItemClassDestructive,
} from "../common/ActionMenu";
import {
  fetchBaseSummaryPollo,
  type BaseSummary,
} from "../../Services/baseSummaryPollo";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerMoneyStrip,
  DrawerSectionTitle,
  DrawerDetailDlCard,
  DrawerStatGrid,
} from "../common/DrawerContentCards";

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

const round2 = (n: number) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/** Suma U.Bruta de un documento salesV2 (misma lógica que CierreVentas). */
function grossProfitFromSaleDoc(x: Record<string, unknown>): number {
  let gp = 0;
  const items = Array.isArray(x.items) ? (x.items as any[]) : [];
  if (items.length > 0) {
    for (const it of items) {
      const qty = Number(it.qty ?? 0);
      const lineFinal =
        Number(it.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
        );
      const cogs = Number(it.cogsAmount ?? 0);
      const g = Number(it.grossProfit);
      gp += Number.isFinite(g) ? round2(g) : round2(lineFinal - cogs);
    }
    return round2(gp);
  }
  const amt = Number(x.amount ?? x.amountCharged ?? 0);
  const cogs = Number(x.cogsAmount ?? 0);
  const g = Number(x.grossProfit);
  return Number.isFinite(g) ? round2(g) : round2(amt - cogs);
}

/** Monto total de la venta (lineFinal o amount), mismo criterio que el listado de ventas cash. */
function saleAmountFromSaleDoc(x: Record<string, unknown>): number {
  const items = Array.isArray(x.items) ? (x.items as any[]) : [];
  if (items.length > 0) {
    return round2(
      items.reduce((acc, it) => acc + Number(it.lineFinal ?? 0), 0),
    );
  }
  return round2(Number(x.amount ?? x.amountCharged ?? 0));
}

const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");
const firstOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};
const lastOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth() + 1, 0), "yyyy-MM-dd");
};

const rowBgByType = (type: string): string => {
  switch (type) {
    case "VENTA_CASH":
    case "ABONO":
      return "bg-green-50/60";
    case "GASTO":
      return "bg-red-50/60";
    case "REABASTECIMIENTO":
      return "bg-blue-50/60";
    case "RETIRO":
    case "DEPOSITO":
    case "PERDIDA":
      return "bg-orange-50/60";
    case "CORTE":
      return "bg-purple-50/60";
    case "PRESTAMO A NEGOCIO POR DUENO":
      return "bg-amber-50/60";
    case "DEVOLUCION A DUENO POR PRESTAMO":
      return "bg-emerald-50/60";
    case "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":
      return "bg-sky-50/60";
    default:
      return "";
  }
};

const borderByType = (type: string): string => {
  switch (type) {
    case "VENTA_CASH":
    case "ABONO":
      return "border-l-4 border-l-green-400";
    case "GASTO":
      return "border-l-4 border-l-red-400";
    case "REABASTECIMIENTO":
      return "border-l-4 border-l-blue-400";
    case "RETIRO":
    case "DEPOSITO":
    case "PERDIDA":
      return "border-l-4 border-l-orange-400";
    case "CORTE":
      return "border-l-4 border-l-purple-500";
    case "PRESTAMO A NEGOCIO POR DUENO":
      return "border-l-4 border-l-amber-400";
    case "DEVOLUCION A DUENO POR PRESTAMO":
      return "border-l-4 border-l-emerald-400";
    case "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":
      return "border-l-4 border-l-sky-400";
    default:
      return "border-l-4 border-l-gray-200";
  }
};

const BADGE_CFG: Record<string, { label: string; cls: string }> = {
  VENTA_CASH:         { label: "VENTA CASH",    cls: "bg-green-100 text-green-800 border-green-200" },
  ABONO:              { label: "ABONO",          cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  GASTO:              { label: "GASTO",          cls: "bg-red-100 text-red-800 border-red-200" },
  REABASTECIMIENTO:   { label: "REABAST.",       cls: "bg-blue-100 text-blue-800 border-blue-200" },
  RETIRO:             { label: "RETIRO",         cls: "bg-orange-100 text-orange-800 border-orange-200" },
  AJUSTE:             { label: "AJUSTE",         cls: "bg-gray-100 text-gray-800 border-gray-200" },
  DEPOSITO:           { label: "DEPÓSITO",       cls: "bg-orange-100 text-orange-800 border-orange-200" },
  PERDIDA:            { label: "PÉRDIDA",        cls: "bg-rose-100 text-rose-800 border-rose-200" },
  CORTE:              { label: "✂ CORTE",        cls: "bg-purple-100 text-purple-800 border-purple-200 font-semibold" },
  "PRESTAMO A NEGOCIO POR DUENO":                  { label: "PRÉSTAMO",       cls: "bg-red-100 text-red-800 border-red-200" },
  "DEVOLUCION A DUENO POR PRESTAMO":               { label: "PAGO PRÉSTAMO", cls: "bg-green-100 text-green-800 border-green-200" },
  "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":   { label: "COMPRA DIRECTA", cls: "bg-sky-100 text-sky-800 border-sky-200" },
};

/** Chip de tipo de movimiento clicable (abre detalle en drawer). */
const typeBadgeButton = (type: string, onClick: () => void) => {
  const c = BADGE_CFG[type] ?? { label: type, cls: "bg-gray-100 text-gray-700 border-gray-200" };
  return (
    <button
      type="button"
      onClick={onClick}
      className={`text-[11px] px-2 py-[2px] rounded-full border whitespace-nowrap font-medium cursor-pointer hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1 focus-visible:ring-indigo-400 ${c.cls}`}
    >
      {c.label}
    </button>
  );
};

type BatchDetail = {
  id: string;
  productName: string;
  date: string;
  unit: string;
  remaining: number;
  salePrice: number;
  totalValue: number;
};

type SaleRow = {
  id: string;
  date: string;
  customer: string;
  type: string;
  amount: number;
  /** Utilidad bruta de la venta (misma lógica que CierreVentas). */
  grossProfit: number;
  productName: string;
  /** Ej. "12.500 lb" o "3.000 ud" */
  qtyLabel: string;
  unitPrice: number;
};

type AbonoRow = {
  id: string;
  date: string;
  customer: string;
  amount: number;
  comment?: string;
  /** Venta a la que aplica el abono (ar_movements_pollo.ref.saleId) */
  saleId?: string;
  customerId?: string;
};

/** Línea para drawer “ventas cash del día” (CONTADO). */
type CashSaleLine = {
  id: string;
  date: string;
  productName: string;
  unitPrice: number;
  qtyLabel: string;
  /** Cantidad numérica de la línea (misma unidad que `measurement` cuando existe). */
  qty: number;
  /** Medida del producto en venta: "lb"/"LB" = libras; resto (unidad, cajilla, huevo…) = KPI unidades. */
  measurement: string;
  amount: number;
  grossProfit: number;
  seller: string;
};

/** Igual criterio que SaleFormV2: solo esos valores cuentan como venta por libras. */
function isPolloLbMeasurement(m: string): boolean {
  const s = String(m || "").toLowerCase().trim();
  return (
    s === "lb" ||
    s === "lbs" ||
    s === "libra" ||
    s === "libras"
  );
}

/** Fallback si la venta vieja no trae `measurement` en el ítem. */
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

function lineKpiBucket(line: CashSaleLine): "lb" | "unidad" {
  const m = String(line.measurement || "").trim();
  if (m && isPolloLbMeasurement(m)) return "lb";
  if (m && !isPolloLbMeasurement(m)) return "unidad";
  const q = parseCashQtyLabelForKpis(line.qtyLabel);
  if (q.lbs > 0 && q.units === 0) return "lb";
  return "unidad";
}

function aggregateCashSaleLinesForDrawer(lines: CashSaleLine[]) {
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

/** Une líneas cash de ventas por día entre `desde` y `hasta` (inclusive, yyyy-MM-dd). */
function collectCashSaleLinesInRange(
  desde: string,
  hasta: string,
  byDay: Record<string, CashSaleLine[]>,
): CashSaleLine[] {
  const a = String(desde || "")
    .trim()
    .slice(0, 10);
  const b = String(hasta || "")
    .trim()
    .slice(0, 10);
  if (!a || !b || a > b) return [];
  const out: CashSaleLine[] = [];
  let cur = a;
  while (cur <= b) {
    out.push(...(byDay[cur] ?? []));
    const d = new Date(`${cur}T12:00:00`);
    d.setDate(d.getDate() + 1);
    cur = format(d, "yyyy-MM-dd");
  }
  return out;
}

/** Expande una venta CONTADO en líneas para el drawer (producto / precio / cantidad / monto / U.B.). */
function appendCashSaleLinesForDoc(
  docId: string,
  x: Record<string, unknown>,
  into: Record<string, CashSaleLine[]>,
) {
  const day = String(x.date || "")
    .trim()
    .slice(0, 10);
  if (!day) return;
  const seller = String(
    x.userEmail || x.vendor || (x.createdBy as { email?: string } | null)?.email || "—",
  ).trim() || "—";
  const items = Array.isArray(x.items) ? (x.items as any[]) : [];
  if (items.length > 0) {
    items.forEach((it, idx) => {
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
      const measurement = String(
        it.measurement ?? it.unit ?? "",
      ).trim();
      const qtyLabel =
        `${Number(qty).toFixed(3)}${unit ? ` ${unit}` : ""}`.trim();
      if (!into[day]) into[day] = [];
      into[day].push({
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
    return;
  }
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
  if (!into[day]) into[day] = [];
  into[day].push({
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
}

/** Filas para el drawer: datos de salesV2 asociados a un abono */
function buildSaleDetailRows(sale: Record<string, unknown> & { id?: string }): {
  label: string;
  value: string;
}[] {
  const items = Array.isArray(sale.items) ? (sale.items as any[]) : [];
  const total =
    items.length > 0
      ? items.reduce((acc, it) => acc + Number(it.lineFinal ?? 0), 0)
      : Number(sale.amount ?? sale.amountCharged ?? 0);
  const first = items[0];
  const rows: { label: string; value: string }[] = [
    { label: "ID venta", value: String(sale.id || "—") },
    { label: "Fecha venta", value: String(sale.date || "—") },
    {
      label: "Cliente",
      value: String(sale.customerName || sale.customer || "—"),
    },
    { label: "Tipo", value: String(sale.type || "—") },
    { label: "Monto venta", value: money(total) },
  ];
  if (first) {
    rows.push(
      { label: "Producto", value: String(first.productName || "—") },
      {
        label: "Cantidad",
        value:
          `${Number(first.qty ?? first.quantity ?? 0).toFixed(3)} ${String(first.unit || "").trim()}`.trim(),
      },
    );
  }
  if (items.length > 1) {
    rows.push({ label: "Ítems", value: `${items.length} líneas` });
  }
  return rows;
}

type LedgerType =
  | "VENTA_CASH"
  | "ABONO"
  | "GASTO"
  | "REABASTECIMIENTO"
  | "RETIRO"
  | "AJUSTE"
  | "DEPOSITO"
  | "PERDIDA"
  | "CORTE"
  | "PRESTAMO A NEGOCIO POR DUENO"
  | "DEVOLUCION A DUENO POR PRESTAMO"
  | "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";

type LedgerRow = {
  id: string;
  date: string; // yyyy-MM-dd
  type: LedgerType;
  description: string;
  reference?: string;
  inAmount: number; // entrada +
  outAmount: number; // salida -
  /** DEPÓSITO: día (yyyy-MM-dd) cuyo resumen “Ventas del día” se asocia (opcional). */
  associatedVentasDia?: string | null;
  /** CORTE: rango de fechas de ventas cash incluidas en el corte (yyyy-MM-dd). */
  corteDesde?: string | null;
  corteHasta?: string | null;
  createdAt?: any;
  createdBy?: { uid?: string | null; email?: string | null } | null;
};

/** Movimiento de caja o fila resumen U.Bruta al cierre de cada día. */
type DisplayLedgerItem =
  | { kind: "mov"; row: any; origIndex: number }
  | { kind: "cash_sales"; date: string; cashTotal: number }
  | { kind: "ub"; date: string; dayGross: number; cumUb: number };

export default function EstadoCuentaPollo(): React.ReactElement {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(lastOfMonth());
  const [loading, setLoading] = useState(true);

  const [base, setBase] = useState<BaseSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [invLbsRem, setInvLbsRem] = useState<number>(0);
  const [invUdsRem, setInvUdsRem] = useState<number>(0);
  const [invExistenciasMonetarias, setInvExistenciasMonetarias] =
    useState<number>(0);
  const [batchDetails, setBatchDetails] = useState<BatchDetail[]>([]);
  const [salesRows, setSalesRows] = useState<SaleRow[]>([]);
  const [abonosRows, setAbonosRows] = useState<AbonoRow[]>([]);
  /** yyyy-MM-dd → suma U.Bruta del día (ventas salesV2 en el rango). */
  const [grossProfitByDay, setGrossProfitByDay] = useState<
    Record<string, number>
  >({});
  /** yyyy-MM-dd → total ventas CONTADO (cash) del día; excluye CREDITO. */
  const [cashSalesTotalByDay, setCashSalesTotalByDay] = useState<
    Record<string, number>
  >({});
  /** yyyy-MM-dd → líneas de ventas CONTADO para drawer “ventas cash del día”. */
  const [cashSaleLinesByDay, setCashSaleLinesByDay] = useState<
    Record<string, CashSaleLine[]>
  >({});
  const [kpiDrawer, setKpiDrawer] = useState<"existencias" | "saldo" | null>(null);
  /** Drawer Saldo inicial: pestaña Ventas vs Abonos */
  const [saldoDrawerTab, setSaldoDrawerTab] = useState<"ventas" | "abonos">(
    "ventas",
  );
  /** yyyy-MM-dd: drawer con listado de abonos AR de ese día + ventas */
  const [abonoDiaDrawerDate, setAbonoDiaDrawerDate] = useState<string | null>(
    null,
  );
  /** Fila de movimiento seleccionada para ver detalle (chip Mov.) */
  const [movimientoDrawerRow, setMovimientoDrawerRow] = useState<any | null>(
    null,
  );
  /** yyyy-MM-dd: drawer listado ventas cash del día */
  const [cashSalesDrawerDate, setCashSalesDrawerDate] = useState<string | null>(
    null,
  );
  const [saleCache, setSaleCache] = useState<
    Record<string, Record<string, unknown> & { id?: string }>
  >({});

  // form
  const [date, setDate] = useState(today());
  const [type, setType] = useState<LedgerType>("GASTO");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [inAmount, setInAmount] = useState<string>("");
  const [outAmount, setOutAmount] = useState<string>("");
  /** DEPÓSITO: opcional, fecha del resumen “Ventas del día” (mismo día que `date` o el elegido). */
  const [associatedVentasDia, setAssociatedVentasDia] = useState<string>("");
  /** CORTE: ventas cash desde / hasta (inclusive). */
  const [corteDesde, setCorteDesde] = useState<string>("");
  const [corteHasta, setCorteHasta] = useState<string>("");

  const { refreshKey, refresh } = useManualRefresh();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [ledgerRowActionMenu, setLedgerRowActionMenu] = useState<{
    rect: DOMRect;
    row: any;
  } | null>(null);
  const [collapseLibras, setCollapseLibras] = useState(true);
  const [collapseUnidades, setCollapseUnidades] = useState(true);
  const [collapseVentas, setCollapseVentas] = useState(true);
  /** Web: bloque Préstamo / compras / salidas — colapsado por defecto */
  const [collapseCajaFlowKpis, setCollapseCajaFlowKpis] = useState(true);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const allCollapsed = collapseLibras && collapseUnidades && collapseVentas;
  const toggleAllKpis = () => {
    const next = !allCollapsed;
    setCollapseLibras(next);
    setCollapseUnidades(next);
    setCollapseVentas(next);
  };
  const [movementTypeFilter, setMovementTypeFilter] = useState<string>("ALL");
  const [toastMsg, setToastMsg] = useState("");

  // ========= helpers: qué tipos afectan CAJA =========
  const affectsCash = (t: LedgerType) => {
    // Caja (cash) SOLO se mueve si entra/sale efectivo real.
    // Compra directa por dueño NO entra a caja.
    return t !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";
  };

  const affectsOwnerDebt = (t: LedgerType) =>
    t === "PRESTAMO A NEGOCIO POR DUENO" ||
    t === "DEVOLUCION A DUENO POR PRESTAMO" ||
    t === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";

  // 1) cargar KPIs base (ventas + abonos)
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const summary = await fetchBaseSummaryPollo(from, to);
        setBase(summary);
      } catch (e) {
        console.error("Error base summary:", e);
        setBase(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, refreshKey]);

  // 2) cargar movimientos manuales (ledger)
  useEffect(() => {
    (async () => {
      try {
        const qLed = query(
          collection(db, "cash_ledger_pollo"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qLed);
        const ledgerRows: LedgerRow[] = snap.docs.map(
          (d) =>
            ({
              id: d.id,
              ...(d.data() as any),
              source: "ledger",
            }) as any,
        );

        const qExp = query(
          collection(db, "expenses"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const expSnap = await getDocs(qExp);
        const expenseRows: LedgerRow[] = expSnap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: `exp_${d.id}`,
            date: x.date || today(),
            type: "GASTO",
            description: x.description || "Gasto",
            reference: x.category || x.reference || null,
            inAmount: 0,
            outAmount: Number(x.amount || 0),
            createdAt: x.createdAt ?? null,
            createdBy: x.createdBy ?? null,
            source: "expenses",
          } as any;
        });

        const merged = [...ledgerRows, ...expenseRows].sort((a, b) =>
          (a.date || "").localeCompare(b.date || ""),
        );
        // try to fill missing createdBy.name by reading `users` collection
        const uids = Array.from(
          new Set(
            merged
              .map((m) => m.createdBy?.uid)
              .filter((x): x is string => Boolean(x) && x !== ""),
          ),
        );

        if (uids.length) {
          const updated = [...merged];
          await Promise.all(
            uids.map(async (uid) => {
              const need = updated.some((r) => {
                const cb = r.createdBy as { name?: string } | null | undefined;
                return r.createdBy?.uid === uid && !cb?.name;
              });
              if (!need) return;
              try {
                const udoc = await getDoc(doc(db, "users", uid));
                if (!udoc.exists()) return;
                const udata = udoc.data() as any;
                const uname =
                  udata?.name || udata?.displayName || udata?.email || null;
                if (!uname) return;
                for (let i = 0; i < updated.length; i++) {
                  if (updated[i].createdBy?.uid === uid) {
                    updated[i] = {
                      ...updated[i],
                      createdBy: {
                        ...(updated[i].createdBy || {}),
                        name:
                          (updated[i].createdBy as { name?: string } | null)
                            ?.name || uname,
                      },
                    } as any;
                  }
                }
              } catch (err) {
                console.warn("No se pudo cargar user doc for uid", uid, err);
              }
            }),
          );
          setLedger(updated as LedgerRow[]);
        } else {
          setLedger(merged as LedgerRow[]);
        }
      } catch (e) {
        console.error("Error ledger:", e);
        setLedger([]);
      }
    })();
  }, [from, to, refreshKey]);

  // 2b) U.Bruta por día (salesV2) — alineado con Cierre de ventas
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", from),
          where("date", "<=", to),
        );
        const snap = await getDocs(qs);
        const byDay: Record<string, number> = {};
        const cashByDay: Record<string, number> = {};
        snap.forEach((d) => {
          const x = d.data() as Record<string, unknown>;
          const day = String(x.date || "")
            .trim()
            .slice(0, 10);
          if (!day) return;
          const saleType = String(x.type ?? "CONTADO").toUpperCase();
          // U.B. día / acum.: solo ventas CONTADO (cash). Crédito se cobra después.
          if (saleType === "CONTADO") {
            const line = grossProfitFromSaleDoc(x);
            byDay[day] = round2((byDay[day] || 0) + line);
            const cashAmt = saleAmountFromSaleDoc(x);
            cashByDay[day] = round2((cashByDay[day] || 0) + cashAmt);
          }
        });
        if (!cancelled) {
          setGrossProfitByDay(byDay);
          setCashSalesTotalByDay(cashByDay);
        }
      } catch (e) {
        console.error("Error U.Bruta por día:", e);
        if (!cancelled) {
          setGrossProfitByDay({});
          setCashSalesTotalByDay({});
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [from, to, refreshKey]);

  // 3) cargar existencias desde inventory_batches (para KPI Existencias)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!from || !to) return;
        const q = query(
          collection(db, "inventory_batches"),
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          where("date", ">=", from),
          // @ts-ignore
          where("date", "<=", to),
        );
        const snap = await getDocs(q);

        const isPounds = (u: string) => {
          const s = (u || "").toLowerCase();
          return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
        };

        let lbs = 0;
        let uds = 0;
        let moneySum = 0;
        const details: BatchDetail[] = [];

        snap.forEach((d) => {
          const b = d.data() as any;
          const remaining = Number(b.remaining || 0);
          const qty = Number(b.quantity || 0) || 1;
          let unitPrice = Number(b.salePrice || 0) || 0;
          if (!unitPrice) {
            const expected = Number(b.expectedTotal || 0);
            unitPrice = qty ? expected / qty : 0;
          }

          if (isPounds(String(b.unit || ""))) {
            lbs += remaining;
          } else {
            uds += remaining;
          }

          moneySum += remaining * unitPrice;

          if (remaining > 0) {
            details.push({
              id: d.id,
              productName: b.productName || b.product || "Sin nombre",
              date: b.date || "",
              unit: b.unit || "ud",
              remaining,
              salePrice: unitPrice,
              totalValue: Number((remaining * unitPrice).toFixed(2)),
            });
          }
        });

        if (!mounted) return;
        setInvLbsRem(Number(lbs.toFixed(3)));
        setInvUdsRem(Number(uds.toFixed(3)));
        setInvExistenciasMonetarias(Number(moneySum.toFixed(2)));
        setBatchDetails(details.sort((a, b) => a.productName.localeCompare(b.productName)));
      } catch (e) {
        console.error("Error cargando existencias para KPI Existencias:", e);
        if (mounted) {
          setInvLbsRem(0);
          setInvUdsRem(0);
          setInvExistenciasMonetarias(0);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [from, to, refreshKey]);

  // 4) cargar detalle ventas cash + abonos (para drawer Saldo Inicial)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!from || !to) return;
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", from),
          where("date", "<=", to),
        );
        const sSnap = await getDocs(qs);
        const sales: SaleRow[] = [];
        const linesByDay: Record<string, CashSaleLine[]> = {};
        sSnap.forEach((d) => {
          const x = d.data() as any;
          if (String(x.type ?? "CONTADO").toUpperCase() !== "CONTADO") return;
          appendCashSaleLinesForDoc(
            d.id,
            x as Record<string, unknown>,
            linesByDay,
          );
          const total = Array.isArray(x.items) && x.items.length > 0
            ? x.items.reduce((a: number, it: any) => a + Number(it.lineFinal ?? 0), 0)
            : Number(x.amount ?? x.amountCharged ?? 0);

          let productName = String(x.productName || "").trim();
          let qty = Number(x.quantity ?? 0);
          let measurement = String(x.measurement || "").toLowerCase();
          let unitPrice = Number(x.unitPrice ?? 0);

          if (Array.isArray(x.items) && x.items.length > 0) {
            const it0 = x.items[0] as any;
            if (!productName) productName = String(it0.productName || "").trim();
            if (!qty) qty = Number(it0.qty ?? it0.quantity ?? 0);
            if (!measurement) measurement = String(it0.unit || "").toLowerCase();
            if (!unitPrice) {
              unitPrice = Number(
                it0.unitPrice ?? it0.price ?? it0.unitPricePackage ?? 0,
              );
            }
          }

          const isUnit =
            /un|ud/.test(measurement) ||
            (x.items?.[0] &&
              /un|ud/i.test(String((x.items[0] as any).unit || "")));
          const qtyLabel = isUnit
            ? `${qty.toFixed(3)} ud`
            : `${qty.toFixed(3)} lb`;

          if (!(unitPrice > 0) && qty > 0 && total > 0) {
            unitPrice = total / qty;
          }

          sales.push({
            id: d.id,
            date: x.date || "",
            customer: x.customerName || x.customer || "—",
            type: "CONTADO",
            amount: Number(total.toFixed(2)),
            grossProfit: grossProfitFromSaleDoc(x as Record<string, unknown>),
            productName: productName || "—",
            qtyLabel,
            unitPrice: Number((unitPrice || 0).toFixed(4)),
          });
        });

        const qar = query(
          collection(db, "ar_movements_pollo"),
          where("date", ">=", from),
          where("date", "<=", to),
        );
        const arSnap = await getDocs(qar);
        const abonos: AbonoRow[] = [];
        arSnap.forEach((d) => {
          const m = d.data() as any;
          if (String(m.type ?? "").trim().toUpperCase() !== "ABONO") return;
          const refSale = m.ref?.saleId
            ? String(m.ref.saleId)
            : undefined;
          abonos.push({
            id: d.id,
            date: m.date || "",
            customer: m.customerName || m.customer || "—",
            amount: Math.abs(Number(m.amount ?? 0)),
            comment: String(m.comment || ""),
            saleId: refSale,
            customerId: m.customerId ? String(m.customerId) : undefined,
          });
        });

        if (!mounted) return;
        setSalesRows(sales.sort((a, b) => a.date.localeCompare(b.date)));
        setAbonosRows(abonos.sort((a, b) => a.date.localeCompare(b.date)));
        setCashSaleLinesByDay(linesByDay);
      } catch (e) {
        console.error("Error cargando detalle ventas/abonos:", e);
        if (mounted) setCashSaleLinesByDay({});
      }
    })();
    return () => { mounted = false; };
  }, [from, to, refreshKey]);

  // saldo base: ventas cash + abonos
  const saldoBase = base?.saldoBase ?? 0;

  /** Suma utilidad bruta de todas las ventas cash del periodo (drawer Saldo inicial). */
  const ventasCashUbAcumulada = useMemo(
    () =>
      round2(
        salesRows.reduce(
          (acc, s) => acc + (Number(s.grossProfit) || 0),
          0,
        ),
      ),
    [salesRows],
  );

  // ========= Balance CAJA (NO se infla) =========
  const ledgerWithCashBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    const rows = [...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );

    return rows.map((r: any) => {
      const cashIn = affectsCash(r.type) ? Number(r.inAmount || 0) : 0;
      const cashOut = affectsCash(r.type) ? Number(r.outAmount || 0) : 0;
      bal = bal + cashIn - cashOut;
      return { ...r, cashBalance: bal };
    });
  }, [ledger, saldoBase]);

  const saldoFinalCaja = ledgerWithCashBalance.length
    ? (ledgerWithCashBalance[ledgerWithCashBalance.length - 1] as any)
        .cashBalance
    : saldoBase;

  // ========= Balance CONTABLE (como lo tenías antes) =========
  const ledgerWithAccountingBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    const rows = [...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );

    return rows.map((r: any) => {
      bal = bal + Number(r.inAmount || 0) - Number(r.outAmount || 0);
      return { ...r, accountingBalance: bal };
    });
  }, [ledger, saldoBase]);

  const saldoFinalContable = ledgerWithAccountingBalance.length
    ? (
        ledgerWithAccountingBalance[
          ledgerWithAccountingBalance.length - 1
        ] as any
      ).accountingBalance
    : saldoBase;

  // Para tabla: usamos CAJA por defecto (lo que preguntaste: "cuánto deberían tener en mano")
  const ledgerWithBalance = useMemo(() => {
    // mezcla ambos para export y para no romper UI: balance=CAJA, pero guardamos contable también
    const byId = new Map<string, any>();
    for (const r of ledgerWithAccountingBalance as any[]) byId.set(r.id, r);
    return (ledgerWithCashBalance as any[]).map((r) => ({
      ...r,
      balance: r.cashBalance,
      accountingBalance: byId.get(r.id)?.accountingBalance ?? r.cashBalance,
    }));
  }, [ledgerWithCashBalance, ledgerWithAccountingBalance]);

  const saldoFinal = saldoFinalCaja;

  // Totales (KPI)
  const totals = useMemo(() => {
    // Entradas de caja reales (excluye compra directa)
    const inCashSum = ledger.reduce((a, r) => {
      if (!affectsCash(r.type)) return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const gastosSum = ledger.reduce((a, r) => {
      return r.type === "GASTO" ? a + Number(r.outAmount || 0) : a;
    }, 0);

    const outSumNonGastos = ledger.reduce((a, r) => {
      if (!affectsCash(r.type)) return a;
      return r.type === "GASTO" || r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a
        : a + Number(r.outAmount || 0);
    }, 0);

    const abonoDueno = ledger.reduce((a, r) => {
      return r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const reabastecimientoSum = ledger.reduce((a, r) => {
      // solo si salió de caja
      if (r.type !== "REABASTECIMIENTO") return a;
      return a + Number(r.outAmount || 0);
    }, 0);

    const comprasDirectasDueno = ledger.reduce((a, r) => {
      return r.type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)"
        ? a + Number(r.inAmount || 0)
        : a;
    }, 0);

    return {
      inCashSum,
      outSumNonGastos,
      gastosSum,
      abonoDueno,
      reabastecimientoSum,
      comprasDirectasDueno,
    };
  }, [ledger]);

  // Movement types available for filter (derived from loaded ledger)
  const movementTypes = useMemo(() => {
    const s = new Set<string>();
    s.add("ALL");
    for (const r of ledger) {
      if (r && (r as any).type) s.add(String((r as any).type));
    }
    return Array.from(s);
  }, [ledger]);

  const movementTypeFilterSelectOptions = useMemo(
    () =>
      movementTypes.map((t) => ({
        value: t,
        label: t === "ALL" ? "Todos" : t,
      })),
    [movementTypes],
  );

  /** Selector “Asociar ventas” en DEPÓSITO: solo el resumen del día elegido en Fecha. */
  const asociarVentasDelDiaOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: "", label: "— Sin asociar —" },
    ];
    const d = String(date || "").trim().slice(0, 10);
    if (!d) return opts;
    const total = round2(cashSalesTotalByDay[d] ?? 0);
    opts.push({
      value: d,
      label: `Ventas del día: ${money(total)}`,
    });
    return opts;
  }, [date, cashSalesTotalByDay]);

  const modalMovementTypeOptions = useMemo(
    () => [
      { value: "GASTO", label: "Gasto" },
      {
        value: "REABASTECIMIENTO",
        label: "Reabastecimiento (pagado con caja)",
      },
      { value: "RETIRO", label: "Retiro" },
      { value: "DEPOSITO", label: "Deposito" },
      { value: "CORTE", label: "Corte de caja (retiro total/parcial)" },
      { value: "PERDIDA", label: "Perdida por robo" },
      {
        value: "PRESTAMO A NEGOCIO POR DUENO",
        label: "Préstamo a negocio por dueño (ENTRA A CAJA)",
      },
      {
        value: "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
        label: "Compra directa por dueño (NO entra a caja)",
      },
      {
        value: "DEVOLUCION A DUENO POR PRESTAMO",
        label: "Devolución a dueño por préstamo (SALE de caja)",
      },
    ],
    [],
  );

  // Filtered ledger used for display (does not affect KPI totals)
  const filteredLedgerWithBalance = useMemo(() => {
    if (!movementTypeFilter || movementTypeFilter === "ALL")
      return ledgerWithBalance;
    return (ledgerWithBalance || []).filter(
      (r: any) => String(r.type || "") === movementTypeFilter,
    );
  }, [ledgerWithBalance, movementTypeFilter]);

  const tableTotals = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    for (const r of filteredLedgerWithBalance as any[]) {
      totalIn += Number(r.inAmount || 0);
      totalOut += Number(r.outAmount || 0);
    }
    return { totalIn, totalOut };
  }, [filteredLedgerWithBalance]);

  /** Suma de abonos AR por fecha de calendario (informativo; mismo valor en todas las filas de ese día). */
  const abonosPorDia = useMemo(() => {
    const m = new Map<string, number>();
    for (const a of abonosRows) {
      const d = String(a.date || "").trim().slice(0, 10);
      if (!d) continue;
      m.set(d, (m.get(d) || 0) + Number(a.amount || 0));
    }
    return m;
  }, [abonosRows]);

  const totalAbonosArPeriodo = useMemo(
    () => abonosRows.reduce((s, a) => s + Number(a.amount || 0), 0),
    [abonosRows],
  );

  /** Solo la primera fila de cada día muestra el total AR (evita repetición). */
  const abonoColFirstRowOfDay = useMemo(() => {
    const rows = filteredLedgerWithBalance as any[];
    const flags: boolean[] = [];
    let prev = "";
    for (let i = 0; i < rows.length; i++) {
      const d = String(rows[i]?.date || "").trim().slice(0, 10);
      flags.push(i === 0 || d !== prev);
      prev = d;
    }
    return flags;
  }, [filteredLedgerWithBalance]);

  const exportAbonoColFirstRowOfDay = useMemo(() => {
    const rows = (ledgerWithBalance || []) as any[];
    const flags: boolean[] = [];
    let prev = "";
    for (let i = 0; i < rows.length; i++) {
      const d = String(rows[i]?.date || "").trim().slice(0, 10);
      flags.push(i === 0 || d !== prev);
      prev = d;
    }
    return flags;
  }, [ledgerWithBalance]);

  /**
   * Movimientos por día + resumen ventas cash + U.B. (CONTADO) por día.
   * Incluye días con ventas pero sin movimientos en caja (p. ej. 31 del mes).
   */
  const displayLedgerWithUb = useMemo((): DisplayLedgerItem[] => {
    const rows = filteredLedgerWithBalance as any[];
    const out: DisplayLedgerItem[] = [];
    const fromKey = String(from || "").trim().slice(0, 10);
    const toKey = String(to || "").trim().slice(0, 10);

    const byDay = new Map<string, { row: any; origIndex: number }[]>();
    rows.forEach((r, origIndex) => {
      const d = String(r.date || "").trim().slice(0, 10);
      if (!byDay.has(d)) byDay.set(d, []);
      byDay.get(d)!.push({ row: r, origIndex });
    });

    const dateSet = new Set<string>();
    for (const r of rows) {
      const d = String(r.date || "").trim().slice(0, 10);
      if (d) dateSet.add(d);
    }
    for (const k of Object.keys(grossProfitByDay)) dateSet.add(k);
    for (const k of Object.keys(cashSalesTotalByDay)) dateSet.add(k);

    const allDates = [...dateSet]
      .filter((d) => d >= fromKey && d <= toKey)
      .sort();

    const saleDaysSorted = Object.keys(grossProfitByDay).sort();
    const cumUbThroughDate = (d: string) =>
      round2(
        saleDaysSorted
          .filter((x) => x <= d)
          .reduce((a, k) => a + (grossProfitByDay[k] ?? 0), 0),
      );

    for (const d of allDates) {
      const cashTotal = round2(cashSalesTotalByDay[d] ?? 0);
      out.push({ kind: "cash_sales", date: d, cashTotal });
      const dayGross = round2(grossProfitByDay[d] ?? 0);
      const cumUb = cumUbThroughDate(d);
      out.push({ kind: "ub", date: d, dayGross, cumUb });
      const dayEntries = byDay.get(d) ?? [];
      for (const { row, origIndex } of dayEntries) {
        out.push({ kind: "mov", row, origIndex });
      }
    }
    return out;
  }, [
    filteredLedgerWithBalance,
    grossProfitByDay,
    cashSalesTotalByDay,
    from,
    to,
  ]);

  const totalUbrutaPeriodo = useMemo(
    () =>
      round2(Object.values(grossProfitByDay).reduce((a, b) => a + b, 0)),
    [grossProfitByDay],
  );

  /** U.B. acumulada al cierre del periodo (ventas con fecha ≤ fin); no depende del último día con caja. */
  const cumUbAcumAlCierrePeriodo = useMemo(() => {
    const saleDaysSorted = Object.keys(grossProfitByDay).sort();
    const toKey = String(to || "").trim().slice(0, 10);
    return round2(
      saleDaysSorted
        .filter((x) => x <= toKey)
        .reduce((a, k) => a + (grossProfitByDay[k] ?? 0), 0),
    );
  }, [grossProfitByDay, to]);

  const abonosDelDiaSeleccionado = useMemo(() => {
    if (!abonoDiaDrawerDate) return [];
    return abonosRows.filter(
      (a) => String(a.date || "").trim().slice(0, 10) === abonoDiaDrawerDate,
    );
  }, [abonoDiaDrawerDate, abonosRows]);

  const cashLinesForDrawer = useMemo(() => {
    if (!cashSalesDrawerDate) return [];
    return cashSaleLinesByDay[cashSalesDrawerDate] ?? [];
  }, [cashSalesDrawerDate, cashSaleLinesByDay]);

  const cashSalesDrawerKpis = useMemo(
    () => aggregateCashSaleLinesForDrawer(cashLinesForDrawer),
    [cashLinesForDrawer],
  );

  const depositoAssocVentasDate = useMemo(() => {
    if (!movimientoDrawerRow || movimientoDrawerRow.type !== "DEPOSITO")
      return null;
    const a = String(
      (movimientoDrawerRow as { associatedVentasDia?: string | null })
        .associatedVentasDia || "",
    )
      .trim()
      .slice(0, 10);
    return a || null;
  }, [movimientoDrawerRow]);

  const depositoDrawerLines = useMemo(() => {
    if (!depositoAssocVentasDate) return [];
    return cashSaleLinesByDay[depositoAssocVentasDate] ?? [];
  }, [depositoAssocVentasDate, cashSaleLinesByDay]);

  const depositoDrawerKpis = useMemo(
    () => aggregateCashSaleLinesForDrawer(depositoDrawerLines),
    [depositoDrawerLines],
  );

  const corteAssocRange = useMemo(() => {
    if (!movimientoDrawerRow || movimientoDrawerRow.type !== "CORTE")
      return null;
    const desde = String(
      (movimientoDrawerRow as LedgerRow).corteDesde || "",
    )
      .trim()
      .slice(0, 10);
    const hasta = String(
      (movimientoDrawerRow as LedgerRow).corteHasta || "",
    )
      .trim()
      .slice(0, 10);
    if (!desde || !hasta || desde > hasta) return null;
    return { desde, hasta };
  }, [movimientoDrawerRow]);

  const corteDrawerLines = useMemo(() => {
    if (!corteAssocRange) return [];
    return collectCashSaleLinesInRange(
      corteAssocRange.desde,
      corteAssocRange.hasta,
      cashSaleLinesByDay,
    );
  }, [corteAssocRange, cashSaleLinesByDay]);

  const corteDrawerKpis = useMemo(
    () => aggregateCashSaleLinesForDrawer(corteDrawerLines),
    [corteDrawerLines],
  );

  useEffect(() => {
    if (!abonoDiaDrawerDate) return;
    const list = abonosRows.filter(
      (a) => String(a.date || "").trim().slice(0, 10) === abonoDiaDrawerDate,
    );
    const ids = [
      ...new Set(list.map((a) => a.saleId).filter((x): x is string => Boolean(x))),
    ];
    if (ids.length === 0) return;
    let cancelled = false;
    (async () => {
      const next: Record<string, Record<string, unknown> & { id?: string }> =
        {};
      await Promise.all(
        ids.map(async (sid) => {
          try {
            const snap = await getDoc(doc(db, "salesV2", sid));
            if (snap.exists()) {
              next[sid] = { id: snap.id, ...snap.data() };
            } else {
              next[sid] = { id: sid, _missing: true };
            }
          } catch {
            next[sid] = { id: sid, _missing: true };
          }
        }),
      );
      if (!cancelled && Object.keys(next).length > 0) {
        setSaleCache((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [abonoDiaDrawerDate, abonosRows]);

  // Display totals depend on filter (para no romper tu lógica)
  const displayTotals = useMemo(() => {
    if (!movementTypeFilter || movementTypeFilter === "ALL") return totals;
    const rows = (ledger || []).filter(
      (r) => String((r as any).type || "") === movementTypeFilter,
    );

    const inCashSum = rows.reduce((a, r: any) => {
      if (!affectsCash(r.type)) return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const gastosSum = rows.reduce(
      (a: number, r: any) =>
        r.type === "GASTO" ? a + Number(r.outAmount || 0) : a,
      0,
    );

    const outSumNonGastos = rows.reduce((a: number, r: any) => {
      if (!affectsCash(r.type)) return a;
      return r.type === "GASTO" || r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a
        : a + Number(r.outAmount || 0);
    }, 0);

    const abonoDueno = rows.reduce((a: number, r: any) => {
      return r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const reabastecimientoSum = rows.reduce((a: number, r: any) => {
      return r.type === "REABASTECIMIENTO" ? a + Number(r.outAmount || 0) : a;
    }, 0);

    const comprasDirectasDueno = rows.reduce((a: number, r: any) => {
      return r.type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)"
        ? a + Number(r.inAmount || 0)
        : a;
    }, 0);

    return {
      inCashSum,
      outSumNonGastos,
      gastosSum,
      abonoDueno,
      reabastecimientoSum,
      comprasDirectasDueno,
    };
  }, [ledger, movementTypeFilter, totals]);

  // KPI: deuda del negocio con el dueño
  const deudaDueno = useMemo(() => {
    const prestadoCaja = ledger.reduce((a, r) => {
      if (r.type !== "PRESTAMO A NEGOCIO POR DUENO") return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const compradoDirecto = ledger.reduce((a, r) => {
      if (r.type !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)") return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const devuelto = ledger.reduce((a, r) => {
      if (r.type !== "DEVOLUCION A DUENO POR PRESTAMO") return a;
      return a + Number(r.outAmount || 0);
    }, 0);

    // deuda = (prestamos + compras directas) - devoluciones
    return Math.max(
      0,
      Number(prestadoCaja || 0) +
        Number(compradoDirecto || 0) -
        Number(devuelto || 0),
    );
  }, [ledger]);

  const exportLedgerToExcel = () => {
    const rows: (string | number)[][] = [];
    const headers = [
      "Fecha",
      "Movimiento",
      "Descripción",
      "Referencia",
      "Entrada",
      "Salida",
      "Abonos día (AR)",
      "Saldo CAJA",
      "Saldo CONTABLE",
      "Fuente",
      "Creado por",
      "Afecta deuda dueño",
      "Afecta CAJA",
    ];
    rows.push(headers);

    (ledgerWithBalance || []).forEach((r: any, idx: number) => {
      const createdBy = r.createdBy
        ? `${r.createdBy.email || r.createdBy.uid || ""}`
        : "";
      const dk = String(r.date || "").trim().slice(0, 10);
      const showAbonoCol = exportAbonoColFirstRowOfDay[idx] ?? false;
      const abonoDia =
        showAbonoCol && dk ? abonosPorDia.get(dk) ?? 0 : "";
      rows.push([
        r.date || "",
        r.type || "",
        r.description || "",
        r.reference || "",
        r.inAmount || 0,
        r.outAmount || 0,
        abonoDia,
        r.balance || 0,
        r.accountingBalance || 0,
        r.source || "ledger",
        createdBy,
        affectsOwnerDebt(r.type as LedgerType) ? "SI" : "",
        affectsCash(r.type as LedgerType) ? "SI" : "NO",
      ]);
    });

    const name = `estado_cuenta_${from || "desde"}_${to || "hasta"}.xlsx`;
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, "Movimientos");

    const ubRows: (string | number)[][] = [
      ["Fecha", "U.Bruta día", "U.Bruta acum."],
    ];
    const daysUb = Object.keys(grossProfitByDay).sort();
    let cumUb = 0;
    for (const d of daysUb) {
      const g = round2(grossProfitByDay[d] ?? 0);
      cumUb = round2(cumUb + g);
      ubRows.push([d, g, cumUb]);
    }
    ubRows.push([
      "Total periodo",
      totalUbrutaPeriodo,
      cumUbAcumAlCierrePeriodo,
    ]);
    const wsUb = XLSX.utils.aoa_to_sheet(ubRows);
    XLSX.utils.book_append_sheet(wb, wsUb, "U_Bruta_diaria");

    XLSX.writeFile(wb, name);
  };

  const saveMovement = async () => {
    const inVal = Number(inAmount || 0);
    const outVal = Number(outAmount || 0);

    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
    ];
    const onlyInTypes: LedgerType[] = [
      "PRESTAMO A NEGOCIO POR DUENO",
      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
    ];

    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (!date) {
      setToastMsg("⚠️ Poné una fecha.");
      return;
    }
    if (!description.trim()) {
      setToastMsg("⚠️ Poné una descripción.");
      return;
    }

    const corteDTrim = corteDesde.trim().slice(0, 10);
    const corteHTrim = corteHasta.trim().slice(0, 10);
    if (type === "CORTE") {
      if (!corteDTrim || !corteHTrim) {
        setToastMsg("⚠️ Poné Desde y Hasta para el corte de caja.");
        return;
      }
      if (corteDTrim > corteHTrim) {
        setToastMsg("⚠️ La fecha Desde no puede ser posterior a Hasta.");
        return;
      }
    }

    if (isOnlyIn) {
      if (inVal <= 0) {
        setToastMsg("⚠️ Poné una entrada para este tipo.");
        return;
      }
    } else if (isOnlyOut) {
      if (outVal <= 0) {
        setToastMsg("⚠️ Poné una salida para este tipo.");
        return;
      }
    } else {
      if (inVal <= 0 && outVal <= 0) {
        setToastMsg("⚠️ Poné una entrada o una salida.");
        return;
      }
      if (inVal > 0 && outVal > 0) {
        setToastMsg("⚠️ Usá solo entrada o salida, no ambos.");
        return;
      }
    }

    const user = auth.currentUser;

    const assocTrim = associatedVentasDia.trim().slice(0, 10);

    const basePayload = {
      date,
      type,
      description: description.trim(),
      reference: reference.trim() || null,
      inAmount: inVal > 0 ? inVal : 0,
      outAmount: outVal > 0 ? outVal : 0,
      createdAt: serverTimestamp(),
      createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
      periodFrom: from,
      periodTo: to,
    };

    if (editingId) {
      const up: Record<string, unknown> = { ...basePayload };
      if (type === "DEPOSITO") {
        up.associatedVentasDia = assocTrim || null;
      } else {
        up.associatedVentasDia = deleteField();
      }
      if (type === "CORTE") {
        up.corteDesde = corteDTrim;
        up.corteHasta = corteHTrim;
      } else {
        up.corteDesde = deleteField();
        up.corteHasta = deleteField();
      }
      try {
        await updateDoc(doc(db, "cash_ledger_pollo", editingId), up);
        setToastMsg("✅ Movimiento actualizado.");
      } catch (e) {
        console.error("Error updating movement:", e);
        setToastMsg("❌ No se pudo actualizar el movimiento. Revisa la consola.");
        return;
      }
    } else {
      const add: Record<string, unknown> = { ...basePayload };
      if (type === "DEPOSITO") {
        add.associatedVentasDia = assocTrim || null;
      }
      if (type === "CORTE") {
        add.corteDesde = corteDTrim;
        add.corteHasta = corteHTrim;
      }
      await addDoc(collection(db, "cash_ledger_pollo"), add);
      setToastMsg("✅ Movimiento guardado.");
    }

    setDescription("");
    setReference("");
    setInAmount("");
    setOutAmount("");
    setAssociatedVentasDia("");
    setCorteDesde("");
    setCorteHasta("");

    refresh();
    setModalOpen(false);
    setEditingId(null);
  };

  // When type changes, clear disabled input
  useEffect(() => {
    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
    ];
    const onlyInTypes: LedgerType[] = [
      "PRESTAMO A NEGOCIO POR DUENO",
      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
    ];

    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (isOnlyOut) setInAmount("");
    if (isOnlyIn) setOutAmount("");
  }, [type]);

  useEffect(() => {
    if (type !== "DEPOSITO") setAssociatedVentasDia("");
  }, [type]);

  useEffect(() => {
    if (type !== "CORTE") {
      setCorteDesde("");
      setCorteHasta("");
    }
  }, [type]);

  /** CORTE: si faltan fechas, usar la fecha del movimiento como valor inicial. */
  useEffect(() => {
    if (type !== "CORTE") return;
    const d = String(date || "").trim().slice(0, 10);
    if (!d) return;
    setCorteDesde((prev) => prev || d);
    setCorteHasta((prev) => prev || d);
  }, [type, date]);

  /** Si cambia la fecha del formulario, quitar asociación que ya no coincide con ese día. */
  useEffect(() => {
    const d = String(date || "").trim().slice(0, 10);
    setAssociatedVentasDia((prev) => {
      if (!prev || !d) return prev;
      return prev !== d ? "" : prev;
    });
  }, [date]);

  // close modal/menu on outside click or Escape
  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (modalOpen) {
        if (modalRef.current && !modalRef.current.contains(target)) {
          setModalOpen(false);
          setEditingId(null);
        }
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setModalOpen(false);
        setEditingId(null);
      }
    };

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modalOpen]);

  const openLedgerEditModal = (r: any) => {
    setEditingId(r.id);
    setDate(r.date);
    setType(r.type as LedgerType);
    setDescription(r.description || "");
    setReference(r.reference || "");
    setAssociatedVentasDia(
      String((r as LedgerRow).associatedVentasDia || "").slice(0, 10),
    );
    setCorteDesde(String((r as LedgerRow).corteDesde || "").slice(0, 10));
    setCorteHasta(String((r as LedgerRow).corteHasta || "").slice(0, 10));
    const inStr =
      Number(r.inAmount || 0) === 0 ? "" : String(Number(r.inAmount));
    const outStr =
      Number(r.outAmount || 0) === 0 ? "" : String(Number(r.outAmount));
    setInAmount(inStr);
    setOutAmount(outStr);
    setModalOpen(true);
    setLedgerRowActionMenu(null);
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">Estado de Cuenta</h2>
        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportLedgerToExcel}
            className="!rounded-xl"
          >
            Exportar Excel
          </Button>
        </div>
      </div>

      {/* Filtros */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
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

      {/* KPIs */}
      {/* Desktop grid */}
      <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <div className="sm:col-span-3 flex justify-end">
          <Button
            type="button"
            variant={allCollapsed ? "primary" : "secondary"}
            size="sm"
            onClick={toggleAllKpis}
            className={`!rounded-xl shrink-0 text-sm !px-3 !py-1.5 !font-medium ${
              allCollapsed ? "" : "!bg-gray-100 !text-gray-800 hover:!bg-gray-200"
            }`}
          >
            {allCollapsed ? "Ver indicadores" : "Ocultar"}
          </Button>
        </div>

        {/* Libras */}
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Libras</div>
          </div>
          {!collapseLibras && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">Libras vendidas Cash</div>
              <div className="text-2xl font-bold">
                {qty3(base?.lbsCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Libras vendidas Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.lbsCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Total Libras Cash + Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3((base?.lbsCash ?? 0) + (base?.lbsCredit ?? 0))}
              </div>
            </div>
          )}
        </div>

        {/* Unidades */}
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Unidades</div>
          </div>
          {!collapseUnidades && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">
                Unidades vendidas Cash
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.unitsCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Unidades vendidas Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.unitsCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Total Unidades Cash + Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3((base?.unitsCash ?? 0) + (base?.unitsCredit ?? 0))}
              </div>
            </div>
          )}
        </div>

        {/* Ventas */}
        <div className="border rounded-2xl p-3 bg-white">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Ventas / Abonos</div>
          </div>
          {!collapseVentas && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">Ventas Cash $</div>
              <div className="text-2xl font-bold">
                {money(base?.salesCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">Ventas Crédito $</div>
              <div className="text-2xl font-bold">
                {money(base?.salesCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Abonos al periodo $
              </div>
              <div className="text-2xl font-bold">
                {money(base?.abonosPeriodo ?? 0)}
              </div>
            </div>
          )}
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <div className="border rounded-2xl p-3 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-gray-900">
                  Préstamo, compras y salidas
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Préstamo a caja, compras del dueño, abonos, deuda, gastos y
                  salidas
                </div>
              </div>
              <Button
                type="button"
                variant={collapseCajaFlowKpis ? "primary" : "secondary"}
                size="sm"
                onClick={() => setCollapseCajaFlowKpis((v) => !v)}
                className={`!rounded-xl shrink-0 text-sm !px-3 !py-1.5 !font-medium ${
                  collapseCajaFlowKpis
                    ? ""
                    : "!bg-gray-100 !text-gray-800 hover:!bg-gray-200"
                }`}
              >
                {collapseCajaFlowKpis ? "Ver indicadores" : "Ocultar"}
              </Button>
            </div>

            {!collapseCajaFlowKpis && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                <div className="border rounded-2xl p-3 bg-green-50">
                  <div className="text-xs text-gray-600">Prestamo a caja</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.inCashSum)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-sky-50">
                  <div className="text-xs text-gray-600">
                    Compras directas (dueño)
                  </div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.comprasDirectasDueno || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-emerald-50">
                  <div className="text-xs text-gray-600">Abonos a Préstamos</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.abonoDueno)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-amber-50">
                  <div className="text-xs text-gray-600">Deuda a Dueño</div>
                  <div className="text-2xl font-bold">{money(deudaDueno)}</div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">Gastos del periodo</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.gastosSum)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">
                    Salidas (Retiros, Depositos, Perdidas)
                  </div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.outSumNonGastos)}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-5 gap-3">
            <div className="border rounded-2xl p-3 bg-blue-50">
              <div className="text-xs text-gray-600">
                Reabastecimiento (pagado con caja)
              </div>
              <div className="text-2xl font-bold">
                {money(displayTotals.reabastecimientoSum || 0)}
              </div>
            </div>

            <Button
              type="button"
              variant="ghost"
              onClick={() => setKpiDrawer("existencias")}
              className="flex flex-col items-stretch w-full h-auto !rounded-2xl border border-amber-200/80 p-3 bg-amber-50 text-left hover:ring-2 hover:ring-amber-300 transition-shadow !font-normal shadow-sm"
            >
              <div className="text-xs text-gray-600">Existencias <span className="text-[10px] text-amber-600 ml-1">ver detalle →</span></div>
              <div className="text-sm text-gray-600">
                Libras: {qty3(invLbsRem)}
              </div>
              <div className="text-sm text-gray-600">
                Unidades: {qty3(invUdsRem)}
              </div>
              <div className="text-2xl font-bold mt-2">
                {money(invExistenciasMonetarias)}
              </div>
            </Button>

            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSaldoDrawerTab("ventas");
                setKpiDrawer("saldo");
              }}
              className="flex flex-col items-stretch w-full h-auto !rounded-2xl border border-indigo-200/80 p-3 bg-indigo-50 text-left hover:ring-2 hover:ring-indigo-300 transition-shadow !font-normal shadow-sm"
            >
              <div className="text-xs text-gray-600">
                Saldo Inicial (Ventas Cash + Abonos) <span className="text-[10px] text-indigo-600 ml-1">ver detalle →</span>
              </div>
              <div className="text-2xl font-bold">{money(saldoBase)}</div>
            </Button>

            {/* ✅ KPI NUEVO: SALDO CONTABLE */}
            <div className="border rounded-2xl p-3 bg-gray-50">
              <div className="text-xs text-gray-600">
                Saldo inicial + Compras directas
              </div>
              <div className="text-2xl font-bold">
                {money(saldoFinalContable)}
              </div>
            </div>

            {/* ✅ SALDO FINAL = CAJA ESPERADA */}
            <div className="border rounded-2xl p-3 bg-gray-900 text-white">
              <div className="text-xs opacity-80">
                Saldo final (Debe - Haber)
              </div>
              <div className="text-3xl font-extrabold">{money(saldoFinal)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: KPIs grouped in a card */}
      <div className="md:hidden mb-4">
        <div className="border rounded-2xl p-3 bg-white shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-600">
              Saldo final (caja esperada)
            </div>
            <div className="flex items-center gap-3">
              <div className="text-lg font-bold">{money(saldoFinal)}</div>
              <Button
                type="button"
                variant={allCollapsed ? "primary" : "secondary"}
                size="sm"
                onClick={toggleAllKpis}
                className={`!rounded-xl shrink-0 text-xs !px-2.5 !py-1.5 !font-medium ${
                  allCollapsed
                    ? ""
                    : "!bg-gray-100 !text-gray-800 hover:!bg-gray-200"
                }`}
              >
                {allCollapsed ? "Ver indicadores" : "Ocultar"}
              </Button>
            </div>
          </div>

          {/* ✅ KPI NUEVO mobile */}
          <div className="border rounded p-2 bg-gray-50">
            <div className="text-xs text-gray-600">
              Saldo contable (incluye compras dueño)
            </div>
            <div className="font-semibold">{money(saldoFinalContable)}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Libras</div>
              </div>
              {!collapseLibras && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Lbs Cash</div>
                    <div className="font-semibold">
                      {qty3(base?.lbsCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Lbs Crédito</div>
                    <div className="font-semibold">
                      {qty3(base?.lbsCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Total Lbs</div>
                    <div className="font-semibold">
                      {qty3((base?.lbsCash ?? 0) + (base?.lbsCredit ?? 0))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Unidades</div>
              </div>
              {!collapseUnidades && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Unid Cash</div>
                    <div className="font-semibold">
                      {qty3(base?.unitsCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Unid Crédito</div>
                    <div className="font-semibold">
                      {qty3(base?.unitsCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Total Unid</div>
                    <div className="font-semibold">
                      {qty3((base?.unitsCash ?? 0) + (base?.unitsCredit ?? 0))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Ventas / Abonos</div>
              </div>
              {!collapseVentas && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Ventas Cash</div>
                    <div className="font-semibold">
                      {money(base?.salesCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Ventas Crédito</div>
                    <div className="font-semibold">
                      {money(base?.salesCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Abonos al periodo
                    </div>
                    <div className="font-semibold">
                      {money(base?.abonosPeriodo ?? 0)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Formulario dentro de modal: botón disparador */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            setEditingId(null);
            setAssociatedVentasDia("");
            setCorteDesde("");
            setCorteHasta("");
            setModalOpen(true);
          }}
          className="!rounded-xl w-full sm:w-auto"
        >
          Agregar movimiento
        </Button>

        <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full sm:w-auto min-w-0">
          <MobileHtmlSelect
            label="Tipo"
            value={movementTypeFilter}
            onChange={setMovementTypeFilter}
            options={movementTypeFilterSelectOptions}
            sheetTitle="Filtrar por tipo"
            triggerIcon="menu"
            selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} w-full sm:w-72`}
            buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} sm:w-72`}
          />
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setModalOpen(false)}
          />

          <div
            ref={modalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-2xl shadow-xl"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Agregar movimiento</h3>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setModalOpen(false)}
                className="!rounded-xl !text-gray-500 hover:!text-gray-700 !px-2"
                aria-label="Cerrar"
              >
                ✕
              </Button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  {type === "CORTE" ? "Fecha de corte" : "Fecha"}
                </label>
                <input
                  type="date"
                  className="border rounded px-3 py-2 w-full"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>

              <div>
                <MobileHtmlSelect
                  label="Tipo movimiento"
                  value={type}
                  onChange={(v) => setType(v as LedgerType)}
                  options={modalMovementTypeOptions}
                  sheetTitle="Tipo de movimiento"
                  triggerIcon="menu"
                  selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                  buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                />

                {type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" && (
                  <div className="mt-1 text-xs text-sky-700">
                    Este movimiento NO aumenta la caja. Solo registra inventario
                    comprado por el dueño y suma a la deuda.
                  </div>
                )}

                {affectsOwnerDebt(type) &&
                  type !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" && (
                    <div className="mt-1 text-xs text-amber-700">
                      Este movimiento afecta la deuda del negocio con el dueño.
                    </div>
                  )}
              </div>

              {type === "DEPOSITO" && (
                <div className="sm:col-span-2 lg:col-span-3">
                  <MobileHtmlSelect
                    label="Asociar ventas"
                    value={associatedVentasDia}
                    onChange={setAssociatedVentasDia}
                    options={asociarVentasDelDiaOptions}
                    sheetTitle="Asociar ventas del día"
                    triggerIcon="menu"
                    selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                    buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                  />
                  <p className="mt-1 text-xs text-gray-500">
                    Opcional. Solo se lista el resumen &quot;Ventas del día&quot; del
                    mismo día indicado arriba en Fecha.
                  </p>
                </div>
              )}

              {type === "CORTE" && (
                <div className="sm:col-span-2 lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Desde (ventas incluidas)
                    </label>
                    <input
                      type="date"
                      className="border rounded px-3 py-2 w-full"
                      value={corteDesde}
                      onChange={(e) => setCorteDesde(e.target.value)}
                    />
                  </div>
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Hasta (ventas incluidas)
                    </label>
                    <input
                      type="date"
                      className="border rounded px-3 py-2 w-full"
                      value={corteHasta}
                      onChange={(e) => setCorteHasta(e.target.value)}
                    />
                  </div>
                  <p className="sm:col-span-2 text-xs text-gray-500">
                    El detalle del movimiento mostrará las ventas cash (CONTADO) con
                    fecha de venta entre Desde y Hasta, según el periodo cargado.
                  </p>
                </div>
              )}

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Referencia
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Factura, recibo, etc."
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-sm text-gray-600 mb-1">
                  Descripción
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ej: Compra bolsas / Re abastecimiento / Pago proveedor..."
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Entrada (+)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="^\\d*(\\.\\d{0,2})?$"
                  className="border rounded px-3 py-2 w-full"
                  value={inAmount}
                  onChange={(e) => {
                    let val = e.target.value.replace(/,/g, ".");
                    if (
                      /^\d*(\.\d{0,2})?$/.test(val) ||
                      val === "." ||
                      val === ""
                    ) {
                      setInAmount(val === "." ? "." : val);
                    }
                  }}
                  placeholder="0.00"
                  disabled={[
                    "GASTO",
                    "REABASTECIMIENTO",
                    "RETIRO",
                    "DEPOSITO",
                    "CORTE",
                    "PERDIDA",
                    "DEVOLUCION A DUENO POR PRESTAMO",
                  ].includes(String(type))}
                  aria-disabled={[
                    "GASTO",
                    "REABASTECIMIENTO",
                    "RETIRO",
                    "DEPOSITO",
                    "CORTE",
                    "PERDIDA",
                    "DEVOLUCION A DUENO POR PRESTAMO",
                  ].includes(String(type))}
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Salida (−)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="^\\d*(\\.\\d{0,2})?$"
                  className="border rounded px-3 py-2 w-full"
                  value={outAmount}
                  onChange={(e) => {
                    let val = e.target.value.replace(/,/g, ".");
                    if (
                      /^\d*(\.\d{0,2})?$/.test(val) ||
                      val === "." ||
                      val === ""
                    ) {
                      setOutAmount(val === "." ? "." : val);
                    }
                  }}
                  placeholder="0.00"
                  disabled={[
                    "PRESTAMO A NEGOCIO POR DUENO",
                    "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
                  ].includes(String(type))}
                  aria-disabled={[
                    "PRESTAMO A NEGOCIO POR DUENO",
                    "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
                  ].includes(String(type))}
                />
              </div>

              <div className="sm:col-span-3 flex gap-2 justify-end mt-2">
                <Button
                  type="button"
                  variant="outline"
                  onClick={() => setModalOpen(false)}
                  className="!rounded-xl"
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={saveMovement}
                  className="!rounded-xl"
                >
                  Guardar movimiento
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabla ledger (desktop): ancho natural + scroll horizontal */}
      <div className="hidden md:block w-full overflow-x-auto overflow-y-visible rounded-lg border border-gray-200 bg-white shadow-sm overscroll-x-contain [scrollbar-gutter:stable]">
        <p className="px-2 py-1.5 text-[11px] text-gray-500 border-b border-gray-100 bg-gray-50/80">
          Tocá el chip <strong>Mov.</strong> para ver
          descripción, referencia y usuario. U.B. cash = utilidad bruta solo de ventas CONTADO
          (crédito no suma hasta cobrar). La fila verde &quot;Ventas del día&quot; abre el
          detalle de esas ventas.
        </p>
        <table className="w-max min-w-[1040px] border-collapse border border-gray-200 text-sm">
          <thead className="bg-gray-100 sticky top-0 z-10">
            <tr>
              <th className="border border-gray-200 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap min-w-[6.5rem]">Fecha</th>
              <th
                className="border border-gray-200 px-3 py-2.5 text-left text-xs font-semibold whitespace-nowrap min-w-[7rem]"
                title="Tipo de movimiento (clic para ver descripción, referencia y usuario)"
              >
                Movimiento
              </th>
              <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[7.5rem]" title="Entrada">Entrada</th>
              <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[7.5rem]" title="Salida">Salida</th>
              <th
                className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[7.5rem]"
                title="Suma AR del día (solo en la primera fila del día; tocar para detalle)"
              >
                Abonos
              </th>
              <th className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[8rem]" title="Saldo caja">Saldo</th>
              <th
                className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[8rem] bg-violet-50/90"
                title="Suma de utilidad bruta (precio venta − costo) solo de ventas CONTADO del día. No incluye crédito."
              >
                U.B. del día
              </th>
              <th
                className="border border-gray-200 px-3 py-2.5 text-right text-xs font-semibold whitespace-nowrap min-w-[8.5rem] bg-violet-50/90"
                title="Suma acumulada de U.B. cash por fechas de venta ≤ este día (orden cronológico)"
              >
                U.B. acumulada.
              </th>
              <th className="border border-gray-200 px-2 py-2.5 text-center text-xs font-semibold whitespace-nowrap w-14" title="Acciones">Menu</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-center bg-indigo-50">
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">
                {from} → {to}
              </td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-left">
                SALDO_INICIAL
              </td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">{money(saldoBase)}</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">{money(0)}</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-semibold">{money(saldoBase)}</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400 bg-violet-50/40">—</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400 bg-violet-50/40">—</td>
              <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">—</td>
            </tr>

            {displayLedgerWithUb.map((item, rowIdx) => {
              if (item.kind === "cash_sales") {
                return (
                  <tr
                    key={`cash-${item.date}-${item.cashTotal}-${rowIdx}`}
                    role="button"
                    tabIndex={0}
                    className="text-center bg-emerald-50/90 border-t border-emerald-200 cursor-pointer hover:bg-emerald-100/90"
                    onClick={() => setCashSalesDrawerDate(item.date)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ")
                        setCashSalesDrawerDate(item.date);
                    }}
                    title="Clic para ver el detalle de ventas cash de este día"
                  >
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-medium text-emerald-900">
                      {item.date}
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-left">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800">
                        Ventas del día
                      </span>
                    </td>
                    <td
                      className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle tabular-nums font-bold text-green-700 bg-emerald-100/70"
                      title="Suma de montos de ventas CONTADO del día (sin crédito)"
                    >
                      {money(item.cashTotal)}
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">
                      —
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">
                      —
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">
                      —
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400 bg-violet-50/30">
                      —
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400 bg-violet-50/30">
                      —
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">
                      —
                    </td>
                  </tr>
                );
              }
              if (item.kind === "ub") {
                return (
                  <tr
                    key={`ub-${item.date}-${item.cumUb}-${rowIdx}`}
                    className="text-center bg-violet-50/80 border-t border-violet-200"
                  >
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-medium text-violet-900">
                      {item.date}
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-left">
                      <span className="text-[11px] font-semibold uppercase tracking-wide text-violet-800">
                        U.Bruta del día
                      </span>
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-bold tabular-nums text-violet-900 bg-violet-100/60">
                      {money(item.dayGross)}
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-bold tabular-nums text-violet-950 bg-violet-100/80">
                      {money(item.cumUb)}
                    </td>
                    <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-400">—</td>
                  </tr>
                );
              }
              const r = item.row;
              const index = item.origIndex;
              const dk = String(r.date || "").trim().slice(0, 10);
              const abonoDia = dk ? abonosPorDia.get(dk) ?? 0 : 0;
              const isFirstOfDay = abonoColFirstRowOfDay[index] ?? false;
              return (
              <tr key={r.id} className={`text-center ${rowBgByType(r.type)}`}>
                <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">{r.date}</td>
                <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">
                  {typeBadgeButton(r.type, () => setMovimientoDrawerRow(r))}
                </td>
                <td className={`border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle tabular-nums ${Number(r.inAmount || 0) > 0 ? "text-green-700 font-semibold" : "text-gray-300"}`}>{money(r.inAmount)}</td>
                <td className={`border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle tabular-nums ${Number(r.outAmount || 0) > 0 ? "text-red-700 font-semibold" : "text-gray-300"}`}>{money(r.outAmount)}</td>
                <td className={`border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle ${!isFirstOfDay ? "bg-gray-50/40" : ""}`}>
                  {isFirstOfDay ? (
                    abonoDia > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="w-full max-w-[140px] mx-auto !rounded-lg !px-1 !py-0.5 tabular-nums text-xs !text-emerald-800 !font-medium hover:!bg-emerald-50 focus-visible:!ring-2 focus-visible:!ring-emerald-300"
                        title="Ver abonos y ventas de este día"
                        onClick={() => setAbonoDiaDrawerDate(dk)}
                      >
                        {money(abonoDia)}
                      </Button>
                    ) : (
                      <span className="text-gray-400 tabular-nums text-xs">—</span>
                    )
                  ) : null}
                </td>
                <td className={`border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle font-bold tabular-nums ${Number(r.balance) < 0 ? "text-red-700" : "text-gray-900"}`}>{money(r.balance)}</td>
                <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-300 bg-violet-50/20">—</td>
                <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle text-gray-300 bg-violet-50/20">—</td>
                <td className="border border-gray-200 px-3 py-2.5 text-sm whitespace-nowrap align-middle">
                  {r.source === "expenses" ? (
                    <div className="text-xs text-gray-400">
                      Gasto registrado
                    </div>
                  ) : (
                    <div className="flex justify-center">
                      <ActionMenuTrigger
                        onClick={(e) => {
                          e.stopPropagation();
                          const rect =
                            e.currentTarget.getBoundingClientRect();
                          setLedgerRowActionMenu({ rect, row: r });
                        }}
                      />
                    </div>
                  )}
                </td>
              </tr>
            );
            })}

            {filteredLedgerWithBalance.length === 0 &&
              displayLedgerWithUb.length === 0 && (
              <tr>
                <td colSpan={9} className="p-3 text-center text-gray-500">
                  No hay movimientos ni ventas cash en este rango.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-gray-800 text-white">
            <tr>
              <td colSpan={2} className="border border-gray-700 p-2 text-right font-semibold text-sm">Totales</td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-bold text-green-300">{money(saldoBase + tableTotals.totalIn)}</td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-bold text-red-300">{money(tableTotals.totalOut)}</td>
              <td
                className="border border-gray-700 p-2 text-center tabular-nums font-semibold text-emerald-200"
                title="Total abonos AR en el periodo seleccionado."
              >
                {money(totalAbonosArPeriodo)}
              </td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-extrabold text-lg">{money(saldoFinal)}</td>
              <td
                className="border border-gray-700 p-2 text-center tabular-nums font-semibold text-violet-200 bg-violet-950/50"
                title="Suma U.B. cash (CONTADO) del periodo"
              >
                {money(totalUbrutaPeriodo)}
              </td>
              <td
                className="border border-gray-700 p-2 text-center tabular-nums font-semibold text-violet-100 bg-violet-950/50"
                title="Mismo total acumulado al cierre del periodo (solo ventas CONTADO en el rango)"
              >
                {money(cumUbAcumAlCierrePeriodo)}
              </td>
              <td className="border border-gray-700 p-2"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile: ledger as cards */}
      <div className="md:hidden space-y-3">
        {displayLedgerWithUb.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-6">
            Sin movimientos ni ventas cash en este rango.
          </div>
        ) : (
          displayLedgerWithUb.map((item, index) => {
            if (item.kind === "cash_sales") {
              return (
                <div
                  key={`cash-m-${item.date}-${item.cashTotal}-${index}`}
                  role="button"
                  tabIndex={0}
                  className="rounded-xl p-3 bg-emerald-50 border border-emerald-200 shadow-sm cursor-pointer active:bg-emerald-100"
                  onClick={() => setCashSalesDrawerDate(item.date)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ")
                      setCashSalesDrawerDate(item.date);
                  }}
                >
                  <div className="flex justify-between items-center gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase text-emerald-800">
                        Total ventas cash · {item.date}
                      </div>
                      <div className="text-xs text-emerald-700 mt-0.5">
                        Solo CONTADO (sin crédito)
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-[10px] text-emerald-600">Entrada</div>
                      <div className="font-bold tabular-nums text-green-700">
                        {money(item.cashTotal)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            }
            if (item.kind === "ub") {
              return (
                <div
                  key={`ub-m-${item.date}-${item.cumUb}-${index}`}
                  className="rounded-xl p-3 bg-violet-50 border border-violet-200 shadow-sm"
                >
                  <div className="flex justify-between items-center gap-2">
                    <div>
                      <div className="text-[11px] font-semibold uppercase text-violet-800">
                        U. Bruta · {item.date}
                      </div>
                      <div className="text-xs text-violet-700 mt-0.5">
                        Solo ventas CONTADO (cash)
                      </div>
                    </div>
                    <div className="text-right">
                      <div className="text-xs text-violet-600">Día</div>
                      <div className="font-bold tabular-nums text-violet-900">
                        {money(item.dayGross)}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2 pt-2 border-t border-violet-200 flex justify-between text-sm">
                    <span className="text-violet-700">Acumulado</span>
                    <span className="font-bold tabular-nums text-violet-950">
                      {money(item.cumUb)}
                    </span>
                  </div>
                </div>
              );
            }
            const r = item.row;
            const origIndex = item.origIndex;
            const dk = String(r.date || "").trim().slice(0, 10);
            const abonoDia = dk ? abonosPorDia.get(dk) ?? 0 : 0;
            const isFirstOfDay = abonoColFirstRowOfDay[origIndex] ?? false;
            return (
            <div
              key={r.id}
              className={`rounded-xl p-3 bg-white shadow-sm ${borderByType(r.type)}`}
            >
              <div className="flex justify-between items-start gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold">{r.description}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>{r.date}</span>
                    {typeBadgeButton(r.type, () => setMovimientoDrawerRow(r))}
                  </div>
                </div>
                <div className="flex items-start gap-1 shrink-0">
                  {r.source !== "expenses" ? (
                    <ActionMenuTrigger
                      onClick={(e) => {
                        e.stopPropagation();
                        setLedgerRowActionMenu({
                          rect: e.currentTarget.getBoundingClientRect(),
                          row: r,
                        });
                      }}
                    />
                  ) : null}
                  <div className="text-right space-y-0.5">
                    {Number(r.inAmount || 0) > 0 && (
                      <div>
                        <div className="text-sm font-semibold text-green-700 tabular-nums">+{money(r.inAmount)}</div>
                        <div className="text-[10px] text-gray-400">Entrada</div>
                      </div>
                    )}
                    {Number(r.outAmount || 0) > 0 && (
                      <div>
                        <div className="text-sm font-semibold text-red-700 tabular-nums">-{money(r.outAmount)}</div>
                        <div className="text-[10px] text-gray-400">Salida</div>
                      </div>
                    )}
                  </div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-gray-700">
                <div>
                  <div className="text-xs text-gray-500">Referencia</div>
                  <div>{r.reference || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Saldo (CAJA)</div>
                  <div className={`font-bold tabular-nums ${Number(r.balance) < 0 ? "text-red-700" : "text-gray-900"}`}>{money(r.balance)}</div>
                </div>
                {isFirstOfDay ? (
                  <div className="col-span-2">
                    <div className="text-xs text-gray-500">
                      AR del día{" "}
                      <span className="text-gray-400 font-normal">
                        (suma; tocar si hay monto)
                      </span>
                    </div>
                    {abonoDia > 0 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="text-left w-full !rounded-lg tabular-nums !text-emerald-800 !font-medium !py-0.5 hover:!bg-emerald-50 !justify-start"
                        onClick={() => setAbonoDiaDrawerDate(dk)}
                      >
                        {money(abonoDia)}
                      </Button>
                    ) : (
                      <div className="tabular-nums text-gray-400">—</div>
                    )}
                  </div>
                ) : null}
              </div>

              <div className="mt-2 text-sm text-gray-700">
                <div className="text-xs text-gray-500">Usuario</div>
                <div>
                  {r.createdBy?.displayName ||
                    r.createdBy?.name ||
                    r.createdBy?.email ||
                    r.createdBy?.uid ||
                    "—"}
                </div>
              </div>
            </div>
            );
          })
        )}

        {displayLedgerWithUb.length > 0 && (
          <div className="rounded-xl p-3 bg-gray-800 text-white shadow-sm border-l-4 border-l-gray-800 mt-1">
            <div className="flex justify-between items-center">
              <div className="text-sm font-semibold">Totales</div>
              <div className="text-right">
                <div className="text-lg font-extrabold tabular-nums">{money(saldoFinal)}</div>
                <div className="text-[10px] text-gray-300">Saldo final</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-[10px] text-gray-400">Total entradas</div>
                <div className="font-semibold text-green-300 tabular-nums">{money(saldoBase + tableTotals.totalIn)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-400">Total salidas</div>
                <div className="font-semibold text-red-300 tabular-nums">{money(tableTotals.totalOut)}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Drawer: Detalle Existencias */}
      <SlideOverDrawer
        open={kpiDrawer === "existencias"}
        onClose={() => setKpiDrawer(null)}
        title="Detalle de Existencias"
        subtitle={`${from} → ${to}`}
        titleId="drawer-existencias-title"
      >
        <DrawerMoneyStrip
          items={[
            { label: "Libras restantes", value: qty3(invLbsRem), tone: "blue" },
            { label: "Unidades restantes", value: qty3(invUdsRem), tone: "slate" },
            { label: "Valor monetario", value: money(invExistenciasMonetarias), tone: "emerald" },
          ]}
        />
        <DrawerSectionTitle>Lotes con existencia ({batchDetails.length})</DrawerSectionTitle>
        <div className="mt-2 space-y-2">
          {batchDetails.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">Sin existencias en este periodo.</div>
          ) : (
            batchDetails.map((b) => (
              <DrawerDetailDlCard
                key={b.id}
                title={b.productName}
                rows={[
                  { label: "Fecha lote", value: b.date },
                  { label: "Unidad", value: b.unit },
                  { label: "Restante", value: b.remaining.toFixed(3), ddClassName: `text-sm font-bold tabular-nums ${b.remaining > 0 ? "text-green-700" : "text-red-600"}` },
                  { label: "Precio venta", value: money(b.salePrice) },
                  { label: "Valor total", value: money(b.totalValue), ddClassName: "text-sm font-bold tabular-nums text-gray-900" },
                ]}
              />
            ))
          )}
        </div>
      </SlideOverDrawer>

      {/* Drawer: Detalle Saldo Inicial */}
      <SlideOverDrawer
        open={kpiDrawer === "saldo"}
        onClose={() => {
          setKpiDrawer(null);
          setSaldoDrawerTab("ventas");
        }}
        title="Detalle del Saldo Inicial"
        subtitle={`${from} → ${to}`}
        titleId="drawer-saldo-title"
        badge={
          <div
            className="flex gap-2 mt-1"
            role="tablist"
            aria-label="Sección del detalle"
          >
            <Button
              type="button"
              role="tab"
              aria-selected={saldoDrawerTab === "ventas"}
              variant={saldoDrawerTab === "ventas" ? "primary" : "outline"}
              size="sm"
              className={`!rounded-full !text-xs !font-semibold ${
                saldoDrawerTab === "ventas"
                  ? ""
                  : "!bg-white !text-slate-700 !border-slate-200 hover:!bg-slate-50"
              }`}
              onClick={() => setSaldoDrawerTab("ventas")}
            >
              Ventas
            </Button>
            <Button
              type="button"
              role="tab"
              aria-selected={saldoDrawerTab === "abonos"}
              variant={saldoDrawerTab === "abonos" ? "primary" : "outline"}
              size="sm"
              className={`!rounded-full !text-xs !font-semibold ${
                saldoDrawerTab === "abonos"
                  ? ""
                  : "!bg-white !text-slate-700 !border-slate-200 hover:!bg-slate-50"
              }`}
              onClick={() => setSaldoDrawerTab("abonos")}
            >
              Abonos
            </Button>
          </div>
        }
      >
        <DrawerMoneyStrip
          items={[
            { label: "Ventas Cash", value: money(base?.salesCash ?? 0), tone: "blue" },
            { label: "Abonos periodo", value: money(base?.abonosPeriodo ?? 0), tone: "emerald" },
            { label: "Saldo Base", value: money(saldoBase), tone: "slate" },
          ]}
        />

        {saldoDrawerTab === "ventas" ? (
          <>
            <div className="mt-3 rounded-xl border border-emerald-200/90 bg-gradient-to-br from-emerald-50/95 to-white px-3 py-3 shadow-sm">
              <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800/90">
                Utilidad bruta acumulada (ventas cash)
              </div>
              <div className="mt-1 text-xl font-bold tabular-nums text-emerald-950">
                {money(ventasCashUbAcumulada)}
              </div>
            </div>
            <DrawerSectionTitle>Ventas Cash ({salesRows.length})</DrawerSectionTitle>
            <div className="mt-2 space-y-2">
              {salesRows.length === 0 ? (
                <div className="text-sm text-gray-500 text-center py-4">
                  Sin ventas cash en este periodo.
                </div>
              ) : (
                salesRows.map((s) => (
                  <DrawerDetailDlCard
                    key={s.id}
                    title={s.customer}
                    rows={[
                      { label: "Fecha", value: s.date },
                      { label: "Producto", value: s.productName },
                      { label: "Cantidad", value: s.qtyLabel },
                      {
                        label: "Precio unit.",
                        value: money(s.unitPrice),
                        ddClassName: "text-sm tabular-nums text-gray-900",
                      },
                      {
                        label: "Monto",
                        value: money(s.amount),
                        ddClassName:
                          "text-sm font-bold tabular-nums text-green-700",
                      },
                      {
                        label: "Utilidad bruta",
                        value: money(s.grossProfit),
                        ddClassName:
                          "text-sm font-semibold tabular-nums text-emerald-800",
                      },
                    ]}
                  />
                ))
              )}
            </div>
          </>
        ) : (
          <>
            <DrawerSectionTitle>Abonos ({abonosRows.length})</DrawerSectionTitle>
            <div className="mt-2 space-y-2">
              {abonosRows.length === 0 ? (
                <div className="text-sm text-gray-500 text-center py-4">
                  Sin abonos en este periodo.
                </div>
              ) : (
                abonosRows.map((a) => (
                  <DrawerDetailDlCard
                    key={a.id}
                    title={a.customer}
                    rows={[
                      { label: "Fecha", value: a.date },
                      {
                        label: "Monto abono",
                        value: money(a.amount),
                        ddClassName:
                          "text-sm font-bold tabular-nums text-emerald-700",
                      },
                    ]}
                  />
                ))
              )}
            </div>
          </>
        )}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={abonoDiaDrawerDate !== null}
        onClose={() => setAbonoDiaDrawerDate(null)}
        title="Abonos del día"
        subtitle={abonoDiaDrawerDate || ""}
        titleId="drawer-abono-dia-title"
        panelMaxWidthClassName="max-w-2xl"
      >
        {abonosDelDiaSeleccionado.length === 0 ? (
          <p className="text-sm text-gray-500 px-1">
            Sin abonos registrados para esta fecha.
          </p>
        ) : (
          <div className="space-y-6">
            {abonosDelDiaSeleccionado.map((a) => {
              const sale = a.saleId ? saleCache[a.saleId] : undefined;
              return (
                <div
                  key={a.id}
                  className="border-b border-gray-100 pb-4 last:border-0 last:pb-0"
                >
                  <DrawerSectionTitle className="mt-0 mb-2">
                    {a.customer} · {money(a.amount)}
                  </DrawerSectionTitle>
                  <DrawerDetailDlCard
                    title="Abono"
                    rows={[
                      { label: "Fecha", value: a.date },
                      {
                        label: "Monto",
                        value: money(a.amount),
                        ddClassName:
                          "text-sm font-bold tabular-nums text-emerald-700",
                      },
                      { label: "Comentario", value: a.comment || "—" },
                      ...(a.saleId
                        ? [
                            {
                              label: "ID venta",
                              value: a.saleId,
                            },
                          ]
                        : []),
                    ]}
                  />
                  {a.saleId ? (
                    <>
                      <DrawerSectionTitle className="mt-3 mb-2">
                        Venta asociada
                      </DrawerSectionTitle>
                      {sale ? (
                        (sale as Record<string, unknown>)._missing ? (
                          <p className="text-sm text-amber-800 px-1">
                            No se encontró la venta{" "}
                            <span className="font-mono text-xs">{a.saleId}</span>{" "}
                            en salesV2.
                          </p>
                        ) : (
                          <DrawerDetailDlCard
                            title={String(
                              sale.customerName || sale.customer || "Venta",
                            )}
                            rows={buildSaleDetailRows(
                              sale as Record<string, unknown> & { id?: string },
                            )}
                          />
                        )
                      ) : (
                        <p className="text-sm text-gray-500 px-1">
                          Cargando venta…
                        </p>
                      )}
                    </>
                  ) : null}
                </div>
              );
            })}
          </div>
        )}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={movimientoDrawerRow !== null}
        onClose={() => setMovimientoDrawerRow(null)}
        title="Detalle del movimiento"
        subtitle={
          movimientoDrawerRow
            ? String(movimientoDrawerRow.date || "")
            : undefined
        }
        titleId="drawer-movimiento-caja-title"
        panelMaxWidthClassName="max-w-2xl"
      >
        {movimientoDrawerRow ? (
          <div className="space-y-0">
            <DrawerDetailDlCard
              title={String(movimientoDrawerRow.type || "—")}
              rows={[
                {
                  label:
                    movimientoDrawerRow.type === "CORTE"
                      ? "Fecha de corte"
                      : "Fecha",
                  value: String(movimientoDrawerRow.date || "—"),
                },
                {
                  label: "Descripción",
                  value: String(movimientoDrawerRow.description || "—"),
                  ddClassName: "text-sm text-gray-800",
                },
                {
                  label: "Referencia",
                  value: String(movimientoDrawerRow.reference || "—"),
                },
                ...(movimientoDrawerRow.type === "DEPOSITO"
                  ? [
                      {
                        label: "Asociar ventas (día)",
                        value: String(
                          (movimientoDrawerRow as LedgerRow).associatedVentasDia ||
                            "—",
                        ),
                        ddClassName: "text-sm font-medium text-emerald-800",
                      },
                    ]
                  : []),
                ...(movimientoDrawerRow.type === "CORTE"
                  ? [
                      {
                        label: "Ventas incluidas desde",
                        value: String(
                          (movimientoDrawerRow as LedgerRow).corteDesde || "—",
                        ),
                        ddClassName: "text-sm font-medium text-purple-900",
                      },
                      {
                        label: "Ventas incluidas hasta",
                        value: String(
                          (movimientoDrawerRow as LedgerRow).corteHasta || "—",
                        ),
                        ddClassName: "text-sm font-medium text-purple-900",
                      },
                    ]
                  : []),
                {
                  label: "Entrada",
                  value: money(movimientoDrawerRow.inAmount),
                  ddClassName: "tabular-nums text-emerald-800 font-semibold",
                },
                {
                  label: "Salida",
                  value: money(movimientoDrawerRow.outAmount),
                  ddClassName: "tabular-nums text-red-800 font-semibold",
                },
                {
                  label: "Saldo (CAJA)",
                  value: money(movimientoDrawerRow.balance),
                  ddClassName: "tabular-nums font-bold",
                },
                {
                  label: "Saldo contable",
                  value: money(movimientoDrawerRow.accountingBalance),
                  ddClassName: "tabular-nums",
                },
                {
                  label: "Fuente",
                  value: String(movimientoDrawerRow.source || "ledger"),
                },
                {
                  label: "Usuario",
                  value:
                    movimientoDrawerRow.createdBy?.displayName ||
                    movimientoDrawerRow.createdBy?.name ||
                    movimientoDrawerRow.createdBy?.email ||
                    movimientoDrawerRow.createdBy?.uid ||
                    "—",
                  ddClassName: "text-sm",
                },
                {
                  label: "ID",
                  value: String(movimientoDrawerRow.id || "—"),
                  ddClassName: "font-mono text-xs",
                },
              ]}
            />
            {movimientoDrawerRow.type === "DEPOSITO" && depositoAssocVentasDate ? (
              <>
                <DrawerSectionTitle className="mt-4 mb-2">
                  Ventas asociadas · {depositoAssocVentasDate}
                </DrawerSectionTitle>
                {depositoDrawerLines.length === 0 ? (
                  <p className="text-sm text-gray-500 px-1">
                    Sin ventas CONTADO para esta fecha en el periodo cargado.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <DrawerStatGrid
                      items={[
                        {
                          label: "Cant. productos (distintos)",
                          value: depositoDrawerKpis.productCount,
                          tone: "slate",
                        },
                        {
                          label: "Líneas",
                          value: depositoDrawerKpis.lineCount,
                          tone: "sky",
                        },
                        {
                          label: "Libras (tipo libra)",
                          value: qty3(depositoDrawerKpis.lbs),
                          tone: "amber",
                        },
                        {
                          label: "Unidades (no libra)",
                          value: qty3(depositoDrawerKpis.units),
                          tone: "violet",
                        },
                        {
                          label: "Monto",
                          value: money(depositoDrawerKpis.amount),
                          tone: "indigo",
                        },
                        {
                          label: "Utilidad bruta",
                          value: money(depositoDrawerKpis.grossProfit),
                          tone: "emerald",
                        },
                      ]}
                    />
                    <DrawerSectionTitle className="mt-0">
                      {depositoDrawerLines.length} línea(s) · solo cash (CONTADO)
                    </DrawerSectionTitle>
                    {depositoDrawerLines.map((line) => (
                      <DrawerDetailDlCard
                        key={line.id}
                        title={line.productName}
                        rows={[
                          { label: "Fecha venta", value: line.date },
                          {
                            label: "Precio",
                            value: money(line.unitPrice),
                            ddClassName: "tabular-nums",
                          },
                          {
                            label: "Cantidad",
                            value: line.qtyLabel,
                          },
                          {
                            label: "Monto",
                            value: money(line.amount),
                            ddClassName: "tabular-nums font-semibold",
                          },
                          {
                            label: "U. bruta",
                            value: money(line.grossProfit),
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
              </>
            ) : null}
            {movimientoDrawerRow.type === "CORTE" && corteAssocRange ? (
              <>
                <DrawerSectionTitle className="mt-4 mb-2">
                  Ventas del corte · {corteAssocRange.desde} →{" "}
                  {corteAssocRange.hasta}
                </DrawerSectionTitle>
                {corteDrawerLines.length === 0 ? (
                  <p className="text-sm text-gray-500 px-1">
                    Sin ventas CONTADO en ese rango en el periodo cargado (ampliá
                    Desde/Hasta en filtros o recargá).
                  </p>
                ) : (
                  <div className="space-y-3">
                    <DrawerStatGrid
                      items={[
                        {
                          label: "Cant. productos (distintos)",
                          value: corteDrawerKpis.productCount,
                          tone: "slate",
                        },
                        {
                          label: "Líneas",
                          value: corteDrawerKpis.lineCount,
                          tone: "sky",
                        },
                        {
                          label: "Libras (tipo libra)",
                          value: qty3(corteDrawerKpis.lbs),
                          tone: "amber",
                        },
                        {
                          label: "Unidades (no libra)",
                          value: qty3(corteDrawerKpis.units),
                          tone: "violet",
                        },
                        {
                          label: "Monto",
                          value: money(corteDrawerKpis.amount),
                          tone: "indigo",
                        },
                        {
                          label: "Utilidad bruta",
                          value: money(corteDrawerKpis.grossProfit),
                          tone: "emerald",
                        },
                      ]}
                    />
                    <DrawerSectionTitle className="mt-0">
                      {corteDrawerLines.length} línea(s) · solo cash (CONTADO)
                    </DrawerSectionTitle>
                    {corteDrawerLines.map((line, corteLineIdx) => (
                      <DrawerDetailDlCard
                        key={`${line.id}-${line.date}-${corteLineIdx}`}
                        title={line.productName}
                        rows={[
                          { label: "Fecha venta", value: line.date },
                          {
                            label: "Precio",
                            value: money(line.unitPrice),
                            ddClassName: "tabular-nums",
                          },
                          {
                            label: "Cantidad",
                            value: line.qtyLabel,
                          },
                          {
                            label: "Monto",
                            value: money(line.amount),
                            ddClassName: "tabular-nums font-semibold",
                          },
                          {
                            label: "U. bruta",
                            value: money(line.grossProfit),
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
              </>
            ) : movimientoDrawerRow.type === "CORTE" ? (
              <p className="text-sm text-amber-800 px-1 mt-4">
                Guardá Desde y Hasta válidos en el movimiento para listar las
                ventas cortadas.
              </p>
            ) : null}
          </div>
        ) : null}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={cashSalesDrawerDate !== null}
        onClose={() => setCashSalesDrawerDate(null)}
        title="Ventas cash del día"
        subtitle={cashSalesDrawerDate || ""}
        titleId="drawer-ventas-cash-dia-title"
        panelMaxWidthClassName="max-w-2xl"
      >
        {cashLinesForDrawer.length === 0 ? (
          <p className="text-sm text-gray-500 px-1">
            Sin ventas CONTADO para esta fecha en el periodo cargado.
          </p>
        ) : (
          <div className="space-y-3">
            <DrawerStatGrid
              items={[
                {
                  label: "Cant. productos (distintos)",
                  value: cashSalesDrawerKpis.productCount,
                  tone: "slate",
                },
                {
                  label: "Líneas",
                  value: cashSalesDrawerKpis.lineCount,
                  tone: "sky",
                },
                {
                  label: "Libras (tipo libra)",
                  value: qty3(cashSalesDrawerKpis.lbs),
                  tone: "amber",
                },
                {
                  label: "Unidades (no libra)",
                  value: qty3(cashSalesDrawerKpis.units),
                  tone: "violet",
                },
                {
                  label: "Monto",
                  value: money(cashSalesDrawerKpis.amount),
                  tone: "indigo",
                },
                {
                  label: "Utilidad bruta",
                  value: money(cashSalesDrawerKpis.grossProfit),
                  tone: "emerald",
                },
              ]}
            />
            <DrawerSectionTitle className="mt-0">
              {cashLinesForDrawer.length} línea(s) · solo cash (CONTADO)
            </DrawerSectionTitle>
            {cashLinesForDrawer.map((line) => (
              <DrawerDetailDlCard
                key={line.id}
                title={line.productName}
                rows={[
                  { label: "Fecha venta", value: line.date },
                  {
                    label: "Precio",
                    value: money(line.unitPrice),
                    ddClassName: "tabular-nums",
                  },
                  {
                    label: "Cantidad",
                    value: line.qtyLabel,
                  },
                  {
                    label: "Monto",
                    value: money(line.amount),
                    ddClassName: "tabular-nums font-semibold",
                  },
                  {
                    label: "U. bruta",
                    value: money(line.grossProfit),
                    ddClassName: "tabular-nums text-violet-800 font-semibold",
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

      <ActionMenu
        anchorRect={ledgerRowActionMenu?.rect ?? null}
        isOpen={!!ledgerRowActionMenu}
        onClose={() => setLedgerRowActionMenu(null)}
        width={200}
      >
        {ledgerRowActionMenu && (
          <div className="py-1">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClass}
              onClick={() => openLedgerEditModal(ledgerRowActionMenu.row)}
            >
              Editar
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClassDestructive}
              onClick={async () => {
                const r = ledgerRowActionMenu.row;
                setLedgerRowActionMenu(null);
                if (!window.confirm("Eliminar este movimiento?")) return;
                try {
                  await deleteDoc(doc(db, "cash_ledger_pollo", r.id));
                  refresh();
                  setToastMsg("✅ Movimiento eliminado.");
                } catch (e) {
                  console.error("Error eliminando movimiento:", e);
                  setToastMsg(
                    "❌ No se pudo eliminar el movimiento. Revisa la consola.",
                  );
                }
              }}
            >
              Eliminar
            </Button>
          </div>
        )}
      </ActionMenu>

      {toastMsg && (
        <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      )}
    </div>
  );
}
