import { computeInventory } from "./pricingEngine";
import type { CommissionMethod, PricingInventory } from "./types";

export interface SaleProduct {
  inventoryId: string;
  inventoryName: string;
  productId: string;
  productName: string;
  invoiceNumber: string;
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
  quantity: number;
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
}

export interface StockBalance {
  ownerUid: string;
  inventoryId: string;
  productId: string;
  soldPackages: number;
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

export function isSaleQuantity(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function saleProducts(inventories: PricingInventory[]): SaleProduct[] {
  return inventories.flatMap((inventory) => {
    const computed = computeInventory(inventory);
    return computed.lines.map((line) => ({
      inventoryId: inventory.id,
      inventoryName: inventory.name.trim() || "Inventario",
      productId: line.id,
      productName: line.name,
      invoiceNumber: line.orderCode,
      initialPackages: line.packages,
      appliedPrice: line.appliedPrice,
      costPerPack: line.costPerPack,
      logisticsPerPack: line.logisticsPerPack,
      grossProfitPerPack: line.grossProfitPerPack,
      vendorProfitPerPack: line.vendorProfitPerPack,
      investorNetPerPack: line.investorNetPerPack,
      commissionMethod: computed.totals.commissionMethod,
      vendorSharePercent: line.vendorSharePercent,
    }));
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

export function sumSaleLines(lines: Array<Pick<SaleLineSnapshot, "quantity" | "salesTotal" | "grossProfit" | "vendorProfit" | "investorNet">>): SaleTotals {
  return lines.reduce<SaleTotals>(
    (totals, line) => ({
      packageCount: totals.packageCount + line.quantity,
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

function soldMap(stock: StockBalance[], ownerUid: string): Map<string, number> {
  const sold = new Map<string, number>();
  for (const balance of stock) {
    if (balance.ownerUid !== ownerUid) continue;
    if (!Number.isInteger(balance.soldPackages) || balance.soldPackages < 0) {
      throw new Error("El saldo de paquetes vendidos no es válido.");
    }
    sold.set(stockKey(balance.inventoryId, balance.productId), balance.soldPackages);
  }
  return sold;
}

export function availablePackages(initialPackages: number, soldPackages: number): number {
  return initialPackages - soldPackages;
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
    if (!isSaleQuantity(line.quantity)) continue;
    const key = stockKey(line.inventoryId, line.productId);
    demand.set(key, (demand.get(key) || 0) + line.quantity);
  }

  const rows: ReviewedSaleLine[] = lines.map((line) => {
    const key = stockKey(line.inventoryId, line.productId);
    const product = productsByKey.get(key) || null;
    const soldPackages = soldByKey[key] || 0;
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
    const available = availablePackages(product.initialPackages, soldPackages);
    if (!isSaleQuantity(line.quantity)) {
      return {
        inventoryId: line.inventoryId,
        productId: line.productId,
        product,
        quantity: line.quantity,
        soldPackages,
        available,
        availableAfter: available - (demand.get(key) || 0),
        financials: null,
        message: "La cantidad debe ser un entero mayor que cero.",
      };
    }
    const requested = demand.get(key) || 0;
    const over = requested > available;
    return {
      inventoryId: line.inventoryId,
      productId: line.productId,
      product,
      quantity: line.quantity,
      soldPackages,
      available,
      availableAfter: over ? available : available - requested,
      financials: over ? null : lineFinancials(product, line.quantity),
      message: over ? `No hay paquetes suficientes. Disponibles: ${available}.` : "",
    };
  });

  const ready = rows.filter((row) => row.financials && row.quantity != null);
  const totals = sumSaleLines(
    ready.map((row) => ({
      quantity: row.quantity as number,
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
  return {
    inventoryId: product.inventoryId,
    inventoryName: product.inventoryName,
    productId: product.productId,
    productName: product.productName,
    invoiceNumber: product.invoiceNumber,
    quantity,
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
  try {
    sold = soldMap(state.stock, request.ownerUid);
  } catch (error) {
    return { status: "rejected", message: error instanceof Error ? error.message : "El saldo de paquetes vendidos no es válido." };
  }

  const owned = state.inventories.filter((inventory) => inventory.ownerUid === request.ownerUid);
  const products = productMap(saleProducts(owned));
  const demand = new Map<string, number>();
  for (const line of request.lines) {
    if (!isSaleQuantity(line.quantity)) {
      return { status: "rejected", message: "La cantidad debe ser un entero mayor que cero. La venta no se registró." };
    }
    const key = stockKey(line.inventoryId, line.productId);
    if (!products.has(key)) {
      return { status: "rejected", message: "Hay un producto que no pertenece a los inventarios seleccionados. La venta no se registró." };
    }
    demand.set(key, (demand.get(key) || 0) + line.quantity);
  }

  const shortages: string[] = [];
  for (const [key, quantity] of demand) {
    const product = products.get(key);
    if (!product) continue;
    const available = availablePackages(product.initialPackages, sold.get(key) || 0);
    if (quantity > available) {
      shortages.push(`${product.productName} (${product.inventoryName}): disponibles ${available}`);
    }
  }
  if (shortages.length) {
    return {
      status: "rejected",
      message: `No hay paquetes suficientes. ${shortages.join(". ")}. La venta no se registró.`,
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
    return {
      ownerUid: request.ownerUid,
      inventoryId: product.inventoryId,
      productId: product.productId,
      soldPackages: (sold.get(key) || 0) + quantity,
      updatedAt: request.soldAt,
    };
  });
  return { status: "created", sale, stock };
}
