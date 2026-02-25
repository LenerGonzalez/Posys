// src/Services/baseSummaryCandies.ts
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";
import { format } from "date-fns";

type SaleType = "CONTADO" | "CREDITO";

export type BaseSummaryCandies = {
  // paquetes
  packsCash: number;
  packsCredit: number;

  // ventas
  salesCash: number;
  salesCredit: number;

  // abonos del periodo (cobranza real)
  abonosPeriodo: number;

  // saldo base (plata real): ventas cash + abonos + downPayments (si existen)
  saldoBase: number;

  // comisiones (totales)
  comisionCash: number;
  comisionCredit: number;

  // comisiones por vendedor para cards
  comisionesCashBySeller: {
    sellerId: string;
    sellerName: string;
    amount: number;
  }[];
  comisionesCreditBySeller: {
    sellerId: string;
    sellerName: string;
    amount: number;
  }[];
};

type Seller = { id: string; name: string; commissionPercent: number };

function ensureDate(x: any): string {
  if (x?.date) return x.date;
  if (x?.createdAt?.toDate) return format(x.createdAt.toDate(), "yyyy-MM-dd");
  return "";
}

function normalizeSale(d: any, id: string) {
  const date = ensureDate(d);
  if (!date) return null;

  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];

  // quantity = paquetes
  let quantity = 0;
  let total = 0;

  // comisión por items (margenVendedor)
  let commissionFromItems = 0;

  if (itemsArray.length > 0) {
    quantity = itemsArray.reduce(
      (acc: number, it: any) =>
        acc + (Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0),
      0,
    );

    total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
    if (!total) {
      total = itemsArray.reduce(
        (acc: number, it: any) =>
          acc + (Number(it.total ?? it.lineFinal ?? 0) || 0),
        0,
      );
    }

    commissionFromItems = itemsArray.reduce(
      (acc: number, it: any) => acc + (Number(it.margenVendedor || 0) || 0),
      0,
    );
  } else {
    quantity =
      Number(
        d.packagesTotal ?? d.quantity ?? d.item?.packages ?? d.item?.qty ?? 0,
      ) || 0;
    total = Number(d.total ?? d.item?.total ?? 0) || 0;
  }

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total: Number(total || 0),
    quantity: Number(quantity || 0),
    downPayment: Number(d.downPayment || 0) || 0,
    vendorId: d.vendorId || "",
    vendorName: d.vendorName || d.vendor || "",
    vendorCommissionAmount: Number(d.vendorCommissionAmount || 0) || 0,
    vendorCommissionPercent: Number(d.vendorCommissionPercent || 0) || 0,
    commissionFromItems: Number(commissionFromItems || 0) || 0,
  };
}

// Comisión histórica (preferida), fallback a sellers_candies
function getCommissionAmount(
  sale: any,
  sellersById: Record<string, Seller>,
): number {
  const itemsCommission = Number(sale.commissionFromItems || 0);
  if (itemsCommission > 0) return Number(itemsCommission.toFixed(2));

  const stored = Number(sale.vendorCommissionAmount || 0);
  if (stored > 0) return Number(stored.toFixed(2));

  const vendorId = String(sale.vendorId || "");
  if (!vendorId) return 0;

  const v = sellersById[vendorId];
  if (!v || !v.commissionPercent) return 0;

  const calc =
    ((Number(sale.total) || 0) * (Number(v.commissionPercent) || 0)) / 100;
  return Number(calc.toFixed(2));
}

function pickAmountAR(x: any): number {
  // intenta agarrar el "monto recibido" en ar_movements
  const candidates = [
    x.amount,
    x.amountPaid,
    x.paidAmount,
    x.paymentAmount,
    x.value,
    x.total,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 0;
}

export async function fetchBaseSummaryCandies(
  from: string,
  to: string,
): Promise<BaseSummaryCandies> {
  // 1) sellers (para fallback de comisión)
  const sellersSnap = await getDocs(collection(db, "sellers_candies"));
  const sellers: Seller[] = sellersSnap.docs.map((d) => {
    const x = d.data() as any;
    return {
      id: d.id,
      name: x.name || "",
      commissionPercent: Number(x.commissionPercent || 0) || 0,
    };
  });
  const sellersById: Record<string, Seller> = {};
  for (const s of sellers) sellersById[s.id] = s;

  // 2) ventas en rango (sales_candies)
  const salesSnap = await getDocs(
    query(collection(db, "sales_candies"), orderBy("createdAt", "desc")),
  );
  const sales: any[] = [];
  salesSnap.forEach((d) => {
    const sale = normalizeSale(d.data(), d.id);
    if (!sale) return;
    if (sale.date >= from && sale.date <= to) sales.push(sale);
  });

  // 3) abonos en rango (ar_movements)
  // NOTA: asumimos que ar_movements tiene field "date" tipo yyyy-MM-dd (si no, ajustamos).
  const arQ = query(
    collection(db, "ar_movements"),
    where("date", ">=", from),
    where("date", "<=", to),
    orderBy("date", "asc"),
  );
  const arSnap = await getDocs(arQ);
  const abonosPeriodo = arSnap.docs.reduce(
    (acc, d) => acc + pickAmountAR(d.data()),
    0,
  );

  let packsCash = 0,
    packsCredit = 0;
  let salesCash = 0,
    salesCredit = 0;
  let downPayments = 0;

  let comisionCash = 0,
    comisionCredit = 0;

  const comCashBySeller: Record<
    string,
    { sellerId: string; sellerName: string; amount: number }
  > = {};
  const comCreditBySeller: Record<
    string,
    { sellerId: string; sellerName: string; amount: number }
  > = {};

  for (const s of sales) {
    const comm = getCommissionAmount(s, sellersById);
    const vendorId = String(s.vendorId || "");
    const vendorName = String(
      s.vendorName || (vendorId ? sellersById[vendorId]?.name : "") || "",
    );

    if (s.type === "CONTADO") {
      packsCash += Number(s.quantity || 0);
      salesCash += Number(s.total || 0);
      comisionCash += comm;

      if (vendorId) {
        if (!comCashBySeller[vendorId]) {
          comCashBySeller[vendorId] = {
            sellerId: vendorId,
            sellerName: vendorName || "—",
            amount: 0,
          };
        }
        comCashBySeller[vendorId].amount += comm;
      }
    } else {
      packsCredit += Number(s.quantity || 0);
      salesCredit += Number(s.total || 0);
      comisionCredit += comm;

      // downPayment de crédito sí es caja
      downPayments += Number(s.downPayment || 0);

      if (vendorId) {
        if (!comCreditBySeller[vendorId]) {
          comCreditBySeller[vendorId] = {
            sellerId: vendorId,
            sellerName: vendorName || "—",
            amount: 0,
          };
        }
        comCreditBySeller[vendorId].amount += comm;
      }
    }
  }

  const saldoBase =
    Number(salesCash || 0) +
    Number(abonosPeriodo || 0) +
    Number(downPayments || 0);

  const comisionesCashBySeller = Object.values(comCashBySeller)
    .map((x) => ({ ...x, amount: Number((x.amount || 0).toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  const comisionesCreditBySeller = Object.values(comCreditBySeller)
    .map((x) => ({ ...x, amount: Number((x.amount || 0).toFixed(2)) }))
    .sort((a, b) => b.amount - a.amount);

  return {
    packsCash,
    packsCredit,
    salesCash,
    salesCredit,
    abonosPeriodo,
    saldoBase,
    comisionCash: Number((comisionCash || 0).toFixed(2)),
    comisionCredit: Number((comisionCredit || 0).toFixed(2)),
    comisionesCashBySeller,
    comisionesCreditBySeller,
  };
}
