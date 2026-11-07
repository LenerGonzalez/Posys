import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  serverTimestamp,
  updateDoc,
  type Timestamp,
} from "firebase/firestore";
import { auth, db } from "../firebase";
import { applyProductPriceEdit, normalizePriceChanges, type PriceDraft } from "./priceCatalog";
import { computeInventory, resolveCommissionMethod, snapshotFromTotals } from "./pricingEngine";
import {
  DEFAULT_SETTINGS,
  type InventorySettings,
  type InventorySnapshot,
  type PricingInventory,
  type ProductInput,
} from "./types";

export const PRICING_COLLECTION = "pricing_inventories";

function isoFrom(value: unknown): string | null {
  if (!value) return null;
  if (typeof value === "string") return value;
  if (value instanceof Date) return value.toISOString();
  const stamp = value as Timestamp;
  if (typeof stamp.toDate === "function") return stamp.toDate().toISOString();
  return null;
}

function asProducts(value: unknown): ProductInput[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item as Partial<ProductInput>;
    return {
      id: String(row.id || ""),
      orderCode: String(row.orderCode || ""),
      name: String(row.name || ""),
      costPerPack: Number(row.costPerPack || 0),
      packages: Number(row.packages || 0),
      priceMethod: row.priceMethod === "PRECIO" ? "PRECIO" : "MARGEN",
      manualPrice:
        row.manualPrice == null || row.manualPrice === ("" as unknown)
          ? null
          : Number(row.manualPrice),
      targetMarginPercent:
        row.targetMarginPercent == null ? null : Number(row.targetMarginPercent),
      vendorSharePercent:
        row.vendorSharePercent == null ? null : Number(row.vendorSharePercent),
    };
  });
}

function asSettings(value: unknown): InventorySettings {
  const row = (value || {}) as Partial<InventorySettings>;
  return {
    logisticsCost: Number(row.logisticsCost ?? DEFAULT_SETTINGS.logisticsCost),
    vendorSharePercent: Number(
      row.vendorSharePercent ?? DEFAULT_SETTINGS.vendorSharePercent,
    ),
    targetMarginPercent: Number(
      row.targetMarginPercent ?? DEFAULT_SETTINGS.targetMarginPercent,
    ),
    branchLabel: String(row.branchLabel || DEFAULT_SETTINGS.branchLabel),
    commissionMethod: resolveCommissionMethod(row.commissionMethod),
  };
}

function asHistory(value: unknown): InventorySnapshot[] {
  if (!Array.isArray(value)) return [];
  return value.map((item) => {
    const row = item as InventorySnapshot;
    return {
      savedAt: String(row.savedAt || ""),
      productCount: Number(row.productCount || 0),
      packages: Number(row.packages || 0),
      purchaseSubtotal: Number(row.purchaseSubtotal || 0),
      logisticsCost: Number(row.logisticsCost || 0),
      projectedSales: Number(row.projectedSales || 0),
      grossProfit: Number(row.grossProfit || 0),
      vendorProfit: Number(row.vendorProfit || 0),
      investorBeforeLogistics: Number(row.investorBeforeLogistics || 0),
      investorNet: Number(row.investorNet || 0),
    };
  });
}

export function inventoryFromDoc(id: string, data: Record<string, unknown>): PricingInventory {
  return {
    id,
    ownerUid: String(data.ownerUid || ""),
    ownerEmail: data.ownerEmail ? String(data.ownerEmail) : null,
    name: String(data.name || "Inventario"),
    settings: asSettings(data.settings),
    products: asProducts(data.products),
    history: asHistory(data.history),
    priceChanges: normalizePriceChanges(data.priceChanges),
    createdAt: isoFrom(data.createdAt),
    updatedAt: isoFrom(data.updatedAt),
  };
}

function requireUser() {
  const user = auth.currentUser;
  if (!user) throw new Error("Inicia sesión para guardar inventarios.");
  return user;
}

function payload(inventory: PricingInventory, includeHistory: boolean) {
  const body: Record<string, unknown> = {
    ownerUid: inventory.ownerUid,
    ownerEmail: inventory.ownerEmail,
    name: inventory.name.trim() || "Inventario",
    settings: inventory.settings,
    products: inventory.products,
    priceChanges: inventory.priceChanges ?? [],
    updatedAt: serverTimestamp(),
  };
  if (includeHistory) body.history = inventory.history.slice(-40);
  return body;
}

export async function listPricingInventories(): Promise<PricingInventory[]> {
  requireUser();
  const snap = await getDocs(collection(db, PRICING_COLLECTION));
  return snap.docs
    .map((item) => inventoryFromDoc(item.id, item.data() as Record<string, unknown>))
    .sort((a, b) => (b.updatedAt || "").localeCompare(a.updatedAt || ""));
}

async function readInventory(id: string): Promise<PricingInventory> {
  requireUser();
  const snap = await getDoc(doc(db, PRICING_COLLECTION, id));
  if (!snap.exists()) throw new Error("Ese inventario ya no existe.");
  return inventoryFromDoc(snap.id, snap.data() as Record<string, unknown>);
}

export async function getPricingInventory(id: string): Promise<PricingInventory> {
  return readInventory(id);
}

export async function createPricingInventory(
  draft: Pick<PricingInventory, "name" | "settings" | "products">,
): Promise<PricingInventory> {
  const user = requireUser();
  const now = new Date().toISOString();
  const inventory: PricingInventory = {
    id: "",
    ownerUid: user.uid,
    ownerEmail: user.email,
    name: draft.name.trim() || "Inventario",
    settings: draft.settings,
    products: draft.products,
    history: [],
    priceChanges: [],
    createdAt: now,
    updatedAt: now,
  };
  const totals = computeInventory(inventory).totals;
  inventory.history = [snapshotFromTotals(totals, now)];
  const ref = await addDoc(collection(db, PRICING_COLLECTION), {
    ...payload(inventory, true),
    createdAt: serverTimestamp(),
  });
  return { ...inventory, id: ref.id };
}

export async function savePricingInventory(
  inventory: PricingInventory,
): Promise<PricingInventory> {
  requireUser();
  const stored = await readInventory(inventory.id);
  const savedAt = new Date().toISOString();
  const totals = computeInventory(inventory).totals;
  const history = [
    ...inventory.history,
    snapshotFromTotals(totals, savedAt),
  ].slice(-40);
  const next = {
    ...inventory,
    ownerUid: stored.ownerUid,
    ownerEmail: stored.ownerEmail,
    history,
    priceChanges: stored.priceChanges ?? inventory.priceChanges ?? [],
    updatedAt: savedAt,
  };
  await updateDoc(doc(db, PRICING_COLLECTION, inventory.id), payload(next, true));
  return next;
}

export async function saveProductPrice(
  inventoryId: string,
  productId: string,
  draft: PriceDraft,
): Promise<PricingInventory> {
  const user = requireUser();
  const stored = await readInventory(inventoryId);
  const edited = applyProductPriceEdit(
    stored,
    productId,
    draft,
    { uid: user.uid, email: user.email },
    new Date().toISOString(),
  );
  if ("error" in edited) throw new Error(edited.error);
  await updateDoc(doc(db, PRICING_COLLECTION, stored.id), payload(edited.inventory, true));
  return { ...edited.inventory, updatedAt: new Date().toISOString() };
}

export async function deletePricingInventory(id: string): Promise<void> {
  const inventory = await getPricingInventory(id);
  await deleteDoc(doc(db, PRICING_COLLECTION, inventory.id));
}

export async function duplicatePricingInventory(id: string): Promise<PricingInventory> {
  const source = await getPricingInventory(id);
  return createPricingInventory({
    name: `Copia de ${source.name}`,
    settings: { ...source.settings },
    products: source.products.map((product) => ({ ...product })),
  });
}
