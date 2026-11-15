import { formatQuantityTotals } from "./quantity";
import {
  productMeasureUnit,
  quantityFieldLabel,
  quantityNoun,
  type ComputedLine,
  type ComputedTotals,
  type MeasureUnit,
  type ProductInput,
} from "./types";

/** Paquete, libra, unidad, o las tres sin sumar cantidades entre sí. */
export type MeasureFilter = MeasureUnit | "all";

export const DEFAULT_MEASURE_FILTER: MeasureFilter = "package";

export const MEASURE_FILTER_OPTIONS: Array<{ value: MeasureFilter; label: string }> = [
  { value: "package", label: "Paquete" },
  { value: "lb", label: "Libra (lb)" },
  { value: "unit", label: "Unidad" },
  { value: "all", label: "Todos" },
];

export function isMeasureFilter(value: unknown): value is MeasureFilter {
  return value === "package" || value === "lb" || value === "unit" || value === "all";
}

/** Si el filtro no viene, se consulta Paquete. Un producto sin unidad también es paquete. */
export function activeMeasureFilter(value: unknown): MeasureFilter {
  return isMeasureFilter(value) ? value : DEFAULT_MEASURE_FILTER;
}

export function measureFilterLabel(filter: MeasureFilter): string {
  return MEASURE_FILTER_OPTIONS.find((option) => option.value === filter)?.label ?? "Paquete";
}

export function matchesMeasureFilter(unit: unknown, filter: unknown): boolean {
  const selected = activeMeasureFilter(filter);
  if (selected === "all") return true;
  return productMeasureUnit({ unit }) === selected;
}

/** La medida del inventario: la única de sus productos. Vacío cuenta como paquete. Mezclado queda en Todos. */
export function inventoryMeasure(inventory: { products: Array<{ unit?: unknown }> }): MeasureFilter {
  const units = new Set(inventory.products.map((product) => productMeasureUnit(product)));
  if (units.size === 1) return [...units][0];
  if (units.size === 0) return DEFAULT_MEASURE_FILTER;
  return "all";
}

export function inventoryMatchesMeasure(inventory: { products: Array<{ unit?: unknown }> }, filter: unknown): boolean {
  const selected = activeMeasureFilter(filter);
  if (selected === "all") return true;
  return inventoryMeasure(inventory) === selected;
}

export function quantityCaption(filter: MeasureFilter, lines: Array<{ unit?: unknown; quantity?: unknown; quantityMilli?: unknown }>): string {
  const selected = filter === "all" ? lines : lines.filter((line) => matchesMeasureFilter(line.unit, filter));
  const label = formatQuantityTotals(selected);
  if (label !== "0" || filter === "all") return label;
  return `0 ${quantityNoun(filter)}`;
}

/** Suma los importes que el motor ya calculó. No vuelve a repartir logística ni comisión. */
export function totalsForLines(base: ComputedTotals, lines: ComputedLine[], complete: boolean): ComputedTotals {
  if (complete) return base;
  const totals: ComputedTotals = {
    ...base,
    productCount: 0,
    packages: 0,
    purchaseSubtotal: 0,
    logisticsCost: 0,
    costWithLogistics: 0,
    projectedSales: 0,
    grossProfit: 0,
    commissionBase: 0,
    vendorProfit: 0,
    investorBeforeLogistics: 0,
    investorNet: 0,
  };
  for (const line of lines) {
    totals.productCount += 1;
    totals.packages += line.packages;
    totals.purchaseSubtotal += line.purchaseSubtotal;
    totals.logisticsCost += line.logisticsAllocated;
    totals.projectedSales += line.salesTotal;
    totals.grossProfit += line.grossProfit;
    totals.commissionBase += line.commissionBase;
    totals.vendorProfit += line.vendorProfit;
    totals.investorBeforeLogistics += line.investorBeforeLogistics;
    totals.investorNet += line.investorNet;
  }
  totals.costWithLogistics = totals.purchaseSubtotal + totals.logisticsCost;
  return totals;
}

export function linesForMeasure<T extends { id: string }>(
  lines: T[],
  products: ProductInput[],
  filter: unknown,
): T[] {
  const selected = activeMeasureFilter(filter);
  if (selected === "all") return lines;
  const units = new Map(products.map((product) => [product.id, product.unit]));
  return lines.filter((line) => matchesMeasureFilter(units.get(line.id), selected));
}

export function measureQuantityLabel(filter: MeasureFilter): string {
  if (filter === "all") return "Cantidades";
  return quantityFieldLabel(filter);
}
