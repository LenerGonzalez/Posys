import { computeInventory, snapshotFromTotals } from "./pricingEngine";
import type { PriceChangeRecord, PriceMethod, PricingInventory, ProductInput } from "./types";

export interface PriceRow {
  id: string;
  inventoryId: string;
  productId: string;
  origin: string;
  product: string;
  orderCode: string;
  price: number;
  margin: number;
  priceMethod: PriceMethod;
  manualPrice: number | null;
  targetMarginPercent: number | null;
  settingsMarginPercent: number;
}

export interface PriceDraft {
  priceMethod: PriceMethod;
  manualPrice: number | null;
  targetMarginPercent: number | null;
}

export interface PriceFilters {
  scope: string;
  query: string;
  minPrice: number | null;
  maxPrice: number | null;
}

export const EMPTY_PRICE_FILTERS: PriceFilters = {
  scope: "",
  query: "",
  minPrice: null,
  maxPrice: null,
};

export function priceOrigin(inventoryName: string, orderCode: string): string {
  const name = inventoryName.trim() || "Sin nombre";
  const code = orderCode.trim();
  if (!code) return `${name} · Sin factura`;
  const invoice = /^factura\b/i.test(code) ? code : `Factura ${code}`;
  return `${name} · ${invoice}`;
}

export function buildPriceRows(inventories: PricingInventory[]): PriceRow[] {
  const unique = new Map<string, PricingInventory>();
  inventories.forEach((inventory) => {
    if (inventory.id && !unique.has(inventory.id)) unique.set(inventory.id, inventory);
  });
  const rows = [...unique.values()].flatMap((inventory) => {
    const computed = computeInventory(inventory);
    return computed.lines.map((line) => {
      const source = inventory.products.find((product) => product.id === line.id);
      return {
        id: `${inventory.id}:${line.id}`,
        inventoryId: inventory.id,
        productId: line.id,
        origin: priceOrigin(inventory.name, line.orderCode),
        product: line.name || "Sin nombre",
        orderCode: line.orderCode,
        price: line.appliedPrice,
        margin: line.realMarginPercent,
        priceMethod: line.priceMethod,
        manualPrice: source?.manualPrice ?? null,
        targetMarginPercent: source?.targetMarginPercent ?? null,
        settingsMarginPercent: inventory.settings.targetMarginPercent,
      };
    });
  });
  rows.sort((left, right) => right.price - left.price || left.product.localeCompare(right.product, "es") || left.id.localeCompare(right.id));
  return rows;
}

export function priceScopeOptions(inventories: PricingInventory[]): Array<{ value: string; label: string }> {
  const unique = new Map<string, PricingInventory>();
  inventories.forEach((inventory) => {
    if (inventory.id && !unique.has(inventory.id)) unique.set(inventory.id, inventory);
  });
  const options = [{ value: "", label: "Todos los inventarios" }];
  [...unique.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "es"))
    .forEach((inventory) => {
      const codes = [...new Set(inventory.products.map((product) => product.orderCode.trim()))];
      const summary = codes
        .map((code) => (code ? (/^factura\b/i.test(code) ? code : `Factura ${code}`) : "Sin factura"))
        .join(" · ");
      options.push({ value: `inv:${inventory.id}`, label: `${inventory.name || "Sin nombre"} · ${summary}` });
    });
  return options;
}

export function filterPriceRows(rows: PriceRow[], filters: PriceFilters): PriceRow[] {
  const query = filters.query.trim().toLocaleLowerCase("es");
  return rows.filter((row) => {
    if (filters.scope.startsWith("inv:") && row.inventoryId !== filters.scope.slice(4)) return false;
    if (query && !row.product.toLocaleLowerCase("es").includes(query)) return false;
    if (filters.minPrice != null && row.price < filters.minPrice) return false;
    if (filters.maxPrice != null && row.price > filters.maxPrice) return false;
    return true;
  });
}

function patchedProducts(inventory: PricingInventory, productId: string, draft: PriceDraft): ProductInput[] | null {
  if (!inventory.products.some((product) => product.id === productId)) return null;
  return inventory.products.map((product) => {
    if (product.id !== productId) return product;
    return {
      ...product,
      priceMethod: draft.priceMethod,
      manualPrice: draft.priceMethod === "PRECIO" ? draft.manualPrice : product.manualPrice,
      targetMarginPercent: draft.priceMethod === "MARGEN" ? draft.targetMarginPercent : product.targetMarginPercent,
    };
  });
}

export function previewProductPrice(inventory: PricingInventory, productId: string, draft: PriceDraft) {
  const products = patchedProducts(inventory, productId, draft);
  if (!products) return null;
  const before = computeInventory(inventory).lines.find((line) => line.id === productId) ?? null;
  const after = computeInventory({ ...inventory, products }).lines.find((line) => line.id === productId) ?? null;
  if (!before || !after) return null;
  return { before, after };
}

export function priceDraftError(draft: PriceDraft): string | null {
  if (draft.priceMethod === "PRECIO" && !(draft.manualPrice != null && draft.manualPrice > 0)) {
    return "Indica un precio manual mayor que cero.";
  }
  if (
    draft.priceMethod === "MARGEN" &&
    draft.targetMarginPercent != null &&
    (draft.targetMarginPercent < 0 || draft.targetMarginPercent >= 100)
  ) {
    return "El margen debe ser de 0 % o más, y menor que 100 %.";
  }
  if (draft.priceMethod === "PRECIO" && draft.manualPrice != null && draft.manualPrice < 0) {
    return "El precio manual no puede ser negativo.";
  }
  return null;
}

export function applyProductPriceEdit(
  inventory: PricingInventory,
  productId: string,
  draft: PriceDraft,
  actor: { uid: string; email: string | null },
  changedAt: string,
): { inventory: PricingInventory; record: PriceChangeRecord } | { error: string } {
  const invalid = priceDraftError(draft);
  if (invalid) return { error: invalid };
  const products = patchedProducts(inventory, productId, draft);
  if (!products) return { error: "Ese producto ya no está en el inventario." };
  const current = inventory.products.find((product) => product.id === productId);
  const before = computeInventory(inventory).lines.find((line) => line.id === productId);
  const nextInventoryBase = { ...inventory, products, settings: inventory.settings };
  const afterComputed = computeInventory(nextInventoryBase);
  const after = afterComputed.lines.find((line) => line.id === productId);
  if (!current || !before || !after) return { error: "No se pudo calcular el precio." };
  const record: PriceChangeRecord = {
    changedAt,
    inventoryId: inventory.id,
    productId,
    productName: current.name,
    orderCode: current.orderCode,
    userEmail: actor.email,
    userUid: actor.uid,
    previousMethod: current.priceMethod,
    nextMethod: draft.priceMethod,
    previousAppliedPrice: before.appliedPrice,
    nextAppliedPrice: after.appliedPrice,
    previousRealMarginPercent: before.realMarginPercent,
    nextRealMarginPercent: after.realMarginPercent,
    previousManualPrice: current.manualPrice,
    nextManualPrice: draft.priceMethod === "PRECIO" ? draft.manualPrice : current.manualPrice,
    previousTargetMarginPercent: current.targetMarginPercent,
    nextTargetMarginPercent: draft.priceMethod === "MARGEN" ? draft.targetMarginPercent : current.targetMarginPercent,
  };
  return {
    record,
    inventory: {
      ...nextInventoryBase,
      history: [...inventory.history, snapshotFromTotals(afterComputed.totals, changedAt)].slice(-40),
      priceChanges: [...(inventory.priceChanges ?? []), record],
    },
  };
}

function nullableNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function normalizePriceChanges(value: unknown): PriceChangeRecord[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const row = item as Partial<PriceChangeRecord>;
    if (!row || typeof row !== "object") return [];
    const method = (value: unknown): PriceMethod => (value === "PRECIO" ? "PRECIO" : "MARGEN");
    return [{
      changedAt: String(row.changedAt || ""),
      inventoryId: String(row.inventoryId || ""),
      productId: String(row.productId || ""),
      productName: String(row.productName || ""),
      orderCode: String(row.orderCode || ""),
      userEmail: row.userEmail ? String(row.userEmail) : null,
      userUid: String(row.userUid || ""),
      previousMethod: method(row.previousMethod),
      nextMethod: method(row.nextMethod),
      previousAppliedPrice: Number(row.previousAppliedPrice || 0),
      nextAppliedPrice: Number(row.nextAppliedPrice || 0),
      previousRealMarginPercent: Number(row.previousRealMarginPercent || 0),
      nextRealMarginPercent: Number(row.nextRealMarginPercent || 0),
      previousManualPrice: nullableNumber(row.previousManualPrice),
      nextManualPrice: nullableNumber(row.nextManualPrice),
      previousTargetMarginPercent: nullableNumber(row.previousTargetMarginPercent),
      nextTargetMarginPercent: nullableNumber(row.nextTargetMarginPercent),
    }];
  });
}
