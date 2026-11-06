import { computeInventory } from "./pricingEngine";
import type { InventorySnapshot, PricingInventory } from "./types";

export interface ProfitabilityFilters {
  from: string;
  to: string;
  inventoryId: string;
  invoice: string;
}

export const EMPTY_PROFITABILITY_FILTERS: ProfitabilityFilters = {
  from: "",
  to: "",
  inventoryId: "",
  invoice: "",
};

export interface ProfitabilityPoint {
  name: string;
  value: number;
}

/** Un guardado real. No se agrupa por día ni se rellena con estimaciones. */
export interface ProfitabilityEvolution {
  savedAt: string;
  inventoryId: string;
  inventoryName: string;
  grossProfit: number;
  investorNet: number;
}

export interface ProfitabilityReport {
  inventoryCount: number;
  productCount: number;
  packages: number;
  purchaseSubtotal: number;
  logisticsCost: number;
  projectedSales: number;
  grossProfit: number;
  vendorProfit: number;
  investorNet: number;
  /** Utilidad bruta total / venta total × 100. No es el promedio simple de cada producto. */
  weightedMarginPercent: number;
  /** Ganancia neta del inversionista / (compra + logística) × 100. */
  roiPercent: number;
  historicalGrossProfit: number;
  historicalInvestorNet: number;
  historicalVendorProfit: number;
  historicalLogisticsCost: number;
  /** El historial guardado no separa facturas, así que no se mezcla con ese filtro. */
  historyAvailable: boolean;
  costs: ProfitabilityPoint[];
  comparison: ProfitabilityPoint[];
  evolution: ProfitabilityEvolution[];
}

export function calendarDay(iso: string | null): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function inRange(iso: string | null, from: string, to: string): boolean {
  if (!from && !to) return true;
  const day = calendarDay(iso);
  if (!day) return false;
  if (from && day < from) return false;
  if (to && day > to) return false;
  return true;
}

/** Un mismo documento no se suma dos veces, aunque la lista lo traiga repetido. */
export function uniqueInventories(items: PricingInventory[]): PricingInventory[] {
  const byId = new Map<string, PricingInventory>();
  items.forEach((item) => {
    if (!item.id) return;
    byId.set(item.id, item);
  });
  return [...byId.values()];
}

export function scopeInventories(
  items: PricingInventory[],
  filters: Pick<ProfitabilityFilters, "from" | "to" | "inventoryId">,
): PricingInventory[] {
  return uniqueInventories(items).filter((item) => {
    if (filters.inventoryId && item.id !== filters.inventoryId) return false;
    return inRange(item.updatedAt || item.createdAt, filters.from, filters.to);
  });
}

export function invoiceOptions(
  items: PricingInventory[],
  filters: Pick<ProfitabilityFilters, "from" | "to" | "inventoryId">,
): string[] {
  const codes = new Set<string>();
  scopeInventories(items, filters).forEach((item) => {
    item.products.forEach((product) => {
      const code = product.orderCode.trim();
      if (code) codes.add(code);
    });
  });
  return [...codes].sort((a, b) => a.localeCompare(b, "es"));
}

/** Mismo margen ponderado y ROI que usa el dashboard. No recalcula precios ni comisiones. */
export function portfolioRates(
  grossProfit: number,
  projectedSales: number,
  investorNet: number,
  purchaseSubtotal: number,
  logisticsCost: number,
): { weightedMarginPercent: number; roiPercent: number } {
  const investment = purchaseSubtotal + logisticsCost;
  return {
    weightedMarginPercent: projectedSales > 0 ? (grossProfit / projectedSales) * 100 : 0,
    roiPercent: investment > 0 ? (investorNet / investment) * 100 : 0,
  };
}

function latestSnapshot(
  history: InventorySnapshot[],
  from: string,
  to: string,
): InventorySnapshot | null {
  let best: InventorySnapshot | null = null;
  history.forEach((item) => {
    if (!inRange(item.savedAt, from, to)) return;
    if (!best || item.savedAt > best.savedAt) best = item;
  });
  return best;
}

function emptyReport(historyAvailable: boolean): ProfitabilityReport {
  return {
    inventoryCount: 0,
    productCount: 0,
    packages: 0,
    purchaseSubtotal: 0,
    logisticsCost: 0,
    projectedSales: 0,
    grossProfit: 0,
    vendorProfit: 0,
    investorNet: 0,
    weightedMarginPercent: 0,
    roiPercent: 0,
    historicalGrossProfit: 0,
    historicalInvestorNet: 0,
    historicalVendorProfit: 0,
    historicalLogisticsCost: 0,
    historyAvailable,
    costs: [
      { name: "Compra", value: 0 },
      { name: "Logística", value: 0 },
      { name: "Comisión del vendedor", value: 0 },
    ],
    comparison: [
      { name: "Venta", value: 0 },
      { name: "Utilidad bruta", value: 0 },
      { name: "Ganancia neta del inversionista", value: 0 },
    ],
    evolution: [],
  };
}

export function buildProfitability(
  items: PricingInventory[],
  filters: ProfitabilityFilters,
): ProfitabilityReport {
  const invoice = filters.invoice.trim();
  const historyAvailable = invoice === "";
  const report = emptyReport(historyAvailable);
  const evolution: ProfitabilityEvolution[] = [];

  scopeInventories(items, filters).forEach((item) => {
    const computed = computeInventory(item);
    const lines = invoice
      ? computed.lines.filter((line) => line.orderCode.trim() === invoice)
      : computed.lines;
    if (invoice && lines.length === 0) return;

    report.inventoryCount += 1;
    if (invoice) {
      lines.forEach((line) => {
        report.productCount += 1;
        report.packages += line.packages;
        report.purchaseSubtotal += line.purchaseSubtotal;
        report.logisticsCost += line.logisticsAllocated;
        report.projectedSales += line.salesTotal;
        report.grossProfit += line.grossProfit;
        report.vendorProfit += line.vendorProfit;
        report.investorNet += line.investorNet;
      });
    } else {
      report.productCount += computed.totals.productCount;
      report.packages += computed.totals.packages;
      report.purchaseSubtotal += computed.totals.purchaseSubtotal;
      report.logisticsCost += computed.totals.logisticsCost;
      report.projectedSales += computed.totals.projectedSales;
      report.grossProfit += computed.totals.grossProfit;
      report.vendorProfit += computed.totals.vendorProfit;
      report.investorNet += computed.totals.investorNet;
    }

    if (!historyAvailable) return;
    const snapshot = latestSnapshot(item.history, filters.from, filters.to);
    if (snapshot) {
      report.historicalGrossProfit += snapshot.grossProfit;
      report.historicalInvestorNet += snapshot.investorNet;
      report.historicalVendorProfit += snapshot.vendorProfit;
      report.historicalLogisticsCost += snapshot.logisticsCost;
    }
    item.history.forEach((entry) => {
      if (!entry.savedAt || !inRange(entry.savedAt, filters.from, filters.to)) return;
      evolution.push({
        savedAt: entry.savedAt,
        inventoryId: item.id,
        inventoryName: item.name || "Sin nombre",
        grossProfit: entry.grossProfit,
        investorNet: entry.investorNet,
      });
    });
  });

  const rates = portfolioRates(
    report.grossProfit,
    report.projectedSales,
    report.investorNet,
    report.purchaseSubtotal,
    report.logisticsCost,
  );
  report.weightedMarginPercent = rates.weightedMarginPercent;
  report.roiPercent = rates.roiPercent;
  report.costs = [
    { name: "Compra", value: report.purchaseSubtotal },
    { name: "Logística", value: report.logisticsCost },
    { name: "Comisión del vendedor", value: report.vendorProfit },
  ];
  report.comparison = [
    { name: "Venta", value: report.projectedSales },
    { name: "Utilidad bruta", value: report.grossProfit },
    { name: "Ganancia neta del inversionista", value: report.investorNet },
  ];
  report.evolution = evolution.sort(
    (left, right) =>
      left.savedAt.localeCompare(right.savedAt) ||
      left.inventoryName.localeCompare(right.inventoryName, "es") ||
      left.inventoryId.localeCompare(right.inventoryId),
  );
  return report;
}
