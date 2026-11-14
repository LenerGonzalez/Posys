import { assessHistoricalRounding, balanceCents, fromCents, lineKey, toCents, type CommissionBalance, type CommissionPayment } from "./commissionCommit";
import type { PricingSale, SaleLineSnapshot } from "./saleCommit";

export interface DashboardFilters {
  from: string;
  to: string;
  inventoryId: string;
  productId: string;
}

export const EMPTY_DASHBOARD_FILTERS: DashboardFilters = {
  from: "",
  to: "",
  inventoryId: "",
  productId: "",
};

export interface CatalogProduct {
  inventoryId: string;
  inventoryName: string;
  productId: string;
  productName: string;
  invoiceNumber: string;
  initialPackages: number;
}

export type CommissionStatus = "Pagada" | "Pendiente" | "Parcial" | "Sin comisión";

export interface ProductReportRow {
  key: string;
  inventoryId: string;
  inventoryName: string;
  invoiceNumbers: string;
  productId: string;
  productName: string;
  initialPackages: number | null;
  soldPackages: number;
  soldAllTime: number;
  availablePackages: number | null;
  salesTotal: number;
  investorNet: number;
  vendorProfit: number;
  commissionPaid: number;
  commissionPending: number;
}

export interface SaleHistoryLine {
  inventoryName: string;
  invoiceNumber: string;
  productName: string;
  quantity: number;
  salesTotal: number;
  investorNet: number;
  vendorProfit: number;
  status: CommissionStatus;
}

export interface SaleHistoryEntry {
  operationId: string;
  soldAt: string;
  sellerName: string;
  sellerUid: string;
  packageCount: number;
  salesTotal: number;
  investorNet: number;
  vendorProfit: number;
  status: CommissionStatus;
  operationPackageCount: number;
  operationSalesTotal: number;
  linesOutsideFilter: boolean;
  lines: SaleHistoryLine[];
}

export interface PaymentHistoryLine {
  saleId: string;
  inventoryName: string;
  invoiceNumber: string;
  productName: string;
  amount: number;
  pendingAfter: number;
}

export interface PaymentHistoryEntry {
  operationId: string;
  paidAt: string;
  sellerName: string;
  amount: number;
  applicationsOutsideFilter: boolean;
  applications: PaymentHistoryLine[];
}

export interface DayPoint {
  day: string;
  label: string;
  packages: number;
  investorNet: number;
  generated: number;
}

export interface SalesDashboardReport {
  packagesSold: number;
  packagesAvailable: number | null;
  salesTotal: number;
  investorNet: number;
  investorPerPackage: number | null;
  commissionGenerated: number;
  commissionPaid: number;
  commissionPending: number;
  historicalRoundingCents: number;
  products: ProductReportRow[];
  sales: SaleHistoryEntry[];
  payments: PaymentHistoryEntry[];
  byDay: DayPoint[];
}

interface ScopedLine {
  sale: PricingSale;
  line: SaleLineSnapshot;
  index: number;
  day: string;
}

function dayKey(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function dayLabel(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (!year || !month || !date) return day;
  return new Date(year, month - 1, date).toLocaleDateString("es-NI", { day: "2-digit", month: "short" });
}

function inDateRange(day: string, filters: DashboardFilters): boolean {
  if (!day) return false;
  if (filters.from && day < filters.from) return false;
  if (filters.to && day > filters.to) return false;
  return true;
}

function matchesScope(line: { inventoryId: string; productId: string }, filters: DashboardFilters): boolean {
  if (filters.inventoryId && line.inventoryId !== filters.inventoryId) return false;
  if (filters.productId && line.productId !== filters.productId) return false;
  return true;
}

function commissionStatus(generated: number, paid: number): CommissionStatus {
  if (generated <= 0) return "Sin comisión";
  if (paid <= 0) return "Pendiente";
  if (paid >= generated) return "Pagada";
  return "Parcial";
}

function combineStatus(statuses: CommissionStatus[]): CommissionStatus {
  const active = statuses.filter((status) => status !== "Sin comisión");
  if (!active.length) return "Sin comisión";
  if (active.every((status) => status === "Pagada")) return "Pagada";
  if (active.every((status) => status === "Pendiente")) return "Pendiente";
  return "Parcial";
}

function centsOf(balance: CommissionBalance | undefined, vendorProfit: number): { generated: number; paid: number; pending: number } {
  if (!balance) {
    const generated = toCents(vendorProfit);
    return { generated, paid: 0, pending: generated };
  }
  return balanceCents(balance);
}

function inventoryNames(sales: PricingSale[], catalog: CatalogProduct[]): Map<string, string> {
  const names = new Map<string, string>();
  for (const product of catalog) {
    if (product.inventoryName.trim()) names.set(product.inventoryId, product.inventoryName.trim());
  }
  const ranked = sales.slice().sort((left, right) => left.soldAt.localeCompare(right.soldAt));
  for (const sale of ranked) {
    for (const line of sale.lines) {
      if (line.inventoryName.trim()) names.set(line.inventoryId, line.inventoryName.trim());
    }
  }
  return names;
}

export function buildSalesDashboard(
  sales: PricingSale[],
  balances: CommissionBalance[],
  payments: CommissionPayment[],
  catalog: CatalogProduct[],
  filters: DashboardFilters,
): SalesDashboardReport {
  const activeSales = sales.filter((sale) => sale.status !== "ANULADA");
  const rounding = assessHistoricalRounding(payments, balances);
  const byLine = new Map(rounding.balances.map((balance) => [lineKey(balance.saleId, balance.lineIndex), balance]));
  const names = inventoryNames(activeSales, catalog);
  const allLines: ScopedLine[] = activeSales.flatMap((sale) =>
    sale.lines.map((line, index) => ({ sale, line, index, day: dayKey(sale.soldAt) })),
  );
  const period = allLines.filter((item) => inDateRange(item.day, filters) && matchesScope(item.line, filters));
  const soldAllTime = new Map<string, number>();
  for (const item of allLines) {
    if (!matchesScope(item.line, filters)) continue;
    const key = `${item.line.inventoryId}:${item.line.productId}`;
    soldAllTime.set(key, (soldAllTime.get(key) || 0) + item.line.quantity);
  }

  let salesCents = 0;
  let investorCents = 0;
  let generatedCents = 0;
  let paidCents = 0;
  let packagesSold = 0;
  const productMap = new Map<string, ProductReportRow & { salesCents: number; investorCents: number; vendorCents: number; paidCents: number; invoices: Set<string> }>();
  const dayMap = new Map<string, { packages: number; investorCents: number; generatedCents: number }>();

  for (const item of period) {
    const moneyLine = centsOf(byLine.get(lineKey(item.sale.operationId, item.index)), item.line.vendorProfit);
    const saleCents = toCents(item.line.salesTotal);
    const investor = toCents(item.line.investorNet);
    packagesSold += item.line.quantity;
    salesCents += saleCents;
    investorCents += investor;
    generatedCents += moneyLine.generated;
    paidCents += moneyLine.paid;
    const key = `${item.line.inventoryId}:${item.line.productId}`;
    const current = productMap.get(key) || {
      key,
      inventoryId: item.line.inventoryId,
      inventoryName: item.line.inventoryName.trim() || names.get(item.line.inventoryId) || "Inventario",
      invoiceNumbers: "",
      productId: item.line.productId,
      productName: item.line.productName,
      initialPackages: null,
      soldPackages: 0,
      soldAllTime: 0,
      availablePackages: null,
      salesTotal: 0,
      investorNet: 0,
      vendorProfit: 0,
      commissionPaid: 0,
      commissionPending: 0,
      salesCents: 0,
      investorCents: 0,
      vendorCents: 0,
      paidCents: 0,
      invoices: new Set<string>(),
    };
    current.soldPackages += item.line.quantity;
    current.salesCents += saleCents;
    current.investorCents += investor;
    current.vendorCents += moneyLine.generated;
    current.paidCents += moneyLine.paid;
    if (item.line.invoiceNumber.trim()) current.invoices.add(item.line.invoiceNumber.trim());
    current.inventoryName = item.line.inventoryName.trim() || current.inventoryName;
    current.productName = item.line.productName || current.productName;
    productMap.set(key, current);
    const day = dayMap.get(item.day) || { packages: 0, investorCents: 0, generatedCents: 0 };
    day.packages += item.line.quantity;
    day.investorCents += investor;
    day.generatedCents += moneyLine.generated;
    dayMap.set(item.day, day);
  }

  const blankRow = (
    key: string,
    inventoryId: string,
    inventoryName: string,
    productId: string,
    productName: string,
    invoiceNumber: string,
  ) => ({
    key,
    inventoryId,
    inventoryName,
    invoiceNumbers: "",
    productId,
    productName,
    initialPackages: null,
    soldPackages: 0,
    soldAllTime: 0,
    availablePackages: null,
    salesTotal: 0,
    investorNet: 0,
    vendorProfit: 0,
    commissionPaid: 0,
    commissionPending: 0,
    salesCents: 0,
    investorCents: 0,
    vendorCents: 0,
    paidCents: 0,
    invoices: new Set<string>(invoiceNumber.trim() ? [invoiceNumber.trim()] : []),
  });
  for (const product of catalog) {
    if (!matchesScope(product, filters)) continue;
    const key = `${product.inventoryId}:${product.productId}`;
    if (productMap.has(key)) continue;
    productMap.set(key, blankRow(key, product.inventoryId, product.inventoryName, product.productId, product.productName, product.invoiceNumber));
  }
  for (const item of allLines) {
    if (!matchesScope(item.line, filters)) continue;
    const key = `${item.line.inventoryId}:${item.line.productId}`;
    if (productMap.has(key)) continue;
    productMap.set(key, blankRow(
      key,
      item.line.inventoryId,
      item.line.inventoryName.trim() || names.get(item.line.inventoryId) || "Inventario",
      item.line.productId,
      item.line.productName,
      item.line.invoiceNumber,
    ));
  }

  const catalogByKey = new Map(catalog.map((product) => [`${product.inventoryId}:${product.productId}`, product]));
  let availableKnown = 0;
  let availableCount = 0;
  for (const product of catalog) {
    if (!matchesScope(product, filters)) continue;
    availableKnown += product.initialPackages - (soldAllTime.get(`${product.inventoryId}:${product.productId}`) || 0);
    availableCount += 1;
  }

  const products = [...productMap.values()]
    .map((row) => {
      const source = catalogByKey.get(row.key);
      const initial = source ? source.initialPackages : null;
      const available = initial == null ? null : initial - (soldAllTime.get(row.key) || 0);
      return {
        key: row.key,
        inventoryId: row.inventoryId,
        inventoryName: row.inventoryName,
        invoiceNumbers: [...row.invoices].join(", "),
        productId: row.productId,
        productName: row.productName,
        initialPackages: initial,
        soldPackages: row.soldPackages,
        soldAllTime: soldAllTime.get(row.key) || 0,
        availablePackages: available,
        salesTotal: fromCents(row.salesCents),
        investorNet: fromCents(row.investorCents),
        vendorProfit: fromCents(row.vendorCents),
        commissionPaid: fromCents(row.paidCents),
        commissionPending: fromCents(row.vendorCents - row.paidCents),
      };
    })
    .sort((left, right) => left.inventoryName.localeCompare(right.inventoryName, "es") || left.productName.localeCompare(right.productName, "es"));

  const salesHistory = activeSales
    .map((sale) => {
      const visible = sale.lines
        .map((line, index) => ({ line, index }))
        .filter((item) => inDateRange(dayKey(sale.soldAt), filters) && matchesScope(item.line, filters));
      if (!visible.length) return null;
      const lineRows = visible.map((item) => {
        const moneyLine = centsOf(byLine.get(lineKey(sale.operationId, item.index)), item.line.vendorProfit);
        return {
          inventoryName: item.line.inventoryName.trim() || names.get(item.line.inventoryId) || "Inventario",
          invoiceNumber: item.line.invoiceNumber,
          productName: item.line.productName,
          quantity: item.line.quantity,
          salesTotal: fromCents(toCents(item.line.salesTotal)),
          investorNet: fromCents(toCents(item.line.investorNet)),
          vendorProfit: fromCents(moneyLine.generated),
          status: commissionStatus(moneyLine.generated, moneyLine.paid),
          generated: moneyLine.generated,
          paid: moneyLine.paid,
          salesCents: toCents(item.line.salesTotal),
          investorCents: toCents(item.line.investorNet),
        };
      });
      const operationLines = sale.lines.map((line) => ({
        quantity: line.quantity,
        salesCents: toCents(line.salesTotal),
      }));
      return {
        operationId: sale.operationId,
        soldAt: sale.soldAt,
        sellerName: sale.sellerName || "Vendedor",
        sellerUid: sale.sellerUid,
        packageCount: lineRows.reduce((sum, line) => sum + line.quantity, 0),
        salesTotal: fromCents(lineRows.reduce((sum, line) => sum + line.salesCents, 0)),
        investorNet: fromCents(lineRows.reduce((sum, line) => sum + line.investorCents, 0)),
        vendorProfit: fromCents(lineRows.reduce((sum, line) => sum + line.generated, 0)),
        status: combineStatus(lineRows.map((line) => line.status)),
        operationPackageCount: operationLines.reduce((sum, line) => sum + line.quantity, 0),
        operationSalesTotal: fromCents(operationLines.reduce((sum, line) => sum + line.salesCents, 0)),
        linesOutsideFilter: visible.length !== sale.lines.length,
        lines: lineRows.map(({ generated: _generated, paid: _paid, salesCents: _sales, investorCents: _investor, ...line }) => line),
      } satisfies SaleHistoryEntry;
    })
    .filter((sale): sale is SaleHistoryEntry => sale != null)
    .sort((left, right) => right.soldAt.localeCompare(left.soldAt));

  const paymentHistory = payments
    .filter((payment) => inDateRange(dayKey(payment.paidAt), filters))
    .map((payment) => {
      const visible = payment.applications.filter((application) => matchesScope(application, filters));
      if ((filters.inventoryId || filters.productId) && !visible.length) return null;
      return {
        operationId: payment.operationId,
        paidAt: payment.paidAt,
        sellerName: payment.sellerName || "Vendedor",
        amount: payment.amount,
        applicationsOutsideFilter: visible.length !== payment.applications.length,
        applications: visible.map((application) => ({
          saleId: application.saleId,
          inventoryName: names.get(application.inventoryId) || "Inventario",
          invoiceNumber: application.invoiceNumber,
          productName: application.productName,
          amount: application.amount,
          pendingAfter: application.pendingAfter,
        })),
      } satisfies PaymentHistoryEntry;
    })
    .filter((payment): payment is PaymentHistoryEntry => payment != null)
    .sort((left, right) => right.paidAt.localeCompare(left.paidAt));

  return {
    packagesSold,
    packagesAvailable: availableCount ? availableKnown : null,
    salesTotal: fromCents(salesCents),
    investorNet: fromCents(investorCents),
    investorPerPackage: packagesSold > 0 ? fromCents(investorCents) / packagesSold : null,
    commissionGenerated: fromCents(generatedCents),
    commissionPaid: fromCents(paidCents),
    commissionPending: fromCents(generatedCents - paidCents),
    historicalRoundingCents: rounding.status === "adjust" ? rounding.cents : 0,
    products,
    sales: salesHistory,
    payments: paymentHistory,
    byDay: [...dayMap.entries()]
      .sort((left, right) => left[0].localeCompare(right[0]))
      .map(([day, point]) => ({
        day,
        label: dayLabel(day),
        packages: point.packages,
        investorNet: fromCents(point.investorCents),
        generated: fromCents(point.generatedCents),
      })),
  };
}
