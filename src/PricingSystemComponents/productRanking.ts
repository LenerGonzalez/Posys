import { computeInventory } from "./pricingEngine";
import { scopeInventories } from "./profitability";
import type { PricingInventory } from "./types";

const MONEY_EPS = 1e-9;

export type ProductProfitStatus = "rentable" | "margen_bajo" | "perdida" | "sin_rentabilidad" | "margen_negativo";

export type ProductRankSort =
  | "net_desc"
  | "net_asc"
  | "margin_desc"
  | "margin_asc"
  | "sales_desc"
  | "packages_desc";

export interface ProductRankFilters {
  from: string;
  to: string;
  inventoryId: string;
  invoice: string;
  query: string;
  status: "" | ProductProfitStatus;
  sort: ProductRankSort;
}

export const EMPTY_PRODUCT_RANK_FILTERS: ProductRankFilters = {
  from: "",
  to: "",
  inventoryId: "",
  invoice: "",
  query: "",
  status: "",
  sort: "net_desc",
};

export interface ProductRankRow {
  id: string;
  inventoryId: string;
  inventoryName: string;
  productName: string;
  invoice: string;
  packages: number;
  purchaseSubtotal: number;
  logisticsAllocated: number;
  appliedPrice: number;
  salesTotal: number;
  realMarginPercent: number;
  vendorProfit: number;
  investorNet: number;
  status: ProductProfitStatus;
}

export interface ProductRankReport {
  rows: ProductRankRow[];
  totalProducts: number;
  profitable: number;
  lowMargin: number;
  losses: number;
  flat: number;
  top: ProductRankRow | null;
}

export function productProfitStatus(investorNet: number, realMarginPercent: number): ProductProfitStatus {
  if (investorNet < -MONEY_EPS) return "perdida";
  if (Math.abs(investorNet) <= MONEY_EPS) return "sin_rentabilidad";
  if (realMarginPercent < -MONEY_EPS) return "margen_negativo";
  if (realMarginPercent <= 5 + MONEY_EPS) return "margen_bajo";
  return "rentable";
}

export function productStatusLabel(status: ProductProfitStatus): string {
  if (status === "rentable") return "Rentable";
  if (status === "margen_bajo") return "Margen bajo";
  if (status === "perdida") return "Pérdida";
  if (status === "margen_negativo") return "Margen negativo";
  return "Sin rentabilidad";
}

function compareRows(sort: ProductRankSort, left: ProductRankRow, right: ProductRankRow): number {
  const name = left.productName.localeCompare(right.productName, "es") || left.inventoryName.localeCompare(right.inventoryName, "es");
  if (sort === "net_desc") return right.investorNet - left.investorNet || name;
  if (sort === "net_asc") return left.investorNet - right.investorNet || name;
  if (sort === "margin_desc") return right.realMarginPercent - left.realMarginPercent || name;
  if (sort === "margin_asc") return left.realMarginPercent - right.realMarginPercent || name;
  if (sort === "sales_desc") return right.salesTotal - left.salesTotal || name;
  return right.packages - left.packages || name;
}

/** Una fila por producto de cada inventario. No mezcla el mismo nombre entre inventarios. */
export function buildProductRanking(items: PricingInventory[], filters: ProductRankFilters): ProductRankReport {
  const invoice = filters.invoice.trim();
  const query = filters.query.trim().toLocaleLowerCase("es");
  const rows: ProductRankRow[] = [];

  scopeInventories(items, filters).forEach((inventory) => {
    const computed = computeInventory(inventory);
    computed.lines.forEach((line) => {
      if (invoice && line.orderCode.trim() !== invoice) return;
      if (query && !line.name.toLocaleLowerCase("es").includes(query)) return;
      const status = productProfitStatus(line.investorNet, line.realMarginPercent);
      if (filters.status && status !== filters.status) return;
      rows.push({
        id: `${inventory.id}:${line.id}`,
        inventoryId: inventory.id,
        inventoryName: inventory.name || "Sin nombre",
        productName: line.name || "Sin nombre",
        invoice: line.orderCode.trim(),
        packages: line.packages,
        purchaseSubtotal: line.purchaseSubtotal,
        logisticsAllocated: line.logisticsAllocated,
        appliedPrice: line.appliedPrice,
        salesTotal: line.salesTotal,
        realMarginPercent: line.realMarginPercent,
        vendorProfit: line.vendorProfit,
        investorNet: line.investorNet,
        status,
      });
    });
  });

  rows.sort((left, right) => compareRows(filters.sort, left, right));
  const top = rows.reduce<ProductRankRow | null>((best, row) => {
    if (!best || row.investorNet > best.investorNet) return row;
    return best;
  }, null);

  return {
    rows,
    totalProducts: rows.length,
    profitable: rows.filter((row) => row.status === "rentable").length,
    lowMargin: rows.filter((row) => row.status === "margen_bajo").length,
    losses: rows.filter((row) => row.status === "perdida").length,
    flat: rows.filter((row) => row.status === "sin_rentabilidad").length,
    top,
  };
}
