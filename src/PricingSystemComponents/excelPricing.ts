import { v4 as uuid } from "uuid";
import * as XLSX from "xlsx";
import { usablePackages } from "./fieldValidation";
import type { ImportPreview, ProductInput } from "./types";
import { INVOICE_HEADERS } from "./types";

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

export { downloadInventoryWorkbook } from "./excelExport";
