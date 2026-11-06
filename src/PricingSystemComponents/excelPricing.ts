import { v4 as uuid } from "uuid";
import * as XLSX from "xlsx";
import { usablePackages } from "./fieldValidation";
import { resolveCommissionMethod } from "./pricingEngine";
import type { ComputedInventory, ImportPreview, PricingInventory, ProductInput } from "./types";
import { INVOICE_HEADERS, commissionMethodLabel } from "./types";

function cellText(value: unknown): string {
  if (value == null) return "";
  return String(value).trim();
}

function cellNumber(value: unknown): number | null {
  if (value == null || value === "") return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const normalized = String(value).replace(/C\$/gi, "").replace(/\s/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function headerIndex(headers: string[], expected: string): number {
  const target = expected.toLowerCase();
  return headers.findIndex((header) => header.trim().toLowerCase() === target);
}

export function parseInvoiceWorkbook(data: ArrayBuffer): ImportPreview {
  const book = XLSX.read(data, { type: "array" });
  const sheet = book.Sheets[book.SheetNames[0]];
  if (!sheet) {
    return {
      products: [],
      issues: [{ row: 0, level: "error", message: "El archivo no tiene hojas." }],
    };
  }
  const rows = XLSX.utils.sheet_to_json<(string | number | null)[]>(sheet, {
    header: 1,
    raw: true,
    defval: "",
  });
  const headerRow = rows.findIndex((row) =>
    row.some((cell) => cellText(cell).toLowerCase() === "producto"),
  );
  if (headerRow < 0) {
    return {
      products: [],
      issues: [
        {
          row: 1,
          level: "error",
          message: "No se encontró la columna Producto. Usa la plantilla oficial.",
        },
      ],
    };
  }
  const headers = rows[headerRow].map((cell) => cellText(cell));
  const columns = {
    order: headerIndex(headers, INVOICE_HEADERS[0]),
    name: headerIndex(headers, INVOICE_HEADERS[1]),
    cost: headerIndex(headers, INVOICE_HEADERS[2]),
    packages: headerIndex(headers, INVOICE_HEADERS[3]),
  };
  const missing = INVOICE_HEADERS.filter((_, index) => Object.values(columns)[index] < 0);
  if (missing.length) {
    return {
      products: [],
      issues: [
        {
          row: headerRow + 1,
          level: "error",
          message: `Faltan columnas: ${missing.join(", ")}.`,
        },
      ],
    };
  }

  const products: ProductInput[] = [];
  const issues: ImportPreview["issues"] = [];
  const seen = new Set<string>();

  rows.slice(headerRow + 1).forEach((row, offset) => {
    const excelRow = headerRow + offset + 2;
    const orderCode = cellText(row[columns.order]);
    const name = cellText(row[columns.name]);
    const costRaw = row[columns.cost];
    const packsRaw = row[columns.packages];
    const blank =
      !orderCode && !name && cellText(costRaw) === "" && cellText(packsRaw) === "";
    if (blank) return;
    if (!name) {
      issues.push({ row: excelRow, level: "error", message: "El producto está vacío." });
      return;
    }
    const cost = cellNumber(costRaw);
    const packages = cellNumber(packsRaw);
    if (cost == null || cost < 0) {
      issues.push({
        row: excelRow,
        level: "error",
        message: `${name}: el costo por paquete no es válido.`,
      });
      return;
    }
    const wholePackages = packages == null ? 0 : usablePackages(packages);
    if (packages == null || wholePackages <= 0) {
      issues.push({
        row: excelRow,
        level: "error",
        message: `${name}: la cantidad de paquetes debe ser un entero mayor que cero.`,
      });
      return;
    }
    const key = `${orderCode.toLowerCase()}|${name.toLowerCase()}`;
    if (seen.has(key)) {
      issues.push({
        row: excelRow,
        level: "warning",
        message: `${name}: está repetido en la misma orden. Se importará otra línea.`,
      });
    }
    seen.add(key);
    products.push({
      id: uuid(),
      orderCode,
      name,
      costPerPack: cost,
      packages: wholePackages,
      priceMethod: "MARGEN",
      manualPrice: null,
      targetMarginPercent: null,
      vendorSharePercent: null,
    });
  });

  if (!products.length && !issues.length) {
    issues.push({ row: 0, level: "error", message: "La factura no tiene productos." });
  }
  return { products, issues };
}

export function mergeImportedProducts(
  current: ProductInput[],
  incoming: ProductInput[],
): ProductInput[] {
  const next = current.map((product) => ({ ...product }));
  const indexByKey = new Map(
    next.map((product, index) => [
      `${product.orderCode.trim().toLowerCase()}|${product.name.trim().toLowerCase()}`,
      index,
    ]),
  );
  incoming.forEach((product) => {
    const key = `${product.orderCode.trim().toLowerCase()}|${product.name.trim().toLowerCase()}`;
    const existingIndex = indexByKey.get(key);
    if (existingIndex == null) {
      indexByKey.set(key, next.length);
      next.push(product);
      return;
    }
    const existing = next[existingIndex];
    next[existingIndex] = {
      ...existing,
      orderCode: product.orderCode,
      costPerPack: product.costPerPack,
      packages: product.packages,
    };
  });
  return next;
}

export function buildInvoiceTemplate(): Blob {
  const sheet = XLSX.utils.aoa_to_sheet([
    [...INVOICE_HEADERS],
    ["0000101004", "Producto de ejemplo", 67.5, 20],
  ]);
  sheet["!cols"] = [{ wch: 16 }, { wch: 36 }, { wch: 28 }, { wch: 24 }];
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, "Factura");
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function downloadInvoiceTemplate() {
  downloadBlob(buildInvoiceTemplate(), "plantilla-factura-inventario.xlsx");
}

export function downloadInventoryWorkbook(
  inventory: PricingInventory,
  computed: ComputedInventory,
) {
  const settings = inventory.settings;
  const method = resolveCommissionMethod(settings.commissionMethod);
  const method3 = method === "3";
  const poolLabel = method3
    ? "Base para comisión"
    : "Utilidad del inversionista antes de logística";
  const config = XLSX.utils.aoa_to_sheet([
    ["CONFIGURACIÓN DEL MODELO ECONÓMICO"],
    ["Parámetro", "Valor", "Uso"],
    [
      "Gastos logísticos de la OM (C$)",
      settings.logisticsCost,
      "Monto total de transporte, carga, almacenamiento u otros gastos logísticos de esta OM.",
    ],
    [
      "Participación del vendedor (%)",
      settings.vendorSharePercent,
      "Porcentaje aplicado sobre la base del método elegido. Un producto puede indicar otro porcentaje.",
    ],
    [
      "Sucursal / mercado",
      settings.branchLabel,
      "Este inventario modela una sola sucursal.",
    ],
    [
      "Método de prorrateo",
      "Proporcional al subtotal de compra",
      "Gasto asignado = gastos logísticos × subtotal del producto ÷ subtotal general de compra.",
    ],
    [
      "Método de distribución de ganancias",
      commissionMethodLabel(method),
      "Cada inventario guarda su propio método. Si el dato no existe, se usa la opción 2.",
    ],
    [
      "Regla de distribución",
      method3 ? "Comisión sobre utilidad después de logística" : "Comisión sobre utilidad bruta",
      method3
        ? "Base = utilidad bruta − logística asignada. Comisión = base × porcentaje. Si la base no es positiva, la comisión es cero."
        : "Comisión = utilidad bruta × porcentaje. Inversionista antes de logística = utilidad bruta − comisión.",
    ],
    [
      "Utilidad neta del inversionista",
      method3
        ? "Base para comisión − comisión del vendedor"
        : "Utilidad bruta − gasto logístico asignado − utilidad vendedor",
      method3
        ? "La logística ya está restada en la base."
        : "Se conserva la fórmula de uNeta de la opción 2.",
    ],
    [
      "Margen objetivo sobre costo total (%)",
      settings.targetMarginPercent,
      "Se aplica al costo por paquete más el gasto logístico asignado por paquete.",
    ],
    [
      "Redondeo del precio de venta",
      "Redondeo hacia arriba",
      "Siempre hacia arriba al siguiente córdoba entero.",
    ],
  ]);

  const products = XLSX.utils.aoa_to_sheet([
    [
      "Orden",
      "Producto",
      "Precio costo / paquete (C$)",
      "Cantidad de paquetes",
      "Subtotal al costo (C$)",
      "Precio automático / paquete (C$)",
      "Precio manual / paquete (C$) - opcional",
      "Precio de venta aplicado / paquete (C$)",
      "Margen real aplicado sobre costo + logística (%)",
      "Total de venta (C$)",
      "Ganancia bruta total (C$)",
      "Ganancia bruta por paquete (C$)",
      "Margen bruto del sistema (%)",
      "Gasto logístico total asignado (C$)",
      "Gasto logístico por paquete (C$)",
      "Comisión vendedor manual por producto (%) - opcional",
      "Comisión vendedor aplicada (%)",
      "Ganancia total del vendedor (C$)",
      "Ganancia del vendedor por paquete (C$)",
      method3 ? "Base para comisión (C$)" : "Ganancia total del inversionista antes de logística (C$)",
      method3
        ? "Base para comisión por paquete (C$)"
        : "Ganancia del inversionista por paquete antes de logística (C$)",
      "Ganancia neta total del inversionista (C$)",
      "Ganancia neta del inversionista por paquete (C$)",
    ],
    ...computed.lines.map((line) => {
      const source = inventory.products.find((product) => product.id === line.id);
      return [
        line.orderCode,
        line.name,
        line.costPerPack,
        line.packages,
        line.purchaseSubtotal,
        line.automaticPrice,
        source?.manualPrice ?? "",
        line.appliedPrice,
        line.realMarginPercent,
        line.salesTotal,
        line.grossProfit,
        line.grossProfitPerPack,
        line.systemGrossMarginPercent,
        line.logisticsAllocated,
        line.logisticsPerPack,
        source?.vendorSharePercent ?? "",
        line.vendorSharePercent,
        line.vendorProfit,
        line.vendorProfitPerPack,
        method3 ? line.commissionBase : line.investorBeforeLogistics,
        method3 ? line.commissionBasePerPack : line.investorBeforeLogisticsPerPack,
        line.investorNet,
        line.investorNetPerPack,
      ];
    }),
  ]);

  const totals = computed.totals;
  const summary = XLSX.utils.aoa_to_sheet([
    ["RESUMEN ECONÓMICO DE LA OM"],
    ["Método en uso", commissionMethodLabel(method)],
    ["Indicador", "Resultado"],
    ["Renglones de productos", totals.productCount],
    ["Paquetes totales", totals.packages],
    ["Subtotal de compra", totals.purchaseSubtotal],
    ["Margen objetivo de fijación de precio", totals.targetMarginPercent],
    ["Comisión del vendedor", totals.vendorSharePercent],
    ["Gastos logísticos", totals.logisticsCost],
    ["Costo total con logística", totals.costWithLogistics],
    ["Total de venta proyectado", totals.projectedSales],
    ["Utilidad bruta global (uBrutaGlobal)", totals.grossProfit],
    ["Utilidad del vendedor", totals.vendorProfit],
    [poolLabel, method3 ? totals.commissionBase : totals.investorBeforeLogistics],
    ["Utilidad neta del inversionista (uNeta)", totals.investorNet],
  ]);

  const prices = XLSX.utils.aoa_to_sheet([
    ["PRECIOS DE COSTO Y VENTA POR PRODUCTO"],
    ["Método en uso", commissionMethodLabel(method)],
    [
      "Producto",
      "Cantidad de paquetes",
      "Costo proveedor / paquete (C$)",
      "Logística / paquete (C$)",
      "Precio Costo",
      "Costo + logística total (C$)",
      "Método",
      "Precio manual / paquete (C$)",
      "Margen objetivo (%)",
      "Precio venta",
      "Margen real (%)",
      "Venta total (C$)",
    ],
    ...computed.lines.map((line) => [
      line.name,
      line.packages,
      line.costPerPack,
      line.logisticsPerPack,
      line.costPlusLogisticsPerPack,
      line.costPlusLogisticsPerPack * line.packages,
      line.priceMethod,
      line.manualPrice || "",
      line.targetMarginPercent,
      line.appliedPrice,
      line.realMarginPercent,
      line.salesTotal,
    ]),
  ]);

  const utilities = XLSX.utils.aoa_to_sheet([
    ["UTILIDADES POR PRODUCTO"],
    ["Método en uso", commissionMethodLabel(method)],
    [
      "Producto",
      "Cantidad de paquetes",
      "Base para comisión / paquete (C$)",
      "Base para comisión (C$)",
      "Ganancia vendedor / paquete (C$)",
      "Ganancia total vendedor (C$)",
      "Ganancia neta inversionista / paquete (C$)",
      "Ganancia neta total inversionista (C$)",
    ],
    ...computed.lines.map((line) => [
      line.name,
      line.packages,
      line.commissionBasePerPack,
      line.commissionBase,
      line.vendorProfitPerPack,
      line.vendorProfit,
      line.investorNetPerPack,
      line.investorNet,
    ]),
  ]);

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, config, "Configuración");
  XLSX.utils.book_append_sheet(book, products, "OM - Productos");
  XLSX.utils.book_append_sheet(book, summary, "Resumen");
  XLSX.utils.book_append_sheet(book, prices, "Precios");
  XLSX.utils.book_append_sheet(book, utilities, "Utilidades");
  const bytes = XLSX.write(book, { bookType: "xlsx", type: "array" });
  const safeName = inventory.name.replace(/[^\w\-]+/g, "_").slice(0, 40) || "inventario";
  downloadBlob(
    new Blob([bytes], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    }),
    `${safeName}-resultados.xlsx`,
  );
}
