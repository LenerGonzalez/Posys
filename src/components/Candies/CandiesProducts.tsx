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
} from "firebase/firestore";
import { db } from "../../firebase";

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
  // ====== STATE FORM ======
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

  // ====== CÁLCULOS MEMO ======
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

    const totalR = packagesNum > 0 ? subtotalCalc / 0.8 : 0; // Total Rivas
    const totalSJ = packagesNum > 0 ? subtotalCalc / 0.85 : 0; // Total San Jorge
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

      // 1) Crear PRODUCTO en products_candies
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

      // 2) Crear INVENTARIO (lote) solo si hay paquetes
      if (packagesNum > 0) {
        const totalUnits = packagesNum * unitsPerPackageNum;

        await addDoc(collection(db, "inventory_candies"), {
          productId: ref.id,
          productName: productName.trim(),
          category,
          // Info de stock
          measurement: "unidad",
          quantity: totalUnits,
          remaining: totalUnits,
          packages: packagesNum,
          unitsPerPackage: unitsPerPackageNum,
          totalUnits,
          // Info económica
          providerPrice: providerPriceNum,
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
          // Fecha
          date: dateStr,
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
        });
      }

      setMsg(
        packagesNum > 0
          ? "✅ Producto de dulces creado y lote de inventario registrado."
          : "✅ Producto de dulces creado (sin inventario, paquetes = 0)."
      );
      resetForm();
      // Si querés cerrar el modal después de guardar, descomenta:
      // setOpenForm(false);
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

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Productos de Dulces</h2>
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

      {/* MODAL */}
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
                  G. Paquete R (auto)
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
                  G. Paquete SJ (auto)
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
                  G. Paquete IO (auto)
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
                  P. Unidad R (auto)
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
                  P. Unidad SJ (auto)
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
                  P. Unidad IO (auto)
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

      {/* TABLA */}
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Producto</th>
              <th className="p-2 border">Precio Prov.</th>
              <th className="p-2 border">Paquetes</th>
              <th className="p-2 border">Und x Paq.</th>
              <th className="p-2 border">Subtotal</th>
              <th className="p-2 border">Total Rivas</th>
              <th className="p-2 border">Total SJ</th>
              <th className="p-2 border">Total Isla</th>
              <th className="p-2 border">G. R</th>
              <th className="p-2 border">G. SJ</th>
              <th className="p-2 border">G. IO</th>
              <th className="p-2 border">P. U R</th>
              <th className="p-2 border">P. U SJ</th>
              <th className="p-2 border">P. U IO</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={17} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={17} className="p-4 text-center">
                  Sin productos
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="text-center">
                  <td className="p-2 border">
                    {r.inventoryDate ||
                      (r.createdAt?.toDate
                        ? r.createdAt.toDate().toISOString().slice(0, 10)
                        : "—")}
                  </td>
                  <td className="p-2 border">{r.category}</td>
                  <td className="p-2 border">{r.name}</td>
                  <td className="p-2 border">{r.providerPrice.toFixed(2)}</td>
                  <td className="p-2 border">{r.packages}</td>
                  <td className="p-2 border">{r.unitsPerPackage}</td>
                  <td className="p-2 border">{r.subtotal.toFixed(2)}</td>
                  <td className="p-2 border">{r.totalRivas.toFixed(2)}</td>
                  <td className="p-2 border">{r.totalSanJorge.toFixed(2)}</td>
                  <td className="p-2 border">{r.totalIsla.toFixed(2)}</td>
                  <td className="p-2 border">{r.gainRivas.toFixed(2)}</td>
                  <td className="p-2 border">{r.gainSanJorge.toFixed(2)}</td>
                  <td className="p-2 border">{r.gainIsla.toFixed(2)}</td>
                  <td className="p-2 border">{r.unitPriceRivas}</td>
                  <td className="p-2 border">{r.unitPriceSanJorge}</td>
                  <td className="p-2 border">{r.unitPriceIsla}</td>
                  <td className="p-2 border">
                    <button
                      className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                      onClick={() => handleDelete(r)}
                    >
                      Borrar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
