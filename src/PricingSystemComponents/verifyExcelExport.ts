import { mkdirSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { buildPriceRows, EMPTY_PRICE_FILTERS, filterPriceRows } from "./priceCatalog";
import { computeInventory } from "./pricingEngine";
import {
  buildInventoryWorkbook,
  buildPriceCatalogWorkbook,
  inventoryWorkbookName,
  priceCatalogFileName,
  type PriceCatalogEntry,
} from "./excelExport";
import type { PricingInventory, ProductInput } from "./types";

const failures: string[] = [];

function check(condition: boolean, message: string) {
  if (!condition) failures.push(message);
}

function product(partial: Partial<ProductInput>): ProductInput {
  return {
    id: partial.id ?? "p1",
    orderCode: partial.orderCode ?? "0000101004",
    name: partial.name ?? "Arroz",
    costPerPack: partial.costPerPack ?? 1000,
    packages: partial.packages ?? 4,
    priceMethod: partial.priceMethod ?? "PRECIO",
    manualPrice: partial.manualPrice === undefined ? 2000 : partial.manualPrice,
    targetMarginPercent: partial.targetMarginPercent ?? null,
    vendorSharePercent: partial.vendorSharePercent ?? null,
  };
}

function inventory(partial: Partial<PricingInventory> & { products: ProductInput[] }): PricingInventory {
  return {
    id: partial.id ?? "inv-1",
    ownerUid: partial.ownerUid ?? "uid-dueno",
    ownerEmail: partial.ownerEmail === undefined ? "dueno@ejemplo.com" : partial.ownerEmail,
    name: partial.name ?? "Noviembre",
    settings: partial.settings ?? {
      logisticsCost: 500,
      vendorSharePercent: 30,
      targetMarginPercent: 30,
      branchLabel: "Mercado Central",
      commissionMethod: "2",
    },
    products: partial.products,
    history: partial.history ?? [],
    createdAt: partial.createdAt === undefined ? "2026-11-01T15:00:00.000Z" : partial.createdAt,
    updatedAt: partial.updatedAt === undefined ? "2026-11-07T18:30:00.000Z" : partial.updatedAt,
  };
}

function pairs(sheet: XLSX.WorkSheet): Map<string, XLSX.CellObject | undefined> {
  const map = new Map<string, XLSX.CellObject | undefined>();
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  for (let row = 1; row <= range.e.r; row += 1) {
    const label = sheet[XLSX.utils.encode_cell({ r: row, c: 0 })]?.v;
    if (typeof label === "string" && !map.has(label)) {
      map.set(label, sheet[XLSX.utils.encode_cell({ r: row, c: 1 })]);
    }
  }
  return map;
}

function headers(sheet: XLSX.WorkSheet): string[] {
  const range = XLSX.utils.decode_range(sheet["!ref"] || "A1");
  const values: string[] = [];
  for (let col = 0; col <= range.e.c; col += 1) {
    const cell = sheet[XLSX.utils.encode_cell({ r: 0, c: col })];
    if (cell?.v == null) break;
    values.push(String(cell.v));
  }
  return values;
}

function reopen(book: XLSX.WorkBook): XLSX.WorkBook {
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
  return XLSX.read(bytes, { type: "array", cellDates: true });
}

const rice = product({});
const beans = product({
  id: "p2",
  name: "Frijol",
  orderCode: "0000101004",
  costPerPack: 800,
  packages: 2,
  priceMethod: "MARGEN",
  manualPrice: null,
  targetMarginPercent: 25,
});
const november = inventory({ products: [rice, beans] });
const computed = computeInventory(november);
const book = reopen(buildInventoryWorkbook(november, computed));

check(
  book.SheetNames.join("|") === "Datos del inventario|Configuración|OM - Productos|Precios|Resumen|Utilidades",
  `hojas ${book.SheetNames.join("|")}`,
);
check(inventoryWorkbookName(november) === "Inventario_Noviembre_0000101004.xlsx", inventoryWorkbookName(november));

const data = pairs(book.Sheets["Datos del inventario"]);
check(data.get("Nombre")?.v === "Noviembre", "nombre");
check(data.get("ID del inventario")?.v === "inv-1", "id");
check(data.get("Correo del propietario")?.v === "dueno@ejemplo.com", "correo");
check(data.get("ID del propietario")?.v === "uid-dueno", "uid");
check(data.get("Facturas u órdenes")?.v === "0000101004", "factura");
check(data.get("Fecha de creación")?.v instanceof Date, "fecha de creación");
check(data.get("Última actualización")?.v instanceof Date, "actualización");

const config = pairs(book.Sheets["Configuración"]);
check(config.get("Gastos logísticos")?.v === 500 && config.get("Gastos logísticos")?.t === "n", "logística configurada");
check(config.get("Participación del vendedor")?.v === 0.3, "comisión general");
check(config.get("Margen objetivo")?.v === 0.3, "margen general");
check(config.get("Sucursal o mercado")?.v === "Mercado Central", "sucursal");
check(config.get("Método de comisión")?.v === "2", "método");
check(String(config.get("Nombre del método")?.v).includes("Opción 2"), "nombre del método");

const om = book.Sheets["OM - Productos"];
const omHeaders = headers(om);
check(omHeaders.slice(0, 5).join("|") === "ID del producto|Orden o factura|Producto|Costo por paquete|Paquetes comprados", omHeaders.join("|"));
check(om["D2"]?.v === 1000 && om["D2"]?.t === "n", "costo original");
check(om["E2"]?.v === 4 && om["E2"]?.t === "n", "paquetes comprados");
check(om["D3"]?.v === 800 && om["E3"]?.v === 2, "segunda compra");
check(om["!autofilter"] != null, "filtro OM");

const priceHeaders = headers(book.Sheets.Precios);
check(
  priceHeaders.slice(0, 12).join("|") === "Producto|Paquetes|Costo por paquete|Logística por paquete|Precio de costo|Costo + logística total|Método de cálculo|Precio manual|Margen objetivo|Precio de venta|Margen real|Venta total",
  priceHeaders.join("|"),
);
const riceLine = computed.lines.find((line) => line.id === "p1");
const beansLine = computed.lines.find((line) => line.id === "p2");
check(!!riceLine && !!beansLine, "líneas calculadas");
if (riceLine && beansLine) {
  check(book.Sheets.Precios.B2?.v === riceLine.packages, "paquetes de precios");
  check(book.Sheets.Precios.F2?.v === riceLine.purchaseSubtotal + riceLine.logisticsAllocated, "costo más logística");
  check(book.Sheets.Precios.J2?.v === riceLine.appliedPrice, "precio de venta");
  check(book.Sheets.Precios.L2?.v === riceLine.salesTotal, "venta total");
  check(book.Sheets.Precios.H2?.v === 2000, "precio manual");
  check(book.Sheets.Precios.H3 == null, "precio manual vacío");
  check(book.Sheets.Precios.I3?.v === beansLine.targetMarginPercent / 100, "margen del producto");
  check(book.Sheets.Precios.F2?.t === "n" && book.Sheets.Precios.K2?.t === "n", "tipos numéricos");
}

const summary = pairs(book.Sheets.Resumen);
check(summary.get("Productos")?.v === computed.totals.productCount, "productos");
check(summary.get("Paquetes")?.v === computed.totals.packages, "paquetes");
check(summary.get("Subtotal de compra")?.v === computed.totals.purchaseSubtotal, "subtotal");
check(summary.get("Venta proyectada")?.v === computed.totals.projectedSales, "venta");
check(summary.get("Utilidad bruta")?.v === computed.totals.grossProfit, "bruta");
check(summary.get("Comisión del vendedor")?.v === computed.totals.vendorProfit, "comisión");
check(summary.get("Ganancia neta del inversionista")?.v === computed.totals.investorNet, "neta");
check(summary.get("Inversionista antes de logística")?.v === computed.totals.investorBeforeLogistics, "antes de logística");
check(summary.get("Comisión del vendedor")?.t === "n", "comisión numérica");

const utilities = book.Sheets.Utilidades;
check(String(utilities.A8?.v) === "Producto", "encabezado de utilidades");
check(utilities.H9?.v === riceLine?.vendorProfit, "vendedor del producto");
check(utilities.J9?.v === riceLine?.investorNet, "neta del producto");
check(utilities.C9 == null, "comisión propia vacía");
check(utilities.D9?.v === riceLine?.vendorSharePercent / 100, "comisión aplicada");
check(utilities["!autofilter"] != null, "filtro de utilidades");

const method3Inventory = inventory({
  products: [rice],
  settings: {
    logisticsCost: 500,
    vendorSharePercent: 30,
    targetMarginPercent: 30,
    branchLabel: "Mercado Central",
    commissionMethod: "3",
  },
});
const method3 = computeInventory(method3Inventory);
const method3Book = reopen(buildInventoryWorkbook(method3Inventory, method3));
const method3Summary = pairs(method3Book.Sheets.Resumen);
check(method3Summary.get("Base para comisión")?.v === method3.totals.commissionBase, "base método 3");
check(method3Summary.get("Comisión del vendedor")?.v === method3.totals.vendorProfit, "comisión método 3");
check(method3Summary.get("Ganancia neta del inversionista")?.v === method3.totals.investorNet, "neta método 3");
check(method3Summary.get("Inversionista antes de logística") == null, "método 3 no usa el indicador del método 2");

const blank = inventory({
  id: "vacio",
  name: "Sin productos",
  products: [],
  createdAt: null,
  updatedAt: null,
  ownerEmail: null,
});
const emptyBook = reopen(buildInventoryWorkbook(blank, computeInventory(blank)));
check(emptyBook.SheetNames.join("|") === "Datos del inventario|Configuración|Resumen", emptyBook.SheetNames.join("|"));
check(pairs(emptyBook.Sheets["Datos del inventario"]).get("Correo del propietario") == null, "sin correo inventado");
check(pairs(emptyBook.Sheets["Datos del inventario"]).get("Fecha de creación") == null, "sin fecha inventada");
check(inventoryWorkbookName(blank) === "Inventario_Sin_productos.xlsx", inventoryWorkbookName(blank));

const several = inventory({
  name: "Noviembre",
  products: [product({ orderCode: "0000101004" }), product({ id: "p9", name: "Azúcar", orderCode: "0000101888" })],
});
check(inventoryWorkbookName(several) === "Inventario_Noviembre.xlsx", inventoryWorkbookName(several));
const severalBook = reopen(buildInventoryWorkbook(several, computeInventory(several)));
check(pairs(severalBook.Sheets["Datos del inventario"]).get("Facturas u órdenes")?.v === "0000101004, 0000101888", "facturas múltiples");

const rows = buildPriceRows([november, several]);
const filtered = filterPriceRows(rows, { ...EMPTY_PRICE_FILTERS, query: "frijol", scope: "inv:inv-1" });
check(filtered.length === 1 && filtered[0].product === "Frijol", "filtro de precios");
const entries: PriceCatalogEntry[] = filtered.map((row) => {
  const line = computeInventory(november).lines.find((item) => item.id === row.productId);
  if (!line) throw new Error("falta la línea");
  return {
    inventoryName: "Noviembre",
    line,
    manualPrice: row.manualPrice,
    productMargin: row.targetMarginPercent,
  };
});
const catalog = reopen(buildPriceCatalogWorkbook(entries));
const catalogHeaders = headers(catalog.Sheets.Precios);
check(catalog.SheetNames[0] === "Precios", "hoja de catálogo");
check(catalogHeaders.join("|") === "Inventario|Factura|Producto|Paquetes|Costo por paquete|Logística por paquete|Precio de costo|Costo + logística total|Método de cálculo|Precio manual|Margen objetivo|Precio de venta|Margen real|Venta total|Utilidad bruta|Ganancia Vendedor|Ganancia inversionista", catalogHeaders.join("|"));
check(catalog.Sheets.Precios.A2?.v === "Noviembre", "inventario del catálogo");
check(catalog.Sheets.Precios.B2?.v === "0000101004", "factura del catálogo");
check(catalog.Sheets.Precios.C2?.v === "Frijol", "solo el filtrado");
check(catalog.Sheets.Precios.A3 == null, "no exporta el resto");
check(!catalogHeaders.includes("ID del producto") && !catalogHeaders.includes("Origen del margen"), "el catálogo no agrega columnas internas");
const minimal = reopen(buildPriceCatalogWorkbook(entries, []));
const minimalHeaders = headers(minimal.Sheets.Precios);
check(minimalHeaders.join("|") === "Producto|Precio de venta", minimalHeaders.join("|"));
check(minimal.Sheets.Precios.A2?.v === "Frijol", "producto obligatorio");
check(
  minimal.Sheets.Precios.B2?.t === "n" &&
    minimal.Sheets.Precios.B2?.v === entries[0].line.appliedPrice &&
    String(minimal.Sheets.Precios.B2?.w || "").startsWith("C$"),
  `precio de venta conserva formato ${minimal.Sheets.Precios.B2?.w}`,
);
const partial = reopen(buildPriceCatalogWorkbook(entries, ["realMargin"]));
const partialHeaders = headers(partial.Sheets.Precios);
check(partialHeaders.join("|") === "Producto|Precio de venta|Margen real", partialHeaders.join("|"));
check(
  partial.Sheets.Precios.C2?.t === "n" &&
    Math.abs(Number(partial.Sheets.Precios.C2?.v) - entries[0].line.realMarginPercent / 100) < 1e-9 &&
    String(partial.Sheets.Precios.C2?.w || "").endsWith("%"),
  `margen conserva porcentaje ${partial.Sheets.Precios.C2?.w}`,
);
const gains = reopen(buildPriceCatalogWorkbook(entries, ["salesTotal", "grossProfit", "vendorProfit", "investorNet"]));
const gainHeaders = headers(gains.Sheets.Precios);
const gainLine = entries[0].line;
check(gainHeaders.join("|") === "Producto|Precio de venta|Venta total|Utilidad bruta|Ganancia Vendedor|Ganancia inversionista", gainHeaders.join("|"));
check(gains.Sheets.Precios.B2?.v === gainLine.appliedPrice, "precio aplicado");
check(gains.Sheets.Precios.C2?.v === gainLine.salesTotal, "venta total del motor");
check(gains.Sheets.Precios.D2?.v === gainLine.grossProfit, "utilidad bruta del motor");
check(gains.Sheets.Precios.E2?.v === gainLine.vendorProfit, "ganancia del vendedor");
check(gains.Sheets.Precios.F2?.v === gainLine.investorNet, "ganancia del inversionista");
check(String(gains.Sheets.Precios.C2?.w || "").startsWith("C$"), "venta total conserva formato");
check(priceCatalogFileName(new Date(2026, 10, 7)) === "Precios_Gestion_Comercial_2026-11-07.xlsx", priceCatalogFileName(new Date(2026, 10, 7)));
let emptyFailed = false;
try {
  buildPriceCatalogWorkbook([]);
} catch {
  emptyFailed = true;
}
check(emptyFailed, "catálogo vacío");

const sampleDir = "/Users/lgonzalez/Desktop/excel-ejemplos-posys";
mkdirSync(sampleDir, { recursive: true });
writeFileSync(`${sampleDir}/${inventoryWorkbookName(november)}`, XLSX.write(buildInventoryWorkbook(november, computed), { bookType: "xlsx", type: "buffer" }));
writeFileSync(
  `${sampleDir}/${priceCatalogFileName(new Date(2026, 10, 7))}`,
  XLSX.write(buildPriceCatalogWorkbook(buildPriceRows([november]).map((row) => {
    const line = computed.lines.find((item) => item.id === row.productId);
    if (!line) throw new Error("falta la línea del ejemplo");
    return { inventoryName: "Noviembre", line, manualPrice: row.manualPrice, productMargin: row.targetMarginPercent };
  })), { bookType: "xlsx", type: "buffer" }),
);
const saved = XLSX.read(`${sampleDir}/${inventoryWorkbookName(november)}`, { type: "file", cellDates: true });
check(saved.SheetNames.includes("Resumen") && saved.Sheets.Resumen.B2?.t === "n", "el archivo guardado abre y conserva números");
const savedPrices = XLSX.read(`${sampleDir}/Precios_Gestion_Comercial_2026-11-07.xlsx`, { type: "file" });
check(savedPrices.SheetNames[0] === "Precios" && savedPrices.Sheets.Precios.A2?.v === "Noviembre", "el catálogo guardado abre");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("excel export ok");
console.log(sampleDir);
