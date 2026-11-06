import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { reviewNumericBlur, reviewNumericChange } from "./fieldValidation";
import { computeInventory, resolveCommissionMethod } from "./pricingEngine";
import type { CommissionMethod, ComputedLine, PricingInventory, ProductInput } from "./types";

const require = createRequire(import.meta.url);
const XLSX = require("xlsx") as typeof import("xlsx");

const workbookPath = new URL("./Sistema ventas.xlsx", import.meta.url);
const book = XLSX.read(readFileSync(workbookPath), { type: "buffer", cellDates: false });
const rows = XLSX.utils.sheet_to_json<(string | number)[]>(book.Sheets["OM - Productos"], {
  header: 1,
  raw: true,
  defval: "",
});

const products: ProductInput[] = [];
for (let index = 1; index < rows.length; index += 1) {
  const row = rows[index];
  const name = String(row[1] || "").trim();
  if (!name) continue;
  products.push({
    id: `row-${index + 1}`,
    orderCode: String(row[0] || ""),
    name,
    costPerPack: Number(row[2] || 0),
    packages: Number(row[3] || 0),
    priceMethod: "MARGEN",
    manualPrice: null,
    targetMarginPercent: null,
    vendorSharePercent: null,
  });
}

const inventory: PricingInventory = {
  id: "golden",
  ownerUid: "test",
  ownerEmail: null,
  name: "Referencia",
  settings: {
    logisticsCost: 1300,
    vendorSharePercent: 35,
    targetMarginPercent: 30,
    branchLabel: "Única",
    commissionMethod: "2",
  },
  products,
  history: [],
  createdAt: null,
  updatedAt: null,
};

const computed = computeInventory(inventory);
const failures: string[] = [];

function near(actual: number, expected: number, tolerance: number, label: string) {
  if (Math.abs(actual - expected) > tolerance) {
    failures.push(`${label}: ${actual} != ${expected}`);
  }
}

const totals = computed.totals;
near(totals.productCount, 47, 0, "productos");
near(totals.packages, 726, 0, "paquetes");
near(totals.purchaseSubtotal, 53484.68, 0.02, "subtotal");
near(totals.logisticsCost, 1300, 0, "logistica");
near(
  computed.lines.reduce((sum, line) => sum + line.logisticsAllocated, 0),
  1300,
  1e-6,
  "prorrateo",
);
near(totals.projectedSales, 78612, 0.05, "venta");
near(totals.grossProfit, 25127.32, 0.05, "bruta");
near(totals.vendorProfit, 8794.562, 0.05, "vendedor");
near(totals.investorBeforeLogistics, 16332.758, 0.05, "inversionista");
near(totals.investorNet, 15032.758, 0.05, "neta");

computed.lines.forEach((line, index) => {
  const row = rows[index + 1];
  near(line.appliedPrice, Number(row[7]), 0, `${line.name} precio`);
  near(line.purchaseSubtotal, Number(row[4]), 0.02, `${line.name} subtotal`);
  near(line.logisticsAllocated, Number(row[13]), 0.02, `${line.name} logistica`);
  near(line.realMarginPercent, Number(row[8]), 0.02, `${line.name} margen real`);
  near(line.systemGrossMarginPercent, Number(row[12]), 0.02, `${line.name} margen bruto`);
  near(line.vendorProfit, Number(row[17]), 0.02, `${line.name} vendedor`);
  near(line.investorBeforeLogistics, Number(row[19]), 0.02, `${line.name} antes logistica`);
  near(line.investorNet, Number(row[21]), 0.02, `${line.name} neta`);
});

function oneProduct(
  product: ProductInput,
  settings = inventory.settings,
): ComputedLine {
  return computeInventory({ ...inventory, settings, products: [product] }).lines[0];
}

const baseProduct: ProductInput = {
  id: "case",
  orderCode: "1",
  name: "Caso",
  costPerPack: 100,
  packages: 1,
  priceMethod: "PRECIO",
  manualPrice: null,
  targetMarginPercent: null,
  vendorSharePercent: null,
};
const noLogistics = { ...inventory.settings, logisticsCost: 0, vendorSharePercent: 35, targetMarginPercent: 30 };

const priceAlert = oneProduct(
  { ...baseProduct, name: "Precio insuficiente", manualPrice: 100 },
  noLogistics,
);
if (!priceAlert.alerts.priceAtOrBelowCost) failures.push("alerta 1 no disparó");
if (priceAlert.alerts.lowMargin || priceAlert.alerts.investorBelowVendor) {
  failures.push("alerta 1 no quedó aislada");
}

const marginAlert = oneProduct(
  { ...baseProduct, name: "Margen bajo", manualPrice: 104 },
  noLogistics,
);
if (!(marginAlert.realMarginPercent > 0 && marginAlert.realMarginPercent <= 5)) {
  failures.push(`margen del caso 2 inesperado: ${marginAlert.realMarginPercent}`);
}
if (!marginAlert.alerts.lowMargin) failures.push("alerta 2 no disparó");
if (marginAlert.alerts.priceAtOrBelowCost || marginAlert.alerts.investorBelowVendor) {
  failures.push("alerta 2 no quedó aislada");
}

const belowTarget = oneProduct(
  { ...baseProduct, name: "Bajo objetivo", manualPrice: 125 },
  noLogistics,
);
if (belowTarget.alerts.lowMargin) {
  failures.push("un margen de 20 % no debe marcar margen bajo");
}

const splitAlert = oneProduct(
  {
    ...baseProduct,
    name: "Inversionista menor",
    manualPrice: 200,
    vendorSharePercent: 80,
  },
  noLogistics,
);
if (!splitAlert.alerts.investorBelowVendor) failures.push("alerta 3 no disparó");
if (splitAlert.alerts.priceAtOrBelowCost || splitAlert.alerts.lowMargin) {
  failures.push("alerta 3 no quedó aislada");
}

const healthy = oneProduct(
  {
    ...baseProduct,
    name: "Sano",
    priceMethod: "MARGEN",
    manualPrice: null,
    costPerPack: 70,
    vendorSharePercent: null,
  },
  noLogistics,
);
if (healthy.appliedPrice !== 100) failures.push(`precio sano ${healthy.appliedPrice}`);
if (healthy.alerts.priceAtOrBelowCost || healthy.alerts.lowMargin || healthy.alerts.investorBelowVendor) {
  failures.push("el caso sano no debía alertar");
}

if (resolveCommissionMethod(undefined) !== "2" || resolveCommissionMethod("otro") !== "2") {
  failures.push("un inventario sin método debe usar la opción 2");
}
if (resolveCommissionMethod("3") !== "3") failures.push("la opción 3 no se reconoció");

function commissionCase(method: CommissionMethod, vendorShare: number | null, packages = 4) {
  const product: ProductInput = {
    ...baseProduct,
    name: "Escenario",
    costPerPack: 1000,
    packages,
    manualPrice: 2000,
    vendorSharePercent: vendorShare,
  };
  return computeInventory({
    ...inventory,
    settings: {
      ...inventory.settings,
      logisticsCost: 500,
      vendorSharePercent: 30,
      commissionMethod: method,
    },
    products: [product],
  });
}

const method2 = commissionCase("2", null);
const method3 = commissionCase("3", null);
const line2 = method2.lines[0];
const line3 = method3.lines[0];
near(line2.grossProfit, 4000, 1e-6, "bruta método 2");
near(line2.logisticsAllocated, 500, 1e-6, "logística método 2");
near(line2.commissionBase, 4000, 1e-6, "base método 2");
near(line2.vendorProfit, 1200, 1e-6, "comisión método 2");
near(line2.investorBeforeLogistics, 2800, 1e-6, "inversionista antes método 2");
near(line2.investorNet, 2300, 1e-6, "neta método 2");
near(line2.vendorProfitPerPack, 300, 1e-6, "comisión por paquete método 2");
near(line2.investorNetPerPack, 575, 1e-6, "neta por paquete método 2");
near(line3.commissionBase, 3500, 1e-6, "base método 3");
near(line3.commissionBasePerPack, 875, 1e-6, "base por paquete método 3");
near(line3.vendorProfit, 1050, 1e-6, "comisión método 3");
near(line3.investorNet, 2450, 1e-6, "neta método 3");
near(line3.vendorProfitPerPack, 262.5, 1e-6, "comisión por paquete método 3");
near(line3.investorNetPerPack, 612.5, 1e-6, "neta por paquete método 3");
if (line2.appliedPrice !== line3.appliedPrice || line2.realMarginPercent !== line3.realMarginPercent) {
  failures.push("el método cambió el precio o el margen");
}
if (line2.logisticsAllocated !== line3.logisticsAllocated) {
  failures.push("el método cambió el prorrateo");
}
if (method2.totals.commissionMethod !== "2" || method3.totals.commissionMethod !== "3") {
  failures.push("el resumen no indica el método usado");
}

const individual2 = commissionCase("2", 10).lines[0];
const individual3 = commissionCase("3", 10).lines[0];
near(individual2.vendorSharePercent, 10, 0, "comisión individual método 2");
near(individual2.vendorProfit, 400, 1e-6, "comisión individual monto método 2");
near(individual2.investorNet, 3100, 1e-6, "neta individual método 2");
near(individual2.vendorProfitPerPack, 100, 1e-6, "comisión individual por paquete método 2");
near(individual3.vendorSharePercent, 10, 0, "comisión individual método 3");
near(individual3.commissionBase, 3500, 1e-6, "base individual método 3");
near(individual3.vendorProfit, 350, 1e-6, "comisión individual monto método 3");
near(individual3.investorNet, 3150, 1e-6, "neta individual método 3");
near(individual3.vendorProfitPerPack, 87.5, 1e-6, "comisión individual por paquete método 3");
near(individual3.investorNetPerPack, 787.5, 1e-6, "neta individual por paquete método 3");

const sharedProduct = (share: number | null, id: string): ProductInput => ({
  ...baseProduct,
  id,
  name: id,
  costPerPack: 1000,
  packages: 2,
  manualPrice: 3000,
  vendorSharePercent: share,
});
function sharedInventory(method: CommissionMethod) {
  return computeInventory({
    ...inventory,
    settings: {
      ...inventory.settings,
      logisticsCost: 500,
      vendorSharePercent: 30,
      commissionMethod: method,
    },
    products: [sharedProduct(null, "general"), sharedProduct(10, "individual")],
  });
}
const shared2 = sharedInventory("2");
const shared3 = sharedInventory("3");
near(
  shared2.lines.reduce((sum, line) => sum + line.logisticsAllocated, 0),
  500,
  1e-6,
  "prorrateo de dos productos",
);
shared2.lines.forEach((line, index) => {
  const other = shared3.lines[index];
  if (line.appliedPrice !== other.appliedPrice || line.logisticsAllocated !== other.logisticsAllocated) {
    failures.push("el método alteró precio o logística en un inventario de varios productos");
  }
});
const general3 = shared3.lines[0];
const custom3 = shared3.lines[1];
near(general3.logisticsAllocated, 250, 1e-6, "logística del producto general");
near(general3.commissionBase, 3750, 1e-6, "base del producto general");
near(general3.vendorProfit, 1125, 1e-6, "comisión general en método 3");
near(general3.investorNet, 2625, 1e-6, "neta general en método 3");
near(general3.vendorProfitPerPack, 562.5, 1e-6, "comisión general por paquete");
near(custom3.vendorProfit, 375, 1e-6, "comisión individual en el mismo inventario");
near(custom3.investorNet, 3375, 1e-6, "neta individual en el mismo inventario");
near(custom3.investorNetPerPack, 1687.5, 1e-6, "neta individual por paquete en el mismo inventario");

const negativeBase = computeInventory({
  ...inventory,
  settings: { ...inventory.settings, logisticsCost: 500, vendorSharePercent: 30, commissionMethod: "3" },
  products: [{ ...baseProduct, name: "Base negativa", costPerPack: 1000, packages: 1, manualPrice: 1100 }],
}).lines[0];
near(negativeBase.commissionBase, -400, 1e-6, "base negativa");
near(negativeBase.vendorProfit, 0, 1e-6, "comisión no negativa");
near(negativeBase.investorNet, -400, 1e-6, "neta negativa");

const zeroBase = computeInventory({
  ...inventory,
  settings: { ...inventory.settings, logisticsCost: 500, vendorSharePercent: 30, commissionMethod: "3" },
  products: [{ ...baseProduct, name: "Base cero", costPerPack: 1000, packages: 1, manualPrice: 1500 }],
}).lines[0];
near(zeroBase.commissionBase, 0, 1e-6, "base cero");
near(zeroBase.vendorProfit, 0, 1e-6, "comisión en base cero");
near(zeroBase.investorNet, 0, 1e-6, "neta en base cero");

const legacy = computeInventory({
  ...inventory,
  settings: {
    ...inventory.settings,
    logisticsCost: 500,
    vendorSharePercent: 30,
    commissionMethod: undefined as unknown as CommissionMethod,
  },
  products: [
    {
      ...baseProduct,
      name: "Legado",
      costPerPack: 1000,
      packages: 4,
      manualPrice: 2000,
    },
  ],
});
near(legacy.totals.vendorProfit, 1200, 1e-6, "legado usa método 2");
near(legacy.totals.investorNet, 2300, 1e-6, "neta legada");
if (legacy.totals.commissionMethod !== "2") failures.push("el legado no quedó en el método 2");

function expectReject(current: number, typed: string, kind: Parameters<typeof reviewNumericChange>[3], label: string) {
  const reviewed = reviewNumericChange(current, String(current), typed, kind);
  if (reviewed.commit || reviewed.value !== current || !reviewed.error) {
    failures.push(`${label} no se rechazó`);
  }
}
expectReject(0, "-100", "logistics", "logística -100");
expectReject(30, "-5", "commission", "comisión -5");
expectReject(30, "-10", "margin", "margen -10");
expectReject(30, "110", "commission", "comisión 110");
expectReject(30, "100", "margin", "margen 100");

const fromZero = reviewNumericChange(0, "0", "0100", "logistics");
if (!fromZero.commit || fromZero.draft !== "100" || fromZero.value !== 100) {
  failures.push(`editar 0 con 100 produjo ${fromZero.draft}`);
}
const cleared = reviewNumericChange(100, "100", "", "cost");
if (cleared.commit || cleared.value !== 100 || cleared.draft !== "") {
  failures.push("borrar el campo no debía guardar un valor nuevo");
}
const retyped = reviewNumericChange(100, "", "80", "cost");
if (!retyped.commit || retyped.value !== 80) failures.push("volver a escribir no guardó 80");
const emptyPackages = reviewNumericBlur(6, "", "packages");
if (emptyPackages.commit || emptyPackages.value !== 6) {
  failures.push("un paquete vacío no debe convertirse en cero");
}

const savedSettings = {
  logisticsCost: fromZero.value ?? 0,
  vendorSharePercent: 30,
  targetMarginPercent: 25,
  branchLabel: "Única",
  commissionMethod: resolveCommissionMethod(undefined),
};
if (
  savedSettings.logisticsCost !== 100 ||
  savedSettings.vendorSharePercent !== 30 ||
  savedSettings.targetMarginPercent !== 25 ||
  savedSettings.commissionMethod !== "2"
) {
  failures.push("un valor válido no se conservó al guardar y reabrir");
}
if (resolveCommissionMethod("3") !== "3") failures.push("el método 3 no se conservó");

const blocked = computeInventory({
  ...inventory,
  settings: {
    ...inventory.settings,
    logisticsCost: -100,
    vendorSharePercent: -5,
    targetMarginPercent: 30,
    commissionMethod: "2",
  },
  products: [{ ...baseProduct, name: "Bloqueado", costPerPack: 100, packages: 1, manualPrice: 200 }],
});
near(blocked.totals.logisticsCost, 0, 0, "logística negativa fuera del cálculo");
near(blocked.totals.vendorProfit, 0, 0, "comisión negativa fuera del cálculo");
near(blocked.lines[0].appliedPrice, 200, 0, "el precio no cambia al rechazar logística");

const capped = computeInventory({
  ...inventory,
  settings: { ...inventory.settings, logisticsCost: 0, vendorSharePercent: 110, commissionMethod: "2" },
  products: [{ ...baseProduct, name: "Tope", costPerPack: 100, packages: 1, manualPrice: 200 }],
});
near(capped.totals.vendorProfit, 100, 1e-6, "comisión mayor que 100 no entra completa");

const ignoredMargin = oneProduct(
  { ...baseProduct, name: "Margen inválido", targetMarginPercent: 100, manualPrice: null, priceMethod: "MARGEN", costPerPack: 70 },
  noLogistics,
);
if (ignoredMargin.appliedPrice !== 100) {
  failures.push(`un margen de 100 % no debía cambiar el precio: ${ignoredMargin.appliedPrice}`);
}

if (failures.length) {
  console.error(failures.slice(0, 30).join("\n"));
  process.exit(1);
}
console.log("pricing engine ok", {
  products: totals.productCount,
  packages: totals.packages,
  subtotal: totals.purchaseSubtotal,
  sales: totals.projectedSales,
  net: totals.investorNet,
});
