import * as XLSX from "xlsx";
import type { ComputedInventory, ComputedLine, PriceMethod, PricingInventory, ProductInput } from "./types";
import { commissionMethodLabel } from "./types";
import { resolveCommissionMethod } from "./pricingEngine";

const MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

type CellKind = "text" | "money" | "percent" | "qty" | "date";
type CellValue = string | number | Date | null;

interface TableColumn {
  header: string;
  width: number;
  kind: CellKind;
}

export interface PriceCatalogEntry {
  inventoryName: string;
  line: ComputedLine;
  manualPrice: number | null;
  productMargin: number | null;
}

const PRICE_COLUMNS: TableColumn[] = [
  { header: "Producto", width: 28, kind: "text" },
  { header: "Paquetes", width: 12, kind: "qty" },
  { header: "Costo por paquete", width: 18, kind: "money" },
  { header: "Logística por paquete", width: 22, kind: "money" },
  { header: "Precio de costo", width: 16, kind: "money" },
  { header: "Costo + logística total", width: 24, kind: "money" },
  { header: "Método de cálculo", width: 20, kind: "text" },
  { header: "Precio manual", width: 16, kind: "money" },
  { header: "Margen objetivo", width: 16, kind: "percent" },
  { header: "Precio de venta", width: 16, kind: "money" },
  { header: "Margen real", width: 14, kind: "percent" },
  { header: "Venta total", width: 16, kind: "money" },
];

function excelCell(kind: CellKind, value: CellValue): XLSX.CellObject | null {
  if (value == null || value === "") return null;
  if (kind === "text") return { t: "s", v: String(value) };
  if (kind === "date") {
    const date = value instanceof Date ? value : new Date(String(value));
    if (Number.isNaN(date.getTime())) return { t: "s", v: String(value) };
    return { t: "d", v: date, z: "yyyy-mm-dd hh:mm" };
  }
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number)) return null;
  if (kind === "money") return { t: "n", v: number, z: '"C$"#,##0.00' };
  if (kind === "percent") return { t: "n", v: number / 100, z: "0.00%" };
  return { t: "n", v: number, z: Number.isInteger(number) ? "#,##0" : "#,##0.###" };
}

function put(sheet: XLSX.WorkSheet, row: number, col: number, cell: XLSX.CellObject | null) {
  if (!cell) return;
  sheet[XLSX.utils.encode_cell({ r: row, c: col })] = cell;
}

function finishSheet(
  sheet: XLSX.WorkSheet,
  lastRow: number,
  columns: number,
  widths: number[],
  filter?: { from: number; to: number },
) {
  sheet["!ref"] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: Math.max(lastRow, 0), c: Math.max(columns - 1, 0) },
  });
  sheet["!cols"] = widths.map((wch) => ({ wch }));
  if (filter && filter.to >= filter.from) {
    sheet["!autofilter"] = {
      ref: XLSX.utils.encode_range({
        s: { r: filter.from, c: 0 },
        e: { r: filter.to, c: columns - 1 },
      }),
    };
  }
}

function detailSheet(
  headers: string[],
  rows: Array<{ label: string; value: CellValue; kind: CellKind; note?: string }>,
  widths: number[],
): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  headers.forEach((header, col) => put(sheet, 0, col, { t: "s", v: header }));
  rows.forEach((row, index) => {
    put(sheet, index + 1, 0, { t: "s", v: row.label });
    put(sheet, index + 1, 1, excelCell(row.kind, row.value));
    if (headers.length > 2) put(sheet, index + 1, 2, row.note ? { t: "s", v: row.note } : null);
  });
  finishSheet(sheet, rows.length, headers.length, widths, rows.length ? { from: 0, to: rows.length } : undefined);
  return sheet;
}

function tableSheet(columns: TableColumn[], rows: CellValue[][]): XLSX.WorkSheet {
  const sheet: XLSX.WorkSheet = {};
  columns.forEach((column, col) => put(sheet, 0, col, { t: "s", v: column.header }));
  rows.forEach((row, index) => {
    columns.forEach((column, col) => put(sheet, index + 1, col, excelCell(column.kind, row[col] ?? null)));
  });
  finishSheet(
    sheet,
    rows.length,
    columns.length,
    columns.map((column) => column.width),
    rows.length ? { from: 0, to: rows.length } : undefined,
  );
  return sheet;
}

function methodLabel(method: PriceMethod): string {
  return method === "PRECIO" ? "Precio manual" : "Margen objetivo";
}

function priceValues(entry: PriceCatalogEntry): CellValue[] {
  const line = entry.line;
  const manual = entry.manualPrice != null && entry.manualPrice > 0 ? entry.manualPrice : null;
  return [
    line.name,
    line.packages,
    line.costPerPack,
    line.logisticsPerPack,
    line.costPlusLogisticsPerPack,
    line.purchaseSubtotal + line.logisticsAllocated,
    methodLabel(line.priceMethod),
    manual,
    line.targetMarginPercent,
    line.appliedPrice,
    line.realMarginPercent,
    line.salesTotal,
  ];
}

function safeFilePart(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\w\-]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_|_$/g, "")
    .slice(0, 48);
}

function uniqueOrders(products: ProductInput[]): string[] {
  return [...new Set(products.map((product) => product.orderCode.trim()).filter(Boolean))];
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function downloadWorkbook(book: XLSX.WorkBook, filename: string) {
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
  downloadBlob(new Blob([bytes], { type: MIME }), filename);
}

export function priceCatalogFileName(date = new Date()): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `Precios_Gestion_Comercial_${date.getFullYear()}-${month}-${day}.xlsx`;
}

export function buildPriceCatalogWorkbook(entries: PriceCatalogEntry[]): XLSX.WorkBook {
  if (!entries.length) throw new Error("No hay productos para exportar.");
  const columns: TableColumn[] = [
    { header: "Inventario", width: 28, kind: "text" },
    { header: "Factura", width: 18, kind: "text" },
    { header: "ID del producto", width: 28, kind: "text" },
    ...PRICE_COLUMNS,
    { header: "Origen del margen", width: 18, kind: "text" },
  ];
  const rows = entries.map((entry) => [
    entry.inventoryName,
    entry.line.orderCode,
    entry.line.id,
    ...priceValues(entry),
    entry.productMargin == null ? "General" : "Producto",
  ]);
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, tableSheet(columns, rows), "Precios");
  return book;
}

export function downloadPriceCatalog(entries: PriceCatalogEntry[], date = new Date()): string {
  const filename = priceCatalogFileName(date);
  downloadWorkbook(buildPriceCatalogWorkbook(entries), filename);
  return filename;
}

export function inventoryWorkbookName(inventory: PricingInventory): string {
  const name = safeFilePart(inventory.name) || "sin_nombre";
  const orders = uniqueOrders(inventory.products);
  const invoice = orders.length === 1 ? `_${safeFilePart(orders[0])}` : "";
  return `Inventario_${name}${invoice}.xlsx`;
}

function inventoryDataSheet(inventory: PricingInventory): XLSX.WorkSheet {
  const orders = uniqueOrders(inventory.products);
  return detailSheet(
    ["Campo", "Valor"],
    [
      { label: "Nombre", value: inventory.name, kind: "text" },
      { label: "ID del inventario", value: inventory.id, kind: "text" },
      { label: "Correo del propietario", value: inventory.ownerEmail, kind: "text" },
      { label: "ID del propietario", value: inventory.ownerUid, kind: "text" },
      { label: "Facturas u órdenes", value: orders.length ? orders.join(", ") : null, kind: "text" },
      { label: "Fecha de creación", value: inventory.createdAt, kind: "date" },
      { label: "Última actualización", value: inventory.updatedAt, kind: "date" },
    ],
    [28, 42],
  );
}

function configurationSheet(inventory: PricingInventory): XLSX.WorkSheet {
  const settings = inventory.settings;
  const method = resolveCommissionMethod(settings.commissionMethod);
  const method3 = method === "3";
  return detailSheet(
    ["Parámetro", "Valor", "Uso"],
    [
      {
        label: "Gastos logísticos",
        value: settings.logisticsCost,
        kind: "money",
        note: "Monto total de transporte, carga, almacenamiento u otros gastos logísticos de esta OM.",
      },
      {
        label: "Participación del vendedor",
        value: settings.vendorSharePercent,
        kind: "percent",
        note: "Porcentaje aplicado sobre la base del método elegido. Un producto puede indicar otro porcentaje.",
      },
      {
        label: "Margen objetivo",
        value: settings.targetMarginPercent,
        kind: "percent",
        note: "Se aplica al costo por paquete más el gasto logístico asignado por paquete.",
      },
      {
        label: "Sucursal o mercado",
        value: settings.branchLabel,
        kind: "text",
        note: "Este inventario modela una sola sucursal.",
      },
      {
        label: "Método de comisión",
        value: method,
        kind: "text",
        note: "Cada inventario guarda su propio método. Si el dato no existe, se usa la opción 2.",
      },
      {
        label: "Nombre del método",
        value: commissionMethodLabel(method),
        kind: "text",
        note: method3
          ? "Base = utilidad bruta − logística asignada. Comisión = base × porcentaje. Si la base no es positiva, la comisión es cero."
          : "Comisión = utilidad bruta × porcentaje. Inversionista antes de logística = utilidad bruta − comisión.",
      },
      {
        label: "Método de prorrateo",
        value: "Proporcional al subtotal de compra",
        kind: "text",
        note: "Gasto asignado = gastos logísticos × subtotal del producto ÷ subtotal general de compra.",
      },
      {
        label: "Utilidad neta del inversionista",
        value: method3
          ? "Base para comisión − comisión del vendedor"
          : "Utilidad bruta − gasto logístico asignado − utilidad vendedor",
        kind: "text",
        note: method3 ? "La logística ya está restada en la base." : "Se conserva la fórmula de uNeta de la opción 2.",
      },
      {
        label: "Redondeo del precio de venta",
        value: "Redondeo hacia arriba",
        kind: "text",
        note: "Siempre hacia arriba al siguiente córdoba entero.",
      },
    ],
    [36, 42, 78],
  );
}

function productsSheet(products: ProductInput[]): XLSX.WorkSheet {
  const columns: TableColumn[] = [
    { header: "ID del producto", width: 28, kind: "text" },
    { header: "Orden o factura", width: 20, kind: "text" },
    { header: "Producto", width: 28, kind: "text" },
    { header: "Costo por paquete", width: 18, kind: "money" },
    { header: "Paquetes comprados", width: 20, kind: "qty" },
    { header: "Método de cálculo", width: 20, kind: "text" },
    { header: "Precio manual", width: 16, kind: "money" },
    { header: "Margen objetivo", width: 18, kind: "percent" },
    { header: "Comisión del producto", width: 22, kind: "percent" },
  ];
  return tableSheet(
    columns,
    products.map((product) => [
      product.id,
      product.orderCode,
      product.name,
      product.costPerPack,
      product.packages,
      methodLabel(product.priceMethod),
      product.manualPrice != null && product.manualPrice > 0 ? product.manualPrice : null,
      product.targetMarginPercent,
      product.vendorSharePercent,
    ]),
  );
}

function pricesSheet(inventory: PricingInventory, computed: ComputedInventory): XLSX.WorkSheet {
  const byId = new Map(inventory.products.map((product) => [product.id, product]));
  return tableSheet(
    [...PRICE_COLUMNS, { header: "ID del producto", width: 28, kind: "text" }, { header: "Factura", width: 18, kind: "text" }, { header: "Origen del margen", width: 18, kind: "text" }],
    computed.lines.map((line) => {
      const product = byId.get(line.id);
      return [
        ...priceValues({
          inventoryName: inventory.name,
          line,
          manualPrice: product?.manualPrice ?? null,
          productMargin: product?.targetMarginPercent ?? null,
        }),
        line.id,
        line.orderCode,
        product?.targetMarginPercent == null ? "General" : "Producto",
      ];
    }),
  );
}

function summarySheet(inventory: PricingInventory, computed: ComputedInventory): XLSX.WorkSheet {
  const totals = computed.totals;
  const method3 = totals.commissionMethod === "3";
  const poolLabel = method3 ? "Base para comisión" : "Inversionista antes de logística";
  const poolValue = method3 ? totals.commissionBase : totals.investorBeforeLogistics;
  const latest = inventory.history[inventory.history.length - 1];
  const rows: Array<{ label: string; value: CellValue; kind: CellKind }> = [
    { label: "Productos", value: totals.productCount, kind: "qty" },
    { label: "Paquetes", value: totals.packages, kind: "qty" },
    { label: "Subtotal de compra", value: totals.purchaseSubtotal, kind: "money" },
    { label: "Gastos logísticos", value: totals.logisticsCost, kind: "money" },
    { label: "Costo con logística", value: totals.costWithLogistics, kind: "money" },
    { label: "Venta proyectada", value: totals.projectedSales, kind: "money" },
    { label: "Utilidad bruta", value: totals.grossProfit, kind: "money" },
    { label: "Comisión del vendedor", value: totals.vendorProfit, kind: "money" },
    { label: "Participación del vendedor", value: totals.vendorSharePercent, kind: "percent" },
    { label: poolLabel, value: poolValue, kind: "money" },
    { label: "Utilidad neta", value: totals.investorNet, kind: "money" },
    { label: "Ganancia neta del inversionista", value: totals.investorNet, kind: "money" },
    { label: "Margen objetivo", value: totals.targetMarginPercent, kind: "percent" },
    { label: "Método en uso", value: commissionMethodLabel(totals.commissionMethod), kind: "text" },
    { label: "Ganancia Bruta Total", value: totals.grossProfit, kind: "money" },
    { label: "Ganancia del vendedor", value: totals.vendorProfit, kind: "money" },
  ];
  if (latest) {
    rows.push({ label: "Utilidad neta del último guardado", value: latest.investorNet, kind: "money" });
  }
  return detailSheet(["Indicador", "Valor"], rows, [42, 28]);
}

function utilitiesSheet(inventory: PricingInventory, computed: ComputedInventory): XLSX.WorkSheet {
  const totals = computed.totals;
  const method3 = totals.commissionMethod === "3";
  const poolLabel = method3 ? "Base para comisión" : "Inversionista antes de logística";
  const poolValue = method3 ? totals.commissionBase : totals.investorBeforeLogistics;
  const intro = [
    { label: "Método en uso", value: commissionMethodLabel(totals.commissionMethod), kind: "text" as const },
    { label: "Vendedor", value: totals.vendorProfit, kind: "money" as const },
    { label: "Comisión general", value: totals.vendorSharePercent, kind: "percent" as const },
    { label: poolLabel, value: poolValue, kind: "money" as const },
    { label: "Inversionista neto", value: totals.investorNet, kind: "money" as const },
  ];
  const columns: TableColumn[] = [
    { header: "Producto", width: 28, kind: "text" },
    { header: "Paquetes", width: 12, kind: "qty" },
    { header: "Comisión", width: 14, kind: "percent" },
    { header: "Comisión aplicada", width: 18, kind: "percent" },
    { header: "Base / paq.", width: 16, kind: "money" },
    { header: "Base", width: 16, kind: "money" },
    { header: "Vendedor / paq.", width: 18, kind: "money" },
    { header: "Vendedor total", width: 16, kind: "money" },
    { header: "Inversionista neto / paq.", width: 26, kind: "money" },
    { header: "Inversionista neto", width: 20, kind: "money" },
  ];
  const sheet = detailSheet(["Campo", "Valor"], intro, columns.map((column) => column.width));
  const headerRow = intro.length + 2;
  const byId = new Map(inventory.products.map((product) => [product.id, product]));
  columns.forEach((column, col) => put(sheet, headerRow, col, { t: "s", v: column.header }));
  computed.lines.forEach((line, index) => {
    const product = byId.get(line.id);
    const values: CellValue[] = [
      line.name,
      line.packages,
      product?.vendorSharePercent ?? null,
      line.vendorSharePercent,
      line.commissionBasePerPack,
      line.commissionBase,
      line.vendorProfitPerPack,
      line.vendorProfit,
      line.investorNetPerPack,
      line.investorNet,
    ];
    columns.forEach((column, col) => put(sheet, headerRow + 1 + index, col, excelCell(column.kind, values[col] ?? null)));
  });
  const last = headerRow + computed.lines.length;
  finishSheet(sheet, last, columns.length, columns.map((column) => column.width), {
    from: headerRow,
    to: last,
  });
  return sheet;
}

export function buildInventoryWorkbook(inventory: PricingInventory, computed: ComputedInventory): XLSX.WorkBook {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, inventoryDataSheet(inventory), "Datos del inventario");
  XLSX.utils.book_append_sheet(book, configurationSheet(inventory), "Configuración");
  if (inventory.products.length) {
    XLSX.utils.book_append_sheet(book, productsSheet(inventory.products), "OM - Productos");
  }
  if (computed.lines.length) {
    XLSX.utils.book_append_sheet(book, pricesSheet(inventory, computed), "Precios");
  }
  XLSX.utils.book_append_sheet(book, summarySheet(inventory, computed), "Resumen");
  if (computed.lines.length) {
    XLSX.utils.book_append_sheet(book, utilitiesSheet(inventory, computed), "Utilidades");
  }
  return book;
}

export function downloadInventoryWorkbook(inventory: PricingInventory, computed: ComputedInventory): string {
  const filename = inventoryWorkbookName(inventory);
  downloadWorkbook(buildInventoryWorkbook(inventory, computed), filename);
  return filename;
}
