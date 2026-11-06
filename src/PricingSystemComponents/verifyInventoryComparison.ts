import { computeInventory } from "./pricingEngine";
import { compareInventories } from "./compareInventories";
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
    priceMethod: "PRECIO",
    manualPrice: partial.manualPrice === undefined ? 2000 : partial.manualPrice,
    targetMarginPercent: null,
    vendorSharePercent: partial.vendorSharePercent ?? null,
  };
}

function inventory(partial: {
  id: string;
  name?: string;
  method?: CommissionMethod;
  logistics?: number;
  share?: number;
  products?: ProductInput[];
  savedAt?: string;
}): PricingInventory {
  return {
    id: partial.id,
    ownerUid: "user",
    ownerEmail: null,
    name: partial.name ?? partial.id,
    settings: {
      logisticsCost: partial.logistics ?? 500,
      vendorSharePercent: partial.share ?? 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: partial.method ?? "2",
    },
    products: partial.products ?? [product({})],
    history: partial.savedAt
      ? [{
          savedAt: partial.savedAt,
          productCount: 1,
          packages: 4,
          purchaseSubtotal: 0,
          logisticsCost: 0,
          projectedSales: 0,
          grossProfit: 0,
          vendorProfit: 0,
          investorBeforeLogistics: 0,
          investorNet: 0,
        }]
      : [],
    createdAt: "2026-05-01T12:00:00.000Z",
    updatedAt: "2026-05-01T12:00:00.000Z",
  };
}

const method2 = inventory({ id: "m2", name: "Método 2", savedAt: "2026-05-02T15:00:00.000Z" });
const method3 = inventory({ id: "m3", name: "Método 3", method: "3", savedAt: "2026-05-03T18:30:00.000Z" });
const compared = compareInventories([method2, method3], ["m2", "m3"]);
if (!compared) failures.push("debía comparar dos inventarios");
const left = compared?.inventories[0];
const right = compared?.inventories[1];
const engine2 = computeInventory(method2).totals;
const engine3 = computeInventory(method3).totals;
near(left?.investorNet ?? 0, engine2.investorNet, 1e-6, "neta método 2 igual al inventario");
near(right?.investorNet ?? 0, engine3.investorNet, 1e-6, "neta método 3 igual al inventario");
near(left?.investorNet ?? 0, 2300, 1e-6, "neta método 2");
near(right?.investorNet ?? 0, 2450, 1e-6, "neta método 3");
near(left?.vendorProfit ?? 0, 1200, 1e-6, "comisión método 2");
near(right?.vendorProfit ?? 0, 1050, 1e-6, "comisión método 3");
near(left?.projectedSales ?? 0, right?.projectedSales ?? 0, 1e-6, "la venta no cambia entre métodos");
near(left?.logisticsCost ?? 0, 500, 1e-6, "logística sin volver a prorratear");
near(left?.costWithLogistics ?? 0, 4500, 1e-6, "costo con logística");
near(left?.weightedMarginPercent ?? 0, 50, 1e-6, "margen ponderado");
near(left?.roiPercent ?? 0, (2300 / 4500) * 100, 1e-6, "ROI método 2");
if (left?.savedAt !== "2026-05-02T15:00:00.000Z") failures.push("no conservó la fecha del último guardado");
const netMetric = compared?.metrics.find((metric) => metric.key === "investorNet");
if (netMetric?.cells[1]?.mark !== "best_profit") failures.push("la mayor neta debía marcarse como mejor rentabilidad");
if (netMetric?.cells[0]?.mark) failures.push("la menor neta no debía ganar rentabilidad");
near(netMetric?.cells[1]?.delta ?? 0, 150, 1e-6, "diferencia monetaria de la neta");
const salesMetric = compared?.metrics.find((metric) => metric.key === "projectedSales");
if (salesMetric?.cells.some((cell) => cell.mark === "best_profit")) failures.push("la venta no debe marcarse como mejor rentabilidad");

const richSales = inventory({
  id: "venta",
  name: "Mucha venta",
  share: 80,
  products: [product({ manualPrice: 3000 })],
});
const volume = compareInventories([method2, richSales], ["m2", "venta"]);
const volumeNet = volume?.metrics.find((metric) => metric.key === "investorNet");
const volumeSales = volume?.metrics.find((metric) => metric.key === "projectedSales");
if ((volume?.inventories[1]?.projectedSales ?? 0) <= (volume?.inventories[0]?.projectedSales ?? 0)) {
  failures.push("el caso de control debía vender más");
}
if ((volume?.inventories[1]?.investorNet ?? 0) >= (volume?.inventories[0]?.investorNet ?? 0)) {
  failures.push("vender más no debía dejar más ganancia neta");
}
if (volumeSales?.cells[1]?.mark !== "highest_volume") failures.push("la mayor venta debía marcarse solo como volumen");
if (volumeNet?.cells[1]?.mark === "best_profit") failures.push("la mayor venta no debía ganar en rentabilidad");
if (volumeNet?.cells[0]?.mark !== "best_profit") failures.push("la mejor neta debía ser el inventario de menor venta");

const custom = inventory({
  id: "custom",
  name: "Comisión propia",
  products: [product({ vendorSharePercent: 10 })],
});
const customCompared = compareInventories([method2, custom], ["m2", "custom"]);
near(customCompared?.inventories[1]?.vendorProfit ?? 0, 400, 1e-6, "comisión individual");
near(customCompared?.inventories[1]?.investorNet ?? 0, 3100, 1e-6, "neta con comisión individual");
near(computeInventory(custom).totals.investorNet, customCompared?.inventories[1]?.investorNet ?? 0, 1e-6, "la comparación no altera la neta individual");

const repeated = compareInventories([
  inventory({
    id: "a",
    name: "Bodega",
    products: [product({ id: "a1", name: "Arroz", costPerPack: 1000, manualPrice: 2000, orderCode: "A-1" })],
  }),
  inventory({
    id: "b",
    name: "Sucursal",
    products: [
      product({ id: "b1", name: "Arroz", costPerPack: 800, manualPrice: 1500, orderCode: "B-9" }),
      product({ id: "b2", name: "Frijol", costPerPack: 500, manualPrice: 900, orderCode: "B-9" }),
    ],
  }),
  inventory({
    id: "c",
    name: "Ruta",
    method: "3",
    products: [product({ id: "c1", name: "Frijol", costPerPack: 400, manualPrice: 700 })],
  }),
], ["a", "b", "c"]);
const arroz = repeated?.products.find((row) => row.label === "Arroz");
const frijol = repeated?.products.find((row) => row.label === "Frijol");
if (!arroz || !frijol) failures.push("debían compararse Arroz y Frijol por aparecer en más de un inventario");
if (arroz && (arroz.sides[0]?.costPerPack !== 1000 || arroz.sides[1]?.costPerPack !== 800)) {
  failures.push("Arroz mezcló el costo de inventarios distintos");
}
if (arroz?.sides[2]?.available) failures.push("Arroz debía figurar no disponible en Ruta");
if (frijol?.sides[0]?.available) failures.push("Frijol debía figurar no disponible en Bodega");
if (frijol && frijol.sides[1]?.costPerPack === frijol.sides[2]?.costPerPack) failures.push("Frijol mezcló costos entre inventarios");
if ((repeated?.inventories[0]?.invoices ?? "") !== "A-1") failures.push("debía mostrar la factura del inventario");
if (compareInventories([method2, method3], ["m2", "m2"])) failures.push("no debe comparar dos veces el mismo inventario");
if (compareInventories([method2], ["m2"])) failures.push("un solo inventario no alcanza para comparar");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("inventory comparison ok", {
  method2Net: left?.investorNet,
  method3Net: right?.investorNet,
  products: repeated?.products.map((row) => row.label),
});
