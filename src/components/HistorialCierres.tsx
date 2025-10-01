// src/components/HistorialCierres.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  deleteDoc,
  doc,
  getDocs,
  query,
  where,
  writeBatch,
} from "firebase/firestore";
import { format, subDays } from "date-fns";

type ClosureDoc = {
  id: string;
  date: string; // "yyyy-MM-dd"
  createdAt?: any;
  totalUnits?: number;
  totalCharged?: number;
  totalSuggested?: number;
  totalDifference?: number;

  // NUEVO: métricas financieras (guardadas por CierreVentas)
  totalCOGS?: number; // costo total del día
  grossProfit?: number; // utilidad bruta del día

  products?: { productName: string; quantity: number; amount: number }[];

  // detalle (si lo guardaste desde CierreVentas)
  salesV2?: Array<{
    id?: string;
    productName?: string;
    quantity?: number;
    amount?: number;
    amountSuggested?: number;
    userEmail?: string;
    clientName?: string;
    amountReceived?: number;
    change?: string | number;
    status?: "FLOTANTE" | "PROCESADA";
    cogsAmount?: number;
    avgUnitCost?: number | null;
    allocations?: {
      batchId: string;
      qty: number;
      unitCost: number;
      lineCost: number;
    }[];
    // ⬇️ NUEVO (opcional): fecha de la venta si fue guardada por CierreVentas
    date?: string;
  }>;

  // compat: si tuvieras el campo "sales" legacy
  sales?: Array<{
    id?: string;
    productName?: string;
    quantity?: number;
    amount?: number;
    amountSuggested?: number;
    userEmail?: string;
    clientName?: string;
    amountReceived?: number;
    change?: string | number;
    status?: "FLOTANTE" | "PROCESADA";
  }>;

  productSummary?: Array<{
    productName: string;
    totalQuantity: number;
    totalAmount: number;
  }>;
};

const money = (n: unknown) => Number(n ?? 0).toFixed(2);
// ⬇️ NUEVO helper para cantidades a 3 decimales (solo formato de salida)
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

export default function HistorialCierres() {
  const deleteClosure = async (c: ClosureDoc) => {
    if (!window.confirm(`¿Eliminar el cierre del ${c.date}?`)) return;

    // Ofrece reabrir ventas ligadas a este cierre
    const alsoRevert = window.confirm(
      "¿También quieres reabrir (revertir a FLOTANTE) las ventas vinculadas a este cierre?"
    );

    try {
      if (alsoRevert) {
        // Busca ventas ligadas por closureId
        const qs = await getDocs(
          query(collection(db, "salesV2"), where("closureId", "==", c.id))
        );
        if (!qs.empty) {
          const batch = writeBatch(db);
          qs.forEach((d) => {
            batch.update(doc(db, "salesV2", d.id), {
              status: "FLOTANTE",
              closureId: null,
              closureDate: null,
            });
          });
          await batch.commit();
        }
      }

      // Borra el doc del cierre
      await deleteDoc(doc(db, "daily_closures", c.id));

      // Limpia selección y refresca lista
      if (selected?.id === c.id) setSelected(null);
      await fetchClosures();

      setMessage(
        `🗑️ Cierre eliminado${alsoRevert ? " y ventas reabiertas." : "."}`
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar el cierre.");
    }
  };

  const [startDate, setStartDate] = useState<string>(
    format(subDays(new Date(), 14), "yyyy-MM-dd")
  );
  const [endDate, setEndDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [loading, setLoading] = useState<boolean>(true);
  const [closures, setClosures] = useState<ClosureDoc[]>([]);
  const [selected, setSelected] = useState<ClosureDoc | null>(null);
  const [message, setMessage] = useState<string>("");

  const detailRef = useRef<HTMLDivElement>(null);

  const fetchClosures = async () => {
    try {
      setLoading(true);
      const qy = query(
        collection(db, "daily_closures"),
        where("date", ">=", startDate),
        where("date", "<=", endDate)
      );
      const snap = await getDocs(qy);
      const rows: ClosureDoc[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      rows.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
      setClosures(rows);
    } catch (e) {
      console.error(e);
      setMessage("❌ Error cargando el historial.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClosures();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const applyFilter = async (e: React.FormEvent) => {
    e.preventDefault();
    fetchClosures();
  };

  const totalsForSelected = useMemo(() => {
    if (!selected)
      return { units: 0, sug: 0, chg: 0, diff: 0, cogs: 0, profit: 0 };
    const units = Number(selected.totalUnits ?? 0);
    const sug = Number(selected.totalSuggested ?? 0);
    const chg = Number(selected.totalCharged ?? 0);
    const diff = Number(
      selected.totalDifference ?? (isFinite(chg - sug) ? chg - sug : 0)
    );
    const cogs = Number(selected.totalCOGS ?? 0); // NUEVO
    const profit = Number(
      selected.grossProfit ?? (isFinite(chg - cogs) ? chg - cogs : 0)
    ); // NUEVO
    return { units, sug, chg, diff, cogs, profit };
  }, [selected]);

  const handleDownloadPDF = async () => {
    if (!detailRef.current || !selected) return;

    const el = detailRef.current;
    // Forzar colores simples antes de rasterizar
    el.classList.add("force-pdf-colors");

    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
        import("html2canvas"),
        import("jspdf"),
      ]);

      const canvas = await html2canvas(el, {
        backgroundColor: "#ffffff",
        onclone: (clonedDoc) => {
          const win = clonedDoc.defaultView!;
          const root = clonedDoc.body;
          root.querySelectorAll<HTMLElement>("*").forEach((n) => {
            const cs = win.getComputedStyle(n);
            if (cs.color) n.style.color = cs.color;
            if (
              cs.backgroundColor &&
              cs.backgroundColor !== "rgba(0, 0, 0, 0)"
            ) {
              n.style.backgroundColor = cs.backgroundColor;
            }
            if (cs.borderColor) n.style.borderColor = cs.borderColor;
          });
        },
      });

      const imgData = canvas.toDataURL("image/png");
      const { jsPDF: _jsPDF } = await import("jspdf");
      const pdf = new _jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_${selected.date}.pdf`);
    } finally {
      el.classList.remove("force-pdf-colors");
    }
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded-2xl shadow-2xl">
      <h1 className="text-2xl font-bold mb-4">Histórico de cierres</h1>

      {/* Filtro por rango */}
      <form
        onSubmit={applyFilter}
        className="flex flex-wrap items-end gap-3 mb-4"
      >
        <div>
          <label className="block text-sm">Desde</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={startDate}
            onChange={(e) => setStartDate(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm">Hasta</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={endDate}
            onChange={(e) => setEndDate(e.target.value)}
          />
        </div>
        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Aplicar
        </button>
      </form>

      {/* Tabla de cierres */}
      {loading ? (
        <p>Cargando...</p>
      ) : closures.length === 0 ? (
        <p className="text-sm text-gray-500">
          Sin cierres en el rango seleccionado.
        </p>
      ) : (
        <table className="min-w-full text-sm mb-6  shadow-lg p-4 bg-white border-gray-100">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Total libras/unidades</th>
              <th className="border p-2">Monto de venta</th>
              {/* <th className="border p-2">Total sugerido</th> */}
              {/* <th className="border p-2">Diferencia</th> */}
              {/* NUEVOS campos en la tabla de lista */}
              <th className="border p-2">Monto al costo</th>
              <th className="border p-2">Ganancia sin gastos</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {closures.map((c) => (
              <tr key={c.id} className="text-center">
                <td className="border p-1">{c.date}</td>
                {/* ⬇️ mostrar total unidades con 3 decimales */}
                <td className="border p-1">{qty3(c.totalUnits)}</td>
                <td className="border p-1">C${money(c.totalCharged)}</td>
                {/* NUEVOS celdas de COGS y utilidad */}
                <td className="border p-1">C${money(c.totalCOGS)}</td>
                <td className="border p-1">
                  C$
                  {money(
                    c.grossProfit ??
                      Number(c.totalCharged ?? 0) - Number(c.totalCOGS ?? 0)
                  )}
                </td>
                <td className="border p-1">
                  <div className="flex items-center gap-2 justify-center">
                    <button
                      className="text-xs bg-gray-800 text-white px-2 py-1 rounded hover:bg-black"
                      onClick={() => setSelected(c)}
                    >
                      Ver detalle
                    </button>
                    <button
                      className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                      onClick={() => deleteClosure(c)}
                    >
                      Eliminar
                    </button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Detalle del cierre seleccionado */}
      {selected && (
        <div className="mt-6 rounded-2xl shadow-lg p-4 bg-white border-solid border-2 border-gray-100">
          <div className="flex items-center gap-3 mb-2 ">
            <h2 className="text-xl font-semibold">Detalle {selected.date}</h2>
            <button
              onClick={() => setSelected(null)}
              className="text-sm px-2 py-1 border rounded"
            >
              Cerrar
            </button>
            <button
              onClick={handleDownloadPDF}
              className="ml-auto bg-green-600 text-white px-3 py-1 rounded-2xl hover:bg-green-700 text-sm"
            >
              Descargar PDF
            </button>
          </div>

          <div ref={detailRef} className="space-y-4">
            {/* Totales */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                {/* ⬇️ total unidades a 3 decimales */}
                Total Libras/Unidades: <strong>{qty3(totalsForSelected.units)}</strong>
              </div>
              {/* <div>
                Total sugerido:{" "}
                <strong>C${money(totalsForSelected.sug)}</strong>
              </div>
              <div>
                Total cobrado: <strong>C${money(totalsForSelected.chg)}</strong>
              </div> */}
              {/* <div
                className={`font-bold ${
                  totalsForSelected.diff < 0 ? "text-red-600" : "text-green-600"
                }`}
              >
                Diferencia: C${money(totalsForSelected.diff)}
              </div> */}
            </div>

            {/* NUEVO: Bloque finanzas del día */}
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm">
              <div>
                Monto al costo:{" "}
                <strong>C${money(totalsForSelected.cogs)}</strong>
              </div>
              <div>
                Ganancia sin gastos:{" "}
                <strong>C${money(totalsForSelected.profit)}</strong>
              </div>
            </div>

            {/* Detalle de ventas (salesV2 si existe, si no products) */}
            {selected.salesV2?.length ? (
              <>
                <h3 className="font-semibold">Ventas incluidas en el cierre</h3>
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      {/* ⬇️ cantidad a 3 decimales */}
                      <th className="border p-2">Cantidad</th>
                      <th className="border p-2">Monto de ventas</th>
                      <th className="border p-2">Monto al costo</th>
                      {/* ⬇️ NUEVA columna: fecha de venta (si existe en el doc) */}
                      <th className="border p-2">Fecha venta</th>
                      <th className="border p-2">Vendedor</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.salesV2.map((s, i) => (
                      <tr key={i} className="text-center">
                        <td className="border p-1">
                          {s.productName ?? "(sin nombre)"}
                        </td>
                        <td className="border p-1">{qty3(s.quantity)}</td>
                        <td className="border p-1">C${money(s.amount)}</td>
                        <td className="border p-1">C${money(s.cogsAmount)}</td>
                        {/* ⬇️ muestra fecha si está guardada; si no, “—” */}
                        <td className="border p-1">{s.date ?? "—"}</td>
                        <td className="border p-1">{s.userEmail ?? ""}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : selected.sales?.length ? (
              <>
                <h3 className="font-semibold">Ventas incluidas en el cierre</h3>
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Cantidad</th>
                      <th className="border p-2">Monto</th>
                      <th className="border p-2">Vendedor</th>
                      <th className="border p-2">Cliente</th>
                      <th className="border p-2">Paga con</th>
                      <th className="border p-2">Vuelto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.sales.map((s, i) => (
                      <tr key={i} className="text-center">
                        <td className="border p-1">
                          {s.productName ?? "(sin nombre)"}
                        </td>
                        <td className="border p-1">{qty3(s.quantity)}</td>
                        <td className="border p-1">C${money(s.amount)}</td>
                        <td className="border p-1">{s.userEmail ?? ""}</td>
                        <td className="border p-1">{s.clientName ?? ""}</td>
                        <td className="border p-1">
                          C${money(s.amountReceived)}
                        </td>
                        <td className="border p-1">
                          {typeof s.change === "number"
                            ? money(s.change)
                            : s.change ?? "0"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : selected.products?.length ? (
              <>
                <h3 className="font-semibold">Productos en el cierre</h3>
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Cantidad</th>
                      <th className="border p-2">Monto</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.products.map((p, i) => (
                      <tr key={i} className="text-center">
                        <td className="border p-1">{p.productName}</td>
                        <td className="border p-1">{qty3(p.quantity)}</td>
                        <td className="border p-1">C${money(p.amount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : (
              <p className="text-sm text-gray-500">
                Sin detalle de ventas en este cierre.
              </p>
            )}

            {/* Consolidado por producto si existe */}
            {selected.productSummary?.length ? (
              <>
                <h3 className="font-semibold">Consolidado por producto</h3>
                <table className="min-w-full border text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="border p-2">Producto</th>
                      <th className="border p-2">Total libras/unidades</th>
                      <th className="border p-2">Total dinero</th>
                    </tr>
                  </thead>
                  <tbody>
                    {selected.productSummary.map((r, i) => (
                      <tr key={i} className="text-center">
                        <td className="border p-1">{r.productName}</td>
                        <td className="border p-1">{qty3(r.totalQuantity)}</td>
                        <td className="border p-1">C${money(r.totalAmount)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            ) : null}
          </div>
        </div>
      )}

      {message && <p className="mt-3 text-sm">{message}</p>}
    </div>
  );
}
