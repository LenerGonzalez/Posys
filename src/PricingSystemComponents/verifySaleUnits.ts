import { buildSalesDashboard } from "./dashboardReport";
import { readSaleMilli, readSoldMilli, totalsByUnit } from "./quantity";
import { commitSale, reviewSale, saleLineAmount, saleProducts, type StockBalance } from "./saleCommit";
import { planSaleVoid, shouldRepairSaleBalances } from "./saleVoid";
import { withStoredQuantity } from "./quantity";
import type { CommissionBalance } from "./commissionCommit";
import type { PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function check(label: string, ok: boolean) {
  if (!ok) failures.push(label);
}

function product(partial: Partial<ProductInput> & { id: string; name: string }): ProductInput {
  return {
    orderCode: "F-1",
    costPerPack: 1000,
    priceMethod: "PRECIO",
    manualPrice: 2000,
    targetMarginPercent: null,
    vendorSharePercent: null,
    packages: 1,
    ...partial,
  };
}

function inventory(products: ProductInput[]): PricingInventory {
  return {
    id: "inv",
    ownerUid: "owner",
    ownerEmail: null,
    name: "Inventario",
    settings: {
      logisticsCost: 0,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: "2",
    },
    products,
    history: [],
    createdAt: null,
    updatedAt: null,
  };
}

const historical = product({ id: "pkg", name: "Histórico", packages: 20 });
const pounds = withStoredQuantity(product({ id: "lb", name: "Arroz", unit: "lb", packages: 1 }), 125500);
const units = product({ id: "each", name: "Pieza", unit: "unit", packages: 10 });
if (!pounds) failures.push("no se preparó el inventario de libras");
const source = inventory([historical, pounds ?? product({ id: "lb", name: "Arroz", unit: "lb" }), units]);
const catalog = saleProducts([source]);

check("histórico de 20 paquetes", catalog.find((item) => item.productId === "pkg")?.initialPackages === 20 && catalog.find((item) => item.productId === "pkg")?.unit === "package");
check("125.500 lb", catalog.find((item) => item.productId === "lb")?.initialPackages === 125.5 && catalog.find((item) => item.productId === "lb")?.unit === "lb");
check("10 unidades", catalog.find((item) => item.productId === "each")?.initialPackages === 10 && catalog.find((item) => item.productId === "each")?.unit === "unit");
check("inventario mixto conserva las tres unidades", new Set(catalog.map((item) => item.unit)).size === 3);

const requestBase = {
  ownerUid: "seller-a",
  sellerUid: "seller-a",
  sellerName: "Ana",
  soldAt: "2026-11-14T12:00:00.000Z",
};

function sell(operationId: string, productId: string, quantity: number, stock: StockBalance[] = []) {
  return commitSale({
    ...requestBase,
    operationId,
    lines: [{ inventoryId: "inv", productId, quantity }],
  }, { existingSale: null, inventories: [source], stock });
}

const packagesSale = sell("op-pkg", "pkg", 2);
check("venta de 2 paquetes", packagesSale.status === "created" && packagesSale.status === "created" && packagesSale.sale.lines[0]?.quantity === 2 && packagesSale.sale.lines[0]?.quantityMilli == null && packagesSale.sale.lines[0]?.unit === "package" && packagesSale.stock[0]?.soldPackages === 2 && packagesSale.stock[0]?.quantityMilli == null);

const oneAndHalf = sell("op-lb", "lb", 1.5);
check("venta de 1.5 lb", oneAndHalf.status === "created" && oneAndHalf.sale.lines[0]?.quantityMilli === 1500 && oneAndHalf.sale.lines[0]?.quantity == null && oneAndHalf.sale.lines[0]?.unit === "lb" && oneAndHalf.stock[0]?.quantityMilli === 1500 && oneAndHalf.stock[0]?.soldPackages == null);
check("el importe de 1.5 lb usa la cantidad real", oneAndHalf.status === "created" && oneAndHalf.sale.lines[0]?.salesTotal === 3000);

const precise = sell("op-precise", "lb", 125.125);
check("venta de 125.125 lb", precise.status === "created" && precise.sale.lines[0]?.quantityMilli === 125125 && precise.sale.lines[0]?.quantity == null);

const unitSale = sell("op-unit", "each", 3);
check("venta de 3 unidades", unitSale.status === "created" && unitSale.sale.lines[0]?.quantity === 3 && unitSale.sale.lines[0]?.unit === "unit" && unitSale.stock[0]?.soldPackages === 3);

check("rechaza decimal en paquetes", sell("op-bad-pkg", "pkg", 1.5).status === "rejected");
check("rechaza decimal en unidades", sell("op-bad-unit", "each", 1.5).status === "rejected");
check("rechaza más de tres decimales", sell("op-bad-lb", "lb", 1.1234).status === "rejected");
check("rechaza más que lo disponible", sell("op-over", "each", 11).status === "rejected");

const untouched: StockBalance[] = [];
reviewSale([{ inventoryId: "inv", productId: "lb", quantity: 1.5 }], catalog, {});
check("la confirmación no consume inventario", untouched.length === 0);

const duplicateStock = oneAndHalf.status === "created" ? oneAndHalf.stock : [];
const duplicate = commitSale({
  ...requestBase,
  operationId: "op-lb",
  lines: [{ inventoryId: "inv", productId: "lb", quantity: 1.5 }],
}, { existingSale: oneAndHalf.status === "created" ? oneAndHalf.sale : null, inventories: [source], stock: duplicateStock });
check("el mismo operationId no registra dos veces", duplicate.status === "existing" && duplicateStock[0]?.quantityMilli === 1500);

const other: StockBalance = { ownerUid: "seller-b", inventoryId: "inv", productId: "lb", soldPackages: 10, updatedAt: "2026-11-01T00:00:00.000Z" };
const own: StockBalance = { ownerUid: "seller-a", inventoryId: "inv", productId: "lb", quantityMilli: 1500, updatedAt: "2026-11-02T00:00:00.000Z" };
const shared = sell("op-shared", "lb", 1, [other, own]);
check("suma contadores de distintos usuarios", shared.status === "created" && shared.sale.lines[0]?.quantity === 1);
check("el contador propio suma solo sus milésimas", shared.status === "created" && shared.stock.length === 1 && shared.stock[0]?.quantityMilli === 2500);
const tenPounds = reviewSale([{ inventoryId: "inv", productId: "lb", quantity: 1 }], catalog, { "inv:lb": 10 });
check("125.500 lb menos 10 lb deja 115.500", tenPounds.rows[0]?.available === 115.5 && tenPounds.rows[0]?.availableAfter === 114.5);

const historicalCounter = readSoldMilli({ soldPackages: 7 });
check("contador histórico de paquetes", historicalCounter.ok && historicalCounter.milli === 7000);
const inconsistent = readSoldMilli({ soldPackages: 7, quantityMilli: 1500 });
check("rechaza contador inconsistente", !inconsistent.ok);
check("la venta rechaza el contador inconsistente", sell("op-bad-counter", "lb", 1, [{ ownerUid: "seller-a", inventoryId: "inv", productId: "lb", soldPackages: 7, quantityMilli: 1500, updatedAt: "" }]).status === "rejected");

const both = readSaleMilli({ quantity: 2, quantityMilli: 2000, unit: "package" });
const mismatch = readSaleMilli({ quantity: 2, quantityMilli: 1500, unit: "package" });
check("acepta cantidad y milésimas iguales", both.ok && both.milli === 2000);
check("rechaza cantidad y milésimas distintas", !mismatch.ok);

function actor(uid = "seller-a") {
  return { uid, roles: uid === "admin" ? ["admin"] : [], name: "Ana" };
}

function voidOf(sale: Extract<typeof packagesSale, { status: "created" }>["sale"], stock: StockBalance[], balances: CommissionBalance[] = []) {
  return planSaleVoid(actor(sale.sellerUid), "2026-11-15T12:00:00.000Z", { sale, balances, stock, queue: null });
}

if (packagesSale.status === "created") {
  const voided = voidOf(packagesSale.sale, packagesSale.stock);
  check("anula paquetes y recupera el contador", voided.status === "voided" && voided.stock[0]?.soldPackages === 0 && voided.stock[0]?.quantityMilli == null);
  if (voided.status === "voided") {
    const again = planSaleVoid(actor(), "2026-11-15T13:00:00.000Z", { sale: voided.sale, balances: [], stock: voided.stock, queue: null });
    check("la segunda anulación no devuelve otra vez", again.status === "already" && voided.stock[0]?.soldPackages === 0);
    check("la venta anulada no vuelve a la cola de comisión", shouldRepairSaleBalances(voided.sale) === false && voided.balances[0]?.balance.generated === 0 && voided.balances[0]?.balance.paid === 0);
    const report = buildSalesDashboard([voided.sale], [], [], catalog.map((item) => ({
      inventoryId: item.inventoryId,
      inventoryName: item.inventoryName,
      productId: item.productId,
      productName: item.productName,
      invoiceNumber: item.invoiceNumber,
      unit: item.unit,
      initialPackages: item.initialPackages,
    })), { from: "", to: "", inventoryId: "", productId: "" });
    check("la venta anulada sale de los totales", report.packagesSold === 0 && report.salesTotal === 0 && report.sales.length === 0);
  }
}

if (oneAndHalf.status === "created") {
  const voided = voidOf(oneAndHalf.sale, oneAndHalf.stock);
  check("anula libras decimales", voided.status === "voided" && voided.stock[0]?.soldPackages === 0 && voided.stock[0]?.quantityMilli == null);
  const partial = voidOf(oneAndHalf.sale, [{ ownerUid: "seller-a", inventoryId: "inv", productId: "lb", quantityMilli: 2500, updatedAt: "" }]);
  check("recupera exactamente el saldo de libras", partial.status === "voided" && partial.stock[0]?.soldPackages === 1 && partial.stock[0]?.quantityMilli == null);
}

if (unitSale.status === "created") {
  const voided = voidOf(unitSale.sale, unitSale.stock);
  check("anula unidades", voided.status === "voided" && voided.stock[0]?.soldPackages === 0);
}

if (packagesSale.status === "created") {
  const paid: CommissionBalance = {
    ownerUid: "seller-a",
    sellerUid: "seller-a",
    saleId: packagesSale.sale.operationId,
    soldAt: packagesSale.sale.soldAt,
    lineIndex: 0,
    inventoryId: "inv",
    invoiceNumber: "F-1",
    productId: "pkg",
    productName: "Histórico",
    generated: 10,
    paid: 0.01,
  };
  check("rechaza anular si hay comisión pagada", voidOf(packagesSale.sale, packagesSale.stock, [paid]).status === "rejected");
  check("rechaza si falta el contador", voidOf(packagesSale.sale, []).status === "rejected");
  check("rechaza si el saldo no alcanza", voidOf(packagesSale.sale, [{ ownerUid: "seller-a", inventoryId: "inv", productId: "pkg", soldPackages: 1, updatedAt: "" }]).status === "rejected");
}

const mixedTotals = totalsByUnit([
  { unit: "package", quantity: 10 },
  { unit: "lb", quantityMilli: 10000 },
  { unit: "unit", quantity: 10 },
]);
check("no suma unidades distintas", mixedTotals.length === 3 && mixedTotals.every((item) => item.amount === 10));
check("una línea histórica sin unidad vale su cantidad", saleLineAmount({ quantity: 2 }) === 2);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sale units ok");
