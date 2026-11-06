import { buildProfitability, EMPTY_PROFITABILITY_FILTERS } from "./profitability";
import {
  buildProductRanking,
  EMPTY_PRODUCT_RANK_FILTERS,
  productProfitStatus,
} from "./productRanking";
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

function inventory(
  partial: Partial<PricingInventory> & Pick<PricingInventory, "id"> & { method?: CommissionMethod },
): PricingInventory {
  return {
    ownerUid: "user",
    ownerEmail: null,
    name: partial.name ?? partial.id,
    settings: partial.settings ?? {
      logisticsCost: partial.settings?.logisticsCost ?? 500,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: partial.method ?? "2",
    },
    products: partial.products ?? [product({})],
    history: [],
    createdAt: "2026-05-01T18:00:00.000Z",
    updatedAt: partial.updatedAt ?? "2026-05-01T18:00:00.000Z",
    id: partial.id,
  };
}

function sumNet(items: PricingInventory[], filters = EMPTY_PRODUCT_RANK_FILTERS) {
  return buildProductRanking(items, filters).rows.reduce((sum, row) => sum + row.investorNet, 0);
}

const base = inventory({ id: "m2" });
const dashboard = buildProfitability([base], EMPTY_PROFITABILITY_FILTERS);
const ranking = buildProductRanking([base], EMPTY_PRODUCT_RANK_FILTERS);
near(sumNet([base]), dashboard.investorNet, 1e-6, "sin filtros, la suma del ranking es la neta del dashboard");
near(ranking.rows[0]?.investorNet ?? 0, 2300, 1e-6, "neta método 2 igual a utilidades");
near(ranking.rows[0]?.logisticsAllocated ?? 0, 500, 1e-6, "logística ya asignada, sin volver a prorratear");
near(ranking.rows[0]?.vendorProfit ?? 0, 1200, 1e-6, "comisión método 2");
if (ranking.rows[0]?.status !== "rentable") failures.push("el caso método 2 debía ser rentable");

const method3 = inventory({
  id: "m3",
  settings: { logisticsCost: 500, vendorSharePercent: 30, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "3" },
});
near(sumNet([method3]), buildProfitability([method3], EMPTY_PROFITABILITY_FILTERS).investorNet, 1e-6, "suma método 3");
near(buildProductRanking([method3], EMPTY_PRODUCT_RANK_FILTERS).rows[0]?.investorNet ?? 0, 2450, 1e-6, "neta método 3");
near(buildProductRanking([method3], EMPTY_PRODUCT_RANK_FILTERS).rows[0]?.vendorProfit ?? 0, 1050, 1e-6, "comisión método 3");

const individual = inventory({
  id: "ind",
  products: [product({ vendorSharePercent: 10 })],
});
const individualRow = buildProductRanking([individual], EMPTY_PRODUCT_RANK_FILTERS).rows[0];
near(individualRow?.vendorProfit ?? 0, 400, 1e-6, "comisión individual");
near(individualRow?.investorNet ?? 0, 3100, 1e-6, "neta con comisión individual");

const sharedName = [
  inventory({ id: "a", name: "Bodega", products: [product({ id: "p1", name: "Arroz", manualPrice: 2000 })] }),
  inventory({ id: "b", name: "Sucursal", products: [product({ id: "p1", name: "Arroz", manualPrice: 1500 })] }),
];
const shared = buildProductRanking(sharedName, EMPTY_PRODUCT_RANK_FILTERS);
if (shared.rows.length !== 2) failures.push(`el mismo nombre debía generar 2 filas: ${shared.rows.length}`);
if (shared.rows[0]?.purchaseSubtotal === shared.rows[1]?.purchaseSubtotal && shared.rows[0]?.investorNet === shared.rows[1]?.investorNet) {
  failures.push("las filas del mismo nombre mezclaron el resultado");
}
near(sumNet(sharedName), buildProfitability(sharedName, EMPTY_PROFITABILITY_FILTERS).investorNet, 1e-6, "suma de dos inventarios");

const duplicated = buildProductRanking([base, { ...base }], EMPTY_PRODUCT_RANK_FILTERS);
if (duplicated.rows.length !== 1) failures.push("un inventario repetido no debe duplicar sus productos");
near(sumNet([base, { ...base }]), buildProfitability([base, { ...base }], EMPTY_PROFITABILITY_FILTERS).investorNet, 1e-6, "suma sin duplicar el id");

const low = inventory({
  id: "bajo",
  settings: { logisticsCost: 0, vendorSharePercent: 0, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
  products: [product({ id: "low", packages: 1, costPerPack: 100, manualPrice: 104 })],
});
const lowRow = buildProductRanking([low], EMPTY_PRODUCT_RANK_FILTERS).rows[0];
if (lowRow?.status !== "margen_bajo") failures.push(`margen bajo esperado, fue ${lowRow?.status}`);
if (!(lowRow && lowRow.investorNet > 0)) failures.push("margen bajo no debe ser pérdida");

const loss = inventory({
  id: "loss",
  settings: { logisticsCost: 0, vendorSharePercent: 0, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
  products: [product({ id: "loss", packages: 1, costPerPack: 100, manualPrice: 50 })],
});
if (buildProductRanking([loss], EMPTY_PRODUCT_RANK_FILTERS).rows[0]?.status !== "perdida") failures.push("debía clasificar pérdida");

const flat = inventory({
  id: "flat",
  settings: { logisticsCost: 0, vendorSharePercent: 0, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
  products: [product({ id: "flat", packages: 1, costPerPack: 100, manualPrice: 100 })],
});
if (buildProductRanking([flat], EMPTY_PRODUCT_RANK_FILTERS).rows[0]?.status !== "sin_rentabilidad") {
  failures.push("neta cero debía ser sin rentabilidad");
}

if (productProfitStatus(10, 5) !== "margen_bajo") failures.push("margen de 5% sigue siendo margen bajo");
if (productProfitStatus(10, 5.01) !== "rentable") failures.push("margen superior a 5% debía ser rentable");
if (productProfitStatus(10, 0) !== "margen_bajo") failures.push("margen de 0% con neta positiva es margen bajo");
if (productProfitStatus(-1, 40) !== "perdida") failures.push("neta negativa es pérdida aunque el margen sea alto");

const byInvoice = inventory({
  id: "facturas",
  products: [
    product({ id: "f1", orderCode: "A-1", name: "Uno", packages: 1, costPerPack: 1000, manualPrice: 2000 }),
    product({ id: "f2", orderCode: "B-2", name: "Dos", packages: 1, costPerPack: 1000, manualPrice: 2000 }),
  ],
  settings: { logisticsCost: 500, vendorSharePercent: 30, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
});
const invoiceFilters = { ...EMPTY_PRODUCT_RANK_FILTERS, invoice: "A-1" };
near(
  sumNet([byInvoice], invoiceFilters),
  buildProfitability([byInvoice], { ...EMPTY_PROFITABILITY_FILTERS, invoice: "A-1" }).investorNet,
  1e-6,
  "la factura usa la logística ya asignada y coincide con el dashboard",
);
const searched = buildProductRanking([byInvoice], { ...EMPTY_PRODUCT_RANK_FILTERS, query: "uno" });
if (searched.totalProducts !== 1 || searched.rows[0]?.productName !== "Uno") failures.push("la búsqueda debía dejar un producto");
if (searched.profitable + searched.lowMargin + searched.losses + searched.flat > searched.totalProducts) {
  failures.push("los indicadores no siguen el filtro de búsqueda");
}

const outside = buildProductRanking([base], { ...EMPTY_PRODUCT_RANK_FILTERS, from: "2026-06-01", to: "2026-06-30" });
if (outside.totalProducts !== 0) failures.push("una fecha fuera de rango no debía traer productos");

const ordered = buildProductRanking(
  [inventory({
    id: "orden",
    settings: { logisticsCost: 0, vendorSharePercent: 0, targetMarginPercent: 30, branchLabel: "Única", commissionMethod: "2" },
    products: [
      product({ id: "caro", name: "Caro", packages: 1, costPerPack: 10, manualPrice: 50 }),
      product({ id: "barato", name: "Barato", packages: 9, costPerPack: 10, manualPrice: 20 }),
    ],
  })],
  { ...EMPTY_PRODUCT_RANK_FILTERS, sort: "packages_desc" },
);
if (ordered.rows[0]?.productName !== "Barato") failures.push("el orden por paquetes no dejó primero al de mayor cantidad");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("product ranking ok", {
  method2Net: ranking.rows[0]?.investorNet,
  rows: shared.rows.length,
  dashboardNet: dashboard.investorNet,
});
