import {
  usableCommission,
  usableManualPrice,
  usableMoney,
  usablePackages,
  usableProductCommission,
  usableProductMargin,
  usableSettingsMargin,
} from "./fieldValidation";
import type {
  CommissionMethod,
  ComputedInventory,
  ComputedLine,
  ComputedTotals,
  InventorySettings,
  InventorySnapshot,
  PriceMethod,
  PricingInventory,
  ProductInput,
} from "./types";

function num(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** ROUNDUP de Excel a córdoba entero, solo hacia arriba. */
export function roundUpToCordoba(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.ceil(value - 1e-8);
}

function marginFraction(percent: number): number | null {
  const fraction = num(percent) / 100;
  if (fraction >= 1) return null;
  return Math.max(fraction, 0);
}

/**
 * Gasto asignado = logística × subtotal del producto ÷ subtotal general.
 * El residuo de punto flotante se suma a la última línea con subtotal,
 * para que la suma sea exactamente el gasto configurado.
 */
export function allocateLogistics(
  subtotals: number[],
  logisticsCost: number,
): number[] {
  const logistics = num(logisticsCost);
  const base = subtotals.map((value) => num(value));
  const total = base.reduce((sum, value) => sum + value, 0);
  if (!(logistics > 0) || !(total > 0)) return base.map(() => 0);

  const allocated = base.map((subtotal) => (logistics * subtotal) / total);
  const drift = logistics - allocated.reduce((sum, value) => sum + value, 0);
  if (drift !== 0) {
    for (let index = allocated.length - 1; index >= 0; index -= 1) {
      if (base[index] > 0) {
        allocated[index] += drift;
        break;
      }
    }
  }
  return allocated;
}

function resolveTargetMargin(
  product: ProductInput,
  settings: InventorySettings,
): number {
  if (
    product.priceMethod === "MARGEN" &&
    product.targetMarginPercent != null &&
    Number.isFinite(product.targetMarginPercent)
  ) {
    return product.targetMarginPercent;
  }
  return num(settings.targetMarginPercent);
}

/** Un inventario sin el campo guardado conserva el método 2. */
export function resolveCommissionMethod(value: unknown): CommissionMethod {
  return value === "3" ? "3" : "2";
}

/**
 * Método 2: comisión = utilidad bruta × porcentaje.
 * Método 3: base = utilidad bruta − logística; comisión = base × porcentaje.
 * Si la base del método 3 no es positiva, la comisión queda en cero.
 */
export function splitCommission(
  grossProfit: number,
  logisticsAllocated: number,
  vendorSharePercent: number,
  method: CommissionMethod,
): {
  commissionBase: number;
  vendorProfit: number;
  investorBeforeLogistics: number;
  investorNet: number;
} {
  const rate = num(vendorSharePercent) / 100;
  if (method === "3") {
    const commissionBase = grossProfit - logisticsAllocated;
    const vendorProfit = commissionBase > 0 ? commissionBase * rate : 0;
    return {
      commissionBase,
      vendorProfit,
      investorBeforeLogistics: grossProfit - vendorProfit,
      investorNet: commissionBase - vendorProfit,
    };
  }
  const vendorProfit = grossProfit * rate;
  return {
    commissionBase: grossProfit,
    vendorProfit,
    investorBeforeLogistics: grossProfit - vendorProfit,
    investorNet: grossProfit - logisticsAllocated - vendorProfit,
  };
}

function resolveVendorShare(
  product: ProductInput,
  settings: InventorySettings,
): number {
  if (
    product.vendorSharePercent != null &&
    Number.isFinite(product.vendorSharePercent)
  ) {
    return product.vendorSharePercent;
  }
  return num(settings.vendorSharePercent);
}

function automaticPrice(
  costPerPack: number,
  logisticsPerPack: number,
  targetMarginPercent: number,
): number {
  const fraction = marginFraction(targetMarginPercent);
  if (fraction == null) return 0;
  const raw = (num(costPerPack) + num(logisticsPerPack)) / (1 - fraction);
  return roundUpToCordoba(raw);
}

export function computeInventory(inventory: PricingInventory): ComputedInventory {
  const settings = {
    ...inventory.settings,
    logisticsCost: usableMoney(inventory.settings.logisticsCost),
    vendorSharePercent: usableCommission(inventory.settings.vendorSharePercent),
    targetMarginPercent: usableSettingsMargin(inventory.settings.targetMarginPercent),
    commissionMethod: resolveCommissionMethod(inventory.settings.commissionMethod),
  };
  const products = inventory.products
    .filter((product) => product.name.trim())
    .map((product) => ({
      ...product,
      costPerPack: usableMoney(product.costPerPack),
      packages: usablePackages(product.packages),
      manualPrice: usableManualPrice(product.manualPrice),
      targetMarginPercent: usableProductMargin(product.targetMarginPercent),
      vendorSharePercent: usableProductCommission(product.vendorSharePercent),
    }));
  const subtotals = products.map(
    (product) => num(product.costPerPack) * num(product.packages),
  );
  const logistics = allocateLogistics(subtotals, settings.logisticsCost);

  const lines: ComputedLine[] = products.map((product, index) => {
    const packages = num(product.packages);
    const costPerPack = num(product.costPerPack);
    const purchaseSubtotal = subtotals[index];
    const logisticsAllocated = logistics[index];
    const logisticsPerPack = packages > 0 ? logisticsAllocated / packages : 0;
    const targetMarginPercent = resolveTargetMargin(product, settings);
    const auto = automaticPrice(costPerPack, logisticsPerPack, targetMarginPercent);
    const manual =
      product.priceMethod === "PRECIO" &&
      product.manualPrice != null &&
      num(product.manualPrice) > 0
        ? num(product.manualPrice)
        : 0;
    const appliedPrice = manual > 0 ? manual : auto;
    const costPlusLogisticsPerPack = costPerPack + logisticsPerPack;
    const realMarginPercent =
      appliedPrice > 0
        ? (1 - costPlusLogisticsPerPack / appliedPrice) * 100
        : 0;
    const salesTotal = appliedPrice * packages;
    const grossProfit = salesTotal - purchaseSubtotal;
    const grossProfitPerPack = packages > 0 ? grossProfit / packages : 0;
    const systemGrossMarginPercent =
      salesTotal > 0 ? (1 - purchaseSubtotal / salesTotal) * 100 : 0;
    const vendorSharePercent = resolveVendorShare(product, settings);
    const method = resolveCommissionMethod(settings.commissionMethod);
    const split = splitCommission(
      grossProfit,
      logisticsAllocated,
      vendorSharePercent,
      method,
    );
    const commissionBase = split.commissionBase;
    const commissionBasePerPack = packages > 0 ? commissionBase / packages : 0;
    const vendorProfit = split.vendorProfit;
    const vendorProfitPerPack = packages > 0 ? vendorProfit / packages : 0;
    const investorBeforeLogistics = split.investorBeforeLogistics;
    const investorBeforeLogisticsPerPack =
      packages > 0 ? investorBeforeLogistics / packages : 0;
    const investorNet = split.investorNet;
    const investorNetPerPack = packages > 0 ? investorNet / packages : 0;

    return {
      id: product.id,
      orderCode: product.orderCode,
      name: product.name,
      costPerPack,
      packages,
      purchaseSubtotal,
      automaticPrice: auto,
      manualPrice: manual,
      appliedPrice,
      realMarginPercent,
      salesTotal,
      grossProfit,
      grossProfitPerPack,
      systemGrossMarginPercent,
      logisticsAllocated,
      logisticsPerPack,
      vendorSharePercent,
      commissionBase,
      commissionBasePerPack,
      vendorProfit,
      vendorProfitPerPack,
      investorBeforeLogistics,
      investorBeforeLogisticsPerPack,
      investorNet,
      investorNetPerPack,
      costPlusLogisticsPerPack,
      targetMarginPercent,
      priceMethod: product.priceMethod,
      alerts: {
        priceAtOrBelowCost: appliedPrice <= costPlusLogisticsPerPack + 1e-9,
        lowMargin: realMarginPercent > 0 && realMarginPercent <= 5 + 1e-9,
        investorBelowVendor:
          investorNetPerPack < vendorProfitPerPack - 1e-9,
      },
    };
  });

  const totals = lines.reduce<ComputedTotals>(
    (acc, line) => {
      acc.productCount += 1;
      acc.packages += line.packages;
      acc.purchaseSubtotal += line.purchaseSubtotal;
      acc.projectedSales += line.salesTotal;
      acc.grossProfit += line.grossProfit;
      acc.commissionBase += line.commissionBase;
      acc.vendorProfit += line.vendorProfit;
      acc.investorBeforeLogistics += line.investorBeforeLogistics;
      acc.investorNet += line.investorNet;
      return acc;
    },
    {
      productCount: 0,
      packages: 0,
      purchaseSubtotal: 0,
      logisticsCost: num(settings.logisticsCost),
      costWithLogistics: 0,
      projectedSales: 0,
      grossProfit: 0,
      commissionBase: 0,
      vendorProfit: 0,
      investorBeforeLogistics: 0,
      investorNet: 0,
      targetMarginPercent: num(settings.targetMarginPercent),
      vendorSharePercent: num(settings.vendorSharePercent),
      commissionMethod: resolveCommissionMethod(settings.commissionMethod),
    },
  );
  totals.costWithLogistics = totals.purchaseSubtotal + totals.logisticsCost;

  return { lines, totals };
}

export function snapshotFromTotals(
  totals: ComputedTotals,
  savedAt: string,
): InventorySnapshot {
  return {
    savedAt,
    productCount: totals.productCount,
    packages: totals.packages,
    purchaseSubtotal: totals.purchaseSubtotal,
    logisticsCost: totals.logisticsCost,
    projectedSales: totals.projectedSales,
    grossProfit: totals.grossProfit,
    vendorProfit: totals.vendorProfit,
    investorBeforeLogistics: totals.investorBeforeLogistics,
    investorNet: totals.investorNet,
  };
}

export function emptyProduct(partial?: Partial<ProductInput>): ProductInput {
  return {
    id: partial?.id ?? "",
    orderCode: partial?.orderCode ?? "",
    name: partial?.name ?? "",
    costPerPack: partial?.costPerPack ?? 0,
    packages: partial?.packages ?? 1,
    priceMethod: partial?.priceMethod ?? "MARGEN",
    manualPrice: partial?.manualPrice ?? null,
    targetMarginPercent: partial?.targetMarginPercent ?? null,
    vendorSharePercent: partial?.vendorSharePercent ?? null,
  };
}

export function countAlerts(lines: ComputedLine[]) {
  return lines.reduce(
    (acc, line) => {
      if (line.alerts.priceAtOrBelowCost) acc.price += 1;
      if (line.alerts.lowMargin) acc.margin += 1;
      if (line.alerts.investorBelowVendor) acc.net += 1;
      return acc;
    },
    { price: 0, margin: 0, net: 0 },
  );
}

export type { PriceMethod };
