import jsPDF from "jspdf";
import { fromCents, toCents } from "./commissionCommit";
import { dateTimeLabel, money, qty } from "./format";
import type { PricingSale, SaleLineSnapshot } from "./saleCommit";

/** Explica la diferencia de redondeo sin cambiar el total guardado en la venta. */
export function vendorCommissionNote(total: number, lineVendorProfits: number[]): string | null {
  const normalized = fromCents(lineVendorProfits.reduce((sum, value) => sum + toCents(value), 0));
  if (toCents(total) === toCents(normalized)) return null;
  return `La comisión para pagos es ${money(normalized)}, redondeada por línea. El comprobante conserva ${money(total)}.`;
}

export function voucherPrice(value: number): string {
  return money(value, Number.isInteger(value) ? 0 : 2);
}

/** El voucher definitivo existe solo cuando el registro devolvió la venta. */
export function voucherAfterAttempt(
  outcome: { sale: PricingSale } | { error: string },
): PricingSale | null {
  if ("error" in outcome) return null;
  return outcome.sale;
}

function fill(doc: jsPDF, color: [number, number, number]) {
  doc.setFillColor(color[0], color[1], color[2]);
}

function panel(doc: jsPDF, x: number, y: number, width: number, height: number, color: [number, number, number]) {
  fill(doc, color);
  doc.roundedRect(x, y, width, height, 2.5, 2.5, "F");
}

function room(doc: jsPDF, y: number, needed: number): number {
  if (y + needed <= 284) return y;
  doc.addPage();
  return 16;
}

function clip(doc: jsPDF, text: string, maxWidth: number): string {
  if (doc.getTextWidth(text) <= maxWidth) return text;
  let cut = text;
  while (cut.length > 1 && doc.getTextWidth(`${cut}…`) > maxWidth) cut = cut.slice(0, -1);
  return `${cut}…`;
}

function drawLine(doc: jsPDF, line: SaleLineSnapshot, y: number): number {
  const next = room(doc, y, 40);
  panel(doc, 14, next, 182, 36, [248, 249, 251]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.setTextColor(26, 28, 30);
  doc.text(clip(doc, line.productName, 120), 18, next + 8);
  doc.text(money(line.salesTotal), 192, next + 8, { align: "right" });
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(68, 71, 78);
  doc.text(clip(doc, `${line.inventoryName} · Factura ${line.invoiceNumber || "sin número"}`, 170), 18, next + 14);
  panel(doc, 18, next + 18, 84, 14, [255, 255, 255]);
  panel(doc, 106, next + 18, 86, 14, [255, 255, 255]);
  doc.setFontSize(8);
  doc.text("Paquetes", 22, next + 23.5);
  doc.text("Precio por paquete", 110, next + 23.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(26, 28, 30);
  doc.text(qty(line.quantity), 22, next + 29);
  doc.text(voucherPrice(line.appliedPrice), 110, next + 29);
  return next + 40;
}

export function buildSaleVoucher(sale: PricingSale): jsPDF {
  const doc = new jsPDF({ unit: "mm", format: "a4" });
  panel(doc, 14, 12, 182, 54, [232, 240, 254]);
  fill(doc, [26, 86, 219]);
  doc.roundedRect(18, 16, 8, 8, 1.5, 1.5, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(26, 86, 219);
  doc.text("GESTIÓN COMERCIAL", 30, 19.2);
  doc.setFontSize(16);
  doc.setTextColor(26, 28, 30);
  doc.text("COMPROBANTE DE VENTA", 30, 27);
  panel(doc, 150, 16, 40, 7, [230, 244, 234]);
  doc.setFontSize(8);
  doc.setTextColor(13, 101, 45);
  doc.text("Registrada", 170, 20.6, { align: "center" });
  panel(doc, 18, 32, 174, 8, [255, 255, 255]);
  doc.setFont("helvetica", "normal");
  doc.setFontSize(8);
  doc.setTextColor(68, 71, 78);
  doc.text(clip(doc, `Operación ${sale.operationId}`, 166), 22, 37.2);
  panel(doc, 18, 44, 84, 16, [255, 255, 255]);
  panel(doc, 106, 44, 86, 16, [255, 255, 255]);
  doc.setFontSize(7);
  doc.text("Fecha", 22, 49.5);
  doc.text("Vendedor", 110, 49.5);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(26, 28, 30);
  doc.text(clip(doc, dateTimeLabel(sale.soldAt), 76), 22, 55.5);
  doc.text(clip(doc, sale.sellerName || "—", 78), 110, 55.5);

  let y = 74;
  for (const line of sale.lines) y = drawLine(doc, line, y);

  y = room(doc, y, 58);
  panel(doc, 14, y, 182, 18, [230, 244, 234]);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(13, 101, 45);
  doc.text("Venta total", 18, y + 7);
  doc.setFontSize(16);
  doc.text(money(sale.salesTotal), 192, y + 12, { align: "right" });

  const metrics: Array<[string, string, [number, number, number], [number, number, number]]> = [
    ["Total de paquetes", qty(sale.packageCount), [248, 249, 251], [26, 28, 30]],
    ["Utilidad bruta", money(sale.grossProfit), [248, 249, 251], [26, 28, 30]],
    ["Ganancia del vendedor", money(sale.vendorProfit), [247, 244, 252], [109, 75, 161]],
    ["Ganancia del inversionista", money(sale.investorNet), [255, 247, 240], [192, 90, 18]],
  ];
  metrics.forEach((metric, index) => {
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = 14 + column * 93;
    const top = y + 22 + row * 16;
    panel(doc, x, top, 89, 14, metric[2]);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(metric[3][0], metric[3][1], metric[3][2]);
    doc.text(metric[0], x + 4, top + 5.5);
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.text(metric[1], x + 4, top + 11);
  });
  const note = vendorCommissionNote(sale.vendorProfit, sale.lines.map((line) => line.vendorProfit));
  if (note) {
    y = room(doc, y + 54, 16);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(141, 78, 0);
    doc.text(clip(doc, note, 180), 14, y + 6);
  }
  return doc;
}

export function saleVoucherBlob(sale: PricingSale): Blob {
  return buildSaleVoucher(sale).output("blob");
}

export function downloadSaleVoucher(sale: PricingSale): void {
  const url = URL.createObjectURL(saleVoucherBlob(sale));
  const link = document.createElement("a");
  link.href = url;
  link.download = `comprobante-${sale.operationId}.pdf`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function printSaleVoucher(sale: PricingSale): void {
  const url = URL.createObjectURL(saleVoucherBlob(sale));
  const frame = document.createElement("iframe");
  frame.setAttribute("title", "Comprobante de venta");
  frame.style.position = "fixed";
  frame.style.width = "0";
  frame.style.height = "0";
  frame.style.border = "0";
  frame.src = url;
  frame.onload = () => {
    frame.contentWindow?.focus();
    frame.contentWindow?.print();
    setTimeout(() => {
      frame.remove();
      URL.revokeObjectURL(url);
    }, 1000);
  };
  document.body.appendChild(frame);
}
