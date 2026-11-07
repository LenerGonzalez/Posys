import { commitSale, reviewSale, saleProducts, type PricingSale, type StockBalance } from "./saleCommit";
import type { CommissionMethod, PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function product(partial: Partial<ProductInput> = {}): ProductInput {
  return {
    id: partial.id ?? "prod-1",
    orderCode: partial.orderCode ?? "0000101004",
    name: partial.name ?? "Arroz",
    costPerPack: partial.costPerPack ?? 1000,
    packages: partial.packages ?? 4,
    priceMethod: "PRECIO",
    manualPrice: partial.manualPrice ?? 2000,
    targetMarginPercent: null,
    vendorSharePercent: partial.vendorSharePercent ?? null,
  };
}

function inventory(partial: {
  id: string;
  name: string;
  products: ProductInput[];
  method?: CommissionMethod;
  logistics?: number;
}): PricingInventory {
  return {
    id: partial.id,
    ownerUid: "owner-1",
    ownerEmail: null,
    name: partial.name,
    settings: {
      logisticsCost: partial.logistics ?? 500,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: partial.method ?? "2",
    },
    products: partial.products,
    history: [],
    createdAt: null,
    updatedAt: null,
  };
}

function request(lines: Array<{ inventoryId: string; productId: string; quantity: number }>, operationId = "op-1") {
  return {
    operationId,
    ownerUid: "owner-1",
    sellerUid: "owner-1",
    sellerName: "Ana",
    soldAt: "2026-11-06T00:00:00.000Z",
    lines,
  };
}

function state(inventories: PricingInventory[], stock: StockBalance[] = [], existingSale: PricingSale | null = null) {
  return { inventories, stock, existingSale };
}

const method2 = inventory({
  id: "inv-a",
  name: "Factura A",
  products: [product()],
});
const method3 = inventory({
  id: "inv-b",
  name: "Factura B",
  method: "3",
  products: [product({ id: "prod-2", name: "Frijol", orderCode: "0000101008" })],
});

const catalogA = saleProducts([method2])[0];
if (catalogA.appliedPrice !== 2000 || catalogA.grossProfitPerPack !== 1000 || catalogA.vendorProfitPerPack !== 300 || catalogA.investorNetPerPack !== 575) {
  failures.push(`método 2 por paquete inesperado: ${catalogA.grossProfitPerPack}, ${catalogA.vendorProfitPerPack}, ${catalogA.investorNetPerPack}`);
}
const catalogB = saleProducts([method3])[0];
if (catalogB.vendorProfitPerPack !== 262.5 || catalogB.investorNetPerPack !== 612.5 || catalogB.commissionMethod !== "3") {
  failures.push(`método 3 por paquete inesperado: ${catalogB.vendorProfitPerPack}, ${catalogB.investorNetPerPack}`);
}

const one = commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 2 }]), state([method2, method3]));
if (one.status !== "created") failures.push("la venta de dos paquetes debía crearse");
else {
  const line = one.sale.lines[0];
  if (one.sale.salesTotal !== 4000 || one.sale.grossProfit !== 2000 || one.sale.vendorProfit !== 600 || one.sale.investorNet !== 1150) {
    failures.push("los totales del método 2 no son precio y ganancia por paquete multiplicados");
  }
  if (line.costPerPack !== 1000 || line.logisticsPerPack !== 125 || line.commissionMethod !== "2" || line.vendorSharePercent !== 30) {
    failures.push("el snapshot no conservó costo, logística, método o porcentaje");
  }
  if (one.stock[0]?.soldPackages !== 2) failures.push("el saldo vendido debía quedar en 2");
  if (method2.products[0]?.packages !== 4) failures.push("la venta modificó los paquetes comprados");
}

const mixed = commitSale(
  request([
    { inventoryId: "inv-a", productId: "prod-1", quantity: 1 },
    { inventoryId: "inv-b", productId: "prod-2", quantity: 2 },
  ], "op-mix"),
  state([method2, method3]),
);
if (mixed.status !== "created") failures.push("una venta debía aceptar dos inventarios");
else if (mixed.sale.packageCount !== 3 || mixed.sale.salesTotal !== 6000 || mixed.sale.vendorProfit !== 825 || mixed.sale.investorNet !== 1800) {
  failures.push(`el consolidado no suma las líneas: ${mixed.sale.salesTotal}, ${mixed.sale.vendorProfit}, ${mixed.sale.investorNet}`);
} else if (mixed.sale.lines[0]?.invoiceNumber !== "0000101004" || mixed.sale.lines[1]?.invoiceNumber !== "0000101008") {
  failures.push("las facturas de las líneas se mezclaron");
} else if (mixed.stock.length !== 2) failures.push("cada inventario y producto debía tener su saldo");

const repeated = commitSale(
  request([
    { inventoryId: "inv-a", productId: "prod-1", quantity: 2 },
    { inventoryId: "inv-a", productId: "prod-1", quantity: 2 },
  ], "op-repeat"),
  state([method2], [{ ownerUid: "owner-1", inventoryId: "inv-a", productId: "prod-1", soldPackages: 1, updatedAt: "" }]),
);
if (repeated.status !== "rejected") failures.push("dos líneas del mismo producto debían sumarse y rechazarse");
const partialStock = [{ ownerUid: "owner-1", inventoryId: "inv-a", productId: "prod-1", soldPackages: 1, updatedAt: "" }];
const partial = commitSale(
  request([
    { inventoryId: "inv-a", productId: "prod-1", quantity: 1 },
    { inventoryId: "inv-b", productId: "prod-2", quantity: 5 },
  ], "op-partial"),
  state([method2, method3], partialStock),
);
if (partial.status !== "rejected" || partialStock[0]?.soldPackages !== 1) {
  failures.push("una línea sin disponibilidad debía cancelar toda la venta sin mover saldos");
}

const sameProductOtherInventory = inventory({
  id: "inv-c",
  name: "Factura C",
  logistics: 0,
  products: [product({ packages: 2, orderCode: "C-1" })],
});
const separate = commitSale(
  request([{ inventoryId: "inv-c", productId: "prod-1", quantity: 2 }], "op-separate"),
  state([method2, sameProductOtherInventory], [{ ownerUid: "owner-1", inventoryId: "inv-a", productId: "prod-1", soldPackages: 4, updatedAt: "" }]),
);
if (separate.status !== "created" || separate.stock.some((item) => item.inventoryId === "inv-a")) {
  failures.push("el mismo producto en otro inventario debía usar su propio saldo");
}

const created = one.status === "created" ? one.sale : null;
const duplicate = created
  ? commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 2 }], "op-1"), state([method2], one.status === "created" ? one.stock : [], created))
  : null;
if (duplicate?.status !== "existing" || (one.status === "created" && one.stock[0]?.soldPackages !== 2)) {
  failures.push("repetir la misma operación no debía volver a descontar paquetes");
}

const changed = inventory({
  id: "inv-a",
  name: "Factura A",
  products: [product({ manualPrice: 2500 })],
});
if (created && created.lines[0]?.appliedPrice !== 2000) failures.push("el snapshot cambió después de registrar");
const nextSale = commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 1 }], "op-new"), state([changed]));
if (nextSale.status !== "created" || nextSale.sale.lines[0]?.appliedPrice !== 2500 || created?.lines[0]?.appliedPrice !== 2000) {
  failures.push("una venta nueva debía usar el precio actual sin recalcular la anterior");
}

const invalid = commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 1.5 }]), state([method2]));
const empty = commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 0 }]), state([method2]));
const negative = commitSale(request([{ inventoryId: "inv-a", productId: "prod-1", quantity: -1 }]), state([method2]));
if (invalid.status !== "rejected" || empty.status !== "rejected" || negative.status !== "rejected") {
  failures.push("una cantidad vacía, decimal o negativa debía rechazar la venta completa");
}
const unnamed = commitSale(request([], "op-empty"), { ...state([method2]), existingSale: null });
if (unnamed.status !== "rejected") failures.push("una venta sin líneas debía rechazarse");

const preview = reviewSale(
  [
    { inventoryId: "inv-a", productId: "prod-1", quantity: 1 },
    { inventoryId: "inv-a", productId: "prod-1", quantity: null },
  ],
  saleProducts([method2]),
  {},
);
if (preview.ok || preview.rows[1]?.message === "") failures.push("una línea sin cantidad debía impedir la confirmación");
const enough = reviewSale(
  [
    { inventoryId: "inv-a", productId: "prod-1", quantity: 1 },
    { inventoryId: "inv-b", productId: "prod-2", quantity: 1 },
  ],
  saleProducts([method2, method3]),
  { "inv-a:prod-1": 3 },
);
if (!enough.ok || enough.rows[0]?.available !== 1 || enough.rows[0]?.availableAfter !== 0 || enough.totals.packageCount !== 2) {
  failures.push("la revisión debía separar disponibilidad por inventario y sumar el consolidado");
}

const sharedInventory = {
  ...inventory({ id: "inv-a", name: "Factura compartida", products: [product({ packages: 4 })] }),
  ownerUid: "otro-usuario",
};
const shared = commitSale(
  request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 1 }], "op-shared"),
  state([sharedInventory], [{ ownerUid: "otro-usuario", inventoryId: "inv-a", productId: "prod-1", soldPackages: 2, updatedAt: "" }]),
);
if (shared.status !== "created" || shared.stock[0]?.ownerUid !== "owner-1" || shared.stock[0]?.soldPackages !== 1) {
  failures.push("una venta debía ver los paquetes vendidos por otro usuario y sumar solo los propios");
}
const sharedOver = commitSale(
  request([{ inventoryId: "inv-a", productId: "prod-1", quantity: 3 }], "op-shared-over"),
  state([sharedInventory], [{ ownerUid: "otro-usuario", inventoryId: "inv-a", productId: "prod-1", soldPackages: 2, updatedAt: "" }]),
);
if (sharedOver.status !== "rejected") failures.push("la disponibilidad debía incluir lo vendido por otros usuarios");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sales ok");
