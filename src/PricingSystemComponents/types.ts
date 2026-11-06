export type PriceMethod = "MARGEN" | "PRECIO";

/** 2: comisión sobre utilidad bruta. 3: comisión sobre utilidad después de logística. */
export type CommissionMethod = "2" | "3";

export function commissionMethodLabel(method: CommissionMethod | undefined): string {
  return method === "3"
    ? "Opción 3: Comisión sobre utilidad después de logística"
    : "Opción 2: Comisión sobre utilidad bruta";
}

export interface InventorySettings {
  logisticsCost: number;
  vendorSharePercent: number;
  targetMarginPercent: number;
  branchLabel: string;
  commissionMethod: CommissionMethod;
}

export interface ProductInput {
  id: string;
  orderCode: string;
  name: string;
  costPerPack: number;
  packages: number;
  priceMethod: PriceMethod;
  manualPrice: number | null;
  targetMarginPercent: number | null;
  vendorSharePercent: number | null;
}

export interface PriceChangeRecord {
  changedAt: string;
  inventoryId: string;
  productId: string;
  productName: string;
  orderCode: string;
  userEmail: string | null;
  userUid: string;
  previousMethod: PriceMethod;
  nextMethod: PriceMethod;
  previousAppliedPrice: number;
  nextAppliedPrice: number;
  previousRealMarginPercent: number;
  nextRealMarginPercent: number;
  previousManualPrice: number | null;
  nextManualPrice: number | null;
  previousTargetMarginPercent: number | null;
  nextTargetMarginPercent: number | null;
}

export interface InventorySnapshot {
  savedAt: string;
  productCount: number;
  packages: number;
  purchaseSubtotal: number;
  logisticsCost: number;
  projectedSales: number;
  grossProfit: number;
  vendorProfit: number;
  investorBeforeLogistics: number;
  investorNet: number;
}

export interface PricingInventory {
  id: string;
  ownerUid: string;
  ownerEmail: string | null;
  name: string;
  settings: InventorySettings;
  products: ProductInput[];
  history: InventorySnapshot[];
  priceChanges?: PriceChangeRecord[];
  createdAt: string | null;
  updatedAt: string | null;
}

export interface LineAlerts {
  /** Precio aplicado <= costo proveedor + logística por paquete. */
  priceAtOrBelowCost: boolean;
  /** Margen real mayor que 0 % y menor o igual a 5 %. */
  lowMargin: boolean;
  /** Ganancia neta del inversionista por paquete menor que la del vendedor por paquete. */
  investorBelowVendor: boolean;
}

export interface ComputedLine {
  id: string;
  orderCode: string;
  name: string;
  costPerPack: number;
  packages: number;
  purchaseSubtotal: number;
  automaticPrice: number;
  manualPrice: number;
  appliedPrice: number;
  realMarginPercent: number;
  salesTotal: number;
  grossProfit: number;
  grossProfitPerPack: number;
  systemGrossMarginPercent: number;
  logisticsAllocated: number;
  logisticsPerPack: number;
  vendorSharePercent: number;
  commissionBase: number;
  commissionBasePerPack: number;
  vendorProfit: number;
  vendorProfitPerPack: number;
  investorBeforeLogistics: number;
  investorBeforeLogisticsPerPack: number;
  investorNet: number;
  investorNetPerPack: number;
  costPlusLogisticsPerPack: number;
  targetMarginPercent: number;
  priceMethod: PriceMethod;
  alerts: LineAlerts;
}

export interface ComputedTotals {
  productCount: number;
  packages: number;
  purchaseSubtotal: number;
  logisticsCost: number;
  costWithLogistics: number;
  projectedSales: number;
  grossProfit: number;
  commissionBase: number;
  vendorProfit: number;
  investorBeforeLogistics: number;
  investorNet: number;
  targetMarginPercent: number;
  vendorSharePercent: number;
  commissionMethod: CommissionMethod;
}

export interface ComputedInventory {
  lines: ComputedLine[];
  totals: ComputedTotals;
}

export interface ImportIssue {
  row: number;
  level: "error" | "warning";
  message: string;
}

export interface ImportPreview {
  products: ProductInput[];
  issues: ImportIssue[];
}

export const INVOICE_HEADERS = [
  "Orden",
  "Producto",
  "Precio costo / paquete (C$)",
  "Cantidad de paquetes",
] as const;

export const DEFAULT_SETTINGS: InventorySettings = {
  logisticsCost: 0,
  vendorSharePercent: 35,
  targetMarginPercent: 30,
  branchLabel: "Única",
  commissionMethod: "2",
};
