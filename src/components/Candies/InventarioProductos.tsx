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
  where,
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
  packages: number; // legacy (puede estar moviéndose con remainingPackages)
  unitsPerPackage: number; // Und x paquete
  totalUnits: number; // Paquetes iniciales * Und x paquete
  remaining: number; // Total de unidades restantes
  remainingPackages?: number; // opcional
  providerPrice: number; // Precio proveedor
  subtotal: number; // guardado (puede venir legacy)
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

  // opcional (si lo guardas desde orden maestra)
  orderId?: string | null;
}

type ProductGroupRow = {
  productId: string;
  productName: string;
  category: string;

  totalPackages: number; // sum de paquetes iniciales
  remainingPackages: number; // sum de paquetes restantes

  providerPrice: number; // del último lote (para mostrar)
  unitPriceRivas: number; // del último lote (para mostrar)
  unitPriceIsla: number; // del último lote (para mostrar)

  subtotal: number; // SUMA real (providerPrice*lotePacks)
  totalRivas: number; // SUMA real (unitPriceRivas*lotePacks)
  totalIsla: number; // SUMA real (unitPriceIsla*lotePacks)
  gainRivas: number; // totalRivas - subtotal
  gainIsla: number; // totalIsla - subtotal

  lastDate: string; // última fecha del producto (max)
  lastCreatedAt?: Timestamp;
  batchCount: number; // cuántos lotes tiene ese producto
};

function getInitialPacks(b: CandyBatch): number {
  // paquetes iniciales = totalUnits / unitsPerPackage
  if (b.unitsPerPackage > 0 && b.totalUnits > 0) {
    return Math.floor(b.totalUnits / b.unitsPerPackage);
  }
  // fallback
  return Math.max(0, Math.floor(Number(b.packages || 0)));
}

function getRemainingPacks(b: CandyBatch): number {
  if (
    typeof b.remainingPackages === "number" &&
    isFinite(b.remainingPackages)
  ) {
    return Math.max(0, Math.floor(b.remainingPackages));
  }
  if (b.unitsPerPackage > 0) {
    return Math.max(
      0,
      Math.floor(Number(b.remaining || 0) / b.unitsPerPackage)
    );
  }
  return 0;
}

function compareDateCreatedAtDesc(a: CandyBatch, b: CandyBatch) {
  const da = String(a.date || "");
  const dbs = String(b.date || "");
  if (da !== dbs) return dbs.localeCompare(da); // desc
  const ca = a.createdAt?.seconds ?? 0;
  const cb = b.createdAt?.seconds ?? 0;
  return cb - ca; // desc
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
  const [categoryFilter, setCategoryFilter] = useState<string>("");

  // Edición simple (solo precio proveedor + fecha, el resto se recalcula)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editProviderPrice, setEditProviderPrice] = useState<number>(0);

  // Modal detalle
  const [openDetail, setOpenDetail] = useState(false);
  const [detailProductId, setDetailProductId] = useState<string>("");
  const [detailProductName, setDetailProductName] = useState<string>("");
  const [detailRows, setDetailRows] = useState<CandyBatch[]>([]);

  // ===== Carga inicial =====
  useEffect(() => {
    (async () => {
      try {
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

          const unitsPerPackage = Number(b.unitsPerPackage || 0);
          const totalUnits = Number(
            b.totalUnits ?? (b.packages || 0) * (b.unitsPerPackage || 0)
          );
          const remaining = Number(b.remaining ?? b.totalUnits ?? 0);

          rows.push({
            id: d.id,
            productId: b.productId,
            productName: b.productName,
            category: b.category,
            measurement: b.measurement ?? "unidad",
            packages: Number(b.packages || 0),
            unitsPerPackage,
            totalUnits,
            remaining,
            remainingPackages:
              typeof b.remainingPackages === "number"
                ? Number(b.remainingPackages)
                : undefined,
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
            orderId: b.orderId ?? null,
          });
        });

        setBatches(rows);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando inventario.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ===== Filtros en memoria =====
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      if (categoryFilter && String(b.category || "") !== categoryFilter)
        return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId, categoryFilter]);

  // Categorías disponibles
  const categories = useMemo(() => {
    const s = new Set<string>();
    for (const p of products) if (p.category) s.add(p.category);
    return Array.from(s).sort((a, b) => a.localeCompare(b));
  }, [products]);

  // Totales del filtro (como pediste)
  const totals = useMemo(() => {
    const totalPaquetes = filteredBatches.reduce(
      (a, b) => a + getInitialPacks(b),
      0
    );

    const totalPaquetesRestantes = filteredBatches.reduce(
      (a, b) => a + getRemainingPacks(b),
      0
    );

    // Sub total = providerPrice * paquetes iniciales (por lote)
    const totalSubtotal = filteredBatches.reduce((a, b) => {
      const packs = getInitialPacks(b);
      return a + Number(b.providerPrice || 0) * packs;
    }, 0);

    const totalRivas = filteredBatches.reduce((a, b) => {
      const packs = getInitialPacks(b);
      return a + Number(b.unitPriceRivas || 0) * packs;
    }, 0);

    const totalSJ = filteredBatches.reduce((a, b) => {
      const packs = getInitialPacks(b);
      return a + Number(b.unitPriceSanJorge || 0) * packs;
    }, 0);

    const totalIsla = filteredBatches.reduce((a, b) => {
      const packs = getInitialPacks(b);
      return a + Number(b.unitPriceIsla || 0) * packs;
    }, 0);

    return {
      totalPaquetes,
      totalPaquetesRestantes,
      totalSubtotal,
      totalRivas,
      totalSJ,
      totalIsla,
    };
  }, [filteredBatches]);

  // KPIs extra (lotes totales / pendientes / pagados)
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

  // ===== Agrupación por producto para la tabla principal =====
  const groupedRows: ProductGroupRow[] = useMemo(() => {
    const map = new Map<string, { batches: CandyBatch[] }>();

    for (const b of filteredBatches) {
      const pid = String(b.productId || "");
      if (!pid) continue;
      if (!map.has(pid)) map.set(pid, { batches: [] });
      map.get(pid)!.batches.push(b);
    }

    const out: ProductGroupRow[] = [];

    for (const [productId, entry] of map.entries()) {
      const list = [...entry.batches].sort(compareDateCreatedAtDesc);
      const last = list[0];

      const totalPackages = list.reduce((a, x) => a + getInitialPacks(x), 0);
      const remainingPackages = list.reduce(
        (a, x) => a + getRemainingPacks(x),
        0
      );

      // Para mostrar (referencia): del último lote
      const providerPrice = Number(last?.providerPrice || 0);
      const unitPriceRivas = Number(last?.unitPriceRivas || 0);
      const unitPriceIsla = Number(last?.unitPriceIsla || 0);

      // ✅ SUMA REAL por lote (no “último precio * totalPackages”)
      const subtotal = list.reduce((acc, x) => {
        const packs = getInitialPacks(x);
        return acc + Number(x.providerPrice || 0) * packs;
      }, 0);

      const totalRivas = list.reduce((acc, x) => {
        const packs = getInitialPacks(x);
        return acc + Number(x.unitPriceRivas || 0) * packs;
      }, 0);

      const totalIsla = list.reduce((acc, x) => {
        const packs = getInitialPacks(x);
        return acc + Number(x.unitPriceIsla || 0) * packs;
      }, 0);

      const gainRivas = totalRivas - subtotal;
      const gainIsla = totalIsla - subtotal;

      // última fecha = max date
      let lastDate = "";
      let lastCreatedAt: Timestamp | undefined = undefined;
      for (const x of list) {
        if (!lastDate || String(x.date || "") > lastDate) {
          lastDate = String(x.date || "");
          lastCreatedAt = x.createdAt;
        }
      }

      out.push({
        productId,
        productName: last?.productName || "",
        category: last?.category || "",
        totalPackages,
        remainingPackages,
        providerPrice,
        unitPriceRivas,
        unitPriceIsla,
        subtotal,
        totalRivas,
        totalIsla,
        gainRivas,
        gainIsla,
        lastDate,
        lastCreatedAt,
        batchCount: list.length,
      });
    }

    out.sort((a, b) => String(b.lastDate).localeCompare(String(a.lastDate)));
    return out;
  }, [filteredBatches]);

  // ===== Acciones (por lote, dentro del detalle) =====
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

    // ✅ FIX: usar paquetes iniciales reales (no old.packages legacy)
    const packsInitial = getInitialPacks(old);

    // === MISMA LÓGICA TUYA ORIGINAL (solo corrigiendo base de packs) ===
    const subtotal = editProviderPrice * packsInitial;
    const totalRivas = packsInitial > 0 ? subtotal / 0.8 : 0;
    const totalSanJorge = packsInitial > 0 ? subtotal / 0.85 : 0;
    const totalIsla = packsInitial > 0 ? subtotal / 0.7 : 0;

    const gainRivas = totalRivas - subtotal;
    const gainSanJorge = totalSanJorge - subtotal;
    const gainIsla = totalIsla - subtotal;

    const unitPriceRivas =
      packsInitial > 0 ? roundToInt(totalRivas / packsInitial) : 0;
    const unitPriceSanJorge =
      packsInitial > 0 ? roundToInt(totalSanJorge / packsInitial) : 0;
    const unitPriceIsla =
      packsInitial > 0 ? roundToInt(totalIsla / packsInitial) : 0;

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

  // ===== Acciones (fila agrupada) =====
  const openProductDetail = async (productId: string, productName: string) => {
    try {
      setLoading(true);
      setMsg("");

      const qB = query(
        collection(db, "inventory_candies"),
        where("productId", "==", productId),
        orderBy("date", "desc")
      );
      const snap = await getDocs(qB);

      const rows: CandyBatch[] = [];
      snap.forEach((d) => {
        const b = d.data() as any;

        const unitsPerPackage = Number(b.unitsPerPackage || 0);
        const totalUnits = Number(
          b.totalUnits ?? (b.packages || 0) * (b.unitsPerPackage || 0)
        );
        const remaining = Number(b.remaining ?? b.totalUnits ?? 0);

        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          measurement: b.measurement ?? "unidad",
          packages: Number(b.packages || 0),
          unitsPerPackage,
          totalUnits,
          remaining,
          remainingPackages:
            typeof b.remainingPackages === "number"
              ? Number(b.remainingPackages)
              : undefined,
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
          orderId: b.orderId ?? null,
        });
      });

      setDetailProductId(productId);
      setDetailProductName(productName);
      setDetailRows(rows);
      setOpenDetail(true);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error abriendo detalle del producto.");
    } finally {
      setLoading(false);
    }
  };

  const deleteProductAllBatches = async (
    productId: string,
    productName: string
  ) => {
    const lotsToDelete = batches.filter((b) => b.productId === productId);
    const ok = confirm(
      `¿Eliminar COMPLETAMENTE "${productName}"?\nEsto eliminará ${lotsToDelete.length} lote(s) de este producto.`
    );
    if (!ok) return;

    try {
      setLoading(true);
      setMsg("");

      for (const b of lotsToDelete) {
        await deleteDoc(doc(db, "inventory_candies", b.id));
      }

      setBatches((prev) => prev.filter((x) => x.productId !== productId));
      setMsg("🗑️ Producto eliminado (todos sus lotes).");

      if (openDetail && detailProductId === productId) {
        setOpenDetail(false);
        setDetailRows([]);
        setDetailProductId("");
        setDetailProductName("");
      }
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando lotes del producto.");
    } finally {
      setLoading(false);
    }
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

        {/* (Extra) Categoría */}
        <div className="flex flex-col min-w-[220px]">
          <label className="font-semibold">Categoría</label>
          <select
            className="border rounded px-2 py-1"
            value={categoryFilter}
            onChange={(e) => setCategoryFilter(e.target.value)}
          >
            <option value="">Todas</option>
            {categories.map((c) => (
              <option key={c} value={c}>
                {c}
              </option>
            ))}
          </select>
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
            setCategoryFilter("");
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

      {/* Totales */}
      <div className="bg-gray-50 p-3 rounded shadow border mb-3 text-sm md:text-base">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-y-1 gap-x-8">
          <div>
            <span className="font-semibold">Paquetes ingresados:</span>{" "}
            {totals.totalPaquetes}
          </div>
          <div>
            <span className="font-semibold">Paquetes restantes:</span>{" "}
            {totals.totalPaquetesRestantes}
          </div>
          <div>
            <span className="font-semibold">Sub total:</span>{" "}
            {money(totals.totalSubtotal)}
          </div>
          <div>
            <span className="font-semibold">Total Rivas:</span>{" "}
            {money(totals.totalRivas)}
          </div>
          <div>
            <span className="font-semibold">Total San Jorge:</span>{" "}
            {money(totals.totalSJ)}
          </div>
          <div>
            <span className="font-semibold">Total Isla:</span>{" "}
            {money(totals.totalIsla)}
          </div>
        </div>
      </div>

      {/* Tabla PRINCIPAL agrupada */}
      <div className="bg-white rounded shadow border w-full overflow-x-auto">
        <div className="w-full overflow-x-auto">
          <table className="min-w-[1200px] table-auto text-xs md:text-sm">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className="p-2 border text-left">Categoría</th>
                <th className="p-2 border text-left">Producto</th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Paquetes totales
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Paquetes restantes
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Precio proveedor
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Precio venta Rivas
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Precio venta Isla
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Subtotal
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Total Rivas
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Total Isla
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Ganancia bruta Rivas
                </th>
                <th className="p-2 border whitespace-nowrap text-right">
                  Ganancia bruta Isla
                </th>
                <th className="p-2 border whitespace-nowrap">Última fecha</th>
                <th className="p-2 border whitespace-nowrap text-center">
                  Opciones
                </th>
              </tr>
            </thead>

            <tbody className="whitespace-nowrap">
              {loading ? (
                <tr>
                  <td colSpan={14} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : groupedRows.length === 0 ? (
                <tr>
                  <td colSpan={14} className="p-4 text-center">
                    Sin productos
                  </td>
                </tr>
              ) : (
                groupedRows.map((r) => (
                  <tr key={r.productId} className="text-left">
                    <td className="p-2 border">{r.category || "—"}</td>
                    <td className="p-2 border max-w-[260px]">
                      <span className="block truncate" title={r.productName}>
                        {r.productName}
                      </span>
                      <span className="text-[10px] text-gray-500">
                        Lotes: {r.batchCount}
                      </span>
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {r.totalPackages}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {r.remainingPackages}
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {money(r.providerPrice)}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {money(r.unitPriceRivas)}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {money(r.unitPriceIsla)}
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {money(r.subtotal)}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {money(r.totalRivas)}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {money(r.totalIsla)}
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {money(r.gainRivas)}
                    </td>
                    <td className="p-2 border text-right tabular-nums">
                      {money(r.gainIsla)}
                    </td>

                    <td className="p-2 border">{r.lastDate || "—"}</td>

                    <td className="p-2 border">
                      <div className="flex gap-1 justify-center flex-wrap">
                        <button
                          className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                          onClick={() =>
                            openProductDetail(r.productId, r.productName)
                          }
                        >
                          Detalle
                        </button>
                        <button
                          className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                          onClick={() =>
                            deleteProductAllBatches(r.productId, r.productName)
                          }
                        >
                          Borrar
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* MODAL DETALLE (lotes reales) */}
      {openDetail && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white p-4 rounded shadow-lg w-full max-w-6xl max-h-[90vh] overflow-y-auto text-sm">
            <div className="flex items-start justify-between gap-3 mb-3">
              <div>
                <h3 className="text-lg font-bold">Detalle del producto</h3>
                <div className="text-xs text-gray-600">
                  <span className="font-semibold">Producto:</span>{" "}
                  {detailProductName || "—"}{" "}
                  <span className="ml-2">
                    <span className="font-semibold">ID:</span> {detailProductId}
                  </span>
                </div>
              </div>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => {
                  setOpenDetail(false);
                  setDetailRows([]);
                  setDetailProductId("");
                  setDetailProductName("");
                  cancelEdit();
                }}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded shadow border w-full overflow-x-auto">
              <table className="min-w-[1200px] table-auto text-xs md:text-sm">
                <thead className="bg-gray-100 sticky top-0 z-10">
                  <tr>
                    <th className="p-2 border text-left">Fecha</th>
                    <th className="p-2 border">Categoría</th>
                    <th className="p-2 border text-left">Producto</th>
                    <th className="p-2 border text-right">
                      Paquetes ingresados
                    </th>
                    <th className="p-2 border text-right">
                      Paquetes restantes
                    </th>
                    <th className="p-2 border text-right">Unidades</th>
                    <th className="p-2 border text-right">Precio proveedor</th>
                    <th className="p-2 border text-right">
                      Precio venta Rivas
                    </th>
                    <th className="p-2 border text-right">Precio venta Isla</th>
                    <th className="p-2 border">Número orden</th>
                    <th className="p-2 border">Status</th>
                    <th className="p-2 border text-center">Acciones</th>
                  </tr>
                </thead>

                <tbody className="whitespace-nowrap">
                  {detailRows.length === 0 ? (
                    <tr>
                      <td
                        colSpan={12}
                        className="p-4 text-center text-gray-500"
                      >
                        Sin lotes
                      </td>
                    </tr>
                  ) : (
                    detailRows.map((b) => {
                      const isEditing = editingId === b.id;

                      const initialPacks = getInitialPacks(b);
                      const remainingPacks = getRemainingPacks(b);

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

                          <td className="p-2 border align-top">
                            {b.category || "—"}
                          </td>

                          <td className="p-2 border align-top max-w-[260px]">
                            <span
                              className="block truncate"
                              title={b.productName}
                            >
                              {b.productName}
                            </span>
                            <span className="text-[10px] text-gray-500">
                              Lote ID: {b.id}
                            </span>
                          </td>

                          <td className="p-2 border align-top text-right tabular-nums">
                            {initialPacks}
                          </td>

                          <td className="p-2 border align-top text-right tabular-nums">
                            {remainingPacks}
                          </td>

                          {/* ✅ Unidades = totalUnits (como dice el header) */}
                          <td className="p-2 border align-top text-right tabular-nums">
                            {b.totalUnits}
                          </td>

                          {/* Precio proveedor */}
                          <td className="p-2 border align-top text-right tabular-nums">
                            {isEditing ? (
                              <input
                                type="number"
                                step="0.01"
                                inputMode="decimal"
                                className="w-24 border p-1 rounded text-right"
                                value={
                                  Number.isNaN(editProviderPrice)
                                    ? ""
                                    : editProviderPrice
                                }
                                onChange={(e) =>
                                  setEditProviderPrice(
                                    Math.max(
                                      0,
                                      parseFloat(e.target.value || "0")
                                    )
                                  )
                                }
                              />
                            ) : (
                              money(b.providerPrice)
                            )}
                          </td>

                          <td className="p-2 border align-top text-right tabular-nums">
                            {money(b.unitPriceRivas)}
                          </td>

                          <td className="p-2 border align-top text-right tabular-nums">
                            {money(b.unitPriceIsla)}
                          </td>

                          <td className="p-2 border align-top">
                            {b.orderId ? String(b.orderId) : "—"}
                          </td>

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
                                    className="px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-xs"
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

            <div className="mt-3 flex justify-end">
              <button
                className="px-3 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                onClick={() =>
                  deleteProductAllBatches(detailProductId, detailProductName)
                }
              >
                Borrar producto (todos los lotes)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
