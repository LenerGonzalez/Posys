import React, { useEffect, useMemo, useRef, useState } from "react";
import { db, auth } from "../../firebase";
import {
  collection,
  getDocs,
  getDoc,
  doc,
  query,
  where,
  onSnapshot,
  Timestamp,
  addDoc,
  serverTimestamp,
} from "firebase/firestore";
import {
  addDays,
  endOfMonth,
  format,
  parse,
  startOfMonth,
} from "date-fns";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import ActionMenu, {
  ActionMenuTrigger,
  actionMenuItemClass,
} from "../../components/common/ActionMenu";
import RefreshButton from "../../components/common/RefreshButton";
import MobileHtmlSelect from "../../components/common/MobileHtmlSelect";
import Toast from "../../components/common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";
import Button from "../common/Button";

const money = (n: unknown) => `C$${Number(n ?? 0).toFixed(2)}`;
const todayStr = () => format(new Date(), "yyyy-MM-dd");

/** Fechas yyyy-MM-dd desde `from` hasta `to` inclusive. */
function eachDayInclusive(fromStr: string, toStr: string): string[] {
  const start = parse(fromStr, "yyyy-MM-dd", new Date());
  const end = parse(toStr, "yyyy-MM-dd", new Date());
  if (start > end) return [];
  const days: string[] = [];
  let d = start;
  while (d <= end) {
    days.push(format(d, "yyyy-MM-dd"));
    d = addDays(d, 1);
  }
  return days;
}

/** Detección libras para lotes (misma lógica que ventas). */
function batchIsLb(m: unknown): boolean {
  const s = String(m ?? "")
    .toLowerCase()
    .trim();
  return ["lb", "lbs", "libra", "libras"].includes(s);
}
const qty3 = (n: number) => Number(n || 0).toFixed(3);

type Allocation = {
  batchId: string;
  qty: number;
  unitCost: number;
  lineCost: number;
};

type SaleDoc = {
  id: string;
  date: string; // "yyyy-MM-dd"
  productName: string;
  quantity: number;
  amount: number; // ingreso
  allocations?: Allocation[];
  avgUnitCost?: number;
  measurement?: string; // "lb" o "unidad"
  type?: "CREDITO" | "CONTADO";
};

type ExpenseDoc = {
  id: string;
  date: string;
  category: string;
  description?: string;
  amount: number;
  status?: "PAGADO" | "PENDIENTE";
  createdAt?: Timestamp;
};

type PendingProductRow = {
  productName: string;
  qty: number;
  amount: number;
  measurement?: string;
  price?: number;
};

type PendingCustomerRow = {
  customerId: string;
  name: string;
  balance: number;
  globalBalance: number;
  lbs: number;
  units: number;
  lastPaymentAmount: number;
  lastSaleDate?: string;
  lastPaymentDate?: string;
  products: PendingProductRow[];
};

type AvailabilityRow = {
  key: string;
  productName: string;
  unit: string;
  incomingQty: number;
  remainingQty: number;
  soldQty: number;
};

export default function FinancialDashboard(): React.ReactElement {
  const [from, setFrom] = useState(() => {
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    return format(first, "yyyy-MM-dd");
  });
  const [to, setTo] = useState(todayStr());
  const [loading, setLoading] = useState(true);

  const [sales, setSales] = useState<SaleDoc[]>([]);
  const [expenses, setExpenses] = useState<ExpenseDoc[]>([]);
  const [pendingCustomers, setPendingCustomers] = useState<
    PendingCustomerRow[]
  >([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [pendingOpen, setPendingOpen] = useState<PendingCustomerRow | null>(
    null,
  );
  const [totalAbonos, setTotalAbonos] = useState(0);
  const [totalAbonosRange, setTotalAbonosRange] = useState(0);
  const [creditGrossProfitCash, setCreditGrossProfitCash] = useState(0);
  const [creditGrossProfitCashRange, setCreditGrossProfitCashRange] =
    useState(0);
  const [inventoryByProduct, setInventoryByProduct] = useState<
    Record<string, { incomingQty: number; remainingQty: number }>
  >({});
  const [totalExpectedVentas, setTotalExpectedVentas] = useState<number>(0);
  const [totalInversion, setTotalInversion] = useState<number>(0);
  const [totalExistenciasMonetarias, setTotalExistenciasMonetarias] =
    useState<number>(0);
  /** Libras ingresadas por día de lote (periodo seleccionado). */
  const [incomingLbsByDay, setIncomingLbsByDay] = useState<
    Record<string, number>
  >({});
  /** Total esperado ventas por día de ingreso de lote (periodo). */
  const [expectedVentasByDay, setExpectedVentasByDay] = useState<
    Record<string, number>
  >({});
  const [priceVenta, setPriceVenta] = useState<Record<string, number>>({});

  const [dashMenuOpen, setDashMenuOpen] = useState(false);
  const dashMenuBtnRef = useRef<HTMLButtonElement>(null);
  const [dashMenuRect, setDashMenuRect] = useState<DOMRect | null>(null);

  const { refreshKey, refresh } = useManualRefresh();

  // Listen to customers and AR movements so dashboard updates when edited elsewhere
  useEffect(() => {
    const unsubCust = onSnapshot(collection(db, "customers_pollo"), () => {
      try {
        refresh();
      } catch (e) {
        console.warn("Failed to call refresh from customers snapshot:", e);
      }
    });

    const unsubMov = onSnapshot(collection(db, "ar_movements_pollo"), () => {
      try {
        refresh();
      } catch (e) {
        console.warn("Failed to call refresh from movements snapshot:", e);
      }
    });

    return () => {
      try {
        unsubCust();
      } catch {}
      try {
        unsubMov();
      } catch {}
    };
  }, [refresh]);

  // UI: estado de expansión en mobile
  const [openProducts, setOpenProducts] = useState<Record<string, boolean>>({});
  const [openExpenses, setOpenExpenses] = useState<Record<string, boolean>>({});
  // accordion mobile for Consolidado por producto
  const [consolidatedOpen, setConsolidatedOpen] = useState<boolean>(false);
  const toggleConsolidated = () => setConsolidatedOpen((v) => !v);
  // accordion mobile for Gastos
  const [consolidatedExpensesOpen, setConsolidatedExpensesOpen] =
    useState<boolean>(false);
  const toggleConsolidatedExpenses = () =>
    setConsolidatedExpensesOpen((v) => !v);

  // top-level collapsables (web + mobile)
  const [kpiSectionOpen, setKpiSectionOpen] = useState<boolean>(false);
  const [pendingSectionOpen, setPendingSectionOpen] = useState<boolean>(false);
  const [consolidatedSectionOpen, setConsolidatedSectionOpen] =
    useState<boolean>(false);
  const [salesKpiCardOpen, setSalesKpiCardOpen] = useState<boolean>(false);
  const [fundsKpiCardOpen, setFundsKpiCardOpen] = useState<boolean>(false);
  const [detailsKpiCardOpen, setDetailsKpiCardOpen] = useState<boolean>(false);
  const toggleKpiSection = () => setKpiSectionOpen((v) => !v);
  const togglePendingSection = () => setPendingSectionOpen((v) => !v);
  const toggleConsolidatedSection = () => setConsolidatedSectionOpen((v) => !v);
  const toggleSalesKpiCard = () => setSalesKpiCardOpen((v) => !v);
  const toggleFundsKpiCard = () => setFundsKpiCardOpen((v) => !v);
  const toggleDetailsKpiCard = () => setDetailsKpiCardOpen((v) => !v);
  // product filter for KPIs
  const [productFilter, setProductFilter] = useState<string>("");
  const [toastMsg, setToastMsg] = useState("");

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      // Ventas
      const qs = query(
        collection(db, "salesV2"),
        where("date", ">=", from),
        where("date", "<=", to),
      );
      const sSnap = await getDocs(qs);
      const sRows: SaleDoc[] = [];

      sSnap.forEach((d) => {
        const x = d.data() as any;
        const baseDate = x.date ?? "";

        // Si hay items[], crear UNA fila por ítem
        if (Array.isArray(x.items) && x.items.length > 0) {
          x.items.forEach((it: any, idx: number) => {
            const prod = String(it.productName ?? "(sin nombre)");
            const qty = Number(it.qty ?? 0);
            const lineFinal =
              Number(it.lineFinal ?? 0) ||
              Math.max(
                0,
                Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
              );
            sRows.push({
              id: `${d.id}#${idx}`,
              date: baseDate,
              productName: prod,
              quantity: qty,
              amount: lineFinal,
              allocations: Array.isArray(it.allocations)
                ? it.allocations
                : x.allocations,
              avgUnitCost: Number(it.avgUnitCost ?? x.avgUnitCost ?? 0),
              measurement: it.measurement ?? x.measurement ?? "",
              type: x.type ?? "CONTADO",
            });
          });
          return;
        }

        // Fallback al shape viejo
        sRows.push({
          id: d.id,
          date: baseDate,
          productName: x.productName ?? "(sin nombre)",
          quantity: Number(x.quantity ?? 0),
          amount: Number(x.amount ?? x.amountCharged ?? 0),
          allocations: Array.isArray(x.allocations) ? x.allocations : [],
          avgUnitCost: Number(x.avgUnitCost ?? 0),
          measurement: x.measurement ?? "",
          type: x.type ?? "CONTADO",
        });
      });

      setSales(sRows);

      // Gastos
      const qg = query(
        collection(db, "expenses"),
        where("date", ">=", from),
        where("date", "<=", to),
      );
      const eSnap = await getDocs(qg);
      const eRows: ExpenseDoc[] = [];
      eSnap.forEach((d) => {
        const x = d.data() as any;
        eRows.push({
          id: d.id,
          date: x.date ?? "",
          category: x.category ?? "(sin categoría)",
          description: x.description ?? "",
          amount: Number(x.amount ?? 0),
          status: (x.status as any) ?? "PAGADO",
          createdAt: x.createdAt,
        });
      });
      setExpenses(eRows);

      setLoading(false);
    };
    load();
  }, [from, to, refreshKey]);

  // KPIs principales
  const kpis = useMemo(() => {
    const revenue = sales.reduce((a, s) => a + (s.amount || 0), 0);

    let cogsReal = 0;
    sales.forEach((s) => {
      if (s.allocations?.length) {
        cogsReal += s.allocations.reduce(
          (x, a) => x + Number(a.lineCost || 0),
          0,
        );
      } else if (s.avgUnitCost && s.quantity) {
        cogsReal += Number(s.avgUnitCost) * Number(s.quantity);
      }
    });

    const grossProfit = revenue - cogsReal;
    const expensesSum = expenses.reduce((a, g) => a + (g.amount || 0), 0);
    const netProfit = grossProfit - expensesSum;

    return { revenue, cogsReal, grossProfit, expensesSum, netProfit };
  }, [sales, expenses]);

  // Visible sales depending on selected product filter
  const visibleSales = useMemo(() => {
    if (!productFilter) return sales;
    return sales.filter((s) => (s.productName || "") === productFilter);
  }, [sales, productFilter]);

  // KPIs for the visible sales (product-filtered)
  const kpisVisible = useMemo(() => {
    const revenue = visibleSales.reduce((a, s) => a + (s.amount || 0), 0);

    let cogsReal = 0;
    visibleSales.forEach((s) => {
      if (s.allocations?.length) {
        cogsReal += s.allocations.reduce(
          (x, a) => x + Number(a.lineCost || 0),
          0,
        );
      } else if (s.avgUnitCost && s.quantity) {
        cogsReal += Number(s.avgUnitCost) * Number(s.quantity);
      }
    });

    const grossProfit = revenue - cogsReal;
    const expensesSum = expenses.reduce((a, g) => a + (g.amount || 0), 0);
    const netProfit = grossProfit - expensesSum;

    return { revenue, cogsReal, grossProfit, expensesSum, netProfit };
  }, [visibleSales, expenses]);

  const kpisCashVisible = useMemo(() => {
    const cashOnly = visibleSales.filter((s) => s.type === "CONTADO");
    const revenue = cashOnly.reduce((a, s) => a + (s.amount || 0), 0);

    let cogsReal = 0;
    cashOnly.forEach((s) => {
      if (s.allocations?.length) {
        cogsReal += s.allocations.reduce(
          (x, a) => x + Number(a.lineCost || 0),
          0,
        );
      } else if (s.avgUnitCost && s.quantity) {
        cogsReal += Number(s.avgUnitCost) * Number(s.quantity);
      }
    });

    const grossProfit = revenue - cogsReal;
    const expensesSum = expenses.reduce((a, g) => a + (g.amount || 0), 0);
    const netProfit = grossProfit - expensesSum;

    return { revenue, cogsReal, grossProfit, expensesSum, netProfit };
  }, [visibleSales, expenses]);

  const kpisCreditVisible = useMemo(() => {
    const creditOnly = visibleSales.filter((s) => s.type === "CREDITO");
    const revenue = creditOnly.reduce((a, s) => a + (s.amount || 0), 0);

    let cogsReal = 0;
    creditOnly.forEach((s) => {
      if (s.allocations?.length) {
        cogsReal += s.allocations.reduce(
          (x, a) => x + Number(a.lineCost || 0),
          0,
        );
      } else if (s.avgUnitCost && s.quantity) {
        cogsReal += Number(s.avgUnitCost) * Number(s.quantity);
      }
    });

    const grossProfit = revenue - cogsReal;

    return { revenue, cogsReal, grossProfit };
  }, [visibleSales]);

  // Helpers para cantidades vendidas
  const mStr = (v: unknown) =>
    String(v ?? "")
      .toLowerCase()
      .trim();
  const getQty = (s: any) => Number(s.qty ?? s.quantity ?? 0);

  // Libras: acepta varias variantes
  const isLb = (m: unknown) =>
    ["lb", "lbs", "libra", "libras"].includes(mStr(m));

  // Unidades: SOLO si explícitamente es unidad/pieza (no undefined)
  const isUnit = (m: unknown) =>
    ["unidad", "unidades", "ud", "uds", "pieza", "piezas"].includes(mStr(m));

  const normalizeUnit = (m: unknown) => {
    if (isLb(m)) return "lb";
    if (isUnit(m)) return "unidad";
    const v = String(m ?? "").trim();
    return v || "unidad";
  };

  const formatDateShort = (v: any) => {
    if (!v) return "—";
    if (typeof v === "string") return v;
    if (v?.toDate) return format(v.toDate(), "yyyy-MM-dd");
    return "—";
  };

  useEffect(() => {
    const loadPending = async () => {
      setPendingLoading(true);
      try {
        const customersSnap = await getDocs(collection(db, "customers_pollo"));
        const customerNameById: Record<string, string> = {};
        customersSnap.forEach((d) => {
          const x = d.data() as any;
          customerNameById[d.id] = String(x.name ?? "(sin nombre)");
        });

        const movementsSnap = await getDocs(
          collection(db, "ar_movements_pollo"),
        );

        const balanceByCustomer: Record<string, number> = {};
        const globalByCustomer: Record<string, number> = {};
        const lastPaymentByCustomer: Record<
          string,
          { amount: number; date?: string; ts?: any }
        > = {};
        const salesByCustomer: Record<string, Set<string>> = {};
        const activeSalesByCustomer: Record<string, Set<string>> = {};
        const saleIds = new Set<string>();
        const paymentsBySaleId: Record<string, number> = {};
        const paymentsByCustomerNoSaleId: Record<string, number> = {};
        const paymentsBySaleIdRange: Record<string, number> = {};
        const paymentsByCustomerNoSaleIdRange: Record<string, number> = {};
        let abonosSum = 0;
        let abonosRangeSum = 0;

        const resolveMovementDate = (m: any) => {
          if (m?.date) return String(m.date);
          if (m?.createdAt?.toDate)
            return format(m.createdAt.toDate(), "yyyy-MM-dd");
          return "";
        };

        movementsSnap.forEach((d) => {
          const m = d.data() as any;
          const customerId = String(m.customerId ?? "").trim();
          if (!customerId) return;

          const amount = Number(m.amount ?? 0);
          balanceByCustomer[customerId] =
            (balanceByCustomer[customerId] || 0) + amount;

          const type = String(m.type ?? "").toUpperCase();
          const statusRaw = String(
            m.debtStatus ?? m.creditStatus ?? m.cycleStatus ?? m.status ?? "",
          )
            .toUpperCase()
            .trim();
          const isSettled = [
            "PAGADA",
            "PAGADO",
            "CERRADA",
            "CERRADO",
            "LIQUIDADA",
            "LIQUIDADO",
          ].includes(statusRaw);
          const createdAt = m.createdAt ?? null;
          if (type === "ABONO") {
            abonosSum += Math.abs(amount);
            const moveDate = resolveMovementDate(m);
            if (moveDate && moveDate >= from && moveDate <= to) {
              abonosRangeSum += Math.abs(amount);
            }
            const abonoSaleId = m?.ref?.saleId ? String(m.ref.saleId) : "";
            if (abonoSaleId) {
              paymentsBySaleId[abonoSaleId] =
                (paymentsBySaleId[abonoSaleId] || 0) + Math.abs(amount);
              if (moveDate && moveDate >= from && moveDate <= to) {
                paymentsBySaleIdRange[abonoSaleId] =
                  (paymentsBySaleIdRange[abonoSaleId] || 0) + Math.abs(amount);
              }
              saleIds.add(abonoSaleId);
            } else {
              paymentsByCustomerNoSaleId[customerId] =
                (paymentsByCustomerNoSaleId[customerId] || 0) +
                Math.abs(amount);
              if (moveDate && moveDate >= from && moveDate <= to) {
                paymentsByCustomerNoSaleIdRange[customerId] =
                  (paymentsByCustomerNoSaleIdRange[customerId] || 0) +
                  Math.abs(amount);
              }
            }
            const prev = lastPaymentByCustomer[customerId];
            const isNewer =
              !prev?.ts ||
              (createdAt?.toDate && prev.ts?.toDate
                ? createdAt.toDate() > prev.ts.toDate()
                : false);
            if (!prev || isNewer) {
              lastPaymentByCustomer[customerId] = {
                amount: Math.abs(amount),
                date: m.date ?? "",
                ts: createdAt,
              };
            }
          }

          if (type === "CARGO") {
            const saleId = m?.ref?.saleId ? String(m.ref.saleId) : "";
            if (saleId) {
              if (!salesByCustomer[customerId])
                salesByCustomer[customerId] = new Set();
              salesByCustomer[customerId].add(saleId);
              if (!isSettled) {
                if (!activeSalesByCustomer[customerId])
                  activeSalesByCustomer[customerId] = new Set();
                activeSalesByCustomer[customerId].add(saleId);
              }
              saleIds.add(saleId);
            }
            if (!isSettled) {
              globalByCustomer[customerId] =
                (globalByCustomer[customerId] || 0) + Math.abs(amount);
            }
          }
        });

        const saleCache = new Map<string, any>();
        await Promise.all(
          Array.from(saleIds).map(async (saleId) => {
            const snap = await getDoc(doc(db, "salesV2", saleId));
            if (snap.exists()) saleCache.set(saleId, snap.data());
          }),
        );

        let grossProfitCashSum = 0;
        let grossProfitCashSumRange = 0;
        const calcLineFinal = (it: any) => {
          const qty = Number(it.qty ?? it.quantity ?? 0);
          return (
            Number(it.lineFinal ?? 0) ||
            Math.max(
              0,
              Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
            )
          );
        };
        const calcSaleTotals = (sale: any) => {
          if (Array.isArray(sale.items) && sale.items.length > 0) {
            let total = 0;
            let cogs = 0;
            sale.items.forEach((it: any) => {
              const qty = Number(it.qty ?? it.quantity ?? 0);
              total += calcLineFinal(it);
              if (Array.isArray(it.allocations) && it.allocations.length > 0) {
                cogs += it.allocations.reduce(
                  (x: number, a: any) => x + Number(a.lineCost || 0),
                  0,
                );
              } else {
                const unitCost = Number(
                  it.avgUnitCost ?? sale.avgUnitCost ?? 0,
                );
                cogs += unitCost * qty;
              }
            });
            return { total, cogs };
          }

          const qty = Number(sale.quantity ?? 0);
          const total = Number(sale.amount ?? sale.amountCharged ?? 0) || 0;
          let cogs = 0;
          if (Array.isArray(sale.allocations) && sale.allocations.length > 0) {
            cogs = sale.allocations.reduce(
              (x: number, a: any) => x + Number(a.lineCost || 0),
              0,
            );
          } else if (sale.avgUnitCost) {
            cogs = Number(sale.avgUnitCost) * qty;
          }

          return { total, cogs };
        };

        const saleTotalsById = new Map<
          string,
          { total: number; cogs: number; grossProfit: number }
        >();

        saleCache.forEach((sale, saleId) => {
          const { total, cogs } = calcSaleTotals(sale);
          saleTotalsById.set(saleId, {
            total,
            cogs,
            grossProfit: total - cogs,
          });
        });

        const grossProfitAllocatedBySaleId: Record<string, number> = {};
        const paidBySaleId: Record<string, number> = {};
        const grossProfitAllocatedBySaleIdRange: Record<string, number> = {};
        const paidBySaleIdRange: Record<string, number> = {};

        Object.keys(paymentsBySaleId).forEach((saleId) => {
          const totals = saleTotalsById.get(saleId);
          if (!totals?.total) return;
          const paid = Number(paymentsBySaleId[saleId] || 0);
          paidBySaleId[saleId] = paid;
          const ratio = Math.min(1, paid / totals.total);
          const gpPart = totals.grossProfit * ratio;
          grossProfitAllocatedBySaleId[saleId] = gpPart;
          grossProfitCashSum += gpPart;
        });

        Object.keys(paymentsBySaleIdRange).forEach((saleId) => {
          const totals = saleTotalsById.get(saleId);
          if (!totals?.total) return;
          const paid = Number(paymentsBySaleIdRange[saleId] || 0);
          paidBySaleIdRange[saleId] = paid;
          const ratio = Math.min(1, paid / totals.total);
          const gpPart = totals.grossProfit * ratio;
          grossProfitAllocatedBySaleIdRange[saleId] = gpPart;
          grossProfitCashSumRange += gpPart;
        });

        Object.keys(paymentsByCustomerNoSaleId).forEach((customerId) => {
          const saleSet = salesByCustomer[customerId];
          if (!saleSet || saleSet.size === 0) return;

          let totalSales = 0;
          let totalGrossProfit = 0;
          let allocatedSales = 0;
          let allocatedGrossProfit = 0;

          saleSet.forEach((saleId) => {
            const totals = saleTotalsById.get(saleId);
            if (!totals) return;
            totalSales += totals.total;
            totalGrossProfit += totals.grossProfit;
            if (paidBySaleId[saleId]) {
              allocatedSales += Math.min(totals.total, paidBySaleId[saleId]);
            }
            allocatedGrossProfit += grossProfitAllocatedBySaleId[saleId] || 0;
          });

          const remainingSales = Math.max(0, totalSales - allocatedSales);
          const remainingGrossProfit = Math.max(
            0,
            totalGrossProfit - allocatedGrossProfit,
          );
          if (!remainingSales || !remainingGrossProfit) return;

          const paid = Number(paymentsByCustomerNoSaleId[customerId] || 0);
          const ratio = Math.min(1, paid / remainingSales);
          grossProfitCashSum += remainingGrossProfit * ratio;
        });

        Object.keys(paymentsByCustomerNoSaleIdRange).forEach((customerId) => {
          const saleSet = salesByCustomer[customerId];
          if (!saleSet || saleSet.size === 0) return;

          let totalSales = 0;
          let totalGrossProfit = 0;
          let allocatedSales = 0;
          let allocatedGrossProfit = 0;

          saleSet.forEach((saleId) => {
            const totals = saleTotalsById.get(saleId);
            if (!totals) return;
            totalSales += totals.total;
            totalGrossProfit += totals.grossProfit;
            if (paidBySaleIdRange[saleId]) {
              allocatedSales += Math.min(
                totals.total,
                paidBySaleIdRange[saleId],
              );
            }
            allocatedGrossProfit +=
              grossProfitAllocatedBySaleIdRange[saleId] || 0;
          });

          const remainingSales = Math.max(0, totalSales - allocatedSales);
          const remainingGrossProfit = Math.max(
            0,
            totalGrossProfit - allocatedGrossProfit,
          );
          if (!remainingSales || !remainingGrossProfit) return;

          const paid = Number(paymentsByCustomerNoSaleIdRange[customerId] || 0);
          const ratio = Math.min(1, paid / remainingSales);
          grossProfitCashSumRange += remainingGrossProfit * ratio;
        });

        const pendingRows: PendingCustomerRow[] = [];
        Object.keys(balanceByCustomer).forEach((customerId) => {
          const balance = Number(balanceByCustomer[customerId] || 0);
          if (balance <= 0) return;

          const productMap = new Map<string, PendingProductRow>();
          let lbs = 0;
          let units = 0;
          let lastSaleDate = "";

          const salesSet =
            activeSalesByCustomer[customerId] || new Set<string>();
          salesSet.forEach((saleId) => {
            const sale = saleCache.get(saleId);
            if (!sale) return;
            const saleDate = String(sale.date ?? "");
            if (saleDate && (!lastSaleDate || saleDate > lastSaleDate)) {
              lastSaleDate = saleDate;
            }

            const items =
              Array.isArray(sale.items) && sale.items.length > 0
                ? sale.items
                : [
                    {
                      productName: sale.productName,
                      qty: sale.quantity,
                      unitPrice: sale.unitPrice,
                      discount: sale.discount,
                      lineFinal: sale.amount ?? sale.amountCharged,
                      measurement: sale.measurement,
                    },
                  ];

            items.forEach((it: any) => {
              const productName = String(it.productName ?? "(sin nombre)");
              const qty = Number(it.qty ?? it.quantity ?? 0);
              const measurement = String(it.measurement ?? "");
              const lineFinal =
                Number(it.lineFinal ?? 0) ||
                Math.max(
                  0,
                  Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
                );

              if (isLb(measurement)) lbs += qty;
              else units += qty;

              const key = `${productName}||${measurement}`;
              const row = productMap.get(key) || {
                productName,
                qty: 0,
                amount: 0,
                measurement,
              };
              row.qty += qty;
              row.amount += lineFinal;
              productMap.set(key, row);
            });
          });

          const lastPayment = lastPaymentByCustomer[customerId];
          const activeGlobalBalance = Number(globalByCustomer[customerId] || 0);

          pendingRows.push({
            customerId,
            name: customerNameById[customerId] || "(sin nombre)",
            balance,
            globalBalance:
              activeGlobalBalance > 0 ? activeGlobalBalance : balance,
            lbs,
            units,
            lastPaymentAmount: Number(lastPayment?.amount || 0),
            lastSaleDate: lastSaleDate || "—",
            lastPaymentDate: formatDateShort(
              lastPayment?.ts || lastPayment?.date,
            ),
            products: Array.from(productMap.values()).sort((a, b) =>
              a.productName.localeCompare(b.productName),
            ),
          });
        });

        const withProducts = pendingRows.filter((row) => row.products.length);
        withProducts.sort((a, b) => b.balance - a.balance);
        setPendingCustomers(withProducts);
        setTotalAbonos(abonosSum);
        setTotalAbonosRange(abonosRangeSum);
        setCreditGrossProfitCash(grossProfitCashSum);
        setCreditGrossProfitCashRange(grossProfitCashSumRange);
      } catch (e) {
        console.error("Error cargando saldos pendientes:", e);
        setPendingCustomers([]);
        setTotalAbonos(0);
        setTotalAbonosRange(0);
        setCreditGrossProfitCashRange(0);
      } finally {
        setPendingLoading(false);
      }
    };

    loadPending();
  }, [refreshKey, from, to]);

  useEffect(() => {
    const loadInventorySummary = async () => {
      try {
        const batchesSnap = await getDocs(
          query(collection(db, "inventory_batches")),
        );

        const fromDate = parse(from, "yyyy-MM-dd", new Date());
        const toDate = parse(to, "yyyy-MM-dd", new Date());
        const monthStart = format(startOfMonth(fromDate), "yyyy-MM-dd");
        const monthEnd = format(endOfMonth(toDate), "yyyy-MM-dd");

        const summary: Record<
          string,
          { incomingQty: number; remainingQty: number }
        > = {};
        let totalExpected = 0;
        let totalInversionLocal = 0;
        let totalExistenciasLocal = 0;
        const incomingLbsDayMap: Record<string, number> = {};
        const expectedVentasDayMap: Record<string, number> = {};

        batchesSnap.forEach((d) => {
          const b = d.data() as any;
          const productName = String(b.productName ?? "(sin nombre)");
          const qty = Number(b.quantity ?? 0);
          const remaining = Number(b.remaining ?? 0);
          const batchDate = b?.date?.toDate
            ? format(b.date.toDate(), "yyyy-MM-dd")
            : String(b?.date ?? b?.createdAt ?? "");
          const batchDateKey =
            typeof batchDate === "string" && batchDate.length >= 10
              ? batchDate.slice(0, 10)
              : "";
          const inPeriod =
            batchDateKey && batchDateKey >= from && batchDateKey <= to;
          const inMonth =
            batchDate && batchDate >= monthStart && batchDate <= monthEnd;
          if (!summary[productName]) {
            summary[productName] = { incomingQty: 0, remainingQty: 0 };
          }
          const expected = Number(
            b.expectedTotal != null
              ? b.expectedTotal
              : Number(b.quantity ?? 0) * Number(b.salePrice ?? 0),
          );
          const invoiced = Number(
            b.invoiceTotal != null
              ? b.invoiceTotal
              : Number(b.quantity ?? 0) * Number(b.purchasePrice ?? 0),
          );
          if (inMonth) {
            summary[productName].incomingQty += qty;
            totalExpected += expected;
            totalInversionLocal += invoiced;
          }
          if (inPeriod) {
            expectedVentasDayMap[batchDateKey] =
              (expectedVentasDayMap[batchDateKey] || 0) + expected;
            const unitRaw = b.unit ?? b.measurement ?? "";
            if (batchIsLb(unitRaw)) {
              incomingLbsDayMap[batchDateKey] =
                (incomingLbsDayMap[batchDateKey] || 0) + qty;
            }
          }
          summary[productName].remainingQty += remaining;
          // accumulate monetary value of remaining stock using salePrice
          const saleP = Number(b.salePrice ?? 0);
          totalExistenciasLocal += Number((remaining * saleP).toFixed(2));
        });

        setInventoryByProduct(summary);
        setTotalExpectedVentas(Number(totalExpected.toFixed(2)));
        setTotalInversion(Number(totalInversionLocal.toFixed(2)));
        setTotalExistenciasMonetarias(Number(totalExistenciasLocal.toFixed(2)));
        setIncomingLbsByDay(incomingLbsDayMap);
        setExpectedVentasByDay(expectedVentasDayMap);
      } catch (e) {
        console.error("Error cargando inventario:", e);
        setInventoryByProduct({});
        setTotalExpectedVentas(0);
        setTotalInversion(0);
        setIncomingLbsByDay({});
        setExpectedVentasByDay({});
      }
    };

    loadInventorySummary();
  }, [refreshKey, from, to]);

  // KPI: Libras vendidas
  const totalLbs = useMemo(
    () =>
      sales.reduce((a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a), 0),
    [sales],
  );

  const totalLbsVisible = useMemo(
    () =>
      visibleSales.reduce(
        (a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [visibleSales],
  );

  const cashSales = useMemo(
    () => visibleSales.filter((s) => s.type === "CONTADO"),
    [visibleSales],
  );
  const creditSales = useMemo(
    () => visibleSales.filter((s) => s.type === "CREDITO"),
    [visibleSales],
  );

  const totalSalesCash = useMemo(
    () => cashSales.reduce((a, s) => a + (s.amount || 0), 0),
    [cashSales],
  );
  const totalSalesCredit = useMemo(
    () => creditSales.reduce((a, s) => a + (s.amount || 0), 0),
    [creditSales],
  );

  const totalPendingBalance = useMemo(
    () => pendingCustomers.reduce((a, c) => a + Number(c.balance || 0), 0),
    [pendingCustomers],
  );

  const cashRevenueWithAbonos = useMemo(
    () => kpisCashVisible.revenue,
    [kpisCashVisible.revenue],
  );

  const totalSalesCashWithAbonos = useMemo(
    () => totalSalesCash,
    [totalSalesCash],
  );

  const collectedCashPlusAbonos = useMemo(
    () => totalSalesCash + totalAbonosRange,
    [totalSalesCash, totalAbonosRange],
  );

  const porRecolectar = useMemo(
    () => Number((totalExpectedVentas - collectedCashPlusAbonos).toFixed(2)),
    [totalExpectedVentas, collectedCashPlusAbonos],
  );

  const utilidadBruta = useMemo(
    () => Number((totalExpectedVentas - totalInversion).toFixed(2)),
    [totalExpectedVentas, totalInversion],
  );

  const grossProfitCashPlusCredit = useMemo(
    () => kpisCashVisible.grossProfit + creditGrossProfitCashRange,
    [kpisCashVisible.grossProfit, creditGrossProfitCashRange],
  );

  const netProfitCashPlusCredit = useMemo(
    () => kpisCashVisible.netProfit + creditGrossProfitCashRange,
    [kpisCashVisible.netProfit, creditGrossProfitCashRange],
  );

  const lbsDailyChartData = useMemo(() => {
    const soldByDay: Record<string, number> = {};
    visibleSales.forEach((s: any) => {
      if (!isLb(s.measurement)) return;
      const d = String(s.date || "").slice(0, 10);
      if (!d) return;
      soldByDay[d] = (soldByDay[d] || 0) + getQty(s);
    });
    const days = eachDayInclusive(from, to);
    return days.map((day) => ({
      day,
      label: format(parse(day, "yyyy-MM-dd", new Date()), "dd/MM"),
      incoming: incomingLbsByDay[day] ?? 0,
      consumed: soldByDay[day] ?? 0,
    }));
  }, [from, to, visibleSales, incomingLbsByDay]);

  const revenueDailyChartData = useMemo(() => {
    const cashByDay: Record<string, number> = {};
    visibleSales
      .filter((s) => s.type === "CONTADO")
      .forEach((s) => {
        const d = String(s.date || "").slice(0, 10);
        if (!d) return;
        cashByDay[d] = (cashByDay[d] || 0) + Number(s.amount || 0);
      });
    const days = eachDayInclusive(from, to);
    let cumCash = 0;
    let cumExpected = 0;
    return days.map((day) => {
      cumCash += cashByDay[day] ?? 0;
      cumExpected += expectedVentasByDay[day] ?? 0;
      return {
        day,
        label: format(parse(day, "yyyy-MM-dd", new Date()), "dd/MM"),
        cumCash,
        cumExpected,
      };
    });
  }, [from, to, visibleSales, expectedVentasByDay]);

  const openDashMenu = () => {
    const r = dashMenuBtnRef.current?.getBoundingClientRect() ?? null;
    setDashMenuRect(r);
    setDashMenuOpen(true);
  };

  const totalLbsCash = useMemo(
    () =>
      cashSales.reduce(
        (a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [cashSales],
  );
  const totalLbsCredit = useMemo(
    () =>
      creditSales.reduce(
        (a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [creditSales],
  );

  // KPI: Unidades vendidas
  const totalUnits = useMemo(
    () =>
      sales.reduce(
        (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [sales],
  );

  const totalUnitsVisible = useMemo(
    () =>
      visibleSales.reduce(
        (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [visibleSales],
  );

  const totalUnitsCash = useMemo(
    () =>
      cashSales.reduce(
        (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [cashSales],
  );
  const totalUnitsCredit = useMemo(
    () =>
      creditSales.reduce(
        (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
        0,
      ),
    [creditSales],
  );

  // list of products present in the selected date range
  const productsInRange = useMemo(() => {
    return Array.from(
      new Set(sales.map((s) => s.productName || "(sin nombre)")),
    ).sort();
  }, [sales]);

  const productFilterSelectOptions = useMemo(
    () => [
      { value: "", label: "Todos los productos" },
      ...productsInRange.map((name) => ({ value: name, label: name })),
    ],
    [productsInRange],
  );

  // Consolidado por producto (con fechas)
  const byProduct = useMemo(() => {
    type Row = {
      productName: string;
      units: number;
      revenue: number;
      cogs: number;
      profit: number;
      firstDate?: string;
      lastDate?: string;
    };
    const map = new Map<string, Row>();

    for (const s of visibleSales) {
      const key = s.productName || "(sin nombre)";
      if (!map.has(key))
        map.set(key, {
          productName: key,
          units: 0,
          revenue: 0,
          cogs: 0,
          profit: 0,
          firstDate: s.date || "",
          lastDate: s.date || "",
        });

      const row = map.get(key)!;
      row.units += Number(s.quantity || 0);
      row.revenue += Number(s.amount || 0);

      if (!row.firstDate || s.date < (row.firstDate || s.date))
        row.firstDate = s.date;
      if (!row.lastDate || s.date > (row.lastDate || s.date))
        row.lastDate = s.date;

      let c = 0;
      if (s.allocations?.length) {
        c = s.allocations.reduce((x, a) => x + Number(a.lineCost || 0), 0);
      } else if (s.avgUnitCost) {
        c = Number(s.avgUnitCost) * Number(s.quantity || 0);
      }
      row.cogs += c;
      row.profit = row.revenue - row.cogs;
    }

    return Array.from(map.values()).sort((a, b) =>
      a.productName.localeCompare(b.productName),
    );
  }, [visibleSales]);

  // KPI: Top 3 productos por libras/unidades vendidas
  const topProducts = useMemo(() => {
    return [...byProduct]
      .sort((a, b) => b.units - a.units)
      .slice(0, 3)
      .map((r, i) => ({ idx: i + 1, name: r.productName, units: r.units }));
  }, [byProduct]);

  const toggleProduct = (key: string) =>
    setOpenProducts((p) => ({ ...p, [key]: !p[key] }));
  const toggleExpense = (key: string) =>
    setOpenExpenses((p) => ({ ...p, [key]: !p[key] }));

  const handleExportPdf = () => {
    const doc = new jsPDF({ unit: "pt", format: "a4" });
    const title = "Dashboard Financiero";
    const subtitle = `Rango: ${from} a ${to}`;
    const filterText = productFilter
      ? `Producto: ${productFilter}`
      : "Producto: Todos";

    doc.setFontSize(16);
    doc.text(title, 40, 40);
    doc.setFontSize(10);
    doc.text(subtitle, 40, 58);
    doc.text(filterText, 40, 72);

    let cursorY = 90;

    const bumpCursor = () => {
      cursorY = (doc as any).lastAutoTable?.finalY
        ? (doc as any).lastAutoTable.finalY + 18
        : cursorY + 18;
    };

    const addKpiTable = (sectionTitle: string, rows: [string, string][]) => {
      if (!rows.length) return;
      doc.setFontSize(11);
      doc.text(sectionTitle, 40, cursorY);
      cursorY += 12;

      autoTable(doc, {
        startY: cursorY,
        head: [["KPI", "Valor"]],
        body: rows,
        styles: { fontSize: 9 },
        headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
      });

      bumpCursor();
    };

    addKpiTable("KPIs Generales", [
      ["Ventas (rango)", money(kpisVisible.revenue)],
      ["Costo", money(kpisVisible.cogsReal)],
      ["Utilidad Bruta", money(kpisVisible.grossProfit)],
      ["Gastos", money(kpisVisible.expensesSum)],
      ["Utilidad Neta", money(kpisVisible.netProfit)],
    ]);

    addKpiTable("KPIs Cash", [
      ["Ventas Cash", money(cashRevenueWithAbonos)],
      ["Costo Cash", money(kpisCashVisible.cogsReal)],
      ["Utilidad Bruta Cash", money(kpisCashVisible.grossProfit)],
    ]);

    addKpiTable("KPIs Crédito", [
      ["Ventas Crédito", money(kpisCreditVisible.revenue)],
      ["Costo Crédito", money(kpisCreditVisible.cogsReal)],
      ["Utilidad Bruta Crédito", money(kpisCreditVisible.grossProfit)],
    ]);

    addKpiTable("Fondos y Utilidades", [
      ["CxC", money(totalPendingBalance)],
      ["Recaudación (Abonos)", money(totalAbonos)],
      ["Recaudación a la fecha", money(totalAbonosRange)],
      ["Existencias Monetarias", money(totalExistenciasMonetarias)],
      ["Recolectado Cash + Abonos", money(collectedCashPlusAbonos)],
      ["Utilidad Neta Crédito (Caja)", money(creditGrossProfitCashRange)],
      ["Utilidad Bruta Cash + Crédito", money(grossProfitCashPlusCredit)],
      ["Gastos", money(kpisCashVisible.expensesSum)],
      ["Utilidad Neta Cash + Crédito", money(netProfitCashPlusCredit)],
    ]);

    addKpiTable("KPIs de Volumen y Ventas", [
      ["Ventas Cash", money(totalSalesCashWithAbonos)],
      ["Ventas Crédito", money(totalSalesCredit)],
      ["Libras Cash", qty3(totalLbsCash)],
      ["Libras Crédito", qty3(totalLbsCredit)],
      ["Libras Cash + Crédito", qty3(totalLbsCash + totalLbsCredit)],
      ["Unidades Cash", qty3(totalUnitsCash)],
      ["Unidades Crédito", qty3(totalUnitsCredit)],
      ["Unidades Cash + Crédito", qty3(totalUnitsCash + totalUnitsCredit)],
    ]);

    if (topProducts.length > 0) {
      doc.setFontSize(11);
      doc.text("Top productos por unidades", 40, cursorY);
      cursorY += 12;

      autoTable(doc, {
        startY: cursorY,
        head: [["#", "Producto", "Cantidad"]],
        body: topProducts.map((t) => [String(t.idx), t.name, qty3(t.units)]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
      });

      bumpCursor();
    }

    autoTable(doc, {
      startY: cursorY,
      head: [
        [
          "Cliente",
          "Libras",
          "Unidades",
          "Saldo Global",
          "Último abono",
          "Saldo pendiente",
          "Fecha ult. abono",
        ],
      ],
      body: pendingCustomers.map((c) => [
        c.name,
        qty3(c.lbs),
        qty3(c.units),
        money(c.globalBalance),
        money(c.lastPaymentAmount),
        money(c.balance),
        c.lastPaymentDate || "—",
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
      didDrawPage: (data) => {
        if (data.pageNumber > 1) {
          doc.setFontSize(10);
          doc.text(title, 40, 30);
        }
      },
    });

    bumpCursor();

    autoTable(doc, {
      startY: cursorY,
      head: [
        [
          "Producto",
          "Ingresado",
          "Disponibilidad",
          "Fechas",
          "Cantidad",
          "Venta",
          "Costo",
          "Utilidad",
        ],
      ],
      body: byProduct.map((r) => [
        r.productName,
        qty3(inventoryByProduct[r.productName]?.incomingQty || 0),
        qty3(inventoryByProduct[r.productName]?.remainingQty || 0),
        r.firstDate && r.lastDate
          ? r.firstDate === r.lastDate
            ? r.firstDate
            : `${r.firstDate} – ${r.lastDate}`
          : "—",
        qty3(r.units),
        money(r.revenue),
        money(r.cogs),
        money(r.profit),
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    bumpCursor();

    autoTable(doc, {
      startY: cursorY,
      head: [["Fecha", "Categoría", "Descripción", "Monto", "Estado"]],
      body: expenses.map((g) => [
        g.date,
        g.category,
        g.description || "—",
        money(g.amount),
        g.status || "—",
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    doc.save(`dashboard_${from}_a_${to}.pdf`);
  };

  const [savingSnapshot, setSavingSnapshot] = useState(false);
  const initialSavedRef = useRef(false);

  const handleSaveSnapshot = async (silent = false) => {
    try {
      setSavingSnapshot(true);

      const user = auth.currentUser;
      const snapshot = {
        from,
        to,
        createdAt: serverTimestamp(),
        user: user
          ? {
              uid: user.uid,
              email: user.email ?? null,
              displayName: user.displayName ?? null,
            }
          : null,
        kpis: {
          visible: kpisVisible,
          cash: kpisCashVisible,
          credit: kpisCreditVisible,
        },
        totals: {
          totalLbs,
          totalUnits,
          totalSalesCash,
          totalSalesCredit,
          totalPendingBalance,
          totalAbonos,
          totalAbonosRange,
          collectedCashPlusAbonos,
          grossProfitCashPlusCredit,
          netProfitCashPlusCredit,
        },
        topProducts: topProducts,
        byProduct: byProduct.map((r) => ({
          productName: r.productName,
          units: r.units,
          revenue: r.revenue,
          cogs: r.cogs,
          profit: r.profit,
        })),
      };

      await addDoc(collection(db, "financial_snapshots"), snapshot);
      if (!silent)
        setToastMsg(
          "✅ KPIs guardados en la colección financial_snapshots.",
        );
    } catch (e) {
      console.error("Error guardando snapshot de KPIs:", e);
      if (!silent)
        setToastMsg("❌ Error guardando snapshot de KPIs. Revisa la consola.");
    } finally {
      setSavingSnapshot(false);
    }
  };

  // Auto-save when date range changes (debounced).
  useEffect(() => {
    // skip first render
    if (!initialSavedRef.current) {
      initialSavedRef.current = true;
      return;
    }

    const t = setTimeout(() => {
      handleSaveSnapshot(true);
    }, 800);

    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  return (
    <div className="w-full min-h-[calc(100dvh-5rem)] bg-gradient-to-b from-slate-100/95 via-slate-50/90 to-white pb-8 pt-2 px-3 sm:px-5 lg:px-6">
      <div className="w-full max-w-[1800px] mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold text-slate-900 tracking-tight">
            Dashboard Financiero
          </h2>
          <p className="text-xs text-slate-500 mt-0.5 hidden sm:block">
            Periodo y KPI en vista amplia
          </p>
        </div>
        <div className="flex items-center justify-end gap-2 shrink-0">
          <div className="hidden md:flex flex-wrap items-center gap-2 justify-end">
            <Button
              type="button"
              onClick={handleExportPdf}
              variant="primary"
              size="sm"
              className="!bg-gray-900 !text-white hover:!bg-black !rounded-lg !shadow-none"
            >
              Exportar PDF
            </Button>
            <Button
              type="button"
              onClick={() => handleSaveSnapshot()}
              disabled={savingSnapshot}
              variant="primary"
              size="sm"
              className="!rounded-lg disabled:!opacity-60"
            >
              {savingSnapshot ? "Guardando…" : "Guardar KPIs"}
            </Button>
            <RefreshButton onClick={refresh} loading={loading} />
          </div>
          <ActionMenuTrigger
            ref={dashMenuBtnRef}
            type="button"
            aria-label="Acciones del dashboard"
            className="md:hidden"
            onClick={() =>
              dashMenuOpen ? setDashMenuOpen(false) : openDashMenu()
            }
          />
          <ActionMenu
            anchorRect={dashMenuRect}
            isOpen={dashMenuOpen}
            onClose={() => setDashMenuOpen(false)}
            width={210}
          >
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClass}
              onClick={() => {
                handleExportPdf();
                setDashMenuOpen(false);
              }}
            >
              Exportar PDF
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClass}
              disabled={savingSnapshot}
              onClick={() => {
                void handleSaveSnapshot();
                setDashMenuOpen(false);
              }}
            >
              {savingSnapshot ? "Guardando…" : "Guardar KPIs"}
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className={actionMenuItemClass}
              disabled={loading}
              onClick={() => {
                refresh();
                setDashMenuOpen(false);
              }}
            >
              Actualizar datos
            </Button>
          </ActionMenu>
        </div>
      </div>

      {/* Filtro de fechas */}
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

      {loading ? (
        <p>Cargando…</p>
      ) : (
        <>
          <div className="mb-3">
            <Button
              type="button"
              onClick={toggleKpiSection}
              variant="outline"
              className="w-full text-left px-4 py-3.5 flex items-center justify-between !rounded-2xl border border-slate-200/80 bg-gradient-to-br from-white via-slate-50/40 to-white shadow-[0_10px_38px_-22px_rgba(15,23,42,0.28)] ring-1 ring-slate-900/[0.04] hover:border-slate-300/90 hover:shadow-lg transition-all !justify-between"
            >
              <div>
                <div className="font-semibold text-slate-900">KPI financiero</div>
                <div className="text-xs text-slate-600 mt-0.5">
                  Ventas:{" "}
                  <span className="font-semibold text-slate-800 tabular-nums">
                    {money(kpisVisible.revenue)}
                  </span>{" "}
                  · Utilidad neta:{" "}
                  <span className="font-semibold text-emerald-800 tabular-nums">
                    {money(kpisVisible.netProfit)}
                  </span>
                </div>
              </div>
              <div className="text-xs font-semibold uppercase tracking-wide text-slate-500 shrink-0 ml-2 px-2 py-1 rounded-lg bg-slate-100/90 border border-slate-200/80">
                {kpiSectionOpen ? "Cerrar" : "Ver"}
              </div>
            </Button>

            {kpiSectionOpen && (
              <div className="mt-3">
                <div className="flex gap-2 mb-2 items-center">
                  <MobileHtmlSelect
                    label={undefined}
                    value={productFilter}
                    onChange={setProductFilter}
                    options={productFilterSelectOptions}
                    sheetTitle="Producto (KPI)"
                    selectClassName="w-full border rounded px-2 py-2 text-sm"
                    buttonClassName="w-full border rounded px-2 py-2 text-sm text-left flex items-center justify-between gap-2 bg-white"
                  />
                </div>

                <div className="md:hidden space-y-3">
                  <div className="rounded-2xl border border-slate-200/70 border-l-[4px] border-l-emerald-500 bg-white shadow-[0_12px_40px_-22px_rgba(15,23,42,0.22)] ring-1 ring-slate-900/[0.04] p-3 sm:p-4 space-y-3">
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full flex items-center justify-between text-left !rounded-xl !shadow-none !px-0 !py-0 !min-h-0 h-auto font-normal"
                      onClick={toggleSalesKpiCard}
                    >
                      <div>
                        <h3 className="font-semibold text-sm text-gray-800">
                          Ventas cash - Credito
                        </h3>
                        <span className="text-xs text-gray-500">Resumen</span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {salesKpiCardOpen ? "Cerrar" : "Ver"}
                      </span>
                    </Button>
                    {salesKpiCardOpen && (
                      <div className="space-y-2">
                        <div className="text-sm text-gray-600">Ventas Cash</div>
                        <div className="text-xl font-bold text-emerald-700 tabular-nums">
                          {money(cashRevenueWithAbonos)}
                        </div>
                        <div className="text-sm text-gray-500">Costo</div>
                        <div className="text-base">
                          {money(kpisCashVisible.cogsReal)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Utilidad Bruta Cash
                        </div>
                        <div className="text-base font-medium">
                          {money(kpisCashVisible.grossProfit)}
                        </div>

                        <hr className="my-2" />

                        <div className="text-sm text-gray-600">
                          Ventas Crédito
                        </div>
                        <div className="text-xl font-bold text-amber-700 tabular-nums">
                          {money(kpisCreditVisible.revenue)}
                        </div>
                        <div className="text-sm text-gray-500">Costo</div>
                        <div className="text-base">
                          {money(kpisCreditVisible.cogsReal)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Utilidad Bruta Crédito
                        </div>
                        <div className="text-base font-medium">
                          {money(kpisCreditVisible.grossProfit)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-slate-200/70 border-l-[4px] border-l-violet-500 bg-white shadow-[0_12px_40px_-22px_rgba(15,23,42,0.22)] ring-1 ring-slate-900/[0.04] p-3 sm:p-4 space-y-3">
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full flex items-center justify-between text-left !rounded-xl !shadow-none !px-0 !py-0 !min-h-0 h-auto font-normal"
                      onClick={toggleFundsKpiCard}
                    >
                      <div>
                        <h3 className="font-semibold text-sm text-gray-800">
                          Fondos
                        </h3>
                        <span className="text-xs text-gray-500">Liquidez</span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {fundsKpiCardOpen ? "Cerrar" : "Ver"}
                      </span>
                    </Button>
                    {fundsKpiCardOpen && (
                      <div className="space-y-2">
                        <div className="text-sm text-gray-600">CxC</div>
                        <div className="text-xl font-bold text-violet-700 tabular-nums">
                          {money(totalPendingBalance)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Recaudación Global(Abonos)
                        </div>
                        <div className="text-base">{money(totalAbonos)}</div>
                        <div className="text-sm text-gray-500">
                          Recaudación a la fecha
                        </div>
                        <div className="text-base">
                          {money(totalAbonosRange)}
                        </div>

                        <hr className="my-2" />

                        <div className="text-sm text-gray-500">
                          Total esperado ventas
                        </div>
                        <div className="text-lg">
                          {money(totalExpectedVentas)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Existencias Monetarias
                        </div>
                        <div className="text-lg">
                          {money(totalExistenciasMonetarias)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Recolectado Cash + Abonos
                        </div>
                        <div className="text-lg">
                          {money(collectedCashPlusAbonos)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Por Recolectar
                        </div>
                        <div
                          className={`text-lg font-medium ${porRecolectar < 0 ? "text-red-600" : ""}`}
                        >
                          {money(porRecolectar)}
                        </div>

                        <hr className="my-2" />

                        <div className="text-sm text-gray-500">Inversion</div>
                        <div className="text-lg">{money(totalInversion)}</div>
                        <div className="text-sm text-gray-500">
                          Utilidad bruta
                        </div>
                        <div className="text-lg">{money(utilidadBruta)}</div>

                        <hr className="my-2" />

                        <div className="text-sm text-gray-500">
                          Utilidad Neta Crédito (Caja)
                        </div>
                        <div className="text-base">
                          {money(creditGrossProfitCashRange)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Utilidad Bruta Cash + Crédito
                        </div>
                        <div className="text-base">
                          {money(grossProfitCashPlusCredit)}
                        </div>
                        <div className="text-sm text-gray-500">Gastos</div>
                        <div className="text-base">
                          {money(kpisCashVisible.expensesSum)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Utilidad Neta Cash + Crédito
                        </div>
                        <div className="text-base font-medium">
                          {money(netProfitCashPlusCredit)}
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="rounded-2xl border border-slate-200/70 border-l-[4px] border-l-amber-500 bg-white shadow-[0_12px_40px_-22px_rgba(15,23,42,0.22)] ring-1 ring-slate-900/[0.04] p-3 sm:p-4 space-y-3">
                    <Button
                      type="button"
                      variant="ghost"
                      className="w-full flex items-center justify-between text-left !rounded-xl !shadow-none !px-0 !py-0 !min-h-0 h-auto font-normal"
                      onClick={toggleDetailsKpiCard}
                    >
                      <div>
                        <h3 className="font-semibold text-sm text-gray-800">
                          Detalles
                        </h3>
                        <span className="text-xs text-gray-500">
                          Métricas adicionales
                        </span>
                      </div>
                      <span className="text-xs text-gray-500">
                        {detailsKpiCardOpen ? "Cerrar" : "Ver"}
                      </span>
                    </Button>
                    {detailsKpiCardOpen && (
                      <div className="space-y-2">
                        <div className="text-sm text-gray-500">Ventas Cash</div>
                        <div className="text-base font-bold">
                          {money(totalSalesCashWithAbonos)}
                        </div>
                        <div className="text-sm text-gray-500">
                          Ventas Crédito
                        </div>
                        <div className="text-base">
                          {money(totalSalesCredit)}
                        </div>
                        <div className="text-sm text-gray-500">Libras Cash</div>
                        <div className="text-base">{qty3(totalLbsCash)}</div>
                        <div className="text-sm text-gray-500">
                          Libras Crédito
                        </div>
                        <div className="text-base">{qty3(totalLbsCredit)}</div>
                        <div className="text-sm text-gray-500">
                          Unidades Cash
                        </div>
                        <div className="text-base">{qty3(totalUnitsCash)}</div>
                        <div className="text-sm text-gray-500">
                          Unidades Crédito
                        </div>
                        <div className="text-base">
                          {qty3(totalUnitsCredit)}
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="hidden md:grid grid-cols-3 gap-4 mb-3">
                  <DashboardCard
                    accent="emerald"
                    eyebrow="Operaciones"
                    title="Cash · Crédito"
                  >
                    <DashboardKpiHero
                      label="Ventas Cash"
                      value={money(cashRevenueWithAbonos)}
                      valueClassName="text-emerald-700"
                    />
                    <DashboardMetricRow
                      label="Costo"
                      value={money(kpisCashVisible.cogsReal)}
                    />
                    <DashboardMetricRow
                      label="Utilidad bruta Cash"
                      value={money(kpisCashVisible.grossProfit)}
                      emphasize
                    />
                    <DashboardSectionDivider label="Crédito" />
                    <DashboardKpiHero
                      label="Ventas Crédito"
                      value={money(kpisCreditVisible.revenue)}
                      valueClassName="text-amber-700"
                    />
                    <DashboardMetricRow
                      label="Costo"
                      value={money(kpisCreditVisible.cogsReal)}
                    />
                    <DashboardMetricRow
                      label="Utilidad bruta Crédito"
                      value={money(kpisCreditVisible.grossProfit)}
                      emphasize
                    />
                  </DashboardCard>

                  <DashboardCard
                    accent="violet"
                    eyebrow="Cartera"
                    title="CxC · Cobranza"
                  >
                    <DashboardKpiHero
                      label="Saldo CxC"
                      value={money(totalPendingBalance)}
                      valueClassName="text-violet-700"
                    />
                    <DashboardMetricRow
                      label="Recaudación global (abonos)"
                      value={money(totalAbonos)}
                    />
                    <DashboardMetricRow
                      label="Recaudación en el periodo"
                      value={money(totalAbonosRange)}
                    />
                    <DashboardSectionDivider label="Proyección" />
                    <DashboardMetricRow
                      label="Total esperado ventas"
                      value={money(totalExpectedVentas)}
                      valueClassName="text-sky-800"
                    />
                    <DashboardMetricRow
                      label="Existencias monetarias"
                      value={money(totalExistenciasMonetarias)}
                    />
                    <DashboardMetricRow
                      label="Recolectado Cash + Abonos"
                      value={money(collectedCashPlusAbonos)}
                    />
                    <DashboardMetricRow
                      label="Por recolectar"
                      value={money(porRecolectar)}
                      emphasize
                      danger={porRecolectar < 0}
                    />
                  </DashboardCard>

                  <DashboardCard
                    accent="amber"
                    eyebrow="Resultado"
                    title="Inversión · Utilidad"
                  >
                    <DashboardKpiHero
                      label="Inversión"
                      value={money(totalInversion)}
                      valueClassName="text-amber-900"
                    />
                    <DashboardMetricRow
                      label="Utilidad bruta"
                      value={money(utilidadBruta)}
                    />
                    <DashboardMetricRow
                      label="Utilidad neta Crédito (caja)"
                      value={money(creditGrossProfitCashRange)}
                    />
                    <DashboardMetricRow
                      label="Utilidad bruta Cash + Crédito"
                      value={money(grossProfitCashPlusCredit)}
                    />
                    <DashboardMetricRow
                      label="Gastos"
                      value={money(kpisCashVisible.expensesSum)}
                    />
                    <DashboardMetricRow
                      label="Utilidad neta Cash + Crédito"
                      value={money(netProfitCashPlusCredit)}
                      emphasize
                      valueClassName="text-emerald-800"
                    />
                  </DashboardCard>
                </div>

                <div className="hidden md:grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6 rounded-2xl border border-slate-200/55 bg-gradient-to-b from-slate-50/95 via-white to-white p-4 sm:p-5 shadow-[inset_0_1px_0_0_rgba(255,255,255,0.9)] ring-1 ring-slate-900/[0.03]">
                  <KpiCompact
                    title="Libras Cash + Credito"
                    value={qty3(totalLbsCash + totalLbsCredit)}
                    valueClassName="text-teal-700"
                  />
                  <KpiCompact
                    title="Unidades Cash + Credito"
                    value={qty3(totalUnitsCash + totalUnitsCredit)}
                    valueClassName="text-indigo-700"
                  />
                  <KpiList
                    title="Productos más vendidos"
                    items={topProducts.map((t) => ({
                      key: `${t.idx}`,
                      label: `${t.idx}. ${t.name}`,
                      value: `(${qty3(t.units)})`,
                    }))}
                  />
                </div>
              </div>
            )}
            <div className="hidden md:grid grid-cols-1 xl:grid-cols-2 gap-4 mb-4 mt-4 px-0">
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.04]">
                    <div className="text-sm font-semibold text-slate-800 mb-1">
                      Libras ingresadas vs consumidas
                    </div>
                    <p className="text-[11px] text-slate-500 mb-3 leading-snug">
                      Por día en el periodo: ingreso en lotes (lb) frente a libras
                      vendidas cash + crédito.
                    </p>
                    <div className="h-[260px] w-full min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={lbsDailyChartData}
                          margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 10 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis tick={{ fontSize: 10 }} width={40} />
                          <Tooltip
                            formatter={(v: number | string | undefined) =>
                              qty3(Number(v ?? 0))
                            }
                            labelStyle={{ fontSize: 12 }}
                          />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Line
                            type="monotone"
                            dataKey="incoming"
                            name="Ingresadas"
                            stroke="#0ea5e9"
                            strokeWidth={2}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="consumed"
                            name="Consumidas"
                            stroke="#f97316"
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                  <div className="rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.04]">
                    <div className="text-sm font-semibold text-slate-800 mb-1">
                      Esperado acumulado vs ventas cash acumuladas
                    </div>
                    <p className="text-[11px] text-slate-500 mb-1 leading-snug">
                      Esperado según ingreso de lotes (acumulado) vs ventas al
                      contado (acumulado en el periodo).
                    </p>
                    <p className="text-[10px] text-slate-600 mb-3 leading-relaxed">
                      Saldos pendientes (CxC):{" "}
                      <span className="font-semibold text-violet-700 tabular-nums">
                        {money(totalPendingBalance)}
                      </span>
                      {" · "}
                      Ventas crédito (periodo):{" "}
                      <span className="font-semibold text-amber-700 tabular-nums">
                        {money(totalSalesCredit)}
                      </span>
                    </p>
                    <div className="h-[240px] w-full min-w-0">
                      <ResponsiveContainer width="100%" height="100%">
                        <LineChart
                          data={revenueDailyChartData}
                          margin={{ top: 4, right: 12, left: 0, bottom: 0 }}
                        >
                          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                          <XAxis
                            dataKey="label"
                            tick={{ fontSize: 10 }}
                            interval="preserveStartEnd"
                          />
                          <YAxis
                            tick={{ fontSize: 10 }}
                            width={48}
                            tickFormatter={(v) =>
                              v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`
                            }
                          />
                          <Tooltip
                            formatter={(v: number | string | undefined) =>
                              money(Number(v ?? 0))
                            }
                            labelStyle={{ fontSize: 12 }}
                          />
                          <Legend wrapperStyle={{ fontSize: 11 }} />
                          <Line
                            type="monotone"
                            dataKey="cumExpected"
                            name="Total esperado acum."
                            stroke="#8b5cf6"
                            strokeWidth={2}
                            dot={false}
                          />
                          <Line
                            type="monotone"
                            dataKey="cumCash"
                            name="Ventas cash acum."
                            stroke="#10b981"
                            strokeWidth={2}
                            dot={false}
                          />
                        </LineChart>
                      </ResponsiveContainer>
                    </div>
                  </div>
                </div>
          </div>

          <div className="mb-3">
            <Button
              type="button"
              onClick={togglePendingSection}
              variant="outline"
              className="w-full text-left px-3 py-3 flex items-center justify-between !rounded-2xl bg-white !justify-between"
            >
              <div className="font-semibold">Saldos pendientes</div>
              <div className="text-gray-500">
                {pendingSectionOpen ? "Cerrar" : "Ver"}
              </div>
            </Button>

            {pendingSectionOpen && (
              <div className="mt-3 rounded-2xl border border-slate-200/90 bg-white shadow-sm overflow-hidden">
                {pendingLoading ? (
                  <div className="text-sm text-slate-600 p-4">
                    Cargando saldos…
                  </div>
                ) : pendingCustomers.length === 0 ? (
                  <div className="text-sm text-slate-600 p-4">
                    Sin saldos pendientes.
                  </div>
                ) : (
                  <>
                    <div className="hidden md:block rounded-xl overflow-x-auto border border-slate-200/80 shadow-sm">
                      <table className="min-w-full w-full text-sm">
                        <thead className="bg-slate-100 sticky top-0 z-10">
                          <tr className="text-[11px] uppercase tracking-wider text-slate-600">
                            <th className="p-3 border-b text-left whitespace-nowrap">
                              Cliente
                            </th>
                            <th className="p-3 border-b text-right whitespace-nowrap">
                              Libras
                            </th>
                            <th className="p-3 border-b text-right whitespace-nowrap">
                              Unidades
                            </th>
                            <th className="p-3 border-b text-right whitespace-nowrap tabular-nums">
                              Saldo global
                            </th>
                            <th className="p-3 border-b text-right whitespace-nowrap tabular-nums">
                              Último abono
                            </th>
                            <th className="p-3 border-b text-right whitespace-nowrap tabular-nums font-semibold text-violet-800">
                              Saldo pendiente
                            </th>
                            <th className="p-3 border-b text-left whitespace-nowrap">
                              Fecha últ. abono
                            </th>
                            <th className="p-3 border-b text-center w-14 whitespace-nowrap" />
                          </tr>
                        </thead>
                        <tbody>
                          {pendingCustomers.map((c) => (
                            <tr
                              key={c.customerId}
                              className="text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition"
                            >
                              <td className="p-3 border-b text-left font-medium text-slate-800 max-w-[14rem] truncate">
                                {c.name}
                              </td>
                              <td className="p-3 border-b text-right tabular-nums text-sky-800 font-medium">
                                {qty3(c.lbs)}
                              </td>
                              <td className="p-3 border-b text-right tabular-nums text-slate-700">
                                {qty3(c.units)}
                              </td>
                              <td className="p-3 border-b text-right tabular-nums">
                                {money(c.globalBalance)}
                              </td>
                              <td className="p-3 border-b text-right tabular-nums">
                                {money(c.lastPaymentAmount)}
                              </td>
                              <td className="p-3 border-b text-right tabular-nums font-semibold text-violet-800">
                                {money(c.balance)}
                              </td>
                              <td className="p-3 border-b text-left whitespace-nowrap text-slate-700">
                                {c.lastPaymentDate || "—"}
                              </td>
                              <td className="p-3 border-b text-center">
                                <Button
                                  type="button"
                                  onClick={() => setPendingOpen(c)}
                                  variant="primary"
                                  size="sm"
                                  className="!bg-indigo-600 hover:!bg-indigo-700 !text-white !rounded-lg !px-3 !py-1 text-xs"
                                >
                                  Ver
                                </Button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>

                    <div className="md:hidden divide-y divide-slate-100">
                      {pendingCustomers.map((c) => (
                        <div
                          key={c.customerId}
                          className="p-4 space-y-3 bg-gradient-to-br from-white to-slate-50/80"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0 flex-1">
                              <div className="font-semibold text-slate-900 leading-snug">
                                {c.name}
                              </div>
                              <div className="text-[11px] text-slate-500 mt-1">
                                Últ. abono:{" "}
                                <span className="text-slate-700">
                                  {c.lastPaymentDate || "—"}
                                </span>
                              </div>
                            </div>
                            <Button
                              type="button"
                              onClick={() => setPendingOpen(c)}
                              variant="primary"
                              size="sm"
                              className="!bg-indigo-600 hover:!bg-indigo-700 shrink-0 !text-white !rounded-lg !px-3 !py-1.5 text-xs"
                            >
                              Ver
                            </Button>
                          </div>
                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div className="rounded-xl border border-slate-200/80 bg-white px-3 py-2 shadow-sm">
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                                Libras
                              </div>
                              <div className="font-semibold tabular-nums text-sky-800">
                                {qty3(c.lbs)}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-white px-3 py-2 shadow-sm">
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                                Unidades
                              </div>
                              <div className="font-semibold tabular-nums text-slate-800">
                                {qty3(c.units)}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-white px-3 py-2 shadow-sm">
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                                Saldo global
                              </div>
                              <div className="font-semibold tabular-nums text-slate-900">
                                {money(c.globalBalance)}
                              </div>
                            </div>
                            <div className="rounded-xl border border-slate-200/80 bg-white px-3 py-2 shadow-sm">
                              <div className="text-[10px] uppercase tracking-wide text-slate-500">
                                Último abono
                              </div>
                              <div className="font-semibold tabular-nums text-slate-900">
                                {money(c.lastPaymentAmount)}
                              </div>
                            </div>
                          </div>
                          <div className="rounded-xl border border-violet-200/90 bg-violet-50/70 px-3 py-2.5 flex items-center justify-between gap-2">
                            <span className="text-xs font-medium text-violet-900">
                              Saldo pendiente
                            </span>
                            <span className="text-lg font-bold tabular-nums text-violet-800">
                              {money(c.balance)}
                            </span>
                          </div>
                        </div>
                      ))}
                    </div>
                  </>
                )}
              </div>
            )}
          </div>

          <div className="mb-3">
            <Button
              type="button"
              onClick={toggleConsolidatedSection}
              variant="outline"
              className="w-full text-left px-3 py-3 flex items-center justify-between !rounded-2xl bg-white !justify-between"
            >
              <div className="font-semibold">Ventas y Gastos</div>
              <div className="text-gray-500">
                {consolidatedSectionOpen ? "Cerrar" : "Ver"}
              </div>
            </Button>

            {consolidatedSectionOpen && (
              <div className="mt-3">
                <h3 className="font-semibold mb-2">Ventas</h3>

                {/* Desktop: tabla */}
                <div className="hidden md:block">
                  <table className="min-w-full border text-sm mb-6">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="border p-2">Producto</th>
                        <th className="border p-2">Ingresado Lb/Un</th>
                        <th className="border p-2">Disponibilidad</th>
                        <th className="border p-2">Fecha Venta</th>
                        <th className="border p-2">Cantidad Lb/Un</th>
                        <th className="border p-2">Monto</th>
                        <th className="border p-2">Costo</th>
                        <th className="border p-2">Utilidad</th>
                      </tr>
                    </thead>
                    <tbody>
                      {byProduct.map((r) => (
                        <tr key={r.productName} className="text-center">
                          <td className="border p-1">{r.productName}</td>
                          <td className="border p-1">
                            {qty3(
                              inventoryByProduct[r.productName]?.incomingQty ||
                                0,
                            )}
                          </td>
                          <td className="border p-1">
                            {qty3(
                              inventoryByProduct[r.productName]?.remainingQty ||
                                0,
                            )}
                          </td>
                          <td className="border p-1">
                            {r.firstDate && r.lastDate
                              ? r.firstDate === r.lastDate
                                ? r.firstDate
                                : `${r.firstDate} – ${r.lastDate}`
                              : "—"}
                          </td>
                          <td className="border p-1">{qty3(r.units)}</td>
                          <td className="border p-1">{money(r.revenue)}</td>
                          <td className="border p-1">{money(r.cogs)}</td>
                          <td
                            className={`border p-1 ${
                              r.profit >= 0 ? "text-green-700" : "text-red-700"
                            }`}
                          >
                            {money(r.profit)}
                          </td>
                        </tr>
                      ))}
                      {byProduct.length === 0 && (
                        <tr>
                          <td
                            colSpan={6}
                            className="p-3 text-center text-gray-500"
                          >
                            Sin datos en el rango seleccionado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: consolidated accordion (collapsed by default) */}
                <div className="md:hidden mb-6">
                  <Button
                    type="button"
                    onClick={toggleConsolidated}
                    variant="outline"
                    className="w-full text-left px-3 py-3 flex items-center justify-between !rounded-2xl bg-white !justify-between"
                  >
                    <div>
                      <div className="font-semibold">Ventas por producto</div>
                      <div className="text-xs text-gray-600">
                        {byProduct.length} productos
                      </div>
                    </div>
                    <div className="text-gray-500">
                      {consolidatedOpen ? "Cerrar" : "Ver"}
                    </div>
                  </Button>

                  {consolidatedOpen && (
                    <div className="space-y-2 mt-3">
                      {byProduct.length === 0 ? (
                        <div className="border rounded-xl p-3 text-sm text-gray-500 bg-gray-50">
                          Sin datos en el rango seleccionado.
                        </div>
                      ) : (
                        byProduct.map((r) => {
                          const open = !!openProducts[r.productName];
                          const fechas =
                            r.firstDate && r.lastDate
                              ? r.firstDate === r.lastDate
                                ? r.firstDate
                                : `${r.firstDate} – ${r.lastDate}`
                              : "—";

                          return (
                            <div
                              key={r.productName}
                              className="border rounded-2xl bg-white shadow-sm overflow-hidden"
                            >
                              <Button
                                type="button"
                                onClick={() => toggleProduct(r.productName)}
                                variant="ghost"
                                className="w-full text-left px-3 py-3 flex items-start gap-3 !rounded-none !shadow-none !justify-start font-normal"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="font-semibold truncate">
                                    {r.productName}
                                  </div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Libras/Unidades
                                  </div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    Vendidas: <b>{qty3(r.units)}</b> •
                                    Disponible:{" "}
                                    <b
                                      className={
                                        inventoryByProduct[r.productName]
                                          ?.remainingQty > 0
                                          ? "text-green-700"
                                          : "text-red-700"
                                      }
                                    >
                                      {qty3(
                                        inventoryByProduct[r.productName]
                                          ?.remainingQty || 0,
                                      )}
                                    </b>
                                  </div>
                                </div>
                                <div className="text-gray-500 text-xs pt-0.10">
                                  {open ? "Cerrar" : "Ver"}
                                </div>
                              </Button>

                              {open && (
                                <div className="px-3 pb-3 text-sm">
                                  <div className="grid grid-cols-2 gap-2">
                                    <Info
                                      label="Lb/Un Ingresadas"
                                      value={qty3(
                                        inventoryByProduct[r.productName]
                                          ?.incomingQty || 0,
                                      )}
                                    />
                                    <Info
                                      label="Lb/Un Disponibles"
                                      value={qty3(
                                        inventoryByProduct[r.productName]
                                          ?.remainingQty || 0,
                                      )}
                                    />
                                    <Info label="Fechas Venta" value={fechas} />
                                    <Info
                                      label="Lb/Un Vendidas"
                                      value={qty3(r.units)}
                                    />
                                    <Info
                                      label="Facturado al costo"
                                      value={money(r.cogs)}
                                    />

                                    <Info
                                      label="Monto Venta"
                                      value={money(r.revenue)}
                                    />
                                    <Info
                                      label="Utilidad bruta"
                                      value={money(r.profit)}
                                      valueClass={
                                        r.profit >= 0
                                          ? "text-green-700 font-semibold"
                                          : "text-red-700 font-semibold"
                                      }
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>

                {/* ===================== GASTOS ===================== */}
                <h3 className="font-semibold mb-2">Gastos del periodo</h3>

                {/* Desktop: tabla */}
                <div className="hidden md:block">
                  <table className="min-w-full border text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="border p-2">Fecha</th>
                        <th className="border p-2">Categoría</th>
                        <th className="border p-2">Descripción</th>
                        <th className="border p-2">Monto</th>
                        <th className="border p-2">Estado</th>
                      </tr>
                    </thead>
                    <tbody>
                      {expenses.map((g) => (
                        <tr key={g.id} className="text-center">
                          <td className="border p-1">{g.date}</td>
                          <td className="border p-1">{g.category}</td>
                          <td className="border p-1">{g.description}</td>
                          <td className="border p-1">{money(g.amount)}</td>
                          <td className="border p-1">
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                g.status === "PAGADO"
                                  ? "bg-green-100 text-green-700"
                                  : "bg-yellow-100 text-yellow-700"
                              }`}
                            >
                              {g.status}
                            </span>
                          </td>
                        </tr>
                      ))}
                      {expenses.length === 0 && (
                        <tr>
                          <td
                            colSpan={5}
                            className="p-3 text-center text-gray-500"
                          >
                            Sin gastos en el rango seleccionado.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: gastos accordion (collapsed by default) */}
                <div className="md:hidden mb-6">
                  <Button
                    type="button"
                    onClick={toggleConsolidatedExpenses}
                    variant="outline"
                    className="w-full text-left px-3 py-3 flex items-center justify-between !rounded-2xl bg-white !justify-between"
                  >
                    <div>
                      <div className="font-semibold">Gastos del periodo</div>
                      <div className="text-xs text-gray-600">
                        {expenses.length} registros
                      </div>
                    </div>
                    <div className="text-gray-500">
                      {consolidatedExpensesOpen ? "Cerrar" : "Abrir"}
                    </div>
                  </Button>

                  {consolidatedExpensesOpen && (
                    <div className="space-y-2 mt-3">
                      {expenses.length === 0 ? (
                        <div className="border rounded-xl p-3 text-sm text-gray-500 bg-gray-50">
                          Sin gastos en el rango seleccionado.
                        </div>
                      ) : (
                        expenses.map((g) => {
                          const open = !!openExpenses[g.id];
                          const badge =
                            g.status === "PAGADO"
                              ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700";

                          return (
                            <div
                              key={g.id}
                              className="border rounded-2xl bg-white shadow-sm overflow-hidden"
                            >
                              <Button
                                type="button"
                                onClick={() => toggleExpense(g.id)}
                                variant="ghost"
                                className="w-full text-left px-3 py-3 flex items-start gap-3 !rounded-none !shadow-none !justify-start font-normal"
                              >
                                <div className="flex-1 min-w-0">
                                  <div className="flex items-center gap-2">
                                    <div className="font-semibold truncate">
                                      {g.category}
                                    </div>
                                    <span
                                      className={`px-2 py-0.5 rounded text-[11px] ${badge}`}
                                    >
                                      {g.status}
                                    </span>
                                  </div>
                                  <div className="text-xs text-gray-600 mt-1">
                                    {g.date} • <b>{money(g.amount)}</b>
                                  </div>
                                </div>
                                <div className="text-gray-500 text-sm pt-0.5">
                                  {open ? "Cerrar" : "Ver"}
                                </div>
                              </Button>

                              {open && (
                                <div className="px-3 pb-3 text-sm">
                                  <div className="grid grid-cols-1 gap-2">
                                    <Info label="Fecha" value={g.date} />
                                    <Info
                                      label="Categoría"
                                      value={g.category}
                                    />
                                    <Info
                                      label="Descripción"
                                      value={g.description || "—"}
                                    />
                                    <Info
                                      label="Monto"
                                      value={money(g.amount)}
                                    />
                                    <Info
                                      label="Estado"
                                      value={g.status || "—"}
                                    />
                                  </div>
                                </div>
                              )}
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </>
      )}

      {pendingOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md p-4">
            <div className="flex items-center justify-between mb-3">
              <h4 className="font-semibold text-lg">{pendingOpen.name}</h4>
              <Button
                type="button"
                onClick={() => setPendingOpen(null)}
                variant="ghost"
                size="sm"
                className="text-sm !text-gray-500 hover:!text-gray-700 !min-h-0 !shadow-none"
              >
                ✕
              </Button>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full border text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Libras/Unidades</th>
                    <th className="border p-2">Monto</th>
                    <th className="border p-2">Fecha Venta</th>
                  </tr>
                </thead>
                <tbody>
                  {pendingOpen.products.length === 0 ? (
                    <tr>
                      <td
                        colSpan={4}
                        className="border p-2 text-center text-gray-500"
                      >
                        Sin productos asociados.
                      </td>
                    </tr>
                  ) : (
                    pendingOpen.products.map((p) => (
                      <tr key={`${p.productName}-${p.measurement}`}>
                        <td className="border p-1">{p.productName}</td>
                        <td className="border p-1 text-center">
                          {qty3(p.qty)}
                        </td>
                        <td className="border p-1 text-center">
                          {money(p.amount)}
                        </td>
                        <td className="border p-1 text-center">
                          {pendingOpen.lastSaleDate || "—"}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
      {toastMsg && (
        <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      )}
      </div>
    </div>
  );
}

/* ================== UI pequeñas ================== */

const dashboardAccentBar: Record<"emerald" | "violet" | "amber", string> = {
  emerald: "bg-gradient-to-r from-emerald-500 via-teal-500 to-emerald-600",
  violet: "bg-gradient-to-r from-violet-500 via-indigo-500 to-violet-600",
  amber: "bg-gradient-to-r from-amber-500 via-orange-500 to-amber-600",
};

function DashboardCard({
  accent,
  eyebrow,
  title,
  children,
}: {
  accent: keyof typeof dashboardAccentBar;
  eyebrow: string;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-2xl border border-slate-200/70 bg-white shadow-[0_12px_42px_-20px_rgba(15,23,42,0.28)] ring-1 ring-slate-900/[0.035] overflow-hidden flex flex-col min-h-0 transition-[box-shadow,transform] hover:shadow-[0_18px_52px_-18px_rgba(15,23,42,0.32)] hover:-translate-y-[1px]">
      <div
        className={`h-[3px] w-full ${dashboardAccentBar[accent]}`}
        aria-hidden
      />
      <div className="px-4 pt-4 pb-3 border-b border-slate-100/90 bg-gradient-to-br from-slate-50/95 via-white to-white">
        <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-slate-500">
          {eyebrow}
        </p>
        <h4 className="text-[15px] font-semibold text-slate-900 tracking-tight mt-1">
          {title}
        </h4>
      </div>
      <div className="px-4 py-1 pb-4 flex-1">{children}</div>
    </div>
  );
}

function DashboardMetricRow({
  label,
  value,
  emphasize,
  danger,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  emphasize?: boolean;
  danger?: boolean;
  /** Clases Tailwind para el número (p. ej. tonos emerald/violet). */
  valueClassName?: string;
}) {
  return (
    <div className="flex items-start justify-between gap-3 py-2.5 border-b border-slate-100/90 last:border-b-0">
      <span className="text-[11px] sm:text-xs font-medium text-slate-500 leading-snug pt-0.5 max-w-[58%]">
        {label}
      </span>
      <span
        className={`text-right tabular-nums font-semibold shrink-0 ${
          danger
            ? `!text-rose-600 ${emphasize ? "text-base sm:text-[17px]" : "text-sm"}`
            : `${emphasize ? "text-base sm:text-[17px]" : "text-sm"} ${valueClassName ?? "text-slate-900"}`
        }`}
      >
        {value}
      </span>
    </div>
  );
}

function DashboardKpiHero({
  label,
  value,
  valueClassName,
}: {
  label: string;
  value: React.ReactNode;
  valueClassName?: string;
}) {
  return (
    <div className="mb-1 pb-4 border-b border-slate-100">
      <div className="text-[11px] font-medium text-slate-500 mb-1.5">{label}</div>
      <div
        className={`text-2xl sm:text-[1.65rem] font-bold tracking-tight tabular-nums ${
          valueClassName ?? "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

function DashboardSectionDivider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-3">
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400 shrink-0">
        {label}
      </span>
      <div className="h-px flex-1 bg-gradient-to-r from-transparent via-slate-200 to-transparent" />
    </div>
  );
}

function Kpi({
  title,
  value,
  positive,
  negative,
  valueClass,
  subtitle,
}: {
  title: string;
  value: string;
  positive?: boolean;
  negative?: boolean;
  valueClass?: string;
  subtitle?: string;
}) {
  const resolvedValueClass = valueClass
    ? valueClass
    : positive
      ? "text-[#568203]"
      : negative
        ? "text-[#AB274F]"
        : "";

  return (
    <div className="rounded-2xl border border-slate-200/70 bg-gradient-to-b from-white to-slate-50/40 p-4 shadow-[0_10px_34px_-18px_rgba(15,23,42,0.22)] ring-1 ring-slate-900/[0.04]">
      <div className="text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
        {title}
      </div>
      {subtitle ? (
        <div className="text-[11px] text-slate-400 mt-1">{subtitle}</div>
      ) : null}
      <div
        className={`text-[26px] sm:text-[30px] font-bold tracking-tight tabular-nums mt-2 ${resolvedValueClass}`}
      >
        {value}
      </div>
    </div>
  );
}

/** KPI compacto (tipografía pequeña) */
function KpiCompact({
  title,
  value,
  valueClassName,
}: {
  title: string;
  value: string;
  valueClassName?: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-[0_8px_28px_-14px_rgba(15,23,42,0.18)] ring-1 ring-slate-900/[0.03] transition-colors hover:border-teal-200/70 hover:shadow-[0_12px_36px_-14px_rgba(15,23,42,0.2)]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 mb-2">
        {title}
      </div>
      <div
        className={`text-xl sm:text-2xl font-bold tabular-nums tracking-tight ${
          valueClassName ?? "text-slate-900"
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** KPI de lista (top productos, etc.) */
function KpiList({
  title,
  items,
}: {
  title: string;
  items: { key: string; label: string; value?: string }[];
}) {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-white p-4 shadow-[0_8px_28px_-14px_rgba(15,23,42,0.18)] ring-1 ring-slate-900/[0.03] flex flex-col min-h-[10rem]">
      <div className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-500 pb-3 mb-1 border-b border-slate-100">
        {title}
      </div>
      <ul className="text-[13px] leading-relaxed list-none pl-0 m-0 space-y-2 flex-1 overflow-auto max-h-40 pr-0.5">
        {items.length === 0 ? (
          <li className="text-slate-400 text-sm">—</li>
        ) : (
          items.map((it) => (
            <li
              key={it.key}
              className="flex items-baseline justify-between gap-2 py-1.5 px-2 -mx-2 rounded-lg hover:bg-slate-50/90 transition-colors"
            >
              <span className="text-slate-700 font-medium truncate min-w-0">
                {it.label}
              </span>
              <span className="text-slate-600 tabular-nums shrink-0 text-xs font-semibold">
                {it.value ?? ""}
              </span>
            </li>
          ))
        )}
      </ul>
    </div>
  );
}

function Info({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: React.ReactNode;
  valueClass?: string;
}) {
  return (
    <div className="border border-slate-200/70 rounded-xl p-2.5 bg-gradient-to-br from-slate-50/90 to-white shadow-sm">
      <div className="text-[11px] font-medium text-slate-600">{label}</div>
      <div className={`text-sm mt-1 font-medium ${valueClass || ""}`}>{value}</div>
    </div>
  );
}
