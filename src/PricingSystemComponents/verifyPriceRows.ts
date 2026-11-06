import { applyProductPriceEdit, buildPriceRows, filterPriceRows, normalizePriceChanges, previewProductPrice, priceOrigin, priceScopeOptions } from "./priceCatalog";
import type { PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function product(partial: Partial<ProductInput>): ProductInput {
  return {
    id: partial.id ?? "p",
    orderCode: partial.orderCode ?? "",
    name: partial.name ?? "Arroz",
    costPerPack: 1000,
    packages: 4,
    priceMethod: "PRECIO",
    manualPrice: partial.manualPrice ?? 2000,
    targetMarginPercent: null,
    vendorSharePercent: null,
  };
}

function inventory(partial: { id: string; name: string; products: ProductInput[]; logistics?: number; margin?: number }): PricingInventory {
  return {
    id: partial.id,
    ownerUid: "user",
    ownerEmail: null,
    name: partial.name,
    settings: {
      logisticsCost: partial.logistics ?? 0,
      vendorSharePercent: 30,
      targetMarginPercent: partial.margin ?? 30,
      branchLabel: "Única",
      commissionMethod: "2",
    },
    products: partial.products,
    history: [],
    createdAt: null,
    updatedAt: null,
  };
}

if (priceOrigin("Copia de Factura 0000101004", "0000101004") !== "Copia de Factura 0000101004 · Factura 0000101004") {
  failures.push("la factura debía mostrarse junto al inventario");
}
if (priceOrigin("Inventario de noviembre", "0000101008") !== "Inventario de noviembre · Factura 0000101008") {
  failures.push("el número de factura debía conservar su inventario");
}
if (priceOrigin("Inventario de noviembre", "") !== "Inventario de noviembre · Sin factura") {
  failures.push("sin número debía decir Sin factura");
}

const rows = buildPriceRows([
  inventory({
    id: "inv-a",
    name: "Copia de Factura 0000101004",
    products: [product({ id: "prod-1", name: "Arroz", orderCode: "0000101004", manualPrice: 1800 })],
  }),
  inventory({
    id: "inv-b",
    name: "Inventario de noviembre",
    products: [
      product({ id: "prod-1", name: "Arroz", orderCode: "0000101008", manualPrice: 2100 }),
      product({ id: "prod-2", name: "Frijol", orderCode: "", manualPrice: 900 }),
    ],
  }),
]);

const arroz = rows.filter((row) => row.product === "Arroz");
if (arroz.length !== 2) failures.push(`Arroz debía ocupar dos filas: ${arroz.length}`);
if (arroz[0]?.inventoryId === arroz[1]?.inventoryId) failures.push("las dos filas de Arroz no pueden compartir inventario");
if (new Set(arroz.map((row) => row.id)).size !== 2) failures.push("cada fila debe identificarse por inventario y producto");
if (arroz.some((row) => row.productId !== "prod-1")) failures.push("el id del producto no debe cambiar");
if (!rows.some((row) => row.origin === "Inventario de noviembre · Sin factura" && row.product === "Frijol")) {
  failures.push("Frijol debía indicar que no tiene factura");
}
if (rows.some((row) => row.product.includes("Factura") || row.product.includes("·"))) {
  failures.push("el nombre del producto no debe mezclarse con la factura");
}

const filtered = filterPriceRows(rows, { scope: "inv:inv-b", query: "ARROZ", minPrice: 2000, maxPrice: 2200 });
if (filtered.length !== 1 || filtered[0]?.inventoryId !== "inv-b") failures.push("los filtros combinados debían dejar solo el Arroz de noviembre");
const priced = filterPriceRows(rows, { scope: "", query: "", minPrice: null, maxPrice: 1000 });
if (!priced.every((row) => row.price <= 1000) || priced.some((row) => row.product === "Arroz")) failures.push("el precio máximo debía excluir el Arroz");
if (filterPriceRows(rows, { scope: "", query: "frijol", minPrice: null, maxPrice: null }).length !== 1) failures.push("la búsqueda debía ignorar mayúsculas");
const scopes = priceScopeOptions([
  inventory({
    id: "inv-b",
    name: "Inventario de noviembre",
    products: [
      product({ id: "prod-1", name: "Arroz", orderCode: "0000101008" }),
      product({ id: "prod-2", name: "Frijol", orderCode: "" }),
    ],
  }),
]);
if (scopes[0]?.label !== "Todos los inventarios") failures.push("la primera opción debía ser todos los inventarios");
if (scopes.length !== 2) failures.push("el filtro debía ofrecer solo todos los inventarios y cada inventario");
if (scopes.some((option) => option.value.startsWith("bill:"))) failures.push("el filtro no debe separar por factura");
if (!scopes.some((option) => option.value === "inv:inv-b" && option.label.includes("Factura 0000101008") && option.label.includes("Sin factura"))) {
  failures.push("el inventario completo debía mostrar sus facturas");
}
const wholeInventory = filterPriceRows(rows, { scope: "inv:inv-b", query: "", minPrice: null, maxPrice: null });
if (wholeInventory.length !== 2 || wholeInventory.some((row) => row.inventoryId !== "inv-b")) {
  failures.push("elegir un inventario debía conservar todas sus facturas");
}

const source = inventory({
  id: "inv-a",
  name: "Bodega",
  logistics: 500,
  products: [
    product({ id: "prod-1", name: "Arroz", orderCode: "A-1", manualPrice: 2000 }),
    product({ id: "prod-9", name: "Azúcar", orderCode: "A-1", manualPrice: 1500 }),
  ],
});
const other = inventory({
  id: "inv-b",
  name: "Sucursal",
  logistics: 500,
  products: [product({ id: "prod-1", name: "Arroz", orderCode: "B-9", manualPrice: 2000 })],
});
const manual = applyProductPriceEdit(source, "prod-1", { priceMethod: "PRECIO", manualPrice: 2500, targetMarginPercent: null }, { uid: "uid-1", email: "ana@correo.com" }, "2026-05-02T15:00:00.000Z");
if ("error" in manual) failures.push(manual.error);
else {
  const line = previewProductPrice(manual.inventory, "prod-1", { priceMethod: "PRECIO", manualPrice: 2500, targetMarginPercent: null });
  const beforeLogistics = previewProductPrice(source, "prod-1", { priceMethod: "PRECIO", manualPrice: 2000, targetMarginPercent: null });
  if (line?.after.appliedPrice !== 2500) failures.push("el precio manual debía aplicarse");
  if (!beforeLogistics || !line || line.after.logisticsAllocated !== beforeLogistics.before.logisticsAllocated) {
    failures.push("editar el precio volvió a prorratear la logística");
  }
  if (!line || line.after.realMarginPercent === beforeLogistics?.before.realMarginPercent) {
    failures.push("el margen real debía recalcularse con el precio nuevo");
  }
  if (manual.inventory.products.find((item) => item.id === "prod-9")?.manualPrice !== 1500) failures.push("el otro producto del inventario cambió");
  if (manual.inventory.settings.logisticsCost !== 500 || manual.inventory.settings.commissionMethod !== "2") failures.push("la logística o el método de comisión cambió");
  if (source.products[0]?.manualPrice !== 2000) failures.push("el inventario original fue mutado");
  if (manual.inventory.priceChanges?.length !== 1) failures.push("debía quedar un registro de precio");
  if (manual.inventory.history.length !== 1) failures.push("debía agregar el guardado sin borrar la estructura");
  if (manual.record.userUid !== "uid-1" || manual.record.productId !== "prod-1" || manual.record.inventoryId !== "inv-a") failures.push("el registro no identifica inventario, producto y usuario");
  if (manual.record.previousAppliedPrice !== 2000 || manual.record.nextAppliedPrice !== 2500) failures.push("el registro no conserva el precio anterior y el nuevo");
  const kept = normalizePriceChanges(manual.inventory.priceChanges);
  if (kept[0]?.nextAppliedPrice !== 2500 || kept[0]?.orderCode !== "A-1") failures.push("el registro no sobrevive al leerse de nuevo");
  const again = applyProductPriceEdit(manual.inventory, "prod-1", { priceMethod: "MARGEN", manualPrice: 2500, targetMarginPercent: 30 }, { uid: "uid-1", email: "ana@correo.com" }, "2026-05-02T16:00:00.000Z");
  if ("error" in again) failures.push(again.error);
  else {
    const marginLine = again.inventory.products.find((item) => item.id === "prod-1");
    const computed = previewProductPrice(again.inventory, "prod-1", { priceMethod: "MARGEN", manualPrice: marginLine?.manualPrice ?? null, targetMarginPercent: 30 });
    if (computed?.after.priceMethod !== "MARGEN" || computed.after.appliedPrice !== computed.after.automaticPrice) failures.push("el margen debía usar el precio automático del motor");
    if ((again.inventory.priceChanges ?? []).length !== 2) failures.push("el segundo cambio no debe borrar el primero");
    if (again.inventory.priceChanges?.[0]?.changedAt !== "2026-05-02T15:00:00.000Z") failures.push("el registro anterior fue sobrescrito");
  }
}
const zeroPrice = applyProductPriceEdit(source, "prod-1", { priceMethod: "PRECIO", manualPrice: 0, targetMarginPercent: null }, { uid: "u", email: null }, "2026-05-02T17:00:00.000Z");
if (!("error" in zeroPrice)) failures.push("un precio manual en cero no debía guardarse");
const fullMargin = applyProductPriceEdit(source, "prod-1", { priceMethod: "MARGEN", manualPrice: null, targetMarginPercent: 100 }, { uid: "u", email: null }, "2026-05-02T17:00:00.000Z");
if (!("error" in fullMargin)) failures.push("un margen de 100 % no debía guardarse");
const untouched = applyProductPriceEdit(source, "prod-1", { priceMethod: "PRECIO", manualPrice: 2200, targetMarginPercent: null }, { uid: "u", email: null }, "2026-05-02T18:00:00.000Z");
if (!("error" in untouched) && other.products[0]?.manualPrice !== 2000) failures.push("editar un inventario modificó el otro");
const refreshed = buildPriceRows(["error" in untouched ? [] : [untouched.inventory, other]].flat());
const editedRow = refreshed.find((row) => row.inventoryId === "inv-a" && row.productId === "prod-1");
const otherRow = refreshed.find((row) => row.inventoryId === "inv-b" && row.productId === "prod-1");
if (editedRow?.price !== 2200 || otherRow?.price === 2200) failures.push("la pantalla debía refrescar solo la fila editada");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("price rows ok", { rows: rows.map((row) => `${row.origin} | ${row.product}`) });
