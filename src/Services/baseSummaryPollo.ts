import { collection, getDocs, query, where } from "firebase/firestore";
import { db } from "../firebase";

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;

const mStr = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .trim();
const isLb = (m: unknown) => ["lb", "lbs", "libra", "libras"].includes(mStr(m));
// ✅ si NO es lb => unidad (igual que en tu CierreVentas)
const isUnit = (m: unknown) => !isLb(m);

export type BaseSummary = {
  lbsCash: number;
  lbsCredit: number;
  unitsCash: number;
  unitsCredit: number;
  salesCash: number;
  salesCredit: number;
  abonosPeriodo: number;
  saldoBase: number; // ventasCash + abonosPeriodo
};

export async function fetchBaseSummaryPollo(
  from: string,
  to: string,
): Promise<BaseSummary> {
  // 1) ventas
  const qs = query(
    collection(db, "salesV2"),
    where("date", ">=", from),
    where("date", "<=", to),
  );
  const sSnap = await getDocs(qs);

  type Row = {
    quantity: number;
    amount: number;
    measurement?: string;
    type: "CREDITO" | "CONTADO";
  };

  const rows: Row[] = [];

  sSnap.forEach((d) => {
    const x = d.data() as any;

    if (Array.isArray(x.items) && x.items.length > 0) {
      x.items.forEach((it: any) => {
        const qty = Number(it.qty ?? 0);
        const lineFinal =
          Number(it.lineFinal ?? 0) ||
          Math.max(
            0,
            Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
          );

        rows.push({
          quantity: qty,
          amount: Number(lineFinal || 0),
          measurement: it.measurement ?? x.measurement ?? "",
          type: (x.type ?? "CONTADO") as any,
        });
      });
      return;
    }

    rows.push({
      quantity: Number(x.quantity ?? 0),
      amount: Number(x.amount ?? x.amountCharged ?? 0),
      measurement: x.measurement ?? "",
      type: (x.type ?? "CONTADO") as any,
    });
  });

  const cash = rows.filter((r) => r.type === "CONTADO");
  const credit = rows.filter((r) => r.type === "CREDITO");

  const lbsCash = round3(
    cash.filter((r) => isLb(r.measurement)).reduce((a, r) => a + r.quantity, 0),
  );
  const lbsCredit = round3(
    credit
      .filter((r) => isLb(r.measurement))
      .reduce((a, r) => a + r.quantity, 0),
  );

  const unitsCash = round3(
    cash
      .filter((r) => isUnit(r.measurement))
      .reduce((a, r) => a + r.quantity, 0),
  );
  const unitsCredit = round3(
    credit
      .filter((r) => isUnit(r.measurement))
      .reduce((a, r) => a + r.quantity, 0),
  );

  const salesCash = round2(cash.reduce((a, r) => a + r.amount, 0));
  const salesCredit = round2(credit.reduce((a, r) => a + r.amount, 0));

  // 2) abonos del periodo (ar_movements_pollo)
  const qar = query(
    collection(db, "ar_movements_pollo"),
    where("date", ">=", from),
    where("date", "<=", to),
  );
  const arSnap = await getDocs(qar);

  let abonosPeriodo = 0;
  arSnap.forEach((d) => {
    const m = d.data() as any;
    const type = String(m.type ?? "")
      .trim()
      .toUpperCase();
    if (type === "ABONO") {
      abonosPeriodo += Math.abs(Number(m.amount ?? 0)); // ✅ vienen negativos
    }
  });
  abonosPeriodo = round2(abonosPeriodo);

  return {
    lbsCash,
    lbsCredit,
    unitsCash,
    unitsCredit,
    salesCash,
    salesCredit,
    abonosPeriodo,
    saldoBase: round2(salesCash + abonosPeriodo),
  };
}
