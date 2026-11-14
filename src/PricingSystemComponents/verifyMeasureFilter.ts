import { compareInventories } from "./compareInventories";
import { buildSalesDashboard, EMPTY_DASHBOARD_FILTERS } from "./dashboardReport";
import { activeMeasureFilter, matchesMeasureFilter, quantityCaption } from "./measureFilter";
import { buildPriceRows, EMPTY_PRICE_FILTERS, filterPriceRows } from "./priceCatalog";
import { computeInventory } from "./pricingEngine";
import { buildProfitability, EMPTY_PROFITABILITY_FILTERS } from "./profitability";
import { buildProductRanking, EMPTY_PRODUCT_RANK_FILTERS } from "./productRanking";
import type { PricingSale, SaleLineSnapshot } from "./saleCommit";
import type { PricingInventory, ProductInput } from "./types";

const failures: string[] = [];
function check(name: string, condition: boolean) {
  if (!condition) failures.push(name);
}

function product(partial: Partial<ProductInput> & Pick<ProductInput, "id" | "name">): ProductInput {
  return {
    orderCode: "F1",
    costPerPack: 1000,
    packages: 4,
    priceMethod: "PRECIO",
    manualPrice: 2000,
    targetMarginPercent: null,
    vendorSharePercent: null,
    ...partial,
  };
}

function inventory(products: ProductInput[]): PricingInventory {
  return {
    id: "lote-1",
    ownerUid: "user",
    ownerEmail: null,
    name: "LOTE 1 NOVIEMBRE",
    createdAt: "2026-11-01T12:00:00.000Z",
    updatedAt: "2026-11-01T12:00:00.000Z",
    settings: {
      logisticsCost: 0,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: "2",
    },
    products,
    history: [],
    priceChanges: [],
  };
}

const historical = product({ id: "hist", name: "Histórico" });
delete historical.unit;
const pounds = product({ id: "lb", name: "Azúcar", unit: "lb", packages: undefined, quantityMilli: 125500, manualPrice: 20, costPerPack: 10 });
const pieces = product({ id: "unit", name: "Vaso", unit: "unit", packages: 30, manualPrice: 15, costPerPack: 8 });
const mixed = inventory([historical, pounds, pieces]);
const other = inventory([product({ id: "other", name: "Otro lote", packages: 2 })]);
other.id = "lote-2";
other.name = "LOTE 2";

check("el filtro inicia en paquete", activeMeasureFilter(undefined) === "package" && EMPTY_PROFITABILITY_FILTERS.unit === "package" && EMPTY_PRODUCT_RANK_FILTERS.unit === "package" && EMPTY_PRICE_FILTERS.unit === "package" && EMPTY_DASHBOARD_FILTERS.unit === "package");
check("un producto sin unidad entra en paquete", matchesMeasureFilter(undefined, "package") && !matchesMeasureFilter(undefined, "lb"));

const packagesOnly = buildProfitability([mixed], EMPTY_PROFITABILITY_FILTERS);
const poundsOnly = buildProfitability([mixed], { ...EMPTY_PROFITABILITY_FILTERS, unit: "lb" });
const piecesOnly = buildProfitability([mixed], { ...EMPTY_PROFITABILITY_FILTERS, unit: "unit" });
const everything = buildProfitability([mixed], { ...EMPTY_PROFITABILITY_FILTERS, unit: "all" });
const lotPounds = buildProfitability([mixed, other], { ...EMPTY_PROFITABILITY_FILTERS, inventoryId: "lote-1", unit: "lb" });
const computed = computeInventory(mixed);
const poundLine = computed.lines.find((line) => line.id === "lb");

check("paquete incluye el histórico y deja fuera libra y unidad", packagesOnly.productCount === 1 && packagesOnly.packages === 4);
check("libra muestra solo la libra", poundsOnly.productCount === 1 && poundsOnly.quantityAmount === 125.5 && poundsOnly.packages === 0);
check("unidad muestra solo las unidades", piecesOnly.productCount === 1 && piecesOnly.quantityAmount === 30 && piecesOnly.packages === 0);
check("todos no suma 4 + 125.5 + 30", !everything.quantityLabel.includes("159") && everything.quantityLabel.includes("paquete") && everything.quantityLabel.includes("libra") && everything.quantityLabel.includes("unidad"));
check("inventario y unidad se aplican juntos", lotPounds.productCount === 1 && lotPounds.quantityAmount === 125.5 && lotPounds.inventoryCount === 1);
check("el importe de la libra conserva el cálculo del motor", poundLine != null && Math.abs(poundsOnly.investorNet - poundLine.investorNet) < 1e-6);
check("todos suma importes y separa cantidades", Math.abs(everything.investorNet - computed.totals.investorNet) < 1e-6 && everything.quantityAmount === 0);

const ranked = buildProductRanking([mixed, other], { ...EMPTY_PRODUCT_RANK_FILTERS, inventoryId: "lote-1", unit: "unit" });
check("la rentabilidad por producto respeta inventario y unidad", ranked.rows.length === 1 && ranked.rows[0]?.productName === "Vaso" && ranked.rows[0]?.unit === "unit");

const prices = filterPriceRows(buildPriceRows([mixed]), { ...EMPTY_PRICE_FILTERS, scope: "inv:lote-1", unit: "lb" });
check("precios filtra inventario y libra", prices.length === 1 && prices[0]?.product === "Azúcar" && prices[0]?.unit === "lb");

const comparison = compareInventories([mixed, other], ["lote-1", "lote-2"], "all");
const packageMetric = comparison?.metrics.find((metric) => metric.key === "packages");
const poundMetric = comparison?.metrics.find((metric) => metric.key === "pounds");
check("la comparación no mete libras en el total de paquetes", packageMetric?.cells[0]?.value === 4 && poundMetric?.cells[0]?.value === 125.5 && comparison?.inventories[0]?.packages === 4);

const saleLine = (unit: "package" | "lb" | "unit" | undefined, quantity: number, productId: string): SaleLineSnapshot => ({
  inventoryId: "lote-1",
  inventoryName: "LOTE 1",
  productId,
  productName: productId,
  invoiceNumber: "F1",
  quantity,
  ...(unit ? { unit } : {}),
  appliedPrice: 10,
  costPerPack: 5,
  logisticsPerPack: 1,
  grossProfitPerPack: 4,
  vendorProfitPerPack: 1,
  investorNetPerPack: 2,
  commissionMethod: "2",
  vendorSharePercent: 30,
  salesTotal: 10 * quantity,
  grossProfit: 4 * quantity,
  vendorProfit: quantity,
  investorNet: 2 * quantity,
});
const sale: PricingSale = {
  operationId: "sale-1",
  ownerUid: "owner",
  sellerUid: "seller",
  sellerName: "Vendedor",
  soldAt: "2026-11-02T12:00:00.000Z",
  packageCount: 2,
  salesTotal: 40,
  grossProfit: 16,
  vendorProfit: 4,
  investorNet: 8,
  lines: [saleLine(undefined, 2, "hist"), saleLine("lb", 1.5, "lb")],
};
const salesReport = buildSalesDashboard([sale], [], [], [{
  inventoryId: "lote-1",
  inventoryName: "LOTE 1",
  productId: "hist",
  productName: "Histórico",
  invoiceNumber: "F1",
  initialPackages: 4,
}, {
  inventoryId: "lote-1",
  inventoryName: "LOTE 1",
  productId: "lb",
  productName: "Azúcar",
  invoiceNumber: "F1",
  unit: "lb",
  initialPackages: 125.5,
}], { ...EMPTY_DASHBOARD_FILTERS, unit: "lb" });
check("ventas y comisiones en libra no arrastra el paquete histórico", salesReport.salesTotal === 15 && salesReport.soldByUnit.length === 1 && salesReport.soldByUnit[0]?.unit === "lb" && salesReport.packagesSold === 0);
check("la cantidad en cero de una unidad lleva su nombre", quantityCaption("lb", []) === "0 libras");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("measure filter ok");
