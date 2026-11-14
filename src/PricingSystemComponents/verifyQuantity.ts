import { reviewNumericChange } from "./fieldValidation";
import { computeInventory } from "./pricingEngine";
import {
  milliFromAmount,
  productQuantity,
  readQuantityMilli,
  storedQuantity,
  takeStoredQuantity,
  withStoredQuantity,
} from "./quantity";
import { commitSale, isSaleQuantity, saleProducts } from "./saleCommit";
import type { PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function near(actual: number, expected: number, label: string) {
  if (Math.abs(actual - expected) > 1e-6) failures.push(`${label}: ${actual} en vez de ${expected}`);
}

function product(partial: Partial<ProductInput> & { name: string }): ProductInput {
  return {
    id: partial.id ?? partial.name,
    orderCode: partial.orderCode ?? "F-1",
    costPerPack: partial.costPerPack ?? 1000,
    priceMethod: partial.priceMethod ?? "PRECIO",
    manualPrice: partial.manualPrice === undefined ? 2000 : partial.manualPrice,
    targetMarginPercent: null,
    vendorSharePercent: null,
    ...partial,
  };
}

function inventory(products: ProductInput[], method: "2" | "3" = "2", logistics = 500): PricingInventory {
  return {
    id: "inv",
    ownerUid: "user",
    ownerEmail: null,
    name: "Inventario",
    settings: {
      logisticsCost: logistics,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Única",
      commissionMethod: method,
    },
    products,
    history: [],
    createdAt: null,
    updatedAt: null,
  };
}

function keysOf(value: object): string[] {
  return Object.keys(JSON.parse(JSON.stringify(value)) as object);
}

const historical = product({ name: "Histórico", packages: 20 });
const historicalLine = computeInventory(inventory([historical], "2", 500)).lines[0];
near(historicalLine.packages, 20, "histórico 20");
near(historicalLine.purchaseSubtotal, 20000, "subtotal histórico");
near(historicalLine.salesTotal, 40000, "venta histórica");
near(historicalLine.grossProfit, 20000, "utilidad histórica");
near(historicalLine.logisticsAllocated, 500, "logística histórica");
near(historicalLine.vendorProfit, 6000, "comisión histórica método 2");
near(historicalLine.investorNet, 13500, "neta histórica método 2");
if (keysOf(historical).includes("quantityMilli")) failures.push("el histórico no debe guardar quantityMilli");

const golden = product({ name: "Caso", packages: 4 });
const method2 = computeInventory(inventory([golden], "2")).lines[0];
const method3 = computeInventory(inventory([golden], "3")).lines[0];
near(method2.purchaseSubtotal, 4000, "compra método 2");
near(method2.salesTotal, 8000, "venta método 2");
near(method2.grossProfit, 4000, "utilidad método 2");
near(method2.vendorProfit, 1200, "comisión método 2");
near(method2.investorNet, 2300, "neta método 2");
near(method3.vendorProfit, 1050, "comisión método 3");
near(method3.investorNet, 2450, "neta método 3");

const oneAndHalf = withStoredQuantity(product({ name: "Libra", unit: "lb", packages: 1 }), 1500);
if (!oneAndHalf || oneAndHalf.quantityMilli !== 1500 || "packages" in oneAndHalf) {
  failures.push("1.5 lb debía guardarse solo como quantityMilli 1500");
}
const pounds = withStoredQuantity(product({ name: "Saco", unit: "lb", packages: 1 }), 125500);
if (!pounds || pounds.quantityMilli !== 125500 || "packages" in pounds) {
  failures.push("125.500 lb debía guardarse como quantityMilli 125500");
}
if (storedQuantity("unit", 1500) || storedQuantity("package", 1500)) {
  failures.push("unidad y paquete aceptaron un decimal");
}
const integerPound = storedQuantity("lb", 2000);
if (!integerPound || !("packages" in integerPound) || integerPound.packages !== 2 || "quantityMilli" in integerPound) {
  failures.push("una libra entera debía guardarse en packages");
}

const conflict = product({ name: "Conflicto", unit: "lb", packages: 4, quantityMilli: 1500 });
if (readQuantityMilli(conflict).ok) failures.push("packages y quantityMilli distintos debían rechazarse");
if (computeInventory(inventory([conflict], "2", 0)).lines.length !== 0) {
  failures.push("un registro inconsistente entró al cálculo");
}

const mixed = computeInventory(inventory([
  product({ id: "pack", name: "Paquete", unit: "package", packages: 4, costPerPack: 1000 }),
  oneAndHalf ? { ...oneAndHalf, id: "lb", costPerPack: 1000 } : product({ name: "falta" }),
  product({ id: "each", name: "Unidad", unit: "unit", packages: 2, costPerPack: 1000 }),
], "2", 750));
if (mixed.lines.length !== 3) failures.push("el inventario mixto no conservó las tres unidades");
const byName = Object.fromEntries(mixed.lines.map((line) => [line.name, line]));
near(byName.Paquete?.purchaseSubtotal ?? -1, 4000, "subtotal paquete");
near(byName.Libra?.packages ?? -1, 1.5, "cantidad 1.5");
near(byName.Libra?.purchaseSubtotal ?? -1, 1500, "subtotal 1.5 lb");
near(byName.Unidad?.purchaseSubtotal ?? -1, 2000, "subtotal unidad");
near(byName.Paquete?.logisticsAllocated ?? -1, 400, "logística del paquete");
near(byName.Libra?.logisticsAllocated ?? -1, 150, "logística de la libra");
near(byName.Unidad?.logisticsAllocated ?? -1, 200, "logística de la unidad");
near(byName.Libra?.logisticsPerPack ?? -1, 100, "logística por libra");
near(byName.Paquete?.vendorProfit ?? -1, 1200, "comisión del paquete");
near(byName.Libra?.vendorProfit ?? -1, 450, "comisión de la libra");
near(byName.Unidad?.vendorProfit ?? -1, 600, "comisión de la unidad");
near(byName.Libra?.investorNet ?? -1, 900, "neta de la libra");

function restored(value: ProductInput): ProductInput {
  const saved = JSON.parse(JSON.stringify(value)) as ProductInput;
  const next: ProductInput = {
    id: saved.id,
    orderCode: saved.orderCode,
    name: saved.name,
    costPerPack: saved.costPerPack,
    priceMethod: saved.priceMethod,
    manualPrice: saved.manualPrice,
    targetMarginPercent: saved.targetMarginPercent,
    vendorSharePercent: saved.vendorSharePercent,
    ...takeStoredQuantity(saved),
  };
  if (saved.unit) next.unit = saved.unit;
  return next;
}

for (const sample of [historical, oneAndHalf, pounds].filter((item): item is ProductInput => Boolean(item))) {
  const again = restored(sample);
  if (productQuantity(again) !== productQuantity(sample) || keysOf(again).sort().join() !== keysOf(sample).sort().join()) {
    failures.push(`al leer de nuevo cambió ${sample.name}`);
  }
}

const poundInput = reviewNumericChange(1, "1.234", "1.2345", "pounds");
const pastedPounds = reviewNumericChange(1, "1", "12.34567", "pounds");
const commaInput = reviewNumericChange(1, "1", "1,500", "pounds");
const validPound = reviewNumericChange(1, "1", "2.375", "pounds");
const unitDecimal = reviewNumericChange(1, "1", "1.5", "units");
const packageDecimal = reviewNumericChange(1, "1", "1.5", "packages");
if (poundInput.draft !== "1.234" || !poundInput.commit || poundInput.value !== 1.234) {
  failures.push("el cuarto decimal de libras no se bloqueó");
}
if (pastedPounds.draft !== "12.345" || !pastedPounds.commit || pastedPounds.value !== 12.345) {
  failures.push("una libra pegada con más de tres decimales no se recortó");
}
if (commaInput.commit || unitDecimal.commit || packageDecimal.commit) {
  failures.push("un decimal inválido fue aceptado en el formulario");
}
if (!validPound.commit || validPound.value !== 2.375 || milliFromAmount(2.375) !== 2375) {
  failures.push("2.375 lb no se convirtió a 2375 milésimas");
}
for (const sample of ["0.125", "1.500", "25.375"]) {
  const reviewed = reviewNumericChange(1, "1", sample, "pounds");
  if (!reviewed.commit || reviewed.value !== Number(sample)) failures.push(`${sample} lb debía aceptarse`);
}
if (milliFromAmount(1.5) !== 1500 || milliFromAmount(125.5) !== 125500) {
  failures.push("la conversión a milésimas no coincide");
}

if (isSaleQuantity(1.5) || !isSaleQuantity(2) || !isSaleQuantity(1.5, "lb") || isSaleQuantity(1.5, "unit")) {
  failures.push("la venta no distingue la unidad al validar la cantidad");
}
const decimalSale = commitSale({
  operationId: "op-decimal",
  ownerUid: "user",
  sellerUid: "user",
  sellerName: "Vendedor",
  soldAt: "2026-11-14T12:00:00.000Z",
  lines: [{ inventoryId: "inv", productId: "Libra", quantity: 1.5 }],
}, { existingSale: null, inventories: [inventory(oneAndHalf ? [historical, oneAndHalf] : [historical])], stock: [] });
if (decimalSale.status !== "created") failures.push("la venta de 1.5 lb fue rechazada");
else if (decimalSale.sale.lines[0]?.quantityMilli !== 1500 || decimalSale.sale.lines[0]?.quantity != null || decimalSale.sale.lines[0]?.unit !== "lb" || decimalSale.stock[0]?.quantityMilli !== 1500) {
  failures.push("la venta de 1.5 lb no guardó solo las milésimas");
}
const offered = saleProducts([inventory(oneAndHalf ? [historical, oneAndHalf] : [historical])]);
if (!offered.some((item) => item.productName === "Histórico" && item.initialPackages === 20 && item.unit === "package")) {
  failures.push("el producto histórico salió del catálogo de ventas");
}
if (!offered.some((item) => item.productName === "Libra" && item.unit === "lb" && item.initialPackages === 1.5)) {
  failures.push("la libra decimal no quedó disponible para venderse como libra");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("quantity phase 2 ok");
