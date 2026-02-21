// src/Services/inventory_evolution_pollo.ts
import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";

const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

const mStr = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .trim();

const normKey = (s: unknown) =>
  String(s ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim();

const isLb = (m: unknown) => ["lb", "lbs", "libra", "libras"].includes(mStr(m));
const isUnit = (m: unknown) => !isLb(m);

const toDateKey = (v: unknown) => {
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
    const anyV = v as any;
    if (anyV && typeof anyV.toDate === "function") {
      const d: Date = anyV.toDate();
      if (!isNaN(d.getTime())) return d.toISOString().slice(0, 10);
    }
    if (v instanceof Date) {
      if (!isNaN(v.getTime())) return (v as Date).toISOString().slice(0, 10);
    }
  } catch (e) {}
  return "";
};

const getMeasurementFromBatch = (b: any) => {
  if (!b) return "";
  return (
    b.measurement ?? b.unit ?? b.unidad ?? b.medida ?? b.measure ?? b.uom ?? ""
  );
};

export type InvMoveType =
  | "INGRESO" // viene de inventory_batches
  | "VENTA_CASH"
  | "VENTA_CREDITO"
  | "MERMA"
  | "ROBO";

export type InvMove = {
  date: string; // yyyy-MM-dd
  type: InvMoveType;
  description: string;
  ref?: string;
  qtyIn: number; // +
  qtyOut: number; // -
};

export type ProductOption = {
  key: string; // productId o productName
  productId?: string; // si existe, ayuda a match perfecto
  productName: string;
  measurement: "lb" | "unidad";
  remaining: number; // stock actual (snapshot)
};

export type GlobalKpis = {
  incomingLbs: number;
  incomingUnits: number;
  remainingLbs: number;
  remainingUnits: number;
};

export type ProductKpis = {
  incoming: number;
  soldCash: number;
  soldCredit: number;
  remaining: number; // snapshot actual (no histórico)
  measurement: "lb" | "unidad";
};

export async function fetchInventoryProductOptionsPollo(): Promise<
  ProductOption[]
> {
  const snap = await getDocs(collection(db, "inventory_batches"));

  const map = new Map<
    string,
    {
      productId?: string;
      productName: string;
      measurement: "lb" | "unidad";
      remaining: number;
    }
  >();

  snap.forEach((d) => {
    const b = d.data() as any;

    const productName = String(b.productName ?? "(sin nombre)");
    const productId = String(b.productId ?? "").trim();
    const key = productId || productName;

    const rem = Number(b.remaining ?? 0);
    const meas = isLb(getMeasurementFromBatch(b)) ? "lb" : "unidad";

    if (!map.has(key)) {
      map.set(key, {
        productId: productId || undefined,
        productName,
        measurement: meas,
        remaining: 0,
      });
    }

    const row = map.get(key)!;
    row.remaining += rem;

    // si hay mezcla rara, preferimos lb si cualquiera es lb
    if (meas === "lb") row.measurement = "lb";

    // preserva productId si aparece en otro batch
    if (!row.productId && productId) row.productId = productId;
  });

  return Array.from(map.entries())
    .map(([key, v]) => ({
      key,
      productId: v.productId,
      productName: v.productName,
      measurement: v.measurement,
      remaining: round3(v.remaining),
    }))
    .filter((x) => x.remaining > 0)
    .sort((a, b) => a.productName.localeCompare(b.productName));
}

export async function fetchGlobalInventoryKpisPollo(
  from: string,
  to: string,
): Promise<GlobalKpis> {
  const snap = await getDocs(collection(db, "inventory_batches"));

  let incomingLbs = 0;
  let incomingUnits = 0;
  let remainingLbs = 0;
  let remainingUnits = 0;

  snap.forEach((d) => {
    const b = d.data() as any;

    const date =
      toDateKey(b.date) ||
      toDateKey(b.createdAt) ||
      toDateKey(b.created_at) ||
      toDateKey(b.paidAt) ||
      toDateKey(b.batchDate) ||
      toDateKey(b.batch_date) ||
      "";

    const qty = Number(b.quantity ?? 0);
    const rem = Number(b.remaining ?? 0);
    const measIsLb = isLb(getMeasurementFromBatch(b));

    // ingresado en rango
    if (date && date >= from && date <= to) {
      if (measIsLb) incomingLbs += qty;
      else incomingUnits += qty;
    }

    // existente (snapshot actual)
    if (measIsLb) remainingLbs += rem;
    else remainingUnits += rem;
  });

  return {
    incomingLbs: round3(incomingLbs),
    incomingUnits: round3(incomingUnits),
    remainingLbs: round3(remainingLbs),
    remainingUnits: round3(remainingUnits),
  };
}

// Wrapper opcional de debug (si lo usás en tu componente)
export async function fetchGlobalInventoryKpisPollo_debug(
  from: string,
  to: string,
) {
  const res = await fetchGlobalInventoryKpisPollo(from, to);
  // eslint-disable-next-line no-console
  console.log("[KPIS DEBUG] resumen:", res);
  return res;
}

export async function fetchProductEvolutionPollo(args: {
  from: string;
  to: string;
  productKey: string; // productId o productName
  productId?: string; // ✅ opcional
  productName: string;
  measurement: "lb" | "unidad";
}): Promise<{
  moves: InvMove[];
  productKpis: ProductKpis;
}> {
  const { from, to, productKey, productId, productName, measurement } = args;

  // ========= 1) INGRESOS desde inventory_batches =========
  const invSnap = await getDocs(collection(db, "inventory_batches"));

  let incoming = 0;
  let remaining = 0;
  const ingresoMoves: InvMove[] = [];

  invSnap.forEach((d) => {
    const b = d.data() as any;

    const pName = String(b.productName ?? "");
    const pId = String(b.productId ?? "").trim();

    // match batch robusto
    const matchBatch =
      (pId && pId === productKey) ||
      (!pId && normKey(pName) === normKey(productKey)) ||
      normKey(pName) === normKey(productName) ||
      (productId && pId === productId);

    if (!matchBatch) return;

    const date =
      toDateKey(b.date) ||
      toDateKey(b.createdAt) ||
      toDateKey(b.created_at) ||
      toDateKey(b.paidAt) ||
      toDateKey(b.batchDate) ||
      toDateKey(b.batch_date) ||
      "";

    const qty = Number(b.quantity ?? 0);
    const rem = Number(b.remaining ?? 0);

    // stock actual snapshot
    remaining += rem;

    // ingresos en rango
    if (date && date >= from && date <= to) {
      incoming += qty;
      ingresoMoves.push({
        date,
        type: "INGRESO",
        description: `Ingreso inventario: ${pName || productName}`,
        ref: d.id,
        qtyIn: qty,
        qtyOut: 0,
      });
    }
  });

  // ========= 2) VENTAS desde salesV2 (en rango) =========
  const qs = query(
    collection(db, "salesV2"),
    where("date", ">=", from),
    where("date", "<=", to),
  );
  const saleSnap = await getDocs(qs);

  let soldCash = 0;
  let soldCredit = 0;
  const saleMoves: InvMove[] = [];

  const pushSaleMove = (
    date: string,
    type: "VENTA_CASH" | "VENTA_CREDITO",
    qty: number,
    saleId: string,
  ) => {
    saleMoves.push({
      date,
      type,
      description: `Venta ${type === "VENTA_CASH" ? "Cash" : "Crédito"}: ${productName}`,
      ref: saleId,
      qtyIn: 0,
      qtyOut: qty,
    });
  };

  saleSnap.forEach((d) => {
    const x = d.data() as any;
    const date = String(x.date ?? "");
    const saleType = String(x.type ?? "CONTADO").toUpperCase(); // CONTADO / CREDITO

    const isCashSale = saleType === "CONTADO";
    const moveType = isCashSale ? "VENTA_CASH" : "VENTA_CREDITO";

    // multi-ítems
    if (Array.isArray(x.items) && x.items.length > 0) {
      x.items.forEach((it: any) => {
        const itName = String(it.productName ?? "");
        const itProductId = String(it.productId ?? "").trim();

        const matchItem =
          (productId && itProductId && itProductId === productId) ||
          (itProductId && itProductId === productKey) ||
          normKey(itName) === normKey(productName) ||
          normKey(itName) === normKey(productKey);

        if (!matchItem) return;

        const qty = Number(it.qty ?? it.quantity ?? 0);
        if (qty <= 0) return;

        if (isCashSale) soldCash += qty;
        else soldCredit += qty;

        pushSaleMove(date, moveType, qty, d.id);
      });
      return;
    }

    // venta simple
    const sName = String(x.productName ?? "");
    const sProductId = String(x.productId ?? "").trim();

    const matchSale =
      (productId && sProductId && sProductId === productId) ||
      (sProductId && sProductId === productKey) ||
      normKey(sName) === normKey(productName) ||
      normKey(sName) === normKey(productKey);

    if (!matchSale) return;

    const qty = Number(x.quantity ?? 0);
    if (qty <= 0) return;

    if (isCashSale) soldCash += qty;
    else soldCredit += qty;

    pushSaleMove(date, moveType, qty, d.id);
  });

  // ========= 3) MERMA / ROBO desde inventory_adjustments_pollo =========
  const qa = query(
    collection(db, "inventory_adjustments_pollo"),
    where("productKey", "==", productKey),
    where("date", ">=", from),
    where("date", "<=", to),
  );
  const adjSnap = await getDocs(qa);

  const adjMoves: InvMove[] = [];

  adjSnap.forEach((d) => {
    const a = d.data() as any;
    const date = String(a.date ?? "");
    const type = String(a.type ?? "").toUpperCase(); // MERMA / ROBO
    const qty = Number(a.qty ?? 0);
    if (!date || qty <= 0) return;

    adjMoves.push({
      date,
      type: type === "MERMA" ? "MERMA" : "ROBO",
      description: a.description
        ? String(a.description)
        : type === "MERMA"
          ? "Merma por peso"
          : "Pérdida/Robo",
      ref: d.id,
      qtyIn: 0,
      qtyOut: qty,
    });
  });

  const moves = [...ingresoMoves, ...saleMoves, ...adjMoves].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  return {
    moves,
    productKpis: {
      incoming: round3(incoming),
      soldCash: round3(soldCash),
      soldCredit: round3(soldCredit),
      remaining: round3(remaining),
      measurement,
    },
  };
}
