/**
 * Comisión del vendedor atribuible a cada abono ligado a una venta (ref.saleId):
 * comisión del abono = comisión total de la venta × (monto abonado / total venta).
 * Persiste en ar_movements: commissionOnPayment, commissionBreakdown.
 */
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

const round2 = (n: number) =>
  Math.round((Number(n) || 0) * 100) / 100;

export type CommissionBreakdownEntry = {
  saleId: string;
  appliedAmount: number;
  saleTotal: number;
  saleCommissionTotal: number;
  commissionPortion: number;
};

type SellerComm = { commissionPercent: number };

export function saleTotalFromDoc(d: any): number {
  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];
  if (itemsArray.length > 0) {
    let total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
    if (!total) {
      total = itemsArray.reduce(
        (acc: number, it: any) =>
          acc + (Number(it.total ?? it.lineFinal ?? 0) || 0),
        0,
      );
    }
    return Number(total || 0);
  }
  return Number(d.total ?? d.item?.total ?? 0) || 0;
}

/** Misma lógica que baseSummaryCandies.getCommissionAmount */
export function commissionFromSaleDoc(
  d: any,
  sellersById: Record<string, SellerComm>,
): number {
  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];

  let commissionFromItems = 0;
  if (itemsArray.length > 0) {
    commissionFromItems = itemsArray.reduce(
      (acc: number, it: any) => acc + (Number(it.margenVendedor || 0) || 0),
      0,
    );
  }
  if (commissionFromItems > 0) return round2(commissionFromItems);

  const stored = Number(d.vendorCommissionAmount || 0);
  if (stored > 0) return round2(stored);

  const vendorId = String(d.vendorId || "");
  if (!vendorId) return 0;
  const v = sellersById[vendorId];
  if (!v?.commissionPercent) return 0;
  const total = saleTotalFromDoc(d);
  const calc = (total * (Number(v.commissionPercent) || 0)) / 100;
  return round2(calc);
}

export async function fetchSellersCandiesCommissionMap(): Promise<
  Record<string, SellerComm>
> {
  const snap = await getDocs(collection(db, "sellers_candies"));
  const m: Record<string, SellerComm> = {};
  snap.forEach((d) => {
    const x = d.data() as any;
    m[d.id] = {
      commissionPercent: Number(x.commissionPercent || 0) || 0,
    };
  });
  return m;
}

export async function buildSaleMetaMap(
  saleIds: string[],
  sellersById: Record<string, SellerComm>,
): Promise<Record<string, { total: number; commission: number }>> {
  const uniq = [...new Set(saleIds.filter(Boolean))];
  const map: Record<string, { total: number; commission: number }> = {};
  await Promise.all(
    uniq.map(async (id) => {
      try {
        const snap = await getDoc(doc(db, "sales_candies", id));
        if (!snap.exists()) return;
        const data = snap.data() as any;
        if (String(data.type || "CONTADO").toUpperCase() !== "CREDITO") return;
        const total = saleTotalFromDoc(data);
        const commission = commissionFromSaleDoc(data, sellersById);
        map[id] = { total, commission };
      } catch {
        /* ignore */
      }
    }),
  );
  return map;
}

function commissionForAbonoOnSale(
  meta: { total: number; commission: number },
  abonoAbs: number,
): { commissionOnPayment: number; commissionBreakdown: CommissionBreakdownEntry[] } {
  const total = Number(meta.total || 0);
  const comm = Number(meta.commission || 0);
  const pay = Math.abs(Number(abonoAbs || 0));
  if (!(total > 0) || !(pay > 0)) {
    return { commissionOnPayment: 0, commissionBreakdown: [] };
  }
  const portion = round2((comm * pay) / total);
  const entry: CommissionBreakdownEntry = {
    saleId: "",
    appliedAmount: round2(pay),
    saleTotal: round2(total),
    saleCommissionTotal: round2(comm),
    commissionPortion: portion,
  };
  return {
    commissionOnPayment: portion,
    commissionBreakdown: [entry],
  };
}

/**
 * Recalcula y guarda commissionOnPayment / commissionBreakdown en todos los ABONOS del cliente.
 * Abonos con ref.saleId: proporcional a la comisión total de esa venta.
 * Abonos sin venta: 0.
 */
export async function syncAbonoCommissionsForCustomer(
  customerId: string,
): Promise<void> {
  if (!customerId) return;

  const mSnap = await getDocs(
    query(collection(db, "ar_movements"), where("customerId", "==", customerId)),
  );

  type M = {
    id: string;
    amount: number;
    ref?: { saleId?: string };
  };

  const movements: M[] = mSnap.docs.map((d) => {
    const x = d.data() as any;
    return {
      id: d.id,
      amount: Number(x.amount || 0),
      ref: x.ref,
    };
  });

  const saleIdsFromAbonos = movements
    .filter((m) => m.amount < 0 && m.ref?.saleId)
    .map((m) => String(m.ref!.saleId));

  const sellersById = await fetchSellersCandiesCommissionMap();
  const saleMeta = await buildSaleMetaMap(saleIdsFromAbonos, sellersById);

  let batch = writeBatch(db);
  let count = 0;
  for (const m of movements) {
    if (m.amount >= 0) continue;
    const ref = doc(db, "ar_movements", m.id);
    const sid = String(m.ref?.saleId || "").trim();
    if (!sid) {
      batch.update(ref, {
        commissionOnPayment: 0,
        commissionBreakdown: [],
      });
    } else {
      const meta = saleMeta[sid];
      if (!meta) {
        batch.update(ref, {
          commissionOnPayment: 0,
          commissionBreakdown: [],
        });
      } else {
        const { commissionOnPayment, commissionBreakdown } =
          commissionForAbonoOnSale(meta, Math.abs(m.amount));
        const bd = commissionBreakdown.map((b) => ({
          ...b,
          saleId: sid,
        }));
        batch.update(ref, {
          commissionOnPayment,
          commissionBreakdown: bd,
        });
      }
    }
    count++;
    if (count >= 400) {
      await batch.commit();
      batch = writeBatch(db);
      count = 0;
    }
  }
  if (count > 0) await batch.commit();
}
