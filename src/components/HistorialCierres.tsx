// src/HistorialCierres.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  addDoc,
  Timestamp,
  query,
  where,
  onSnapshot,
  writeBatch,
  doc,
  updateDoc,
  deleteDoc,
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
  products?: { productName: string; quantity: number; amount: number }[];
  // opcionales agregados:
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

export default function HistorialCierres() {
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
      // Nota: Firestore permite doble where en el mismo campo
      const qy = query(
        collection(db, "daily_closures"),
        where("date", ">=", startDate),
        where("date", "<=", endDate)
        // Si tu colección guarda muchos, puedes añadir orderBy("date","desc") en reglas adecuadas
      );
      const snap = await getDocs(qy);
      const rows: ClosureDoc[] = [];
      snap.forEach((d) => rows.push({ id: d.id, ...(d.data() as any) }));
      // Ordenamos manualmente por fecha descendente
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
    if (!selected) return { units: 0, sug: 0, chg: 0, diff: 0 };
    const units = Number(selected.totalUnits ?? 0);
    const sug = Number(selected.totalSuggested ?? 0);
    const chg = Number(selected.totalCharged ?? 0);
    const diff = Number(selected.totalDifference ?? chg - sug);
    return { units, sug, chg, diff };
  }, [selected]);

  const handleDownloadPDF = async () => {
    if (!detailRef.current || !selected) return;
    const [{ default: html2canvas }, { jsPDF }] = await Promise.all([
      import("html2canvas"),
      import("jspdf"),
    ]);
    const canvas = await html2canvas(detailRef.current);
    const imgData = canvas.toDataURL("image/png");
    const pdf = new jsPDF();
    pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
    pdf.save(`cierre_${selected.date}.pdf`);
  };

  return (
    <div className="max-w-7xl mx-auto p-6 bg-white rounded shadow">
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
        <table className="min-w-full border text-sm mb-6">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Total libras/unidades</th>
              <th className="border p-2">Total cobrado</th>
              <th className="border p-2">Total sugerido</th>
              <th className="border p-2">Diferencia</th>
              <th className="border p-2">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {closures.map((c) => (
              <tr key={c.id} className="text-center">
                <td className="border p-1">{c.date}</td>
                <td className="border p-1">{c.totalUnits ?? 0}</td>
                <td className="border p-1">C${money(c.totalCharged)}</td>
                <td className="border p-1">C${money(c.totalSuggested)}</td>
                <td
                  className={`border p-1 ${
                    Number(c.totalDifference ?? 0) < 0
                      ? "text-red-600"
                      : "text-green-700"
                  }`}
                >
                  C$
                  {money(
                    c.totalDifference ??
                      Number(c.totalCharged ?? 0) -
                        Number(c.totalSuggested ?? 0)
                  )}
                </td>
                <td className="border p-1">
                  <button
                    className="text-xs bg-gray-800 text-white px-2 py-1 rounded hover:bg-black"
                    onClick={() => setSelected(c)}
                  >
                    Ver detalle
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* Detalle del cierre seleccionado */}
      {selected && (
        <div className="mt-6">
          <div className="flex items-center gap-3 mb-2">
            <h2 className="text-xl font-semibold">Detalle {selected.date}</h2>
            <button
              onClick={() => setSelected(null)}
              className="text-sm px-2 py-1 border rounded"
            >
              Cerrar
            </button>
            <button
              onClick={handleDownloadPDF}
              className="ml-auto bg-green-600 text-white px-3 py-1 rounded hover:bg-green-700 text-sm"
            >
              Descargar PDF
            </button>
          </div>

          <div ref={detailRef} className="space-y-4">
            {/* Totales */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm">
              <div>
                Total unidades: <strong>{totalsForSelected.units}</strong>
              </div>
              <div>
                Total sugerido:{" "}
                <strong>C${money(totalsForSelected.sug)}</strong>
              </div>
              <div>
                Total cobrado: <strong>C${money(totalsForSelected.chg)}</strong>
              </div>
              <div
                className={`font-bold ${
                  totalsForSelected.diff < 0 ? "text-red-600" : "text-green-600"
                }`}
              >
                Diferencia: C${money(totalsForSelected.diff)}
              </div>
            </div>

            {/* Si existe el detalle de ventas, lo mostramos */}
            {selected.sales?.length ? (
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
                        <td className="border p-1">{s.quantity ?? 0}</td>
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
                        <td className="border p-1">{p.quantity}</td>
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
                        <td className="border p-1">{r.totalQuantity}</td>
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
