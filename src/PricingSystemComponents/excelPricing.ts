import { v4 as uuid } from "uuid";
import * as XLSX from "xlsx";
import { usablePackages } from "./fieldValidation";
import { milliFromAmount, storedQuantity } from "./quantity";
import type { ImportPreview, MeasureUnit, ProductInput } from "./types";
import { INVOICE_HEADERS } from "./types";

const UNIT_HEADER = "Unidad de medida";
const TEMPLATE_HEADERS = ["Orden", "Producto", "Costo unitario (C$)", "Cantidad", UNIT_HEADER] as const;
const LEGACY_COST = INVOICE_HEADERS[2];
const LEGACY_QUANTITY = INVOICE_HEADERS[3];

function measureFromLabel(value: string): MeasureUnit | "missing" | "invalid" {
  const text = value.trim().toLowerCase();
  if (!text) return "missing";
  if (text === "paquete" || text === "paquetes" || text === "package") return "package";
  if (text === "libra" || text === "libra (lb)" || text === "libras" || text === "lb") return "lb";
  if (text === "unidad" || text === "unidades" || text === "unit") return "unit";
  return "invalid";
}

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

function headerIndex(headers: string[], ...names: string[]): number {
  const expected = new Set(names.map((name) => name.toLowerCase()));
  return headers.findIndex((header) => expected.has(header.trim().toLowerCase()));
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
    order: headerIndex(headers, TEMPLATE_HEADERS[0]),
    name: headerIndex(headers, TEMPLATE_HEADERS[1]),
    cost: headerIndex(headers, TEMPLATE_HEADERS[2], LEGACY_COST),
    packages: headerIndex(headers, TEMPLATE_HEADERS[3], LEGACY_QUANTITY),
    unit: headerIndex(headers, UNIT_HEADER),
  };
  const missing = TEMPLATE_HEADERS.slice(0, 4).filter((_, index) => Object.values(columns)[index] < 0);
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
    const chosen = columns.unit < 0 ? "missing" : measureFromLabel(cellText(row[columns.unit]));
    if (chosen === "invalid") {
      issues.push({
        row: excelRow,
        level: "error",
        message: `${name}: la unidad de medida no es válida.`,
      });
      return;
    }
    const milli = chosen === "lb" ? milliFromAmount(packages ?? Number.NaN) : null;
    const quantity = chosen === "lb" && milli != null && milli > 0 ? storedQuantity("lb", milli) : null;
    const wholePackages = packages == null ? 0 : usablePackages(packages);
    if (chosen === "lb" ? !quantity : packages == null || wholePackages <= 0) {
      issues.push({
        row: excelRow,
        level: "error",
        message: chosen === "lb"
          ? `${name}: la cantidad de libras admite hasta tres decimales.`
          : chosen === "unit"
            ? `${name}: la cantidad de unidades debe ser un entero mayor que cero.`
            : `${name}: la cantidad de paquetes debe ser un entero mayor que cero.`,
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
      ...(chosen === "lb" && quantity ? quantity : { packages: wholePackages }),
      ...(chosen === "package" || chosen === "unit" || chosen === "lb" ? { unit: chosen === "lb" ? "lb" as const : chosen } : {}),
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
    const merged: ProductInput = {
      ...existing,
      orderCode: product.orderCode,
      costPerPack: product.costPerPack,
    };
    delete merged.packages;
    delete merged.quantityMilli;
    delete merged.unit;
    if (product.unit) merged.unit = product.unit;
    if (product.quantityMilli != null) merged.quantityMilli = product.quantityMilli;
    else merged.packages = product.packages;
    next[existingIndex] = merged;
  });
  return next;
}

const UNIT_LIST = '"Paquete,Libra,Unidad"';
const TEMPLATE_HINT = "Unidad de medida: elige Paquete, Libra o Unidad en la lista. Si la celda queda vacía, se interpreta como Paquete. Paquete y Unidad aceptan solo cantidades enteras. Libra admite hasta tres decimales.";

function xmlText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineCell(ref: string, value: string, style?: number): string {
  const styled = style == null ? "" : ` s="${style}"`;
  return `<c r="${ref}" t="inlineStr"${styled}><is><t>${xmlText(value)}</t></is></c>`;
}

function numberCell(ref: string, value: number): string {
  return `<c r="${ref}"><v>${value}</v></c>`;
}

/** SheetJS Community no escribe validación de datos; el xlsx se arma sin comprimir para incluir la lista. */
export function invoiceTemplateBytes(): Uint8Array {
  const invoice = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:E2"/>
  <sheetViews><sheetView workbookViewId="0"><selection activeCell="A3" sqref="A3"/></sheetView></sheetViews>
  <cols>
    <col min="1" max="1" width="18" customWidth="1"/>
    <col min="2" max="2" width="36" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="22" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1" ht="48" customHeight="1">${inlineCell("A1", TEMPLATE_HINT, 1)}</row>
    <row r="2">${TEMPLATE_HEADERS.map((header, index) => inlineCell(`${"ABCDE"[index]}2`, header)).join("")}</row>
  </sheetData>
  <mergeCells count="1"><mergeCell ref="A1:E1"/></mergeCells>
  <dataValidations count="1">
    <dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" promptTitle="Unidad de medida" prompt="Paquete, Libra o Unidad. Vacío = Paquete." errorTitle="Unidad de medida" error="Usa Paquete, Libra o Unidad." sqref="E3:E500">
      <formula1>${UNIT_LIST}</formula1>
    </dataValidation>
  </dataValidations>
</worksheet>`;
  const examples = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <dimension ref="A1:E4"/>
  <cols>
    <col min="1" max="1" width="18" customWidth="1"/>
    <col min="2" max="2" width="36" customWidth="1"/>
    <col min="3" max="3" width="22" customWidth="1"/>
    <col min="4" max="4" width="14" customWidth="1"/>
    <col min="5" max="5" width="22" customWidth="1"/>
  </cols>
  <sheetData>
    <row r="1">${TEMPLATE_HEADERS.map((header, index) => inlineCell(`${"ABCDE"[index]}1`, header)).join("")}</row>
    <row r="2">${inlineCell("A2", "0000101004")}${inlineCell("B2", "Ejemplo en paquete")}${numberCell("C2", 67.5)}${numberCell("D2", 20)}${inlineCell("E2", "Paquete")}</row>
    <row r="3">${inlineCell("A3", "0000101004")}${inlineCell("B3", "Ejemplo en libra")}${numberCell("C3", 10)}${numberCell("D3", 1.5)}${inlineCell("E3", "Libra")}</row>
    <row r="4">${inlineCell("A4", "0000101004")}${inlineCell("B4", "Ejemplo en unidad")}${numberCell("C4", 8)}${numberCell("D4", 30)}${inlineCell("E4", "Unidad")}</row>
  </sheetData>
  <dataValidations count="1">
    <dataValidation type="list" allowBlank="1" showInputMessage="1" showErrorMessage="1" sqref="E2:E4">
      <formula1>${UNIT_LIST}</formula1>
    </dataValidation>
  </dataValidations>
</worksheet>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="center"/></xf>
  </cellXfs>
</styleSheet>`;
  return storeZip([
    { name: "[Content_Types].xml", data: textBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`) },
    { name: "_rels/.rels", data: textBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`) },
    { name: "xl/workbook.xml", data: textBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>
    <sheet name="Factura" sheetId="1" r:id="rId1"/>
    <sheet name="Ejemplos" sheetId="2" r:id="rId2"/>
  </sheets>
</workbook>`) },
    { name: "xl/_rels/workbook.xml.rels", data: textBytes(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`) },
    { name: "xl/styles.xml", data: textBytes(styles) },
    { name: "xl/worksheets/sheet1.xml", data: textBytes(invoice) },
    { name: "xl/worksheets/sheet2.xml", data: textBytes(examples) },
  ]);
}

export function buildInvoiceTemplate(): Blob {
  const bytes = invoiceTemplateBytes();
  return new Blob([bytes], {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

const CRC_TABLE = new Uint32Array(256).map((_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function storeZip(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const locals: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;
  for (const file of files) {
    const name = textBytes(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint32(14, crc, true);
    view.setUint32(18, file.data.length, true);
    view.setUint32(22, file.data.length, true);
    view.setUint16(26, name.length, true);
    local.set(name, 30);
    locals.push(local, file.data);
    const header = new Uint8Array(46 + name.length);
    const directory = new DataView(header.buffer);
    directory.setUint32(0, 0x02014b50, true);
    directory.setUint16(4, 20, true);
    directory.setUint16(6, 20, true);
    directory.setUint32(16, crc, true);
    directory.setUint32(20, file.data.length, true);
    directory.setUint32(24, file.data.length, true);
    directory.setUint16(28, name.length, true);
    directory.setUint32(42, offset, true);
    header.set(name, 46);
    central.push(header);
    offset += local.length + file.data.length;
  }
  const centralSize = central.reduce((sum, part) => sum + part.length, 0);
  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, files.length, true);
  endView.setUint16(10, files.length, true);
  endView.setUint32(12, centralSize, true);
  endView.setUint32(16, offset, true);
  const output = new Uint8Array(offset + centralSize + end.length);
  let cursor = 0;
  for (const part of [...locals, ...central, end]) {
    output.set(part, cursor);
    cursor += part.length;
  }
  return output;
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
