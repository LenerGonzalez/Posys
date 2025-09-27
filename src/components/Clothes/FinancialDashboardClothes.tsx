// src/components/Clothes/FinancialDashboardClothes.tsx
import React, { useEffect, useMemo, useState } from "react";
import { collection, getDocs } from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";
import RefreshButton from "../common/RefreshButton"; 
import useManualRefresh from "../../hooks/useManualRefresh";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;


type SaleType = "CONTADO" | "CREDITO";

interface SaleItem {
  productId: string;
  productName: string;
  sku?: string;
  qty: number;
  unitPrice: number;
  discount?: number; // NUEVO
}
interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;
  items: SaleItem[];
  customerId?: string;
}

interface BatchRow {
  id: string;
  productId: string;
  productName: string;
  date: string; // yyyy-MM-dd
  quantity: number;
  remaining: number;
  purchasePrice: number;
}

interface Movement {
  id: string;
  customerId: string;
  type: "CARGO" | "ABONO";
  amount: number; // CARGO > 0, ABONO < 0
  date: string; // yyyy-MM-dd
}

interface Customer {
  id: string;
  name: string;
  balance?: number; // suma de movements (CARGO-ABONO)
}

interface ExpenseRow {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  status?: string;
}

interface CreditPiece {
  saleId: string;
  date: string;
  productName: string;
  sku?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number; // bruto
  discount: number; // descuento por ítem (C$)
  lineFinal: number; // neto (con descuento)
}

/** Devuelve yyyy-MM-dd del createdAt si no hay date string */
function ensureDate(x: any): string {
  const d: string | undefined = x?.date;
  if (d) return d;
  if (x?.createdAt?.toDate) {
    return format(x.createdAt.toDate(), "yyyy-MM-dd");
  }
  return "";
}

/** Normaliza ítems de venta: lee items[] o cae a item {} */
function normalizeSaleItems(x: any): SaleItem[] {
  if (Array.isArray(x?.items)) {
    return x.items.map((it: any) => {
      const qty = Number(it?.qty || 0);
      const unitPrice =
        Number(it?.unitPrice || 0) ||
        (qty > 0 ? Number(it?.total || 0) / qty : 0) ||
        0;
      return {
        productId: String(it?.productId || ""),
        productName: String(it?.productName || ""),
        sku: it?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(it?.discount || 0),
      };
    });
  }

  if (x?.item) {
    const it = x.item;
    const qty = Number(it?.qty || 0) || Number(x?.quantity || 0) || 0;
    const unitPrice =
      Number(it?.unitPrice || 0) ||
      (qty > 0 ? Number(it?.total || x?.total || 0) / qty : 0) ||
      0;

    return [
      {
        productId: String(it?.productId || ""),
        productName: String(it?.productName || ""),
        sku: it?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(it?.discount || 0),
      },
    ];
  }

  const qty = Number(x?.quantity || 0);
  const unitPrice = qty > 0 ? Number(x?.total || 0) / qty : 0;
  if (qty > 0) {
    return [
      {
        productId: String(x?.productId || ""),
        productName: String(x?.productName || ""),
        sku: x?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(x?.discount || 0),
      },
    ];
  }
  return [];
}

// ===== Normalización completa de cada doc de venta =====
function normalizeSale(raw: any, id: string): SaleDoc | null {
  const date = ensureDate(raw);
  if (!date) return null;

  if (Array.isArray(raw.items)) {
    return {
      id,
      date,
      type: (raw.type || "CONTADO") as SaleType,
      total: Number(raw.total ?? raw.itemsTotal ?? 0),
      items: raw.items.map((it: any) => ({
        productId: String(it.productId || ""),
        productName: String(it.productName || ""),
        sku: it.sku || "",
        qty: Number(it.qty || 0),
        unitPrice: Number(
          it.unitPrice ??
            (Number(it.total || 0) / Math.max(1, Number(it.qty || 0)) || 0)
        ),
        discount: Number(it.discount || 0),
      })),
      customerId: raw.customerId || undefined,
    };
  }

  const single = raw.item || {};
  const qty = Number(raw.quantity ?? single.qty ?? 0);
  const lineTotal = Number(raw.total ?? raw.itemsTotal ?? single.total ?? 0);

  return {
    id,
    date,
    type: (raw.type || "CONTADO") as SaleType,
    total: Number(raw.total ?? raw.itemsTotal ?? lineTotal ?? 0),
    items: [
      {
        productId: String(single.productId || raw.productId || ""),
        productName: String(single.productName || raw.productName || ""),
        sku: single.sku || raw.sku || "",
        qty,
        unitPrice: Number(
          single.unitPrice ?? (lineTotal && qty ? lineTotal / qty : 0)
        ),
        discount: Number(single.discount || 0),
      },
    ],
    customerId: raw.customerId || undefined,
  };
}

/** COGS por FIFO */
function computeFifoCogs(
  batches: BatchRow[],
  salesUpToToDate: SaleDoc[],
  fromDate: string,
  toDate: string
) {
  const byProd: Record<
    string,
    {
      productName: string;
      lots: { date: string; qtyLeft: number; cost: number }[];
    }
  > = {};

  for (const b of batches) {
    if (!byProd[b.productId]) {
      byProd[b.productId] = { productName: b.productName, lots: [] };
    }
    byProd[b.productId].lots.push({
      date: b.date,
      qtyLeft: Number(b.quantity || 0),
      cost: Number(b.purchasePrice || 0),
    });
  }

  for (const k of Object.keys(byProd)) {
    byProd[k].lots.sort((a, b) => a.date.localeCompare(b.date));
  }

  const orderedSales = [...salesUpToToDate].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  let cogsPeriod = 0;

  for (const s of orderedSales) {
    for (const it of s.items || []) {
      const map = byProd[it.productId];
      if (!map) continue;
      let need = Number(it.qty || 0);
      if (need <= 0) continue;

      for (const lot of map.lots) {
        if (need <= 0) break;
        if (lot.qtyLeft <= 0) continue;

        const take = Math.min(lot.qtyLeft, need);
        if (s.date >= fromDate && s.date <= toDate) {
          cogsPeriod += take * lot.cost;
        }
        lot.qtyLeft -= take;
        need -= take;
      }
    }
  }

  return cogsPeriod;
}

export default function FinancialDashboardClothes() {
  const { refreshKey, refresh } = useManualRefresh();

  const [fromDate, setFromDate] = useState(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );
  

  const [salesRange, setSalesRange] = useState<SaleDoc[]>([]);
  const [salesUpToToDate, setSalesUpToToDate] = useState<SaleDoc[]>([]);
  const [batchesUpToToDate, setBatchesUpToToDate] = useState<BatchRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [abonos, setAbonos] = useState<Movement[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [modalOpen, setModalOpen] = useState(false);
  const [modalCustomer, setModalCustomer] = useState<Customer | null>(null);
  const [modalPieces, setModalPieces] = useState<CreditPiece[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalKpis, setModalKpis] = useState({
    totalBruto: 0, // NUEVO
    totalDescuento: 0, // NUEVO
    totalFiado: 0, // Neto (bruto - descuento)
    saldoActual: 0,
    abonadoPeriodo: 0,
  });

  // ===== Carga de datos =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // Ventas
        const sSnap = await getDocs(collection(db, "sales_clothes"));
        const allSales: SaleDoc[] = [];
        const rangeSales: SaleDoc[] = [];

        sSnap.forEach((d) => {
          const x = d.data() as any;
          const doc = normalizeSale(x, d.id);
          if (!doc) return;

          if (doc.date <= toDate) allSales.push(doc);
          if (doc.date >= fromDate && doc.date <= toDate) rangeSales.push(doc);
        });
        setSalesUpToToDate(allSales);
        setSalesRange(rangeSales);

        // Lotes
        const bSnap = await getDocs(
          collection(db, "inventory_clothes_batches")
        );
        const allBatches: BatchRow[] = [];
        bSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date || date > toDate) return;
          allBatches.push({
            id: d.id,
            productId: x.productId,
            productName: x.productName || "",
            date,
            quantity: Number(x.quantity || 0),
            remaining: Number(x.remaining || 0),
            purchasePrice: Number(x.purchasePrice || 0),
          });
        });
        setBatchesUpToToDate(allBatches);

        // Gastos
        const eSnap = await getDocs(collection(db, "expenses_clothes"));
        const eList: ExpenseRow[] = [];
        eSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date) return;
          if (date >= fromDate && date <= toDate) {
            eList.push({
              id: d.id,
              date,
              category: x.category || "",
              description: x.description || "",
              amount: Number(x.amount || 0),
              status: x.status || "",
            });
          }
        });
        setExpenses(eList);

        // Movimientos
        const mSnap = await getDocs(collection(db, "ar_movements"));
        const abonosRange: Movement[] = [];
        const balanceByCust: Record<string, number> = {};
        mSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date) return;
          const cid = x.customerId;
          const amt = Number(x.amount || 0);
          if (cid) balanceByCust[cid] = (balanceByCust[cid] || 0) + amt;
          if (x.type === "ABONO" && date >= fromDate && date <= toDate) {
            abonosRange.push({
              id: d.id,
              customerId: cid,
              type: "ABONO",
              amount: amt,
              date,
            });
          }
        });
        setAbonos(abonosRange);

        // Clientes
        const cSnap = await getDocs(collection(db, "customers_clothes"));
        const cList: Customer[] = [];
        cSnap.forEach((d) => {
          const x = d.data() as any;
          cList.push({
            id: d.id,
            name: x.name || "",
            balance: balanceByCust[d.id] || 0,
          });
        });
        setCustomers(cList);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando datos del dashboard.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate, refreshKey]);

  // ====== COGS por FIFO ======
  const cogsFIFO = useMemo(() => {
    try {
      return computeFifoCogs(
        batchesUpToToDate,
        salesUpToToDate,
        fromDate,
        toDate
      );
    } catch (e) {
      console.error(e);
      return 0;
    }
  }, [batchesUpToToDate, salesUpToToDate, fromDate, toDate]);

  // ====== KPIs generales ======
  const kpis = useMemo(() => {
    const ventasTotales = salesRange.reduce((a, s) => a + (s.total || 0), 0);
    const gastosPeriodo = expenses.reduce((a, e) => a + (e.amount || 0), 0);
    const gananciaAntes = ventasTotales - cogsFIFO;
    const gananciaDespues = gananciaAntes - gastosPeriodo;

    const abonosRecibidos = abonos.reduce(
      (a, m) => a + Math.abs(m.amount || 0),
      0
    );

    const clientesConSaldo = customers.filter((c) => (c.balance || 0) > 0);
    const saldosPendientes = clientesConSaldo.reduce(
      (a, c) => a + (c.balance || 0),
      0
    );

    let prendasCash = 0;
    let prendasCredito = 0;
    for (const s of salesRange) {
      const qty = (s.items || []).reduce(
        (a, it) => a + (Number(it.qty) || 0),
        0
      );
      if (s.type === "CONTADO") prendasCash += qty;
      else prendasCredito += qty;
    }

    return {
      ventasTotales,
      costoMercaderia: cogsFIFO,
      gastosPeriodo,
      gananciaAntes,
      gananciaDespues,
      abonosRecibidos,
      saldosPendientes,
      clientesConSaldo: clientesConSaldo.length,
      prendasCash,
      prendasCredito,
    };
  }, [salesRange, expenses, abonos, customers, cogsFIFO]);

  // ===== Consolidado por cliente con saldo =====
  const creditCustomersRows = useMemo(() => {
    const countByCust: Record<string, number> = {};
    for (const s of salesRange) {
      if (s.type !== "CREDITO" || !s.customerId) continue;
      const count = (s.items || []).reduce(
        (a, it) => a + (Number(it.qty) || 0),
        0
      );
      countByCust[s.customerId] = (countByCust[s.customerId] || 0) + count;
    }

    return customers
      .filter((c) => (c.balance || 0) > 0)
      .map((c) => ({
        customerId: c.id,
        name: c.name,
        prendasCredito: countByCust[c.id] || 0,
        saldo: c.balance || 0,
      }))
      .sort((a, b) => b.saldo - a.saldo);
  }, [customers, salesRange]);

  // ===== Modal detalle cliente =====
  const openCustomerModal = async (row: {
    customerId: string;
    name: string;
  }) => {
    setModalOpen(true);
    setModalCustomer({ id: row.customerId, name: row.name });
    setModalPieces([]);
    setModalLoading(true);
    setModalKpis({
      totalBruto: 0,
      totalDescuento: 0,
      totalFiado: 0,
      saldoActual: 0,
      abonadoPeriodo: 0,
    });

    try {
      const list: CreditPiece[] = [];
      let totalBruto = 0;
      let totalDescuento = 0;
      let totalFiado = 0;

      for (const s of salesRange) {
        if (s.type !== "CREDITO" || s.customerId !== row.customerId) continue;
        for (const it of s.items || []) {
          const qty = Number(it.qty || 0);
          const unitPrice = Number(it.unitPrice || 0);
          const lineTotal = qty * unitPrice; // BRUTO
          const discount = Math.max(0, Number(it.discount || 0));
          const lineFinal = Math.max(0, lineTotal - discount); // NETO

          list.push({
            saleId: s.id,
            date: s.date,
            productName: it.productName,
            sku: it.sku || "",
            qty,
            unitPrice,
            lineTotal,
            discount,
            lineFinal,
          });

          totalBruto += lineTotal;
          totalDescuento += discount;
          totalFiado += lineFinal; // KPI usa NETO
        }
      }

      // Abonos del periodo del cliente
      let abonadoPeriodo = 0;
      for (const a of abonos) {
        if (a.customerId === row.customerId) {
          abonadoPeriodo += Math.abs(a.amount || 0);
        }
      }

      // Saldo actual (histórico)
      const cust = customers.find((c) => c.id === row.customerId);
      const saldoActual = cust?.balance || 0;

      setModalPieces(list);
      setModalKpis({
        totalBruto,
        totalDescuento,
        totalFiado,
        saldoActual,
        abonadoPeriodo,
      });
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el detalle del cliente.");
    } finally {
      setModalLoading(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
    

      {/* Filtro */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Finanzas (Ropa)</h2>
        <RefreshButton
          onClick={refresh}
          loading={loading}
        />
      </div>
      <div className="bg-white p-3 rounded shadow border mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div className="flex flex-col">
          <label className="font-semibold">Desde</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <label className="font-semibold">Hasta</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-4 gap-3 mb-4">
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Ventas Totales</div>
          <div className="text-xl font-semibold">
            {money(kpis.ventasTotales)}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Cash + Crédito del periodo.
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Costo de Mercadería (FIFO)
          </div>
          <div className="text-xl font-semibold">
            {money(kpis.costoMercaderia)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Ganancia antes de Gastos</div>
          <div className="text-xl font-semibold text-green-600">
            {money(kpis.gananciaAntes)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Gastos del Negocio</div>
          <div className="text-xl font-semibold">
            {money(kpis.gastosPeriodo)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Ganancia después de Gastos
          </div>
          <div className="text-xl font-semibold text-green-600">
            {money(kpis.gananciaDespues)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Abonos Recibidos</div>
          <div className="text-xl font-semibold">
            {money(kpis.abonosRecibidos)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Saldos Pendientes</div>
          <div className="text-xl font-semibold">
            {money(kpis.saldosPendientes)}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">A la fecha.</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Clientes con Saldo</div>
          <div className="text-xl font-semibold">{kpis.clientesConSaldo}</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Prendas Cash</div>
          <div className="text-xl font-semibold">{kpis.prendasCash}</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Prendas Crédito (vendidas)
          </div>
          <div className="text-xl font-semibold">{kpis.prendasCredito}</div>
        </div>
      </div>

      {/* Consolidado por cliente */}
      <h3 className="text-lg font-semibold mb-2">Consolidado por cliente</h3>
      <div className="bg-white p-2 rounded shadow border w-full mb-6">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Cliente</th>
              <th className="p-2 border">Prendas Crédito (periodo)</th>
              <th className="p-2 border">Saldo actual</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={3}>
                  Cargando…
                </td>
              </tr>
            ) : creditCustomersRows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={3}>
                  Sin clientes con saldo
                </td>
              </tr>
            ) : (
              creditCustomersRows.map((r) => (
                <tr key={r.customerId} className="text-center">
                  <td className="p-2 border">{r.name}</td>
                  <td className="p-2 border">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openCustomerModal({
                          customerId: r.customerId,
                          name: r.name,
                        })
                      }
                      title="Ver piezas fiadas del periodo"
                    >
                      {r.prendasCredito}
                    </button>
                  </td>
                  <td className="p-2 border font-semibold">{money(r.saldo)}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Gastos */}
      <h3 className="text-lg font-semibold mb-2">Gastos del periodo</h3>
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Descripción</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Estado</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Cargando…
                </td>
              </tr>
            ) : expenses.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Sin gastos en el rango seleccionado.
                </td>
              </tr>
            ) : (
              expenses
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((g) => (
                  <tr key={g.id} className="text-center">
                    <td className="p-2 border">{g.date}</td>
                    <td className="p-2 border">{g.category || "—"}</td>
                    <td className="p-2 border">
                      {g.description ? (
                        <span title={g.description}>
                          {g.description.length > 40
                            ? g.description.slice(0, 40) + "…"
                            : g.description}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2 border">{money(g.amount)}</td>
                    <td className="p-2 border">{g.status || "—"}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal detalle cliente */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-5xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Detalle del cliente — {modalCustomer?.name || ""}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            {/* Mini-resumen del periodo para este cliente */}
            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-3">
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">
                  Total Bruto (periodo)
                </div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalBruto)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Descuento (periodo)</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalDescuento)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">
                  Monto Total Fiado (periodo)
                </div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalFiado)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Saldo actual</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.saldoActual)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Abonado (periodo)</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.abonadoPeriodo)}
                </div>
              </div>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Fecha compra</th>
                    <th className="p-2 border">Pieza</th>
                    <th className="p-2 border">SKU</th>
                    <th className="p-2 border">Cant.</th>
                    <th className="p-2 border">P. Unit</th>
                    <th className="p-2 border">Monto</th> {/* Bruto */}
                    <th className="p-2 border">Descuento</th> {/* Nuevo */}
                    <th className="p-2 border">Monto final</th> {/* Neto */}
                  </tr>
                </thead>
                <tbody>
                  {modalLoading ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : modalPieces.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center">
                        Sin piezas fiadas en el periodo.
                      </td>
                    </tr>
                  ) : (
                    modalPieces
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((p, i) => (
                        <tr key={`${p.saleId}-${i}`} className="text-center">
                          <td className="p-2 border">{p.date}</td>
                          <td className="p-2 border">{p.productName}</td>
                          <td className="p-2 border">{p.sku || "—"}</td>
                          <td className="p-2 border">{p.qty}</td>
                          <td className="p-2 border">{money(p.unitPrice)}</td>
                          <td className="p-2 border">{money(p.lineTotal)}</td>
                          <td className="p-2 border">{money(p.discount)}</td>
                          <td className="p-2 border">{money(p.lineFinal)}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
