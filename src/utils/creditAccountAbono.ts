/**
 * Reglas compartidas: ventas/consignaciones a crédito (CARGO + ref.saleId).
 */

export type CargoRowLike = {
  type: string;
  amount: number;
  ref?: { saleId?: string };
  debtStatus?: string;
  date?: string;
  createdAt?: { seconds?: number };
};

const round2 = (n: number) =>
  Math.round(((Number(n) || 0) + Number.EPSILON) * 100) / 100;

/**
 * Ids de ventas con cargo pendiente (PENDIENTE y saldo > 0), orden: más antigua primero.
 * Exportado para KPIs / búsquedas.
 */
export function listPendingSaleIdsOldestFirst<T extends CargoRowLike>(
  rows: T[],
  normalizeDebtStatus: (v?: string) => "PENDIENTE" | "PAGADA",
  getPendingForSale: (rows: T[], saleId: string) => number,
  getCargoSaleDate: (rows: T[], saleId: string) => string,
): string[] {
  const ids = new Set<string>();
  for (const m of rows) {
    if (m.type !== "CARGO" || !m.ref?.saleId || Number(m.amount) <= 0) continue;
    const sid = String(m.ref.saleId).trim();
    if (!sid) continue;
    if (normalizeDebtStatus(m.debtStatus) !== "PENDIENTE") continue;
    if (getPendingForSale(rows, sid) <= 0.005) continue;
    ids.add(sid);
  }
  return [...ids].sort((a, b) => {
    const da = getCargoSaleDate(rows, a) || a;
    const db = getCargoSaleDate(rows, b) || b;
    if (da !== db) return da.localeCompare(db);
    return a.localeCompare(b);
  });
}

export function getOldestPendingSaleId<T extends CargoRowLike>(
  rows: T[],
  normalizeDebtStatus: (v?: string) => "PENDIENTE" | "PAGADA",
  getPendingForSale: (rows: T[], saleId: string) => number,
  getCargoSaleDate: (rows: T[], saleId: string) => string,
): string | null {
  const list = listPendingSaleIdsOldestFirst(
    rows,
    normalizeDebtStatus,
    getPendingForSale,
    getCargoSaleDate,
  );
  return list.length ? list[0] : null;
}

export type AbonoDistribuido = {
  saleId: string;
  /** Monto asignado a esta venta (2 decimales). */
  abonoCalculado: number;
  saldoFinal: number;
  pagadoCompleto: boolean;
};

export type AbonoMovementLike = CargoRowLike & {
  type: string;
  amount: number;
  date?: string;
  createdAt?: { seconds?: number; nanoseconds?: number };
  ref?: { saleId?: string };
};

export type EffectiveSaleBalance = {
  saleId: string;
  cargoAmt: number;
  /** Abonos con ref.saleId explícita. */
  abonoLigado: number;
  /** Parte de abonos generales aplicada FIFO a esta venta. */
  abonoGeneral: number;
  /** abonoLigado + abonoGeneral */
  abonoEfectivo: number;
  pendiente: number;
};

function compareAbonoMovementChrono(
  a: AbonoMovementLike,
  b: AbonoMovementLike,
): number {
  const da = String(a.date || "").slice(0, 10);
  const db = String(b.date || "").slice(0, 10);
  if (da !== db) return da.localeCompare(db);
  const as = a.createdAt?.seconds || 0;
  const bs = b.createdAt?.seconds || 0;
  if (as !== bs) return as - bs;
  const an = a.createdAt?.nanoseconds || 0;
  const bn = b.createdAt?.nanoseconds || 0;
  return an - bn;
}

/**
 * Reparte abonos generales (sin ref.saleId) en FIFO sobre consignaciones pendientes,
 * además de los abonos ligados a cada venta. Así el pendiente por factura cuadra con el saldo global.
 */
export function computeEffectiveSaleBalances<T extends AbonoMovementLike>(
  rows: T[],
  getCargoSaleDate: (rows: T[], saleId: string) => string,
): Map<string, EffectiveSaleBalance> {
  const cargoBySale = new Map<string, number>();
  for (const m of rows) {
    if (m.type !== "CARGO" || !m.ref?.saleId || Number(m.amount) <= 0) continue;
    const sid = String(m.ref.saleId).trim();
    if (!sid) continue;
    cargoBySale.set(sid, round2(Number(m.amount)));
  }

  const pending = new Map<string, number>();
  const abonoLigado = new Map<string, number>();
  const abonoGeneral = new Map<string, number>();
  for (const [sid, amt] of cargoBySale) {
    pending.set(sid, amt);
    abonoLigado.set(sid, 0);
    abonoGeneral.set(sid, 0);
  }

  const abonos = rows
    .filter((m) => m.type === "ABONO" && Number(m.amount) < 0)
    .slice()
    .sort(compareAbonoMovementChrono);

  const oldestPendingSaleId = (): string | null => {
    const ids = [...pending.keys()].filter(
      (sid) => (pending.get(sid) || 0) > 0.005,
    );
    if (!ids.length) return null;
    ids.sort((a, b) => {
      const da = getCargoSaleDate(rows, a) || a;
      const db = getCargoSaleDate(rows, b) || b;
      if (da !== db) return da.localeCompare(db);
      return a.localeCompare(b);
    });
    return ids[0] ?? null;
  };

  const applyToSale = (
    saleId: string,
    monto: number,
    bucket: "linked" | "general",
  ): number => {
    let rest = round2(monto);
    const pend = pending.get(saleId) || 0;
    const applied = round2(Math.min(rest, pend));
    if (applied <= 0) return rest;
    pending.set(saleId, round2(pend - applied));
    const map = bucket === "linked" ? abonoLigado : abonoGeneral;
    map.set(saleId, round2((map.get(saleId) || 0) + applied));
    return round2(rest - applied);
  };

  for (const ab of abonos) {
    let rest = round2(Math.abs(Number(ab.amount) || 0));
    const sid = String(ab.ref?.saleId || "").trim();
    if (sid && cargoBySale.has(sid)) {
      rest = applyToSale(sid, rest, "linked");
    }
    while (rest > 0.005) {
      const oldest = oldestPendingSaleId();
      if (!oldest) break;
      const before = rest;
      rest = applyToSale(oldest, rest, "general");
      if (rest >= before - 0.005) break;
    }
  }

  const out = new Map<string, EffectiveSaleBalance>();
  for (const [saleId, cargoAmt] of cargoBySale) {
    const ligado = round2(abonoLigado.get(saleId) || 0);
    const general = round2(abonoGeneral.get(saleId) || 0);
    const abonoEfectivo = round2(ligado + general);
    out.set(saleId, {
      saleId,
      cargoAmt,
      abonoLigado: ligado,
      abonoGeneral: general,
      abonoEfectivo,
      pendiente: round2(Math.max(0, cargoAmt - abonoEfectivo)),
    });
  }
  return out;
}

/** Reparte `montoTotal` desde la venta más antigua; no excede el pendiente de cada una. */
export function distribuirAbonoEntrePendientes<T extends CargoRowLike>(
  rows: T[],
  montoTotal: number,
  normalizeDebtStatus: (v?: string) => "PENDIENTE" | "PAGADA",
  getPendingForSale: (rows: T[], saleId: string) => number,
  getCargoSaleDate: (rows: T[], saleId: string) => string,
): AbonoDistribuido[] {
  const total = Math.max(0, round2(montoTotal));
  if (total <= 0) return [];
  let restante = total;
  const orden = listPendingSaleIdsOldestFirst(
    rows,
    normalizeDebtStatus,
    getPendingForSale,
    getCargoSaleDate,
  );
  const out: AbonoDistribuido[] = [];
  for (const saleId of orden) {
    if (restante <= 0) break;
    const pend = round2(getPendingForSale(rows, saleId));
    if (pend <= 0) continue;
    const aplicado = round2(Math.min(restante, pend));
    if (aplicado <= 0) continue;
    const saldoFinal = round2(pend - aplicado);
    restante = round2(restante - aplicado);
    out.push({
      saleId,
      abonoCalculado: aplicado,
      saldoFinal,
      pagadoCompleto: saldoFinal <= 0.005,
    });
  }
  return out;
}

/**
 * Incluye todas las ventas pendientes en orden (más antigua primero).
 * Las que no recibieron parte del abono muestran abono 0 y saldo = pendiente.
 */
export function mergeDistribucionConPendientesSinCobro<T extends CargoRowLike>(
  rows: T[],
  dist: AbonoDistribuido[],
  normalizeDebtStatus: (v?: string) => "PENDIENTE" | "PAGADA",
  getPendingForSale: (rows: T[], saleId: string) => number,
  getCargoSaleDate: (rows: T[], saleId: string) => string,
): AbonoDistribuido[] {
  const pendingIds = listPendingSaleIdsOldestFirst(
    rows,
    normalizeDebtStatus,
    getPendingForSale,
    getCargoSaleDate,
  );
  const map = new Map(dist.map((d) => [d.saleId, d]));
  return pendingIds.map((saleId) => {
    const hit = map.get(saleId);
    if (hit) return hit;
    const pend = round2(getPendingForSale(rows, saleId));
    return {
      saleId,
      abonoCalculado: 0,
      saldoFinal: pend,
      pagadoCompleto: pend <= 0.005,
    };
  });
}
