import { collection, doc, getDoc, getDocs, query, runTransaction, where } from "firebase/firestore";
import { auth, db } from "../firebase";
import {
  balanceDocumentId,
  balancesFromSale,
  emptyQueue,
  enqueueOpenLines,
  PAYMENTS_COLLECTION,
  queueDocumentId,
  queueFromDoc,
} from "./commissionCommit";
import { inventoryFromDoc, PRICING_COLLECTION } from "./firestorePricing";
import {
  commitSale,
  stockDocumentId,
  stockKey,
  type PricingSale,
  type SaleCommitRequest,
  type SaleLineSnapshot,
  type StockBalance,
} from "./saleCommit";
import type { CommissionMethod } from "./types";

export const SALES_COLLECTION = "pricing_sales";

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Inicia sesión para registrar la venta.");
  return user;
}

function asLine(value: unknown): SaleLineSnapshot {
  const row = (value || {}) as Partial<SaleLineSnapshot>;
  const method: CommissionMethod = row.commissionMethod === "3" ? "3" : "2";
  return {
    inventoryId: String(row.inventoryId || ""),
    inventoryName: String(row.inventoryName || ""),
    productId: String(row.productId || ""),
    productName: String(row.productName || ""),
    invoiceNumber: String(row.invoiceNumber || ""),
    quantity: Number(row.quantity || 0),
    appliedPrice: Number(row.appliedPrice || 0),
    costPerPack: Number(row.costPerPack || 0),
    logisticsPerPack: Number(row.logisticsPerPack || 0),
    grossProfitPerPack: Number(row.grossProfitPerPack || 0),
    vendorProfitPerPack: Number(row.vendorProfitPerPack || 0),
    investorNetPerPack: Number(row.investorNetPerPack || 0),
    commissionMethod: method,
    vendorSharePercent: Number(row.vendorSharePercent || 0),
    salesTotal: Number(row.salesTotal || 0),
    grossProfit: Number(row.grossProfit || 0),
    vendorProfit: Number(row.vendorProfit || 0),
    investorNet: Number(row.investorNet || 0),
  };
}

export function saleFromDoc(id: string, data: Record<string, unknown>): PricingSale {
  const lines = Array.isArray(data.lines) ? data.lines.map(asLine) : [];
  return {
    operationId: String(data.operationId || id),
    ownerUid: String(data.ownerUid || ""),
    sellerUid: String(data.sellerUid || ""),
    sellerName: String(data.sellerName || ""),
    soldAt: String(data.soldAt || ""),
    packageCount: Number(data.packageCount || 0),
    salesTotal: Number(data.salesTotal || 0),
    grossProfit: Number(data.grossProfit || 0),
    vendorProfit: Number(data.vendorProfit || 0),
    investorNet: Number(data.investorNet || 0),
    lines,
  };
}

function salePayload(sale: PricingSale): Record<string, unknown> {
  return { type: "sale", ...sale };
}

function stockPayload(balance: StockBalance): Record<string, unknown> {
  return { type: "stock", ...balance };
}

function commissionBalancePayload(balance: ReturnType<typeof balancesFromSale>[number], updatedAt: string): Record<string, unknown> {
  return { type: "balance", ...balance, updatedAt };
}

function commissionQueuePayload(queue: ReturnType<typeof emptyQueue>, updatedAt: string): Record<string, unknown> {
  return { type: "queue", ...queue, updatedAt };
}

export async function listPricingSales(): Promise<PricingSale[]> {
  requireUser();
  const snap = await getDocs(query(collection(db, SALES_COLLECTION), where("type", "==", "sale")));
  return snap.docs
    .map((item) => saleFromDoc(item.id, item.data() as Record<string, unknown>))
    .sort((left, right) => right.soldAt.localeCompare(left.soldAt));
}

export async function readSellerName(): Promise<string> {
  const user = requireUser();
  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) return "";
  return String((snap.data() as { name?: unknown }).name || "").trim();
}

export async function readSoldPackages(
  keys: Array<{ inventoryId: string; productId: string }>,
): Promise<Record<string, number>> {
  requireUser();
  const wanted = new Set(keys.map((key) => stockKey(key.inventoryId, key.productId)));
  const totals = new Map<string, number>();
  if (wanted.size) {
    const snap = await getDocs(query(collection(db, SALES_COLLECTION), where("type", "==", "stock")));
    for (const item of snap.docs) {
      const data = item.data() as { inventoryId?: unknown; productId?: unknown; soldPackages?: unknown };
      const key = stockKey(String(data.inventoryId || ""), String(data.productId || ""));
      if (!wanted.has(key)) continue;
      const sold = Number(data.soldPackages || 0);
      if (!Number.isInteger(sold) || sold < 0) {
        throw new Error("El saldo de paquetes vendidos no es válido.");
      }
      totals.set(key, (totals.get(key) || 0) + sold);
    }
  }
  return Object.fromEntries([...wanted].map((key) => [key, totals.get(key) || 0]));
}

export async function registerSale(
  operationId: string,
  lines: SaleCommitRequest["lines"],
): Promise<PricingSale> {
  const user = requireUser();
  const saleRef = doc(db, SALES_COLLECTION, operationId);
  const stockCatalog = await getDocs(query(collection(db, SALES_COLLECTION), where("type", "==", "stock")));
  return runTransaction(db, async (transaction) => {
    const existing = await transaction.get(saleRef);
    if (existing.exists()) {
      const data = existing.data() as Record<string, unknown>;
      if (data.type !== "sale" || data.ownerUid !== user.uid) {
        throw new Error("Esta operación pertenece a otro usuario.");
      }
      return saleFromDoc(existing.id, data);
    }

    const profile = await transaction.get(doc(db, "users", user.uid));
    const sellerName = profile.exists()
      ? String((profile.data() as { name?: unknown }).name || "").trim()
      : "";
    const inventoryIds = [...new Set(lines.map((line) => line.inventoryId))];
    const inventories = await Promise.all(
      inventoryIds.map(async (inventoryId) => {
        const snap = await transaction.get(doc(db, PRICING_COLLECTION, inventoryId));
        if (!snap.exists()) throw new Error("Hay un inventario que ya no existe. La venta no se registró.");
        return inventoryFromDoc(snap.id, snap.data() as Record<string, unknown>);
      }),
    );
    const grouped = new Map<string, { inventoryId: string; productId: string }>();
    for (const line of lines) grouped.set(stockKey(line.inventoryId, line.productId), line);
    const stockRefs = new Map<string, ReturnType<typeof doc>>();
    for (const item of stockCatalog.docs) {
      const data = item.data() as { inventoryId?: unknown; productId?: unknown };
      const key = stockKey(String(data.inventoryId || ""), String(data.productId || ""));
      if (!grouped.has(key)) continue;
      stockRefs.set(item.id, item.ref);
    }
    for (const key of grouped.values()) {
      const id = stockDocumentId(user.uid, key.inventoryId, key.productId);
      if (!stockRefs.has(id)) stockRefs.set(id, doc(db, SALES_COLLECTION, id));
    }
    const stock: StockBalance[] = [];
    for (const ref of stockRefs.values()) {
      const snap = await transaction.get(ref);
      if (!snap.exists()) continue;
      const data = snap.data() as Partial<StockBalance> & { type?: unknown };
      if (data.type !== "stock") continue;
      const soldPackages = Number(data.soldPackages || 0);
      if (!Number.isInteger(soldPackages) || soldPackages < 0) {
        throw new Error("El saldo de paquetes vendidos no es válido.");
      }
      stock.push({
        ownerUid: String(data.ownerUid || ""),
        inventoryId: String(data.inventoryId || ""),
        productId: String(data.productId || ""),
        soldPackages,
        updatedAt: String(data.updatedAt || ""),
      });
    }
    const queueRef = doc(db, PAYMENTS_COLLECTION, queueDocumentId(user.uid, user.uid));
    const queueSnap = await transaction.get(queueRef);
    const queue = queueFromDoc(user.uid, user.uid, queueSnap.exists() ? queueSnap.data() as Record<string, unknown> : null);

    const result = commitSale(
      {
        operationId,
        ownerUid: user.uid,
        sellerUid: user.uid,
        sellerName,
        soldAt: new Date().toISOString(),
        lines,
      },
      { existingSale: null, inventories, stock },
    );
    if (result.status === "rejected") throw new Error(result.message);
    if (result.status === "existing") return result.sale;

    transaction.set(saleRef, salePayload(result.sale));
    for (const balance of result.stock) {
      transaction.set(doc(db, SALES_COLLECTION, stockDocumentId(balance.ownerUid, balance.inventoryId, balance.productId)), stockPayload(balance));
    }
    const commissions = balancesFromSale(result.sale);
    for (const commission of commissions) {
      transaction.set(
        doc(db, PAYMENTS_COLLECTION, balanceDocumentId(commission.ownerUid, commission.saleId, commission.lineIndex)),
        commissionBalancePayload(commission, result.sale.soldAt),
      );
    }
    transaction.set(queueRef, commissionQueuePayload(enqueueOpenLines(queue, commissions), result.sale.soldAt));
    return result.sale;
  });
}
