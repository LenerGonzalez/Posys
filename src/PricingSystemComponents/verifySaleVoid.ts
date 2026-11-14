import type { CommissionBalance, CommissionQueue, CommissionQueueLine } from "./commissionCommit";
import type { PricingSale, SaleLineSnapshot, StockBalance } from "./saleCommit";
import { canVoidSale, planSaleVoid, shouldRepairSaleBalances, type SaleVoidActor } from "./saleVoid";

const failures: string[] = [];

function check(name: string, condition: boolean) {
  if (!condition) failures.push(name);
}

function line(partial: Partial<SaleLineSnapshot> & Pick<SaleLineSnapshot, "inventoryId" | "productId" | "quantity">): SaleLineSnapshot {
  const quantity = partial.quantity;
  return {
    inventoryName: partial.inventoryName ?? "Inventario",
    productName: partial.productName ?? "Producto",
    invoiceNumber: partial.invoiceNumber ?? "F-1",
    appliedPrice: partial.appliedPrice ?? 40,
    costPerPack: 20,
    logisticsPerPack: 2,
    grossProfitPerPack: 18,
    vendorProfitPerPack: 5,
    investorNetPerPack: 8,
    commissionMethod: "2",
    vendorSharePercent: 30,
    salesTotal: (partial.appliedPrice ?? 40) * quantity,
    grossProfit: 18 * quantity,
    vendorProfit: 5 * quantity,
    investorNet: 8 * quantity,
    ...partial,
  };
}

function sale(lines: SaleLineSnapshot[], sellerUid = "seller-1"): PricingSale {
  return {
    operationId: "sale-1",
    ownerUid: sellerUid,
    sellerUid,
    sellerName: "Vendedor",
    soldAt: "2026-11-01T12:00:00.000Z",
    packageCount: lines.reduce((sum, item) => sum + item.quantity, 0),
    salesTotal: lines.reduce((sum, item) => sum + item.salesTotal, 0),
    grossProfit: lines.reduce((sum, item) => sum + item.grossProfit, 0),
    vendorProfit: lines.reduce((sum, item) => sum + item.vendorProfit, 0),
    investorNet: lines.reduce((sum, item) => sum + item.investorNet, 0),
    lines,
  };
}

function balance(lineIndex: number, paid = 0, saleId = "sale-1"): CommissionBalance {
  return {
    ownerUid: "seller-1",
    sellerUid: "seller-1",
    saleId,
    soldAt: "2026-11-01T12:00:00.000Z",
    lineIndex,
    inventoryId: "inv-1",
    invoiceNumber: "F-1",
    productId: "p1",
    productName: "Producto",
    generated: 10,
    paid,
  };
}

function stock(ownerUid: string, inventoryId: string, productId: string, soldPackages: number): StockBalance {
  return { ownerUid, inventoryId, productId, soldPackages, updatedAt: "2026-11-01T12:00:00.000Z" };
}

function queueLine(saleId: string, lineIndex: number, productId = "p1"): CommissionQueueLine {
  return {
    saleId,
    soldAt: saleId === "sale-1" ? "2026-11-01T12:00:00.000Z" : "2026-10-01T12:00:00.000Z",
    lineIndex,
    inventoryId: "inv-1",
    invoiceNumber: "F-1",
    productId,
    productName: productId,
  };
}

const actorSeller: SaleVoidActor = { uid: "seller-1", roles: ["contador"], name: "Ana" };
const actorAdmin: SaleVoidActor = { uid: "admin-1", roles: ["admin"], name: "Admin" };
const actorOther: SaleVoidActor = { uid: "other-1", roles: ["prices_admin"], name: "Otro" };
const when = "2026-11-13T18:00:00.000Z";

const own = planSaleVoid(actorSeller, when, {
  sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 5, appliedPrice: 40 })]),
  balances: [balance(0)],
  stock: [stock("seller-1", "inv-1", "p1", 5)],
  queue: { ownerUid: "seller-1", sellerUid: "seller-1", lines: [queueLine("sale-1", 0), queueLine("older", 0, "otro")] },
});
check("seller voids own pending sale", own.status === "voided");
if (own.status === "voided") {
  check("stock returns to the seller counter", own.stock.length === 1 && own.stock[0]?.ownerUid === "seller-1" && own.stock[0]?.soldPackages === 0);
  check("sale is marked voided without rewriting the line", own.sale.status === "ANULADA" && own.sale.voidedByUid === "seller-1" && own.sale.lines[0]?.appliedPrice === 40 && own.sale.lines[0]?.quantity === 5);
  check("pending commission is cleared", own.balances[0]?.balance.generated === 0 && own.balances[0]?.balance.paid === 0 && own.balances[0]?.create === false);
  check("voided line leaves the queue and the other line stays", own.queue?.lines.length === 1 && own.queue?.lines[0]?.saleId === "older");
}

const adminStock = [
  stock("seller-1", "inv-2", "p9", 4),
  stock("admin-1", "inv-2", "p9", 9),
];
const asAdmin = planSaleVoid(actorAdmin, when, {
  sale: sale([line({ inventoryId: "inv-2", productId: "p9", quantity: 3 })]),
  balances: [{ ...balance(0), ownerUid: "seller-1", inventoryId: "inv-2", productId: "p9" }],
  stock: adminStock,
  queue: null,
});
check("admin voids another seller", asAdmin.status === "voided");
if (asAdmin.status === "voided") {
  check("packages return to the original seller", asAdmin.stock.length === 1 && asAdmin.stock[0]?.ownerUid === "seller-1" && asAdmin.stock[0]?.soldPackages === 1);
  check("admin counter is not changed", !asAdmin.stock.some((item) => item.ownerUid === "admin-1"));
}

const denied = planSaleVoid(actorOther, when, {
  sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 1 })]),
  balances: [balance(0)],
  stock: [stock("seller-1", "inv-1", "p1", 1)],
  queue: null,
});
check("another role cannot void someone else's sale", denied.status === "rejected" && denied.status === "rejected");
check("denied void does not describe a stock change", denied.status !== "voided");

const ownOtherRole = planSaleVoid(
  { uid: "seller-1", roles: ["prices_admin"], name: "Ana" },
  when,
  {
    sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 1 })]),
    balances: [balance(0)],
    stock: [stock("seller-1", "inv-1", "p1", 2)],
    queue: null,
  },
);
check("any role can void their own sale", ownOtherRole.status === "voided" && canVoidSale("seller-1", ["contador"], "seller-1"));

const paid = planSaleVoid(actorSeller, when, {
  sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 1 })]),
  balances: [balance(0, 4)],
  stock: [stock("seller-1", "inv-1", "p1", 1)],
  queue: { ownerUid: "seller-1", sellerUid: "seller-1", lines: [queueLine("sale-1", 0)] },
});
check("paid commission rejects the whole void", paid.status === "rejected");

const again = planSaleVoid(actorSeller, when, {
  sale: { ...sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 5 })]), status: "ANULADA" },
  balances: [balance(0)],
  stock: [stock("seller-1", "inv-1", "p1", 5)],
  queue: null,
});
check("a second void does not return packages again", again.status === "already");

const missing = planSaleVoid(actorSeller, when, {
  sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 2 })]),
  balances: [balance(0)],
  stock: [],
  queue: null,
});
const negative = planSaleVoid(actorSeller, when, {
  sale: sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 4 })]),
  balances: [balance(0)],
  stock: [stock("seller-1", "inv-1", "p1", 3)],
  queue: null,
});
check("missing counter rejects the void", missing.status === "rejected");
check("negative counter rejects the void", negative.status === "rejected");

const repeated = planSaleVoid(actorSeller, when, {
  sale: sale([
    line({ inventoryId: "inv-1", productId: "p1", quantity: 2 }),
    line({ inventoryId: "inv-9", productId: "p2", quantity: 1 }),
    line({ inventoryId: "inv-1", productId: "p1", quantity: 3 }),
  ]),
  balances: [balance(0), balance(1), balance(2)],
  stock: [stock("seller-1", "inv-1", "p1", 10), stock("seller-1", "inv-9", "p2", 4)],
  queue: null,
});
check("repeated products are grouped once", repeated.status === "voided");
if (repeated.status === "voided") {
  const same = repeated.stock.find((item) => item.productId === "p1");
  const other = repeated.stock.find((item) => item.productId === "p2");
  check("grouped quantity is subtracted once", same?.soldPackages === 5 && other?.soldPackages === 3 && repeated.stock.length === 2);
}

const fifo: CommissionQueue = {
  ownerUid: "seller-1",
  sellerUid: "seller-1",
  lines: [queueLine("before", 0, "a"), queueLine("sale-1", 1, "b"), queueLine("middle", 0, "c"), queueLine("sale-1", 0, "d"), queueLine("after", 2, "e")],
};
const kept = planSaleVoid(actorSeller, when, {
  sale: sale([
    line({ inventoryId: "inv-1", productId: "p1", quantity: 1 }),
    line({ inventoryId: "inv-1", productId: "p2", quantity: 1 }),
  ]),
  balances: [balance(0), balance(1)],
  stock: [stock("seller-1", "inv-1", "p1", 1), stock("seller-1", "inv-1", "p2", 1)],
  queue: fifo,
});
check("fifo keeps the other lines in order", kept.status === "voided" && kept.status === "voided");
if (kept.status === "voided") {
  check("remaining queue order is unchanged", kept.queue?.lines.map((item) => `${item.saleId}:${item.lineIndex}`).join(",") === "before:0,middle:0,after:2");
}

const active = sale([line({ inventoryId: "inv-1", productId: "p1", quantity: 1 })]);
const voided = { ...active, status: "ANULADA" as const };
check("repair skips a voided sale", shouldRepairSaleBalances(voided) === false && shouldRepairSaleBalances(active) === true);

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
console.log("sale void ok");
