// src/components/InventoryCandyBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  deleteDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";

// ===== Helpers =====
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// redondeo estándar: 1.5 → 2, 1.4 → 1
function roundToInt(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.round(value);
}

interface CandyProduct {
  id: string;
  name: string;
  category: string;
}

type BatchStatus = "PENDIENTE" | "PAGADO";

interface CandyBatch {
  id: string;
  productId: string;
  productName: string;
  category: string;
  measurement: string; // "unidad"
  packages: number; // (puede cambiar con ventas, lo corregimos en UI)
  unitsPerPackage: number; // Und x paquete
  totalUnits: number; // Paquetes iniciales * Und x paquete
  remaining: number; // Total de unidades restantes
  providerPrice: number; // Precio proveedor
  subtotal: number; // Precio proveedor * Paquetes iniciales
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  gainRivas: number;
  gainSanJorge: number;
  gainIsla: number;
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;
  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
  status: BatchStatus;
}

export default function InventoryCandyBatches() {
  const [products, setProducts] = useState<CandyProduct[]>([]);
  const [batches, setBatches] = useState<CandyBatch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [productFilterId, setProductFilterId] = useState<string>("");

  // Edición simple (solo precio proveedor + fecha, el resto se recalcula)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editProviderPrice, setEditProviderPrice] = useState<number>(0);

  // ===== Carga inicial =====
  useEffect(() => {
    (async () => {
      setLoading(true);

      // Productos de dulces (para filtro)
      const psnap = await getDocs(collection(db, "products_candies"));
      const prods: CandyProduct[] = [];
      psnap.forEach((d) => {
        const it = d.data() as any;
        prods.push({
          id: d.id,
          name: it.name ?? "(sin nombre)",
          category: it.category ?? "(sin categoría)",
        });
      });
      setProducts(prods);

      // Lotes de dulces
      const qB = query(
        collection(db, "inventory_candies"),
        orderBy("date", "desc")
      );
      const bsnap = await getDocs(qB);
      const rows: CandyBatch[] = [];
      bsnap.forEach((d) => {
        const b = d.data() as any;
        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          measurement: b.measurement ?? "unidad",
          packages: Number(b.packages || 0),
          unitsPerPackage: Number(b.unitsPerPackage || 0),
          totalUnits: Number(
            b.totalUnits ?? (b.packages || 0) * (b.unitsPerPackage || 0)
          ),
          remaining: Number(b.remaining ?? b.totalUnits ?? 0),
          providerPrice: Number(b.providerPrice || 0),
          subtotal: Number(b.subtotal || 0),
          totalRivas: Number(b.totalRivas || 0),
          totalSanJorge: Number(b.totalSanJorge || 0),
          totalIsla: Number(b.totalIsla || 0),
          gainRivas: Number(b.gainRivas || 0),
          gainSanJorge: Number(b.gainSanJorge || 0),
          gainIsla: Number(b.gainIsla || 0),
          unitPriceRivas: Number(b.unitPriceRivas || 0),
          unitPriceSanJorge: Number(b.unitPriceSanJorge || 0),
          unitPriceIsla: Number(b.unitPriceIsla || 0),
          date: b.date,
          createdAt: b.createdAt,
          status: (b.status as BatchStatus) ?? "PENDIENTE",
        });
      });
      setBatches(rows);
      setLoading(false);
    })();
  }, []);

  // ===== Filtros en memoria =====
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  // Totales del filtro
  const totals = useMemo(() => {
    // paquetes iniciales por lote (no cambian)
    const getInitialPacks = (b: CandyBatch) => {
      if (b.unitsPerPackage > 0) {
        return Math.floor(b.totalUnits / b.unitsPerPackage);
      }
      return b.packages;
    };

    const totalPaquetes = filteredBatches.reduce(
      (a, b) => a + getInitialPacks(b),
      0
    );
    const totalUnidades = filteredBatches.reduce((a, b) => a + b.totalUnits, 0);
    const totalRestantesUnidades = filteredBatches.reduce(
      (a, b) => a + b.remaining,
      0
    );

    // Paquetes restantes = remaining / unitsPerPackage
    const totalPaquetesRestantes = filteredBatches.reduce((a, b) => {
      if (b.unitsPerPackage <= 0) return a;
      return a + Math.floor(b.remaining / b.unitsPerPackage);
    }, 0);

    const totalSubtotal = filteredBatches.reduce((a, b) => a + b.subtotal, 0);
    const totalRivas = filteredBatches.reduce((a, b) => a + b.totalRivas, 0);
    const totalSJ = filteredBatches.reduce((a, b) => a + b.totalSanJorge, 0);
    const totalIsla = filteredBatches.reduce((a, b) => a + b.totalIsla, 0);
    return {
      totalPaquetes,
      totalUnidades,
      totalRestantesUnidades,
      totalPaquetesRestantes,
      totalSubtotal,
      totalRivas,
      totalSJ,
      totalIsla,
    };
  }, [filteredBatches]);

  // === KPIs extra (lotes totales / pendientes / pagados) ===
  const kpisLotes = useMemo(() => {
    let pendientes = 0;
    let pagados = 0;

    for (const b of filteredBatches) {
      if (b.status === "PENDIENTE") pendientes += 1;
      if (b.status === "PAGADO") pagados += 1;
    }

    return {
      totalLotes: filteredBatches.length,
      pendientes,
      pagados,
    };
  }, [filteredBatches]);

  // ===== Acciones =====
  const startEdit = (b: CandyBatch) => {
    setEditingId(b.id);
    setEditDate(b.date);
    setEditProviderPrice(b.providerPrice);
    setMsg("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDate("");
    setEditProviderPrice(0);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const old = batches.find((x) => x.id === editingId);
    if (!old) return;

    if (editProviderPrice < 0) {
      setMsg("El precio proveedor no puede ser negativo.");
      return;
    }

    // Recalcular derivado según tu lógica original
    const subtotal = editProviderPrice * old.packages;
    const totalRivas = old.packages > 0 ? subtotal / 0.8 : 0;
    const totalSanJorge = old.packages > 0 ? subtotal / 0.85 : 0;
    const totalIsla = old.packages > 0 ? subtotal / 0.7 : 0;

    const gainRivas = totalRivas - subtotal;
    const gainSanJorge = totalSanJorge - subtotal;
    const gainIsla = totalIsla - subtotal;

    const unitPriceRivas =
      old.packages > 0 ? roundToInt(totalRivas / old.packages) : 0;
    const unitPriceSanJorge =
      old.packages > 0 ? roundToInt(totalSanJorge / old.packages) : 0;
    const unitPriceIsla =
      old.packages > 0 ? roundToInt(totalIsla / old.packages) : 0;

    const ref = doc(db, "inventory_candies", editingId);
    await updateDoc(ref, {
      date: editDate,
      providerPrice: editProviderPrice,
      subtotal,
      totalRivas,
      totalSanJorge,
      totalIsla,
      gainRivas,
      gainSanJorge,
      gainIsla,
      unitPriceRivas,
      unitPriceSanJorge,
      unitPriceIsla,
    });

    setBatches((prev) =>
      prev.map((b) =>
        b.id === editingId
          ? {
              ...b,
              date: editDate,
              providerPrice: editProviderPrice,
              subtotal,
              totalRivas,
              totalSanJorge,
              totalIsla,
              gainRivas,
              gainSanJorge,
              gainIsla,
              unitPriceRivas,
              unitPriceSanJorge,
              unitPriceIsla,
            }
          : b
      )
    );

    setMsg("✅ Lote de dulces actualizado");
    cancelEdit();
  };

  const payBatch = async (b: CandyBatch) => {
    const ok = confirm(
      `¿Marcar PAGADO el lote del ${b.date} (${b.productName})?`
    );
    if (!ok) return;
    await updateDoc(doc(db, "inventory_candies", b.id), {
      status: "PAGADO",
    });
    setBatches((prev) =>
      prev.map((x) => (x.id === b.id ? { ...x, status: "PAGADO" } : x))
    );
    setMsg("✅ Lote marcado como pagado");
  };

  const deleteBatch = async (b: CandyBatch) => {
    const ok = confirm(`¿Eliminar el lote del ${b.date} (${b.productName})?`);
    if (!ok) return;
    await deleteDoc(doc(db, "inventory_candies", b.id));
    setBatches((prev) => prev.filter((x) => x.id !== b.id));
    setMsg("🗑️ Lote eliminado");
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Inventario Productos</h2>
      </div>

      {/* Filtros */}
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
        <div className="flex flex-col min-w-[240px]">
          <label className="font-semibold">Producto</label>
          <select
            className="border rounded px-2 py-1"
            value={productFilterId}
            onChange={(e) => setProductFilterId(e.target.value)}
          >
            <option value="">Todos</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.category}
              </option>
            ))}
          </select>
        </div>

        <button
          className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProductFilterId("");
          }}
        >
          Quitar filtro
        </button>
      </div>

      {/* KPIs de lotes */}
      <div className="bg-gray-50 p-2 rounded shadow border mb-2 text-xs md:text-sm">
        <div className="flex flex-wrap gap-x-6 gap-y-1">
          <div>
            <span className="font-semibold">Lotes totales:</span>{" "}
            {kpisLotes.totalLotes}
          </div>
          <div>
            <span className="font-semibold">Lotes pendientes:</span>{" "}
            {kpisLotes.pendientes}
          </div>
          <div>
            <span className="font-semibold">Lotes pagados:</span>{" "}
            {kpisLotes.pagados}
          </div>
        </div>
      </div>

      {/* Totales como en tu imagen */}
      <div className="bg-gray-50 p-3 rounded shadow border mb-3 text-sm md:text-base">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-y-1 gap-x-8">
          <div>
            <span className="font-semibold">Paquetes totales:</span>{" "}
            {totals.totalPaquetes}
          </div>
          <div>
            <span className="font-semibold">Paquetes restantes:</span>{" "}
            {totals.totalPaquetesRestantes}
          </div>
          <div>
            <span className="font-semibold">Subtotal total:</span>{" "}
            {money(totals.totalSubtotal)}
          </div>
          <div>
            <span className="font-semibold">Total Rivas (todo):</span>{" "}
            {money(totals.totalRivas)}
          </div>
          <div>
            <span className="font-semibold">Total San Jorge (todo):</span>{" "}
            {money(totals.totalSJ)}
          </div>
          <div>
            <span className="font-semibold">Total Isla (todo):</span>{" "}
            {money(totals.totalIsla)}
          </div>
        </div>
      </div>

      {/* Tabla */}
      <div className="bg-white rounded shadow border w-full overflow-x-auto">
        <div className="w-full overflow-x-auto">
          <table className="min-w-full table-auto text-xs md:text-sm">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className="p-2 border text-left">Fecha</th>
                <th className="p-2 border whitespace-nowrap">Categoría</th>
                <th className="p-2 border whitespace-nowrap">Producto</th>
                <th className="p-2 border whitespace-nowrap">Precio Prov.</th>
                <th className="p-2 border whitespace-nowrap">Paquetes</th>
                <th className="p-2 border whitespace-nowrap">Paq restantes</th>
                <th className="p-2 border whitespace-nowrap">Und x Paq.</th>
                <th className="p-2 border whitespace-nowrap">Und Totales</th>
                <th className="p-2 border whitespace-nowrap">Und Restantes</th>
                <th className="p-2 border whitespace-nowrap">Subtotal</th>
                <th className="p-2 border whitespace-nowrap">Total Rivas</th>
                <th className="p-2 border whitespace-nowrap">Total SJ</th>
                <th className="p-2 border whitespace-nowrap">Total Isla</th>
                <th className="p-2 border whitespace-nowrap">G. R</th>
                <th className="p-2 border whitespace-nowrap">G. SJ</th>
                <th className="p-2 border whitespace-nowrap">G. IO</th>
                <th className="p-2 border whitespace-nowrap">P. U R</th>
                <th className="p-2 border whitespace-nowrap">P. U SJ</th>
                <th className="p-2 border whitespace-nowrap">P. U IO</th>
                <th className="p-2 border whitespace-nowrap">Estado</th>
                <th className="p-2 border whitespace-nowrap text-center">
                  Acciones
                </th>
              </tr>
            </thead>

            <tbody className="whitespace-nowrap">
              {loading ? (
                <tr>
                  <td colSpan={21} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : filteredBatches.length === 0 ? (
                <tr>
                  <td colSpan={21} className="p-4 text-center">
                    Sin lotes
                  </td>
                </tr>
              ) : (
                filteredBatches.map((b) => {
                  const isEditing = editingId === b.id;

                  // Paquetes iniciales y restantes por lote
                  const initialPacks =
                    b.unitsPerPackage > 0
                      ? Math.floor(b.totalUnits / b.unitsPerPackage)
                      : b.packages;
                  const paquetesRestantes =
                    b.unitsPerPackage > 0
                      ? Math.floor(b.remaining / b.unitsPerPackage)
                      : 0;

                  return (
                    <tr key={b.id} className="text-left">
                      {/* Fecha */}
                      <td className="p-2 border align-top">
                        {isEditing ? (
                          <input
                            type="date"
                            className="w-full border p-1 rounded"
                            value={editDate}
                            onChange={(e) => setEditDate(e.target.value)}
                          />
                        ) : (
                          b.date
                        )}
                      </td>

                      {/* Categoría */}
                      <td className="p-2 border align-top">
                        {b.category || "—"}
                      </td>

                      {/* Producto */}
                      <td className="p-2 border align-top max-w-[220px] md:max-w-[320px]">
                        <span className="block truncate" title={b.productName}>
                          {b.productName}
                        </span>
                      </td>

                      {/* Precio Proveedor */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="w-20 border p-1 rounded text-right"
                            value={
                              Number.isNaN(editProviderPrice)
                                ? ""
                                : editProviderPrice
                            }
                            onChange={(e) =>
                              setEditProviderPrice(
                                Math.max(0, parseFloat(e.target.value || "0"))
                              )
                            }
                          />
                        ) : (
                          money(b.providerPrice)
                        )}
                      </td>

                      {/* Paquetes (iniciales, no cambian) */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {initialPacks}
                      </td>

                      {/* Paquetes restantes */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {paquetesRestantes}
                      </td>

                      {/* Und x paquete */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.unitsPerPackage}
                      </td>

                      {/* Und totales */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.totalUnits}
                      </td>

                      {/* Und restantes */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.remaining}
                      </td>

                      {/* Subtotal */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.subtotal)}
                      </td>

                      {/* Total Rivas */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.totalRivas)}
                      </td>

                      {/* Total SJ */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.totalSanJorge)}
                      </td>

                      {/* Total Isla */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.totalIsla)}
                      </td>

                      {/* Ganancias */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.gainRivas)}
                      </td>
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.gainSanJorge)}
                      </td>
                      <td className="p-2 border align-top text-right tabular-nums">
                        {money(b.gainIsla)}
                      </td>

                      {/* P. Unidad */}
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.unitPriceRivas}
                      </td>
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.unitPriceSanJorge}
                      </td>
                      <td className="p-2 border align-top text-right tabular-nums">
                        {b.unitPriceIsla}
                      </td>

                      {/* Estado */}
                      <td className="p-2 border align-top">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] md:text-xs ${
                            b.status === "PAGADO"
                              ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700"
                          }`}
                        >
                          {b.status}
                        </span>
                      </td>

                      {/* Acciones */}
                      <td className="p-2 border align-top">
                        {isEditing ? (
                          <div className="flex gap-2 justify-center">
                            <button
                              className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                              onClick={saveEdit}
                            >
                              Guardar
                            </button>
                            <button
                              className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                              onClick={cancelEdit}
                            >
                              Cancelar
                            </button>
                          </div>
                        ) : (
                          <div className="flex gap-1 justify-center flex-wrap">
                            {b.status === "PENDIENTE" && (
                              <button
                                className="px-2 py-1 rounded bg-green-600 text:white hover:bg-green-700 text-xs"
                                onClick={() => payBatch(b)}
                              >
                                Pagar
                              </button>
                            )}
                            <button
                              className="px-2 py-1 rounded bg-yellow-400 text-black hover:bg-yellow-500 text-xs"
                              onClick={() => startEdit(b)}
                            >
                              Editar
                            </button>
                            <button
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                              onClick={() => deleteBatch(b)}
                            >
                              Borrar
                            </button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
