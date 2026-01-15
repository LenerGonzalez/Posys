// src/components/Candies/CashDeliveriesCandies.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { format, startOfMonth, endOfMonth } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
  PieChart,
  Pie,
  Cell,
} from "recharts";

type SellerDoc = {
  id: string;
  name: string;
  branch?: string;
  commissionPercent?: number; // 15, 20, etc
};

type CashDeliveryDoc = {
  id: string;
  date: Timestamp;

  sellerId: string;
  sellerName: string;

  amountDelivered: number;
  commissionPercent: number;
  commissionPaid: number;
  extraExpenses: number;
  totalFinal: number;

  comment: string;

  createdAt: Timestamp;
  updatedAt?: Timestamp;
};

const SELLERS_COLLECTION = "sellers_candies";
const DELIVERIES_COLLECTION = "cash_deliveries_candies";

function safeNumber(v: any) {
  const n =
    typeof v === "number" ? v : parseFloat(String(v ?? "").replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

function toMoney(n: number) {
  if (!Number.isFinite(n)) return "0.00";
  return n.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
}

function calcCommission(amount: number, percent: number) {
  return (amount * percent) / 100;
}

function calcTotalFinal(amount: number, commission: number, expenses: number) {
  return amount - commission - expenses;
}

function tsToDateInput(ts: Timestamp | null | undefined) {
  if (!ts) return "";
  return format(ts.toDate(), "yyyy-MM-dd");
}

function dateInputToTimestamp(value: string) {
  if (!value) return Timestamp.fromDate(new Date());
  const [y, m, d] = value.split("-").map((x) => parseInt(x, 10));
  const dt = new Date(y, (m || 1) - 1, d || 1, 0, 0, 0, 0);
  return Timestamp.fromDate(dt);
}

export default function CashDeliveriesCandies() {
  // ===== Period filter (mes actual) =====
  const today = new Date();
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(today), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(today), "yyyy-MM-dd")
  );

  // ===== Sellers =====
  const [sellers, setSellers] = useState<SellerDoc[]>([]);
  const sellersMap = useMemo(() => {
    const m = new Map<string, SellerDoc>();
    sellers.forEach((s) => m.set(s.id, s));
    return m;
  }, [sellers]);

  // ===== Rows =====
  const [rows, setRows] = useState<CashDeliveryDoc[]>([]);
  const [loading, setLoading] = useState(true);

  // ===== Add form =====
  const [newDate, setNewDate] = useState(() =>
    format(new Date(), "yyyy-MM-dd")
  );
  const [newSellerId, setNewSellerId] = useState("");
  const [newAmountDelivered, setNewAmountDelivered] = useState("");
  const [newExtraExpenses, setNewExtraExpenses] = useState("0");
  const [newComment, setNewComment] = useState("");

  // ===== Edit =====
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState<
    Partial<CashDeliveryDoc> & { dateInput?: string }
  >({});

  // ===== PDF =====
  const exportRef = useRef<HTMLDivElement>(null);

  // ===== Load sellers =====
  useEffect(() => {
    const qSellers = query(
      collection(db, SELLERS_COLLECTION),
      orderBy("name", "asc")
    );
    const unsub = onSnapshot(
      qSellers,
      (snap) => {
        const list: SellerDoc[] = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            name: String(data?.name ?? ""),
            branch: data?.branch ? String(data.branch) : "",
            commissionPercent: safeNumber(data?.commissionPercent ?? 0),
          };
        });
        setSellers(list);
      },
      () => setSellers([])
    );
    return () => unsub();
  }, []);

  // ===== Load deliveries by period =====
  useEffect(() => {
    setLoading(true);

    const fromTs = dateInputToTimestamp(fromDate);

    // toDate inclusive -> +1 día y usamos "< nextDay"
    const toDt = new Date(dateInputToTimestamp(toDate).toDate().getTime());
    toDt.setDate(toDt.getDate() + 1);
    const toTsExclusive = Timestamp.fromDate(toDt);

    const qDeliveries = query(
      collection(db, DELIVERIES_COLLECTION),
      where("date", ">=", fromTs),
      where("date", "<", toTsExclusive),
      orderBy("date", "desc")
      // ✅ QUITAMOS orderBy("createdAt") para evitar índice compuesto
    );

    const unsub = onSnapshot(
      qDeliveries,
      (snap) => {
        const list = snap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            date: data?.date as Timestamp,
            sellerId: String(data?.sellerId ?? ""),
            sellerName: String(data?.sellerName ?? ""),
            amountDelivered: safeNumber(data?.amountDelivered),
            commissionPercent: safeNumber(data?.commissionPercent),
            commissionPaid: safeNumber(data?.commissionPaid),
            extraExpenses: safeNumber(data?.extraExpenses),
            totalFinal: safeNumber(data?.totalFinal),
            comment: String(data?.comment ?? ""),
            createdAt: data?.createdAt as Timestamp,
            updatedAt: data?.updatedAt as Timestamp | undefined,
          };
        });

        setRows(list);
        setLoading(false);
      },
      (err) => {
        console.error("Firestore deliveries query error:", err);
        setRows([]);
        setLoading(false);
        alert("Firestore query falló. Revisá consola (probable índice).");
      }
    );

    return () => unsub();
  }, [fromDate, toDate]);

  // ===== New row derived =====
  const selectedSeller = useMemo(
    () => (newSellerId ? sellersMap.get(newSellerId) : undefined),
    [newSellerId, sellersMap]
  );
  const newCommissionPercent = safeNumber(
    selectedSeller?.commissionPercent ?? 0
  );
  const newAmountN = safeNumber(newAmountDelivered);
  const newExtraN = safeNumber(newExtraExpenses);
  const newCommissionPaidN = calcCommission(newAmountN, newCommissionPercent);
  const newTotalFinalN = calcTotalFinal(
    newAmountN,
    newCommissionPaidN,
    newExtraN
  );

  // ===== KPIs =====
  const kpiBySeller = useMemo(() => {
    const agg = new Map<
      string,
      {
        sellerId: string;
        sellerName: string;
        delivered: number;
        commission: number;
        totalFinal: number;
      }
    >();

    for (const r of rows) {
      const key = r.sellerId || r.sellerName || "UNKNOWN";
      const prev = agg.get(key) ?? {
        sellerId: r.sellerId,
        sellerName:
          r.sellerName || sellersMap.get(r.sellerId)?.name || "Sin nombre",
        delivered: 0,
        commission: 0,
        totalFinal: 0,
      };

      prev.delivered += safeNumber(r.amountDelivered);
      prev.commission += safeNumber(r.commissionPaid);
      prev.totalFinal += safeNumber(r.totalFinal);

      agg.set(key, prev);
    }

    return Array.from(agg.values()).sort((a, b) =>
      a.sellerName.localeCompare(b.sellerName)
    );
  }, [rows, sellersMap]);

  const totals = useMemo(() => {
    let delivered = 0;
    let commission = 0;
    let expenses = 0;
    let totalFinal = 0;

    for (const r of rows) {
      delivered += safeNumber(r.amountDelivered);
      commission += safeNumber(r.commissionPaid);
      expenses += safeNumber(r.extraExpenses);
      totalFinal += safeNumber(r.totalFinal);
    }

    return { delivered, commission, expenses, totalFinal };
  }, [rows]);

  // ===== Charts =====
  const barData = useMemo(() => {
    return kpiBySeller.map((x) => ({
      name: x.sellerName,
      Entregado: Number(x.delivered.toFixed(2)),
      Comision: Number(x.commission.toFixed(2)),
    }));
  }, [kpiBySeller]);

  const pieData = useMemo(() => {
    return [
      {
        name: "Total Entregado (Bruto)",
        value: Number(totals.delivered.toFixed(2)),
      },
      { name: "Total Comisión", value: Number(totals.commission.toFixed(2)) },
      { name: "Total Gastos", value: Number(totals.expenses.toFixed(2)) },
    ].filter((x) => x.value > 0);
  }, [totals]);

  const pieColors = ["#3B82F6", "#F59E0B", "#EF4444"]; // solo para que se distingan

  // ===== Actions =====
  async function addDelivery() {
    if (!newSellerId) return alert("Seleccioná un vendedor.");
    if (newAmountN <= 0)
      return alert("Ingresá un Monto entregado válido (> 0).");

    const seller = sellersMap.get(newSellerId);
    const sellerName = seller?.name ?? "Sin nombre";
    const commissionPercent = safeNumber(seller?.commissionPercent ?? 0);

    const commissionPaid = calcCommission(newAmountN, commissionPercent);
    const totalFinal = calcTotalFinal(newAmountN, commissionPaid, newExtraN);

    await addDoc(collection(db, DELIVERIES_COLLECTION), {
      date: dateInputToTimestamp(newDate),
      sellerId: newSellerId,
      sellerName,

      amountDelivered: newAmountN,
      commissionPercent,
      commissionPaid,
      extraExpenses: newExtraN,
      totalFinal,

      comment: newComment ?? "",

      createdAt: Timestamp.now(),
    });

    setNewAmountDelivered("");
    setNewExtraExpenses("0");
    setNewComment("");
  }

  function startEdit(r: CashDeliveryDoc) {
    setEditingId(r.id);
    setEditDraft({ ...r, dateInput: tsToDateInput(r.date) });
  }

  function cancelEdit() {
    setEditingId(null);
    setEditDraft({});
  }

  async function saveEdit(id: string) {
    const draft = editDraft;

    const sellerId = String(draft.sellerId ?? "");
    const seller = sellersMap.get(sellerId);
    const sellerName = String(draft.sellerName ?? seller?.name ?? "Sin nombre");

    const amountDelivered = safeNumber(draft.amountDelivered);
    const extraExpenses = safeNumber(draft.extraExpenses);
    const commissionPercent = safeNumber(
      draft.commissionPercent ?? seller?.commissionPercent ?? 0
    );

    const commissionPaid = calcCommission(amountDelivered, commissionPercent);
    const totalFinal = calcTotalFinal(
      amountDelivered,
      commissionPaid,
      extraExpenses
    );

    const dateTs = dateInputToTimestamp(
      String(draft.dateInput ?? tsToDateInput(draft.date as any))
    );

    await updateDoc(doc(db, DELIVERIES_COLLECTION, id), {
      date: dateTs,
      sellerId,
      sellerName,
      amountDelivered,
      commissionPercent,
      commissionPaid,
      extraExpenses,
      totalFinal,
      comment: String(draft.comment ?? ""),
      updatedAt: Timestamp.now(),
    });

    cancelEdit();
  }

  async function removeRow(id: string) {
    if (!confirm("¿Eliminar este registro?")) return;
    await deleteDoc(doc(db, DELIVERIES_COLLECTION, id));
  }

  async function exportPDF() {
    if (!exportRef.current) return;

    const canvas = await html2canvas(exportRef.current, {
      scale: 2,
      useCORS: true,
      backgroundColor: "#ffffff",
      scrollX: 0,
      scrollY: -window.scrollY,
    });

    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF("p", "mm", "a4");

    const pageWidth = pdf.internal.pageSize.getWidth();
    const pageHeight = pdf.internal.pageSize.getHeight();

    const imgWidth = pageWidth;
    const imgHeight = (canvas.height * imgWidth) / canvas.width;

    let remaining = imgHeight;
    let y = 0;

    pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight);
    remaining -= pageHeight;

    while (remaining > 0) {
      pdf.addPage();
      y = -(imgHeight - remaining);
      pdf.addImage(imgData, "PNG", 0, y, imgWidth, imgHeight);
      remaining -= pageHeight;
    }

    pdf.save(`Entregas_Dulces_${fromDate}_a_${toDate}.pdf`);
  }

  return (
    <div className="p-3 md:p-6 max-w-7xl mx-auto space-y-3 md:space-y-4">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
        <div>
          <h1 className="text-lg md:text-2xl font-black text-gray-900">
            Control Contable - Entregas de Vendedores (Dulces)
          </h1>
          <p className="text-xs md:text-sm text-gray-600">
            Periodo: <span className="font-bold">{fromDate}</span> →{" "}
            <span className="font-bold">{toDate}</span>
          </p>
        </div>

        <button
          onClick={exportPDF}
          className="h-10 px-4 rounded-xl bg-gray-900 text-white font-extrabold hover:bg-gray-800 active:scale-[0.99] transition"
        >
          Exportar a PDF
        </button>
      </div>

      {/* Filters */}
      <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
        <div className="font-black text-sm text-gray-900 mb-3">
          Filtros de periodo
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-xs font-bold text-gray-600">Desde</span>
            <input
              type="date"
              value={fromDate}
              onChange={(e) => setFromDate(e.target.value)}
              className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </label>

          <label className="space-y-1">
            <span className="text-xs font-bold text-gray-600">Hasta</span>
            <input
              type="date"
              value={toDate}
              onChange={(e) => setToDate(e.target.value)}
              className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
            />
          </label>
        </div>
      </div>

      {/* Export area */}
      <div ref={exportRef} className="space-y-3 md:space-y-4">
        {/* KPI cards */}
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
          <div className="font-black text-sm text-gray-900 mb-3">
            KPIs Consolidados
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-extrabold text-gray-600">
                KPI Entradas (Neto)
              </div>
              <div className="text-xl font-black text-gray-900 mt-1">
                $ {toMoney(totals.totalFinal)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Entregado - Comisión - Gastos
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-extrabold text-gray-600">
                KPI Comisiones
              </div>
              <div className="text-xl font-black text-gray-900 mt-1">
                $ {toMoney(totals.commission)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Suma de comisión pagada
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-extrabold text-gray-600">
                KPI Gastos extras
              </div>
              <div className="text-xl font-black text-gray-900 mt-1">
                $ {toMoney(totals.expenses)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Suma de gastos registrados
              </div>
            </div>

            <div className="rounded-2xl border border-gray-100 bg-gray-50 p-3">
              <div className="text-xs font-extrabold text-gray-600">
                Total entregado (Bruto)
              </div>
              <div className="text-xl font-black text-gray-900 mt-1">
                $ {toMoney(totals.delivered)}
              </div>
              <div className="text-[11px] text-gray-500 mt-1">
                Sin restar nada
              </div>
            </div>
          </div>

          <div className="font-black text-sm text-gray-900 mt-4 mb-2">
            KPI Vendedores (sumatoria del periodo)
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[520px] w-full text-sm">
              <thead>
                <tr className="bg-gray-50 text-gray-700">
                  <th className="text-left p-2 font-black">Vendedor</th>
                  <th className="text-right p-2 font-black">Entregado</th>
                  <th className="text-right p-2 font-black">Comisión</th>
                  <th className="text-right p-2 font-black">Total final</th>
                </tr>
              </thead>
              <tbody>
                {kpiBySeller.length === 0 ? (
                  <tr>
                    <td className="p-2 text-gray-500" colSpan={4}>
                      Sin datos en el periodo seleccionado.
                    </td>
                  </tr>
                ) : (
                  kpiBySeller.map((x) => (
                    <tr key={x.sellerId || x.sellerName} className="border-t">
                      <td className="p-2">{x.sellerName}</td>
                      <td className="p-2 text-right">
                        $ {toMoney(x.delivered)}
                      </td>
                      <td className="p-2 text-right">
                        $ {toMoney(x.commission)}
                      </td>
                      <td className="p-2 text-right font-extrabold">
                        $ {toMoney(x.totalFinal)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>

        {/* Charts */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
            <div className="font-black text-sm text-gray-900 mb-3">
              Entregas y Comisión por vendedor (Barras)
            </div>
            <div className="w-full h-[320px]">
              <ResponsiveContainer>
                <BarChart data={barData}>
                  <XAxis dataKey="name" interval={0} angle={-12} height={70} />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="Entregado" />
                  <Bar dataKey="Comision" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
            <div className="font-black text-sm text-gray-900 mb-3">
              Distribución (Pastel)
            </div>
            <div className="w-full h-[320px]">
              <ResponsiveContainer>
                <PieChart>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    outerRadius={110}
                    label
                  >
                    {pieData.map((_, idx) => (
                      <Cell
                        key={idx}
                        fill={pieColors[idx % pieColors.length]}
                      />
                    ))}
                  </Pie>
                  <Tooltip />
                  <Legend />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>

        {/* Add movement */}
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
          <div className="font-black text-sm text-gray-900 mb-3">
            Agregar movimiento
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">Fecha</span>
              <input
                type="date"
                value={newDate}
                onChange={(e) => setNewDate(e.target.value)}
                className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">Vendedor</span>
              <select
                value={newSellerId}
                onChange={(e) => setNewSellerId(e.target.value)}
                className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10 bg-white"
              >
                <option value="">Seleccionar...</option>
                {sellers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name} {s.branch ? `(${s.branch})` : ""}
                  </option>
                ))}
              </select>
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">
                Monto entregado
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={newAmountDelivered}
                onChange={(e) => setNewAmountDelivered(e.target.value)}
                placeholder="0.00"
                className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">
                Comisión configurada
              </span>
              <input
                value={`${newCommissionPercent}%`}
                readOnly
                className="w-full h-10 rounded-xl border border-gray-200 px-3 bg-gray-50 text-gray-800"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">
                Comisión pagada
              </span>
              <input
                value={`$ ${toMoney(newCommissionPaidN)}`}
                readOnly
                className="w-full h-10 rounded-xl border border-gray-200 px-3 bg-gray-50 text-gray-800"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">
                Gastos extras
              </span>
              <input
                type="number"
                inputMode="decimal"
                value={newExtraExpenses}
                onChange={(e) => setNewExtraExpenses(e.target.value)}
                placeholder="0.00"
                className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
              />
            </label>

            <label className="space-y-1">
              <span className="text-xs font-bold text-gray-600">
                Total final
              </span>
              <input
                value={`$ ${toMoney(newTotalFinalN)}`}
                readOnly
                className="w-full h-10 rounded-xl border border-gray-200 px-3 bg-gray-50 text-gray-900 font-extrabold"
              />
            </label>

            <label className="space-y-1 md:col-span-2">
              <span className="text-xs font-bold text-gray-600">
                Comentario
              </span>
              <input
                value={newComment}
                onChange={(e) => setNewComment(e.target.value)}
                placeholder="Opcional..."
                className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none focus:ring-2 focus:ring-gray-900/10"
              />
            </label>
          </div>

          <div className="mt-3">
            <button
              onClick={addDelivery}
              className="w-full md:w-auto h-10 px-4 rounded-xl bg-gray-900 text-white font-extrabold hover:bg-gray-800 active:scale-[0.99] transition"
            >
              Guardar movimiento
            </button>
          </div>
        </div>

        {/* Detailed register */}
        <div className="bg-white border border-gray-100 rounded-2xl shadow-sm p-3 md:p-4">
          <div className="font-black text-sm text-gray-900 mb-3">
            Registro detallado
          </div>

          {loading ? (
            <div className="text-sm text-gray-500">Cargando...</div>
          ) : rows.length === 0 ? (
            <div className="text-sm text-gray-500">
              No hay registros en el periodo.
            </div>
          ) : (
            <>
              {/* Desktop: tabla */}
              <div className="hidden md:block overflow-x-auto">
                <table className="min-w-[1100px] w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-gray-700">
                      <th className="text-left p-2 font-black">Fecha</th>
                      <th className="text-left p-2 font-black">Vendedor</th>
                      <th className="text-right p-2 font-black">
                        Monto entregado
                      </th>
                      <th className="text-right p-2 font-black">Comisión %</th>
                      <th className="text-right p-2 font-black">
                        Comisión pagada
                      </th>
                      <th className="text-right p-2 font-black">Gastos</th>
                      <th className="text-right p-2 font-black">Total final</th>
                      <th className="text-left p-2 font-black">Comentario</th>
                      <th className="text-left p-2 font-black">Acciones</th>
                    </tr>
                  </thead>

                  <tbody>
                    {rows.map((r) => {
                      const isEditing = editingId === r.id;

                      if (!isEditing) {
                        return (
                          <tr key={r.id} className="border-t">
                            <td className="p-2">
                              {format(r.date.toDate(), "yyyy-MM-dd")}
                            </td>
                            <td className="p-2 font-semibold">
                              {r.sellerName}
                            </td>
                            <td className="p-2 text-right">
                              $ {toMoney(r.amountDelivered)}
                            </td>
                            <td className="p-2 text-right">
                              {toMoney(r.commissionPercent)}%
                            </td>
                            <td className="p-2 text-right">
                              $ {toMoney(r.commissionPaid)}
                            </td>
                            <td className="p-2 text-right">
                              $ {toMoney(r.extraExpenses)}
                            </td>
                            <td className="p-2 text-right font-extrabold">
                              $ {toMoney(r.totalFinal)}
                            </td>
                            <td className="p-2">{r.comment}</td>
                            <td className="p-2">
                              <div className="flex gap-2">
                                <button
                                  onClick={() => startEdit(r)}
                                  className="h-8 px-3 rounded-xl border border-gray-200 font-extrabold hover:bg-gray-50"
                                >
                                  Editar
                                </button>
                                <button
                                  onClick={() => removeRow(r.id)}
                                  className="h-8 px-3 rounded-xl border border-gray-200 font-extrabold text-red-700 hover:bg-red-50"
                                >
                                  Eliminar
                                </button>
                              </div>
                            </td>
                          </tr>
                        );
                      }

                      // Editing row (desktop inline)
                      const amount = safeNumber(
                        editDraft.amountDelivered ?? r.amountDelivered
                      );
                      const percent = safeNumber(
                        editDraft.commissionPercent ?? r.commissionPercent
                      );
                      const expenses = safeNumber(
                        editDraft.extraExpenses ?? r.extraExpenses
                      );
                      const comm = calcCommission(amount, percent);
                      const total = calcTotalFinal(amount, comm, expenses);

                      return (
                        <tr key={r.id} className="border-t bg-yellow-50/40">
                          <td className="p-2">
                            <input
                              type="date"
                              value={String(editDraft.dateInput ?? "")}
                              onChange={(e) =>
                                setEditDraft((p) => ({
                                  ...p,
                                  dateInput: e.target.value,
                                }))
                              }
                              className="h-9 px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            />
                          </td>

                          <td className="p-2">
                            <select
                              value={String(editDraft.sellerId ?? r.sellerId)}
                              onChange={(e) => {
                                const sellerId = e.target.value;
                                const s = sellersMap.get(sellerId);
                                setEditDraft((p) => ({
                                  ...p,
                                  sellerId,
                                  sellerName: s?.name ?? "",
                                  commissionPercent: safeNumber(
                                    s?.commissionPercent ?? 0
                                  ),
                                }));
                              }}
                              className="h-9 px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            >
                              <option value="">Seleccionar...</option>
                              {sellers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name} {s.branch ? `(${s.branch})` : ""}
                                </option>
                              ))}
                            </select>
                          </td>

                          <td className="p-2 text-right">
                            <input
                              type="number"
                              value={String(amount)}
                              onChange={(e) =>
                                setEditDraft((p) => ({
                                  ...p,
                                  amountDelivered: safeNumber(e.target.value),
                                }))
                              }
                              className="h-9 w-32 text-right px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            />
                          </td>

                          <td className="p-2 text-right">
                            <input
                              type="number"
                              value={String(percent)}
                              onChange={(e) =>
                                setEditDraft((p) => ({
                                  ...p,
                                  commissionPercent: safeNumber(e.target.value),
                                }))
                              }
                              className="h-9 w-24 text-right px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            />
                          </td>

                          <td className="p-2 text-right font-semibold">
                            $ {toMoney(comm)}
                          </td>

                          <td className="p-2 text-right">
                            <input
                              type="number"
                              value={String(expenses)}
                              onChange={(e) =>
                                setEditDraft((p) => ({
                                  ...p,
                                  extraExpenses: safeNumber(e.target.value),
                                }))
                              }
                              className="h-9 w-32 text-right px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            />
                          </td>

                          <td className="p-2 text-right font-extrabold">
                            $ {toMoney(total)}
                          </td>

                          <td className="p-2">
                            <input
                              type="text"
                              value={String(editDraft.comment ?? r.comment)}
                              onChange={(e) =>
                                setEditDraft((p) => ({
                                  ...p,
                                  comment: e.target.value,
                                }))
                              }
                              className="h-9 w-full px-3 rounded-xl border border-gray-200 bg-white outline-none"
                            />
                          </td>

                          <td className="p-2">
                            <div className="flex gap-2">
                              <button
                                onClick={() => saveEdit(r.id)}
                                className="h-8 px-3 rounded-xl bg-gray-900 text-white font-extrabold hover:bg-gray-800"
                              >
                                Guardar
                              </button>
                              <button
                                onClick={cancelEdit}
                                className="h-8 px-3 rounded-xl border border-gray-200 font-extrabold hover:bg-gray-50"
                              >
                                Cancelar
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Mobile: cards */}
              <div className="md:hidden space-y-3">
                {rows.map((r) => (
                  <div
                    key={r.id}
                    className="rounded-2xl border border-gray-100 p-3 bg-white"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="font-black text-gray-900">
                        {r.sellerName}
                      </div>
                      <div className="text-xs font-extrabold bg-gray-100 rounded-full px-3 py-1">
                        {format(r.date.toDate(), "yyyy-MM-dd")}
                      </div>
                    </div>

                    <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                      <div>
                        <div className="text-[11px] font-bold text-gray-500">
                          Monto entregado
                        </div>
                        <div className="font-extrabold">
                          $ {toMoney(r.amountDelivered)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-bold text-gray-500">
                          Comisión %
                        </div>
                        <div className="font-semibold">
                          {toMoney(r.commissionPercent)}%
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-bold text-gray-500">
                          Comisión pagada
                        </div>
                        <div className="font-semibold">
                          $ {toMoney(r.commissionPaid)}
                        </div>
                      </div>
                      <div>
                        <div className="text-[11px] font-bold text-gray-500">
                          Gastos
                        </div>
                        <div className="font-semibold">
                          $ {toMoney(r.extraExpenses)}
                        </div>
                      </div>

                      <div className="col-span-2">
                        <div className="text-[11px] font-bold text-gray-500">
                          Total final
                        </div>
                        <div className="text-base font-black">
                          $ {toMoney(r.totalFinal)}
                        </div>
                      </div>

                      {r.comment ? (
                        <div className="col-span-2">
                          <div className="text-[11px] font-bold text-gray-500">
                            Comentario
                          </div>
                          <div className="text-sm text-gray-800">
                            {r.comment}
                          </div>
                        </div>
                      ) : null}
                    </div>

                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => startEdit(r)}
                        className="flex-1 h-10 rounded-xl border border-gray-200 font-extrabold hover:bg-gray-50"
                      >
                        Editar
                      </button>
                      <button
                        onClick={() => removeRow(r.id)}
                        className="flex-1 h-10 rounded-xl border border-gray-200 font-extrabold text-red-700 hover:bg-red-50"
                      >
                        Eliminar
                      </button>
                    </div>
                  </div>
                ))}

                {/* Mobile edit panel */}
                {editingId ? (
                  <div className="rounded-2xl border border-yellow-200 bg-yellow-50 p-3">
                    <div className="font-black text-gray-900 mb-3">
                      Editando registro
                    </div>

                    <div className="grid grid-cols-1 gap-3">
                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Fecha
                        </span>
                        <input
                          type="date"
                          value={String(editDraft.dateInput ?? "")}
                          onChange={(e) =>
                            setEditDraft((p) => ({
                              ...p,
                              dateInput: e.target.value,
                            }))
                          }
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Vendedor
                        </span>
                        <select
                          value={String(editDraft.sellerId ?? "")}
                          onChange={(e) => {
                            const sellerId = e.target.value;
                            const s = sellersMap.get(sellerId);
                            setEditDraft((p) => ({
                              ...p,
                              sellerId,
                              sellerName: s?.name ?? "",
                              commissionPercent: safeNumber(
                                s?.commissionPercent ?? 0
                              ),
                            }));
                          }}
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        >
                          <option value="">Seleccionar...</option>
                          {sellers.map((s) => (
                            <option key={s.id} value={s.id}>
                              {s.name} {s.branch ? `(${s.branch})` : ""}
                            </option>
                          ))}
                        </select>
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Monto entregado
                        </span>
                        <input
                          type="number"
                          value={String(editDraft.amountDelivered ?? "")}
                          onChange={(e) =>
                            setEditDraft((p) => ({
                              ...p,
                              amountDelivered: safeNumber(e.target.value),
                            }))
                          }
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Gastos extras
                        </span>
                        <input
                          type="number"
                          value={String(editDraft.extraExpenses ?? "")}
                          onChange={(e) =>
                            setEditDraft((p) => ({
                              ...p,
                              extraExpenses: safeNumber(e.target.value),
                            }))
                          }
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Comisión %
                        </span>
                        <input
                          type="number"
                          value={String(editDraft.commissionPercent ?? "")}
                          onChange={(e) =>
                            setEditDraft((p) => ({
                              ...p,
                              commissionPercent: safeNumber(e.target.value),
                            }))
                          }
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        />
                      </label>

                      <label className="space-y-1">
                        <span className="text-xs font-bold text-gray-600">
                          Comentario
                        </span>
                        <input
                          type="text"
                          value={String(editDraft.comment ?? "")}
                          onChange={(e) =>
                            setEditDraft((p) => ({
                              ...p,
                              comment: e.target.value,
                            }))
                          }
                          className="w-full h-10 rounded-xl border border-gray-200 px-3 outline-none bg-white"
                        />
                      </label>

                      <div className="flex gap-2">
                        <button
                          onClick={() => saveEdit(editingId)}
                          className="flex-1 h-10 rounded-xl bg-gray-900 text-white font-extrabold hover:bg-gray-800"
                        >
                          Guardar
                        </button>
                        <button
                          onClick={cancelEdit}
                          className="flex-1 h-10 rounded-xl border border-gray-200 font-extrabold hover:bg-gray-50"
                        >
                          Cancelar
                        </button>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
