import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  getDocs,
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
import useManualRefresh from "../../hooks/useManualRefresh";
import {
  fetchBaseSummaryPollo,
  type BaseSummary,
} from "../../Services/baseSummaryPollo";

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");

type LedgerType =
  | "VENTA_CASH"
  | "ABONO"
  | "GASTO"
  | "REABASTECIMIENTO"
  | "RETIRO"
  | "AJUSTE"
  | "DEPOSITO"
  | "PERDIDA"
  | "PRESTAMO A NEGOCIO POR DUENO" // ✅ entra a caja (cash-in)
  | "DEVOLUCION A DUENO POR PRESTAMO" // ✅ sale de caja (cash-out)
  | "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)"; // ✅ NO mueve caja

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
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());
  const [loading, setLoading] = useState(true);

  const [base, setBase] = useState<BaseSummary | null>(null);
  const [ledger, setLedger] = useState<LedgerRow[]>([]);
  const [invLbsRem, setInvLbsRem] = useState<number>(0);
  const [invUdsRem, setInvUdsRem] = useState<number>(0);
  const [invExistenciasMonetarias, setInvExistenciasMonetarias] =
    useState<number>(0);

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
  const [collapseLibras, setCollapseLibras] = useState(false);
  const [collapseUnidades, setCollapseUnidades] = useState(false);
  const [collapseVentas, setCollapseVentas] = useState(false);
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
        setLedger(merged as LedgerRow[]);
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

        snap.forEach((d) => {
          const b = d.data() as any;
          const remaining = Number(b.remaining || 0);
          const qty = Number(b.quantity || 0) || 1;
          // preferir salePrice (unit), si no existe usar expectedTotal/quantity
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
        });

        if (!mounted) return;
        setInvLbsRem(Number(lbs.toFixed(3)));
        setInvUdsRem(Number(uds.toFixed(3)));
        setInvExistenciasMonetarias(Number(moneySum.toFixed(2)));
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

  // Filtered ledger used for display (does not affect KPI totals)
  const filteredLedgerWithBalance = useMemo(() => {
    if (!movementTypeFilter || movementTypeFilter === "ALL")
      return ledgerWithBalance;
    return (ledgerWithBalance || []).filter(
      (r: any) => String(r.type || "") === movementTypeFilter,
    );
  }, [ledgerWithBalance, movementTypeFilter]);

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
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
    ];
    const onlyInTypes: LedgerType[] = [
      "PRESTAMO A NEGOCIO POR DUENO",
      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)",
    ];

    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (!date) return window.alert("Poné una fecha.");
    if (!description.trim()) return window.alert("Poné una descripción.");

    if (isOnlyIn) {
      if (inVal <= 0) return window.alert("Poné una entrada para este tipo.");
    } else if (isOnlyOut) {
      if (outVal <= 0) return window.alert("Poné una salida para este tipo.");
    } else {
      if (inVal <= 0 && outVal <= 0)
        return window.alert("Poné una entrada o una salida.");
      if (inVal > 0 && outVal > 0)
        return window.alert("Usá solo entrada o salida, no ambos.");
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
      } catch (e) {
        console.error("Error updating movement:", e);
        window.alert("No se pudo actualizar el movimiento. Revisa la consola.");
        return;
      }
    } else {
      await addDoc(collection(db, "cash_ledger_pollo"), payload);
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
            className={`text-sm px-3 py-1 border rounded ${
              allCollapsed ? "bg-blue-600 text-white" : "bg-red-600 text-white"
            } hover:opacity-90`}
          >
            {allCollapsed ? "Ver Indicadores" : "Ocultar Indicadores"}
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
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3">
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

          <div className="mt-3 grid grid-cols-1 lg:grid-cols-5 gap-3">
            <div className="border rounded-2xl p-3 bg-blue-50">
              <div className="text-xs text-gray-600">
                Reabastecimiento (pagado con caja)
              </div>
              <div className="text-2xl font-bold">
                {money(displayTotals.reabastecimientoSum || 0)}
              </div>
            </div>

            <div className="border rounded-2xl p-3 bg-amber-50">
              <div className="text-xs text-gray-600">Existencias </div>
              <div className="text-sm text-gray-600">
                Libras: {qty3(invLbsRem)}
              </div>
              <div className="text-sm text-gray-600">
                Unidades: {qty3(invUdsRem)}
              </div>
              <div className="text-2xl font-bold mt-2">
                {money(invExistenciasMonetarias)}
              </div>
            </div>

            <div className="border rounded-2xl p-3 bg-indigo-50">
              <div className="text-xs text-gray-600">
                Saldo Inicial (Ventas Cash + Abonos)
              </div>
              <div className="text-2xl font-bold">{money(saldoBase)}</div>
            </div>

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
                className={`text-xs px-2 py-1 border rounded ${
                  allCollapsed
                    ? "bg-blue-600 text-white"
                    : "bg-red-600 text-white"
                } hover:opacity-90`}
              >
                {allCollapsed ? "Ver Indicadores" : "Colapsar todo"}
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

        <div className="flex flex-col sm:flex-row sm:items-center gap-2 w-full sm:w-auto">
          <label className="text-sm text-gray-700">Tipo:</label>
          <select
            className="border rounded px-2 py-1 text-sm w-full sm:w-auto"
            value={movementTypeFilter}
            onChange={(e) => setMovementTypeFilter(e.target.value)}
          >
            {movementTypes.map((t) => (
              <option key={t} value={t}>
                {t === "ALL" ? "Todos" : t}
              </option>
            ))}
          </select>
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
                <label className="block text-sm text-gray-600 mb-1">
                  Tipo movimiento
                </label>
                <select
                  className="border rounded px-3 py-2 w-full"
                  value={type}
                  onChange={(e) => setType(e.target.value as any)}
                >
                  <option value="GASTO">Gasto</option>
                  <option value="REABASTECIMIENTO">
                    Reabastecimiento (pagado con caja)
                  </option>
                  <option value="RETIRO">Retiro</option>
                  <option value="DEPOSITO">Deposito a Carmen Ortiz</option>
                  <option value="PERDIDA">Perdida por robo</option>
                  <option value="PRESTAMO A NEGOCIO POR DUENO">
                    Préstamo a negocio por dueño (ENTRA A CAJA)
                  </option>
                  <option value="COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)">
                    Compra directa por dueño (NO entra a caja)
                  </option>
                  <option value="DEVOLUCION A DUENO POR PRESTAMO">
                    Devolución a dueño por préstamo (SALE de caja)
                  </option>
                </select>

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
                    "PERDIDA",
                    "DEVOLUCION A DUENO POR PRESTAMO",
                  ].includes(String(type))}
                  aria-disabled={[
                    "GASTO",
                    "REABASTECIMIENTO",
                    "RETIRO",
                    "DEPOSITO",
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
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Movimiento</th>
              <th className="border p-2">Descripción</th>
              <th className="border p-2">Referencia</th>
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
              <td className="border p-1">{money(saldoBase)}</td>
              <td className="border p-1">{money(0)}</td>
              <td className="border p-1 font-semibold">{money(saldoBase)}</td>
              <td className="border p-1">—</td>
            </tr>

            {filteredLedgerWithBalance.map((r: any) => (
              <tr key={r.id} className="text-center">
                <td className="border p-1">{r.date}</td>
                <td className="border p-1">
                  <div className="flex items-center justify-center gap-2 whitespace-nowrap">
                    {r.type === "PRESTAMO A NEGOCIO POR DUENO" ? (
                      <span className="text-[11px] px-2 py-[2px] rounded-full bg-red-100 text-red-800 border border-red-200 whitespace-nowrap">
                        PRESTAMO
                      </span>
                    ) : r.type === "DEVOLUCION A DUENO POR PRESTAMO" ? (
                      <span className="text-[11px] px-2 py-[2px] rounded-full bg-green-100 text-green-800 border border-green-200 whitespace-nowrap">
                        PAGO A PRESTAMO
                      </span>
                    ) : r.type ===
                      "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" ? (
                      <span className="text-[11px] px-2 py-[2px] rounded-full bg-sky-100 text-sky-800 border border-sky-200 whitespace-nowrap">
                        COMPRA DIRECTA
                      </span>
                    ) : (
                      <span className="truncate">{r.type}</span>
                    )}
                  </div>
                </td>
                <td className="border p-1 text-left">{r.description}</td>
                <td className="border p-1">{r.reference || "—"}</td>
                <td className="border p-1">{money(r.inAmount)}</td>
                <td className="border p-1">{money(r.outAmount)}</td>
                <td className="border p-1 font-semibold">{money(r.balance)}</td>
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
                              } catch (e) {
                                console.error(
                                  "Error eliminando movimiento:",
                                  e,
                                );
                                window.alert(
                                  "No se pudo eliminar el movimiento. Revisa la consola.",
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
                <td colSpan={8} className="p-3 text-center text-gray-500">
                  No hay movimientos manuales en este rango.
                </td>
              </tr>
            )}
          </tbody>
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
              className="border rounded-xl p-3 bg-white shadow-sm"
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-sm font-semibold">{r.description}</div>
                  <div className="text-xs text-gray-500 flex items-center gap-2 whitespace-nowrap">
                    <span className="truncate">
                      {r.date} •{" "}
                      {r.type === "PRESTAMO A NEGOCIO POR DUENO" ? (
                        <span className="text-[11px] px-2 py-[2px] rounded-full bg-red-100 text-red-800 border border-red-200 whitespace-nowrap">
                          PRESTAMO
                        </span>
                      ) : r.type === "DEVOLUCION A DUENO POR PRESTAMO" ? (
                        <span className="text-[11px] px-2 py-[2px] rounded-full bg-green-100 text-green-800 border border-green-200 whitespace-nowrap">
                          PAGO A PRESTAMO
                        </span>
                      ) : r.type ===
                        "COMPRA DIRECTA POR DUENO (NO ENTRA A CAJA)" ? (
                        <span className="text-[11px] px-2 py-[2px] rounded-full bg-sky-100 text-sky-800 border border-sky-200 whitespace-nowrap">
                          COMPRA DIRECTA
                        </span>
                      ) : (
                        <span className="truncate">{r.type}</span>
                      )}
                    </span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm">{money(r.inAmount || 0)}</div>
                  <div className="text-xs text-gray-500">Entrada</div>
                </div>
              </div>

              <div className="mt-2 grid grid-cols-2 gap-2 text-sm text-gray-700">
                <div>
                  <div className="text-xs text-gray-500">Referencia</div>
                  <div>{r.reference || "—"}</div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">Saldo (CAJA)</div>
                  <div className="font-semibold">{money(r.balance)}</div>
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
                        } catch (e) {
                          console.error("Error eliminando movimiento:", e);
                          window.alert(
                            "No se pudo eliminar el movimiento. Revisa la consola.",
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
      </div>
    </div>
  );
}
