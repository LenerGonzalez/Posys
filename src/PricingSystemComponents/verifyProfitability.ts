import { buildProfitability, EMPTY_PROFITABILITY_FILTERS } from "./profitability";
import type { CommissionMethod, PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function near(actual: number, expected: number, tolerance: number, label: string) {
  if (Math.abs(actual - expected) > tolerance) failures.push(`${label}: ${actual} != ${expected}`);
}

function product(partial: Partial<ProductInput>): ProductInput {
  return {
    id: partial.id ?? "p",
    orderCode: partial.orderCode ?? "F1",
    name: partial.name ?? "Producto",
    costPerPack: partial.costPerPack ?? 1000,
    packages: partial.packages ?? 4,
    priceMethod: partial.priceMethod ?? "PRECIO",
    manualPrice: partial.manualPrice === undefined ? 2000 : partial.manualPrice,
    targetMarginPercent: partial.targetMarginPercent ?? null,
    vendorSharePercent: partial.vendorSharePercent ?? null,
  };
}

function inventory(partial: Partial<PricingInventory> & Pick<PricingInventory, "id">): PricingInventory {
  return {
    ownerUid: "user",
    ownerEmail: null,
    name: partial.name ?? partial.id,
    settings: partial.settings ?? {
      logisticsCost: 500,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: "2",
    },
    products: partial.products ?? [product({})],
    history: partial.history ?? [],
    createdAt: partial.createdAt === undefined ? "2026-05-01T18:00:00.000Z" : partial.createdAt,
    updatedAt: partial.updatedAt === undefined ? "2026-05-01T18:00:00.000Z" : partial.updatedAt,
    id: partial.id,
  };
}

const method2 = buildProfitability(
  [inventory({ id: "m2", settings: { logisticsCost: 500, vendorSharePercent: 30, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" } })],
  EMPTY_PROFITABILITY_FILTERS,
);
near(method2.purchaseSubtotal, 4000, 1e-6, "compra método 2");
near(method2.logisticsCost, 500, 1e-6, "logística método 2");
near(method2.projectedSales, 8000, 1e-6, "venta método 2");
near(method2.grossProfit, 4000, 1e-6, "bruta método 2");
near(method2.vendorProfit, 1200, 1e-6, "comisión método 2");
near(method2.investorNet, 2300, 1e-6, "neta método 2");
near(method2.roiPercent, (2300 / 4500) * 100, 1e-6, "ROI método 2");
near(method2.weightedMarginPercent, 50, 1e-6, "margen es utilidad bruta sobre venta");
near(method2.costs[0].value, method2.purchaseSubtotal, 0, "el gráfico de compra coincide");
near(method2.costs[1].value, method2.logisticsCost, 0, "el gráfico de logística coincide");
near(method2.costs[2].value, method2.vendorProfit, 0, "el gráfico de comisión coincide");
near(method2.comparison[0].value, method2.projectedSales, 0, "el gráfico de venta coincide");
near(method2.comparison[1].value, method2.grossProfit, 0, "el gráfico de utilidad coincide");
near(method2.comparison[2].value, method2.investorNet, 0, "el gráfico de neta coincide");

const method3 = buildProfitability(
  [inventory({
    id: "m3",
    settings: { logisticsCost: 500, vendorSharePercent: 30, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "3" satisfies CommissionMethod },
  })],
  EMPTY_PROFITABILITY_FILTERS,
);
near(method3.vendorProfit, 1050, 1e-6, "comisión método 3");
near(method3.investorNet, 2450, 1e-6, "neta método 3");
near(method3.roiPercent, (2450 / 4500) * 100, 1e-6, "ROI método 3");
near(method3.projectedSales, method2.projectedSales, 1e-6, "la venta no cambia con el método");

const duplicated = buildProfitability(
  [
    inventory({ id: "same" }),
    inventory({ id: "same", name: "Repetido" }),
    inventory({ id: "other" }),
  ],
  EMPTY_PROFITABILITY_FILTERS,
);
if (duplicated.inventoryCount !== 2) failures.push(`un id repetido se sumó: ${duplicated.inventoryCount}`);
near(duplicated.investorNet, 4600, 1e-6, "neta sin duplicar el mismo id");

const weighted = buildProfitability(
  [inventory({
    id: "margen",
    settings: { logisticsCost: 0, vendorSharePercent: 0, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
    products: [
      product({ id: "a", name: "Alto", costPerPack: 0, packages: 1, manualPrice: 100 }),
      product({ id: "b", name: "Medio", costPerPack: 50, packages: 1, manualPrice: 100 }),
    ],
  })],
  EMPTY_PROFITABILITY_FILTERS,
);
near(weighted.weightedMarginPercent, 75, 1e-6, "margen ponderado por venta");

const byInvoice = inventory({
  id: "facturas",
  products: [
    product({ id: "f1", orderCode: "A-1", name: "Uno", packages: 1, costPerPack: 1000, manualPrice: 2000 }),
    product({ id: "f2", orderCode: "B-2", name: "Dos", packages: 1, costPerPack: 1000, manualPrice: 2000 }),
  ],
});
const oneInvoice = buildProfitability([byInvoice], { ...EMPTY_PROFITABILITY_FILTERS, invoice: "A-1" });
const bothInvoices = buildProfitability([byInvoice], EMPTY_PROFITABILITY_FILTERS);
near(oneInvoice.purchaseSubtotal, 1000, 1e-6, "compra de una factura");
near(oneInvoice.logisticsCost, 250, 1e-6, "logística ya asignada a la factura");
near(oneInvoice.investorNet, 450, 1e-6, "neta de una factura");
near(bothInvoices.investorNet, 900, 1e-6, "neta de las dos facturas");
near(oneInvoice.logisticsCost * 2, bothInvoices.logisticsCost, 1e-6, "la factura no vuelve a prorratear toda la logística");
if (oneInvoice.historyAvailable) failures.push("el historial no debe mezclarse con el filtro de factura");

const dated = inventory({
  id: "fecha",
  updatedAt: "2026-05-01T18:00:00.000Z",
  history: [
    {
      savedAt: "2026-05-01T18:00:00.000Z",
      productCount: 1,
      packages: 4,
      purchaseSubtotal: 4000,
      logisticsCost: 500,
      projectedSales: 7000,
      grossProfit: 3000,
      vendorProfit: 900,
      investorBeforeLogistics: 2100,
      investorNet: 100,
    },
    {
      savedAt: "2026-05-02T18:00:00.000Z",
      productCount: 1,
      packages: 4,
      purchaseSubtotal: 4000,
      logisticsCost: 500,
      projectedSales: 8000,
      grossProfit: 4000,
      vendorProfit: 1200,
      investorBeforeLogistics: 2800,
      investorNet: 180,
    },
  ],
});
const history = buildProfitability([dated], EMPTY_PROFITABILITY_FILTERS);
near(history.investorNet, 2300, 1e-6, "el indicador actual no usa el historial");
near(history.historicalInvestorNet, 180, 1e-6, "el histórico usa el último guardado");
if (history.evolution.length !== 2) failures.push(`la evolución debía tener 2 registros: ${history.evolution.length}`);
if (history.evolution[0]?.savedAt !== "2026-05-01T18:00:00.000Z") failures.push("el primer guardado perdió la hora");
if (history.evolution[1]?.savedAt !== "2026-05-02T18:00:00.000Z") failures.push("el segundo guardado perdió la hora");
near(history.evolution[0]?.investorNet ?? 0, 100, 1e-6, "primer guardado");
near(history.evolution[1]?.investorNet ?? 0, 180, 1e-6, "segundo guardado, sin acumular el anterior");

const sameDay = buildProfitability(
  [inventory({
    id: "dia",
    history: [
      { ...dated.history[0], savedAt: "2026-05-02T15:00:00.000Z", investorNet: 100 },
      { ...dated.history[0], savedAt: "2026-05-02T20:00:00.000Z", investorNet: 180 },
    ],
  })],
  EMPTY_PROFITABILITY_FILTERS,
);
if (sameDay.evolution.length !== 2) failures.push("dos guardados del mismo día deben verse por separado");
if (sameDay.evolution[0]?.savedAt !== "2026-05-02T15:00:00.000Z") failures.push("se perdió el guardado de las 15:00");
if (sameDay.evolution[1]?.savedAt !== "2026-05-02T20:00:00.000Z") failures.push("se perdió el guardado de las 20:00");
near(sameDay.evolution[0]?.investorNet ?? 0, 100, 1e-6, "el guardado de las 15:00 se conserva");
near(sameDay.evolution[1]?.investorNet ?? 0, 180, 1e-6, "el guardado de las 20:00 se conserva");
near(sameDay.historicalInvestorNet, 180, 1e-6, "el resumen histórico sigue usando el último guardado");

const outside = buildProfitability([dated], { ...EMPTY_PROFITABILITY_FILTERS, from: "2026-06-01", to: "2026-06-30" });
if (outside.inventoryCount !== 0) failures.push("una fecha fuera de rango no debía entrar");

const inside = buildProfitability([dated], { ...EMPTY_PROFITABILITY_FILTERS, from: "2026-05-02", to: "2026-05-02" });
if (inside.inventoryCount !== 0) failures.push("el inventario actualizado en mayo 1 no entra al filtro del mayo 2");

const mayFirst = buildProfitability([dated], { ...EMPTY_PROFITABILITY_FILTERS, from: "2026-05-01", to: "2026-05-01" });
if (mayFirst.inventoryCount !== 1) failures.push("la fecha inicial y final inclusivas no incluyeron el inventario");
near(mayFirst.historicalInvestorNet, 100, 1e-6, "en el rango solo entra el guardado de ese día");
if (mayFirst.evolution.length !== 1) failures.push("la evolución debía limitarse al rango");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("profitability ok", {
  method2Net: method2.investorNet,
  method3Net: method3.investorNet,
  roi: method2.roiPercent,
  weighted: weighted.weightedMarginPercent,
});
