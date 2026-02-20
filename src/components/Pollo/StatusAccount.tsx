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

const money = (n: unknown) => `C$${Number(n ?? 0).toFixed(2)}`;
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");

type LedgerType =
  | "VENTA_CASH"
  | "ABONO"
  | "GASTO"
  | "REABASTECIMIENTO"
  | "RETIRO"
  | "AJUSTE";

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

  // form
  const [date, setDate] = useState(today());
  const [type, setType] = useState<LedgerType>("GASTO");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  // use string states for inputs so we can keep partial values like '.' while typing
  const [inAmount, setInAmount] = useState<string>("");
  const [outAmount, setOutAmount] = useState<string>("");

  const { refreshKey, refresh } = useManualRefresh();

  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [actionOpenId, setActionOpenId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);

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
              // mark source so UI can treat external rows differently
              source: "ledger",
            }) as any,
        );

        // Also load expenses in the same date range and map to ledger shape
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
            type: "GASTO", // map expenses as GASTO
            description: x.description || "Gasto",
            reference: x.category || x.reference || null,
            inAmount: 0,
            outAmount: Number(x.amount || 0),
            createdAt: x.createdAt ?? null,
            createdBy: x.createdBy ?? null,
            source: "expenses",
          } as any;
        });

        // Merge and sort by date asc (stable)
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

  // saldo base: ventas cash + abonos
  const saldoBase = base?.saldoBase ?? 0;

  // saldo corrido: base + sum(entradas) - sum(salidas)
  const ledgerWithBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    const rows = [...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );
    return rows.map((r) => {
      bal = bal + Number(r.inAmount || 0) - Number(r.outAmount || 0);
      return { ...r, balance: bal };
    });
  }, [ledger, saldoBase]);

  const saldoFinal = ledgerWithBalance.length
    ? ledgerWithBalance[ledgerWithBalance.length - 1].balance
    : saldoBase;

  const totals = useMemo(() => {
    const inSum = ledger.reduce((a, r) => a + Number(r.inAmount || 0), 0);
    const outSum = ledger.reduce((a, r) => a + Number(r.outAmount || 0), 0);
    return { inSum, outSum };
  }, [ledger]);

  const downloadExcelFile = (filename: string, rows: (string | number)[][], sheetName = "Hoja1") => {
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
      "Saldo",
      "Fuente",
      "Creado por",
    ];
    rows.push(headers);

    // use ledgerWithBalance for calculated balance
    (ledgerWithBalance || []).forEach((r: any) => {
      const createdBy = r.createdBy ? `${r.createdBy.email || r.createdBy.uid || ""}` : "";
      rows.push([
        r.date || "",
        r.type || "",
        r.description || "",
        r.reference || "",
        (r.inAmount || 0),
        (r.outAmount || 0),
        (r.balance || 0),
        (r.source || "ledger"),
        createdBy,
      ]);
    });

    const name = `estado_cuenta_${from || "desde"}_${to || "hasta"}.xlsx`;
    downloadExcelFile(name, rows, "Movimientos");
  };

  const saveMovement = async () => {
    const inVal = Number(inAmount || 0);
    const outVal = Number(outAmount || 0);

    if (!date) return window.alert("Poné una fecha.");
    if (!description.trim()) return window.alert("Poné una descripción.");
    if (inVal <= 0 && outVal <= 0)
      return window.alert("Poné una entrada o una salida.");
    if (inVal > 0 && outVal > 0)
      return window.alert("Usá solo entrada o salida, no ambos.");

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
      // update existing
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

    // reset form
    setDescription("");
    setReference("");
    setInAmount("");
    setOutAmount("");

    refresh();
    setModalOpen(false);
    setEditingId(null);
  };

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
        <h2 className="text-xl sm:text-2xl font-bold">
          Estado de Cuenta (Pollo)
        </h2>
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
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Libras Cash</div>
          <div className="text-2xl font-bold">{qty3(base?.lbsCash ?? 0)}</div>
        </div>
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Libras Crédito</div>
          <div className="text-2xl font-bold">{qty3(base?.lbsCredit ?? 0)}</div>
        </div>
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Total Libras</div>
          <div className="text-2xl font-bold">
            {qty3((base?.lbsCash ?? 0) + (base?.lbsCredit ?? 0))}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Unidades Cash</div>
          <div className="text-2xl font-bold">{qty3(base?.unitsCash ?? 0)}</div>
        </div>
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Unidades Crédito</div>
          <div className="text-2xl font-bold">
            {qty3(base?.unitsCredit ?? 0)}
          </div>
        </div>
        <div className="border rounded-2xl p-3 bg-gray-50">
          <div className="text-xs text-gray-600">Total Unidades</div>
          <div className="text-2xl font-bold">
            {qty3((base?.unitsCash ?? 0) + (base?.unitsCredit ?? 0))}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-white">
          <div className="text-xs text-gray-600">Ventas Cash</div>
          <div className="text-2xl font-bold">
            {money(base?.salesCash ?? 0)}
          </div>
        </div>
        <div className="border rounded-2xl p-3 bg-white">
          <div className="text-xs text-gray-600">Ventas Crédito</div>
          <div className="text-2xl font-bold">
            {money(base?.salesCredit ?? 0)}
          </div>
        </div>
        <div className="border rounded-2xl p-3 bg-white">
          <div className="text-xs text-gray-600">Abonado al periodo</div>
          <div className="text-2xl font-bold">
            {money(base?.abonosPeriodo ?? 0)}
          </div>
        </div>

        <div className="border rounded-2xl p-3 bg-indigo-50">
          <div className="text-xs text-gray-600">
            Saldo base (Ventas Cash + Abonos)
          </div>
          <div className="text-2xl font-bold">{money(saldoBase)}</div>
        </div>
        <div className="border rounded-2xl p-3 bg-green-50">
          <div className="text-xs text-gray-600">Entradas manuales</div>
          <div className="text-2xl font-bold">{money(totals.inSum)}</div>
        </div>
        <div className="border rounded-2xl p-3 bg-red-50">
          <div className="text-xs text-gray-600">Salidas manuales</div>
          <div className="text-2xl font-bold">{money(totals.outSum)}</div>
        </div>

        <div className="border rounded-2xl p-3 bg-gray-900 text-white sm:col-span-2 lg:col-span-3">
          <div className="text-xs opacity-80">Saldo final (corriente)</div>
          <div className="text-3xl font-extrabold">{money(saldoFinal)}</div>
        </div>
      </div>

      {/* Mobile: KPIs grouped in a card */}
      <div className="md:hidden mb-4">
        <div className="border rounded-2xl p-3 bg-white shadow-sm space-y-2">
          <div className="flex items-center justify-between">
            <div className="text-xs text-gray-600">Saldo final (corriente)</div>
            <div className="text-lg font-bold">{money(saldoFinal)}</div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div className="border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600">Saldo base</div>
              <div className="font-semibold">{money(saldoBase)}</div>
            </div>
            <div className="border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600">Entradas manuales</div>
              <div className="font-semibold">{money(totals.inSum)}</div>
            </div>
            <div className="border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600">Salidas manuales</div>
              <div className="font-semibold">{money(totals.outSum)}</div>
            </div>
            <div className="border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600">Ventas Cash</div>
              <div className="font-semibold">{money(base?.salesCash ?? 0)}</div>
            </div>
            <div className="border rounded p-2 bg-gray-50">
              <div className="text-xs text-gray-600">Abonado al periodo</div>
              <div className="font-semibold">
                {money(base?.abonosPeriodo ?? 0)}
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Formulario dentro de modal: botón disparador */}
      <div className="mb-4">
        <button
          type="button"
          onClick={() => setModalOpen(true)}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg hover:bg-blue-700"
        >
          Agregar movimiento
        </button>
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
                  <option value="REABASTECIMIENTO">Reabastecimiento</option>
                  <option value="RETIRO">Retiro</option>
                  <option value="DEPOSITO">Deposito a Carmen Ortiz</option>
                  <option value="PERDIDA">Perdida por robo</option>
                </select>
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
                    // Only allow numbers with up to 2 decimals (allow trailing dot)
                    if (
                      /^\d*(\.\d{0,2})?$/.test(val) ||
                      val === "." ||
                      val === ""
                    ) {
                      setInAmount(val === "." ? "." : val);
                    }
                  }}
                  placeholder="0.00"
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
              <th className="border p-2">Saldo</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {/* fila base (informativa) */}
            <tr className="text-center bg-indigo-50">
              <td className="border p-1">
                {from} → {to}
              </td>
              <td className="border p-1">SALDO_BASE</td>
              <td className="border p-1 text-left">
                Ventas Cash + Abonos del periodo
              </td>
              <td className="border p-1">—</td>
              <td className="border p-1">{money(saldoBase)}</td>
              <td className="border p-1">{money(0)}</td>
              <td className="border p-1 font-semibold">{money(saldoBase)}</td>
            </tr>

            {ledgerWithBalance.map((r) => (
              <tr key={r.id} className="text-center">
                <td className="border p-1">{r.date}</td>
                <td className="border p-1">{r.type}</td>
                <td className="border p-1 text-left">{r.description}</td>
                <td className="border p-1">{r.reference || "—"}</td>
                <td className="border p-1">{money(r.inAmount)}</td>
                <td className="border p-1">{money(r.outAmount)}</td>
                <td className="border p-1 font-semibold">
                  {money((r as any).balance)}
                </td>
                <td className="border p-1 relative">
                  {(r as any).source === "expenses" ? (
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
                              // open modal prefilled for edit
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

            {ledgerWithBalance.length === 0 && (
              <tr>
                <td colSpan={7} className="p-3 text-center text-gray-500">
                  No hay movimientos manuales en este rango.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: ledger as cards */}
      <div className="md:hidden space-y-3">
        {ledgerWithBalance.length === 0 ? (
          <div className="text-center text-gray-500 text-sm py-6">
            Sin movimientos manuales en este rango.
          </div>
        ) : (
          ledgerWithBalance.map((r) => (
            <div
              key={r.id}
              className="border rounded-xl p-3 bg-white shadow-sm"
            >
              <div className="flex justify-between items-start">
                <div>
                  <div className="text-sm font-semibold">{r.description}</div>
                  <div className="text-xs text-gray-500">
                    {r.date} • {r.type}
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
                  <div className="text-xs text-gray-500">Saldo</div>
                  <div className="font-semibold">
                    {money((r as any).balance)}
                  </div>
                </div>
              </div>

              <div className="mt-3 flex justify-end gap-2">
                {(r as any).source === "expenses" ? null : (
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
