import { money, qty } from "./format";
import type { PricingSale } from "./saleCommit";
import { buildSaleVoucher, vendorCommissionNote, voucherAfterAttempt, voucherPrice } from "./saleVoucher";

const failures: string[] = [];

const sale: PricingSale = {
  operationId: "op-voucher-1",
  ownerUid: "owner-1",
  sellerUid: "owner-1",
  sellerName: "Ana",
  soldAt: "2026-11-06T03:15:00.000Z",
  packageCount: 3,
  salesTotal: 99.99,
  grossProfit: 40.5,
  vendorProfit: 12.25,
  investorNet: 28.25,
  lines: [
    {
      inventoryId: "inv-a",
      inventoryName: "Factura A",
      productId: "prod-1",
      productName: "Arroz",
      invoiceNumber: "0000101004",
      quantity: 2,
      appliedPrice: 10,
      costPerPack: 4,
      logisticsPerPack: 1,
      grossProfitPerPack: 5,
      vendorProfitPerPack: 2,
      investorNetPerPack: 3,
      commissionMethod: "2",
      vendorSharePercent: 30,
      salesTotal: 70,
      grossProfit: 30,
      vendorProfit: 8,
      investorNet: 22,
    },
    {
      inventoryId: "inv-b",
      inventoryName: "Factura B",
      productId: "prod-2",
      productName: "Frijol",
      invoiceNumber: "0000101008",
      quantity: 1,
      appliedPrice: 15,
      costPerPack: 6,
      logisticsPerPack: 1,
      grossProfitPerPack: 8,
      vendorProfitPerPack: 3,
      investorNetPerPack: 5,
      commissionMethod: "3",
      vendorSharePercent: 40,
      salesTotal: 29.99,
      grossProfit: 10.5,
      vendorProfit: 4.25,
      investorNet: 6.25,
    },
  ],
};

const failed = voucherAfterAttempt({ error: "No se pudo registrar la venta." });
if (failed !== null) failures.push("un fallo de registro no debía producir voucher");
const accepted = voucherAfterAttempt({ sale });
if (accepted !== sale) failures.push("el voucher debía ser exactamente la venta registrada");

const pdf = buildSaleVoucher(sale).output();
const expected = [
  "GESTIÓN COMERCIAL",
  "COMPROBANTE DE VENTA",
  sale.operationId,
  sale.sellerName,
  "Arroz",
  "Frijol",
  "Factura A",
  "Factura B",
  "0000101004",
  "0000101008",
  qty(sale.packageCount),
  money(sale.salesTotal),
  money(sale.grossProfit),
  money(sale.vendorProfit),
  money(sale.investorNet),
  money(sale.lines[0].salesTotal),
  money(sale.lines[1].salesTotal),
  voucherPrice(sale.lines[0].appliedPrice),
  voucherPrice(sale.lines[1].appliedPrice),
];
for (const text of expected) {
  if (!pdf.includes(text)) failures.push(`el PDF no contiene: ${text}`);
}
if (pdf.includes(money(20)) && sale.lines[0].salesTotal !== 20) {
  failures.push("el PDF recalculó el total del primer producto");
}
if (vendorCommissionNote(sale.vendorProfit, sale.lines.map((line) => line.vendorProfit)) || pdf.includes("redondeada por línea")) {
  failures.push("el comprobante explicó un redondeo que no existe");
}
const roundingNote = vendorCommissionNote(32.5069423929099, [23.602363367799114, 8.904579025110783]);
if (!roundingNote || !roundingNote.includes(money(32.5)) || !roundingNote.includes(money(32.51))) {
  failures.push("la diferencia de redondeo debía identificarse sin cambiar el total");
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sale voucher ok");
