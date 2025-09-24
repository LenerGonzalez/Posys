// src/components/ProductsClothes.tsx
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

// ====== Catálogos (puedes ampliarlos cuando quieras) ======
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
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

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
  // 🔵 SIN sufijo aleatorio: SKU estable igual al del producto
  return `${prefix}-${sub}-${gen}-${col}-${siz}-${brd}`;
}

// Código del cliente (opcional) A–Z 0–9 . _ -
const CLIENT_CODE_RE = /^[A-Za-z0-9._-]{0,32}$/;

// ====== Tipos ======
interface ProductRow {
  id: string;
  name: string;
  category: string; // subcategoría
  measurement: string; // "unidad"
  // Campos de ropa
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
  // ---- Formulario (campos en rojo) ----
  const [name, setName] = useState("");
  const [category, setCategory] = useState<string>("Camisa"); // subcategoría
  const [size, setSize] = useState<string>("");
  const [color, setColor] = useState<string>("");
  const [brand, setBrand] = useState<Brand>("Shein");
  const [gender, setGender] = useState<Gender>("");
  const [clientCode, setClientCode] = useState<string>("");
  const [sku, setSku] = useState<string>("");
  const [notes, setNotes] = useState<string>("");

  // Lista
  const [rows, setRows] = useState<ProductRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Tallas sugeridas según subcat/género
  const sizeOptions = useMemo(() => {
    if (category.toLowerCase() === "jean") return SIZES_JEANS;
    if (gender === "NINO" || gender === "NINA") return SIZES_KIDS;
    return SIZES_ADULT;
  }, [category, gender]);

  // 🔵 Autogenerar SKU cuando cambian los insumos (sin sufijo)
  useEffect(() => {
    setSku(
      generarSKU({
        subcat: category,
        gender,
        color,
        size,
        brand,
      })
    );
  }, [category, gender, color, size, brand]);

  // Cargar lista
  useEffect(() => {
    (async () => {
      const qP = query(
        collection(db, "products_clothes"),
        orderBy("createdAt", "desc")
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
  }, []);

  const resetForm = () => {
    setName("");
    setCategory("Camisa");
    setSize("");
    setColor("");
    setBrand("Shein");
    setGender("");
    setClientCode("");
    setNotes("");
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!name.trim()) {
      setMsg("Ingresa el nombre del producto.");
      return;
    }
    if (clientCode && !CLIENT_CODE_RE.test(clientCode)) {
      setMsg("Código del cliente inválido (A–Z 0–9 . _ - , máx 32).");
      return;
    }

    try {
      const ref = await addDoc(collection(db, "products_clothes"), {
        name: name.trim(),
        category,
        measurement: "unidad",
        // ropa
        sku,
        size: size || "",
        color: color || "",
        brand: brand || "",
        gender: gender || "",
        clientCode: clientCode || "",
        notes: notes || "",
        createdAt: Timestamp.now(),
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

      resetForm();
      setMsg("✅ Producto de ropa creado");
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
      <h2 className="text-2xl font-bold mb-3">Productos de Ropa</h2>

      {/* ===== Formulario ===== */}
      <form
        onSubmit={handleCreate}
        className="bg-white p-4 rounded shadow border mb-6 grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        {/* Nombre / Subcategoría */}
        <div>
          <label className="block text-sm font-semibold">
            Nombre del producto
          </label>
          <input
            className="w-full border p-2 rounded"
            placeholder="Ej: Blusa floral manga corta"
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">Subcategoría</label>
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
          <label className="block text-sm font-semibold">
            Género (opcional)
          </label>
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
          <label className="block text-sm font-semibold">
            Talla (opcional)
          </label>
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
          <div className="text-[11px] text-gray-500 mt-1">
            Sugeridas por subcategoría/género
          </div>
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Color (opcional)
          </label>
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
          <label className="block text-sm font-semibold">
            Marca / Origen (opcional)
          </label>
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

        {/* SKU / Código cliente */}
        <div>
          <label className="block text-sm font-semibold">SKU (auto)</label>
          <input
            className="w-full border p-2 rounded bg-gray-100"
            value={sku}
            readOnly
            placeholder="Se genera automáticamente"
            title="Se genera de subcategoría, género, talla, color y marca"
          />
        </div>

        <div>
          <label className="block text-sm font-semibold">
            Código del cliente (opcional)
          </label>
          <input
            className="w-full border p-2 rounded"
            placeholder="Ej: LOTE-SHEIN-SEP-01"
            value={clientCode}
            onChange={(e) => {
              const v = e.target.value;
              if (CLIENT_CODE_RE.test(v)) setClientCode(v);
            }}
            title="Solo letras, números, punto, guion y guion_bajo (máx 32)"
          />
          {!CLIENT_CODE_RE.test(clientCode) && clientCode.length > 0 && (
            <div className="text-xs text-red-600 mt-1">Formato inválido</div>
          )}
        </div>

        {/* Comentario */}
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Comentario</label>
          <textarea
            className="w-full border p-2 rounded resize-y min-h-24"
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
            maxLength={500}
            placeholder="Ej: Camisita veranera, tela delgada, tirantes…"
          />
          <div className="text-xs text-gray-500 text-right">
            {notes.length}/500
          </div>
        </div>

        <div className="md:col-span-2">
          <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
            Crear producto
          </button>
        </div>
      </form>

      {/* ===== Lista de productos agregados ===== */}
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Subcat.</th>
              <th className="p-2 border">Nombre Producto</th>
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
                <td className="p-4 text-center" colSpan={11}>
                  Cargando…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={11}>
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
                  <td className="p-2 border">{r.category || "—"}</td>
                  <td className="p-2 border">{r.name}</td>
                  <td className="p-2 border">{r.sku || "—"}</td>
                  <td className="p-2 border">{r.size || "—"}</td>
                  <td className="p-2 border">
                    {r.color?.toUpperCase() || "—"}
                  </td>
                  <td className="p-2 border">{r.brand || "—"}</td>
                  <td className="p-2 border">{r.gender || "—"}</td>
                  <td className="p-2 border">{r.clientCode || "—"}</td>
                  <td className="p-2 border">
                    <span title={r.notes || ""}>
                      {(r.notes || "").length > 40
                        ? (r.notes || "").slice(0, 40) + "…"
                        : r.notes || "—"}
                    </span>
                  </td>
                  <td className="p-2 border">
                    <button
                      className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
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
