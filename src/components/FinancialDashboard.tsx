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

// Helpers
const money = (n: unknown) => `C$${Number(n ?? 0).toFixed(2)}`;
const todayStr = () => format(new Date(), "yyyy-MM-dd");

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
  allocations?: Allocation[]; // costos reales por lote
  avgUnitCost?: number; // backup: costo unitario promedio guardado
};

type ExpenseDoc = {
  id: string;
  date: string; // "yyyy-MM-dd"
  category: string;
  description?: string;
  amount: number; // Monto del gasto (+)
  status?: "PAGADO" | "PENDIENTE";
  createdAt?: Timestamp;
};

export default function FinancialDashboard(): React.ReactElement {
  const [from, setFrom] = useState(() => {
    // mes actual inicio
    const d = new Date();
    const first = new Date(d.getFullYear(), d.getMonth(), 1);
    return format(first, "yyyy-MM-dd");
  });
  const [to, setTo] = useState(todayStr());
  const [loading, setLoading] = useState(true);

  const [sales, setSales] = useState<SaleDoc[]>([]);
  const [expenses, setExpenses] = useState<ExpenseDoc[]>([]);

  // Carga ventas y gastos por rango (strings "yyyy-MM-dd")
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
        sRows.push({
          id: d.id,
          date: x.date ?? "",
          productName: x.productName ?? "(sin nombre)",
          quantity: Number(x.quantity ?? 0),
          amount: Number(x.amount ?? x.amountCharged ?? 0),
          allocations: Array.isArray(x.allocations) ? x.allocations : [],
          avgUnitCost: Number(x.avgUnitCost ?? 0),
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
  }, [from, to]);

  // --- Cálculos principales ---
  const kpis = useMemo(() => {
    // Ingreso (ventas)
    const revenue = sales.reduce((a, s) => a + (s.amount || 0), 0);

    // Costo real (COGS) usando allocations; si no tiene, cae al avgUnitCost*qty
    let cogsReal = 0;
    sales.forEach((s) => {
      if (s.allocations && s.allocations.length > 0) {
        const line = s.allocations.reduce(
          (x, a) => x + Number(a.lineCost || 0),
          0
        );
        cogsReal += line;
      } else if (s.avgUnitCost && s.quantity) {
        cogsReal += Number(s.avgUnitCost) * Number(s.quantity);
      } // si no, 0
    });

    const grossProfit = revenue - cogsReal;

    // Gastos del periodo (puedes filtrar solo PAGADO si quieres)
    const expensesSum = expenses.reduce((a, g) => a + (g.amount || 0), 0);
    const netProfit = grossProfit - expensesSum;

    return {
      revenue,
      cogsReal,
      grossProfit,
      expensesSum,
      netProfit,
    };
  }, [sales, expenses]);

  // Consolidado por producto (unidades, ingreso, costo, utilidad)
  const byProduct = useMemo(() => {
    type Row = {
      productName: string;
      units: number;
      revenue: number;
      cogs: number;
      profit: number;
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
        });

      const row = map.get(key)!;
      row.units += Number(s.quantity || 0);
      row.revenue += Number(s.amount || 0);

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

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded shadow ">
      <h2 className="text-2xl font-bold mb-4">Finanzas</h2>

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
          {/* KPIs */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-6 text-3xl font-bold">
            <Kpi title="Ventas Totales" value={money(kpis.revenue)} />
            <Kpi title="Costo de Mercaderia" value={money(kpis.cogsReal)} />
            <Kpi
              title="Ganancia antes de Gastos"
              value={money(kpis.grossProfit)}
              positive
            />
            <Kpi title="Gastos del Negocio" value={money(kpis.expensesSum)} />
            <Kpi
              title="Ganancia despues de Gastos"
              value={money(kpis.netProfit)}
              positive
            />
          </div>

          {/* Consolidado por producto */}
          <h3 className="font-semibold mb-2">Consolidado por producto</h3>
          <table className="min-w-full border text-sm mb-6">
            <thead className="bg-gray-100">
              <tr>
                <th className="border p-2">Producto</th>
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
                  <td className="border p-1">{r.units}</td>
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
                  <td colSpan={5} className="p-3 text-center text-gray-500">
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
    <div className="border rounded-lg p-3">
      <div className="text-xs text-gray-500">{title}</div>
      <div className={`text-xl font-bold ${positive ? "text-green-700" : ""}`}>
        {value}
      </div>
    </div>
  );
}
