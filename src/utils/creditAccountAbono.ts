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
