import { mkdirSync, writeFileSync } from "node:fs";
import * as XLSX from "xlsx";
import { invoiceTemplateBytes, parseInvoiceWorkbook } from "./excelPricing";
import { withStoredQuantity } from "./quantity";
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
    ...(partial.unit ? { unit: partial.unit } : {}),
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
check(omHeaders.slice(0, 6).join("|") === "ID del producto|Orden o factura|Producto|Unidad de medida|Costo por paquete|Cantidad", omHeaders.join("|"));
check(om["D2"]?.v === "Paquete", "unidad histórica");
check(om["E2"]?.v === 1000 && om["E2"]?.t === "n", "costo original");
check(om["F2"]?.v === 4 && om["F2"]?.t === "n", "cantidad comprada");
check(om["E3"]?.v === 800 && om["F3"]?.v === 2, "segunda compra");
check(om["!autofilter"] != null, "filtro OM");

const priceHeaders = headers(book.Sheets.Precios);
check(
  priceHeaders.slice(0, 13).join("|") === "Producto|Unidad de medida|Cantidad|Costo por paquete|Logística por paquete|Precio de costo|Costo + logística total|Método de cálculo|Precio manual|Margen objetivo|Precio de venta|Margen real|Venta total",
  priceHeaders.join("|"),
);
const riceLine = computed.lines.find((line) => line.id === "p1");
const beansLine = computed.lines.find((line) => line.id === "p2");
check(!!riceLine && !!beansLine, "líneas calculadas");
if (riceLine && beansLine) {
  check(book.Sheets.Precios.B2?.v === "Paquete", "unidad de precios");
  check(book.Sheets.Precios.C2?.v === riceLine.packages, "cantidad de precios");
  check(book.Sheets.Precios.G2?.v === riceLine.purchaseSubtotal + riceLine.logisticsAllocated, "costo más logística");
  check(book.Sheets.Precios.K2?.v === riceLine.appliedPrice, "precio de venta");
  check(book.Sheets.Precios.M2?.v === riceLine.salesTotal, "venta total");
  check(book.Sheets.Precios.I2?.v === 2000, "precio manual");
  check(book.Sheets.Precios.I3 == null, "precio manual vacío");
  check(book.Sheets.Precios.J3?.v === beansLine.targetMarginPercent / 100, "margen del producto");
  check(book.Sheets.Precios.G2?.t === "n" && book.Sheets.Precios.L2?.t === "n", "tipos numéricos");
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
check(utilities.B9?.v === "Paquete", "unidad en utilidades");
check(utilities.C9?.v === riceLine?.packages, "cantidad en utilidades");
check(utilities.I9?.v === riceLine?.vendorProfit, "vendedor del producto");
check(utilities.K9?.v === riceLine?.investorNet, "neta del producto");
check(utilities.D9 == null, "comisión propia vacía");
check(riceLine != null && utilities.E9?.v === riceLine.vendorSharePercent / 100, "comisión aplicada");
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
check(catalogHeaders.join("|") === "Inventario|Factura|Producto|Unidad de medida|Cantidad|Costo por paquete|Logística por paquete|Precio de costo|Costo + logística total|Método de cálculo|Precio manual|Margen objetivo|Precio de venta|Margen real|Venta total|Utilidad bruta|Ganancia Vendedor|Ganancia inversionista", catalogHeaders.join("|"));
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

const wholePounds = product({ id: "lb-whole", name: "Azúcar entera", packages: 20, unit: "lb" });
const decimalPounds = withStoredQuantity(product({ id: "lb-decimal", name: "Azúcar decimal", unit: "lb" }), 1500);
const precisePounds = withStoredQuantity(product({ id: "lb-precise", name: "Azúcar precisa", unit: "lb" }), 125500);
const each = product({ id: "each", name: "Huevo", packages: 10, unit: "unit" });
const historicalPack = product({ id: "hist", name: "Arroz histórico", packages: 20 });
check(Boolean(decimalPounds && precisePounds), "no se prepararon las libras decimales");
if (decimalPounds && precisePounds) {
  const mixed = inventory({
    products: [historicalPack, wholePounds, decimalPounds, precisePounds, each],
  });
  const mixedBook = reopen(buildInventoryWorkbook(mixed, computeInventory(mixed)));
  const mixedOm = mixedBook.Sheets["OM - Productos"];
  const mixedHeaders = headers(mixedOm);
  const unitCol = mixedHeaders.indexOf("Unidad de medida");
  const quantityCol = mixedHeaders.indexOf("Cantidad");
  const read = (row: number, col: number) => mixedOm[XLSX.utils.encode_cell({ r: row, c: col })]?.v;
  check(unitCol >= 0 && quantityCol >= 0, "faltan columnas de unidad o cantidad");
  const exported = [1, 2, 3, 4, 5].map((row) => `${read(row, 0)}|${read(row, unitCol)}|${read(row, quantityCol)}`);
  check(exported.join(" || ") === [
    "hist|Paquete|20",
    "lb-whole|Libra (lb)|20",
    "lb-decimal|Libra (lb)|1.5",
    "lb-precise|Libra (lb)|125.5",
    "each|Unidad|10",
  ].join(" || "), `exportación de cantidades ${exported.join(" || ")}`);
  check(!JSON.stringify(exported).includes("1500") && !JSON.stringify(exported).includes("125500"), "se exportaron milésimas");
}

function invoiceFile(rows: (string | number)[][]): ArrayBuffer {
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  const file = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(file, sheet, "Factura");
  const bytes = XLSX.write(file, { bookType: "xlsx", type: "buffer" }) as Buffer;
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

const historicalInvoice = parseInvoiceWorkbook(invoiceFile([
  ["Orden", "Producto", "Precio costo / paquete (C$)", "Cantidad de paquetes"],
  ["0000101004", "Arroz histórico", 67.5, 20],
]));
const historicalProduct = historicalInvoice.products[0];
check(historicalInvoice.issues.length === 0, `la factura histórica tuvo observaciones: ${historicalInvoice.issues.map((issue) => issue.message).join("; ")}`);
check(historicalProduct?.packages === 20 && historicalProduct.quantityMilli == null && historicalProduct.unit == null, "un archivo sin unidad no quedó como paquete");
const decimalInvoice = parseInvoiceWorkbook(invoiceFile([
  ["Orden", "Producto", "Precio costo / paquete (C$)", "Cantidad de paquetes", "Unidad de medida"],
  ["0000101004", "Libra", 10, 1.5, "Libra (lb)"],
  ["0000101004", "Docena", 10, 10, "Unidad"],
  ["0000101004", "Caja", 10, 4, "Paquete"],
]));
check(decimalInvoice.issues.length === 0, `la factura con unidades tuvo observaciones: ${decimalInvoice.issues.map((issue) => issue.message).join("; ")}`);
check(decimalInvoice.products[0]?.quantityMilli === 1500 && decimalInvoice.products[0]?.packages == null, "1.5 lb no se importó en milésimas");
check(decimalInvoice.products[1]?.packages === 10 && decimalInvoice.products[1]?.unit === "unit", "las unidades no se importaron enteras");
check(decimalInvoice.products[2]?.packages === 4 && decimalInvoice.products[2]?.unit === "package", "el paquete explícito no se importó");

const template = invoiceTemplateBytes();
writeFileSync(`${sampleDir}/plantilla-factura-inventario.xlsx`, template);
const templateXml = new TextDecoder().decode(template);
check(templateXml.includes('type="list"') && templateXml.includes('allowBlank="1"') && templateXml.includes('<formula1>"Paquete,Libra,Unidad"</formula1>'), "la plantilla no tiene la lista Paquete, Libra, Unidad");
check(templateXml.includes("Si la celda queda vacía, se interpreta como Paquete."), "la plantilla no indica los valores permitidos");
const templateBook = XLSX.read(template, { type: "array" });
check(templateBook.SheetNames[0] === "Factura" && templateBook.SheetNames.includes("Ejemplos"), `hojas de la plantilla: ${templateBook.SheetNames.join(", ")}`);
const templateRows = XLSX.utils.sheet_to_json<(string | number)[]>(templateBook.Sheets.Factura, { header: 1, defval: "" });
const templateHeaders = templateRows.find((row) => row.some((cell) => String(cell).trim().toLowerCase() === "producto")) ?? [];
check(templateHeaders.join(" | ") === "Orden | Producto | Costo unitario (C$) | Cantidad | Unidad de medida", `encabezados de la plantilla: ${templateHeaders.join(" | ")}`);
const exampleRows = XLSX.utils.sheet_to_json<(string | number)[]>(templateBook.Sheets.Ejemplos, { header: 1, defval: "" });
check(exampleRows.slice(1).map((row) => `${row[4]}:${row[3]}`).join(" | ") === "Paquete:20 | Libra:1.5 | Unidad:30", "la hoja de ejemplos no muestra las tres unidades");
const blankTemplate = parseInvoiceWorkbook(template.buffer.slice(template.byteOffset, template.byteOffset + template.byteLength) as ArrayBuffer);
check(blankTemplate.products.length === 0 && blankTemplate.issues.every((issue) => issue.message === "La factura no tiene productos."), `la indicación de la plantilla se importó como factura: ${blankTemplate.issues.map((issue) => issue.message).join("; ")}`);

const currentInvoice = parseInvoiceWorkbook(invoiceFile([
  ["Orden", "Producto", "Costo unitario (C$)", "Cantidad", "Unidad de medida"],
  ["0000101004", "Caja", 10, 4, "Paquete"],
  ["0000101004", "Azúcar", 10, 1.5, "Libra"],
  ["0000101004", "Pieza", 10, 8, "Unidad"],
  ["0000101004", "Sin unidad", 10, 5, ""],
]));
check(currentInvoice.issues.length === 0, `la factura nueva tuvo observaciones: ${currentInvoice.issues.map((issue) => issue.message).join("; ")}`);
check(currentInvoice.products[0]?.packages === 4 && currentInvoice.products[0]?.unit === "package" && currentInvoice.products[0]?.quantityMilli == null, "Paquete nuevo no se importó entero");
check(currentInvoice.products[1]?.quantityMilli === 1500 && currentInvoice.products[1]?.packages == null && currentInvoice.products[1]?.unit === "lb", "Libra decimal no se guardó en quantityMilli");
check(currentInvoice.products[2]?.packages === 8 && currentInvoice.products[2]?.unit === "unit" && currentInvoice.products[2]?.quantityMilli == null, "Unidad nueva no se importó entera");
check(currentInvoice.products[3]?.packages === 5 && currentInvoice.products[3]?.quantityMilli == null && currentInvoice.products[3]?.unit == null, "una unidad vacía no se interpretó como Paquete");
const rejected = parseInvoiceWorkbook(invoiceFile([
  ["Orden", "Producto", "Costo unitario (C$)", "Cantidad", "Unidad de medida"],
  ["0000101004", "Caja decimal", 10, 1.5, "Paquete"],
  ["0000101004", "Pieza decimal", 10, 1.5, "Unidad"],
]));
check(rejected.products.length === 0 && rejected.issues.length === 2, "Paquete y Unidad aceptaron decimales");

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("excel export ok");
console.log(sampleDir);
