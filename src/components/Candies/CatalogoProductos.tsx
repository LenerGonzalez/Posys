import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

type CandyProduct = {
  id: string;
  name: string;
  category: string;
  providerPrice: number; // por paquete
  unitsPerPackage: number; // und por paquete
  createdAt?: any;
};

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

function norm(s: any) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toNum(v: any, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function roundInt(v: any, fallback = 1) {
  const n = Math.floor(toNum(v, fallback));
  return n > 0 ? n : fallback;
}

function isEmptyRow(obj: Record<string, any>) {
  const vals = Object.values(obj || {});
  return vals.every((v) => norm(v) === "");
}

/**
 * Detecta columna por múltiples nombres posibles (case-insensitive).
 */
function pickCol(row: Record<string, any>, candidates: string[]) {
  const keys = Object.keys(row || {});
  const map = new Map<string, string>();
  keys.forEach((k) => map.set(norm(k), k));

  for (const c of candidates) {
    const realKey = map.get(norm(c));
    if (realKey != null) return row[realKey];
  }
  return undefined;
}

type ImportRow = {
  category: string;
  name: string;
  providerPrice: number;
  unitsPerPackage: number;
  _raw?: Record<string, any>;
};

export default function ProductsCandies() {
  const { refreshKey, refresh } = useManualRefresh();

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // catálogo
  const [products, setProducts] = useState<CandyProduct[]>([]);

  // form manual
  const [category, setCategory] = useState("");
  const [name, setName] = useState("");
  const [providerPrice, setProviderPrice] = useState<number>(0);
  const [unitsPerPackage, setUnitsPerPackage] = useState<number>(1);

  // edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState("");
  const [editName, setEditName] = useState("");
  const [editProviderPrice, setEditProviderPrice] = useState<number>(0);
  const [editUnitsPerPackage, setEditUnitsPerPackage] = useState<number>(1);

  // filtros
  const [search, setSearch] = useState("");

  // importación
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  // ============================
  //  LOAD CATALOG
  // ============================
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const snap = await getDocs(
          query(collection(db, "products_candies"), orderBy("name", "asc"))
        );
        const list: CandyProduct[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name || "",
            category: x.category || "",
            providerPrice: Number(x.providerPrice || 0),
            unitsPerPackage: Number(x.unitsPerPackage || 1),
            createdAt: x.createdAt,
          });
        });
        setProducts(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando catálogo de dulces.");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  const filtered = useMemo(() => {
    const q = norm(search);
    if (!q) return products;
    return products.filter((p) => {
      const hay = `${p.category} ${p.name}`.toLowerCase();
      return hay.includes(q);
    });
  }, [products, search]);

  // ============================
  //  CRUD MANUAL
  // ============================
  const resetForm = () => {
    setCategory("");
    setName("");
    setProviderPrice(0);
    setUnitsPerPackage(1);
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    const c = String(category || "").trim();
    const n = String(name || "").trim();
    const pp = Math.max(0, toNum(providerPrice, 0));
    const upp = roundInt(unitsPerPackage, 1);

    if (!c) return setMsg("⚠️ La categoría es requerida.");
    if (!n) return setMsg("⚠️ El nombre del producto es requerido.");
    if (pp <= 0) return setMsg("⚠️ El precio proveedor debe ser > 0.");
    if (upp <= 0) return setMsg("⚠️ Und x paquete debe ser > 0.");

    // evitar duplicados exactos (category+name)
    const exists = products.some(
      (p) => norm(p.category) === norm(c) && norm(p.name) === norm(n)
    );
    if (exists) {
      return setMsg("⚠️ Ya existe un producto con esa categoría y nombre.");
    }

    try {
      setLoading(true);
      const payload = {
        category: c,
        name: n,
        providerPrice: pp,
        unitsPerPackage: upp,
        createdAt: Timestamp.now(),
      };
      const ref = await addDoc(collection(db, "products_candies"), payload);
      setProducts((prev) =>
        [...prev, { id: ref.id, ...payload } as CandyProduct].sort((a, b) =>
          a.name.localeCompare(b.name)
        )
      );
      setMsg("✅ Producto creado.");
      resetForm();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error creando producto.");
    } finally {
      setLoading(false);
    }
  };

  const startEdit = (p: CandyProduct) => {
    setEditingId(p.id);
    setEditCategory(p.category);
    setEditName(p.name);
    setEditProviderPrice(p.providerPrice);
    setEditUnitsPerPackage(p.unitsPerPackage || 1);
    setMsg("");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditCategory("");
    setEditName("");
    setEditProviderPrice(0);
    setEditUnitsPerPackage(1);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setMsg("");

    const c = String(editCategory || "").trim();
    const n = String(editName || "").trim();
    const pp = Math.max(0, toNum(editProviderPrice, 0));
    const upp = roundInt(editUnitsPerPackage, 1);

    if (!c) return setMsg("⚠️ La categoría es requerida.");
    if (!n) return setMsg("⚠️ El nombre del producto es requerido.");
    if (pp <= 0) return setMsg("⚠️ El precio proveedor debe ser > 0.");
    if (upp <= 0) return setMsg("⚠️ Und x paquete debe ser > 0.");

    // evitar duplicado con otro id
    const dup = products.some(
      (p) =>
        p.id !== editingId &&
        norm(p.category) === norm(c) &&
        norm(p.name) === norm(n)
    );
    if (dup)
      return setMsg("⚠️ Ya existe otro producto con esa categoría y nombre.");

    try {
      setLoading(true);
      await updateDoc(doc(db, "products_candies", editingId), {
        category: c,
        name: n,
        providerPrice: pp,
        unitsPerPackage: upp,
        updatedAt: Timestamp.now(),
      });

      setProducts((prev) =>
        prev
          .map((p) =>
            p.id === editingId
              ? {
                  ...p,
                  category: c,
                  name: n,
                  providerPrice: pp,
                  unitsPerPackage: upp,
                }
              : p
          )
          .sort((a, b) => a.name.localeCompare(b.name))
      );

      setMsg("✅ Producto actualizado.");
      cancelEdit();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error actualizando producto.");
    } finally {
      setLoading(false);
    }
  };

  const removeProduct = async (p: CandyProduct) => {
    const ok = confirm(`¿Eliminar "${p.name}" (${p.category}) del catálogo?`);
    if (!ok) return;

    try {
      setLoading(true);
      await deleteDoc(doc(db, "products_candies", p.id));
      setProducts((prev) => prev.filter((x) => x.id !== p.id));
      setMsg("🗑️ Producto eliminado.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando producto.");
    } finally {
      setLoading(false);
    }
  };

  // ============================
  //  IMPORT XLSX/CSV
  // ============================
  const downloadTemplateXlsx = () => {
    const data = [
      {
        Categoria: "Gomitas",
        Producto: "Gomita Fresa",
        PrecioProveedor: 120,
        UnidadesPorPaquete: 24,
      },
    ];

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Productos");

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "template_productos_dulces.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const parseRowsFromSheetJson = (json: any[]) => {
    const rows: ImportRow[] = [];
    const errors: string[] = [];

    json.forEach((r: any, idx: number) => {
      if (!r || typeof r !== "object") return;
      if (isEmptyRow(r)) return;

      const cat = String(
        pickCol(r, ["Categoria", "Categoría", "Category", "cat", "category"]) ??
          ""
      ).trim();

      const prod = String(
        pickCol(r, [
          "Producto",
          "Product",
          "Nombre",
          "Name",
          "producto",
          "name",
        ]) ?? ""
      ).trim();

      const ppRaw = pickCol(r, [
        "PrecioProveedor",
        "Precio Prov",
        "Precio Prov.",
        "ProviderPrice",
        "Precio",
        "Costo",
        "providerPrice",
      ]);

      const uppRaw = pickCol(r, [
        "UnidadesPorPaquete",
        "Und x Paquete",
        "UnitsPerPackage",
        "UPP",
        "unitsPerPackage",
      ]);

      const providerPrice = Math.max(0, toNum(ppRaw, 0));
      const unitsPerPackage = roundInt(uppRaw, 1);

      const rowNumber = idx + 2; // asumiendo fila 1 header

      if (!cat) errors.push(`Fila ${rowNumber}: falta Categoria.`);
      if (!prod) errors.push(`Fila ${rowNumber}: falta Producto/Nombre.`);
      if (providerPrice <= 0)
        errors.push(`Fila ${rowNumber}: PrecioProveedor debe ser > 0.`);
      if (unitsPerPackage <= 0)
        errors.push(`Fila ${rowNumber}: UnidadesPorPaquete debe ser > 0.`);

      if (cat && prod && providerPrice > 0 && unitsPerPackage > 0) {
        rows.push({
          category: cat,
          name: prod,
          providerPrice,
          unitsPerPackage,
          _raw: r,
        });
      }
    });

    // Deduplicar dentro del archivo por (cat+name): gana la última fila
    const map = new Map<string, ImportRow>();
    for (const r of rows) {
      map.set(`${norm(r.category)}::${norm(r.name)}`, r);
    }

    return {
      rows: Array.from(map.values()),
      errors,
    };
  };

  const onPickFile = async (file: File | null) => {
    setMsg("");
    setImportErrors([]);
    setImportRows([]);
    setImportFileName(file?.name || "");

    if (!file) return;

    const ext = file.name.toLowerCase();
    const isXlsx = ext.endsWith(".xlsx") || ext.endsWith(".xls");
    const isCsv = ext.endsWith(".csv");

    if (!isXlsx && !isCsv) {
      setImportErrors(["Solo se permiten archivos .xlsx, .xls o .csv"]);
      return;
    }

    try {
      setImportLoading(true);

      const reader = new FileReader();
      const data: ArrayBuffer = await new Promise((resolve, reject) => {
        reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });

      const wb = XLSX.read(new Uint8Array(data), { type: "array" });

      const firstSheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const { rows, errors } = parseRowsFromSheetJson(json as any[]);
      setImportRows(rows);
      setImportErrors(errors);

      if (rows.length === 0 && errors.length === 0) {
        setImportErrors(["No se encontraron filas válidas para importar."]);
      }
    } catch (e) {
      console.error(e);
      setImportErrors([
        "Error leyendo el archivo. Revisá que no esté corrupto.",
      ]);
    } finally {
      setImportLoading(false);
    }
  };

  const importToFirestore = async () => {
    setMsg("");
    if (importErrors.length > 0) {
      setMsg("⚠️ Corregí los errores antes de importar.");
      return;
    }
    if (importRows.length === 0) {
      setMsg("⚠️ No hay filas para importar.");
      return;
    }

    try {
      setImportLoading(true);

      // index por (cat+name) del catálogo actual
      const existingByKey: Record<string, CandyProduct> = {};
      products.forEach((p) => {
        existingByKey[`${norm(p.category)}::${norm(p.name)}`] = p;
      });

      const batch = writeBatch(db);

      let toCreate = 0;
      let toUpdate = 0;

      for (const r of importRows) {
        const key = `${norm(r.category)}::${norm(r.name)}`;
        const existing = existingByKey[key];

        if (existing) {
          // update
          batch.update(doc(db, "products_candies", existing.id), {
            category: r.category.trim(),
            name: r.name.trim(),
            providerPrice: Math.max(0, toNum(r.providerPrice, 0)),
            unitsPerPackage: roundInt(r.unitsPerPackage, 1),
            updatedAt: Timestamp.now(),
          });
          toUpdate += 1;
        } else {
          // create
          const ref = doc(collection(db, "products_candies"));
          batch.set(ref, {
            category: r.category.trim(),
            name: r.name.trim(),
            providerPrice: Math.max(0, toNum(r.providerPrice, 0)),
            unitsPerPackage: roundInt(r.unitsPerPackage, 1),
            createdAt: Timestamp.now(),
          });
          toCreate += 1;
        }
      }

      await batch.commit();

      setMsg(
        `✅ Importación lista. Creados: ${toCreate}, Actualizados: ${toUpdate}`
      );
      setImportOpen(false);
      setImportRows([]);
      setImportErrors([]);
      setImportFileName("");
      refresh(); // recargar lista real desde Firestore
    } catch (e) {
      console.error(e);
      setMsg("❌ Error importando productos a Firestore.");
    } finally {
      setImportLoading(false);
    }
  };

  // preview stats
  const importStats = useMemo(() => {
    const existingKeys = new Set(
      products.map((p) => `${norm(p.category)}::${norm(p.name)}`)
    );
    let willUpdate = 0;
    let willCreate = 0;
    for (const r of importRows) {
      const k = `${norm(r.category)}::${norm(r.name)}`;
      if (existingKeys.has(k)) willUpdate += 1;
      else willCreate += 1;
    }
    return { willCreate, willUpdate, total: importRows.length };
  }, [importRows, products]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Catálogo de Productos (Dulces)</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading || importLoading} />
          <button
            className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
            onClick={() => {
              setImportOpen(true);
              setImportRows([]);
              setImportErrors([]);
              setImportFileName("");
            }}
          >
            Importar (.xlsx)
          </button>
        </div>
      </div>

      {/* FORM CREAR */}
      <form
        onSubmit={createProduct}
        className="bg-white p-3 rounded shadow border mb-4 grid grid-cols-1 md:grid-cols-5 gap-3 items-end text-sm"
      >
        <div>
          <label className="block font-semibold">Categoría</label>
          <input
            className="w-full border rounded px-2 py-1"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            placeholder="Ej: Gomitas"
          />
        </div>

        <div className="md:col-span-2">
          <label className="block font-semibold">Producto</label>
          <input
            className="w-full border rounded px-2 py-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ej: Gomita Fresa"
          />
        </div>

        <div>
          <label className="block font-semibold">Precio proveedor (paq)</label>
          <input
            type="number"
            step="0.01"
            inputMode="decimal"
            className="w-full border rounded px-2 py-1 text-right"
            value={Number.isNaN(providerPrice) ? "" : providerPrice}
            onChange={(e) =>
              setProviderPrice(Math.max(0, toNum(e.target.value, 0)))
            }
          />
        </div>

        <div>
          <label className="block font-semibold">Und x paquete</label>
          <input
            type="number"
            min={1}
            className="w-full border rounded px-2 py-1 text-right"
            value={unitsPerPackage}
            onChange={(e) => setUnitsPerPackage(roundInt(e.target.value, 1))}
          />
        </div>

        <div className="md:col-span-5 flex justify-end gap-2">
          <button
            type="button"
            className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
            onClick={resetForm}
          >
            Limpiar
          </button>
          <button
            type="submit"
            className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
            disabled={loading}
          >
            Crear producto
          </button>
        </div>
      </form>

      {/* BUSCADOR */}
      <div className="bg-white p-3 rounded shadow border mb-3 flex flex-col md:flex-row gap-3 items-center text-sm">
        <div className="w-full md:w-1/2">
          <label className="block font-semibold">Buscar</label>
          <input
            className="w-full border rounded px-2 py-1"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Buscar por categoría o producto…"
          />
        </div>
        <div className="w-full md:w-1/2 text-right">
          <div className="text-xs text-gray-600">Productos en catálogo</div>
          <div className="text-lg font-semibold">{filtered.length}</div>
        </div>
      </div>

      {/* TABLA */}
      <div className="bg-white rounded shadow border w-full overflow-x-auto">
        <table className="min-w-[900px] w-full text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border text-left">Categoría</th>
              <th className="p-2 border text-left">Producto</th>
              <th className="p-2 border text-right">Precio proveedor</th>
              <th className="p-2 border text-right">Und x paquete</th>
              <th className="p-2 border text-center">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Sin productos.
                </td>
              </tr>
            ) : (
              filtered.map((p) => {
                const isEd = editingId === p.id;
                return (
                  <tr key={p.id} className="align-top">
                    <td className="p-2 border">
                      {isEd ? (
                        <input
                          className="w-full border rounded px-2 py-1"
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                        />
                      ) : (
                        p.category
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEd ? (
                        <input
                          className="w-full border rounded px-2 py-1"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      ) : (
                        p.name
                      )}
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {isEd ? (
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-28 border rounded px-2 py-1 text-right"
                          value={
                            Number.isNaN(editProviderPrice)
                              ? ""
                              : editProviderPrice
                          }
                          onChange={(e) =>
                            setEditProviderPrice(
                              Math.max(0, toNum(e.target.value, 0))
                            )
                          }
                        />
                      ) : (
                        money(p.providerPrice)
                      )}
                    </td>

                    <td className="p-2 border text-right tabular-nums">
                      {isEd ? (
                        <input
                          type="number"
                          min={1}
                          className="w-24 border rounded px-2 py-1 text-right"
                          value={editUnitsPerPackage}
                          onChange={(e) =>
                            setEditUnitsPerPackage(roundInt(e.target.value, 1))
                          }
                        />
                      ) : (
                        p.unitsPerPackage
                      )}
                    </td>

                    <td className="p-2 border">
                      {isEd ? (
                        <div className="flex gap-2 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                            onClick={saveEdit}
                            type="button"
                          >
                            Guardar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEdit}
                            type="button"
                          >
                            Cancelar
                          </button>
                        </div>
                      ) : (
                        <div className="flex gap-2 justify-center flex-wrap">
                          <button
                            className="px-2 py-1 rounded bg-yellow-400 hover:bg-yellow-500"
                            onClick={() => startEdit(p)}
                            type="button"
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                            onClick={() => removeProduct(p)}
                            type="button"
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

      {/* MODAL IMPORTACIÓN */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded shadow-lg p-5 text-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xl font-bold">
                Importar productos (.xlsx / .csv)
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setImportOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-gray-50 border rounded p-3 mb-3">
              <div className="flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
                <div>
                  <div className="font-semibold">1) Subí tu archivo</div>
                  <div className="text-xs text-gray-600">
                    Columnas esperadas (flexible): Categoria, Producto/Nombre,
                    PrecioProveedor, UnidadesPorPaquete.
                  </div>
                </div>
                <button
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={downloadTemplateXlsx}
                  type="button"
                >
                  Descargar template .xlsx
                </button>
              </div>

              <div className="mt-3 flex flex-col md:flex-row gap-3 md:items-center">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                />
                {importFileName && (
                  <span className="text-xs text-gray-600">
                    Archivo: <b>{importFileName}</b>
                  </span>
                )}
                {importLoading && <span className="text-xs">Procesando…</span>}
              </div>
            </div>

            {importErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-3">
                <div className="font-semibold text-red-700 mb-2">
                  Errores encontrados
                </div>
                <ul className="list-disc pl-5 text-red-700 text-xs space-y-1">
                  {importErrors.slice(0, 50).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
                {importErrors.length > 50 && (
                  <div className="text-xs text-red-700 mt-2">
                    … y {importErrors.length - 50} más.
                  </div>
                )}
              </div>
            )}

            <div className="bg-white border rounded p-3">
              <div className="flex flex-wrap gap-4 items-center justify-between mb-2">
                <div>
                  <div className="font-semibold">2) Previsualización</div>
                  <div className="text-xs text-gray-600">
                    Se importarán {importStats.total} filas (Crear:{" "}
                    {importStats.willCreate} / Actualizar:{" "}
                    {importStats.willUpdate})
                  </div>
                </div>

                <button
                  className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                  onClick={importToFirestore}
                  disabled={
                    importLoading ||
                    importRows.length === 0 ||
                    importErrors.length > 0
                  }
                  type="button"
                >
                  Importar a Firestore
                </button>
              </div>

              <div className="overflow-x-auto border rounded">
                <table className="min-w-[900px] w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border text-left">Categoría</th>
                      <th className="p-2 border text-left">Producto</th>
                      <th className="p-2 border text-right">
                        Precio proveedor
                      </th>
                      <th className="p-2 border text-right">Und x paquete</th>
                      <th className="p-2 border text-center">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={5}
                          className="p-4 text-center text-gray-500"
                        >
                          Subí un archivo para ver la previsualización.
                        </td>
                      </tr>
                    ) : (
                      importRows.slice(0, 300).map((r, i) => {
                        const key = `${norm(r.category)}::${norm(r.name)}`;
                        const exists = products.some(
                          (p) => `${norm(p.category)}::${norm(p.name)}` === key
                        );
                        return (
                          <tr key={`${key}-${i}`} className="whitespace-nowrap">
                            <td className="p-2 border">{r.category}</td>
                            <td className="p-2 border">{r.name}</td>
                            <td className="p-2 border text-right tabular-nums">
                              {money(r.providerPrice)}
                            </td>
                            <td className="p-2 border text-right tabular-nums">
                              {r.unitsPerPackage}
                            </td>
                            <td className="p-2 border text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] ${
                                  exists
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-green-100 text-green-700"
                                }`}
                              >
                                {exists ? "ACTUALIZA" : "CREA"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>

              {importRows.length > 300 && (
                <div className="text-xs text-gray-600 mt-2">
                  Mostrando 300 de {importRows.length} filas (el import importa
                  todas).
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
