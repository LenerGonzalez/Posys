import React, { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { format } from "date-fns";
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

const money = (n: unknown) => `C$${Number(n ?? 0).toFixed(2)}`;
const todayStr = () => format(new Date(), "yyyy-MM-dd");
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

  const { refreshKey, refresh } = useManualRefresh();

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

  // accordion mobile for KPIs (collapsed by default)
  const [kpisOpen, setKpisOpen] = useState<boolean>(false);
  const toggleKpis = () => setKpisOpen((v) => !v);
  // product filter for KPIs
  const [productFilter, setProductFilter] = useState<string>("");

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

  // list of products present in the selected date range
  const productsInRange = useMemo(() => {
    return Array.from(
      new Set(sales.map((s) => s.productName || "(sin nombre)")),
    ).sort();
  }, [sales]);

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

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">Dashboard Financiero</h2>
        <RefreshButton onClick={refresh} loading={loading} />
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
          {/* Product filter above KPIs (select-only) */}
          <div className="mb-3">
            <div className="flex gap-2 mb-2 items-center">
              <select
                className="w-full border rounded px-2 py-2 text-sm"
                value={productFilter}
                onChange={(e) => setProductFilter(e.target.value)}
              >
                <option value="">Todos los productos</option>
                {productsInRange.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </div>

            {/* Mobile: KPIs accordion (collapsed by default) */}
            <div className="md:hidden">
              <button
                type="button"
                onClick={toggleKpis}
                className="w-full text-left px-3 py-3 flex items-center justify-between border rounded-2xl bg-white"
              >
                <div>
                  <div className="font-semibold">KPIs</div>
                  <div className="text-xs text-gray-600">
                    Ventas: <b>{money(kpisVisible.revenue)}</b> • Utilidad Neta:{" "}
                    <b>{money(kpisVisible.netProfit)}</b>
                  </div>
                </div>
                <div className="text-gray-500">{kpisOpen ? "▲" : "▼"}</div>
              </button>

              {kpisOpen && (
                <div className="mt-3 space-y-3">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 rounded-2xl shadow-lg p-3 sm:p-4 bg-gray-50">
                    <Kpi title="Ventas" value={money(kpisVisible.revenue)} />
                    <Kpi title="Costo" value={money(kpisVisible.cogsReal)} />
                    <Kpi
                      title="Ganancia Bruta"
                      value={money(kpisVisible.grossProfit)}
                      positive
                    />
                    <Kpi
                      title="Gastos"
                      value={money(kpisVisible.expensesSum)}
                    />
                    <Kpi
                      title="Ganancia Neta"
                      value={money(kpisVisible.netProfit)}
                      positive
                    />
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 rounded-lg shadow-2xl p-3 sm:p-4 bg-gray-50">
                    <KpiCompact
                      title="Libras Vendidas"
                      value={qty3(totalLbsVisible)}
                    />
                    <KpiCompact
                      title="Unidades Vendidas"
                      value={qty3(totalUnitsVisible)}
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
            </div>
          </div>
          {/* KPIs principales */}
          <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-3 rounded-2xl shadow-lg p-3 sm:p-4 bg-gray-50">
            <Kpi title="Ventas" value={money(kpisVisible.revenue)} />
            <Kpi title="Costo" value={money(kpisVisible.cogsReal)} />
            <Kpi
              title="Ganancia Bruta"
              value={money(kpisVisible.grossProfit)}
              positive
            />
            <Kpi title="Gastos" value={money(kpisVisible.expensesSum)} />
            <Kpi
              title="Ganancia Neta"
              value={money(kpisVisible.netProfit)}
              positive
            />
          </div>

          {/* KPIs secundarios */}
          <div className="hidden md:grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6 rounded-lg shadow-2xl p-3 sm:p-4 bg-gray-50">
            <KpiCompact title="Libras Vendidas" value={qty3(totalLbsVisible)} />
            <KpiCompact
              title="Unidades Vendidas"
              value={qty3(totalUnitsVisible)}
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

          {/* ===================== CONSOLIDADO POR PRODUCTO ===================== */}
          <h3 className="font-semibold mb-2">Consolidado por producto</h3>

          {/* Desktop: tabla */}
          <div className="hidden md:block">
            <table className="min-w-full border text-sm mb-6">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border p-2">Producto</th>
                  <th className="border p-2">Fechas</th>
                  <th className="border p-2">Total libras/unidades</th>
                  <th className="border p-2">Ingreso</th>
                  <th className="border p-2">Costo</th>
                  <th className="border p-2">Utilidad</th>
                </tr>
              </thead>
              <tbody>
                {byProduct.map((r) => (
                  <tr key={r.productName} className="text-center">
                    <td className="border p-1">{r.productName}</td>
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
                    <td colSpan={6} className="p-3 text-center text-gray-500">
                      Sin datos en el rango seleccionado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: consolidated accordion (collapsed by default) */}
          <div className="md:hidden mb-6">
            <button
              type="button"
              onClick={toggleConsolidated}
              className="w-full text-left px-3 py-3 flex items-center justify-between border rounded-2xl bg-white"
            >
              <div>
                <div className="font-semibold">Consolidado por producto</div>
                <div className="text-xs text-gray-600">
                  {byProduct.length} productos
                </div>
              </div>
              <div className="text-gray-500">
                {consolidatedOpen ? "▲" : "▼"}
              </div>
            </button>

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
                        <button
                          type="button"
                          onClick={() => toggleProduct(r.productName)}
                          className="w-full text-left px-3 py-3 flex items-start gap-3"
                        >
                          <div className="flex-1 min-w-0">
                            <div className="font-semibold truncate">
                              {r.productName}
                            </div>
                            <div className="text-xs text-gray-600 mt-1">
                              Total: <b>{qty3(r.units)}</b> • Utilidad:{" "}
                              <b
                                className={
                                  r.profit >= 0
                                    ? "text-green-700"
                                    : "text-red-700"
                                }
                              >
                                {money(r.profit)}
                              </b>
                            </div>
                          </div>
                          <div className="text-gray-500 text-sm pt-0.5">
                            {open ? "▲" : "▼"}
                          </div>
                        </button>

                        {open && (
                          <div className="px-3 pb-3 text-sm">
                            <div className="grid grid-cols-2 gap-2">
                              <Info label="Fechas" value={fechas} />
                              <Info label="Total" value={qty3(r.units)} />
                              <Info label="Ingreso" value={money(r.revenue)} />
                              <Info label="Costo" value={money(r.cogs)} />
                              <Info
                                label="Utilidad"
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
                    <td colSpan={5} className="p-3 text-center text-gray-500">
                      Sin gastos en el rango seleccionado.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          {/* Mobile: gastos accordion (collapsed by default) */}
          <div className="md:hidden mb-6">
            <button
              type="button"
              onClick={toggleConsolidatedExpenses}
              className="w-full text-left px-3 py-3 flex items-center justify-between border rounded-2xl bg-white"
            >
              <div>
                <div className="font-semibold">Gastos del periodo</div>
                <div className="text-xs text-gray-600">
                  {expenses.length} registros
                </div>
              </div>
              <div className="text-gray-500">
                {consolidatedExpensesOpen ? "▲" : "▼"}
              </div>
            </button>

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
                        <button
                          type="button"
                          onClick={() => toggleExpense(g.id)}
                          className="w-full text-left px-3 py-3 flex items-start gap-3"
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
                            {open ? "▲" : "▼"}
                          </div>
                        </button>

                        {open && (
                          <div className="px-3 pb-3 text-sm">
                            <div className="grid grid-cols-1 gap-2">
                              <Info label="Fecha" value={g.date} />
                              <Info label="Categoría" value={g.category} />
                              <Info
                                label="Descripción"
                                value={g.description || "—"}
                              />
                              <Info label="Monto" value={money(g.amount)} />
                              <Info label="Estado" value={g.status || "—"} />
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
        </>
      )}
    </div>
  );
}

/* ================== UI pequeñas ================== */

function Kpi({
  title,
  value,
  positive,
}: {
  title: string;
  value: string;
  positive?: boolean;
}) {
  return (
    <div className="border rounded-2xl p-3 bg-white">
      <div className="text-[13px] sm:text-[17px] text-gray-500">{title}</div>
      <div
        className={`text-[26px] sm:text-[30px] font-bold ${
          positive ? "text-green-700" : ""
        }`}
      >
        {value}
      </div>
    </div>
  );
}

/** KPI compacto (tipografía pequeña) */
function KpiCompact({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded-lg p-3 bg-white">
      <div className="text-[13px] sm:text-[17px] text-gray-500">{title}</div>
      <div className="text-[18px] sm:text-[20px] font-semibold">{value}</div>
    </div>
  );
}

/** KPI de lista (3 renglones, tipografía chica) */
function KpiList({
  title,
  items,
}: {
  title: string;
  items: { key: string; label: string; value?: string }[];
}) {
  return (
    <div className="border rounded-lg p-3 bg-white">
      <div className="text-[11px] text-gray-500 mb-1">{title}</div>
      <ul className="text-sm leading-snug list-none pl-0 m-0 space-y-0.5">
        {items.length === 0 ? (
          <li className="text-gray-500">—</li>
        ) : (
          items.map((it) => (
            <li key={it.key}>
              {it.label} {it.value ?? ""}
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
    <div className="border rounded-xl p-2 bg-gray-50">
      <div className="text-[11px] text-gray-600">{label}</div>
      <div className={`text-sm mt-0.5 ${valueClass || ""}`}>{value}</div>
    </div>
  );
}
