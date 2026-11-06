import {
  assessHistoricalRounding,
  balanceCents,
  balancesFromSale,
  commitPayment,
  emptyQueue,
  enqueueOpenLines,
  fromCents,
  lineKey,
  openPending,
  planPayment,
  toCents,
  type CommissionBalance,
  type CommissionPayment,
  type CommissionQueueLine,
} from "./commissionCommit";
import type { PricingSale } from "./saleCommit";

const failures: string[] = [];

function balance(partial: Partial<CommissionBalance> & Pick<CommissionBalance, "saleId" | "soldAt" | "lineIndex" | "generated">): CommissionBalance {
  return {
    ownerUid: "owner-1",
    sellerUid: "seller-1",
    inventoryId: partial.inventoryId ?? "inv-a",
    invoiceNumber: partial.invoiceNumber ?? "F-1",
    productId: partial.productId ?? "prod-1",
    productName: partial.productName ?? "Arroz",
    paid: partial.paid ?? 0,
    ...partial,
  };
}

function queueFrom(balances: CommissionBalance[]) {
  return enqueueOpenLines(emptyQueue("owner-1", "seller-1"), balances);
}

const first = balance({ saleId: "sale-1", soldAt: "2026-01-01T00:00:00.000Z", lineIndex: 0, generated: 100, inventoryId: "inv-a", invoiceNumber: "0001", productName: "Arroz" });
const second = balance({ saleId: "sale-2", soldAt: "2026-01-02T00:00:00.000Z", lineIndex: 0, generated: 150, inventoryId: "inv-b", invoiceNumber: "0002", productName: "Frijol" });
const third = balance({ saleId: "sale-3", soldAt: "2026-01-03T00:00:00.000Z", lineIndex: 0, generated: 200, inventoryId: "inv-a", invoiceNumber: "0003", productName: "Azúcar" });
const balances = [third, first, second];
const queued = queueFrom(balances);
if (queued.lines.map((line) => line.saleId).join() !== "sale-1,sale-2,sale-3") {
  failures.push("la cola no quedó ordenada de la comisión más antigua a la más nueva");
}

const partial = planPayment(180, queued, balances);
if (partial.status !== "planned") {
  failures.push("un pago parcial de 180 debía distribuirse");
} else {
  const [one, two] = partial.applications;
  if (partial.applications.length !== 2 || one?.amount !== 100 || one.pendingAfter !== 0 || two?.amount !== 80 || two.pendingAfter !== 70) {
    failures.push("el pago de 180 no liquidó la primera comisión y dejó 70 en la segunda");
  }
  if (partial.queue.lines.map((line) => line.saleId).join() !== "sale-2,sale-3") {
    failures.push("la línea parcial debía seguir primera en la cola");
  }
  const paidSecond = partial.balances.find((line) => line.saleId === "sale-2");
  const untouched = partial.balances.find((line) => line.saleId === "sale-3");
  if (paidSecond?.paid !== 80 || paidSecond.generated !== 150 || untouched?.paid !== 0) {
    failures.push("el pago no debía cambiar la comisión generada ni la venta más nueva");
  }
  const next = planPayment(270, partial.queue, partial.balances);
  if (next.status !== "planned" || next.applications.map((line) => line.amount).join() !== "70,200") {
    failures.push("el siguiente pago debía continuar en el saldo parcial");
  }
  const over = planPayment(270.01, partial.queue, partial.balances);
  if (over.status !== "rejected") failures.push("un pago mayor al pendiente debía rechazarse completo");
}

const sameDate: CommissionQueueLine[] = [
  { saleId: "b-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 1, inventoryId: "inv-a", invoiceNumber: "1", productId: "p", productName: "B" },
  { saleId: "a-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 0, inventoryId: "inv-a", invoiceNumber: "1", productId: "p", productName: "A" },
  { saleId: "a-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 1, inventoryId: "inv-b", invoiceNumber: "2", productId: "q", productName: "A2" },
];
const tiedBalances = [
  balance({ saleId: "b-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 1, generated: 40 }),
  balance({ saleId: "a-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 1, generated: 30, inventoryId: "inv-b" }),
  balance({ saleId: "a-sale", soldAt: "2026-02-01T00:00:00.000Z", lineIndex: 0, generated: 10 }),
];
const tied = planPayment(25, { ownerUid: "owner-1", sellerUid: "seller-1", lines: sameDate }, tiedBalances);
if (tied.status !== "planned" || tied.applications.map((line) => `${line.saleId}:${line.lineIndex}:${line.amount}`).join() !== "a-sale:0:10,a-sale:1:15") {
  failures.push("la misma fecha debía ordenarse por venta y después por línea");
}

const again = enqueueOpenLines(queued, balances);
if (again.lines.length !== 3) failures.push("volver a encolar una venta no debía duplicar sus líneas");

const zero = balance({ saleId: "sale-0", soldAt: "2026-01-01T00:00:00.000Z", lineIndex: 1, generated: 0 });
const withZero = enqueueOpenLines(emptyQueue("owner-1", "seller-1"), [zero]);
if (withZero.lines.length !== 0) failures.push("una comisión de cero no debía entrar a la cola");

const emptyPay = planPayment(0, queued, balances);
const negative = planPayment(-10, queued, balances);
if (emptyPay.status !== "rejected" || negative.status !== "rejected") {
  failures.push("un pago vacío o negativo debía rechazarse");
}

const sale: PricingSale = {
  operationId: "sale-snap",
  ownerUid: "owner-1",
  sellerUid: "seller-1",
  sellerName: "Ana",
  soldAt: "2026-03-01T00:00:00.000Z",
  packageCount: 2,
  salesTotal: 99.99,
  grossProfit: 40,
  vendorProfit: 70,
  investorNet: 20,
  lines: [{
    inventoryId: "inv-a",
    inventoryName: "Factura A",
    productId: "prod-1",
    productName: "Arroz",
    invoiceNumber: "0000101004",
    quantity: 2,
    appliedPrice: 10,
    costPerPack: 4,
    logisticsPerPack: 1,
    grossProfitPerPack: 5,
    vendorProfitPerPack: 10,
    investorNetPerPack: 4,
    commissionMethod: "2",
    vendorSharePercent: 30,
    salesTotal: 70,
    grossProfit: 40,
    vendorProfit: 70,
    investorNet: 20,
  }],
};
const snap = balancesFromSale(sale);
if (snap[0]?.generated !== 70 || snap[0].paid !== 0 || sale.lines[0]?.vendorProfit !== 70) {
  failures.push("la comisión generada debía normalizar el snapshot sin recalcular precio por cantidad");
}

const created = commitPayment(
  { operationId: "pay-1", ownerUid: "owner-1", sellerUid: "seller-1", sellerName: "Ana", paidAt: "2026-04-01T00:00:00.000Z", amount: 180 },
  { existingPayment: null, queue: queued, balances },
);
if (created.status !== "created" || created.payment.amount !== 180 || created.balances.some((line) => line.generated !== (line.saleId === "sale-1" ? 100 : line.saleId === "sale-2" ? 150 : 200))) {
  failures.push("el pago no debía modificar la comisión generada");
}
const saved = created.status === "created" ? created : null;
const replay = saved
  ? commitPayment(
    { operationId: "pay-1", ownerUid: "owner-1", sellerUid: "seller-1", sellerName: "Ana", paidAt: "2026-04-02T00:00:00.000Z", amount: 180 },
    { existingPayment: saved.payment, queue: saved.queue, balances: saved.balances },
  )
  : null;
if (!replay || replay.status !== "existing" || replay.payment !== saved?.payment) {
  failures.push("repetir el mismo pago debía devolver el registro existente");
}
if (created.status === "created" && created.queue.lines.some((line) => line.saleId === "sale-1")) {
  failures.push("la comisión liquidada debía salir de la cola");
}
if (openPending(150, 80) !== 70) failures.push("el pendiente de la línea parcial debía ser 70");
if (created.status === "created" && created.balances.some((line) => !created.payment.applications.some((item) => lineKey(item.saleId, item.lineIndex) === lineKey(line.saleId, line.lineIndex)))) {
  failures.push("el pago no debía tocar saldos fuera de su distribución");
}

const floats = [
  balance({ saleId: "old-1", soldAt: "2026-11-06T06:07:01.221Z", lineIndex: 0, generated: 23.602363367799114, invoiceNumber: "0000101004", productName: "Producto de ejemplo 1" }),
  balance({ saleId: "old-1", soldAt: "2026-11-06T06:07:01.221Z", lineIndex: 1, generated: 8.904579025110783, invoiceNumber: "", productName: "Producto de ejemplo 2" }),
  balance({ saleId: "old-2", soldAt: "2026-11-06T06:11:33.156Z", lineIndex: 0, generated: 8.904579025110783, invoiceNumber: "", productName: "Producto de ejemplo 2" }),
  balance({ saleId: "old-3", soldAt: "2026-11-06T06:18:11.093Z", lineIndex: 0, generated: 35.40354505169867, invoiceNumber: "0000101004", productName: "Producto de ejemplo 1" }),
  balance({ saleId: "old-4", soldAt: "2026-11-06T06:21:31.526Z", lineIndex: 0, generated: 23.602363367799114, invoiceNumber: "0000101004", productName: "Producto de ejemplo 1" }),
];
const floatQueue = queueFrom(floats);
const generatedCents = floats.reduce((sum, line) => sum + balanceCents(line).generated, 0);
const lineLabels = floats.reduce((sum, line) => sum + balanceCents(line).generated, 0);
if (generatedCents !== 10040 || lineLabels !== generatedCents) {
  failures.push("la comisión generada debía ser la suma de las líneas en centavos");
}
const paidFloat = planPayment(100, floatQueue, floats);
if (paidFloat.status !== "planned") {
  failures.push("el pago de 100 debía distribuirse en centavos");
} else {
  const applied = paidFloat.applications.reduce((sum, line) => sum + toCents(line.amount), 0);
  if (applied !== 10000) failures.push("las aplicaciones no suman el pago");
  if (toCents(paidFloat.applications[0]?.amount ?? 0) !== 2360 || toCents(paidFloat.applications[4]?.amount ?? 0) !== 2320) {
    failures.push("la distribución FIFO no usó los centavos de cada línea");
  }
  if (toCents(paidFloat.applications[4]?.pendingAfter ?? 0) !== 40) {
    failures.push("el saldo parcial no quedó en centavos");
  }
  const pendingAfter = paidFloat.balances.reduce((sum, line) => sum + balanceCents(line).pending, 0);
  const paidAfter = paidFloat.balances.reduce((sum, line) => sum + balanceCents(line).paid, 0);
  const generatedAfter = paidFloat.balances.reduce((sum, line) => sum + balanceCents(line).generated, 0);
  if (paidAfter !== 10000 || pendingAfter !== 40 || generatedAfter !== paidAfter + pendingAfter) {
    failures.push("pagado y pendiente no cierran con la comisión generada");
  }
}
const partialOnly = planPayment(30, floatQueue, floats);
if (partialOnly.status !== "planned" || partialOnly.applications.reduce((sum, line) => sum + toCents(line.amount), 0) !== 3000) {
  failures.push("el pago parcial debía sumar exactamente 30.00");
}
const tooMuch = planPayment(100.42, floatQueue, floats);
if (tooMuch.status !== "rejected") failures.push("un pago mayor a la comisión normalizada debía rechazarse");
const settled = balance({ saleId: "paid", soldAt: "2026-11-06T06:07:01.221Z", lineIndex: 0, generated: 23.602363367799114, paid: 23.602363367799114 });
if (balanceCents(settled).pending !== 0 || balanceCents(settled).paid !== balanceCents(settled).generated) {
  failures.push("una línea ya liquidada no debía reabrir saldo al normalizar");
}
const historicalPartial = balance({ saleId: "partial", soldAt: "2026-11-06T06:18:11.093Z", lineIndex: 0, generated: 35.40354505169867, paid: 8.588478581979318 });
if (balanceCents(historicalPartial).paid !== 859 || balanceCents(historicalPartial).pending !== 2681) {
  failures.push("el pago histórico parcial debía conservarse al centavo más cercano");
}
if (fromCents(10040) !== 100.4) failures.push("la conversión de centavos alteró el importe");

const settledLines = [floats[0], floats[1], floats[2]].map((line) => ({ ...line, paid: line.generated }));
const partialPaid = { ...floats[3], paid: fromCents(2859) };
const stillOpen = floats[4];
const currentLines = [...settledLines, partialPaid, stillOpen];
const historicalPayment: CommissionPayment = {
  operationId: "pay-50",
  ownerUid: "owner-1",
  sellerUid: "seller-1",
  sellerName: "Ana",
  paidAt: "2026-11-06T06:41:00.000Z",
  amount: 50,
  applications: [
    { saleId: "old-1", lineIndex: 0, inventoryId: "inv-a", invoiceNumber: "0000101004", productId: "prod-1", productName: "Producto de ejemplo 1", amount: 23.602363367799114, pendingAfter: 0 },
    { saleId: "old-1", lineIndex: 1, inventoryId: "inv-a", invoiceNumber: "", productId: "prod-1", productName: "Producto de ejemplo 2", amount: 8.904579025110783, pendingAfter: 0 },
    { saleId: "old-2", lineIndex: 0, inventoryId: "inv-a", invoiceNumber: "", productId: "prod-1", productName: "Producto de ejemplo 2", amount: 8.904579025110783, pendingAfter: 0 },
    { saleId: "old-3", lineIndex: 0, inventoryId: "inv-a", invoiceNumber: "0000101004", productId: "prod-1", productName: "Producto de ejemplo 1", amount: 8.588478581979318, pendingAfter: 26.815066469719355 },
  ],
};
const laterPayment: CommissionPayment = {
  operationId: "pay-20",
  ownerUid: "owner-1",
  sellerUid: "seller-1",
  sellerName: "Ana",
  paidAt: "2026-11-06T07:11:00.000Z",
  amount: 20,
  applications: [
    { saleId: "old-3", lineIndex: 0, inventoryId: "inv-a", invoiceNumber: "0000101004", productId: "prod-1", productName: "Producto de ejemplo 1", amount: 20, pendingAfter: 6.81 },
  ],
};
const historicalSnapshot = JSON.stringify(historicalPayment);
const laterSnapshot = JSON.stringify(laterPayment);
const lineSnapshot = JSON.stringify(currentLines);
const openQueue = enqueueOpenLines(emptyQueue("owner-1", "seller-1"), currentLines);
const firstLook = assessHistoricalRounding([historicalPayment, laterPayment], currentLines);
const secondLook = assessHistoricalRounding([historicalPayment, laterPayment], currentLines);
if (firstLook.status !== "adjust" || secondLook.status !== "adjust" || firstLook.saleId !== "old-3" || secondLook.saleId !== firstLook.saleId) {
  failures.push("dos lecturas simultáneas debían reconocer el mismo ajuste de un centavo");
}
const adjustedPaid = firstLook.status === "adjust" ? firstLook.balances.reduce((sum, line) => sum + balanceCents(line).paid, 0) : 0;
const adjustedPending = firstLook.status === "adjust" ? firstLook.balances.reduce((sum, line) => sum + balanceCents(line).pending, 0) : 0;
if (adjustedPaid !== 7000 || adjustedPending !== 3040) {
  failures.push("el ajuste debía dejar pagado 70.00 y pendiente 30.40");
}
if (JSON.stringify(historicalPayment) !== historicalSnapshot || JSON.stringify(laterPayment) !== laterSnapshot || JSON.stringify(currentLines) !== lineSnapshot) {
  failures.push("el ajuste no debía modificar los pagos ni los saldos guardados");
}
const nextPayment = firstLook.status === "adjust"
  ? planPayment(6.8, openQueue, firstLook.balances)
  : null;
if (!nextPayment || nextPayment.status !== "planned" || toCents(nextPayment.applications[0]?.amount ?? 0) !== 680 || toCents(nextPayment.applications[0]?.pendingAfter ?? 1) !== 0) {
  failures.push("el siguiente pago debía usar el pendiente ajustado de 6.80");
}
const storedAfterPayment = currentLines.map((line) => {
  const updated = nextPayment?.status === "planned"
    ? nextPayment.balances.find((item) => lineKey(item.saleId, item.lineIndex) === lineKey(line.saleId, line.lineIndex))
    : null;
  return updated ?? line;
});
const savedNext: CommissionPayment = {
  operationId: "pay-680",
  ownerUid: "owner-1",
  sellerUid: "seller-1",
  sellerName: "Ana",
  paidAt: "2026-11-06T08:00:00.000Z",
  amount: 6.8,
  applications: nextPayment?.status === "planned" ? nextPayment.applications : [],
};
const reread = assessHistoricalRounding([historicalPayment, laterPayment, savedNext], storedAfterPayment);
if (reread.status !== "none" || reread.balances.reduce((sum, line) => sum + balanceCents(line).pending, 0) !== 2360) {
  failures.push("al volver a leer, el centavo no debía descontarse otra vez");
}
const partialCent = firstLook.status === "adjust" ? planPayment(1, openQueue, firstLook.balances) : null;
const paidAfterPartial = partialCent?.status === "planned"
  ? partialCent.balances.find((line) => line.saleId === "old-3")
  : null;
if (!paidAfterPartial || balanceCents(paidAfterPartial).paid !== 2960 || toCents(partialCent?.status === "planned" ? partialCent.applications[0]?.amount ?? 0 : 0) !== 100) {
  failures.push("un abono parcial debía guardar el centavo completo en paid");
}
const unexplained = assessHistoricalRounding([{ ...laterPayment, amount: 20.02 }, historicalPayment], currentLines);
if (unexplained.status !== "unexplained" || JSON.stringify(currentLines) !== lineSnapshot) {
  failures.push("una diferencia distinta de C$0.01 debía detenerse sin cambiar saldos");
}
const createdAdjusted = firstLook.status === "adjust"
  ? commitPayment(
    { operationId: "pay-680", ownerUid: "owner-1", sellerUid: "seller-1", sellerName: "Ana", paidAt: "2026-11-06T08:00:00.000Z", amount: 6.8 },
    { existingPayment: null, queue: openQueue, balances: firstLook.balances },
  )
  : null;
const replayAdjusted = createdAdjusted?.status === "created"
  ? commitPayment(
    { operationId: "pay-680", ownerUid: "owner-1", sellerUid: "seller-1", sellerName: "Ana", paidAt: "2026-11-06T08:00:00.000Z", amount: 6.8 },
    { existingPayment: createdAdjusted.payment, queue: createdAdjusted.queue, balances: createdAdjusted.balances },
  )
  : null;
const samePayment = replayAdjusted?.status === "existing" && createdAdjusted?.status === "created" && replayAdjusted.payment === createdAdjusted.payment;
if (!samePayment) failures.push("repetir el pago ajustado debía devolver el mismo registro");
if (createdAdjusted?.status === "created" && createdAdjusted.payment.applications.some((line) => line.amount === 0.01)) {
  failures.push("el centavo no debía guardarse como una aplicación nueva");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("commissions ok");
