import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
  getDoc,
  orderBy,
  query,
  serverTimestamp,
  where,
  deleteDoc,
  doc,
  updateDoc,
} from "firebase/firestore";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Toast from "../common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";
import {
  fetchBaseSummaryPollo,
  type BaseSummary,
} from "../../Services/baseSummaryPollo";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerMoneyStrip,
  DrawerSectionTitle,
  DrawerDetailDlCard,
} from "../common/DrawerContentCards";

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");
const firstOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};
const lastOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth() + 1, 0), "yyyy-MM-dd");
};

const rowBgByType = (type: string): string => {
  switch (type) {
    case "VENTA_CASH":
    case "ABONO":
      return "bg-green-50/60";
    case "GASTO":
      return "bg-red-50/60";
    case "REABASTECIMIENTO":
      return "bg-blue-50/60";
    case "RETIRO":
    case "DEPOSITO":
    case "PERDIDA":
      return "bg-orange-50/60";
    case "CORTE":
      return "bg-purple-50/60";
    case "PRESTAMO A NEGOCIO POR DUENO":
      return "bg-amber-50/60";
    case "DEVOLUCION A DUENO POR PRESTAMO":
      return "bg-emerald-50/60";
    case "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":
      return "bg-sky-50/60";
    default:
      return "";
  }
};

const borderByType = (type: string): string => {
  switch (type) {
    case "VENTA_CASH":
    case "ABONO":
      return "border-l-4 border-l-green-400";
    case "GASTO":
      return "border-l-4 border-l-red-400";
    case "REABASTECIMIENTO":
      return "border-l-4 border-l-blue-400";
    case "RETIRO":
    case "DEPOSITO":
    case "PERDIDA":
      return "border-l-4 border-l-orange-400";
    case "CORTE":
      return "border-l-4 border-l-purple-500";
    case "PRESTAMO A NEGOCIO POR DUENO":
      return "border-l-4 border-l-amber-400";
    case "DEVOLUCION A DUENO POR PRESTAMO":
      return "border-l-4 border-l-emerald-400";
    case "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":
      return "border-l-4 border-l-sky-400";
    default:
      return "border-l-4 border-l-gray-200";
  }
};

const BADGE_CFG: Record<string, { label: string; cls: string }> = {
  VENTA_CASH:         { label: "VENTA CASH",    cls: "bg-green-100 text-green-800 border-green-200" },
  ABONO:              { label: "ABONO",          cls: "bg-emerald-100 text-emerald-800 border-emerald-200" },
  GASTO:              { label: "GASTO",          cls: "bg-red-100 text-red-800 border-red-200" },
  REABASTECIMIENTO:   { label: "REABAST.",       cls: "bg-blue-100 text-blue-800 border-blue-200" },
  RETIRO:             { label: "RETIRO",         cls: "bg-orange-100 text-orange-800 border-orange-200" },
  AJUSTE:             { label: "AJUSTE",         cls: "bg-gray-100 text-gray-800 border-gray-200" },
  DEPOSITO:           { label: "DEPÓSITO",       cls: "bg-orange-100 text-orange-800 border-orange-200" },
  PERDIDA:            { label: "PÉRDIDA",        cls: "bg-rose-100 text-rose-800 border-rose-200" },
  CORTE:              { label: "✂ CORTE",        cls: "bg-purple-100 text-purple-800 border-purple-200 font-semibold" },
  "PRESTAMO A NEGOCIO POR DUENO":                  { label: "PRÉSTAMO",       cls: "bg-red-100 text-red-800 border-red-200" },
  "DEVOLUCION A DUENO POR PRESTAMO":               { label: "PAGO PRÉSTAMO", cls: "bg-green-100 text-green-800 border-green-200" },
  "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)":   { label: "COMPRA DIRECTA", cls: "bg-sky-100 text-sky-800 border-sky-200" },
};

const typeBadge = (type: string) => {
  const c = BADGE_CFG[type] ?? { label: type, cls: "bg-gray-100 text-gray-700 border-gray-200" };
  return (
    <span className={`text-[11px] px-2 py-[2px] rounded-full border whitespace-nowrap font-medium ${c.cls}`}>
      {c.label}
    </span>
  );
};

type BatchDetail = {
  id: string;
  productName: string;
  date: string;
  unit: string;
  remaining: number;
  salePrice: number;
  totalValue: number;
};

type SaleRow = {
  id: string;
  date: string;
  customer: string;
  type: string;
  amount: number;
};

type AbonoRow = {
  id: string;
  date: string;
  customer: string;
  amount: number;
};

type LedgerType =
  | "VENTA_CASH"
  | "ABONO"
  | "GASTO"
  | "REABASTECIMIENTO"
  | "RETIRO"
  | "AJUSTE"
  | "DEPOSITO"
  | "PERDIDA"
  | "CORTE"
  | "PRESTAMO A NEGOCIO POR DUENO"
  | "DEVOLUCION A DUENO POR PRESTAMO"
  | "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";

type LedgerRow = {
  id: string;
  date: string; // yyyy-MM-dd
  type: LedgerType;
  description: string;
  reference?: string;
  inAmount: number; // entrada +
  outAmount: number; // salida -
  createdAt?: any;
  createdBy?: { uid?: string | null; email?: string | null } | null;
};

export default function EstadoCuentaPollo(): React.ReactElement {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(lastOfMonth());
  const [loading, setLoading] = useState(true);

  const [base, setBase] = useState<BaseSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [invLbsRem, setInvLbsRem] = useState<number>(0);
  const [invUdsRem, setInvUdsRem] = useState<number>(0);
  const [invExistenciasMonetarias, setInvExistenciasMonetarias] =
    useState<number>(0);
  const [batchDetails, setBatchDetails] = useState<BatchDetail[]>([]);
  const [salesRows, setSalesRows] = useState<SaleRow[]>([]);
  const [abonosRows, setAbonosRows] = useState<AbonoRow[]>([]);
  const [kpiDrawer, setKpiDrawer] = useState<"existencias" | "saldo" | null>(null);

  // form
  const [date, setDate] = useState(today());
  const [type, setType] = useState<LedgerType>("GASTO");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [inAmount, setInAmount] = useState<string>("");
  const [outAmount, setOutAmount] = useState<string>("");

  const { refreshKey, refresh } = useManualRefresh();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionOpenId, setActionOpenId] = useState<string | null>(null);
  const [collapseLibras, setCollapseLibras] = useState(true);
  const [collapseUnidades, setCollapseUnidades] = useState(true);
  const [collapseVentas, setCollapseVentas] = useState(true);
  /** Web: bloque Préstamo / compras / salidas — colapsado por defecto */
  const [collapseCajaFlowKpis, setCollapseCajaFlowKpis] = useState(true);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const allCollapsed = collapseLibras && collapseUnidades && collapseVentas;
  const toggleAllKpis = () => {
    const next = !allCollapsed;
    setCollapseLibras(next);
    setCollapseUnidades(next);
    setCollapseVentas(next);
  };
  const actionMenuRef = useRef<HTMLDivElement | null>(null);
  const [movementTypeFilter, setMovementTypeFilter] = useState<string>("ALL");
  const [toastMsg, setToastMsg] = useState("");

  // ========= helpers: qué tipos afectan CAJA =========
  const affectsCash = (t: LedgerType) => {
    // Caja (cash) SOLO se mueve si entra/sale efectivo real.
    // Compra directa por dueño NO entra a caja.
    return t !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";
  };

  const affectsOwnerDebt = (t: LedgerType) =>
    t === "PRESTAMO A NEGOCIO POR DUENO" ||
    t === "DEVOLUCION A DUENO POR PRESTAMO" ||
    t === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)";

  // 1) cargar KPIs base (ventas + abonos)
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const summary = await fetchBaseSummaryPollo(from, to);
        setBase(summary);
      } catch (e) {
        console.error("Error base summary:", e);
        setBase(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, refreshKey]);

  // 2) cargar movimientos manuales (ledger)
  useEffect(() => {
    (async () => {
      try {
        const qLed = query(
          collection(db, "cash_ledger_pollo"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qLed);
        const ledgerRows: LedgerRow[] = snap.docs.map(
          (d) =>
            ({
              id: d.id,
              ...(d.data() as any),
              source: "ledger",
            }) as any,
        );

        const qExp = query(
          collection(db, "expenses"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const expSnap = await getDocs(qExp);
        const expenseRows: LedgerRow[] = expSnap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: `exp_${d.id}`,
            date: x.date || today(),
            type: "GASTO",
            description: x.description || "Gasto",
            reference: x.category || x.reference || null,
            inAmount: 0,
            outAmount: Number(x.amount || 0),
            createdAt: x.createdAt ?? null,
            createdBy: x.createdBy ?? null,
            source: "expenses",
          } as any;
        });

        const merged = [...ledgerRows, ...expenseRows].sort((a, b) =>
          (a.date || "").localeCompare(b.date || ""),
        );
        // try to fill missing createdBy.name by reading `users` collection
        const uids = Array.from(
          new Set(
            merged
              .map((m) => m.createdBy?.uid)
              .filter((x): x is string => Boolean(x) && x !== ""),
          ),
        );

        if (uids.length) {
          const updated = [...merged];
          await Promise.all(
            uids.map(async (uid) => {
              const need = updated.some(
                (r) => r.createdBy?.uid === uid && !r.createdBy?.name,
              );
              if (!need) return;
              try {
                const udoc = await getDoc(doc(db, "users", uid));
                if (!udoc.exists()) return;
                const udata = udoc.data() as any;
                const uname =
                  udata?.name || udata?.displayName || udata?.email || null;
                if (!uname) return;
                for (let i = 0; i < updated.length; i++) {
                  if (updated[i].createdBy?.uid === uid) {
                    updated[i] = {
                      ...updated[i],
                      createdBy: {
                        ...(updated[i].createdBy || {}),
                        name: updated[i].createdBy?.name || uname,
                      },
                    } as any;
                  }
                }
              } catch (err) {
                console.warn("No se pudo cargar user doc for uid", uid, err);
              }
            }),
          );
          setLedger(updated as LedgerRow[]);
        } else {
          setLedger(merged as LedgerRow[]);
        }
      } catch (e) {
        console.error("Error ledger:", e);
        setLedger([]);
      }
    })();
  }, [from, to, refreshKey]);

  // 3) cargar existencias desde inventory_batches (para KPI Existencias)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!from || !to) return;
        const q = query(
          collection(db, "inventory_batches"),
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          where("date", ">=", from),
          // @ts-ignore
          where("date", "<=", to),
        );
        const snap = await getDocs(q);

        const isPounds = (u: string) => {
          const s = (u || "").toLowerCase();
          return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
        };

        let lbs = 0;
        let uds = 0;
        let moneySum = 0;
        const details: BatchDetail[] = [];

        snap.forEach((d) => {
          const b = d.data() as any;
          const remaining = Number(b.remaining || 0);
          const qty = Number(b.quantity || 0) || 1;
          let unitPrice = Number(b.salePrice || 0) || 0;
          if (!unitPrice) {
            const expected = Number(b.expectedTotal || 0);
            unitPrice = qty ? expected / qty : 0;
          }

          if (isPounds(String(b.unit || ""))) {
            lbs += remaining;
          } else {
            uds += remaining;
          }

          moneySum += remaining * unitPrice;

          if (remaining > 0) {
            details.push({
              id: d.id,
              productName: b.productName || b.product || "Sin nombre",
              date: b.date || "",
              unit: b.unit || "ud",
              remaining,
              salePrice: unitPrice,
              totalValue: Number((remaining * unitPrice).toFixed(2)),
            });
          }
        });

        if (!mounted) return;
        setInvLbsRem(Number(lbs.toFixed(3)));
        setInvUdsRem(Number(uds.toFixed(3)));
        setInvExistenciasMonetarias(Number(moneySum.toFixed(2)));
        setBatchDetails(details.sort((a, b) => a.productName.localeCompare(b.productName)));
      } catch (e) {
        console.error("Error cargando existencias para KPI Existencias:", e);
        if (mounted) {
          setInvLbsRem(0);
          setInvUdsRem(0);
          setInvExistenciasMonetarias(0);
        }
      }
    })();

    return () => {
      mounted = false;
    };
  }, [from, to, refreshKey]);

  // 4) cargar detalle ventas cash + abonos (para drawer Saldo Inicial)
  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        if (!from || !to) return;
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", from),
          where("date", "<=", to),
        );
        const sSnap = await getDocs(qs);
        const sales: SaleRow[] = [];
        sSnap.forEach((d) => {
          const x = d.data() as any;
          if (String(x.type ?? "CONTADO").toUpperCase() !== "CONTADO") return;
          const total = Array.isArray(x.items) && x.items.length > 0
            ? x.items.reduce((a: number, it: any) => a + Number(it.lineFinal ?? 0), 0)
            : Number(x.amount ?? x.amountCharged ?? 0);
          sales.push({
            id: d.id,
            date: x.date || "",
            customer: x.customerName || x.customer || "—",
            type: "CONTADO",
            amount: Number(total.toFixed(2)),
          });
        });

        const qar = query(
          collection(db, "ar_movements_pollo"),
          where("date", ">=", from),
          where("date", "<=", to),
        );
        const arSnap = await getDocs(qar);
        const abonos: AbonoRow[] = [];
        arSnap.forEach((d) => {
          const m = d.data() as any;
          if (String(m.type ?? "").trim().toUpperCase() !== "ABONO") return;
          abonos.push({
            id: d.id,
            date: m.date || "",
            customer: m.customerName || m.customer || "—",
            amount: Math.abs(Number(m.amount ?? 0)),
          });
        });

        if (!mounted) return;
        setSalesRows(sales.sort((a, b) => a.date.localeCompare(b.date)));
        setAbonosRows(abonos.sort((a, b) => a.date.localeCompare(b.date)));
      } catch (e) {
        console.error("Error cargando detalle ventas/abonos:", e);
      }
    })();
    return () => { mounted = false; };
  }, [from, to, refreshKey]);

  // saldo base: ventas cash + abonos
  const saldoBase = base?.saldoBase ?? 0;

  // ========= Balance CAJA (NO se infla) =========
  const ledgerWithCashBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    const rows = [...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );

    return rows.map((r: any) => {
      const cashIn = affectsCash(r.type) ? Number(r.inAmount || 0) : 0;
      const cashOut = affectsCash(r.type) ? Number(r.outAmount || 0) : 0;
      bal = bal + cashIn - cashOut;
      return { ...r, cashBalance: bal };
    });
  }, [ledger, saldoBase]);

  const saldoFinalCaja = ledgerWithCashBalance.length
    ? (ledgerWithCashBalance[ledgerWithCashBalance.length - 1] as any)
        .cashBalance
    : saldoBase;

  // ========= Balance CONTABLE (como lo tenías antes) =========
  const ledgerWithAccountingBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    const rows = [...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );

    return rows.map((r: any) => {
      bal = bal + Number(r.inAmount || 0) - Number(r.outAmount || 0);
      return { ...r, accountingBalance: bal };
    });
  }, [ledger, saldoBase]);

  const saldoFinalContable = ledgerWithAccountingBalance.length
    ? (
        ledgerWithAccountingBalance[
          ledgerWithAccountingBalance.length - 1
        ] as any
      ).accountingBalance
    : saldoBase;

  // Para tabla: usamos CAJA por defecto (lo que preguntaste: "cuánto deberían tener en mano")
  const ledgerWithBalance = useMemo(() => {
    // mezcla ambos para export y para no romper UI: balance=CAJA, pero guardamos contable también
    const byId = new Map<string, any>();
    for (const r of ledgerWithAccountingBalance as any[]) byId.set(r.id, r);
    return (ledgerWithCashBalance as any[]).map((r) => ({
      ...r,
      balance: r.cashBalance,
      accountingBalance: byId.get(r.id)?.accountingBalance ?? r.cashBalance,
    }));
  }, [ledgerWithCashBalance, ledgerWithAccountingBalance]);

  const saldoFinal = saldoFinalCaja;

  // Totales (KPI)
  const totals = useMemo(() => {
    // Entradas de caja reales (excluye compra directa)
    const inCashSum = ledger.reduce((a, r) => {
      if (!affectsCash(r.type)) return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const gastosSum = ledger.reduce((a, r) => {
      return r.type === "GASTO" ? a + Number(r.outAmount || 0) : a;
    }, 0);

    const outSumNonGastos = ledger.reduce((a, r) => {
      if (!affectsCash(r.type)) return a;
      return r.type === "GASTO" || r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a
        : a + Number(r.outAmount || 0);
    }, 0);

    const abonoDueno = ledger.reduce((a, r) => {
      return r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const reabastecimientoSum = ledger.reduce((a, r) => {
      // solo si salió de caja
      if (r.type !== "REABASTECIMIENTO") return a;
      return a + Number(r.outAmount || 0);
    }, 0);

    const comprasDirectasDueno = ledger.reduce((a, r) => {
      return r.type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)"
        ? a + Number(r.inAmount || 0)
        : a;
    }, 0);

    return {
      inCashSum,
      outSumNonGastos,
      gastosSum,
      abonoDueno,
      reabastecimientoSum,
      comprasDirectasDueno,
    };
  }, [ledger]);

  // Movement types available for filter (derived from loaded ledger)
  const movementTypes = useMemo(() => {
    const s = new Set<string>();
    s.add("ALL");
    for (const r of ledger) {
      if (r && (r as any).type) s.add(String((r as any).type));
    }
    return Array.from(s);
  }, [ledger]);

  const movementTypeFilterSelectOptions = useMemo(
    () =>
      movementTypes.map((t) => ({
        value: t,
        label: t === "ALL" ? "Todos" : t,
      })),
    [movementTypes],
  );

  const modalMovementTypeOptions = useMemo(
    () => [
      { value: "GASTO", label: "Gasto" },
      {
        value: "REABASTECIMIENTO",
        label: "Reabastecimiento (pagado con caja)",
      },
      { value: "RETIRO", label: "Retiro" },
      { value: "DEPOSITO", label: "Deposito a Carmen Ortiz" },
      { value: "CORTE", label: "Corte de caja (retiro total/parcial)" },
      { value: "PERDIDA", label: "Perdida por robo" },
      {
        value: "PRESTAMO A NEGOCIO POR DUENO",
        label: "Préstamo a negocio por dueño (ENTRA A CAJA)",
      },
      {
        value: "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
        label: "Compra directa por dueño (NO entra a caja)",
      },
      {
        value: "DEVOLUCION A DUENO POR PRESTAMO",
        label: "Devolución a dueño por préstamo (SALE de caja)",
      },
    ],
    [],
  );

  // Filtered ledger used for display (does not affect KPI totals)
  const filteredLedgerWithBalance = useMemo(() => {
    if (!movementTypeFilter || movementTypeFilter === "ALL")
      return ledgerWithBalance;
    return (ledgerWithBalance || []).filter(
      (r: any) => String(r.type || "") === movementTypeFilter,
    );
  }, [ledgerWithBalance, movementTypeFilter]);

  const tableTotals = useMemo(() => {
    let totalIn = 0;
    let totalOut = 0;
    for (const r of filteredLedgerWithBalance as any[]) {
      totalIn += Number(r.inAmount || 0);
      totalOut += Number(r.outAmount || 0);
    }
    return { totalIn, totalOut };
  }, [filteredLedgerWithBalance]);

  // Display totals depend on filter (para no romper tu lógica)
  const displayTotals = useMemo(() => {
    if (!movementTypeFilter || movementTypeFilter === "ALL") return totals;
    const rows = (ledger || []).filter(
      (r) => String((r as any).type || "") === movementTypeFilter,
    );

    const inCashSum = rows.reduce((a, r: any) => {
      if (!affectsCash(r.type)) return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const gastosSum = rows.reduce(
      (a: number, r: any) =>
        r.type === "GASTO" ? a + Number(r.outAmount || 0) : a,
      0,
    );

    const outSumNonGastos = rows.reduce((a: number, r: any) => {
      if (!affectsCash(r.type)) return a;
      return r.type === "GASTO" || r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a
        : a + Number(r.outAmount || 0);
    }, 0);

    const abonoDueno = rows.reduce((a: number, r: any) => {
      return r.type === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const reabastecimientoSum = rows.reduce((a: number, r: any) => {
      return r.type === "REABASTECIMIENTO" ? a + Number(r.outAmount || 0) : a;
    }, 0);

    const comprasDirectasDueno = rows.reduce((a: number, r: any) => {
      return r.type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)"
        ? a + Number(r.inAmount || 0)
        : a;
    }, 0);

    return {
      inCashSum,
      outSumNonGastos,
      gastosSum,
      abonoDueno,
      reabastecimientoSum,
      comprasDirectasDueno,
    };
  }, [ledger, movementTypeFilter, totals]);

  // KPI: deuda del negocio con el dueño
  const deudaDueno = useMemo(() => {
    const prestadoCaja = ledger.reduce((a, r) => {
      if (r.type !== "PRESTAMO A NEGOCIO POR DUENO") return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const compradoDirecto = ledger.reduce((a, r) => {
      if (r.type !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)") return a;
      return a + Number(r.inAmount || 0);
    }, 0);

    const devuelto = ledger.reduce((a, r) => {
      if (r.type !== "DEVOLUCION A DUENO POR PRESTAMO") return a;
      return a + Number(r.outAmount || 0);
    }, 0);

    // deuda = (prestamos + compras directas) - devoluciones
    return Math.max(
      0,
      Number(prestadoCaja || 0) +
        Number(compradoDirecto || 0) -
        Number(devuelto || 0),
    );
  }, [ledger]);

  const downloadExcelFile = (
    filename: string,
    rows: (string | number)[][],
    sheetName = "Hoja1",
  ) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, filename);
  };

  const exportLedgerToExcel = () => {
    const rows: (string | number)[][] = [];
    const headers = [
      "Fecha",
      "Movimiento",
      "Descripción",
      "Referencia",
      "Entrada",
      "Salida",
      "Saldo CAJA",
      "Saldo CONTABLE",
      "Fuente",
      "Creado por",
      "Afecta deuda dueño",
      "Afecta CAJA",
    ];
    rows.push(headers);

    (ledgerWithBalance || []).forEach((r: any) => {
      const createdBy = r.createdBy
        ? `${r.createdBy.email || r.createdBy.uid || ""}`
        : "";
      rows.push([
        r.date || "",
        r.type || "",
        r.description || "",
        r.reference || "",
        r.inAmount || 0,
        r.outAmount || 0,
        r.balance || 0,
        r.accountingBalance || 0,
        r.source || "ledger",
        createdBy,
        affectsOwnerDebt(r.type as LedgerType) ? "SI" : "",
        affectsCash(r.type as LedgerType) ? "SI" : "NO",
      ]);
    });

    const name = `estado_cuenta_${from || "desde"}_${to || "hasta"}.xlsx`;
    downloadExcelFile(name, rows, "Movimientos");
  };

  const saveMovement = async () => {
    const inVal = Number(inAmount || 0);
    const outVal = Number(outAmount || 0);

    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
    ];
    const onlyInTypes: LedgerType[] = [
      "PRESTAMO A NEGOCIO POR DUENO",
      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
    ];

    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (!date) {
      setToastMsg("⚠️ Poné una fecha.");
      return;
    }
    if (!description.trim()) {
      setToastMsg("⚠️ Poné una descripción.");
      return;
    }

    if (isOnlyIn) {
      if (inVal <= 0) {
        setToastMsg("⚠️ Poné una entrada para este tipo.");
        return;
      }
    } else if (isOnlyOut) {
      if (outVal <= 0) {
        setToastMsg("⚠️ Poné una salida para este tipo.");
        return;
      }
    } else {
      if (inVal <= 0 && outVal <= 0) {
        setToastMsg("⚠️ Poné una entrada o una salida.");
        return;
      }
      if (inVal > 0 && outVal > 0) {
        setToastMsg("⚠️ Usá solo entrada o salida, no ambos.");
        return;
      }
    }

    const user = auth.currentUser;

    const payload = {
      date,
      type,
      description: description.trim(),
      reference: reference.trim() || null,
      inAmount: inVal > 0 ? inVal : 0,
      outAmount: outVal > 0 ? outVal : 0,
      createdAt: serverTimestamp(),
      createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
      periodFrom: from,
      periodTo: to,
    };

    if (editingId) {
      try {
        await updateDoc(doc(db, "cash_ledger_pollo", editingId), payload);
        setToastMsg("✅ Movimiento actualizado.");
      } catch (e) {
        console.error("Error updating movement:", e);
        setToastMsg("❌ No se pudo actualizar el movimiento. Revisa la consola.");
        return;
      }
    } else {
      await addDoc(collection(db, "cash_ledger_pollo"), payload);
      setToastMsg("✅ Movimiento guardado.");
    }

    setDescription("");
    setReference("");
    setInAmount("");
    setOutAmount("");

    refresh();
    setModalOpen(false);
    setEditingId(null);
  };

  // When type changes, clear disabled input
  useEffect(() => {
    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
    ];
    const onlyInTypes: LedgerType[] = [
      "PRESTAMO A NEGOCIO POR DUENO",
      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
    ];

    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (isOnlyOut) setInAmount("");
    if (isOnlyIn) setOutAmount("");
  }, [type]);

  // close modal/menu on outside click or Escape
  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (modalOpen) {
        if (modalRef.current && !modalRef.current.contains(target)) {
          setModalOpen(false);
          setEditingId(null);
        }
      }
      if (actionOpenId) {
        if (actionMenuRef.current && !actionMenuRef.current.contains(target)) {
          setActionOpenId(null);
        }
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setActionOpenId(null);
        setModalOpen(false);
        setEditingId(null);
      }
    };

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modalOpen, actionOpenId]);

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">Estado de Cuenta</h2>
        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            type="button"
            onClick={exportLedgerToExcel}
            className="px-3 py-2 border rounded bg-white hover:bg-gray-50 text-sm"
          >
            Exportar Excel
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs */}
      {/* Desktop grid */}
      <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-4">
        <div className="sm:col-span-3 flex justify-end">
          <button
            type="button"
            onClick={toggleAllKpis}
            className={`shrink-0 text-sm px-3 py-1.5 rounded-lg border font-medium ${
              allCollapsed
                ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
                : "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200"
            }`}
          >
            {allCollapsed ? "Ver indicadores" : "Ocultar"}
          </button>
        </div>

        {/* Libras */}
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Libras</div>
          </div>
          {!collapseLibras && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">Libras vendidas Cash</div>
              <div className="text-2xl font-bold">
                {qty3(base?.lbsCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Libras vendidas Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.lbsCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Total Libras Cash + Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3((base?.lbsCash ?? 0) + (base?.lbsCredit ?? 0))}
              </div>
            </div>
          )}
        </div>

        {/* Unidades */}
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Unidades</div>
          </div>
          {!collapseUnidades && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">
                Unidades vendidas Cash
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.unitsCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Unidades vendidas Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3(base?.unitsCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Total Unidades Cash + Crédito
              </div>
              <div className="text-2xl font-bold">
                {qty3((base?.unitsCash ?? 0) + (base?.unitsCredit ?? 0))}
              </div>
            </div>
          )}
        </div>

        {/* Ventas */}
        <div className="border rounded-2xl p-3 bg-white">
          <div className="flex items-center justify-between">
            <div className="text-sm font-semibold">Ventas / Abonos</div>
          </div>
          {!collapseVentas && (
            <div className="mt-3 space-y-2">
              <div className="text-xs text-gray-600">Ventas Cash $</div>
              <div className="text-2xl font-bold">
                {money(base?.salesCash ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">Ventas Crédito $</div>
              <div className="text-2xl font-bold">
                {money(base?.salesCredit ?? 0)}
              </div>
              <div className="text-xs text-gray-600 mt-2">
                Abonos al periodo $
              </div>
              <div className="text-2xl font-bold">
                {money(base?.abonosPeriodo ?? 0)}
              </div>
            </div>
          )}
        </div>

        <div className="sm:col-span-2 lg:col-span-3">
          <div className="border rounded-2xl p-3 bg-white shadow-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold text-gray-900">
                  Préstamo, compras y salidas
                </div>
                <div className="text-xs text-gray-500 mt-0.5">
                  Préstamo a caja, compras del dueño, abonos, deuda, gastos y
                  salidas
                </div>
              </div>
              <button
                type="button"
                onClick={() => setCollapseCajaFlowKpis((v) => !v)}
                className={`shrink-0 text-sm px-3 py-1.5 rounded-lg border font-medium ${
                  collapseCajaFlowKpis
                    ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
                    : "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200"
                }`}
              >
                {collapseCajaFlowKpis ? "Ver indicadores" : "Ocultar"}
              </button>
            </div>

            {!collapseCajaFlowKpis && (
              <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
                <div className="border rounded-2xl p-3 bg-green-50">
                  <div className="text-xs text-gray-600">Prestamo a caja</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.inCashSum)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-sky-50">
                  <div className="text-xs text-gray-600">
                    Compras directas (dueño)
                  </div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.comprasDirectasDueno || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-emerald-50">
                  <div className="text-xs text-gray-600">Abonos a Préstamos</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.abonoDueno)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-amber-50">
                  <div className="text-xs text-gray-600">Deuda a Dueño</div>
                  <div className="text-2xl font-bold">{money(deudaDueno)}</div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">Gastos del periodo</div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.gastosSum)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-red-50">
                  <div className="text-xs text-gray-600">
                    Salidas (Retiros, Depositos, Perdidas)
                  </div>
                  <div className="text-2xl font-bold">
                    {money(displayTotals.outSumNonGastos)}
                  </div>
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-5 gap-3">
            <div className="border rounded-2xl p-3 bg-blue-50">
              <div className="text-xs text-gray-600">
                Reabastecimiento (pagado con caja)
              </div>
              <div className="text-2xl font-bold">
                {money(displayTotals.reabastecimientoSum || 0)}
              </div>
            </div>

            <button type="button" onClick={() => setKpiDrawer("existencias")} className="border rounded-2xl p-3 bg-amber-50 text-left hover:ring-2 hover:ring-amber-300 transition-shadow cursor-pointer">
              <div className="text-xs text-gray-600">Existencias <span className="text-[10px] text-amber-600 ml-1">ver detalle →</span></div>
              <div className="text-sm text-gray-600">
                Libras: {qty3(invLbsRem)}
              </div>
              <div className="text-sm text-gray-600">
                Unidades: {qty3(invUdsRem)}
              </div>
              <div className="text-2xl font-bold mt-2">
                {money(invExistenciasMonetarias)}
              </div>
            </button>

            <button type="button" onClick={() => setKpiDrawer("saldo")} className="border rounded-2xl p-3 bg-indigo-50 text-left hover:ring-2 hover:ring-indigo-300 transition-shadow cursor-pointer">
              <div className="text-xs text-gray-600">
                Saldo Inicial (Ventas Cash + Abonos) <span className="text-[10px] text-indigo-600 ml-1">ver detalle →</span>
              </div>
              <div className="text-2xl font-bold">{money(saldoBase)}</div>
            </button>

            {/* ✅ KPI NUEVO: SALDO CONTABLE */}
            <div className="border rounded-2xl p-3 bg-gray-50">
              <div className="text-xs text-gray-600">
                Saldo inicial + Compras directas
              </div>
              <div className="text-2xl font-bold">
                {money(saldoFinalContable)}
              </div>
            </div>

            {/* ✅ SALDO FINAL = CAJA ESPERADA */}
            <div className="border rounded-2xl p-3 bg-gray-900 text-white">
              <div className="text-xs opacity-80">
                Saldo final (Debe - Haber)
              </div>
              <div className="text-3xl font-extrabold">{money(saldoFinal)}</div>
            </div>
          </div>
        </div>
      </div>

      {/* Mobile: KPIs grouped in a card */}
      <div className="md:hidden mb-4">
        <div className="border rounded-2xl p-3 bg-white shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-600">
              Saldo final (caja esperada)
            </div>
            <div className="flex items-center gap-3">
              <div className="text-lg font-bold">{money(saldoFinal)}</div>
              <button
                type="button"
                onClick={toggleAllKpis}
                className={`shrink-0 text-xs px-2.5 py-1.5 rounded-lg border font-medium ${
                  allCollapsed
                    ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700"
                    : "bg-gray-100 text-gray-800 border-gray-200 hover:bg-gray-200"
                }`}
              >
                {allCollapsed ? "Ver indicadores" : "Ocultar"}
              </button>
            </div>
          </div>

          {/* ✅ KPI NUEVO mobile */}
          <div className="border rounded p-2 bg-gray-50">
            <div className="text-xs text-gray-600">
              Saldo contable (incluye compras dueño)
            </div>
            <div className="font-semibold">{money(saldoFinalContable)}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Libras</div>
              </div>
              {!collapseLibras && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Lbs Cash</div>
                    <div className="font-semibold">
                      {qty3(base?.lbsCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Lbs Crédito</div>
                    <div className="font-semibold">
                      {qty3(base?.lbsCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Total Lbs</div>
                    <div className="font-semibold">
                      {qty3((base?.lbsCash ?? 0) + (base?.lbsCredit ?? 0))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Unidades</div>
              </div>
              {!collapseUnidades && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Unid Cash</div>
                    <div className="font-semibold">
                      {qty3(base?.unitsCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Unid Crédito</div>
                    <div className="font-semibold">
                      {qty3(base?.unitsCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Total Unid</div>
                    <div className="font-semibold">
                      {qty3((base?.unitsCash ?? 0) + (base?.unitsCredit ?? 0))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="border rounded p-2 bg-gray-50 col-span-2">
              <div className="flex items-center justify-between">
                <div className="text-xs text-gray-600">Ventas / Abonos</div>
              </div>
              {!collapseVentas && (
                <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2">
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Ventas Cash</div>
                    <div className="font-semibold">
                      {money(base?.salesCash ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">Ventas Crédito</div>
                    <div className="font-semibold">
                      {money(base?.salesCredit ?? 0)}
                    </div>
                  </div>
                  <div className="border rounded p-2 bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Abonos al periodo
                    </div>
                    <div className="font-semibold">
                      {money(base?.abonosPeriodo ?? 0)}
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Formulario dentro de modal: botón disparador */}
      <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="bg-blue-600 text-white px-3 py-1 text-sm rounded-lg hover:bg-blue-700 w-full sm:w-auto"
        >
          Agregar movimiento
        </button>

        <div className="flex flex-col sm:flex-row sm:items-end gap-2 w-full sm:w-auto min-w-0">
          <MobileHtmlSelect
            label="Tipo"
            value={movementTypeFilter}
            onChange={setMovementTypeFilter}
            options={movementTypeFilterSelectOptions}
            sheetTitle="Filtrar por tipo"
            selectClassName="border rounded px-2 py-1 text-sm w-full sm:w-72"
            buttonClassName="border rounded px-2 py-1 text-sm w-full sm:w-72 text-left flex items-center justify-between gap-2 bg-white"
          />
        </div>
      </div>

      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
          <div
            className="absolute inset-0 bg-black/40"
            onClick={() => setModalOpen(false)}
          />

          <div
            ref={modalRef}
            className="relative bg-white rounded-2xl p-4 w-full max-w-2xl shadow-xl"
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="font-semibold">Agregar movimiento</h3>
              <button
                type="button"
                onClick={() => setModalOpen(false)}
                className="text-gray-500 hover:text-gray-700"
              >
                ✕
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Fecha
                </label>
                <input
                  type="date"
                  className="border rounded px-3 py-2 w-full"
                  value={date}
                  onChange={(e) => setDate(e.target.value)}
                />
              </div>

              <div>
                <MobileHtmlSelect
                  label="Tipo movimiento"
                  value={type}
                  onChange={(v) => setType(v as LedgerType)}
                  options={modalMovementTypeOptions}
                  sheetTitle="Tipo de movimiento"
                  selectClassName="border rounded px-3 py-2 w-full"
                  buttonClassName="border rounded px-3 py-2 w-full text-left flex items-center justify-between gap-2 bg-white"
                />

                {type === "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" && (
                  <div className="mt-1 text-xs text-sky-700">
                    Este movimiento NO aumenta la caja. Solo registra inventario
                    comprado por el dueño y suma a la deuda.
                  </div>
                )}

                {affectsOwnerDebt(type) &&
                  type !== "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" && (
                    <div className="mt-1 text-xs text-amber-700">
                      Este movimiento afecta la deuda del negocio con el dueño.
                    </div>
                  )}
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Referencia
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                  placeholder="Factura, recibo, etc."
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-3">
                <label className="block text-sm text-gray-600 mb-1">
                  Descripción
                </label>
                <input
                  className="border rounded px-3 py-2 w-full"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Ej: Compra bolsas / Re abastecimiento / Pago proveedor..."
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Entrada (+)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="^\\d*(\\.\\d{0,2})?$"
                  className="border rounded px-3 py-2 w-full"
                  value={inAmount}
                  onChange={(e) => {
                    let val = e.target.value.replace(/,/g, ".");
                    if (
                      /^\d*(\.\d{0,2})?$/.test(val) ||
                      val === "." ||
                      val === ""
                    ) {
                      setInAmount(val === "." ? "." : val);
                    }
                  }}
                  placeholder="0.00"
                  disabled={[
                    "GASTO",
                    "REABASTECIMIENTO",
                    "RETIRO",
                    "DEPOSITO",
                    "CORTE",
                    "PERDIDA",
                    "DEVOLUCION A DUENO POR PRESTAMO",
                  ].includes(String(type))}
                  aria-disabled={[
                    "GASTO",
                    "REABASTECIMIENTO",
                    "RETIRO",
                    "DEPOSITO",
                    "CORTE",
                    "PERDIDA",
                    "DEVOLUCION A DUENO POR PRESTAMO",
                  ].includes(String(type))}
                />
              </div>

              <div>
                <label className="block text-sm text-gray-600 mb-1">
                  Salida (−)
                </label>
                <input
                  type="text"
                  inputMode="decimal"
                  pattern="^\\d*(\\.\\d{0,2})?$"
                  className="border rounded px-3 py-2 w-full"
                  value={outAmount}
                  onChange={(e) => {
                    let val = e.target.value.replace(/,/g, ".");
                    if (
                      /^\d*(\.\d{0,2})?$/.test(val) ||
                      val === "." ||
                      val === ""
                    ) {
                      setOutAmount(val === "." ? "." : val);
                    }
                  }}
                  placeholder="0.00"
                  disabled={[
                    "PRESTAMO A NEGOCIO POR DUENO",
                    "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
                  ].includes(String(type))}
                  aria-disabled={[
                    "PRESTAMO A NEGOCIO POR DUENO",
                    "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
                  ].includes(String(type))}
                />
              </div>

              <div className="sm:col-span-3 flex gap-2 justify-end mt-2">
                <button
                  type="button"
                  onClick={() => setModalOpen(false)}
                  className="px-4 py-2 border rounded"
                >
                  Cancelar
                </button>
                <button
                  type="button"
                  onClick={saveMovement}
                  className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
                >
                  Guardar movimiento
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Tabla ledger (desktop) */}
      <div className="hidden md:block overflow-x-auto">
        <table className="min-w-full border text-sm">
          <thead className="bg-gray-100 sticky top-0 z-10">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Movimiento</th>
              <th className="border p-2">Descripción</th>
              <th className="border p-2">Referencia</th>
              <th className="border p-2">Usuario</th>
              <th className="border p-2">Entrada (+)</th>
              <th className="border p-2">Salida (−)</th>
              <th className="border p-2">Saldo (CAJA)</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr className="text-center bg-indigo-50">
              <td className="border p-1">
                {from} → {to}
              </td>
              <td className="border p-1">SALDO_INICIAL</td>
              <td className="border p-1 text-left">
                Ventas Cash + Abonos del periodo
              </td>
              <td className="border p-1">—</td>
              <td className="border p-1">—</td>
              <td className="border p-1">{money(saldoBase)}</td>
              <td className="border p-1">{money(0)}</td>
              <td className="border p-1 font-semibold">{money(saldoBase)}</td>
              <td className="border p-1">—</td>
            </tr>

            {filteredLedgerWithBalance.map((r: any) => (
              <tr key={r.id} className={`text-center ${rowBgByType(r.type)}`}>
                <td className="border p-1">{r.date}</td>
                <td className="border p-1">{typeBadge(r.type)}</td>
                <td className="border p-1 text-left">{r.description}</td>
                <td className="border p-1">{r.reference || "—"}</td>
                <td className="border p-1">
                  {r.createdBy?.displayName ||
                    r.createdBy?.name ||
                    r.createdBy?.email ||
                    r.createdBy?.uid ||
                    "—"}
                </td>
                <td className={`border p-1 tabular-nums ${Number(r.inAmount || 0) > 0 ? "text-green-700 font-semibold" : "text-gray-300"}`}>{money(r.inAmount)}</td>
                <td className={`border p-1 tabular-nums ${Number(r.outAmount || 0) > 0 ? "text-red-700 font-semibold" : "text-gray-300"}`}>{money(r.outAmount)}</td>
                <td className={`border p-1 font-bold tabular-nums ${Number(r.balance) < 0 ? "text-red-700" : "text-gray-900"}`}>{money(r.balance)}</td>
                <td className="border p-1 relative">
                  {r.source === "expenses" ? (
                    <div className="text-xs text-gray-400">
                      Gasto registrado
                    </div>
                  ) : (
                    <div className="inline-block">
                      <button
                        onClick={() =>
                          setActionOpenId(actionOpenId === r.id ? null : r.id)
                        }
                        className="px-2 py-1 rounded hover:bg-gray-100"
                        aria-label="Acciones"
                      >
                        ⋯
                      </button>

                      {actionOpenId === r.id && (
                        <div
                          ref={(el) => {
                            actionMenuRef.current = el as HTMLDivElement | null;
                          }}
                          className="absolute right-2 mt-1 bg-white border rounded shadow-md z-50 text-left text-sm"
                        >
                          <button
                            className="block w-full text-left px-3 py-2 hover:bg-gray-100"
                            onClick={() => {
                              setEditingId(r.id);
                              setDate(r.date);
                              setType(r.type as LedgerType);
                              setDescription(r.description || "");
                              setReference(r.reference || "");
                              const inStr =
                                Number(r.inAmount || 0) === 0
                                  ? ""
                                  : String(Number(r.inAmount));
                              const outStr =
                                Number(r.outAmount || 0) === 0
                                  ? ""
                                  : String(Number(r.outAmount));
                              setInAmount(inStr);
                              setOutAmount(outStr);
                              setModalOpen(true);
                              setActionOpenId(null);
                            }}
                          >
                            Editar
                          </button>
                          <button
                            className="block w-full text-left px-3 py-2 text-red-600 hover:bg-gray-100"
                            onClick={async () => {
                              setActionOpenId(null);
                              if (!window.confirm("Eliminar este movimiento?"))
                                return;
                              try {
                                await deleteDoc(
                                  doc(db, "cash_ledger_pollo", r.id),
                                );
                                refresh();
                                setToastMsg("✅ Movimiento eliminado.");
                              } catch (e) {
                                console.error(
                                  "Error eliminando movimiento:",
                                  e,
                                );
                                setToastMsg(
                                  "❌ No se pudo eliminar el movimiento. Revisa la consola.",
                                );
                              }
                            }}
                          >
                            Eliminar
                          </button>
                        </div>
                      )}
                    </div>
                  )}
                </td>
              </tr>
            ))}

            {filteredLedgerWithBalance.length === 0 && (
              <tr>
                <td colSpan={9} className="p-3 text-center text-gray-500">
                  No hay movimientos manuales en este rango.
                </td>
              </tr>
            )}
          </tbody>
          <tfoot className="bg-gray-800 text-white">
            <tr>
              <td colSpan={5} className="border border-gray-700 p-2 text-right font-semibold text-sm">Totales</td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-bold text-green-300">{money(saldoBase + tableTotals.totalIn)}</td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-bold text-red-300">{money(tableTotals.totalOut)}</td>
              <td className="border border-gray-700 p-2 text-center tabular-nums font-extrabold text-lg">{money(saldoFinal)}</td>
              <td className="border border-gray-700 p-2"></td>
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Mobile: ledger as cards */}
      <div className="md:hidden space-y-3">
        {filteredLedgerWithBalance.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-6">
            Sin movimientos manuales en este rango.
          </div>
        ) : (
          filteredLedgerWithBalance.map((r: any) => (
            <div
              key={r.id}
              className={`rounded-xl p-3 bg-white shadow-sm ${borderByType(r.type)}`}
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-sm font-semibold">{r.description}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 flex-wrap">
                    <span>{r.date}</span>
                    {typeBadge(r.type)}
                  </div>
                </div>
                <div className="text-right space-y-0.5">
                  {Number(r.inAmount || 0) > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-green-700 tabular-nums">+{money(r.inAmount)}</div>
                      <div className="text-[10px] text-gray-400">Entrada</div>
                    </div>
                  )}
                  {Number(r.outAmount || 0) > 0 && (
                    <div>
                      <div className="text-sm font-semibold text-red-700 tabular-nums">-{money(r.outAmount)}</div>
                      <div className="text-[10px] text-gray-400">Salida</div>
                    </div>
                  )}
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-gray-700">
                <div>
                  <div className="text-xs text-gray-500">Referencia</div>
                  <div>{r.reference || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Saldo (CAJA)</div>
                  <div className={`font-bold tabular-nums ${Number(r.balance) < 0 ? "text-red-700" : "text-gray-900"}`}>{money(r.balance)}</div>
                </div>
              </div>

              <div className="mt-2 text-sm text-gray-700">
                <div className="text-xs text-gray-500">Usuario</div>
                <div>
                  {r.createdBy?.displayName ||
                    r.createdBy?.name ||
                    r.createdBy?.email ||
                    r.createdBy?.uid ||
                    "—"}
                </div>
              </div>

              <div className="mt-3 flex justify-end gap-2">
                {r.source === "expenses" ? null : (
                  <>
                    <button
                      onClick={() => {
                        setEditingId(r.id);
                        setDate(r.date);
                        setType(r.type as LedgerType);
                        setDescription(r.description || "");
                        setReference(r.reference || "");
                        const inStr =
                          Number(r.inAmount || 0) === 0
                            ? ""
                            : String(Number(r.inAmount));
                        const outStr =
                          Number(r.outAmount || 0) === 0
                            ? ""
                            : String(Number(r.outAmount));
                        setInAmount(inStr);
                        setOutAmount(outStr);
                        setModalOpen(true);
                      }}
                      className="px-3 py-1 border rounded text-sm"
                    >
                      Editar
                    </button>
                    <button
                      onClick={async () => {
                        if (!window.confirm("Eliminar este movimiento?"))
                          return;
                        try {
                          await deleteDoc(doc(db, "cash_ledger_pollo", r.id));
                          refresh();
                          setToastMsg("✅ Movimiento eliminado.");
                        } catch (e) {
                          console.error("Error eliminando movimiento:", e);
                          setToastMsg(
                            "❌ No se pudo eliminar el movimiento. Revisa la consola.",
                          );
                        }
                      }}
                      className="px-3 py-1 bg-red-600 text-white rounded text-sm"
                    >
                      Eliminar
                    </button>
                  </>
                )}
              </div>
            </div>
          ))
        )}

        {filteredLedgerWithBalance.length > 0 && (
          <div className="rounded-xl p-3 bg-gray-800 text-white shadow-sm border-l-4 border-l-gray-800 mt-1">
            <div className="flex justify-between items-center">
              <div className="text-sm font-semibold">Totales</div>
              <div className="text-right">
                <div className="text-lg font-extrabold tabular-nums">{money(saldoFinal)}</div>
                <div className="text-[10px] text-gray-300">Saldo final</div>
              </div>
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
              <div>
                <div className="text-[10px] text-gray-400">Total entradas</div>
                <div className="font-semibold text-green-300 tabular-nums">{money(saldoBase + tableTotals.totalIn)}</div>
              </div>
              <div>
                <div className="text-[10px] text-gray-400">Total salidas</div>
                <div className="font-semibold text-red-300 tabular-nums">{money(tableTotals.totalOut)}</div>
              </div>
            </div>
          </div>
        )}
      </div>
      {/* Drawer: Detalle Existencias */}
      <SlideOverDrawer
        open={kpiDrawer === "existencias"}
        onClose={() => setKpiDrawer(null)}
        title="Detalle de Existencias"
        subtitle={`${from} → ${to}`}
        titleId="drawer-existencias-title"
      >
        <DrawerMoneyStrip
          items={[
            { label: "Libras restantes", value: qty3(invLbsRem), tone: "blue" },
            { label: "Unidades restantes", value: qty3(invUdsRem), tone: "slate" },
            { label: "Valor monetario", value: money(invExistenciasMonetarias), tone: "emerald" },
          ]}
        />
        <DrawerSectionTitle>Lotes con existencia ({batchDetails.length})</DrawerSectionTitle>
        <div className="mt-2 space-y-2">
          {batchDetails.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">Sin existencias en este periodo.</div>
          ) : (
            batchDetails.map((b) => (
              <DrawerDetailDlCard
                key={b.id}
                title={b.productName}
                rows={[
                  { label: "Fecha lote", value: b.date },
                  { label: "Unidad", value: b.unit },
                  { label: "Restante", value: b.remaining.toFixed(3), ddClassName: `text-sm font-bold tabular-nums ${b.remaining > 0 ? "text-green-700" : "text-red-600"}` },
                  { label: "Precio venta", value: money(b.salePrice) },
                  { label: "Valor total", value: money(b.totalValue), ddClassName: "text-sm font-bold tabular-nums text-gray-900" },
                ]}
              />
            ))
          )}
        </div>
      </SlideOverDrawer>

      {/* Drawer: Detalle Saldo Inicial */}
      <SlideOverDrawer
        open={kpiDrawer === "saldo"}
        onClose={() => setKpiDrawer(null)}
        title="Detalle del Saldo Inicial"
        subtitle={`${from} → ${to}`}
        titleId="drawer-saldo-title"
      >
        <DrawerMoneyStrip
          items={[
            { label: "Ventas Cash", value: money(base?.salesCash ?? 0), tone: "blue" },
            { label: "Abonos periodo", value: money(base?.abonosPeriodo ?? 0), tone: "emerald" },
            { label: "Saldo Base", value: money(saldoBase), tone: "slate" },
          ]}
        />

        <DrawerSectionTitle>Ventas Cash ({salesRows.length})</DrawerSectionTitle>
        <div className="mt-2 space-y-2">
          {salesRows.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">Sin ventas cash en este periodo.</div>
          ) : (
            salesRows.map((s) => (
              <DrawerDetailDlCard
                key={s.id}
                title={s.customer}
                rows={[
                  { label: "Fecha", value: s.date },
                  { label: "Monto", value: money(s.amount), ddClassName: "text-sm font-bold tabular-nums text-green-700" },
                ]}
              />
            ))
          )}
        </div>

        <DrawerSectionTitle>Abonos ({abonosRows.length})</DrawerSectionTitle>
        <div className="mt-2 space-y-2">
          {abonosRows.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-4">Sin abonos en este periodo.</div>
          ) : (
            abonosRows.map((a) => (
              <DrawerDetailDlCard
                key={a.id}
                title={a.customer}
                rows={[
                  { label: "Fecha", value: a.date },
                  { label: "Monto abono", value: money(a.amount), ddClassName: "text-sm font-bold tabular-nums text-emerald-700" },
                ]}
              />
            ))
          )}
        </div>
      </SlideOverDrawer>

      {toastMsg && (
        <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      )}
    </div>
  );
}
