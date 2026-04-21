import {
  addDoc,
  collection,
  deleteDoc,
  deleteField,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";
import { fetchGlobalInventoryKpisPollo } from "./inventory_evolution_pollo";
import { roundQty } from "./decimal";

const round2 = (n: number) =>
  Math.round((Number(n) + Number.EPSILON) * 100) / 100;
const round3n = (n: number) =>
  Math.round((Number(n) || 0) * 1000) / 1000;

const mStr = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .trim();

/** Misma lógica que evolutivo: lb / libras vs resto (incl. cajilla → unidades). */
export function measurementIsLbPollo(m: unknown): boolean {
  return ["lb", "lbs", "libra", "libras"].includes(mStr(m));
}

const toDateKey = (v: unknown): string => {
  if (v == null) return "";
  if (typeof v === "string") {
    const s = v.trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return "";
  }
  if (typeof v === "number") {
    const d = new Date(v);
    if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    return "";
  }
  try {
    const anyV = v as { toDate?: () => Date };
    if (anyV && typeof anyV.toDate === "function") {
      const d = anyV.toDate();
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    if (v instanceof Date && !isNaN(v.getTime()))
      return v.toISOString().slice(0, 10);
  } catch {
    /* ignore */
  }
  return "";
};

function batchRowDate(b: Record<string, unknown>): string {
  return (
    toDateKey(b.date) ||
    toDateKey(b.createdAt) ||
    toDateKey(b.created_at) ||
    toDateKey(b.paidAt) ||
    toDateKey(b.batchDate) ||
    toDateKey(b.batch_date) ||
    ""
  );
}

/**
 * Arma el reporte del corte desde datos ya guardados:
 * - Ingresos lb/un: `inventory_batches` (fecha del lote en rango)
 * - Ventas: `salesV2` (`date` en rango)
 * - Pérdidas (merma/robo): `inventory_adjustments_pollo`
 * - Facturado a costo: Σ cantidad × precio compra en lotes del rango
 * - Ganancia bruta: Σ `grossProfitTotal` de ventas
 * - Ganancia neta aprox.: bruta − gastos **pagados** en `expenses` en el mismo rango
 */
export async function computeInventoryCutoffReportPollo(
  from: string,
  to: string,
): Promise<InventoryCutoffReportNumbers> {
  if (!from || !to || from > to) {
    throw new Error("Indicá periodo desde y hasta válidos (yyyy-MM-dd).");
  }

  const kpis = await fetchGlobalInventoryKpisPollo(from, to);

  const saleSnap = await getDocs(
    query(
      collection(db, "salesV2"),
      where("date", ">=", from),
      where("date", "<=", to),
    ),
  );

  let soldAmount = 0;
  let grossProfitSum = 0;
  let lbsSold = 0;
  let unitsSold = 0;

  saleSnap.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    soldAmount += Number(
      x.amountCharged ?? x.itemsTotal ?? x.amount ?? 0,
    );
    grossProfitSum += Number(x.grossProfitTotal ?? 0);

    const items = x.items;
    if (Array.isArray(items) && items.length > 0) {
      for (const it of items as Record<string, unknown>[]) {
        const qty = Number(it.qty ?? it.quantity ?? 0);
        if (qty <= 0) continue;
        const meas = it.measurement ?? it.unit ?? "";
        if (measurementIsLbPollo(meas)) lbsSold += qty;
        else unitsSold += qty;
      }
      return;
    }
    const qty = Number(x.quantity ?? 0);
    if (qty <= 0) return;
    const meas = x.measurement ?? "lb";
    if (measurementIsLbPollo(meas)) lbsSold += qty;
    else unitsSold += qty;
  });

  let lbsLost = 0;
  let unitsLost = 0;
  try {
    const adjSnap = await getDocs(
      query(
        collection(db, "inventory_adjustments_pollo"),
        where("date", ">=", from),
        where("date", "<=", to),
      ),
    );
    adjSnap.forEach((d) => {
      const a = d.data() as Record<string, unknown>;
      const qty = Number(a.qty ?? 0);
      if (qty <= 0) return;
      if (measurementIsLbPollo(a.measurement)) lbsLost += qty;
      else unitsLost += qty;
    });
  } catch {
    /* colección o índice: dejar pérdidas en 0 */
  }

  let invoicedAtCost = 0;
  const invSnap = await getDocs(collection(db, "inventory_batches"));
  invSnap.forEach((d) => {
    const b = d.data() as Record<string, unknown>;
    const date = batchRowDate(b);
    if (!date || date < from || date > to) return;
    const qty = Number(b.quantity ?? 0);
    const pp = Number(b.purchasePrice ?? 0);
    invoicedAtCost += qty * pp;
  });

  let expensesPaid = 0;
  try {
    const exSnap = await getDocs(collection(db, "expenses"));
    exSnap.forEach((d) => {
      const x = d.data() as Record<string, unknown>;
      const dt = String(x.date ?? "");
      if (!dt || dt < from || dt > to) return;
      const st = String(x.status ?? "PAGADO").toUpperCase();
      if (st !== "PAGADO") return;
      expensesPaid += Number(x.amount ?? 0);
    });
  } catch {
    /* sin gastos */
  }

  const gross = round2(grossProfitSum);
  const net = round2(grossProfitSum - expensesPaid);

  return {
    invoicedAtCost: round2(invoicedAtCost),
    soldAmount: round2(soldAmount),
    lbsIn: round3n(kpis.incomingLbs),
    lbsSold: round3n(lbsSold),
    lbsLost: round3n(lbsLost),
    unitsIn: round3n(kpis.incomingUnits),
    unitsSold: round3n(unitsSold),
    unitsLost: round3n(unitsLost),
    grossProfit: gross,
    netProfit: net,
  };
}

export const INVENTORY_CUTOFFS_COLLECTION = "inventory_cutoffs";

/** Totales del reporte al corte (manual o calculado en el futuro). */
export type InventoryCutoffReportNumbers = {
  /** Facturado a costo (compras / valor a costo facturado en el periodo). */
  invoicedAtCost: number;
  /** Vendido (ingresos por ventas en el periodo). */
  soldAmount: number;
  lbsIn: number;
  lbsSold: number;
  lbsLost: number;
  unitsIn: number;
  unitsSold: number;
  unitsLost: number;
  grossProfit: number;
  netProfit: number;
};

/** Opcional: notas de conciliación. No mueve caja por sí solo. */
export type InventoryCutoffFinancial = {
  notes?: string;
  /** Referencia a un gasto ya cargado en el módulo Gastos (ese sí puede afectar caja). */
  expenseDocumentId?: string;
  /** @deprecated Solo lectura de cortes viejos; ya no se guarda desde el formulario. */
  moneyImpactRegistered?: number;
};

export type InventoryCutoffRecord = {
  id: string;
  cutoffDate: string;
  /** Etiqueta visible, ej. "Ciclo 26/04/2026". */
  displayLabel: string;
  periodFrom?: string;
  periodTo?: string;
  report: InventoryCutoffReportNumbers;
  financial?: InventoryCutoffFinancial;
  createdAt: Timestamp;
  createdByEmail?: string;
};

function docToRecord(id: string, data: Record<string, unknown>): InventoryCutoffRecord {
  const report = (data.report || {}) as Partial<InventoryCutoffReportNumbers>;
  const financial = data.financial as InventoryCutoffFinancial | undefined;
  return {
    id,
    cutoffDate: String(data.cutoffDate ?? ""),
    displayLabel: String(data.displayLabel ?? ""),
    periodFrom: data.periodFrom ? String(data.periodFrom) : undefined,
    periodTo: data.periodTo ? String(data.periodTo) : undefined,
    report: {
      invoicedAtCost: Number(report.invoicedAtCost ?? 0),
      soldAmount: Number(report.soldAmount ?? 0),
      lbsIn: Number(report.lbsIn ?? 0),
      lbsSold: Number(report.lbsSold ?? 0),
      lbsLost: Number(report.lbsLost ?? 0),
      unitsIn: Number(report.unitsIn ?? 0),
      unitsSold: Number(report.unitsSold ?? 0),
      unitsLost: Number(report.unitsLost ?? 0),
      grossProfit: Number(report.grossProfit ?? 0),
      netProfit: Number(report.netProfit ?? 0),
    },
    financial: financial
      ? {
          moneyImpactRegistered: Number(financial.moneyImpactRegistered ?? 0),
          notes: financial.notes,
          expenseDocumentId: financial.expenseDocumentId,
        }
      : undefined, // moneyImpactRegistered: legado
    createdAt: (data.createdAt as Timestamp) ?? Timestamp.now(),
    createdByEmail: data.createdByEmail
      ? String(data.createdByEmail)
      : undefined,
  };
}

export async function fetchInventoryCutoffsPollo(): Promise<
  InventoryCutoffRecord[]
> {
  const q = query(
    collection(db, INVENTORY_CUTOFFS_COLLECTION),
    orderBy("createdAt", "desc"),
  );
  const snap = await getDocs(q);
  const list: InventoryCutoffRecord[] = [];
  snap.forEach((d) => {
    list.push(docToRecord(d.id, d.data() as Record<string, unknown>));
  });
  return list;
}

export async function createInventoryCutoffPollo(input: {
  cutoffDate: string;
  displayLabel: string;
  periodFrom?: string;
  periodTo?: string;
  report: InventoryCutoffReportNumbers;
  financial?: Pick<InventoryCutoffFinancial, "notes" | "expenseDocumentId">;
  createdByEmail?: string;
}): Promise<string> {
  const fin = input.financial;
  const financialPayload =
    fin && (fin.notes?.trim() || fin.expenseDocumentId?.trim())
      ? {
          notes: fin.notes?.trim() || null,
          expenseDocumentId: fin.expenseDocumentId?.trim() || null,
        }
      : null;

  const ref = await addDoc(collection(db, INVENTORY_CUTOFFS_COLLECTION), {
    cutoffDate: input.cutoffDate,
    displayLabel: input.displayLabel,
    periodFrom: input.periodFrom || null,
    periodTo: input.periodTo || null,
    report: input.report,
    financial: financialPayload,
    createdAt: Timestamp.now(),
    createdByEmail: input.createdByEmail || null,
  });
  await applyCutoffSnapshotToBatchesPollo(
    input.cutoffDate.trim(),
    input.periodFrom,
    input.periodTo,
  );
  return ref.id;
}

const FIRESTORE_BATCH_MAX = 450;

/**
 * Marca lotes con existencia (chip "Al ciclo" en inventario).
 * Si el corte trae periodo desde/hasta: solo lotes cuya fecha de ingreso está en ese rango (inclusive).
 * Si no hay periodo válido: solo lotes con fecha de ingreso ≤ fecha de corte (compatibilidad).
 */
export async function applyCutoffSnapshotToBatchesPollo(
  cutoffDate: string,
  periodFrom?: string | null,
  periodTo?: string | null,
): Promise<number> {
  const cd = String(cutoffDate || "").trim();
  if (!cd) return 0;
  const pf = String(periodFrom ?? "").trim();
  const pt = String(periodTo ?? "").trim();
  const useRange = Boolean(pf && pt && pf <= pt);

  const snap = await getDocs(collection(db, "inventory_batches"));
  const toUpdate: { ref: ReturnType<typeof doc>; rem: number }[] = [];
  snap.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    const date = String(x.date ?? "");
    if (!date) return;
    if (useRange) {
      if (date < pf || date > pt) return;
    } else if (date > cd) {
      return;
    }
    const rem = roundQty(Number(x.remaining ?? 0));
    if (rem <= 0) return;
    toUpdate.push({ ref: d.ref, rem });
  });
  for (let i = 0; i < toUpdate.length; i += FIRESTORE_BATCH_MAX) {
    const chunk = toUpdate.slice(i, i + FIRESTORE_BATCH_MAX);
    const wb = writeBatch(db);
    for (const { ref, rem } of chunk) {
      wb.update(ref, {
        cycleCutoffDate: cd,
        cycleQtyAtClose: rem,
        cycleQtyPostMerma: rem,
      });
    }
    await wb.commit();
  }
  return toUpdate.length;
}

/** Quita ciclo de lotes que tenían esta fecha de corte (al borrar o cambiar fecha). */
export async function clearCutoffSnapshotFromBatchesPollo(
  cutoffDate: string,
): Promise<void> {
  const cd = String(cutoffDate || "").trim();
  if (!cd) return;
  const snap = await getDocs(collection(db, "inventory_batches"));
  const chunk: ReturnType<typeof doc>[] = [];
  snap.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    if (String(x.cycleCutoffDate ?? "") !== cd) return;
    chunk.push(d.ref);
  });
  for (let i = 0; i < chunk.length; i += FIRESTORE_BATCH_MAX) {
    const wb = writeBatch(db);
    const part = chunk.slice(i, i + FIRESTORE_BATCH_MAX);
    for (const ref of part) {
      wb.update(ref, {
        cycleCutoffDate: deleteField(),
        cycleQtyAtClose: deleteField(),
        cycleQtyPostMerma: deleteField(),
      });
    }
    await wb.commit();
  }
}

export async function updateInventoryCutoffPollo(
  id: string,
  input: {
    cutoffDate: string;
    displayLabel: string;
    periodFrom?: string | null;
    periodTo?: string | null;
    report: InventoryCutoffReportNumbers;
    financial?: Pick<InventoryCutoffFinancial, "notes" | "expenseDocumentId">;
  },
): Promise<void> {
  const fin = input.financial;
  const financialPayload =
    fin && (fin.notes?.trim() || fin.expenseDocumentId?.trim())
      ? {
          notes: fin.notes?.trim() || null,
          expenseDocumentId: fin.expenseDocumentId?.trim() || null,
        }
      : null;

  const ref = doc(db, INVENTORY_CUTOFFS_COLLECTION, id);
  const prevSnap = await getDoc(ref);
  const prevDate = prevSnap.exists()
    ? String((prevSnap.data() as Record<string, unknown>).cutoffDate ?? "")
    : "";

  await updateDoc(ref, {
    cutoffDate: input.cutoffDate.trim(),
    displayLabel: input.displayLabel.trim(),
    periodFrom: input.periodFrom?.trim() || null,
    periodTo: input.periodTo?.trim() || null,
    report: input.report,
    financial: financialPayload ?? null,
  });

  const nextDate = input.cutoffDate.trim();
  if (prevDate && prevDate !== nextDate) {
    await clearCutoffSnapshotFromBatchesPollo(prevDate);
  }
  await clearCutoffSnapshotFromBatchesPollo(nextDate);
  await applyCutoffSnapshotToBatchesPollo(
    nextDate,
    input.periodFrom,
    input.periodTo,
  );
}

export async function deleteInventoryCutoffPollo(id: string): Promise<void> {
  const ref = doc(db, INVENTORY_CUTOFFS_COLLECTION, id);
  const prevSnap = await getDoc(ref);
  const prevDate = prevSnap.exists()
    ? String((prevSnap.data() as Record<string, unknown>).cutoffDate ?? "")
    : "";
  await deleteDoc(ref);
  if (prevDate) await clearCutoffSnapshotFromBatchesPollo(prevDate);
}
