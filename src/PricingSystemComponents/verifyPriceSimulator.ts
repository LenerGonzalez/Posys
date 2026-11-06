import { computeInventory } from "./pricingEngine";
import { portfolioRates } from "./profitability";
import { simulationMetrics, simulationTone } from "./PriceSimulator";
import type { CommissionMethod, PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function near(actual: number, expected: number, tolerance: number, label: string) {
  if (Math.abs(actual - expected) > tolerance) failures.push(`${label}: ${actual} != ${expected}`);
}

function product(partial: Partial<ProductInput> = {}): ProductInput {
  return {
    id: partial.id ?? "p",
    orderCode: "F1",
    name: "Producto",
    costPerPack: partial.costPerPack ?? 1000,
    packages: partial.packages ?? 4,
    priceMethod: "PRECIO",
    manualPrice: partial.manualPrice === undefined ? 2000 : partial.manualPrice,
    targetMarginPercent: null,
    vendorSharePercent: partial.vendorSharePercent ?? null,
  };
}

function inventory(method: CommissionMethod, partial?: { logistics?: number; share?: number; price?: number }): PricingInventory {
  return {
    id: method,
    ownerUid: "user",
    ownerEmail: null,
    name: method,
    settings: {
      logisticsCost: partial?.logistics ?? 500,
      vendorSharePercent: partial?.share ?? 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: method,
    },
    products: [product({ manualPrice: partial?.price ?? 2000 })],
    history: [],
    createdAt: null,
    updatedAt: null,
  };
}

const method2 = computeInventory(inventory("2")).totals;
const method3 = computeInventory(inventory("3")).totals;
const rows = simulationMetrics(method2, method3);
const byKey = new Map(rows.map((row) => [row.key, row]));

near(method2.purchaseSubtotal, 4000, 1e-6, "compra");
near(method2.logisticsCost, 500, 1e-6, "logística");
near(method2.costWithLogistics, 4500, 1e-6, "costo con logística");
near(method2.projectedSales, 8000, 1e-6, "venta");
near(method2.grossProfit, 4000, 1e-6, "bruta");
near(method2.commissionBase, 4000, 1e-6, "base método 2");
near(method2.vendorProfit, 1200, 1e-6, "comisión método 2");
near(method2.investorNet, 2300, 1e-6, "neta método 2");
near(method3.commissionBase, 3500, 1e-6, "base método 3");
near(method3.vendorProfit, 1050, 1e-6, "comisión método 3");
near(method3.investorNet, 2450, 1e-6, "neta método 3");
near(method2.projectedSales, method3.projectedSales, 1e-6, "la venta no cambia con el método");

const roi2 = portfolioRates(method2.grossProfit, method2.projectedSales, method2.investorNet, method2.purchaseSubtotal, method2.logisticsCost).roiPercent;
const roi3 = portfolioRates(method3.grossProfit, method3.projectedSales, method3.investorNet, method3.purchaseSubtotal, method3.logisticsCost).roiPercent;
near(byKey.get("roi")?.current ?? 0, roi2, 1e-6, "ROI actual");
near(byKey.get("roi")?.simulated ?? 0, roi3, 1e-6, "ROI simulado");
near(byKey.get("roi")?.currentNet ?? 0, 2300, 1e-6, "neta usada en el ROI actual");
near(byKey.get("roi")?.simulatedNet ?? 0, 2450, 1e-6, "neta usada en el ROI simulado");
near(roi2, (2300 / 4500) * 100, 1e-6, "ROI método 2");
near(roi3, (2450 / 4500) * 100, 1e-6, "ROI método 3");

if (simulationTone((byKey.get("vendorProfit")?.simulated ?? 0) - (byKey.get("vendorProfit")?.current ?? 0), "lower") !== "good") {
  failures.push("bajar la comisión debía verse como favorable");
}
if (simulationTone((byKey.get("investorNet")?.simulated ?? 0) - 2300, "higher") !== "good") {
  failures.push("subir la neta debía verse como favorable");
}
if (simulationTone(-500, "neutral") !== "flat") failures.push("la base de comisión no debe colorearse");
if (simulationTone(0, "higher") !== "flat") failures.push("una diferencia de cero no es mejora ni empeora");
if (simulationTone(200, "lower") !== "bad") failures.push("subir un costo debía verse desfavorable");

const richerSales = computeInventory(inventory("2", { price: 3000, share: 80 })).totals;
const volume = simulationMetrics(method2, richerSales);
const sales = volume.find((row) => row.key === "projectedSales");
const net = volume.find((row) => row.key === "investorNet");
if ((sales?.simulated ?? 0) <= (sales?.current ?? 0)) failures.push("el caso de control debía vender más");
if ((net?.simulated ?? 0) >= (net?.current ?? 0)) failures.push("vender más no debía dejar más ganancia neta");
if (sales && simulationTone(sales.simulated - sales.current, sales.sense) !== "good") failures.push("la mayor venta debía marcarse solo en su indicador");
if (net && simulationTone(net.simulated - net.current, net.sense) !== "bad") failures.push("la menor neta debía marcarse desfavorable");

const moreLogistics = computeInventory(inventory("2", { logistics: 800 })).totals;
const logistics = simulationMetrics(method2, moreLogistics).find((row) => row.key === "logisticsCost");
const cost = simulationMetrics(method2, moreLogistics).find((row) => row.key === "costWithLogistics");
if (logistics && simulationTone(logistics.simulated - logistics.current, logistics.sense) !== "bad") {
  failures.push("aumentar la logística debía verse desfavorable");
}
if (cost && simulationTone(cost.simulated - cost.current, cost.sense) !== "bad") {
  failures.push("aumentar el costo con logística debía verse desfavorable");
}
near(moreLogistics.logisticsCost, 800, 1e-6, "logística simulada");
near(moreLogistics.investorNet, method2.grossProfit - method2.vendorProfit - 800, 1e-6, "la neta descuenta la logística nueva sin otra fórmula");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("price simulator ok", { method2Net: method2.investorNet, method3Net: method3.investorNet, roi2, roi3 });
