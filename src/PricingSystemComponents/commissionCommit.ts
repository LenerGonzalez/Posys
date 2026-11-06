import type { PricingSale } from "./saleCommit";

export const PAYMENTS_COLLECTION = "pricing_commission_payments";

/** Redondeo al centavo más cercano. Toda la comisión se suma en enteros. */
export function toCents(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(value * 100);
}

export function fromCents(cents: number): number {
  return cents / 100;
}

export function balanceCents(balance: Pick<CommissionBalance, "generated" | "paid">): { generated: number; paid: number; pending: number } {
  const generated = toCents(balance.generated);
  const paid = Math.min(Math.max(toCents(balance.paid), 0), Math.max(generated, 0));
  return { generated, paid, pending: generated - paid };
}

export interface CommissionBalance {
  ownerUid: string;
  sellerUid: string;
  saleId: string;
  soldAt: string;
  lineIndex: number;
  inventoryId: string;
  invoiceNumber: string;
  productId: string;
  productName: string;
  generated: number;
  paid: number;
}

export interface CommissionQueueLine {
  saleId: string;
  soldAt: string;
  lineIndex: number;
  inventoryId: string;
  invoiceNumber: string;
  productId: string;
  productName: string;
}

export interface CommissionQueue {
  ownerUid: string;
  sellerUid: string;
  lines: CommissionQueueLine[];
}

export interface PaymentApplication {
  saleId: string;
  lineIndex: number;
  inventoryId: string;
  invoiceNumber: string;
  productId: string;
  productName: string;
  amount: number;
  pendingAfter: number;
}

export interface CommissionPayment {
  operationId: string;
  ownerUid: string;
  sellerUid: string;
  sellerName: string;
  paidAt: string;
  amount: number;
  applications: PaymentApplication[];
}

export interface PaymentCommitRequest {
  operationId: string;
  ownerUid: string;
  sellerUid: string;
  sellerName: string;
  paidAt: string;
  amount: number;
}

export interface PaymentCommitState {
  existingPayment: CommissionPayment | null;
  queue: CommissionQueue;
  balances: CommissionBalance[];
}

export type PaymentPlan =
  | { status: "rejected"; message: string }
  | { status: "planned"; applications: PaymentApplication[]; balances: CommissionBalance[]; queue: CommissionQueue };

export type PaymentCommitResult =
  | { status: "existing"; payment: CommissionPayment }
  | { status: "created"; payment: CommissionPayment; balances: CommissionBalance[]; queue: CommissionQueue }
  | { status: "rejected"; message: string };

function safeId(value: string): string {
  return encodeURIComponent(value);
}

export function queueDocumentId(ownerUid: string, sellerUid: string): string {
  return `queue_${safeId(ownerUid)}_${safeId(sellerUid)}`;
}

export function balanceDocumentId(ownerUid: string, saleId: string, lineIndex: number): string {
  return `balance_${safeId(ownerUid)}_${safeId(saleId)}_${lineIndex}`;
}

export function lineKey(saleId: string, lineIndex: number): string {
  return `${saleId}:${lineIndex}`;
}

export function emptyQueue(ownerUid: string, sellerUid: string): CommissionQueue {
  return { ownerUid, sellerUid, lines: [] };
}

export function queueFromDoc(ownerUid: string, sellerUid: string, data: Record<string, unknown> | null): CommissionQueue {
  if (!data) return emptyQueue(ownerUid, sellerUid);
  if (data.type !== "queue" || data.ownerUid !== ownerUid || data.sellerUid !== sellerUid) {
    throw new Error("La cola de comisiones no corresponde a este vendedor.");
  }
  const rows = Array.isArray(data.lines) ? data.lines : [];
  return {
    ownerUid,
    sellerUid,
    lines: rows.map((value) => {
      const row = (value || {}) as Partial<CommissionQueueLine>;
      return {
        saleId: String(row.saleId || ""),
        soldAt: String(row.soldAt || ""),
        lineIndex: Number(row.lineIndex || 0),
        inventoryId: String(row.inventoryId || ""),
        invoiceNumber: String(row.invoiceNumber || ""),
        productId: String(row.productId || ""),
        productName: String(row.productName || ""),
      };
    }),
  };
}

export function openPending(generated: number, paid: number): number {
  return fromCents(balanceCents({ generated, paid }).pending);
}

export function compareFifo(left: CommissionQueueLine, right: CommissionQueueLine): number {
  if (left.soldAt < right.soldAt) return -1;
  if (left.soldAt > right.soldAt) return 1;
  if (left.saleId < right.saleId) return -1;
  if (left.saleId > right.saleId) return 1;
  return left.lineIndex - right.lineIndex;
}

export function balancesFromSale(sale: PricingSale): CommissionBalance[] {
  return sale.lines.map((line, lineIndex) => ({
    ownerUid: sale.ownerUid,
    sellerUid: sale.sellerUid,
    saleId: sale.operationId,
    soldAt: sale.soldAt,
    lineIndex,
    inventoryId: line.inventoryId,
    invoiceNumber: line.invoiceNumber,
    productId: line.productId,
    productName: line.productName,
    generated: fromCents(toCents(line.vendorProfit)),
    paid: 0,
  }));
}

function queueLine(balance: CommissionBalance): CommissionQueueLine {
  return {
    saleId: balance.saleId,
    soldAt: balance.soldAt,
    lineIndex: balance.lineIndex,
    inventoryId: balance.inventoryId,
    invoiceNumber: balance.invoiceNumber,
    productId: balance.productId,
    productName: balance.productName,
  };
}

export function enqueueOpenLines(queue: CommissionQueue, balances: CommissionBalance[]): CommissionQueue {
  const present = new Set(queue.lines.map((line) => lineKey(line.saleId, line.lineIndex)));
  const added = balances.filter((balance) => (
    balance.ownerUid === queue.ownerUid
    && balance.sellerUid === queue.sellerUid
    && openPending(balance.generated, balance.paid) > 0
    && !present.has(lineKey(balance.saleId, balance.lineIndex))
  ));
  return {
    ...queue,
    lines: [...queue.lines, ...added.map(queueLine)].sort(compareFifo),
  };
}

export function planPayment(amount: number, queue: CommissionQueue, balances: CommissionBalance[]): PaymentPlan {
  const amountCents = toCents(amount);
  if (amountCents <= 0) {
    return { status: "rejected", message: "El monto del pago debe ser mayor que cero. El pago no se registró." };
  }
  const working = new Map(balances.map((balance) => {
    const cents = balanceCents(balance);
    return [lineKey(balance.saleId, balance.lineIndex), {
      ...balance,
      generated: fromCents(cents.generated),
      paid: fromCents(cents.paid),
    }] as const;
  }));
  const seen = new Set<string>();
  const applications: PaymentApplication[] = [];
  const kept: CommissionQueueLine[] = [];
  let remaining = amountCents;

  for (const line of [...queue.lines].sort(compareFifo)) {
    const key = lineKey(line.saleId, line.lineIndex);
    if (seen.has(key)) continue;
    seen.add(key);
    const balance = working.get(key);
    if (!balance) {
      return { status: "rejected", message: "Falta el saldo de una comisión pendiente. El pago no se registró." };
    }
    const pending = balanceCents(balance).pending;
    if (pending <= 0) continue;
    if (remaining <= 0) {
      kept.push(line);
      continue;
    }
    const apply = Math.min(pending, remaining);
    const pendingAfter = pending - apply;
    const generated = balanceCents(balance).generated;
    working.set(key, { ...balance, generated: fromCents(generated), paid: fromCents(generated - pendingAfter) });
    applications.push({
      saleId: line.saleId,
      lineIndex: line.lineIndex,
      inventoryId: line.inventoryId,
      invoiceNumber: line.invoiceNumber,
      productId: line.productId,
      productName: line.productName,
      amount: fromCents(apply),
      pendingAfter: fromCents(pendingAfter),
    });
    remaining -= apply;
    if (pendingAfter > 0) kept.push(line);
  }

  if (remaining > 0) {
    return { status: "rejected", message: "El pago supera la comisión pendiente. El pago no se registró." };
  }
  return {
    status: "planned",
    applications,
    balances: [...working.values()],
    queue: { ...queue, lines: kept },
  };
}

export function commitPayment(request: PaymentCommitRequest, state: PaymentCommitState): PaymentCommitResult {
  const operationId = request.operationId.trim();
  if (!operationId || /^(queue_|balance_|stock_)/.test(operationId)) {
    return { status: "rejected", message: "El pago no tiene un identificador válido." };
  }
  if (!request.ownerUid || !request.sellerUid) {
    return { status: "rejected", message: "El pago debe indicar al vendedor." };
  }
  if (state.existingPayment) {
    if (state.existingPayment.ownerUid !== request.ownerUid || state.existingPayment.operationId !== operationId) {
      return { status: "rejected", message: "Este pago pertenece a otro usuario." };
    }
    return { status: "existing", payment: state.existingPayment };
  }
  if (!request.sellerName.trim()) {
    return { status: "rejected", message: "El perfil no tiene un nombre de vendedor." };
  }
  if (state.queue.ownerUid !== request.ownerUid || state.queue.sellerUid !== request.sellerUid) {
    return { status: "rejected", message: "La cola de comisiones no corresponde a este vendedor." };
  }
  const plan = planPayment(request.amount, state.queue, state.balances);
  if (plan.status === "rejected") return plan;
  const changed = new Set(plan.applications.map((line) => lineKey(line.saleId, line.lineIndex)));
  const amount = fromCents(plan.applications.reduce((sum, line) => sum + toCents(line.amount), 0));
  return {
    status: "created",
    payment: {
      operationId,
      ownerUid: request.ownerUid,
      sellerUid: request.sellerUid,
      sellerName: request.sellerName.trim(),
      paidAt: request.paidAt,
      amount,
      applications: plan.applications,
    },
    balances: plan.balances.filter((balance) => changed.has(lineKey(balance.saleId, balance.lineIndex))),
    queue: plan.queue,
  };
}

export const HISTORICAL_ROUNDING_CENTS = 1;

export const UNEXPLAINED_ROUNDING_MESSAGE = "La diferencia de redondeo no es de C$0.01 o no coincide con los pagos registrados. El pago no se registró.";

export type RoundingAssessment =
  | { status: "none"; balances: CommissionBalance[] }
  | { status: "adjust"; balances: CommissionBalance[]; saleId: string; lineIndex: number; cents: 1 }
  | { status: "unexplained"; balances: CommissionBalance[]; gap: number; explained: number };

function applicationCents(payment: CommissionPayment): number {
  return payment.applications.reduce((sum, line) => sum + toCents(line.amount), 0);
}

function oldestOpenBalance(balances: CommissionBalance[]): CommissionBalance | null {
  const open = balances.filter((balance) => balanceCents(balance).pending >= HISTORICAL_ROUNDING_CENTS);
  open.sort((left, right) => compareFifo(
    { saleId: left.saleId, soldAt: left.soldAt, lineIndex: left.lineIndex, inventoryId: left.inventoryId, invoiceNumber: left.invoiceNumber, productId: left.productId, productName: left.productName },
    { saleId: right.saleId, soldAt: right.soldAt, lineIndex: right.lineIndex, inventoryId: right.inventoryId, invoiceNumber: right.invoiceNumber, productId: right.productId, productName: right.productName },
  ));
  return open[0] ?? null;
}

/** El centavo histórico es la diferencia entre el efectivo registrado y el pagado de las líneas. No se guarda solo. */
export function assessHistoricalRounding(payments: CommissionPayment[], balances: CommissionBalance[]): RoundingAssessment {
  const cash = payments.reduce((sum, payment) => sum + toCents(payment.amount), 0);
  const allocated = balances.reduce((sum, balance) => sum + balanceCents(balance).paid, 0);
  const gap = cash - allocated;
  const explained = payments.reduce((sum, payment) => sum + (toCents(payment.amount) - applicationCents(payment)), 0);
  if (gap === 0) return { status: "none", balances };
  const target = oldestOpenBalance(balances);
  if (gap !== HISTORICAL_ROUNDING_CENTS || explained !== HISTORICAL_ROUNDING_CENTS || !target) {
    return { status: "unexplained", balances, gap, explained };
  }
  return {
    status: "adjust",
    cents: 1,
    saleId: target.saleId,
    lineIndex: target.lineIndex,
    balances: balances.map((balance) => balance === target
      ? { ...balance, paid: fromCents(balanceCents(balance).paid + HISTORICAL_ROUNDING_CENTS) }
      : balance),
  };
}

export function historicalRoundingPayment(payments: CommissionPayment[]): CommissionPayment | null {
  return payments.find((payment) => toCents(payment.amount) - applicationCents(payment) === HISTORICAL_ROUNDING_CENTS) ?? null;
}
