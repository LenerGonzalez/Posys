// src/components/Pollo/PolloCashAudits.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  Timestamp,
  collection,
  getDocs,
  query,
  where,
} from "firebase/firestore";
import { db, auth } from "../../firebase";
import * as XLSX from "xlsx";
import {
  createPolloCashAudit,
  deletePolloCashAudit,
  listPolloCashAudits,
  PolloCashAudit,
  updatePolloCashAudit,
} from "../../Services/pollo_cash_audits";

// Helpers
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const qty3 = (n: number) => Number(n || 0).toFixed(3);
const to2 = (v: any) => {
  const num = Number(String(v ?? "").replace(/,/g, "."));
  return isNaN(num) ? 0 : Math.round(num * 100) / 100;
};
const ymd = (d: Date) => {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
const todayYMD = () => {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
};
const monthStartYMD = () => {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth(), 1));
};
const monthEndYMD = () => {
  const d = new Date();
  return ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
};
const startOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0);
const endOfDay = (d: Date) =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate(), 23, 59, 59);

// Helpers para cantidades vendidas
const mStr = (v: unknown) =>
  String(v ?? "")
    .toLowerCase()
    .trim();
const getQty = (s: any) => Number(s.qty ?? s.quantity ?? 0);
const isLb = (m: unknown) => ["lb", "lbs", "libra", "libras"].includes(mStr(m));
const isUnit = (m: unknown) =>
  ["unidad", "unidades", "ud", "uds", "pieza", "piezas"].includes(mStr(m));

type UserRow = { uid: string; name: string; role?: string; roles?: string[] };

export default function PolloCashAudits() {
  // ===== Modal / form state =====
  const [openForm, setOpenForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [colabOpen, setColabOpen] = useState(false);
  const [inputsOpen, setInputsOpen] = useState(false);
  const [editId, setEditId] = useState<string | null>(null);
  const [kpiCardOpen, setKpiCardOpen] = useState(false);

  // Users (contadores)
  const [contadores, setContadores] = useState<UserRow[]>([]);
  const [contadorUid, setContadorUid] = useState("");
  const [contadorName, setContadorName] = useState("");

  // Form fields
  const [recibidoPor, setRecibidoPor] = useState(""); // quien recibe (obligatorio en tu spec original)
  const [entregadoPor, setEntregadoPor] = useState(""); // quien entrega
  const [rangeFrom, setRangeFrom] = useState(todayYMD());
  const [rangeTo, setRangeTo] = useState(todayYMD());

  const [ventasCash, setVentasCash] = useState<number>(0);
  const [abonos, setAbonos] = useState<number>(0);
  const [ingresosExtra, setIngresosExtra] = useState<number>(0);
  const [debitos, setDebitos] = useState<number>(0);
  const [comment, setComment] = useState("");

  // KPI modal (rango de cierre ventas seleccionado)
  const [modalSalesRows, setModalSalesRows] = useState<any[]>([]);
  const [modalAbonosRange, setModalAbonosRange] = useState<number>(0);
  const [modalKpiLoading, setModalKpiLoading] = useState(false);

  const subTotal = useMemo(
    () => to2(ventasCash + abonos + ingresosExtra),
    [ventasCash, abonos, ingresosExtra],
  );
  const totalEntregado = useMemo(
    () => to2(subTotal - debitos),
    [subTotal, debitos],
  );

  // ===== List / filters =====
  const [rows, setRows] = useState<PolloCashAudit[]>([]);
  const [loading, setLoading] = useState(false);

  const [filterFrom, setFilterFrom] = useState<string>(monthStartYMD()); // createdAt filter
  const [filterTo, setFilterTo] = useState<string>(monthEndYMD());

  // KPIs del periodo (ventas/abonos/libras/unidades)
  const [kpiSalesRows, setKpiSalesRows] = useState<any[]>([]);
  const [kpiAbonosRange, setKpiAbonosRange] = useState<number>(0);
  const [kpiLoading, setKpiLoading] = useState(false);

  async function loadContadores() {
    // Opción A: role == "contador"
    // Si vos usás roles[] entonces cambiamos el query o filtramos en memoria.
    const snap = await getDocs(query(collection(db, "users")));
    const list: UserRow[] = snap.docs.map((d) => {
      const data: any = d.data();
      return {
        uid: d.id,
        name: data.displayName || data.name || data.email || d.id,
        role: data.role,
        roles: data.roles,
      };
    });

    const conts = list.filter(
      (u) =>
        u.role === "contador" ||
        (Array.isArray(u.roles) && u.roles.includes("contador")),
    );
    setContadores(conts);

    // default: logueado si existe en contadores; si no, el primero
    const uid = auth.currentUser?.uid || "";
    const me = conts.find((c) => c.uid === uid);
    const pick = me || conts[0];

    if (pick) {
      setContadorUid(pick.uid);
      setContadorName(pick.name);
    }
  }

  async function loadRows() {
    setLoading(true);
    try {
      const params =
        filterFrom && filterTo
          ? {
              createdFrom: startOfDay(new Date(filterFrom)),
              createdTo: endOfDay(new Date(filterTo)),
            }
          : undefined;

      const data = await listPolloCashAudits(params);
      setRows(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadContadores();
    // carga inicial
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    loadRows();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filterFrom, filterTo]);

  useEffect(() => {
    const loadKpis = async () => {
      if (!filterFrom || !filterTo) return;
      setKpiLoading(true);
      try {
        // Ventas (salesV2) por rango
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", filterFrom),
          where("date", "<=", filterTo),
        );
        const sSnap = await getDocs(qs);
        const sRows: any[] = [];

        sSnap.forEach((d) => {
          const x = d.data() as any;
          const baseDate = x.date ?? "";

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
                measurement: it.measurement ?? x.measurement ?? "",
                type: x.type ?? "CONTADO",
              });
            });
            return;
          }

          sRows.push({
            id: d.id,
            date: baseDate,
            productName: x.productName ?? "(sin nombre)",
            quantity: Number(x.quantity ?? 0),
            amount: Number(x.amount ?? x.amountCharged ?? 0),
            measurement: x.measurement ?? "",
            type: x.type ?? "CONTADO",
          });
        });

        setKpiSalesRows(sRows);

        // Recaudado (abonos) por rango
        const movementsSnap = await getDocs(
          collection(db, "ar_movements_pollo"),
        );
        let abonosRangeSum = 0;

        const resolveMovementDate = (m: any) => {
          if (m?.date) return String(m.date);
          if (m?.createdAt?.toDate) return ymd(m.createdAt.toDate());
          return "";
        };

        movementsSnap.forEach((d) => {
          const m = d.data() as any;
          const type = String(m.type ?? "").toUpperCase();
          if (type !== "ABONO") return;
          const amount = Math.abs(Number(m.amount ?? 0));
          const moveDate = resolveMovementDate(m);
          if (moveDate && moveDate >= filterFrom && moveDate <= filterTo) {
            abonosRangeSum += amount;
          }
        });

        setKpiAbonosRange(abonosRangeSum);
      } catch (e) {
        console.error("Error cargando KPIs del periodo:", e);
        setKpiSalesRows([]);
        setKpiAbonosRange(0);
      } finally {
        setKpiLoading(false);
      }
    };

    loadKpis();
  }, [filterFrom, filterTo]);

  useEffect(() => {
    const loadModalKpi = async () => {
      if (!rangeFrom || !rangeTo) return;
      setModalKpiLoading(true);
      try {
        const qs = query(
          collection(db, "salesV2"),
          where("date", ">=", rangeFrom),
          where("date", "<=", rangeTo),
        );
        const sSnap = await getDocs(qs);
        const sRows: any[] = [];

        sSnap.forEach((d) => {
          const x = d.data() as any;
          const baseDate = x.date ?? "";

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
                measurement: it.measurement ?? x.measurement ?? "",
                type: x.type ?? "CONTADO",
              });
            });
            return;
          }

          sRows.push({
            id: d.id,
            date: baseDate,
            productName: x.productName ?? "(sin nombre)",
            quantity: Number(x.quantity ?? 0),
            amount: Number(x.amount ?? x.amountCharged ?? 0),
            measurement: x.measurement ?? "",
            type: x.type ?? "CONTADO",
          });
        });

        setModalSalesRows(sRows);

        const movementsSnap = await getDocs(
          collection(db, "ar_movements_pollo"),
        );
        let abonosRangeSum = 0;

        const resolveMovementDate = (m: any) => {
          if (m?.date) return String(m.date);
          if (m?.createdAt?.toDate) return ymd(m.createdAt.toDate());
          return "";
        };

        movementsSnap.forEach((d) => {
          const m = d.data() as any;
          const type = String(m.type ?? "").toUpperCase();
          if (type !== "ABONO") return;
          const amount = Math.abs(Number(m.amount ?? 0));
          const moveDate = resolveMovementDate(m);
          if (moveDate && moveDate >= rangeFrom && moveDate <= rangeTo) {
            abonosRangeSum += amount;
          }
        });

        setModalAbonosRange(abonosRangeSum);
      } catch (e) {
        console.error("Error cargando KPI de modal:", e);
        setModalSalesRows([]);
        setModalAbonosRange(0);
      } finally {
        setModalKpiLoading(false);
      }
    };

    loadModalKpi();
  }, [rangeFrom, rangeTo]);

  // KPIs
  const kpi = useMemo(() => {
    const sumTotal = rows.reduce(
      (a, r) => a + (Number(r.totalEntregado) || 0),
      0,
    );
    const sumDeb = rows.reduce((a, r) => a + (Number(r.debitos) || 0), 0);
    const sumSub = rows.reduce((a, r) => a + (Number(r.subTotal) || 0), 0);
    return {
      sumTotal: to2(sumTotal),
      sumDeb: to2(sumDeb),
      sumSub: to2(sumSub),
    };
  }, [rows]);

  const kpiPeriod = useMemo(() => {
    const cashSales = kpiSalesRows.filter((s) => s.type === "CONTADO");
    const creditSales = kpiSalesRows.filter((s) => s.type === "CREDITO");

    const ventasCash = cashSales.reduce((a, s) => a + (s.amount || 0), 0);
    const recaudado = ventasCash + kpiAbonosRange;

    const lbsCash = cashSales.reduce(
      (a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a),
      0,
    );
    const unitsCash = cashSales.reduce(
      (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
      0,
    );
    const lbsCredit = creditSales.reduce(
      (a, s: any) => (isLb(s.measurement) ? a + getQty(s) : a),
      0,
    );
    const unitsCredit = creditSales.reduce(
      (a, s: any) => (isUnit(s.measurement) ? a + getQty(s) : a),
      0,
    );

    return {
      ventasCash: to2(ventasCash),
      recaudado: to2(recaudado),
      lbsCash: qty3(lbsCash),
      unitsCash: qty3(unitsCash),
      lbsCredit: qty3(lbsCredit),
      unitsCredit: qty3(unitsCredit),
    };
  }, [kpiSalesRows, kpiAbonosRange]);

  const modalKpi = useMemo(() => {
    const cashSales = modalSalesRows.filter((s) => s.type === "CONTADO");
    const ventasCashRange = cashSales.reduce((a, s) => a + (s.amount || 0), 0);
    const recaudadoRange = ventasCashRange + modalAbonosRange;
    return {
      recaudado: to2(recaudadoRange),
    };
  }, [modalSalesRows, modalAbonosRange]);

  function resetForm() {
    setRecibidoPor("");
    setEntregadoPor("");
    setRangeFrom(todayYMD());
    setRangeTo(todayYMD());
    setVentasCash(0);
    setAbonos(0);
    setIngresosExtra(0);
    setDebitos(0);
    setComment("");
    setColabOpen(false);
    setInputsOpen(false);
    setEditId(null);
  }

  function startEdit(row: PolloCashAudit) {
    setEditId(row.id);
    setOpenForm(true);
    setColabOpen(true);
    setInputsOpen(true);

    setContadorUid(row.contadorUid || "");
    setContadorName(row.contadorName || "");
    setRecibidoPor(row.recibidoPor || "");
    setEntregadoPor(row.entregadoPor || "");
    setRangeFrom(row.rangeFrom || todayYMD());
    setRangeTo(row.rangeTo || todayYMD());
    setVentasCash(Number(row.ventasCash || 0));
    setAbonos(Number(row.abonos || 0));
    setIngresosExtra(Number(row.ingresosExtra || 0));
    setDebitos(Number(row.debitos || 0));
    setComment(row.comment || "");
  }

  async function onSave() {
    // validaciones mínimas
    if (!contadorUid) return alert("Seleccione Contador.");
    if (!recibidoPor.trim()) return alert("Recibido por es obligatorio.");
    if (!rangeFrom || !rangeTo) return alert("Seleccione el rango arqueado.");
    if (new Date(rangeFrom) > new Date(rangeTo))
      return alert("Rango inválido: Desde no puede ser mayor que Hasta.");

    setSaving(true);
    try {
      if (editId) {
        await updatePolloCashAudit(editId, {
          contadorUid,
          contadorName,

          recibidoPor: recibidoPor.trim(),
          entregadoPor: entregadoPor.trim(),

          rangeFrom,
          rangeTo,

          ventasCash: to2(ventasCash),
          abonos: to2(abonos),
          ingresosExtra: to2(ingresosExtra),
          debitos: to2(debitos),

          subTotal: to2(subTotal),
          totalEntregado: to2(totalEntregado),

          comment: comment.trim(),
        });
      } else {
        const createdByUid = auth.currentUser?.uid || "";
        const createdByName =
          auth.currentUser?.displayName ||
          auth.currentUser?.email ||
          createdByUid;

        await createPolloCashAudit({
          createdAt: Timestamp.now(),
          createdByUid,
          createdByName,

          contadorUid,
          contadorName,

          recibidoPor: recibidoPor.trim(),
          entregadoPor: entregadoPor.trim(),

          rangeFrom,
          rangeTo,

          ventasCash: to2(ventasCash),
          abonos: to2(abonos),
          ingresosExtra: to2(ingresosExtra),
          debitos: to2(debitos),

          subTotal: to2(subTotal),
          totalEntregado: to2(totalEntregado),

          comment: comment.trim(),
        });
      }

      setOpenForm(false);
      resetForm();
      await loadRows();
    } finally {
      setSaving(false);
    }
  }

  async function onDelete(row: PolloCashAudit) {
    const ok = window.confirm(
      `¿Eliminar el arqueo creado el ${row.createdAt?.toDate ? row.createdAt.toDate().toLocaleString() : ""}?`,
    );
    if (!ok) return;
    setSaving(true);
    try {
      await deletePolloCashAudit(row.id);
      await loadRows();
    } finally {
      setSaving(false);
    }
  }

  function exportExcel() {
    const data = rows.map((r) => ({
      "Fecha de creación": r.createdAt?.toDate
        ? r.createdAt.toDate().toLocaleString()
        : "",
      "Rango arqueado": `${r.rangeFrom} a ${r.rangeTo}`,
      "Arqueado por (Contador)": r.contadorName,
      "Recibido por": r.recibidoPor,
      "Entregado por": r.entregadoPor,
      "Ventas cash": r.ventasCash,
      Abonos: r.abonos,
      "Ingresos extra": r.ingresosExtra,
      "Sub total": r.subTotal,
      Débitos: r.debitos,
      "Monto entregado": r.totalEntregado,
      Comentario: r.comment || "",
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Arqueos");
    XLSX.writeFile(wb, `arqueos_pollo_${todayYMD()}.xlsx`);
  }

  return (
    <div className="p-3 md:p-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h1 className="text-lg md:text-xl font-semibold">
            Arqueo físico y entregas (Pollo)
          </h1>
          <p className="text-xs text-gray-500">
            Registro de arqueos, débitos por gasto/reabastecimiento y monto
            entregado.
          </p>
        </div>

        <div className="flex gap-2">
          <button
            onClick={() => {
              resetForm();
              setOpenForm(true);
            }}
            className="px-3 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
          >
            + Nuevo arqueo
          </button>
          <button
            onClick={exportExcel}
            className="px-3 py-2 rounded bg-emerald-600 text-white text-sm hover:bg-emerald-700"
          >
            Exportar Excel
          </button>
        </div>
      </div>

      {/* Filtros + KPIs */}
      <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500 mb-2">
            Filtro por fecha (creación)
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-gray-600">Desde</label>
              <input
                type="date"
                value={filterFrom}
                onChange={(e) => setFilterFrom(e.target.value)}
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>
            <div>
              <label className="text-xs text-gray-600">Hasta</label>
              <input
                type="date"
                value={filterTo}
                onChange={(e) => setFilterTo(e.target.value)}
                className="w-full border rounded px-2 py-2 text-sm"
              />
            </div>
          </div>
          <button
            onClick={() => {
              setFilterFrom("");
              setFilterTo("");
            }}
            className="mt-2 text-xs text-blue-600 hover:underline"
          >
            Limpiar filtro
          </button>
        </div>

        <div className="bg-white rounded shadow p-3 hidden md:block">
          <div className="text-xs text-gray-500">KPI: Monto entregado</div>
          <div className="text-xl font-semibold">{money(kpi.sumTotal)}</div>
          <div className="text-xs text-gray-400">
            Suma de Total (Sub total - Débitos)
          </div>
        </div>

        <div className="bg-white rounded shadow p-3 hidden md:block">
          <div className="flex justify-between gap-3">
            <div>
              <div className="text-xs text-gray-500">KPI: Débitos</div>
              <div className="text-lg font-semibold">{money(kpi.sumDeb)}</div>
            </div>
            <div>
              <div className="text-xs text-gray-500">KPI: Sub totales</div>
              <div className="text-lg font-semibold">{money(kpi.sumSub)}</div>
            </div>
          </div>
          <div className="text-xs text-gray-400 mt-1">
            Sumas del listado filtrado
          </div>
        </div>
      </div>

      {/* KPIs del periodo (ventas/abonos/libras/unidades) */}
      <div className="mt-3 hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-3">
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Ventas cash (período)</div>
          <div className="text-lg font-semibold">
            {money(kpiPeriod.ventasCash)}
          </div>
          {kpiLoading && (
            <div className="text-[11px] text-gray-400">Actualizando…</div>
          )}
        </div>
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Recaudado (período)</div>
          <div className="text-lg font-semibold">
            {money(kpiPeriod.recaudado)}
          </div>
          <div className="text-[11px] text-gray-400">Cash + abonos</div>
        </div>
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Libras cash</div>
          <div className="text-lg font-semibold">{kpiPeriod.lbsCash}</div>
        </div>
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Unidades cash</div>
          <div className="text-lg font-semibold">{kpiPeriod.unitsCash}</div>
        </div>
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Libras crédito</div>
          <div className="text-lg font-semibold">{kpiPeriod.lbsCredit}</div>
        </div>
        <div className="bg-white rounded shadow p-3">
          <div className="text-xs text-gray-500">Unidades crédito</div>
          <div className="text-lg font-semibold">{kpiPeriod.unitsCredit}</div>
        </div>
      </div>

      {/* KPIs colapsables (mobile) */}
      <div className="mt-3 md:hidden">
        <CollapsibleCard
          title="KPIs"
          open={kpiCardOpen}
          onToggle={() => setKpiCardOpen((v) => !v)}
        >
          <div className="grid grid-cols-1 gap-3">
            <div className="bg-white rounded border p-3">
              <div className="text-xs text-gray-500">KPI: Monto entregado</div>
              <div className="text-lg font-semibold">{money(kpi.sumTotal)}</div>
              <div className="text-xs text-gray-400">
                Suma de Total (Sub total - Débitos)
              </div>
            </div>

            <div className="bg-white rounded border p-3">
              <div className="flex justify-between gap-3">
                <div>
                  <div className="text-xs text-gray-500">KPI: Débitos</div>
                  <div className="text-lg font-semibold">
                    {money(kpi.sumDeb)}
                  </div>
                </div>
                <div>
                  <div className="text-xs text-gray-500">KPI: Sub totales</div>
                  <div className="text-lg font-semibold">
                    {money(kpi.sumSub)}
                  </div>
                </div>
              </div>
              <div className="text-xs text-gray-400 mt-1">
                Sumas del listado filtrado
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">
                  Ventas cash (período)
                </div>
                <div className="text-lg font-semibold">
                  {money(kpiPeriod.ventasCash)}
                </div>
                {kpiLoading && (
                  <div className="text-[11px] text-gray-400">Actualizando…</div>
                )}
              </div>
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">Recaudado (período)</div>
                <div className="text-lg font-semibold">
                  {money(kpiPeriod.recaudado)}
                </div>
                <div className="text-[11px] text-gray-400">Cash + abonos</div>
              </div>
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">Libras cash</div>
                <div className="text-lg font-semibold">{kpiPeriod.lbsCash}</div>
              </div>
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">Unidades cash</div>
                <div className="text-lg font-semibold">
                  {kpiPeriod.unitsCash}
                </div>
              </div>
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">Libras crédito</div>
                <div className="text-lg font-semibold">
                  {kpiPeriod.lbsCredit}
                </div>
              </div>
              <div className="bg-white rounded border p-3">
                <div className="text-xs text-gray-500">Unidades crédito</div>
                <div className="text-lg font-semibold">
                  {kpiPeriod.unitsCredit}
                </div>
              </div>
            </div>
          </div>
        </CollapsibleCard>
      </div>

      {/* Lista mobile: tarjetas */}
      <div className="mt-4 block md:hidden space-y-3">
        {loading ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            Cargando…
          </div>
        ) : rows.length === 0 ? (
          <div className="p-4 text-center bg-white rounded-xl border shadow">
            No hay arqueos en este rango.
          </div>
        ) : (
          rows.map((r) => (
            <div
              key={r.id}
              className="bg-white border rounded-2xl p-3 shadow-sm"
            >
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="text-[11px] text-gray-500">
                    Fecha de creación
                  </div>
                  <div className="font-semibold text-sm">
                    {r.createdAt?.toDate
                      ? r.createdAt.toDate().toLocaleString()
                      : ""}
                  </div>
                  <div className="text-[11px] text-gray-500 mt-1">
                    Rango arqueado
                  </div>
                  <div className="text-sm">
                    {r.rangeFrom} a {r.rangeTo}
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-[11px] text-gray-500">
                    Monto entregado
                  </div>
                  <div className="font-semibold">{money(r.totalEntregado)}</div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                <div>
                  <span className="text-gray-500">Contador:</span>{" "}
                  {r.contadorName}
                </div>
                <div>
                  <span className="text-gray-500">Recibido:</span>{" "}
                  {r.recibidoPor}
                </div>
                <div>
                  <span className="text-gray-500">Sub total:</span>{" "}
                  {money(r.subTotal)}
                </div>
                <div>
                  <span className="text-gray-500">Débitos:</span>{" "}
                  {money(r.debitos)}
                </div>
              </div>

              <div className="mt-3 flex justify-end">
                <button
                  type="button"
                  onClick={() => startEdit(r)}
                  className="text-xs px-3 py-1.5 rounded border text-gray-700 hover:bg-gray-50"
                  disabled={saving}
                >
                  Editar
                </button>
                <button
                  type="button"
                  onClick={() => onDelete(r)}
                  className="ml-2 text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                  disabled={saving}
                >
                  Eliminar
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* Tabla */}
      <div className="mt-4 bg-white rounded shadow overflow-hidden hidden md:block">
        <div className="p-3 border-b flex items-center justify-between">
          <div className="text-sm font-semibold">Arqueos guardados</div>
          <div className="text-xs text-gray-500">
            {loading ? "Cargando..." : `${rows.length} registro(s)`}
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-[900px] w-full text-sm">
            <thead className="bg-gray-50 text-gray-600">
              <tr>
                <th className="text-left px-3 py-2">Fecha de creación</th>
                <th className="text-left px-3 py-2">Rango arqueado</th>
                <th className="text-left px-3 py-2">Arqueado por</th>
                <th className="text-left px-3 py-2">Recibido por</th>
                <th className="text-right px-3 py-2">Sub total</th>
                <th className="text-right px-3 py-2">Débitos</th>
                <th className="text-right px-3 py-2">Monto entregado</th>
                <th className="text-right px-3 py-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {!loading && rows.length === 0 && (
                <tr>
                  <td
                    colSpan={8}
                    className="px-3 py-6 text-center text-gray-500"
                  >
                    No hay arqueos en este rango.
                  </td>
                </tr>
              )}

              {rows.map((r) => (
                <tr key={r.id} className="border-t">
                  <td className="px-3 py-2">
                    {r.createdAt?.toDate
                      ? r.createdAt.toDate().toLocaleString()
                      : ""}
                  </td>
                  <td className="px-3 py-2">
                    {r.rangeFrom} a {r.rangeTo}
                  </td>
                  <td className="px-3 py-2">{r.contadorName}</td>
                  <td className="px-3 py-2">{r.recibidoPor}</td>
                  <td className="px-3 py-2 text-right font-medium">
                    {money(r.subTotal)}
                  </td>
                  <td className="px-3 py-2 text-right">{money(r.debitos)}</td>
                  <td className="px-3 py-2 text-right font-semibold">
                    {money(r.totalEntregado)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      onClick={() => startEdit(r)}
                      className="text-xs px-3 py-1.5 rounded border text-gray-700 hover:bg-gray-50"
                      disabled={saving}
                    >
                      Editar
                    </button>
                    <button
                      type="button"
                      onClick={() => onDelete(r)}
                      className="ml-2 text-xs px-3 py-1.5 rounded bg-red-600 text-white hover:bg-red-700 disabled:opacity-60"
                      disabled={saving}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* MODAL FORM */}
      {openForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3">
          <div className="bg-white w-full max-w-3xl rounded shadow-lg overflow-hidden">
            <div className="p-3 border-b flex items-center justify-between">
              <div className="font-semibold">
                {editId ? "Editar arqueo" : "Nuevo arqueo"}
              </div>
              <button
                onClick={() => {
                  setOpenForm(false);
                  resetForm();
                }}
                className="text-sm px-2 py-1 rounded hover:bg-gray-100"
              >
                ✕
              </button>
            </div>

            <div className="p-3 md:p-4 space-y-3 text-sm">
              {/* Mobile: cards colapsables */}
              <div className="md:hidden space-y-3">
                <CollapsibleCard
                  title="Datos colaboradores"
                  open={colabOpen}
                  onToggle={() => setColabOpen((v) => !v)}
                >
                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <label className="text-xs text-gray-600">Contador</label>
                      <select
                        value={contadorUid}
                        onChange={(e) => {
                          const uid = e.target.value;
                          const u = contadores.find((x) => x.uid === uid);
                          setContadorUid(uid);
                          setContadorName(u?.name || "");
                        }}
                        className="w-full border rounded px-2 py-2"
                      >
                        {contadores.length === 0 && (
                          <option value="">(No hay contadores)</option>
                        )}
                        {contadores.map((u) => (
                          <option key={u.uid} value={u.uid}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                      <div className="text-[11px] text-gray-400 mt-1">
                        Por default se selecciona el contador logueado si
                        aplica.
                      </div>
                    </div>

                    <div>
                      <label className="text-xs text-gray-600">
                        Recibido por (obligatorio)
                      </label>
                      <input
                        value={recibidoPor}
                        onChange={(e) => setRecibidoPor(e.target.value)}
                        className="w-full border rounded px-2 py-2"
                        placeholder="Nombre de quien recibe el dinero"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-gray-600">
                        Entregado por
                      </label>
                      <input
                        value={entregadoPor}
                        onChange={(e) => setEntregadoPor(e.target.value)}
                        className="w-full border rounded px-2 py-2"
                        placeholder="Nombre de quien entrega el dinero"
                      />
                    </div>

                    <div>
                      <label className="text-xs text-gray-600">
                        Rango cierre ventas
                      </label>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="date"
                          value={rangeFrom}
                          onChange={(e) => setRangeFrom(e.target.value)}
                          className="w-full border rounded px-2 py-2"
                        />
                        <input
                          type="date"
                          value={rangeTo}
                          onChange={(e) => setRangeTo(e.target.value)}
                          className="w-full border rounded px-2 py-2"
                        />
                      </div>
                    </div>
                  </div>
                </CollapsibleCard>

                <CollapsibleCard
                  title="Inputs y KPIs"
                  open={inputsOpen}
                  onToggle={() => setInputsOpen((v) => !v)}
                >
                  <div className="bg-blue-50 border border-blue-200 rounded p-3 mb-3">
                    <div className="text-xs text-blue-700">
                      Recaudado en el rango (Ventas cash + abonos)
                    </div>
                    <div className="text-lg font-semibold text-blue-900">
                      {money(modalKpi.recaudado)}
                    </div>
                    {modalKpiLoading && (
                      <div className="text-[11px] text-blue-600">
                        Actualizando…
                      </div>
                    )}
                  </div>
                  <div className="grid grid-cols-1 gap-3">
                    <MoneyInput
                      label="Ventas cash"
                      value={ventasCash}
                      onChange={setVentasCash}
                    />
                    <MoneyInput
                      label="Abonos"
                      value={abonos}
                      onChange={setAbonos}
                    />
                    <MoneyInput
                      label="Ingresos extra oficiales"
                      value={ingresosExtra}
                      onChange={setIngresosExtra}
                    />
                    <MoneyInput
                      label="Débitos (gasto o reabastecimiento)"
                      value={debitos}
                      onChange={setDebitos}
                    />
                  </div>

                  <div className="mt-3 grid grid-cols-1 gap-3">
                    <KpiBox
                      title="Sub total (ventas + abonos + ingresos)"
                      value={money(subTotal)}
                    />
                    <KpiBox
                      title="Total (sub total - débitos)"
                      value={money(totalEntregado)}
                    />
                  </div>
                </CollapsibleCard>
              </div>

              {/* Desktop: layout original */}
              <div className="hidden md:block space-y-3">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <div>
                    <label className="text-xs text-gray-600">Contador</label>
                    <select
                      value={contadorUid}
                      onChange={(e) => {
                        const uid = e.target.value;
                        const u = contadores.find((x) => x.uid === uid);
                        setContadorUid(uid);
                        setContadorName(u?.name || "");
                      }}
                      className="w-full border rounded px-2 py-2"
                    >
                      {contadores.length === 0 && (
                        <option value="">(No hay contadores)</option>
                      )}
                      {contadores.map((u) => (
                        <option key={u.uid} value={u.uid}>
                          {u.name}
                        </option>
                      ))}
                    </select>
                    <div className="text-[11px] text-gray-400 mt-1">
                      Por default se selecciona el contador logueado si aplica.
                    </div>
                  </div>

                  <div>
                    <label className="text-xs text-gray-600">
                      Recibido por (obligatorio)
                    </label>
                    <input
                      value={recibidoPor}
                      onChange={(e) => setRecibidoPor(e.target.value)}
                      className="w-full border rounded px-2 py-2"
                      placeholder="Nombre de quien recibe el dinero"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-600">
                      Entregado por
                    </label>
                    <input
                      value={entregadoPor}
                      onChange={(e) => setEntregadoPor(e.target.value)}
                      className="w-full border rounded px-2 py-2"
                      placeholder="Nombre de quien entrega el dinero"
                    />
                  </div>

                  <div>
                    <label className="text-xs text-gray-600">
                      Rango cierre ventas
                    </label>
                    <div className="grid grid-cols-2 gap-2">
                      <input
                        type="date"
                        value={rangeFrom}
                        onChange={(e) => setRangeFrom(e.target.value)}
                        className="w-full border rounded px-2 py-2"
                      />
                      <input
                        type="date"
                        value={rangeTo}
                        onChange={(e) => setRangeTo(e.target.value)}
                        className="w-full border rounded px-2 py-2"
                      />
                    </div>
                  </div>
                </div>

                <div className="bg-blue-50 border border-blue-200 rounded p-3">
                  <div className="text-xs text-blue-700">
                    Recaudado en el rango (Ventas cash + abonos)
                  </div>
                  <div className="text-lg font-semibold text-blue-900">
                    {money(modalKpi.recaudado)}
                  </div>
                  {modalKpiLoading && (
                    <div className="text-[11px] text-blue-600">
                      Actualizando…
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <MoneyInput
                    label="Ventas cash"
                    value={ventasCash}
                    onChange={setVentasCash}
                  />
                  <MoneyInput
                    label="Abonos"
                    value={abonos}
                    onChange={setAbonos}
                  />
                  <MoneyInput
                    label="Ingresos extra oficiales"
                    value={ingresosExtra}
                    onChange={setIngresosExtra}
                  />
                  <MoneyInput
                    label="Débitos (gasto o reabastecimiento)"
                    value={debitos}
                    onChange={setDebitos}
                  />
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                  <KpiBox
                    title="Sub total (ventas + abonos + ingresos)"
                    value={money(subTotal)}
                  />
                  <KpiBox
                    title="Total (sub total - débitos)"
                    value={money(totalEntregado)}
                  />
                </div>
              </div>

              <div>
                <label className="text-xs text-gray-600">
                  Comentario / Nota
                </label>
                <textarea
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  className="w-full border rounded px-2 py-2 min-h-[90px]"
                  placeholder="Opcional..."
                />
              </div>
            </div>

            <div className="p-3 border-t flex items-center justify-end gap-2">
              <button
                onClick={() => {
                  setOpenForm(false);
                  resetForm();
                }}
                className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                disabled={saving}
              >
                Cancelar
              </button>
              <button
                onClick={onSave}
                className="px-3 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700 disabled:opacity-60"
                disabled={saving}
              >
                {saving
                  ? "Guardando..."
                  : editId
                    ? "Guardar cambios"
                    : "Guardar arqueo"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function KpiBox({ title, value }: { title: string; value: string }) {
  return (
    <div className="bg-gray-50 border rounded p-3">
      <div className="text-xs text-gray-500">{title}</div>
      <div className="text-lg font-semibold">{value}</div>
    </div>
  );
}

function MoneyInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div>
      <label className="text-xs text-gray-600">{label}</label>
      <input
        inputMode="decimal"
        value={String(value)}
        onChange={(e) => onChange(to2(e.target.value))}
        className="w-full border rounded px-2 py-2"
        placeholder="0.00"
      />
    </div>
  );
}

function CollapsibleCard({
  title,
  open,
  onToggle,
  children,
}: {
  title: string;
  open: boolean;
  onToggle: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border rounded-2xl shadow-sm overflow-hidden">
      <div className="px-3 py-2 flex items-center justify-between">
        <div className="font-semibold text-sm">{title}</div>
        <button
          type="button"
          onClick={onToggle}
          className="text-xs px-3 py-1.5 rounded border hover:bg-gray-50"
        >
          {open ? "Cerrar" : "Ver"}
        </button>
      </div>
      {open && <div className="px-3 pb-3 pt-1">{children}</div>}
    </div>
  );
}
