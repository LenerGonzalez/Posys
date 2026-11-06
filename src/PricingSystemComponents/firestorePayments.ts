import { collection, doc, getDoc, getDocs, query, runTransaction, where } from "firebase/firestore";
import { auth, db } from "../firebase";
import {
  assessHistoricalRounding,
  balanceDocumentId,
  balancesFromSale,
  commitPayment,
  enqueueOpenLines,
  PAYMENTS_COLLECTION,
  queueDocumentId,
  queueFromDoc,
  UNEXPLAINED_ROUNDING_MESSAGE,
  type CommissionBalance,
  type CommissionPayment,
  type CommissionQueue,
  type PaymentApplication,
} from "./commissionCommit";
import { SALES_COLLECTION, saleFromDoc } from "./firestoreSales";
import type { PricingSale } from "./saleCommit";

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Inicia sesión para registrar el pago.");
  return user;
}

export function balanceFromDoc(data: Record<string, unknown>): CommissionBalance {
  return {
    ownerUid: String(data.ownerUid || ""),
    sellerUid: String(data.sellerUid || ""),
    saleId: String(data.saleId || ""),
    soldAt: String(data.soldAt || ""),
    lineIndex: Number(data.lineIndex || 0),
    inventoryId: String(data.inventoryId || ""),
    invoiceNumber: String(data.invoiceNumber || ""),
    productId: String(data.productId || ""),
    productName: String(data.productName || ""),
    generated: Number(data.generated || 0),
    paid: Number(data.paid || 0),
  };
}

export function paymentFromDoc(id: string, data: Record<string, unknown>): CommissionPayment {
  const applications = Array.isArray(data.applications)
    ? data.applications.map((value) => {
      const row = (value || {}) as Partial<PaymentApplication>;
      return {
        saleId: String(row.saleId || ""),
        lineIndex: Number(row.lineIndex || 0),
        inventoryId: String(row.inventoryId || ""),
        invoiceNumber: String(row.invoiceNumber || ""),
        productId: String(row.productId || ""),
        productName: String(row.productName || ""),
        amount: Number(row.amount || 0),
        pendingAfter: Number(row.pendingAfter || 0),
      };
    })
    : [];
  return {
    operationId: String(data.operationId || id),
    ownerUid: String(data.ownerUid || ""),
    sellerUid: String(data.sellerUid || ""),
    sellerName: String(data.sellerName || ""),
    paidAt: String(data.paidAt || ""),
    amount: Number(data.amount || 0),
    applications,
  };
}

function balancePayload(balance: CommissionBalance, updatedAt: string): Record<string, unknown> {
  return { type: "balance", ...balance, updatedAt };
}

function queuePayload(queue: CommissionQueue, updatedAt: string): Record<string, unknown> {
  return { type: "queue", ...queue, updatedAt };
}

function paymentPayload(payment: CommissionPayment): Record<string, unknown> {
  return { type: "payment", ...payment };
}

async function salesForOwner(ownerUid: string): Promise<PricingSale[]> {
  const snap = await getDocs(query(collection(db, SALES_COLLECTION), where("ownerUid", "==", ownerUid)));
  return snap.docs
    .map((item) => ({ id: item.id, data: item.data() as Record<string, unknown> }))
    .filter((item) => item.data.type === "sale")
    .map((item) => saleFromDoc(item.id, item.data));
}

export async function ensureCommissionBalances(): Promise<void> {
  const user = requireUser();
  const sales = await salesForOwner(user.uid);
  for (const sale of sales) {
    if (!sale.sellerUid || !sale.lines.length) continue;
    const missing = await Promise.all(sale.lines.map(async (_line, index) => {
      const snap = await getDoc(doc(db, PAYMENTS_COLLECTION, balanceDocumentId(sale.ownerUid, sale.operationId, index)));
      return !snap.exists();
    }));
    if (missing.every((item) => !item)) continue;
    await runTransaction(db, async (transaction) => {
      const saleSnap = await transaction.get(doc(db, SALES_COLLECTION, sale.operationId));
      if (!saleSnap.exists()) return;
      const stored = saleFromDoc(saleSnap.id, saleSnap.data() as Record<string, unknown>);
      if (stored.ownerUid !== user.uid) return;
      const queueRef = doc(db, PAYMENTS_COLLECTION, queueDocumentId(stored.ownerUid, stored.sellerUid));
      const queueSnap = await transaction.get(queueRef);
      const queue = queueFromDoc(
        stored.ownerUid,
        stored.sellerUid,
        queueSnap.exists() ? queueSnap.data() as Record<string, unknown> : null,
      );
      const created: CommissionBalance[] = [];
      for (const balance of balancesFromSale(stored)) {
        const snap = await transaction.get(doc(db, PAYMENTS_COLLECTION, balanceDocumentId(balance.ownerUid, balance.saleId, balance.lineIndex)));
        if (!snap.exists()) created.push(balance);
      }
      if (!created.length) return;
      const updatedAt = new Date().toISOString();
      for (const balance of created) {
        transaction.set(doc(db, PAYMENTS_COLLECTION, balanceDocumentId(balance.ownerUid, balance.saleId, balance.lineIndex)), balancePayload(balance, updatedAt));
      }
      transaction.set(queueRef, queuePayload(enqueueOpenLines(queue, created), updatedAt));
    });
  }
}

export interface CommissionBook {
  sellers: Array<{ sellerUid: string; sellerName: string }>;
  balances: CommissionBalance[];
  queues: CommissionQueue[];
  payments: CommissionPayment[];
}

export async function listCommissionActivity(): Promise<{ balances: CommissionBalance[]; payments: CommissionPayment[] }> {
  const user = requireUser();
  const snap = await getDocs(query(collection(db, PAYMENTS_COLLECTION), where("ownerUid", "==", user.uid)));
  const balances: CommissionBalance[] = [];
  const payments: CommissionPayment[] = [];
  for (const item of snap.docs) {
    const data = item.data() as Record<string, unknown>;
    if (data.ownerUid !== user.uid) continue;
    if (data.type === "balance") balances.push(balanceFromDoc(data));
    if (data.type === "payment") payments.push(paymentFromDoc(item.id, data));
  }
  return { balances, payments };
}

export async function readCommissionBook(): Promise<CommissionBook> {
  const user = requireUser();
  await ensureCommissionBalances();
  const [sales, snap] = await Promise.all([
    salesForOwner(user.uid),
    getDocs(query(collection(db, PAYMENTS_COLLECTION), where("ownerUid", "==", user.uid))),
  ]);
  const sellers = new Map<string, string>();
  for (const sale of sales) {
    if (sale.sellerUid) sellers.set(sale.sellerUid, sale.sellerName || sellers.get(sale.sellerUid) || "Vendedor");
  }
  const balances: CommissionBalance[] = [];
  const payments: CommissionPayment[] = [];
  const queues: CommissionQueue[] = [];
  for (const item of snap.docs) {
    const data = item.data() as Record<string, unknown>;
    if (data.ownerUid !== user.uid) continue;
    if (data.type === "balance") balances.push(balanceFromDoc(data));
    if (data.type === "payment") payments.push(paymentFromDoc(item.id, data));
    if (data.type === "queue") queues.push(queueFromDoc(String(data.ownerUid), String(data.sellerUid), data));
  }
  return {
    sellers: [...sellers.entries()].map(([sellerUid, sellerName]) => ({ sellerUid, sellerName })),
    balances,
    queues,
    payments: payments.sort((left, right) => right.paidAt.localeCompare(left.paidAt)),
  };
}

export async function registerPayment(operationId: string, sellerUid: string, amount: number): Promise<CommissionPayment> {
  const user = requireUser();
  const paymentRef = doc(db, PAYMENTS_COLLECTION, operationId);
  const queueRef = doc(db, PAYMENTS_COLLECTION, queueDocumentId(user.uid, sellerUid));
  const listed = await getDocs(query(collection(db, PAYMENTS_COLLECTION), where("ownerUid", "==", user.uid)));
  const paymentRefs = listed.docs.filter((item) => {
    const data = item.data() as { type?: unknown; ownerUid?: unknown; sellerUid?: unknown };
    return data.type === "payment" && data.ownerUid === user.uid && data.sellerUid === sellerUid && item.id !== operationId;
  }).map((item) => item.ref);
  const balanceRefs = listed.docs.filter((item) => {
    const data = item.data() as { type?: unknown; ownerUid?: unknown; sellerUid?: unknown };
    return data.type === "balance" && data.ownerUid === user.uid && data.sellerUid === sellerUid;
  }).map((item) => item.ref);
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(paymentRef);
    if (existing.exists()) {
      const data = existing.data() as Record<string, unknown>;
      if (data.type !== "payment" || data.ownerUid !== user.uid) {
        throw new Error("Este pago pertenece a otro usuario.");
      }
      return paymentFromDoc(existing.id, data);
    }
    const profile = await transaction.get(doc(db, "users", sellerUid));
    const sellerName = profile.exists()
      ? String((profile.data() as { name?: unknown }).name || "").trim()
      : "";
    const queueSnap = await transaction.get(queueRef);
    const queue = queueFromDoc(user.uid, sellerUid, queueSnap.exists() ? queueSnap.data() as Record<string, unknown> : null);
    const seenBalances = new Set(balanceRefs.map((item) => item.id));
    const balanceReads = [...balanceRefs];
    for (const line of queue.lines) {
      const id = balanceDocumentId(user.uid, line.saleId, line.lineIndex);
      if (seenBalances.has(id)) continue;
      seenBalances.add(id);
      balanceReads.push(doc(db, PAYMENTS_COLLECTION, id));
    }
    const payments: CommissionPayment[] = [];
    for (const ref of paymentRefs) {
      const snap = await transaction.get(ref);
      if (!snap.exists()) continue;
      const data = snap.data() as Record<string, unknown>;
      if (data.type !== "payment" || data.ownerUid !== user.uid || data.sellerUid !== sellerUid) continue;
      payments.push(paymentFromDoc(snap.id, data));
    }
    const balances: CommissionBalance[] = [];
    for (const ref of balanceReads) {
      const snap = await transaction.get(ref);
      if (!snap.exists()) continue;
      const data = snap.data() as Record<string, unknown>;
      if (data.type !== "balance" || data.ownerUid !== user.uid || data.sellerUid !== sellerUid) continue;
      balances.push(balanceFromDoc(data));
    }
    const rounding = assessHistoricalRounding(payments, balances);
    if (rounding.status === "unexplained") throw new Error(UNEXPLAINED_ROUNDING_MESSAGE);
    const result = commitPayment(
      {
        operationId,
        ownerUid: user.uid,
        sellerUid,
        sellerName,
        paidAt: new Date().toISOString(),
        amount,
      },
      { existingPayment: null, queue, balances: rounding.balances },
    );
    if (result.status === "rejected") throw new Error(result.message);
    if (result.status === "existing") return result.payment;
    const updatedAt = result.payment.paidAt;
    transaction.set(paymentRef, paymentPayload(result.payment));
    for (const balance of result.balances) {
      transaction.set(doc(db, PAYMENTS_COLLECTION, balanceDocumentId(balance.ownerUid, balance.saleId, balance.lineIndex)), balancePayload(balance, updatedAt));
    }
    transaction.set(queueRef, queuePayload(result.queue, updatedAt));
    return result.payment;
  });
}
