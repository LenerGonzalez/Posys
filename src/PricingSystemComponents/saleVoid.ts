import { hasRole } from "../utils/roles";
import { toCents, type CommissionBalance, type CommissionQueue } from "./commissionCommit";
import { stockKey, type PricingSale, type SaleLineSnapshot, type StockBalance } from "./saleCommit";

export interface SaleVoidActor {
  uid: string;
  roles: string[];
  name: string;
}

export interface SaleStockDemand {
  inventoryId: string;
  productId: string;
  quantity: number;
}

export interface SaleVoidState {
  sale: PricingSale | null;
  balances: CommissionBalance[];
  stock: StockBalance[];
  queue: CommissionQueue | null;
}

export interface VoidBalanceWrite {
  balance: CommissionBalance;
  create: boolean;
}

export type SaleVoidResult =
  | {
    status: "voided";
    sale: PricingSale;
    stock: StockBalance[];
    balances: VoidBalanceWrite[];
    queue: CommissionQueue | null;
  }
  | { status: "already"; sale: PricingSale }
  | { status: "rejected"; message: string };

export function rolesFromProfile(data: Record<string, unknown> | undefined): string[] {
  if (!data) return [];
  if (Array.isArray(data.roles)) return data.roles.map(String);
  if (typeof data.role === "string" && data.role) return [data.role];
  return [];
}

export function canVoidSale(actorUid: string, roles: readonly string[], sellerUid: string): boolean {
  if (actorUid && sellerUid && actorUid === sellerUid) return true;
  return hasRole([...roles], "admin");
}

export function isVoidedSale(sale: PricingSale): boolean {
  return sale.status === "ANULADA";
}

export function shouldRepairSaleBalances(sale: PricingSale): boolean {
  return Boolean(sale.sellerUid && sale.lines.length && !isVoidedSale(sale));
}

export function saleStockDemand(lines: SaleLineSnapshot[]): SaleStockDemand[] | string {
  const grouped = new Map<string, SaleStockDemand>();
  for (const line of lines) {
    if (!line.inventoryId || !line.productId || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      return "La cantidad de la venta no es válida. La venta no se anuló.";
    }
    const key = stockKey(line.inventoryId, line.productId);
    const current = grouped.get(key) ?? { inventoryId: line.inventoryId, productId: line.productId, quantity: 0 };
    current.quantity += line.quantity;
    grouped.set(key, current);
  }
  return [...grouped.values()];
}

export function planSaleVoid(actor: SaleVoidActor, voidedAt: string, state: SaleVoidState): SaleVoidResult {
  const sale = state.sale;
  if (!sale) return { status: "rejected", message: "La venta no existe. La venta no se anuló." };
  if (isVoidedSale(sale)) return { status: "already", sale };
  if (!canVoidSale(actor.uid, actor.roles, sale.sellerUid)) {
    return { status: "rejected", message: "No puedes anular esta venta." };
  }
  if (!sale.sellerUid) return { status: "rejected", message: "La venta no tiene un vendedor. La venta no se anuló." };

  const paid = state.balances.some((balance) => balance.saleId === sale.operationId && toCents(balance.paid) > 0);
  if (paid) return { status: "rejected", message: "Esta venta tiene comisiones pagadas. La venta no se anuló." };

  const demand = saleStockDemand(sale.lines);
  if (typeof demand === "string") return { status: "rejected", message: demand };

  const stock: StockBalance[] = [];
  for (const item of demand) {
    const balance = state.stock.find((row) => (
      row.ownerUid === sale.sellerUid
      && row.inventoryId === item.inventoryId
      && row.productId === item.productId
    ));
    if (!balance || !Number.isInteger(balance.soldPackages) || balance.soldPackages < item.quantity) {
      return { status: "rejected", message: "No se encontró el contador de paquetes o quedaría por debajo de cero. La venta no se anuló." };
    }
    stock.push({ ...balance, soldPackages: balance.soldPackages - item.quantity, updatedAt: voidedAt });
  }

  const balances: VoidBalanceWrite[] = sale.lines.map((line, lineIndex) => {
    const current = state.balances.find((balance) => balance.saleId === sale.operationId && balance.lineIndex === lineIndex);
    if (current) return { create: false, balance: { ...current, generated: 0, paid: 0 } };
    return {
      create: true,
      balance: {
        ownerUid: sale.ownerUid,
        sellerUid: sale.sellerUid,
        saleId: sale.operationId,
        soldAt: sale.soldAt,
        lineIndex,
        inventoryId: line.inventoryId,
        invoiceNumber: line.invoiceNumber,
        productId: line.productId,
        productName: line.productName,
        generated: 0,
        paid: 0,
      },
    };
  });

  const queue = state.queue
    ? { ...state.queue, lines: state.queue.lines.filter((line) => line.saleId !== sale.operationId) }
    : null;

  return {
    status: "voided",
    sale: {
      ...sale,
      lines: sale.lines,
      status: "ANULADA",
      voidedAt,
      voidedByUid: actor.uid,
      voidedByName: actor.name.trim(),
    },
    stock,
    balances,
    queue,
  };
}
