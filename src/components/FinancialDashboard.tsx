import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { format } from "date-fns";
import RefreshButton from "../components/common/RefreshButton";
import useManualRefresh from "../hooks/useManualRefresh";

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

  useEffect(() => {
    const load = async () => {
      setLoading(true);

      // Ventas
      const qs = query(
        collection(db, "salesV2"),
        where("date", ">=", from),
        where("date", "<=", to)
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
                Number(it.unitPrice || 0) * qty - Number(it.discount || 0)
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
        where("date", "<=", to)
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
          0
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
    [sales]
  );

  // KPI: Unidades vendidas
  const totalUnits = useMemo(
    () =>
      sales.reduce(
        (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
        0
      ),
    [sales]
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

    for (const s of sales) {
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
      a.productName.localeCompare(b.productName)
    );
  }, [sales]);

  // KPI: Top 3 productos por libras/unidades vendidas
  const topProducts = useMemo(() => {
    return [...byProduct]
      .sort((a, b) => b.units - a.units)
      .slice(0, 3)
      .map((r, i) => ({ idx: i + 1, name: r.productName, units: r.units }));
  }, [byProduct]);

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl ">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Finanzas: Ingresos y Egresos</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>

      {/* Filtro de fechas */}
      <div className="flex flex-wrap items-end gap-2 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {loading ? (
        <p>Cargando…</p>
      ) : (
        <>
          {/* KPIs principales (igual tamaño que antes) */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-3 rounded-2xl shadow-lg p-4 bg-gray-50">
            <Kpi title="Ventas" value={money(kpis.revenue)} />
            <Kpi title="Costo" value={money(kpis.cogsReal)} />
            <Kpi
              title="Ganancia Bruta"
              value={money(kpis.grossProfit)}
              positive
            />
            <Kpi title="Gastos" value={money(kpis.expensesSum)} />
            <Kpi title="Ganancia Neta" value={money(kpis.netProfit)} positive />
          </div>

          {/* KPIs secundarios (debajo y compactos) */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mb-6 rounded-lg shadow-2xl p-4 bg-gray-50">
            <KpiCompact title="Libras Vendidas" value={qty3(totalLbs)} />
            <KpiCompact title="Unidades Vendidas" value={qty3(totalUnits)} />
            <KpiList
              title="Productos más vendidos"
              items={topProducts.map((t) => ({
                key: `${t.idx}`,
                label: `${t.idx}. ${t.name}`,
                value: `(${qty3(t.units)})`,
              }))}
            />
          </div>

          {/* Consolidado por producto */}
          <h3 className="font-semibold mb-2">Consolidado por producto</h3>
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

          {/* Gastos del periodo */}
          <h3 className="font-semibold mb-2">Gastos del periodo</h3>
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
    <div className="border rounded-2xl p-3">
      <div className="text-[17px] text-gray-500">{title}</div>
      <div className={`text-[30px] font-bold ${positive ? "text-green-700" : ""}`}>
        {value}
      </div>
    </div>
  );
}

/** KPI compacto (tipografía pequeña) */
function KpiCompact({ title, value }: { title: string; value: string }) {
  return (
    <div className="border rounded-lg p-3">
      <div className="text-[17px] text-gray-500">{title}</div>
      <div className="text-[20px] font-semibold">{value}</div>
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
    <div className="border rounded-lg p-3">
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
