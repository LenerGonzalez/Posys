import { collection, doc, getDoc, getDocs, getDocsFromServer, query, runTransaction, where } from "firebase/firestore";
import { auth, db } from "../firebase";
import {
  balanceDocumentId,
  balancesFromSale,
  emptyQueue,
  enqueueOpenLines,
  PAYMENTS_COLLECTION,
  queueDocumentId,
  queueFromDoc,
  type CommissionBalance,
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
import { planSaleVoid, rolesFromProfile, saleStockDemand, type SaleVoidActor } from "./saleVoid";
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
    ...(data.status === "ANULADA"
      ? {
        status: "ANULADA" as const,
        voidedAt: String(data.voidedAt || ""),
        voidedByUid: String(data.voidedByUid || ""),
        voidedByName: String(data.voidedByName || ""),
      }
      : {}),
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

const STOCK_READ_MS = 4000;

function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("STOCK_READ_TIMEOUT")), milliseconds);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

// Safari en iOS, con la persistencia IndexedDB de Firestore, puede dejar getDocs
// pendiente para siempre en una consulta filtrada: el índice local no responde
// y la promesa ni se resuelve ni se rechaza. Si la lectura local no termina,
// se consulta el servidor para no dejar las cantidades en «Consultando».
async function readStockDocuments() {
  const stockQuery = query(collection(db, SALES_COLLECTION), where("type", "==", "stock"));
  try {
    return await withTimeout(getDocs(stockQuery), STOCK_READ_MS);
  } catch (cacheError) {
    try {
      return await withTimeout(getDocsFromServer(stockQuery), STOCK_READ_MS);
    } catch (serverError) {
      const readable = (error: unknown) =>
        error instanceof Error && error.message && error.message !== "STOCK_READ_TIMEOUT" ? error.message : "";
      throw new Error(readable(serverError) || readable(cacheError) || "No se pudieron consultar los paquetes disponibles.");
    }
  }
}

export async function readSoldPackages(
  keys: Array<{ inventoryId: string; productId: string }>,
): Promise<Record<string, number>> {
  requireUser();
  const wanted = new Set(keys.map((key) => stockKey(key.inventoryId, key.productId)));
  const totals = new Map<string, number>();
  if (wanted.size) {
    const snap = await readStockDocuments();
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

function storedBalance(data: Record<string, unknown>): CommissionBalance {
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

export async function voidSale(operationId: string): Promise<void> {
  const user = requireUser();
  const saleRef = doc(db, SALES_COLLECTION, operationId);
  await runTransaction(db, async (transaction) => {
    const saleSnap = await transaction.get(saleRef);
    if (!saleSnap.exists() || saleSnap.data().type !== "sale") {
      throw new Error("La venta no existe. La venta no se anuló.");
    }
    const sale = saleFromDoc(saleSnap.id, saleSnap.data() as Record<string, unknown>);
    if (sale.status === "ANULADA") return;

    const profileSnap = await transaction.get(doc(db, "users", user.uid));
    const profile = profileSnap.exists() ? profileSnap.data() as Record<string, unknown> : undefined;
    const actor: SaleVoidActor = {
      uid: user.uid,
      roles: rolesFromProfile(profile),
      name: String(profile?.name || "").trim(),
    };
    const demand = saleStockDemand(sale.lines);
    if (typeof demand === "string") throw new Error(demand);

    const balanceSnaps = [];
    for (const [index] of sale.lines.entries()) {
      balanceSnaps.push(await transaction.get(doc(db, PAYMENTS_COLLECTION, balanceDocumentId(sale.ownerUid, sale.operationId, index))));
    }
    const stockSnaps = [];
    for (const item of demand) {
      stockSnaps.push(await transaction.get(doc(db, SALES_COLLECTION, stockDocumentId(sale.sellerUid, item.inventoryId, item.productId))));
    }
    const queueRef = doc(db, PAYMENTS_COLLECTION, queueDocumentId(sale.ownerUid, sale.sellerUid));
    const queueSnap = await transaction.get(queueRef);

    const balances: CommissionBalance[] = [];
    for (const snap of balanceSnaps) {
      if (!snap.exists()) continue;
      const data = snap.data() as Record<string, unknown>;
      if (data.type !== "balance") continue;
      balances.push(storedBalance(data));
    }
    const stock: StockBalance[] = [];
    for (const snap of stockSnaps) {
      if (!snap.exists()) continue;
      const data = snap.data() as Partial<StockBalance> & { type?: unknown };
      if (data.type !== "stock") continue;
      stock.push({
        ownerUid: String(data.ownerUid || ""),
        inventoryId: String(data.inventoryId || ""),
        productId: String(data.productId || ""),
        soldPackages: Number(data.soldPackages || 0),
        updatedAt: String(data.updatedAt || ""),
      });
    }
    const queue = queueSnap.exists()
      ? queueFromDoc(sale.ownerUid, sale.sellerUid, queueSnap.data() as Record<string, unknown>)
      : null;
    const result = planSaleVoid(actor, new Date().toISOString(), { sale, balances, stock, queue });
    if (result.status === "rejected") throw new Error(result.message);
    if (result.status === "already") return;

    transaction.update(saleRef, {
      status: "ANULADA",
      voidedAt: result.sale.voidedAt,
      voidedByUid: result.sale.voidedByUid,
      voidedByName: result.sale.voidedByName,
    });
    for (const balance of result.stock) {
      transaction.update(doc(db, SALES_COLLECTION, stockDocumentId(balance.ownerUid, balance.inventoryId, balance.productId)), {
        soldPackages: balance.soldPackages,
        updatedAt: balance.updatedAt,
      });
    }
    for (const item of result.balances) {
      const ref = doc(db, PAYMENTS_COLLECTION, balanceDocumentId(item.balance.ownerUid, item.balance.saleId, item.balance.lineIndex));
      if (item.create) transaction.set(ref, commissionBalancePayload(item.balance, result.sale.voidedAt || ""));
      else transaction.update(ref, { generated: 0, paid: 0, updatedAt: result.sale.voidedAt });
    }
    if (result.queue) transaction.set(queueRef, commissionQueuePayload(result.queue, result.sale.voidedAt || ""));
  });
}
