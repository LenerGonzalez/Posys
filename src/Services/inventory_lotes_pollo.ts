// src/Services/inventory_lotes_pollo.ts
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

const normKey = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

export const toDateKeyLot = (v: unknown): string => {
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
    if (v instanceof Date) {
      if (!isNaN(v.getTime())) return v.toISOString().slice(0, 10);
    }
  } catch {
    /* noop */
  }
  return "";
};

export type LotBatchLine = {
  id: string;
  groupId: string;
  orderName: string;
  date: string;
  productId: string;
  productName: string;
  unit: string;
  quantity: number;
  remaining: number;
  invoiceTotal: number;
  expectedTotal: number;
  purchasePrice: number;
  salePrice: number;
};

export type LotGroup = {
  groupId: string;
  orderName: string;
  displayDate: string;
  lines: LotBatchLine[];
};

/** Lotes agrupados (batchGroupId || id) con al menos una línea con fecha en [from, to]. */
export async function fetchLotGroupsInRange(
  from: string,
  to: string,
): Promise<LotGroup[]> {
  const snap = await getDocs(collection(db, "inventory_batches"));
  const rawLines: LotBatchLine[] = [];

  snap.forEach((d) => {
    const b = d.data() as Record<string, unknown>;
    const date =
      toDateKeyLot(b.date) ||
      toDateKeyLot(b.createdAt) ||
      toDateKeyLot(b.created_at) ||
      "";
    const batchGroupId = String(b.batchGroupId ?? "").trim();
    const groupId = batchGroupId || d.id;
    const orderName = String(b.orderName ?? "").trim();
    rawLines.push({
      id: d.id,
      groupId,
      orderName,
      date,
      productId: String(b.productId ?? "").trim(),
      productName: String(b.productName ?? "").trim(),
      unit: String(b.unit ?? b.measurement ?? "").trim(),
      quantity: Number(b.quantity ?? 0),
      remaining: Number(b.remaining ?? b.quantity ?? 0),
      invoiceTotal: Number(b.invoiceTotal ?? 0),
      expectedTotal: Number(b.expectedTotal ?? 0),
      purchasePrice: Number(b.purchasePrice ?? 0),
      salePrice: Number(b.salePrice ?? 0),
    });
  });

  const byGroup = new Map<string, LotBatchLine[]>();
  for (const L of rawLines) {
    if (!byGroup.has(L.groupId)) byGroup.set(L.groupId, []);
    byGroup.get(L.groupId)!.push(L);
  }

  const groups: LotGroup[] = [];
  for (const [groupId, lines] of byGroup) {
    const inRange = lines.some(
      (L) => L.date && L.date >= from && L.date <= to,
    );
    if (!inRange) continue;

    const dates = lines.map((l) => l.date).filter(Boolean).sort();
    const displayDate = dates[0] || "";
    const nameFromOrder = lines.find((l) => l.orderName)?.orderName;
    const orderName =
      nameFromOrder || lines.map((l) => l.productName).filter(Boolean)[0] || "—";

    groups.push({
      groupId,
      orderName,
      displayDate,
      lines,
    });
  }

  groups.sort((a, b) => {
    const c = a.displayDate.localeCompare(b.displayDate);
    if (c !== 0) return -c;
    return a.orderName.localeCompare(b.orderName);
  });

  return groups;
}

export type LotSaleAllocHit = {
  saleId: string;
  saleDate: string;
  isCash: boolean;
  itemIndex: number;
  batchId: string;
  allocQty: number;
  productId: string;
  productName: string;
  measurement: string;
  /** qty total de la línea de venta */
  lineQty: number;
  lineFinal: number;
  grossProfit: number;
  unitPrice: number;
  discount: number;
  seller: string;
  customerLabel: string;
};

function extractAllocationsFromItem(
  it: Record<string, unknown>,
): { batchId: string; qty: number }[] {
  const out: { batchId: string; qty: number }[] = [];
  const raw = it.allocations;
  if (Array.isArray(raw)) {
    for (const a of raw) {
      const row = a as Record<string, unknown>;
      const batchId = String(row.batchId ?? "").trim();
      const qty = Number(row.qty ?? 0);
      if (batchId && qty > 0) out.push({ batchId, qty });
    }
    return out;
  }
  if (raw && typeof raw === "object") {
    for (const a of Object.values(raw)) {
      const row = a as Record<string, unknown>;
      const batchId = String(row.batchId ?? "").trim();
      const qty = Number(row.qty ?? 0);
      if (batchId && qty > 0) out.push({ batchId, qty });
    }
  }
  return out;
}

/** Ventas en [from, to] con items; se filtran asignaciones a batchIds después. */
export async function fetchSalesV2ForLotView(
  from: string,
  to: string,
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const qs = query(collection(db, "salesV2"), where("date", ">=", from));
  const snap = await getDocs(qs);
  const out: Array<{ id: string; data: Record<string, unknown> }> = [];
  snap.forEach((d) => {
    const x = d.data() as Record<string, unknown>;
    const day = String(x.date ?? "")
      .trim()
      .slice(0, 10);
    if (!day || day > to) return;
    out.push({ id: d.id, data: x });
  });
  return out;
}

export function collectLotSaleAllocHits(
  sales: Array<{ id: string; data: Record<string, unknown> }>,
  batchIds: Set<string>,
): LotSaleAllocHit[] {
  const hits: LotSaleAllocHit[] = [];

  for (const { id: saleId, data: x } of sales) {
    const saleDate = String(x.date ?? "")
      .trim()
      .slice(0, 10);
    if (!saleDate) continue;

    const saleType = String(x.type ?? "CONTADO").toUpperCase();
    const isCash = saleType === "CONTADO";

    const seller =
      String(
        x.userEmail ||
          x.vendor ||
          (x.createdBy as { email?: string } | null)?.email ||
          "—",
      ).trim() || "—";

    const customerLabel =
      String(x.customerName || x.clientName || "")
        .trim() || "—";

    const items = Array.isArray(x.items)
      ? (x.items as Record<string, unknown>[])
      : [];

    if (items.length === 0) continue;

    items.forEach((it, itemIndex) => {
      const allocs = extractAllocationsFromItem(it);
      if (allocs.length === 0) return;

      const lineQty = Number(it.qty ?? it.quantity ?? 0);
      const lineBase =
        Number(it.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it.unitPrice || 0) * lineQty - Number(it.discount || 0),
        );
      const cogs = Number(it.cogsAmount ?? 0);
      const g = Number(it.grossProfit);
      const grossProfit = Number.isFinite(g)
        ? round3(g)
        : round3(lineBase - cogs);
      const unitPrice = Number(it.unitPrice ?? 0);
      const discount = Number(it.discount ?? 0);
      const productId = String(it.productId ?? "").trim();
      const productName = String(it.productName ?? "").trim();
      const measurement = String(it.measurement ?? it.unit ?? "").trim();

      for (const a of allocs) {
        if (!batchIds.has(a.batchId)) continue;
        hits.push({
          saleId,
          saleDate,
          isCash,
          itemIndex,
          batchId: a.batchId,
          allocQty: round3(a.qty),
          productId,
          productName,
          measurement,
          lineQty,
          lineFinal: round3(lineBase),
          grossProfit,
          unitPrice,
          discount,
          seller,
          customerLabel,
        });
      }
    });
  }

  return hits;
}

/** Monto atribuido al lote para una asignación (prorrateo por cantidad de línea). */
export function allocLineAmount(hit: LotSaleAllocHit): number {
  const q = Number(hit.lineQty || 0);
  if (q <= 0) return round3(hit.lineFinal);
  return round3((hit.lineFinal * hit.allocQty) / q);
}

export function allocLineGross(hit: LotSaleAllocHit): number {
  const q = Number(hit.lineQty || 0);
  if (q <= 0) return round3(hit.grossProfit);
  return round3((hit.grossProfit * hit.allocQty) / q);
}

export type DayLotMovement = {
  date: string;
  cashQty: number;
  creditQty: number;
  cashAmount: number;
  creditAmount: number;
};

export function summarizeHitsByDay(hits: LotSaleAllocHit[]): DayLotMovement[] {
  const map = new Map<string, Omit<DayLotMovement, "date">>();

  for (const h of hits) {
    const prev = map.get(h.saleDate) || {
      cashQty: 0,
      creditQty: 0,
      cashAmount: 0,
      creditAmount: 0,
    };
    const amt = allocLineAmount(h);
    if (h.isCash) {
      prev.cashQty += h.allocQty;
      prev.cashAmount += amt;
    } else {
      prev.creditQty += h.allocQty;
      prev.creditAmount += amt;
    }
    map.set(h.saleDate, prev);
  }

  const out: DayLotMovement[] = [];
  for (const [date, v] of map) {
    if (
      v.cashQty <= 0.0005 &&
      v.creditQty <= 0.0005 &&
      v.cashAmount < 0.005 &&
      v.creditAmount < 0.005
    )
      continue;
    out.push({
      date,
      cashQty: round3(v.cashQty),
      creditQty: round3(v.creditQty),
      cashAmount: round3(v.cashAmount),
      creditAmount: round3(v.creditAmount),
    });
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

export function lineMatchesProductFilter(
  line: LotBatchLine,
  productKey: string,
  productId?: string,
  productName?: string,
): boolean {
  if (!productKey && !productId && !productName) return true;
  const pid = String(line.productId || "").trim();
  if (productId && pid && pid === productId) return true;
  if (pid && pid === productKey) return true;
  if (productName && normKey(line.productName) === normKey(productName))
    return true;
  if (productKey && normKey(line.productName) === normKey(productKey))
    return true;
  return false;
}
