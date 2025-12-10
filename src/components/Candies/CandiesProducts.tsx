// src/components/Candies/ProductsCandy.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { calcPriceByBranch } from "../../Services/pricing_candies";

// REFRESH
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

// ====== Catálogos ======
const CANDY_CATEGORIES = [
  "Caramelo",
  "Meneito",
  "Chicles",
  "Jalea",
  "Bombones",
  "Chocolate",
  "Galleta",
  "Bolsas Tematicas",
  "Bolsas Dulceras",
  "Mochilas",
  "Juguetes",
  "Platos y Vasos",
] as const;

type CandyCategory = (typeof CANDY_CATEGORIES)[number];

interface CandyRow {
  id: string;
  name: string; // Producto
  category: CandyCategory;
  providerPrice: number; // Precio Proveedor
  packages: number; // Paquetes
  unitsPerPackage: number; // Unidades por paquete
  subtotal: number; // Subtotal
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  gainRivas: number; // G. Paquete R
  gainSanJorge: number; // G. Paquete SJ
  gainIsla: number; // G. Paquete IO
  unitPriceRivas: number; // P. Unidad R
  unitPriceSanJorge: number; // P. Unidad SJ
  unitPriceIsla: number; // P. Unidad IO
  inventoryDate: string; // yyyy-MM-dd
  createdAt: Timestamp;
}

// Helper: redondeo estándar (ejemplo 1.5 -> 2, 1.4 -> 1)
function roundToInt(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.round(value);
}

export default function ProductsCandy() {
  // ====== STATE FORM (crear) ======
  const [category, setCategory] = useState<CandyCategory>("Caramelo");
  const [productName, setProductName] = useState(""); // Producto
  const [providerPrice, setProviderPrice] = useState<string>(""); // Precio Proveedor
  const [packages, setPackages] = useState<string>("0"); // Paquetes
  const [unitsPerPackage, setUnitsPerPackage] = useState<string>("1"); // Unidades por paquete
  const [inventoryDate, setInventoryDate] = useState<string>(""); // Fecha inventario

  // Mensaje / estado
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const { refreshKey, refresh } = useManualRefresh();

  // Lista
  const [rows, setRows] = useState<CandyRow[]>([]);

  // Modal
  const [openForm, setOpenForm] = useState(false);

  // ====== EDICIÓN INLINE ======
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Partial<CandyRow> | null>(null);

  const startEdit = (row: CandyRow) => {
    setEditingId(row.id);
    setEditValues({ ...row });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditValues(null);
  };

  const handleEditChange = (field: keyof CandyRow, value: string) => {
    if (!editValues) return;
    setEditValues((prev) => ({
      ...prev,
      [field]:
        field === "name" || field === "category" || field === "inventoryDate"
          ? value
          : Number(value || 0),
    }));
  };

  const saveEdit = async () => {
    if (!editingId || !editValues) return;

    const rowOriginal = rows.find((r) => r.id === editingId);
    if (!rowOriginal) return;

    const name = (editValues.name ?? rowOriginal.name).toString().trim();
    if (!name) {
      setMsg("El nombre del producto no puede estar vacío.");
      return;
    }

    const category: CandyCategory =
      (editValues.category as CandyCategory) ?? rowOriginal.category;

    const providerPriceNum = Number(
      editValues.providerPrice ?? rowOriginal.providerPrice ?? 0
    );
    const packagesNum = Number(
      editValues.packages ?? rowOriginal.packages ?? 0
    );
    const unitsPerPackageNum = Number(
      editValues.unitsPerPackage ?? rowOriginal.unitsPerPackage ?? 0
    );
    const subtotalNum = Number(
      editValues.subtotal ?? rowOriginal.subtotal ?? 0
    );
    const totalRivasNum = Number(
      editValues.totalRivas ?? rowOriginal.totalRivas ?? 0
    );
    const totalSanJorgeNum = Number(
      editValues.totalSanJorge ?? rowOriginal.totalSanJorge ?? 0
    );
    const totalIslaNum = Number(
      editValues.totalIsla ?? rowOriginal.totalIsla ?? 0
    );
    const gainRivasNum = Number(
      editValues.gainRivas ?? rowOriginal.gainRivas ?? 0
    );
    const gainSanJorgeNum = Number(
      editValues.gainSanJorge ?? rowOriginal.gainSanJorge ?? 0
    );
    const gainIslaNum = Number(
      editValues.gainIsla ?? rowOriginal.gainIsla ?? 0
    );
    const unitPriceRivasNum = Number(
      editValues.unitPriceRivas ?? rowOriginal.unitPriceRivas ?? 0
    );
    const unitPriceSanJorgeNum = Number(
      editValues.unitPriceSanJorge ?? rowOriginal.unitPriceSanJorge ?? 0
    );
    const unitPriceIslaNum = Number(
      editValues.unitPriceIsla ?? rowOriginal.unitPriceIsla ?? 0
    );
    const inventoryDateStr = (
      editValues.inventoryDate ??
      rowOriginal.inventoryDate ??
      ""
    ).toString();

    if (providerPriceNum < 0) {
      setMsg("El precio proveedor no puede ser negativo.");
      return;
    }
    if (packagesNum < 0) {
      setMsg("Los paquetes deben ser 0 o más.");
      return;
    }
    if (unitsPerPackageNum <= 0) {
      setMsg("Las unidades por paquete deben ser mayor que 0.");
      return;
    }

    try {
      await updateDoc(doc(db, "products_candies", editingId), {
        name,
        category,
        providerPrice: providerPriceNum,
        packages: packagesNum,
        unitsPerPackage: unitsPerPackageNum,
        subtotal: subtotalNum,
        totalRivas: totalRivasNum,
        totalSanJorge: totalSanJorgeNum,
        totalIsla: totalIslaNum,
        gainRivas: gainRivasNum,
        gainSanJorge: gainSanJorgeNum,
        gainIsla: gainIslaNum,
        unitPriceRivas: unitPriceRivasNum,
        unitPriceSanJorge: unitPriceSanJorgeNum,
        unitPriceIsla: unitPriceIslaNum,
        inventoryDate: inventoryDateStr,
      });

      setRows((prev) =>
        prev.map((r) =>
          r.id === editingId
            ? {
                ...r,
                name,
                category,
                providerPrice: providerPriceNum,
                packages: packagesNum,
                unitsPerPackage: unitsPerPackageNum,
                subtotal: subtotalNum,
                totalRivas: totalRivasNum,
                totalSanJorge: totalSanJorgeNum,
                totalIsla: totalIslaNum,
                gainRivas: gainRivasNum,
                gainSanJorge: gainSanJorgeNum,
                gainIsla: gainIslaNum,
                unitPriceRivas: unitPriceRivasNum,
                unitPriceSanJorge: unitPriceSanJorgeNum,
                unitPriceIsla: unitPriceIslaNum,
                inventoryDate: inventoryDateStr,
              }
            : r
        )
      );

      setMsg("✅ Producto actualizado");
      cancelEdit();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al actualizar producto");
    }
  };

  // ====== CÁLCULOS MEMO (crear) ======
  const {
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
  } = useMemo(() => {
    const providerPriceNum = Number(providerPrice || 0);
    const packagesNum = Number(packages || 0);

    const subtotalCalc = providerPriceNum * packagesNum;

    const totalR = packagesNum > 0 ? subtotalCalc / 0.75 : 0; // Total Rivas
    const totalSJ = packagesNum > 0 ? subtotalCalc / 0.75 : 0; // Total San Jorge
    const totalIO = packagesNum > 0 ? subtotalCalc / 0.7 : 0; // Total Isla

    const gainR = totalR - subtotalCalc;
    const gainSJ = totalSJ - subtotalCalc;
    const gainIO = totalIO - subtotalCalc;

    const unitR = packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0;
    const unitSJ = packagesNum > 0 ? roundToInt(totalSJ / packagesNum) : 0;
    const unitIO = packagesNum > 0 ? roundToInt(totalIO / packagesNum) : 0;

    return {
      subtotal: subtotalCalc,
      totalRivas: totalR,
      totalSanJorge: totalSJ,
      totalIsla: totalIO,
      gainRivas: gainR,
      gainSanJorge: gainSJ,
      gainIsla: gainIO,
      unitPriceRivas: unitR,
      unitPriceSanJorge: unitSJ,
      unitPriceIsla: unitIO,
    };
  }, [providerPrice, packages]);

  // ====== KPIs (lista de productos) ======
  const kpis = useMemo(() => {
    const totalProducts = rows.length;
    let totalPackages = 0;
    let totalUnits = 0;
    let totalSubtotal = 0;
    let totalTotalRivas = 0;
    let totalTotalSanJorge = 0;
    let totalTotalIsla = 0;

    for (const r of rows) {
      totalPackages += r.packages;
      totalUnits += r.packages * r.unitsPerPackage;
      totalSubtotal += r.subtotal;
      totalTotalRivas += r.totalRivas;
      totalTotalSanJorge += r.totalSanJorge;
      totalTotalIsla += r.totalIsla;
    }

    return {
      totalProducts,
      totalPackages,
      totalUnits,
      totalSubtotal,
      totalTotalRivas,
      totalTotalSanJorge,
      totalTotalIsla,
    };
  }, [rows]);

  // ====== LOAD LISTA ======
  useEffect(() => {
    (async () => {
      setLoading(true);
      const qP = query(
        collection(db, "products_candies"),
        orderBy("createdAt", "desc")
      );
      const snap = await getDocs(qP);
      const list: CandyRow[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          name: x.name ?? "",
          category: (x.category as CandyCategory) ?? "Caramelo",
          providerPrice: Number(x.providerPrice ?? 0),
          packages: Number(x.packages ?? 0),
          unitsPerPackage: Number(x.unitsPerPackage ?? 0),
          subtotal: Number(x.subtotal ?? 0),
          totalRivas: Number(x.totalRivas ?? 0),
          totalSanJorge: Number(x.totalSanJorge ?? 0),
          totalIsla: Number(x.totalIsla ?? 0),
          gainRivas: Number(x.gainRivas ?? 0),
          gainSanJorge: Number(x.gainSanJorge ?? 0),
          gainIsla: Number(x.gainIsla ?? 0),
          unitPriceRivas: Number(x.unitPriceRivas ?? 0),
          unitPriceSanJorge: Number(x.unitPriceSanJorge ?? 0),
          unitPriceIsla: Number(x.unitPriceIsla ?? 0),
          inventoryDate: x.inventoryDate ?? "",
          createdAt: x.createdAt ?? Timestamp.now(),
        });
      });
      setRows(list);
      setLoading(false);
    })();
  }, [refreshKey]);

  const resetForm = () => {
    setCategory("Caramelo");
    setProductName("");
    setProviderPrice("");
    setPackages("0");
    setUnitsPerPackage("1");
    setInventoryDate("");
  };

  // ====== HANDLE CREATE ======
  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!productName.trim()) {
      setMsg("Ingresa el nombre del producto.");
      return;
    }

    const providerPriceNum = Number(providerPrice || 0);
    const packagesNum = Number(packages || 0);
    const unitsPerPackageNum = Number(unitsPerPackage || 0);

    if (providerPriceNum < 0) {
      setMsg("El precio proveedor no puede ser negativo.");
      return;
    }
    if (packagesNum < 0) {
      setMsg("Los paquetes deben ser 0 o más.");
      return;
    }
    if (unitsPerPackageNum <= 0) {
      setMsg("Las unidades por paquete deben ser mayor que 0.");
      return;
    }

    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const dateStr = inventoryDate || todayStr;

      // Crear PRODUCTO en products_candies (YA NO CREA INVENTARIO AQUÍ)
      const productDoc = {
        name: productName.trim(),
        category,
        providerPrice: providerPriceNum,
        packages: packagesNum,
        unitsPerPackage: unitsPerPackageNum,
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
        inventoryDate: dateStr,
        createdAt: Timestamp.now(),
      };

      const ref = await addDoc(collection(db, "products_candies"), productDoc);

      setRows((prev) => [
        {
          id: ref.id,
          ...productDoc,
        },
        ...prev,
      ]);

      setMsg("✅ Producto de dulces creado.");
      resetForm();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al crear producto de dulces");
    }
  };

  // ====== DELETE ======
  const handleDelete = async (row: CandyRow) => {
    const ok = confirm(`¿Eliminar el producto "${row.name}"?`);
    if (!ok) return;
    await deleteDoc(doc(db, "products_candies", row.id));
    setRows((prev) => prev.filter((x) => x.id !== row.id));
  };

  // Helper para tomar valores en modo edición
  const getEdit = (field: keyof CandyRow, fallback: any) => {
    if (!editValues) return fallback;
    const v = (editValues as any)[field];
    return v ?? fallback;
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Productos</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700"
            onClick={() => setOpenForm(true)}
          >
            <span className="inline-block bg-green-700/40 rounded-full p-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </span>
            Nuevo producto
          </button>
        </div>
      </div>

      {/* KPIs ARRIBA DE LA TABLA */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-2 mb-3 text-xs md:text-sm">
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total productos</div>
          <div>{kpis.totalProducts}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total paquetes</div>
          <div>{kpis.totalPackages}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total unidades</div>
          <div>{kpis.totalUnits}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Subtotal proveedor</div>
          <div>{kpis.totalSubtotal.toFixed(2)}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total Rivas</div>
          <div>{kpis.totalTotalRivas.toFixed(2)}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total San Jorge</div>
          <div>{kpis.totalTotalSanJorge.toFixed(2)}</div>
        </div>
        <div className="bg-gray-100 p-2 rounded border">
          <div className="font-semibold">Total Isla</div>
          <div>{kpis.totalTotalIsla.toFixed(2)}</div>
        </div>
      </div>

      {/* MODAL NUEVO PRODUCTO */}
      {openForm && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-3xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4">Nuevo producto de dulces</h3>
            <form
              onSubmit={handleCreate}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              {/* Categoría */}
              <div>
                <label className="block text-sm font-semibold">Categoría</label>
                <select
                  className="w-full border p-2 rounded"
                  value={category}
                  onChange={(e) => setCategory(e.target.value as CandyCategory)}
                >
                  {CANDY_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              {/* Producto */}
              <div>
                <label className="block text-sm font-semibold">Producto</label>
                <input
                  className="w-full border p-2 rounded"
                  value={productName}
                  onChange={(e) => setProductName(e.target.value)}
                  placeholder="Ej: Chicles menta"
                />
              </div>

              {/* Precio Proveedor */}
              <div>
                <label className="block text-sm font-semibold">
                  Precio Proveedor
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="number"
                  step="0.01"
                  min={0}
                  value={providerPrice}
                  onChange={(e) => setProviderPrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>

              {/* Paquetes */}
              <div>
                <label className="block text-sm font-semibold">Paquetes</label>
                <input
                  className="w-full border p-2 rounded"
                  type="number"
                  min={0}
                  value={packages}
                  onChange={(e) => setPackages(e.target.value)}
                  placeholder="0"
                />
              </div>

              {/* Unidades por paquete */}
              <div>
                <label className="block text-sm font-semibold">
                  Unidades por paquete
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="number"
                  min={1}
                  value={unitsPerPackage}
                  onChange={(e) => setUnitsPerPackage(e.target.value)}
                  placeholder="Ej: 10"
                />
              </div>

              {/* Fecha inventario */}
              <div>
                <label className="block text-sm font-semibold">
                  Fecha inventario
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="date"
                  value={inventoryDate}
                  onChange={(e) => setInventoryDate(e.target.value)}
                />
              </div>

              {/* Subtotal (auto) */}
              <div>
                <label className="block text-sm font-semibold">
                  Subtotal (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(subtotal) ? "" : subtotal.toFixed(2)}
                />
              </div>

              {/* Total Rivas */}
              <div>
                <label className="block text-sm font-semibold">
                  Total Rivas (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(totalRivas) ? "" : totalRivas.toFixed(2)}
                />
              </div>

              {/* Total San Jorge */}
              <div>
                <label className="block text-sm font-semibold">
                  Total San Jorge (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(totalSanJorge) ? "" : totalSanJorge.toFixed(2)}
                />
              </div>

              {/* Total Isla */}
              <div>
                <label className="block text-sm font-semibold">
                  Total Isla (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(totalIsla) ? "" : totalIsla.toFixed(2)}
                />
              </div>

              {/* G. Paquete R */}
              <div>
                <label className="block text-sm font-semibold">
                  Ganancia Paquete Rivas (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(gainRivas) ? "" : gainRivas.toFixed(2)}
                />
              </div>

              {/* G. Paquete SJ */}
              <div>
                <label className="block text-sm font-semibold">
                  Ganancia Paquete San Jorge (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(gainSanJorge) ? "" : gainSanJorge.toFixed(2)}
                />
              </div>

              {/* G. Paquete IO */}
              <div>
                <label className="block text-sm font-semibold">
                  Ganancia Paquete Isla (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={isNaN(gainIsla) ? "" : gainIsla.toFixed(2)}
                />
              </div>

              {/* P. Unidad R */}
              <div>
                <label className="block text-sm font-semibold">
                  Precio Unidad Rivas (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={
                    unitPriceRivas || unitPriceRivas === 0 ? unitPriceRivas : ""
                  }
                />
              </div>

              {/* P. Unidad SJ */}
              <div>
                <label className="block text-sm font-semibold">
                  Precio Unidad San Jorge (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={
                    unitPriceSanJorge || unitPriceSanJorge === 0
                      ? unitPriceSanJorge
                      : ""
                  }
                />
              </div>

              {/* P. Unidad IO */}
              <div>
                <label className="block text-sm font-semibold">
                  Precio Unidad Isla (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  readOnly
                  value={
                    unitPriceIsla || unitPriceIsla === 0 ? unitPriceIsla : ""
                  }
                />
              </div>

              {/* Botones */}
              <div className="md:col-span-2 flex justify-end gap-2 mt-2">
                <button
                  type="button"
                  onClick={resetForm}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Limpiar
                </button>
                <button
                  type="button"
                  onClick={() => setOpenForm(false)}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                >
                  Guardar
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* TABLA (más ancha, sin wrap) */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto">
        <table className="min-w-[1600px] text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border whitespace-nowrap">Fecha</th>
              <th className="p-2 border whitespace-nowrap">Categoría</th>
              <th className="p-2 border whitespace-nowrap">Producto</th>
              <th className="p-2 border whitespace-nowrap">Precio Proveedor</th>
              <th className="p-2 border whitespace-nowrap">Paquetes/Bolsas</th>
              <th className="p-2 border whitespace-nowrap">Und x Paquetes</th>
              <th className="p-2 border whitespace-nowrap">Subtotal</th>
              <th className="p-2 border whitespace-nowrap">Total Rivas</th>
              <th className="p-2 border whitespace-nowrap">Total San Jorge</th>
              <th className="p-2 border whitespace-nowrap">Total Isla</th>
              <th className="p-2 border whitespace-nowrap">Ganancia Rivas</th>
              <th className="p-2 border whitespace-nowrap">
                Ganancia San Jorge
              </th>
              <th className="p-2 border whitespace-nowrap">Ganancia Isla</th>
              <th className="p-2 border whitespace-nowrap">Precio Rivas</th>
              <th className="p-2 border whitespace-nowrap">Precio San Jorge</th>
              <th className="p-2 border whitespace-nowrap">Precio Isla</th>
              <th className="p-2 border whitespace-nowrap">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={17} className="p-4 text-center whitespace-nowrap">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={17} className="p-4 text-center whitespace-nowrap">
                  Sin productos
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const isEditing = editingId === r.id;
                return (
                  <tr key={r.id} className="text-center whitespace-nowrap">
                    {/* Fecha */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="date"
                          className="border p-1 rounded text-xs"
                          value={
                            getEdit(
                              "inventoryDate",
                              r.inventoryDate ||
                                (r.createdAt?.toDate
                                  ? r.createdAt
                                      .toDate()
                                      .toISOString()
                                      .slice(0, 10)
                                  : "")
                            ) || ""
                          }
                          onChange={(e) =>
                            handleEditChange("inventoryDate", e.target.value)
                          }
                        />
                      ) : (
                        r.inventoryDate ||
                        (r.createdAt?.toDate
                          ? r.createdAt.toDate().toISOString().slice(0, 10)
                          : "—")
                      )}
                    </td>

                    {/* Categoría */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <select
                          className="border p-1 rounded text-xs"
                          value={getEdit("category", r.category) as string}
                          onChange={(e) =>
                            handleEditChange(
                              "category",
                              e.target.value as CandyCategory
                            )
                          }
                        >
                          {CANDY_CATEGORIES.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))}
                        </select>
                      ) : (
                        r.category
                      )}
                    </td>

                    {/* Producto */}
                    <td className="p-2 border whitespace-nowrap max-w-xs">
                      {isEditing ? (
                        <input
                          className="border p-1 rounded text-xs w-full"
                          value={getEdit("name", r.name) as string}
                          onChange={(e) =>
                            handleEditChange("name", e.target.value)
                          }
                        />
                      ) : (
                        r.name
                      )}
                    </td>

                    {/* Precio Proveedor */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("providerPrice", r.providerPrice)}
                          onChange={(e) =>
                            handleEditChange("providerPrice", e.target.value)
                          }
                        />
                      ) : (
                        r.providerPrice.toFixed(2)
                      )}
                    </td>

                    {/* Paquetes */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("packages", r.packages)}
                          onChange={(e) =>
                            handleEditChange("packages", e.target.value)
                          }
                        />
                      ) : (
                        r.packages
                      )}
                    </td>

                    {/* Und x Paq */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("unitsPerPackage", r.unitsPerPackage)}
                          onChange={(e) =>
                            handleEditChange("unitsPerPackage", e.target.value)
                          }
                        />
                      ) : (
                        r.unitsPerPackage
                      )}
                    </td>

                    {/* Subtotal */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("subtotal", r.subtotal)}
                          onChange={(e) =>
                            handleEditChange("subtotal", e.target.value)
                          }
                        />
                      ) : (
                        r.subtotal.toFixed(2)
                      )}
                    </td>

                    {/* Total Rivas */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("totalRivas", r.totalRivas)}
                          onChange={(e) =>
                            handleEditChange("totalRivas", e.target.value)
                          }
                        />
                      ) : (
                        r.totalRivas.toFixed(2)
                      )}
                    </td>

                    {/* Total SJ */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("totalSanJorge", r.totalSanJorge)}
                          onChange={(e) =>
                            handleEditChange("totalSanJorge", e.target.value)
                          }
                        />
                      ) : (
                        r.totalSanJorge.toFixed(2)
                      )}
                    </td>

                    {/* Total Isla */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("totalIsla", r.totalIsla)}
                          onChange={(e) =>
                            handleEditChange("totalIsla", e.target.value)
                          }
                        />
                      ) : (
                        r.totalIsla.toFixed(2)
                      )}
                    </td>

                    {/* G. R */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("gainRivas", r.gainRivas)}
                          onChange={(e) =>
                            handleEditChange("gainRivas", e.target.value)
                          }
                        />
                      ) : (
                        r.gainRivas.toFixed(2)
                      )}
                    </td>

                    {/* G. SJ */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("gainSanJorge", r.gainSanJorge)}
                          onChange={(e) =>
                            handleEditChange("gainSanJorge", e.target.value)
                          }
                        />
                      ) : (
                        r.gainSanJorge.toFixed(2)
                      )}
                    </td>

                    {/* G. IO */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("gainIsla", r.gainIsla)}
                          onChange={(e) =>
                            handleEditChange("gainIsla", e.target.value)
                          }
                        />
                      ) : (
                        r.gainIsla.toFixed(2)
                      )}
                    </td>

                    {/* P. U R */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("unitPriceRivas", r.unitPriceRivas)}
                          onChange={(e) =>
                            handleEditChange("unitPriceRivas", e.target.value)
                          }
                        />
                      ) : (
                        r.unitPriceRivas
                      )}
                    </td>

                    {/* P. U SJ */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit(
                            "unitPriceSanJorge",
                            r.unitPriceSanJorge
                          )}
                          onChange={(e) =>
                            handleEditChange(
                              "unitPriceSanJorge",
                              e.target.value
                            )
                          }
                        />
                      ) : (
                        r.unitPriceSanJorge
                      )}
                    </td>

                    {/* P. U IO */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <input
                          type="number"
                          className="border p-1 rounded text-right text-xs"
                          value={getEdit("unitPriceIsla", r.unitPriceIsla)}
                          onChange={(e) =>
                            handleEditChange("unitPriceIsla", e.target.value)
                          }
                        />
                      ) : (
                        r.unitPriceIsla
                      )}
                    </td>

                    {/* Acciones */}
                    <td className="p-2 border whitespace-nowrap">
                      {isEditing ? (
                        <div className="flex gap-1 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                            onClick={saveEdit}
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                            onClick={cancelEdit}
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-1 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-yellow-500 text-white hover:bg-yellow-600 text-xs"
                            onClick={() => startEdit(r)}
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                            onClick={() => handleDelete(r)}
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

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
