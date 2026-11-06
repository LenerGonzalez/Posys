import { computeInventory } from "./pricingEngine";
import { portfolioRates, uniqueInventories } from "./profitability";
import type { PricingInventory } from "./types";

export type MetricGoal = "higher_profit" | "higher_volume" | "lower_cost" | "neutral";
export type MetricKind = "money" | "percent" | "qty";

export interface ComparedInventory {
  id: string;
  name: string;
  invoices: string;
  savedAt: string | null;
  productCount: number;
  packages: number;
  purchaseSubtotal: number;
  logisticsCost: number;
  costWithLogistics: number;
  projectedSales: number;
  grossProfit: number;
  vendorProfit: number;
  investorNet: number;
  weightedMarginPercent: number;
  roiPercent: number;
}

export interface MetricCell {
  value: number;
  delta: number | null;
  deltaPercent: number | null;
  mark: "best_profit" | "highest_volume" | "lowest_cost" | null;
}

export interface MetricComparison {
  key: keyof ComparedInventory;
  label: string;
  kind: MetricKind;
  goal: MetricGoal;
  cells: MetricCell[];
}

export interface ProductSide {
  available: boolean;
  inventoryId: string;
  inventoryName: string;
  productName: string;
  costPerPack: number | null;
  appliedPrice: number | null;
  packages: number | null;
  realMarginPercent: number | null;
  investorNetPerPack: number | null;
}

export interface ProductComparisonRow {
  id: string;
  label: string;
  sides: ProductSide[];
}

export interface InventoryComparison {
  inventories: ComparedInventory[];
  metrics: MetricComparison[];
  products: ProductComparisonRow[];
}

const METRICS: Array<{ key: keyof ComparedInventory; label: string; kind: MetricKind; goal: MetricGoal }> = [
  { key: "purchaseSubtotal", label: "Inversión en compras", kind: "money", goal: "lower_cost" },
  { key: "logisticsCost", label: "Gastos logísticos", kind: "money", goal: "lower_cost" },
  { key: "costWithLogistics", label: "Costo total con logística", kind: "money", goal: "lower_cost" },
  { key: "projectedSales", label: "Venta proyectada", kind: "money", goal: "higher_volume" },
  { key: "grossProfit", label: "Utilidad bruta", kind: "money", goal: "higher_profit" },
  { key: "vendorProfit", label: "Comisión del vendedor", kind: "money", goal: "neutral" },
  { key: "investorNet", label: "Ganancia neta del inversionista", kind: "money", goal: "higher_profit" },
  { key: "weightedMarginPercent", label: "Margen de ganancia promedio ponderado", kind: "percent", goal: "higher_profit" },
  { key: "roiPercent", label: "ROI", kind: "percent", goal: "higher_profit" },
  { key: "productCount", label: "Cantidad de productos", kind: "qty", goal: "higher_volume" },
  { key: "packages", label: "Cantidad de paquetes", kind: "qty", goal: "higher_volume" },
];

function invoiceLabel(inventory: PricingInventory): string {
  const codes = [...new Set(inventory.products.map((product) => product.orderCode.trim()).filter(Boolean))];
  codes.sort((left, right) => left.localeCompare(right, "es"));
  return codes.length ? codes.join(" · ") : "Sin factura";
}

function latestSavedAt(inventory: PricingInventory): string | null {
  let best: string | null = null;
  inventory.history.forEach((entry) => {
    if (!entry.savedAt) return;
    if (!best || entry.savedAt > best) best = entry.savedAt;
  });
  return best || inventory.updatedAt || inventory.createdAt;
}

function productKey(name: string): string {
  return name.trim().toLocaleLowerCase("es");
}

function deltaPercent(base: number, value: number): number | null {
  if (Math.abs(base) < 1e-9) return null;
  return ((value - base) / Math.abs(base)) * 100;
}

function bestIndexes(values: number[], goal: MetricGoal): number[] {
  if (goal === "neutral" || values.length < 2) return [];
  const target = goal === "lower_cost" ? Math.min(...values) : Math.max(...values);
  const indexes = values.flatMap((value, index) => (Math.abs(value - target) < 1e-9 ? [index] : []));
  return indexes.length === values.length ? [] : indexes;
}

function markFor(goal: MetricGoal, marked: boolean): MetricCell["mark"] {
  if (!marked) return null;
  if (goal === "higher_profit") return "best_profit";
  if (goal === "higher_volume") return "highest_volume";
  if (goal === "lower_cost") return "lowest_cost";
  return null;
}

export function compareInventories(items: PricingInventory[], ids: string[]): InventoryComparison | null {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length < 2 || uniqueIds.length > 5) return null;
  const byId = new Map(uniqueInventories(items).map((item) => [item.id, item]));
  const chosen = uniqueIds.map((id) => byId.get(id));
  if (chosen.some((item) => !item)) return null;
  const inventories = chosen.map((inventory) => {
    const source = inventory as PricingInventory;
    const computed = computeInventory(source);
    const rates = portfolioRates(
      computed.totals.grossProfit,
      computed.totals.projectedSales,
      computed.totals.investorNet,
      computed.totals.purchaseSubtotal,
      computed.totals.logisticsCost,
    );
    return {
      inventory: source,
      computed,
      summary: {
        id: source.id,
        name: source.name || "Sin nombre",
        invoices: invoiceLabel(source),
        savedAt: latestSavedAt(source),
        productCount: computed.totals.productCount,
        packages: computed.totals.packages,
        purchaseSubtotal: computed.totals.purchaseSubtotal,
        logisticsCost: computed.totals.logisticsCost,
        costWithLogistics: computed.totals.costWithLogistics,
        projectedSales: computed.totals.projectedSales,
        grossProfit: computed.totals.grossProfit,
        vendorProfit: computed.totals.vendorProfit,
        investorNet: computed.totals.investorNet,
        weightedMarginPercent: rates.weightedMarginPercent,
        roiPercent: rates.roiPercent,
      } satisfies ComparedInventory,
    };
  });

  const metrics: MetricComparison[] = METRICS.map((metric) => {
    const values = inventories.map((item) => Number(item.summary[metric.key]));
    const winners = new Set(bestIndexes(values, metric.goal));
    const base = values[0] ?? 0;
    return {
      key: metric.key,
      label: metric.label,
      kind: metric.kind,
      goal: metric.goal,
      cells: values.map((value, index) => ({
        value,
        delta: index === 0 ? null : value - base,
        deltaPercent: index === 0 ? null : deltaPercent(base, value),
        mark: markFor(metric.goal, winners.has(index)),
      })),
    };
  });

  const grouped = inventories.map((item) => {
    const lines = new Map<string, typeof item.computed.lines>();
    item.computed.lines.forEach((line) => {
      const key = productKey(line.name);
      const bucket = lines.get(key) ?? [];
      bucket.push(line);
      lines.set(key, bucket);
    });
    return lines;
  });
  const sharedKeys = new Map<string, string>();
  grouped.forEach((lines, index) => {
    lines.forEach((_bucket, key) => {
      if (!sharedKeys.has(key)) sharedKeys.set(key, inventories[index].summary.name);
    });
  });
  const products: ProductComparisonRow[] = [];
  [...sharedKeys.keys()]
    .filter((key) => grouped.filter((lines) => lines.has(key)).length >= 2)
    .sort((left, right) => left.localeCompare(right, "es"))
    .forEach((key) => {
      const width = Math.max(...grouped.map((lines) => lines.get(key)?.length ?? 0));
      for (let occurrence = 0; occurrence < width; occurrence += 1) {
        const sample = grouped.flatMap((lines) => lines.get(key) ?? []).find(Boolean);
        products.push({
          id: `${key}:${occurrence}`,
          label: width > 1 ? `${sample?.name || key} · ${occurrence + 1}` : sample?.name || key,
          sides: grouped.map((lines, index) => {
            const line = lines.get(key)?.[occurrence];
            const summary = inventories[index].summary;
            if (!line) {
              return {
                available: false,
                inventoryId: summary.id,
                inventoryName: summary.name,
                productName: "",
                costPerPack: null,
                appliedPrice: null,
                packages: null,
                realMarginPercent: null,
                investorNetPerPack: null,
              };
            }
            return {
              available: true,
              inventoryId: summary.id,
              inventoryName: summary.name,
              productName: line.name,
              costPerPack: line.costPerPack,
              appliedPrice: line.appliedPrice,
              packages: line.packages,
              realMarginPercent: line.realMarginPercent,
              investorNetPerPack: line.investorNetPerPack,
            };
          }),
        });
      }
    });

  return {
    inventories: inventories.map((item) => item.summary),
    metrics,
    products,
  };
}
