import { fromCents, toCents, type CommissionBalance, type CommissionPayment } from "./commissionCommit";
import { buildSalesDashboard, type CatalogProduct, type DashboardFilters } from "./dashboardReport";
import type { PricingSale, SaleLineSnapshot } from "./saleCommit";

const failures: string[] = [];

function check(name: string, condition: boolean) {
  if (!condition) failures.push(name);
}

function line(partial: Partial<SaleLineSnapshot> & Pick<SaleLineSnapshot, "inventoryId" | "productId" | "quantity">): SaleLineSnapshot {
  const quantity = partial.quantity;
  const appliedPrice = partial.appliedPrice ?? 10;
  const vendorPerPack = partial.vendorProfitPerPack ?? 1;
  const investorPerPack = partial.investorNetPerPack ?? 2;
  return {
    inventoryName: partial.inventoryName ?? "Inventario A",
    productName: partial.productName ?? "Producto",
    invoiceNumber: partial.invoiceNumber ?? "F-1",
    appliedPrice,
    costPerPack: 5,
    logisticsPerPack: 1,
    grossProfitPerPack: 4,
    vendorProfitPerPack: vendorPerPack,
    investorNetPerPack: investorPerPack,
    commissionMethod: "2",
    vendorSharePercent: 30,
    salesTotal: partial.salesTotal ?? appliedPrice * quantity,
    grossProfit: partial.grossProfit ?? 4 * quantity,
    vendorProfit: partial.vendorProfit ?? vendorPerPack * quantity,
    investorNet: partial.investorNet ?? investorPerPack * quantity,
    ...partial,
  };
}

function sale(operationId: string, soldAt: string, lines: SaleLineSnapshot[]): PricingSale {
  return {
    operationId,
    ownerUid: "owner",
    sellerUid: "seller",
    sellerName: "Lener Gonzalez",
    soldAt,
    packageCount: lines.reduce((sum, item) => sum + item.quantity, 0),
    salesTotal: lines.reduce((sum, item) => sum + item.salesTotal, 0),
    grossProfit: lines.reduce((sum, item) => sum + item.grossProfit, 0),
    vendorProfit: lines.reduce((sum, item) => sum + item.vendorProfit, 0),
    investorNet: lines.reduce((sum, item) => sum + item.investorNet, 0),
    lines,
  };
}

const filters: DashboardFilters = { from: "", to: "", inventoryId: "", productId: "" };
const projected = line({
  inventoryId: "inv-1",
  productId: "p1",
  productName: "Producto de ejemplo 1",
  invoiceNumber: "0000101004",
  quantity: 2,
  appliedPrice: 98,
  salesTotal: 196,
  vendorProfit: 23.602363367799114,
  investorNet: 35.40354505169867,
});
const wholeInventoryVendor = 236.02;
const report = buildSalesDashboard(
  [sale("sale-1", "2026-11-06T06:07:01.221Z", [projected])],
  [],
  [],
  [{ inventoryId: "inv-1", inventoryName: "Inventario noviembre", productId: "p1", productName: "Producto de ejemplo 1", invoiceNumber: "0000101004", initialPackages: 20 }],
  filters,
);
check("sold packages are the real quantity", report.packagesSold === 2);
check("projected inventory commission is not used", report.commissionGenerated !== wholeInventoryVendor);
check("generated rounds the sold line once", report.commissionGenerated === fromCents(toCents(23.602363367799114)));
check("investor rounds the sold line once", report.investorNet === fromCents(toCents(35.40354505169867)));
check("sales total rounds the sold line once", report.salesTotal === 196);
check("available is initial minus sold", report.packagesAvailable === 18);
check("per package uses sold packages", report.investorPerPackage === report.investorNet / 2);

const otherInventory = line({
  inventoryId: "inv-2",
  inventoryName: "Inventario diciembre",
  productId: "p9",
  productName: "Producto de ejemplo 1",
  invoiceNumber: "0000202008",
  quantity: 1,
  salesTotal: 73,
  vendorProfit: 8.904579025110783,
  investorNet: 13.36,
});
const separated = buildSalesDashboard(
  [sale("sale-2", "2026-11-06T12:00:00.000Z", [projected, otherInventory])],
  [],
  [],
  [],
  filters,
);
check("same name in another inventory stays separate", separated.products.length === 2);
check("product filter keeps one inventory", buildSalesDashboard([sale("sale-2", "2026-11-06T12:00:00.000Z", [projected, otherInventory])], [], [], [], { ...filters, productId: "p9" }).packagesSold === 1);

const historicalVendor = [23.602363367799114, 8.904579025110783, 8.904579025110783, 35.40354505169867, 23.602363367799114];
const historicalPaid = [23.602363367799114, 8.904579025110783, 8.904579025110783, 8.588478581979318, 0];
const historicalLines = historicalVendor.map((vendor, index) =>
  line({
    inventoryId: index === 4 ? "inv-1" : "inv-1",
    productId: index === 1 || index === 2 ? "p2" : "p1",
    productName: index === 1 || index === 2 ? "Producto de ejemplo 2" : "Producto de ejemplo 1",
    quantity: 1,
    salesTotal: 10,
    vendorProfit: vendor,
    investorNet: 1,
  }),
);
const historicalSales = [
  sale("ed9623b1", "2026-11-06T06:07:01.221Z", [historicalLines[0], historicalLines[1]]),
  sale("5495a127", "2026-11-06T06:11:33.156Z", [historicalLines[2]]),
  sale("ffb14dd9", "2026-11-06T06:18:11.093Z", [historicalLines[3]]),
  sale("db0055e4", "2026-11-06T06:21:31.526Z", [historicalLines[4]]),
];
const historicalBalances: CommissionBalance[] = historicalSales.flatMap((item) =>
  item.lines.map((row, index) => ({
    ownerUid: "owner",
    sellerUid: "seller",
    saleId: item.operationId,
    soldAt: item.soldAt,
    lineIndex: index,
    inventoryId: row.inventoryId,
    invoiceNumber: row.invoiceNumber,
    productId: row.productId,
    productName: row.productName,
    generated: row.vendorProfit,
    paid: item.operationId === "ed9623b1"
      ? historicalPaid[index]
      : item.operationId === "5495a127"
        ? historicalPaid[2]
        : item.operationId === "ffb14dd9"
          ? historicalPaid[3]
          : 0,
  })),
);
const ledger = buildSalesDashboard(historicalSales, historicalBalances, [], [], filters);
check("generated cents are 100.40", ledger.commissionGenerated === 100.4);
check("paid cents are 49.99", ledger.commissionPaid === 49.99);
check("pending cents are 50.41", ledger.commissionPending === 50.41);
check("paid plus pending equals generated", toCents(ledger.commissionPaid) + toCents(ledger.commissionPending) === toCents(ledger.commissionGenerated));
const partialSale = ledger.sales.find((item) => item.operationId === "ffb14dd9");
check("partial sale stays partial", partialSale?.status === "Parcial");
check("open sale stays pending", ledger.sales.find((item) => item.operationId === "db0055e4")?.status === "Pendiente");
check("settled sale is paid", ledger.sales.find((item) => item.operationId === "5495a127")?.status === "Pagada");
check("multi-product sale keeps both lines", ledger.sales.find((item) => item.operationId === "ed9623b1")?.lines.length === 2);
check("visible lines equal the operation when unfiltered", ledger.sales.every((item) => item.operationSalesTotal === item.salesTotal));

const storedPayment: CommissionPayment = {
  operationId: "pay-50",
  ownerUid: "owner",
  sellerUid: "seller",
  sellerName: "Lener Gonzalez",
  paidAt: "2026-11-06T06:41:00.000Z",
  amount: 50,
  applications: [
    { saleId: "ed9623b1", lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "0000101004", productId: "p1", productName: "Producto de ejemplo 1", amount: 23.602363367799114, pendingAfter: 0 },
    { saleId: "ed9623b1", lineIndex: 1, inventoryId: "inv-1", invoiceNumber: "", productId: "p2", productName: "Producto de ejemplo 2", amount: 8.904579025110783, pendingAfter: 0 },
    { saleId: "5495a127", lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "", productId: "p2", productName: "Producto de ejemplo 2", amount: 8.904579025110783, pendingAfter: 0 },
    { saleId: "ffb14dd9", lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "0000101004", productId: "p1", productName: "Producto de ejemplo 1", amount: 8.588478581979318, pendingAfter: 26.815066469719355 },
  ],
};
const withPayment = buildSalesDashboard(historicalSales, historicalBalances, [storedPayment], [], filters);
check("historical payment amount stays 50", withPayment.payments[0]?.amount === 50);
check("dashboard includes the rounding cent once", withPayment.commissionPaid === 50 && withPayment.commissionPending === 50.4 && withPayment.historicalRoundingCents === 1);
check("historical applications stay untouched", withPayment.payments[0]?.applications[3]?.amount === 8.588478581979318);
const filteredPayment = buildSalesDashboard(historicalSales, historicalBalances, [storedPayment], [], { ...filters, productId: "p2" });
check("product filter limits payment applications", filteredPayment.payments[0]?.applications.length === 2);
check("filtered payment still shows the stored amount", filteredPayment.payments[0]?.amount === 50);

const dated = buildSalesDashboard(historicalSales, historicalBalances, [storedPayment], [], { ...filters, from: "2026-11-07", to: "2026-11-07" });
check("date filter excludes earlier sales", dated.packagesSold === 0 && dated.sales.length === 0 && dated.payments.length === 0);
const catalog: CatalogProduct[] = [
  { inventoryId: "inv-1", inventoryName: "Inventario noviembre", productId: "p1", productName: "Producto de ejemplo 1", invoiceNumber: "0000101004", initialPackages: 20 },
];
const available = buildSalesDashboard(historicalSales, historicalBalances, [], catalog, { ...filters, from: "2026-11-07", to: "2026-11-07" });
check("available keeps all-time sold packages", available.packagesAvailable === 17);
const stockRow = available.products.find((row) => row.productId === "p1");
check("empty period keeps the product stock", available.packagesSold === 0 && available.salesTotal === 0 && stockRow?.soldPackages === 0 && stockRow.soldAllTime === 3 && stockRow.availablePackages === 17);

const day = buildSalesDashboard(historicalSales, historicalBalances, [], [], filters);
check("daily packages equal the kpi", day.byDay.reduce((sum, point) => sum + point.packages, 0) === day.packagesSold);
check("daily investor cents equal the kpi", day.byDay.reduce((sum, point) => sum + toCents(point.investorNet), 0) === toCents(day.investorNet));
check("daily commission cents equal the kpi", day.byDay.reduce((sum, point) => sum + toCents(point.generated), 0) === toCents(day.commissionGenerated));
check("product rows equal the sales kpi", day.products.reduce((sum, row) => sum + toCents(row.salesTotal), 0) === toCents(day.salesTotal));
check("product commissions equal the kpi", day.products.reduce((sum, row) => sum + toCents(row.vendorProfit), 0) === toCents(day.commissionGenerated));

const early = sale("s-early", "2026-11-01T18:00:00.000Z", [line({ inventoryId: "inv-1", productId: "p1", quantity: 2, salesTotal: 20, vendorProfit: 4, investorNet: 6 })]);
const later = sale("s-late", "2026-11-08T18:00:00.000Z", [line({ inventoryId: "inv-1", productId: "p1", quantity: 1, salesTotal: 10, vendorProfit: 2, investorNet: 3 })]);
const periodBalances: CommissionBalance[] = [
  { ownerUid: "owner", sellerUid: "seller", saleId: "s-early", soldAt: early.soldAt, lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "F-1", productId: "p1", productName: "Producto", generated: 4, paid: 4 },
  { ownerUid: "owner", sellerUid: "seller", saleId: "s-late", soldAt: later.soldAt, lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "F-1", productId: "p1", productName: "Producto", generated: 2, paid: 0 },
];
const periodPayment: CommissionPayment = {
  operationId: "pay-later",
  ownerUid: "owner",
  sellerUid: "seller",
  sellerName: "Lener Gonzalez",
  paidAt: "2026-11-08T20:00:00.000Z",
  amount: 4,
  applications: [{ saleId: "s-early", lineIndex: 0, inventoryId: "inv-1", invoiceNumber: "F-1", productId: "p1", productName: "Producto", amount: 4, pendingAfter: 0 }],
};
const novemberEighth = buildSalesDashboard(
  [early, later],
  periodBalances,
  [periodPayment],
  [{ inventoryId: "inv-1", inventoryName: "Inventario", productId: "p1", productName: "Producto", invoiceNumber: "F-1", initialPackages: 10 }],
  { from: "2026-11-08", to: "2026-11-08", inventoryId: "", productId: "" },
);
const novemberRow = novemberEighth.products.find((row) => row.productId === "p1");
check("period sold stays apart from cumulative stock", novemberRow?.soldPackages === 1 && novemberRow.soldAllTime === 3 && novemberRow.availablePackages === 7);
check("sales follow the sale date", novemberEighth.packagesSold === 1 && novemberEighth.salesTotal === 10 && novemberEighth.commissionGenerated === 2 && novemberEighth.commissionPaid === 0);
check("payment history follows the payment date", novemberEighth.payments.length === 1 && novemberEighth.payments[0]?.amount === 4);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sales dashboard ok");
