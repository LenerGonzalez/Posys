// src/components/CierreVentas.tsx
import React, { useEffect, useRef, useState } from "react";
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
} from "firebase/firestore";
import { format } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { restoreSaleAndDelete } from "../Services/inventory";
import RefreshButton from "../components/common/RefreshButton";
import useManualRefresh from "../hooks/useManualRefresh";

type FireTimestamp = { toDate?: () => Date } | undefined;

interface SaleDataRaw {
  id?: string;
  productName?: string;
  quantity?: number;
  amount?: number;
  amountCharged?: number;
  amountSuggested?: number;
  date?: string;
  userEmail?: string;
  vendor?: string;
  clientName?: string;
  amountReceived?: number;
  change?: string | number;
  status?: "FLOTANTE" | "PROCESADA";
  timestamp?: FireTimestamp;
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  items?: any[]; // ← importante para multi-ítems
}

interface SaleData {
  id: string;
  productName: string;
  quantity: number;
  amount: number;
  amountSuggested: number;
  date: string;
  userEmail: string;
  clientName: string;
  amountReceived: number;
  change: string;
  status: "FLOTANTE" | "PROCESADA";
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
}

interface ClosureData {
  id: string;
  date: string;
  createdAt: any;
  products: { productName: string; quantity: number; amount: number }[];
  totalUnits: number;
  totalCharged: number;
  totalSuggested: number;
  totalDifference: number;
  salesV2?: any[];
  productSummary?: {
    productName: string;
    totalQuantity: number;
    totalAmount: number;
  }[];
  totalCOGS?: number;
  grossProfit?: number;
}

// 🔧 helpers
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

// 🔵 Normaliza UNA venta en MÚLTIPLES filas si trae items[]
const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
  const date =
    raw.date ??
    (raw.timestamp?.toDate
      ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
      : "");
  if (!date) return [];

  // Si trae items, retornar una fila por ítem
  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const qty = Number(it?.qty ?? 0);
      const lineFinal =
        Number(it?.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPrice || 0) * qty - Number(it?.discount || 0)
        );
      return {
        id: `${id}#${idx}`,
        productName: String(it?.productName ?? "(sin nombre)"),
        quantity: qty,
        amount: round2(lineFinal),
        amountSuggested: Number(raw.amountSuggested ?? 0), // (si te sirve)
        date,
        userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
        clientName: raw.clientName ?? "",
        amountReceived: Number(raw.amountReceived ?? 0),
        change: String(raw.change ?? "0"),
        status: (raw.status as any) ?? "FLOTANTE",
        allocations: Array.isArray(it?.allocations)
          ? it.allocations
          : raw.allocations,
        avgUnitCost: Number(it?.avgUnitCost ?? raw.avgUnitCost ?? 0),
        cogsAmount: Number(it?.cogsAmount ?? 0),
      };
    });
  }

  // Fallback: una sola fila
  return [
    {
      id,
      productName: raw.productName ?? "(sin nombre)",
      quantity: Number(raw.quantity ?? 0),
      amount: Number(raw.amount ?? raw.amountCharged ?? 0),
      amountSuggested: Number(raw.amountSuggested ?? 0),
      date,
      userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
      clientName: raw.clientName ?? "",
      amountReceived: Number(raw.amountReceived ?? 0),
      change: String(raw.change ?? "0"),
      status: (raw.status as any) ?? "FLOTANTE",
      allocations: raw.allocations,
      avgUnitCost: raw.avgUnitCost,
      cogsAmount: raw.cogsAmount,
    },
  ];
};

export default function CierreVentas({
  role,
}: {
  role?: "admin" | "vendedor";
}): React.ReactElement {
  const [salesV2, setSales] = useState<SaleData[]>([]);
  const [floatersExtra, setFloatersExtra] = useState<SaleData[]>([]);
  const [closure, setClosure] = useState<ClosureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FLOTANTE" | "PROCESADA">("ALL");

  const [editing, setEditing] = useState<null | SaleData>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [editAmount, setEditAmount] = useState<number>(0);
  const [editClient, setEditClient] = useState<string>("");
  const [editPaid, setEditPaid] = useState<number>(0);
  const [editChange, setEditChange] = useState<string>("0");

  const today = format(new Date(), "yyyy-MM-dd");
  const pdfRef = useRef<HTMLDivElement>(null);
  const { refreshKey, refresh } = useManualRefresh();

  // Ventas de HOY
  useEffect(() => {
    const q = query(collection(db, "salesV2"), where("date", "==", today));
    const unsub = onSnapshot(q, (snap) => {
      const rows: SaleData[] = [];
      snap.forEach((d) => {
        const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
        rows.push(...parts);
      });
      setSales(rows);
      setLoading(false);
    });
    return () => unsub();
  }, [today, refreshKey]);

  // FLOTANTE de cualquier fecha
  useEffect(() => {
    const qFlo = query(
      collection(db, "salesV2"),
      where("status", "==", "FLOTANTE")
    );
    const unsub = onSnapshot(qFlo, (snap) => {
      const rows: SaleData[] = [];
      snap.forEach((d) => {
        const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
        rows.push(...parts);
      });
      setFloatersExtra(rows);
    });
    return () => unsub();
  }, [refreshKey]);

  // Cierre guardado (informativo)
  useEffect(() => {
    const fetchClosure = async () => {
      const q = query(
        collection(db, "daily_closures"),
        where("date", "==", today)
      );
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const d = snapshot.docs[0];
        setClosure({ id: d.id, ...d.data() } as ClosureData);
      } else {
        setClosure(null);
      }
    };
    fetchClosure();
  }, [today, refreshKey]);

  // Ventas visibles
  const visibleSales = React.useMemo(() => {
    if (filter === "FLOTANTE") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) if (s.status === "FLOTANTE") map.set(s.id, s);
      return Array.from(map.values());
    }
    if (filter === "ALL") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) map.set(s.id, s);
      return Array.from(map.values());
    }
    return salesV2.filter((s) => s.status === "PROCESADA");
  }, [filter, salesV2, floatersExtra]);

  // Totales visibles
  const totalSuggested = round2(
    visibleSales.reduce((sum, s) => sum + (s.amountSuggested || 0), 0)
  );
  const totalCharged = round2(
    visibleSales.reduce((sum, s) => sum + (s.amount || 0), 0)
  );
  const totalUnits = round3(
    visibleSales.reduce((sum, s) => sum + (s.quantity || 0), 0)
  );
  const totalCOGSVisible = round2(
    visibleSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0)
  );
  const grossProfitVisible = round2(totalCharged - totalCOGSVisible);

  // Consolidado por producto
  const productMap: Record<
    string,
    { totalQuantity: number; totalAmount: number }
  > = {};
  visibleSales.forEach((s) => {
    const key = s.productName || "(sin nombre)";
    if (!productMap[key])
      productMap[key] = { totalQuantity: 0, totalAmount: 0 };
    productMap[key].totalQuantity = round3(
      productMap[key].totalQuantity + (s.quantity || 0)
    );
    productMap[key].totalAmount = round2(
      productMap[key].totalAmount + (s.amount || 0)
    );
  });
  const productSummaryArray = Object.entries(productMap).map(
    ([productName, v]) => ({
      productName,
      totalQuantity: v.totalQuantity,
      totalAmount: v.totalAmount,
    })
  );

  // Guardar cierre (misma lógica tuya)
  const handleSaveClosure = async () => {
    try {
      const candidatesVisible = visibleSales.filter(
        (s) => s.status === "FLOTANTE"
      );
      const toProcess =
        candidatesVisible.length > 0
          ? candidatesVisible
          : salesV2.filter((s) => s.status !== "PROCESADA");

      if (toProcess.length === 0) {
        setMessage("No hay ventas para procesar.");
        return;
      }

      const totals = {
        totalCharged: round2(
          toProcess.reduce((a, s) => a + (s.amount || 0), 0)
        ),
        totalSuggested: round2(
          toProcess.reduce((a, s) => a + (s.amountSuggested || 0), 0)
        ),
        totalUnits: round3(
          toProcess.reduce((a, s) => a + (s.quantity || 0), 0)
        ),
        totalCOGS: round2(
          toProcess.reduce((a, s) => a + Number(s.cogsAmount ?? 0), 0)
        ),
      };
      const diff = round2(totals.totalCharged - totals.totalSuggested);
      const grossProfit = round2(totals.totalCharged - totals.totalCOGS);

      const ref = await addDoc(collection(db, "daily_closures"), {
        date: today,
        createdAt: Timestamp.now(),
        totalCharged: totals.totalCharged,
        totalSuggested: totals.totalSuggested,
        totalDifference: diff,
        totalUnits: totals.totalUnits,
        totalCOGS: totals.totalCOGS,
        grossProfit,
        products: toProcess.map((s) => ({
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
        })),
        salesV2: toProcess.map((s) => ({
          id: s.id,
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
          amountSuggested: s.amountSuggested,
          userEmail: s.userEmail,
          clientName: s.clientName,
          amountReceived: s.amountReceived,
          change: s.change,
          status: s.status,
          cogsAmount: s.cogsAmount ?? 0,
          avgUnitCost: s.avgUnitCost ?? null,
          allocations: s.allocations ?? [],
          date: s.date,
        })),
        productSummary: Object.entries(
          toProcess.reduce((acc, s) => {
            const k = s.productName || "(sin nombre)";
            if (!acc[k]) acc[k] = { totalQuantity: 0, totalAmount: 0 };
            acc[k].totalQuantity = round3(
              acc[k].totalQuantity + (s.quantity || 0)
            );
            acc[k].totalAmount = round2(acc[k].totalAmount + (s.amount || 0));
            return acc;
          }, {} as Record<string, { totalQuantity: number; totalAmount: number }>)
        ).map(([productName, v]) => ({
          productName,
          totalQuantity: v.totalQuantity,
          totalAmount: v.totalAmount,
        })),
      });

      const batch = writeBatch(db);
      toProcess.forEach((s) => {
        batch.update(doc(db, "salesV2", s.id.split("#")[0]), {
          status: "PROCESADA",
          closureId: ref.id,
          closureDate: today,
        });
      });
      await batch.commit();

      setMessage(`✅ Cierre guardado. Ventas procesadas: ${toProcess.length}.`);
    } catch (error) {
      console.error(error);
      setMessage("❌ Error al guardar el cierre.");
    }
  };

  const handleRevert = async (saleId: string) => {
    if (
      !window.confirm("¿Revertir esta venta? Esta acción no se puede deshacer.")
    )
      return;
    try {
      await updateDoc(doc(db, "salesV2", saleId.split("#")[0]), {
        status: "FLOTANTE",
        closureId: null,
        closureDate: null,
      });
      setMessage("↩️ Venta revertida a FLOTANTE.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo revertir la venta.");
    }
  };

  const openEdit = (s: SaleData) => {
    setEditing(s);
    setEditQty(s.quantity);
    setEditAmount(s.amount);
    setEditClient(s.clientName);
    setEditPaid(s.amountReceived);
    setEditChange(s.change);
  };

  const saveEdit = async () => {
    if (!editing) return;
    try {
      await updateDoc(doc(db, "salesV2", editing.id.split("#")[0]), {
        quantity: editQty,
        amount: editAmount,
        amountCharged: editAmount,
        clientName: editClient,
        amountReceived: editPaid,
        change: editChange,
      });
      setEditing(null);
      setMessage("✅ Venta actualizada.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo actualizar la venta.");
    }
  };

  const deleteSale = async (saleId: string) => {
    if (
      !window.confirm(
        "¿Eliminar esta venta? Se restaurará el stock en los lotes asignados."
      )
    )
      return;
    try {
      const { restored } = await restoreSaleAndDelete(saleId.split("#")[0]);
      setMessage(
        `🗑️ Venta eliminada. Stock restaurado: ${Number(restored).toFixed(2)}.`
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar la venta.");
    }
  };

  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;
    pdfRef.current.classList.add("force-pdf-colors");
    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_${today}.pdf`);
    } finally {
      pdfRef.current.classList.remove("force-pdf-colors");
    }
  };

  const isAdmin = !role || role === "admin";

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      <h2 className="text-2xl font-bold mb-4">Cierre de Ventas - {today}</h2>

      <div className="flex items-center gap-2 mb-3">
        <label className="text-sm">Filtrar:</label>
        <select
          className="border rounded px-2 py-1"
          value={filter}
          onChange={(e) => setFilter(e.target.value as any)}
        >
          <option value="ALL">Todas</option>
          <option value="FLOTANTE">Venta Flotante</option>
          <option value="PROCESADA">Venta Procesada</option>
        </select>
      </div>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          <table className="min-w-full border text-sm mb-4  shadow-2xl">
            <thead className="bg-gray-100">
              <tr>
                <th className="border p-2">Estado</th>
                <th className="border p-2">Producto</th>
                <th className="border p-2">Libras - Unidad</th>
                <th className="border p-2">Monto</th>
                <th className="border p-2">Fecha venta</th>
                <th className="border p-2">Vendedor</th>
                <th className="border p-2">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {visibleSales.map((s) => (
                <tr key={s.id} className="text-center">
                  <td className="border p-1">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        s.status === "PROCESADA"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {s.status}
                    </span>
                  </td>
                  <td className="border p-1">{s.productName}</td>
                  <td className="border p-1">{qty3(s.quantity)}</td>
                  <td className="border p-1">C${money(s.amount)}</td>
                  <td className="border p-1">{s.date}</td>
                  <td className="border p-1">{s.userEmail}</td>
                  <td className="border p-1">
                    {s.status === "FLOTANTE" ? (
                      <div className="flex gap-2 justify-center">
                        {isAdmin && (
                          <>
                            <button
                              onClick={() => openEdit(s)}
                              className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700"
                            >
                              Editar
                            </button>
                            <button
                              onClick={() => deleteSale(s.id)}
                              className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                            >
                              Eliminar
                            </button>
                          </>
                        )}
                        {!isAdmin && (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </div>
                    ) : s.status === "PROCESADA" ? (
                      <div className="flex gap-2 justify-center">
                        {isAdmin ? (
                          <button
                            onClick={() => handleRevert(s.id)}
                            className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                          >
                            Revertir
                          </button>
                        ) : (
                          <span className="text-gray-400 text-xs">—</span>
                        )}
                      </div>
                    ) : (
                      <span className="text-gray-400 text-xs">No options</span>
                    )}
                  </td>
                </tr>
              ))}
              {visibleSales.length === 0 && (
                <tr>
                  <td colSpan={9} className="p-3 text-center text-gray-500">
                    Sin ventas para mostrar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-sm mb-2">
            <div>
              {" "}
              Total Libras/Unidades: <strong>{qty3(totalUnits)}</strong>
            </div>
            <div>
              {" "}
              Total cobrado: <strong>C${money(totalCharged)}</strong>
            </div>
          </div>

          {(totalCOGSVisible > 0 || grossProfitVisible !== totalCharged) && (
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-sm mb-6">
              <div>
                {" "}
                Calculo a Precio compra:{" "}
                <strong>C${money(totalCOGSVisible)}</strong>
              </div>
              <div>
                {" "}
                Ganancia antes de gasto:{" "}
                <strong>C${money(grossProfitVisible)}</strong>
              </div>
            </div>
          )}

          <h3 className="font-semibold mb-2">Consolidado por producto</h3>
          <table className="min-w-full border text-sm mb-2 shadow-2xl">
            <thead className="bg-gray-100">
              <tr>
                <th className="border p-2">Producto</th>
                <th className="border p-2">Total libras/unidades</th>
                <th className="border p-2">Total dinero</th>
              </tr>
            </thead>
            <tbody>
              {productSummaryArray.map((row) => (
                <tr key={row.productName} className="text-center">
                  <td className="border p-1">{row.productName}</td>
                  <td className="border p-1">{qty3(row.totalQuantity)}</td>
                  <td className="border p-1">C${money(row.totalAmount)}</td>
                </tr>
              ))}
              {productSummaryArray.length === 0 && (
                <tr>
                  <td colSpan={3} className="p-3 text-center text-gray-500">
                    Sin datos para consolidar.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      <div className="flex gap-2">
        <button
          onClick={handleSaveClosure}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Cerrar ventas del día
        </button>
        <button
          onClick={handleDownloadPDF}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Descargar PDF
        </button>
      </div>

      {message && <p className="mt-2 text-sm">{message}</p>}

      {/* Panel de edición */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-4 space-y-3">
            <h4 className="font-semibold text-lg">Editar venta</h4>
            <div className="text-sm text-gray-500">
              {editing.productName} • {editing.userEmail}
            </div>

            <label className="text-sm">Cantidad</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editQty}
              onChange={(e) => setEditQty(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Monto cobrado</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editAmount}
              onChange={(e) => setEditAmount(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Cliente</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editClient}
              onChange={(e) => setEditClient(e.target.value)}
            />

            <label className="text-sm">Paga con</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editPaid}
              onChange={(e) => setEditPaid(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Vuelto</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editChange}
              onChange={(e) => setEditChange(e.target.value)}
            />

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setEditing(null)}
                className="px-3 py-1 border rounded"
              >
                Cancelar
              </button>
              <button
                onClick={saveEdit}
                className="px-3 py-1 rounded text-white bg-indigo-600 hover:bg-indigo-700"
              >
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
