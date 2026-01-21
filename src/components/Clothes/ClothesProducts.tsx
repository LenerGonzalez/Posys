// src/components/Clothes/ProductsClothes.tsx
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
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

// ====== Catálogos ======
const SUBCATS = [
  "Camisa",
  "Blusa",
  "Vestido",
  "Jean",
  "Pantalón",
  "Short",
  "Falda",
  "Conjunto",
  "Abrigo",
  "Suéter",
  "Accesorio",
];
const COLORS = [
  "Negro",
  "Blanco",
  "Azul",
  "Rojo",
  "Verde",
  "Gris",
  "Beige",
  "Rosa",
  "Amarillo",
  "Marrón",
  "Morado",
  "Naranja",
];
const SIZES_ADULT = ["XS", "S", "M", "L", "XL", "2XL"];
const SIZES_KIDS = ["2", "4", "6", "8", "10", "12", "14"];
const SIZES_JEANS = ["26", "28", "30", "32", "34", "36", "38"];
const BRANDS = ["Shein", "Usado", "Otro"] as const;
const GENDERS = ["", "HOMBRE", "MUJER", "NINO", "NINA", "UNISEX"] as const;

type Brand = (typeof BRANDS)[number];
type Gender = (typeof GENDERS)[number];

// ====== Helpers ======
function norm(token?: string) {
  return (token || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "");
}
function abrevGenero(g?: string) {
  switch ((g || "").toUpperCase()) {
    case "HOMBRE":
      return "HOM";
    case "MUJER":
      return "MUJ";
    case "NINO":
      return "NIN";
    case "NINA":
      return "NIA";
    case "UNISEX":
      return "UNI";
    default:
      return "GEN";
  }
}
function generarSKU(parts: {
  subcat?: string;
  gender?: string;
  color?: string;
  size?: string;
  brand?: string;
}) {
  const prefix = "ROP";
  const sub = norm(parts.subcat).slice(0, 3) || "GEN";
  const gen = abrevGenero(parts.gender);
  const col = norm(parts.color).slice(0, 3) || "COL";
  const siz = norm(parts.size) || "TLL";
  const brd = norm(parts.brand).slice(0, 4) || "BRD";
  return `${prefix}-${sub}-${gen}-${col}-${siz}-${brd}`;
}
const CLIENT_CODE_RE = /^[A-Za-z0-9._-]{0,32}$/;

interface ProductRow {
  id: string;
  name: string;
  category: string;
  measurement: string;
  sku: string;
  size?: string;
  color?: string;
  brand?: string;
  gender?: Gender;
  clientCode?: string;
  notes?: string;
  createdAt: Timestamp;
}

export default function ProductsClothes() {
  // form state
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("Camisa");
  const [size, setSize] = useState("");
  const [color, setColor] = useState("");
  const [brand, setBrand] = useState<Brand>("Shein");
  const [gender, setGender] = useState<Gender>("");
  const [clientCode, setClientCode] = useState("");
  const [sku, setSku] = useState("");
  const [notes, setNotes] = useState("");

  // [ADD] Campos NUEVOS para crear lote desde aquí
  const [salePrice, setSalePrice] = useState<string>(""); // precio de venta (producto y lote)
  const [quantity, setQuantity] = useState<string>("0"); // cantidad de piezas
  const [batchDate, setBatchDate] = useState<string>(""); // yyyy-MM-dd
  const [lotNotes, setLotNotes] = useState<string>(""); // notas del lote (NO toca tus notes del producto)

  // [ADD] Total esperado auto (solo visual y para guardar en lote)
  const expectedTotal = useMemo(() => {
    const q = Number(quantity || 0);
    const p = Number(salePrice || 0);
    return Math.floor(q * p * 100) / 100;
  }, [quantity, salePrice]);

  // lista
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const { refreshKey, refresh } = useManualRefresh();

  // modal
  const [openForm, setOpenForm] = useState(false);

  // opciones talla
  const sizeOptions = useMemo(() => {
    if (category.toLowerCase() === "jean") return SIZES_JEANS;
    if (gender === "NINO" || gender === "NINA") return SIZES_KIDS;
    return SIZES_ADULT;
  }, [category, gender]);

  useEffect(() => {
    setSku(generarSKU({ subcat: category, gender, color, size, brand }));
  }, [category, gender, color, size, brand]);

  // load lista
  useEffect(() => {
    (async () => {
      setLoading(true);
      const qP = query(
        collection(db, "products_clothes"),
        orderBy("createdAt", "desc"),
      );
      const snap = await getDocs(qP);
      const list: ProductRow[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          name: x.name ?? "(sin nombre)",
          category: x.category ?? "",
          measurement: x.measurement ?? "unidad",
          sku: x.sku ?? "",
          size: x.size || "",
          color: x.color || "",
          brand: x.brand || "",
          gender: x.gender || "",
          clientCode: x.clientCode || "",
          notes: x.notes || "",
          createdAt: x.createdAt ?? Timestamp.now(),
        });
      });
      setRows(list);
      setLoading(false);
    })();
  }, [refreshKey]);

  const resetForm = () => {
    setName("");
    setCategory("Camisa");
    setSize("");
    setColor("");
    setBrand("Shein");
    setGender("");
    setClientCode("");
    setNotes("");
    // [ADD] limpiar campos nuevos
    setSalePrice("");
    setQuantity("0");
    setBatchDate("");
    setLotNotes("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    if (!name.trim()) {
      setMsg("Ingresa el nombre del producto.");
      return;
    }
    if (clientCode && !CLIENT_CODE_RE.test(clientCode)) {
      setMsg("Código del cliente inválido");
      return;
    }
    // [ADD] Validaciones suaves para los nuevos campos (no bloquean crear solo producto)
    const quantityNum = Number(quantity || 0);
    const salePriceNum = Number(salePrice || 0);
    if (quantityNum < 0) {
      setMsg("La cantidad de piezas debe ser 0 o mayor.");
      return;
    }
    if (salePriceNum < 0) {
      setMsg("El precio de venta no puede ser negativo.");
      return;
    }

    try {
      // 1) Crear PRODUCTO (mantengo TODO tu flujo + agrego price)
      const ref = await addDoc(collection(db, "products_clothes"), {
        name: name.trim(),
        category,
        measurement: "unidad",
        sku,
        size: size || "",
        color: color || "",
        brand: brand || "",
        gender: gender || "",
        clientCode: clientCode || "",
        notes: notes || "",
        createdAt: Timestamp.now(),
        // [ADD] guardo precio de venta en el producto para que lo lean otros módulos
        price: salePriceNum || 0,
      });

      setRows((prev) => [
        {
          id: ref.id,
          name: name.trim(),
          category,
          measurement: "unidad",
          sku,
          size: size || "",
          color: color || "",
          brand: brand || "",
          gender: gender || "",
          clientCode: clientCode || "",
          notes: notes || "",
          createdAt: Timestamp.now(),
        },
        ...prev,
      ]);

      // 2) [ADD] Crear LOTE si quantity > 0 (NO toco tu SKU ni lógicas existentes)
      if (quantityNum > 0) {
        const todayStr = new Date().toISOString().slice(0, 10);
        const dateStr = batchDate ? batchDate : todayStr;

        await addDoc(collection(db, "inventory_clothes_batches"), {
          productId: ref.id,
          productName: name.trim(),
          category,
          unit: "unidad",
          quantity: quantityNum,
          remaining: quantityNum,
          purchasePrice: 0, // sin costo por ahora
          salePrice: salePriceNum || 0, // referencia al crear lote
          invoiceTotal: 0, // sin costo
          expectedTotal: expectedTotal || 0,
          date: dateStr, // yyyy-MM-dd
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
          // extras existentes en Inventario
          notes: lotNotes || "",
          sku: sku || "",
          size: size || "",
          color: color || "",
          gender: gender || "",
          brand: brand || "",
          clientCode: clientCode || "",
        });
      }

      setMsg(
        quantityNum > 0
          ? "✅ Producto creado y lote de inventario registrado"
          : "✅ Producto de ropa creado",
      );
      // [ADD] no cierro el modal si quieres seguir creando; si prefieres cerrarlo, descomenta:
      // setOpenForm(false);
      resetForm();
      // opcional: refrescar lista externa
      // refresh();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al crear producto");
    }
  };

  const handleDelete = async (row: ProductRow) => {
    const ok = confirm(`¿Eliminar el producto "${row.name}"?`);
    if (!ok) return;
    await deleteDoc(doc(db, "products_clothes", row.id));
    setRows((prev) => prev.filter((x) => x.id !== row.id));
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Productos de Ropa</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700"
            onClick={() => {
              setOpenForm(true);
            }}
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
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-xl font-bold mb-4">Nuevo producto de ropa</h3>
            <form
              onSubmit={handleCreate}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              <div>
                <label className="block text-sm font-semibold">Nombre</label>
                <input
                  className="w-full border p-2 rounded"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Blusa floral"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Subcategoría
                </label>
                <select
                  className="w-full border p-2 rounded"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                >
                  {SUBCATS.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Género</label>
                <select
                  className="w-full border p-2 rounded"
                  value={gender}
                  onChange={(e) => setGender(e.target.value as Gender)}
                >
                  {GENDERS.map((g) => (
                    <option key={g} value={g}>
                      {g || "—"}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Talla</label>
                <select
                  className="w-full border p-2 rounded"
                  value={size}
                  onChange={(e) => setSize(e.target.value)}
                >
                  <option value="">—</option>
                  {sizeOptions.map((s) => (
                    <option key={s} value={s}>
                      {s}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Color</label>
                <select
                  className="w-full border p-2 rounded"
                  value={color}
                  onChange={(e) => setColor(e.target.value)}
                >
                  <option value="">—</option>
                  {COLORS.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Marca</label>
                <select
                  className="w-full border p-2 rounded"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value as Brand)}
                >
                  {BRANDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  SKU (auto)
                </label>
                <input
                  className="w-full border p-2 rounded bg-gray-100"
                  value={sku}
                  readOnly
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Código cliente
                </label>
                <input
                  className="w-full border p-2 rounded"
                  value={clientCode}
                  onChange={(e) => setClientCode(e.target.value)}
                />
              </div>

              {/* ====== CAMPOS NUEVOS PARA LOTE ====== */}
              <div>
                <label className="block text-sm font-semibold">
                  Precio de venta (pza)
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="number"
                  step="0.01"
                  min={0}
                  value={salePrice}
                  onChange={(e) => setSalePrice(e.target.value)}
                  placeholder="0.00"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Cantidad de piezas (crea lote si &gt; 0)
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="number"
                  min={0}
                  value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                  placeholder="0"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Fecha de lote
                </label>
                <input
                  className="w-full border p-2 rounded"
                  type="date"
                  value={batchDate}
                  onChange={(e) => setBatchDate(e.target.value)}
                />
              </div>
              {/* <div className="md:col-span-2">
                <label className="block text-sm font-semibold">
                  Notas del lote
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-20"
                  value={lotNotes}
                  onChange={(e) => setLotNotes(e.target.value)}
                  placeholder="Observaciones específicas del lote (opcional)"
                  maxLength={500}
                />
              </div> */}
              {/* ====== FIN CAMPOS NUEVOS ====== */}

              {/* <div className="md:col-span-2">
                <label className="block text-sm font-semibold">
                  Comentario
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-24"
                  value={notes}
                  onChange={(e) => setNotes(e.target.value)}
                  maxLength={500}
                />
              </div> */}

              {/* [ADD] Línea de totales visual */}
              <div className="md:col-span-2 flex items-center justify-between border-t pt-3 mt-2 text-sm">
                <div>
                  <span className="font-semibold">Medición:</span> unidad
                </div>
                <div>
                  <span className="font-semibold">Total esperado (auto): </span>
                  {isNaN(expectedTotal) ? "—" : expectedTotal.toFixed(2)}
                </div>
              </div>

              <div className="md:col-span-2 flex justify-end gap-2 mt-2">
                {/* [ADD] Botón Limpiar */}
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

      {/* tabla */}
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Subcat.</th>
              <th className="p-2 border">Nombre</th>
              <th className="p-2 border">SKU</th>
              <th className="p-2 border">Talla</th>
              <th className="p-2 border">Color</th>
              <th className="p-2 border">Marca</th>
              <th className="p-2 border">Género</th>
              <th className="p-2 border">Código Cliente</th>
              <th className="p-2 border">Comentario</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={11} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td colSpan={11} className="p-4 text-center">
                  Sin productos
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.id} className="text-center">
                  <td className="p-2 border">
                    {r.createdAt?.toDate
                      ? r.createdAt.toDate().toISOString().slice(0, 10)
                      : "—"}
                  </td>
                  <td className="p-2 border">{r.category}</td>
                  <td className="p-2 border">{r.name}</td>
                  <td className="p-2 border">{r.sku}</td>
                  <td className="p-2 border">{r.size || "—"}</td>
                  <td className="p-2 border">{r.color || "—"}</td>
                  <td className="p-2 border">{r.brand || "—"}</td>
                  <td className="p-2 border">{r.gender || "—"}</td>
                  <td className="p-2 border">{r.clientCode || "—"}</td>
                  <td className="p-2 border">{r.notes || "—"}</td>
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
