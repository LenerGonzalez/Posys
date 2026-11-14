import { usablePackages } from "./fieldValidation";
import { applyProductPriceEdit, buildPriceRows } from "./priceCatalog";
import {
  isMeasureUnit,
  measureUnitLabel,
  patchProductKeepingUnit,
  productMeasureUnit,
  withStoredMeasureUnit,
  type PricingInventory,
  type ProductInput,
} from "./types";

const failures: string[] = [];

function base(partial: Partial<ProductInput> = {}): ProductInput {
  return {
    id: partial.id ?? "p",
    orderCode: partial.orderCode ?? "F-1",
    name: partial.name ?? "Arroz",
    costPerPack: partial.costPerPack ?? 1000,
    packages: partial.packages ?? 4,
    priceMethod: "MARGEN",
    manualPrice: null,
    targetMarginPercent: null,
    vendorSharePercent: null,
    ...partial,
  };
}

function inventory(products: ProductInput[]): PricingInventory {
  return {
    id: "inv",
    ownerUid: "user",
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

function savedKeys(product: ProductInput): string[] {
  return Object.keys(JSON.parse(JSON.stringify(product)) as Record<string, unknown>);
}

const historical = withStoredMeasureUnit(base(), undefined);
if ("unit" in historical || savedKeys(historical).includes("unit")) failures.push("un producto histórico no debe guardar unit");
if (productMeasureUnit(historical) !== "package" || measureUnitLabel(productMeasureUnit(historical)) !== "Paquete") {
  failures.push("un producto sin unit debe mostrarse como Paquete");
}

const invalid = withStoredMeasureUnit(base(), "kg");
if ("unit" in invalid) failures.push("una unidad desconocida no debe guardarse");
if (productMeasureUnit(invalid) !== "package") failures.push("una unidad desconocida debe leerse como paquete");

for (const unit of ["package", "lb", "unit"] as const) {
  const created = withStoredMeasureUnit(base({ name: unit }), unit);
  if (created.unit !== unit) failures.push(`crear por ${unit} no conservó la unidad`);
  if (!savedKeys(created).includes("unit")) failures.push(`crear por ${unit} no persistiría unit`);
  if (productMeasureUnit(created) !== unit) failures.push(`leer ${unit} falló`);
}

if (measureUnitLabel("package") !== "Paquete" || measureUnitLabel("lb") !== "Libra (lb)" || measureUnitLabel("unit") !== "Unidad") {
  failures.push("las etiquetas de unidad no coinciden");
}
if (isMeasureUnit("") || isMeasureUnit(null) || isMeasureUnit(1.5)) failures.push("la creación debe rechazar una unidad vacía");

const locked = patchProductKeepingUnit(withStoredMeasureUnit(base(), "lb"), { name: "Nuevo", unit: "unit", packages: 8 });
if (locked.unit !== "lb" || locked.name !== "Nuevo" || locked.packages !== 8) failures.push("editar no debe cambiar la unidad");
const historicalEdit = patchProductKeepingUnit(historical, { name: "Viejo", unit: "lb" });
if ("unit" in historicalEdit || historicalEdit.name !== "Viejo") failures.push("editar un histórico no debe introducir unit");

const rows = buildPriceRows([
  inventory([
    historical,
    withStoredMeasureUnit(base({ id: "lb", name: "Azúcar" }), "lb"),
    withStoredMeasureUnit(base({ id: "each", name: "Huevo" }), "unit"),
  ]),
]);
const shown = Object.fromEntries(rows.map((row) => [row.product, measureUnitLabel(row.unit)]));
if (shown.Arroz !== "Paquete" || shown.Azúcar !== "Libra (lb)" || shown.Huevo !== "Unidad") {
  failures.push(`las filas de precios no muestran la unidad: ${JSON.stringify(shown)}`);
}

const priced = applyProductPriceEdit(
  inventory([withStoredMeasureUnit(base({ manualPrice: 2000, priceMethod: "PRECIO" }), "lb")]),
  "p",
  { priceMethod: "PRECIO", manualPrice: 2100, targetMarginPercent: null },
  { uid: "user", email: null },
  "2026-11-14T12:00:00.000Z",
);
if ("error" in priced || priced.inventory.products[0]?.unit !== "lb") failures.push("editar el precio no debe cambiar la unidad");

const pricedHistorical = applyProductPriceEdit(
  inventory([historical]),
  "p",
  { priceMethod: "PRECIO", manualPrice: 2100, targetMarginPercent: null },
  { uid: "user", email: null },
  "2026-11-14T12:00:00.000Z",
);
if ("error" in pricedHistorical || "unit" in pricedHistorical.inventory.products[0]) {
  failures.push("editar el precio de un histórico introdujo unit");
}

if (usablePackages(2) !== 2 || usablePackages(1.5) !== 0 || !Number.isInteger(locked.packages)) {
  failures.push("las cantidades dejaron de ser enteras");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("measure unit phase 1 ok");
