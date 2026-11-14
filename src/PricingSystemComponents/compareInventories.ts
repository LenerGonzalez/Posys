import { activeMeasureFilter, matchesMeasureFilter, type MeasureFilter } from "./measureFilter";
import { computeInventory } from "./pricingEngine";
import { portfolioRates, uniqueInventories } from "./profitability";
import { productMeasureUnit, type MeasureUnit, type PricingInventory } from "./types";

export type MetricGoal = "higher_profit" | "higher_volume" | "lower_cost" | "neutral";
export type MetricKind = "money" | "percent" | "qty";

export interface ComparedInventory {
  id: string;
  name: string;
  invoices: string;
  savedAt: string | null;
  productCount: number;
  packages: number;
  pounds: number;
  units: number;
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
  unit: MeasureUnit | null;
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
];

const QUANTITY_METRICS: Array<{ key: keyof ComparedInventory; label: string; kind: MetricKind; goal: MetricGoal }> = [
  { key: "packages", label: "Cantidad de paquetes", kind: "qty", goal: "higher_volume" },
  { key: "pounds", label: "Cantidad de libras", kind: "qty", goal: "higher_volume" },
  { key: "units", label: "Cantidad de unidades", kind: "qty", goal: "higher_volume" },
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

function productKey(name: string, unit: MeasureUnit, filter: MeasureFilter): string {
  const base = name.trim().toLocaleLowerCase("es");
  return filter === "all" ? `${unit}:${base}` : base;
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

export function compareInventories(items: PricingInventory[], ids: string[], measure: MeasureFilter = "package"): InventoryComparison | null {
  const uniqueIds = [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
  if (uniqueIds.length < 2 || uniqueIds.length > 5) return null;
  const byId = new Map(uniqueInventories(items).map((item) => [item.id, item]));
  const chosen = uniqueIds.map((id) => byId.get(id));
  if (chosen.some((item) => !item)) return null;
  const selected = activeMeasureFilter(measure);
  const inventories = chosen.map((inventory) => {
    const source = inventory as PricingInventory;
    const computed = computeInventory(source);
    const units = new Map(source.products.map((product) => [product.id, product.unit]));
    const lines = computed.lines.filter((line) => matchesMeasureFilter(units.get(line.id), selected));
    const coversInventory = lines.length === computed.lines.length;
    const quantities = { package: 0, lb: 0, unit: 0 };
    lines.forEach((line) => {
      const unit = productMeasureUnit({ unit: units.get(line.id) });
      quantities[unit] += line.packages;
    });
    const money = coversInventory
      ? computed.totals
      : lines.reduce((sum, line) => {
          sum.purchaseSubtotal += line.purchaseSubtotal;
          sum.logisticsCost += line.logisticsAllocated;
          sum.projectedSales += line.salesTotal;
          sum.grossProfit += line.grossProfit;
          sum.vendorProfit += line.vendorProfit;
          sum.investorNet += line.investorNet;
          return sum;
        }, { purchaseSubtotal: 0, logisticsCost: 0, projectedSales: 0, grossProfit: 0, vendorProfit: 0, investorNet: 0 });
    const rates = portfolioRates(
      money.grossProfit,
      money.projectedSales,
      money.investorNet,
      money.purchaseSubtotal,
      money.logisticsCost,
    );
    return {
      inventory: source,
      computed,
      units,
      lines,
      summary: {
        id: source.id,
        name: source.name || "Sin nombre",
        invoices: invoiceLabel(source),
        savedAt: latestSavedAt(source),
        productCount: lines.length,
        packages: quantities.package,
        pounds: quantities.lb,
        units: quantities.unit,
        purchaseSubtotal: money.purchaseSubtotal,
        logisticsCost: money.logisticsCost,
        costWithLogistics: money.purchaseSubtotal + money.logisticsCost,
        projectedSales: money.projectedSales,
        grossProfit: money.grossProfit,
        vendorProfit: money.vendorProfit,
        investorNet: money.investorNet,
        weightedMarginPercent: rates.weightedMarginPercent,
        roiPercent: rates.roiPercent,
      } satisfies ComparedInventory,
    };
  });

  const quantityMetrics = QUANTITY_METRICS.filter((metric) => {
    if (selected === "package") return metric.key === "packages";
    if (selected === "lb") return metric.key === "pounds";
    if (selected === "unit") return metric.key === "units";
    return inventories.some((item) => Number(item.summary[metric.key]) > 0);
  });
  const metrics: MetricComparison[] = [...METRICS, ...quantityMetrics].map((metric) => {
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
    const lines = new Map<string, typeof item.lines>();
    item.lines.forEach((line) => {
      const unit = productMeasureUnit({ unit: item.units.get(line.id) });
      const key = productKey(line.name, unit, selected);
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
        const unitName = selected === "all" ? key.startsWith("lb:") ? " · Libra (lb)" : key.startsWith("unit:") ? " · Unidad" : " · Paquete" : "";
        products.push({
          id: `${key}:${occurrence}`,
          label: `${width > 1 ? `${sample?.name || key} · ${occurrence + 1}` : sample?.name || key}${unitName}`,
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
                unit: null,
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
              unit: productMeasureUnit({ unit: inventories[index].units.get(line.id) }),
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
