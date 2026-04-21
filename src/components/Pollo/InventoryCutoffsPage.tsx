import React, { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { format } from "date-fns";
import { getAuth } from "firebase/auth";
import {
  computeInventoryCutoffReportPollo,
  createInventoryCutoffPollo,
  deleteInventoryCutoffPollo,
  fetchInventoryCutoffsPollo,
  updateInventoryCutoffPollo,
  type InventoryCutoffRecord,
  type InventoryCutoffReportNumbers,
} from "../../Services/inventoryCutoffPollo";
import Button from "../common/Button";
import Toast from "../common/Toast";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const qty3 = (n: number) => (Number(n) || 0).toFixed(3);

const emptyReport = (): InventoryCutoffReportNumbers => ({
  invoicedAtCost: 0,
  soldAmount: 0,
  lbsIn: 0,
  lbsSold: 0,
  lbsLost: 0,
  unitsIn: 0,
  unitsSold: 0,
  unitsLost: 0,
  grossProfit: 0,
  netProfit: 0,
});

function CutoffReportPrint({
  record,
}: {
  record: InventoryCutoffRecord;
}) {
  const { report: r, financial: f } = record;
  return (
    <div className="rounded-xl border-2 border-slate-200 bg-white p-5 text-slate-900 print:border-black print:shadow-none">
      <h2 className="text-lg font-bold border-b border-slate-200 pb-2 mb-4 print:text-black">
        Datos al corte — {record.displayLabel}
      </h2>
      <p className="text-sm text-slate-600 mb-4 print:text-black">
        Fecha de corte: {record.cutoffDate}
        {record.periodFrom && record.periodTo
          ? ` · Periodo reportado: ${record.periodFrom} → ${record.periodTo}`
          : null}
      </p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-x-8 gap-y-2 text-sm">
        <dt className="text-slate-500 font-medium">Facturado a costo</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {money(r.invoicedAtCost)}
        </dd>
        <dt className="text-slate-500 font-medium">Vendido</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {money(r.soldAmount)}
        </dd>
        <dt className="text-slate-500 font-medium">Libras ingresadas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.lbsIn)} lb
        </dd>
        <dt className="text-slate-500 font-medium">Libras vendidas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.lbsSold)} lb
        </dd>
        <dt className="text-slate-500 font-medium">Libras perdidas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.lbsLost)} lb
        </dd>
        <dt className="text-slate-500 font-medium">Unidades ingresadas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.unitsIn)}
        </dd>
        <dt className="text-slate-500 font-medium">Unidades vendidas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.unitsSold)}
        </dd>
        <dt className="text-slate-500 font-medium">Unidades perdidas</dt>
        <dd className="tabular-nums font-semibold text-right sm:text-left">
          {qty3(r.unitsLost)}
        </dd>
        <dt className="text-slate-500 font-medium">Ganancia bruta</dt>
        <dd className="tabular-nums font-semibold text-emerald-800 text-right sm:text-left">
          {money(r.grossProfit)}
        </dd>
        <dt className="text-slate-500 font-medium">Ganancia neta</dt>
        <dd className="tabular-nums font-semibold text-emerald-900 text-right sm:text-left">
          {money(r.netProfit)}
        </dd>
      </dl>
      <p className="text-[11px] text-slate-500 mt-3 print:text-gray-600">
        Si el reporte se calculó con el botón del sistema: la ganancia neta es
        bruta de ventas menos gastos en <strong>Gastos</strong> con estado{" "}
        <strong>PAGADO</strong> en el mismo periodo (desde/hasta).
      </p>
      {(f?.notes ||
        f?.expenseDocumentId ||
        (f?.moneyImpactRegistered != null &&
          Number(f.moneyImpactRegistered) !== 0)) && (
        <div className="mt-5 pt-4 border-t border-slate-200 text-sm">
          <h3 className="font-bold text-slate-800 mb-2">
            Notas / referencias
          </h3>
          {f?.expenseDocumentId ? (
            <p className="text-slate-600">
              Ref. gasto u otro doc.: {f.expenseDocumentId}
            </p>
          ) : null}
          {f?.notes ? (
            <p className="text-slate-600 mt-2 whitespace-pre-wrap">{f.notes}</p>
          ) : null}
          {f?.moneyImpactRegistered != null &&
          Number(f.moneyImpactRegistered) !== 0 ? (
            <p className="text-slate-500 mt-2 text-xs">
              (Registro numérico anterior: {money(Number(f.moneyImpactRegistered))})
            </p>
          ) : null}
        </div>
      )}
    </div>
  );
}

export default function InventoryCutoffsPage() {
  const [rows, setRows] = useState<InventoryCutoffRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [showForm, setShowForm] = useState(false);

  const [cutoffDate, setCutoffDate] = useState(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [displayLabel, setDisplayLabel] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [report, setReport] = useState<InventoryCutoffReportNumbers>(
    emptyReport,
  );
  const [financialNotes, setFinancialNotes] = useState("");
  const [expenseRef, setExpenseRef] = useState("");
  const [saving, setSaving] = useState(false);
  const [computing, setComputing] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const list = await fetchInventoryCutoffsPollo();
      setRows(list);
    } catch (e) {
      console.error(e);
      setMsg("No se pudieron cargar los cortes. Revisa permisos en Firestore.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const updateReport = (key: keyof InventoryCutoffReportNumbers, raw: string) => {
    const n = raw === "" ? 0 : Number(raw);
    setReport((prev) => ({ ...prev, [key]: Number.isFinite(n) ? n : 0 }));
  };

  const resetForm = () => {
    setEditingId(null);
    setCutoffDate(format(new Date(), "yyyy-MM-dd"));
    setDisplayLabel("");
    setPeriodFrom("");
    setPeriodTo("");
    setReport(emptyReport());
    setFinancialNotes("");
    setExpenseRef("");
  };

  const startEdit = (r: InventoryCutoffRecord) => {
    setEditingId(r.id);
    setCutoffDate(r.cutoffDate);
    setDisplayLabel(r.displayLabel);
    setPeriodFrom(r.periodFrom ?? "");
    setPeriodTo(r.periodTo ?? "");
    setReport({ ...r.report });
    setFinancialNotes(r.financial?.notes ?? "");
    setExpenseRef(r.financial?.expenseDocumentId ?? "");
    setShowForm(true);
    setMsg("");
  };

  const handleSave = async () => {
    if (!cutoffDate.trim()) {
      setMsg("Indicá la fecha del corte.");
      return;
    }
    const label =
      displayLabel.trim() ||
      `Ciclo ${format(new Date(cutoffDate + "T12:00:00"), "dd/MM/yyyy")}`;
    const financial =
      financialNotes.trim() || expenseRef.trim()
        ? {
            notes: financialNotes.trim() || undefined,
            expenseDocumentId: expenseRef.trim() || undefined,
          }
        : undefined;

    setSaving(true);
    try {
      if (editingId) {
        await updateInventoryCutoffPollo(editingId, {
          cutoffDate: cutoffDate.trim(),
          displayLabel: label,
          periodFrom: periodFrom.trim() || null,
          periodTo: periodTo.trim() || null,
          report: { ...report },
          financial,
        });
        setMsg("Corte actualizado.");
      } else {
        const email = getAuth().currentUser?.email ?? undefined;
        await createInventoryCutoffPollo({
          cutoffDate: cutoffDate.trim(),
          displayLabel: label,
          periodFrom: periodFrom.trim() || undefined,
          periodTo: periodTo.trim() || undefined,
          report: { ...report },
          financial,
          createdByEmail: email,
        });
        setMsg("Corte guardado.");
      }
      setShowForm(false);
      resetForm();
      await load();
    } catch (e) {
      console.error(e);
      setMsg(
        e instanceof Error ? e.message : "Error al guardar el corte.",
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (r: InventoryCutoffRecord) => {
    if (
      !window.confirm(
        "¿Eliminar este corte? Se quitará la marca de ciclo en los lotes que tenían esta fecha de corte.",
      )
    )
      return;
    setSaving(true);
    try {
      await deleteInventoryCutoffPollo(r.id);
      if (editingId === r.id) {
        setShowForm(false);
        resetForm();
      }
      if (expandedId === r.id) setExpandedId(null);
      setMsg("Corte eliminado.");
      await load();
    } catch (e) {
      console.error(e);
      setMsg("No se pudo eliminar el corte.");
    } finally {
      setSaving(false);
    }
  };

  const printRecord = (id: string) => {
    setExpandedId(id);
    requestAnimationFrame(() => window.print());
  };

  const handleComputeFromSystem = async () => {
    if (!periodFrom.trim() || !periodTo.trim()) {
      setMsg("Completá periodo desde y hasta para calcular.");
      return;
    }
    if (periodFrom > periodTo) {
      setMsg("La fecha desde no puede ser mayor que hasta.");
      return;
    }
    setComputing(true);
    try {
      const computed = await computeInventoryCutoffReportPollo(
        periodFrom.trim(),
        periodTo.trim(),
      );
      setReport(computed);
      setMsg(
        "Reporte calculado desde lotes, ventas, mermas y gastos pagados del periodo.",
      );
    } catch (e) {
      console.error(e);
      setMsg(
        e instanceof Error
          ? e.message
          : "No se pudo calcular. Revisa conexión e índices de Firestore.",
      );
    } finally {
      setComputing(false);
    }
  };

  return (
    <div className="max-w-3xl mx-auto px-3 py-4 print:max-w-none print:px-4">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4 print:hidden">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            Cortes de inventario
          </h1>
          <p className="text-sm text-slate-600 mt-1">
            Cerrá el ciclo con un reporte imprimible. Los números se pueden{" "}
            <strong>calcular solos</strong> desde el periodo elegido.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link
            to="../batches"
            className="text-sm font-medium text-blue-700 hover:underline"
          >
            ← Inventario lotes
          </Link>
          <Link
            to="../statusInventory"
            className="text-sm font-medium text-blue-700 hover:underline"
          >
            Evolutivo / mermas
          </Link>
          <Link
            to="../expenses"
            className="text-sm font-medium text-blue-700 hover:underline"
          >
            Gastos
          </Link>
        </div>
      </div>

      <div className="print:hidden mb-4 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 space-y-2">
        <p>
          <strong>Caja vs pérdida de inventario:</strong> un{" "}
          <strong>gasto</strong> en el módulo Gastos suele implicar dinero que
          sale de caja. Si la pérdida fue solo de mercadería (sin efectivo que
          hubiera entrado), conviene registrar la salida de stock en{" "}
          <Link to="../statusInventory" className="underline font-medium">
            Evolutivo de libras
          </Link>{" "}
          como <strong>merma/robo</strong>: además del registro, el sistema{" "}
          <strong>descuenta los lotes por FIFO</strong> (igual que una venta) y
          guarda <code className="text-[11px]">cogsAmount</code> = valor a costo
          retirado. Eso alimenta las <strong>perdidas</strong> del reporte de
          cortes. La venta ficticia para cuadrar caja ya no hace falta para el
          stock.
        </p>
        <p>
          <strong>Ajuste incremental</strong> de stock: entra con nuevos lotes en
          Inventario; el <strong>decremento</strong> operativo está en Evolutivo
          (merma/robo), no en esta pantalla.
        </p>
      </div>

      <div className="print:hidden mb-4">
        <Button
          type="button"
          variant="primary"
          size="sm"
          onClick={() => {
            if (showForm) {
              setShowForm(false);
              resetForm();
            } else {
              resetForm();
              setShowForm(true);
            }
          }}
        >
          {showForm ? "Cerrar formulario" : "Registrar nuevo corte"}
        </Button>
      </div>

      {showForm && (
        <div className="print:hidden mb-6 rounded-xl border-2 border-slate-200 bg-white p-4 shadow-sm space-y-4">
          <h2 className="font-bold text-slate-800">
            {editingId ? "Editar corte" : "Nuevo corte"}
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Fecha del corte
              </label>
              <input
                type="date"
                className="w-full border rounded-lg px-2 py-2"
                value={cutoffDate}
                onChange={(e) => setCutoffDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Etiqueta (ej. Ciclo 26/04/2026)
              </label>
              <input
                className="w-full border rounded-lg px-2 py-2"
                value={displayLabel}
                onChange={(e) => setDisplayLabel(e.target.value)}
                placeholder="Opcional — si vacío, se arma con la fecha"
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Periodo del reporte — desde
              </label>
              <input
                type="date"
                className="w-full border rounded-lg px-2 py-2"
                value={periodFrom}
                onChange={(e) => setPeriodFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block font-medium text-slate-700 mb-1">
                Periodo del reporte — hasta
              </label>
              <input
                type="date"
                className="w-full border rounded-lg px-2 py-2"
                value={periodTo}
                onChange={(e) => setPeriodTo(e.target.value)}
              />
            </div>
          </div>
          <p className="text-xs text-slate-600">
            <strong>Etiqueta en lotes:</strong> si completás <em>desde</em> y{" "}
            <em>hasta</em> con un rango válido, el chip &quot;Al ciclo&quot; en
            inventario se aplica solo a lotes cuya <strong>fecha de ingreso</strong>{" "}
            cae en ese rango (con existencia &gt; 0). Si falta el periodo, se usan
            lotes con fecha de ingreso hasta la fecha del corte.
          </p>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={computing}
              onClick={() => void handleComputeFromSystem()}
            >
              {computing ? "Calculando…" : "Calcular desde sistema"}
            </Button>
            <span className="text-xs text-slate-500 self-center">
              Usa lotes, ventas (salesV2), mermas y gastos pagados del rango.
            </span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
            {(
              [
                ["invoicedAtCost", "Facturado a costo"],
                ["soldAmount", "Vendido"],
                ["lbsIn", "Libras ingresadas"],
                ["lbsSold", "Libras vendidas"],
                ["lbsLost", "Libras perdidas"],
                ["unitsIn", "Unidades ingresadas"],
                ["unitsSold", "Unidades vendidas"],
                ["unitsLost", "Unidades perdidas"],
                ["grossProfit", "Ganancia bruta"],
                ["netProfit", "Ganancia neta"],
              ] as const
            ).map(([key, lab]) => (
              <div key={key}>
                <label className="block font-medium text-slate-700 mb-1">
                  {lab}
                </label>
                <input
                  type="number"
                  step="0.01"
                  className="w-full border rounded-lg px-2 py-2 tabular-nums"
                  value={report[key] === 0 ? "" : report[key]}
                  onChange={(e) => updateReport(key, e.target.value)}
                />
              </div>
            ))}
          </div>

          <div className="border-t border-slate-200 pt-4 space-y-3">
            <h3 className="font-semibold text-slate-800">
              Notas de conciliación (opcional)
            </h3>
            <p className="text-xs text-slate-600">
              Esto <strong>no mueve caja</strong>. Si cargás un gasto real en{" "}
              <Link to="../expenses" className="underline">
                Gastos
              </Link>
              , anotá aquí el id para archivo.
            </p>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Ref. gasto / documento
              </label>
              <input
                className="w-full border rounded-lg px-2 py-2"
                value={expenseRef}
                onChange={(e) => setExpenseRef(e.target.value)}
                placeholder="ID Firestore u otro número"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1">
                Notas
              </label>
              <textarea
                className="w-full border rounded-lg px-2 py-2 min-h-[72px]"
                value={financialNotes}
                onChange={(e) => setFinancialNotes(e.target.value)}
                placeholder="Ej. Cuadre con pesaje del 26/04; diferencia explicada por merma…"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="primary"
              disabled={saving}
              onClick={() => void handleSave()}
            >
              {saving
                ? "Guardando…"
                : editingId
                  ? "Actualizar corte"
                  : "Guardar corte"}
            </Button>
            {editingId ? (
              <Button
                type="button"
                variant="outline"
                disabled={saving}
                onClick={() => {
                  setShowForm(false);
                  resetForm();
                }}
              >
                Cancelar edición
              </Button>
            ) : null}
          </div>
        </div>
      )}

      {loading ? (
        <p className="text-slate-500 text-sm print:hidden">Cargando…</p>
      ) : rows.length === 0 ? (
        <p className="text-slate-500 text-sm print:hidden">
          No hay cortes registrados todavía.
        </p>
      ) : (
        <ul className="space-y-3 print:hidden">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm"
            >
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="font-bold text-slate-900">{r.displayLabel}</p>
                  <p className="text-xs text-slate-500 mt-1">
                    Corte: {r.cutoffDate}
                    {r.createdAt
                      ? ` · Registrado: ${format(r.createdAt.toDate(), "dd/MM/yyyy HH:mm")}`
                      : ""}
                  </p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setExpandedId((id) => (id === r.id ? null : r.id))
                    }
                  >
                    {expandedId === r.id ? "Ocultar" : "Ver reporte"}
                  </Button>
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={() => printRecord(r.id)}
                  >
                    Imprimir
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={saving}
                    onClick={() => startEdit(r)}
                  >
                    Editar
                  </Button>
                  <Button
                    type="button"
                    variant="danger"
                    size="sm"
                    disabled={saving}
                    onClick={() => void handleDelete(r)}
                  >
                    Eliminar
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {/* Solo impresión: el corte expandido o el último impreso */}
      <div className="hidden print:block">
        {rows
          .filter((r) => r.id === expandedId)
          .map((r) => (
            <CutoffReportPrint key={r.id} record={r} />
          ))}
      </div>

      {expandedId && (
        <div className="mt-4 print:hidden">
          {rows
            .filter((r) => r.id === expandedId)
            .map((r) => (
              <CutoffReportPrint key={r.id} record={r} />
            ))}
        </div>
      )}

      {msg && (
        <div className="print:hidden">
          <Toast message={msg} onClose={() => setMsg("")} />
        </div>
      )}
    </div>
  );
}
