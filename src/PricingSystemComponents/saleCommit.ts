import { computeInventory } from "./pricingEngine";
import {
  milliFromAmount,
  QUANTITY_SCALE,
  readSaleMilli,
  readSoldMilli,
  storedSaleLine,
  storedSoldCounter,
} from "./quantity";
import { productMeasureUnit, type CommissionMethod, type MeasureUnit, type PricingInventory } from "./types";

export interface SaleProduct {
  inventoryId: string;
  inventoryName: string;
  productId: string;
  productName: string;
  invoiceNumber: string;
  unit: MeasureUnit;
  initialPackages: number;
  appliedPrice: number;
  costPerPack: number;
  logisticsPerPack: number;
  grossProfitPerPack: number;
  vendorProfitPerPack: number;
  investorNetPerPack: number;
  commissionMethod: CommissionMethod;
  vendorSharePercent: number;
}

export interface SaleLineSnapshot {
  inventoryId: string;
  inventoryName: string;
  productId: string;
  productName: string;
  invoiceNumber: string;
  unit?: MeasureUnit;
  quantity?: number;
  quantityMilli?: number;
  appliedPrice: number;
  costPerPack: number;
  logisticsPerPack: number;
  grossProfitPerPack: number;
  vendorProfitPerPack: number;
  investorNetPerPack: number;
  commissionMethod: CommissionMethod;
  vendorSharePercent: number;
  salesTotal: number;
  grossProfit: number;
  vendorProfit: number;
  investorNet: number;
}

export interface PricingSale {
  operationId: string;
  ownerUid: string;
  sellerUid: string;
  sellerName: string;
  soldAt: string;
  packageCount: number;
  salesTotal: number;
  grossProfit: number;
  vendorProfit: number;
  investorNet: number;
  lines: SaleLineSnapshot[];
  status?: "ANULADA";
  voidedAt?: string;
  voidedByUid?: string;
  voidedByName?: string;
}

export interface StockBalance {
  ownerUid: string;
  inventoryId: string;
  productId: string;
  soldPackages?: number;
  quantityMilli?: number;
  updatedAt: string;
}

export interface SaleTotals {
  packageCount: number;
  salesTotal: number;
  grossProfit: number;
  vendorProfit: number;
  investorNet: number;
}

export interface SaleCommitRequest {
  operationId: string;
  ownerUid: string;
  sellerUid: string;
  sellerName: string;
  soldAt: string;
  lines: Array<{ inventoryId: string; productId: string; quantity: number }>;
}

export interface SaleCommitState {
  existingSale: PricingSale | null;
  inventories: PricingInventory[];
  stock: StockBalance[];
}

export type SaleCommitResult =
  | { status: "existing"; sale: PricingSale }
  | { status: "created"; sale: PricingSale; stock: StockBalance[] }
  | { status: "rejected"; message: string };

export function stockKey(inventoryId: string, productId: string): string {
  return `${inventoryId}:${productId}`;
}

export function stockDocumentId(ownerUid: string, inventoryId: string, productId: string): string {
  const safe = (value: string) => encodeURIComponent(value);
  return `stock_${safe(ownerUid)}_${safe(inventoryId)}_${safe(productId)}`;
}

export function isSaleQuantity(value: number | null | undefined, unit: MeasureUnit | unknown = "package"): value is number {
  if (typeof value !== "number") return false;
  const milli = milliFromAmount(value);
  if (milli == null || milli <= 0) return false;
  return productMeasureUnit({ unit }) === "lb" || milli % QUANTITY_SCALE === 0;
}

export function saleLineAmount(line: { quantity?: unknown; quantityMilli?: unknown; unit?: unknown }): number {
  const reading = readSaleMilli(line);
  return reading.ok ? reading.milli / QUANTITY_SCALE : 0;
}

export function saleProducts(inventories: PricingInventory[]): SaleProduct[] {
  return inventories.flatMap((inventory) => {
    const computed = computeInventory(inventory);
    return computed.lines.flatMap((line) => {
      const source = inventory.products.find((product) => product.id === line.id);
      const unit = productMeasureUnit(source ?? {});
      return [{
      inventoryId: inventory.id,
      inventoryName: inventory.name.trim() || "Inventario",
      productId: line.id,
      productName: line.name,
      invoiceNumber: line.orderCode,
      unit,
      initialPackages: line.packages,
      appliedPrice: line.appliedPrice,
      costPerPack: line.costPerPack,
      logisticsPerPack: line.logisticsPerPack,
      grossProfitPerPack: line.grossProfitPerPack,
      vendorProfitPerPack: line.vendorProfitPerPack,
      investorNetPerPack: line.investorNetPerPack,
      commissionMethod: computed.totals.commissionMethod,
      vendorSharePercent: line.vendorSharePercent,
    }];
    });
  });
}

export function lineFinancials(product: SaleProduct, quantity: number): Pick<
  SaleLineSnapshot,
  "salesTotal" | "grossProfit" | "vendorProfit" | "investorNet"
> {
  return {
    salesTotal: product.appliedPrice * quantity,
    grossProfit: product.grossProfitPerPack * quantity,
    vendorProfit: product.vendorProfitPerPack * quantity,
    investorNet: product.investorNetPerPack * quantity,
  };
}

export function sumSaleLines(lines: Array<Pick<SaleLineSnapshot, "quantity" | "quantityMilli" | "unit" | "salesTotal" | "grossProfit" | "vendorProfit" | "investorNet">>): SaleTotals {
  return lines.reduce<SaleTotals>(
    (totals, line) => ({
      packageCount: totals.packageCount + (productMeasureUnit(line) === "package" ? saleLineAmount(line) : 0),
      salesTotal: totals.salesTotal + line.salesTotal,
      grossProfit: totals.grossProfit + line.grossProfit,
      vendorProfit: totals.vendorProfit + line.vendorProfit,
      investorNet: totals.investorNet + line.investorNet,
    }),
    { packageCount: 0, salesTotal: 0, grossProfit: 0, vendorProfit: 0, investorNet: 0 },
  );
}

function productMap(products: SaleProduct[]): Map<string, SaleProduct> {
  return new Map(products.map((product) => [stockKey(product.inventoryId, product.productId), product]));
}

function addSoldMilli(sold: Map<string, number>, balance: StockBalance) {
  const reading = readSoldMilli(balance);
  if (!reading.ok) throw new Error("El saldo vendido no es válido.");
  const key = stockKey(balance.inventoryId, balance.productId);
  sold.set(key, (sold.get(key) || 0) + reading.milli);
}

function soldMap(stock: StockBalance[], ownerUid: string): Map<string, number> {
  const sold = new Map<string, number>();
  for (const balance of stock) {
    if (balance.ownerUid !== ownerUid) continue;
    addSoldMilli(sold, balance);
  }
  return sold;
}

function soldTotals(stock: StockBalance[]): Map<string, number> {
  const sold = new Map<string, number>();
  for (const balance of stock) addSoldMilli(sold, balance);
  return sold;
}

function amountMilli(value: number, unit: MeasureUnit): number | null {
  if (!isSaleQuantity(value, unit)) return null;
  return milliFromAmount(value);
}

export function availablePackages(initialPackages: number, soldPackages: number): number {
  const initial = milliFromAmount(initialPackages);
  const sold = milliFromAmount(soldPackages);
  if (initial == null || sold == null) return initialPackages - soldPackages;
  return (initial - sold) / QUANTITY_SCALE;
}

export interface DraftSaleLine {
  inventoryId: string;
  productId: string;
  quantity: number | null;
}

export interface ReviewedSaleLine {
  inventoryId: string;
  productId: string;
  product: SaleProduct | null;
  quantity: number | null;
  soldPackages: number;
  available: number | null;
  availableAfter: number | null;
  financials: ReturnType<typeof lineFinancials> | null;
  message: string;
}

export function reviewSale(
  lines: DraftSaleLine[],
  products: SaleProduct[],
  soldByKey: Record<string, number>,
): { ok: boolean; message: string; totals: SaleTotals; rows: ReviewedSaleLine[] } {
  const productsByKey = productMap(products);
  const demand = new Map<string, number>();
  for (const line of lines) {
    const product = productsByKey.get(stockKey(line.inventoryId, line.productId));
    const milli = product && line.quantity != null ? amountMilli(line.quantity, product.unit) : null;
    if (milli == null) continue;
    const key = stockKey(line.inventoryId, line.productId);
    demand.set(key, (demand.get(key) || 0) + milli);
  }

  const rows: ReviewedSaleLine[] = lines.map((line) => {
    const key = stockKey(line.inventoryId, line.productId);
    const product = productsByKey.get(key) || null;
    const soldMilli = milliFromAmount(soldByKey[key] || 0) ?? 0;
    const soldPackages = soldMilli / QUANTITY_SCALE;
    if (!product) {
      return {
        inventoryId: line.inventoryId,
        productId: line.productId,
        product: null,
        quantity: line.quantity,
        soldPackages,
        available: null,
        availableAfter: null,
        financials: null,
        message: "Este producto ya no está en el inventario.",
      };
    }
    const initialMilli = milliFromAmount(product.initialPackages);
    const availableMilli = initialMilli == null ? null : initialMilli - soldMilli;
    const available = availableMilli == null ? null : availableMilli / QUANTITY_SCALE;
    const noun = product.unit === "lb" ? "libras" : product.unit === "unit" ? "unidades" : "paquetes";
    if (line.quantity == null || !isSaleQuantity(line.quantity, product.unit)) {
      return {
        inventoryId: line.inventoryId,
        productId: line.productId,
        product,
        quantity: line.quantity,
        soldPackages,
        available,
        availableAfter: available,
        financials: null,
        message: product.unit === "lb"
          ? "La cantidad de libras admite hasta tres decimales."
          : "La cantidad debe ser un entero mayor que cero.",
      };
    }
    const requested = demand.get(key) || 0;
    const over = availableMilli == null || requested > availableMilli;
    const availableAfter = availableMilli == null || over ? available : (availableMilli - requested) / QUANTITY_SCALE;
    return {
      inventoryId: line.inventoryId,
      productId: line.productId,
      product,
      quantity: line.quantity,
      soldPackages,
      available,
      availableAfter,
      financials: over ? null : lineFinancials(product, line.quantity),
      message: over ? `No hay ${noun} suficientes. Disponibles: ${available}.` : "",
    };
  });

  const ready = rows.filter((row) => row.financials && row.quantity != null);
  const totals = sumSaleLines(
    ready.map((row) => ({
      quantity: row.product && productMeasureUnit(row.product) === "package" ? row.quantity as number : 0,
      salesTotal: row.financials?.salesTotal || 0,
      grossProfit: row.financials?.grossProfit || 0,
      vendorProfit: row.financials?.vendorProfit || 0,
      investorNet: row.financials?.investorNet || 0,
    })),
  );
  if (!lines.length) {
    return { ok: false, message: "Agrega al menos un producto.", totals, rows };
  }
  const problem = rows.find((row) => row.message);
  if (problem) return { ok: false, message: problem.message, totals, rows };
  return { ok: true, message: "", totals, rows };
}

function snapshotLine(product: SaleProduct, quantity: number): SaleLineSnapshot {
  const financials = lineFinancials(product, quantity);
  const milli = amountMilli(quantity, product.unit) ?? 0;
  const stored = storedSaleLine(product.unit, milli);
  return {
    inventoryId: product.inventoryId,
    inventoryName: product.inventoryName,
    productId: product.productId,
    productName: product.productName,
    invoiceNumber: product.invoiceNumber,
    ...stored,
    appliedPrice: product.appliedPrice,
    costPerPack: product.costPerPack,
    logisticsPerPack: product.logisticsPerPack,
    grossProfitPerPack: product.grossProfitPerPack,
    vendorProfitPerPack: product.vendorProfitPerPack,
    investorNetPerPack: product.investorNetPerPack,
    commissionMethod: product.commissionMethod,
    vendorSharePercent: product.vendorSharePercent,
    ...financials,
  };
}

export function commitSale(request: SaleCommitRequest, state: SaleCommitState): SaleCommitResult {
  const operationId = request.operationId.trim();
  if (!operationId || operationId.startsWith("stock_")) {
    return { status: "rejected", message: "La operación no tiene un identificador válido." };
  }
  if (!request.ownerUid || request.sellerUid !== request.ownerUid) {
    return { status: "rejected", message: "La venta debe registrarse con el usuario autenticado." };
  }
  if (!request.sellerName.trim()) {
    return { status: "rejected", message: "El perfil no tiene un nombre de vendedor." };
  }
  if (state.existingSale) {
    if (state.existingSale.ownerUid !== request.ownerUid || state.existingSale.operationId !== operationId) {
      return { status: "rejected", message: "Esta operación pertenece a otro usuario." };
    }
    return { status: "existing", sale: state.existingSale };
  }
  if (!request.lines.length) {
    return { status: "rejected", message: "Agrega al menos un producto." };
  }

  let sold: Map<string, number>;
  let ownSold: Map<string, number>;
  try {
    sold = soldTotals(state.stock);
    ownSold = soldMap(state.stock, request.ownerUid);
  } catch (error) {
    return { status: "rejected", message: error instanceof Error ? error.message : "El saldo de paquetes vendidos no es válido." };
  }

  const products = productMap(saleProducts(state.inventories));
  const demand = new Map<string, number>();
  for (const line of request.lines) {
    const key = stockKey(line.inventoryId, line.productId);
    const product = products.get(key);
    if (!product) {
      return { status: "rejected", message: "Hay un producto que no pertenece a los inventarios seleccionados. La venta no se registró." };
    }
    if (!isSaleQuantity(line.quantity, product.unit)) {
      return {
        status: "rejected",
        message: product.unit === "lb"
          ? "La cantidad de libras admite hasta tres decimales. La venta no se registró."
          : "La cantidad debe ser un entero mayor que cero. La venta no se registró.",
      };
    }
    demand.set(key, (demand.get(key) || 0) + (amountMilli(line.quantity, product.unit) ?? 0));
  }

  const shortages: string[] = [];
  for (const [key, quantity] of demand) {
    const product = products.get(key);
    if (!product) continue;
    const initial = milliFromAmount(product.initialPackages);
    const available = initial == null ? 0 : initial - (sold.get(key) || 0);
    if (quantity > available) {
      shortages.push(`${product.productName} (${product.inventoryName}): disponibles ${available / QUANTITY_SCALE}`);
    }
  }
  if (shortages.length) {
    return {
      status: "rejected",
      message: `No hay cantidad suficiente. ${shortages.join(". ")}. La venta no se registró.`,
    };
  }

  const lines = request.lines.map((line) => snapshotLine(products.get(stockKey(line.inventoryId, line.productId)) as SaleProduct, line.quantity));
  const totals = sumSaleLines(lines);
  const sale: PricingSale = {
    operationId,
    ownerUid: request.ownerUid,
    sellerUid: request.sellerUid,
    sellerName: request.sellerName.trim(),
    soldAt: request.soldAt,
    packageCount: totals.packageCount,
    salesTotal: totals.salesTotal,
    grossProfit: totals.grossProfit,
    vendorProfit: totals.vendorProfit,
    investorNet: totals.investorNet,
    lines,
  };
  const stock = [...demand.entries()].map(([key, quantity]) => {
    const product = products.get(key) as SaleProduct;
    const stored = storedSoldCounter((ownSold.get(key) || 0) + quantity);
    return {
      ownerUid: request.ownerUid,
      inventoryId: product.inventoryId,
      productId: product.productId,
      ...stored,
      updatedAt: request.soldAt,
    };
  });
  return { status: "created", sale, stock };
}
