// src/components/ProductForm.tsx
import React, { useEffect, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  updateDoc,
  query,
  where,
  limit,
} from "firebase/firestore";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  measurement: string;
  active?: boolean; // <-- nuevo (soft delete)
}

export default function ProductForm() {
  // formulario crear
  const [name, setName] = useState("");
  const [price, setPrice] = useState<number>(0);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [measurement, setMeasurement] = useState("");

  // listado / tabla
  const [products, setProducts] = useState<Product[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [showInactive, setShowInactive] = useState(false); // <-- opcional

  // edición en tabla
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editMeasurement, setEditMeasurement] = useState("");
  const [editPrice, setEditPrice] = useState<number>(0);

  // modal crear
  const [showCreateModal, setShowCreateModal] = useState(false);

  const loadProducts = async () => {
    setLoadingList(true);
    const snap = await getDocs(collection(db, "products"));
    const rows: Product[] = [];
    snap.forEach((d) => {
      const it = d.data() as any;
      rows.push({
        id: d.id,
        name: it.name ?? "",
        price: Number(it.price ?? 0),
        category: it.category ?? "",
        measurement: it.measurement ?? "",
        active: it.active !== false, // default true si no existe
      });
    });
    setProducts(rows);
    setLoadingList(false);
  };

  useEffect(() => {
    loadProducts();
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (!name || price <= 0 || !measurement) {
      setMessage("❌ Completa nombre, precio válido y unidad de medida");
      return;
    }

    try {
      const payload = {
        name,
        price: parseFloat(price.toFixed(2)),
        category,
        measurement,
        active: true, // <-- por defecto activos
      };
      const newRef = await addDoc(collection(db, "products"), payload);

      // actualiza UI sin recargar
      setProducts((prev) => [{ id: newRef.id, ...payload }, ...prev]);

      setMessage("✅ Producto registrado con exito.");
      setName("");
      setPrice(0);
      setMeasurement("");
      setCategory("");

      // cerrar modal al crear
      setShowCreateModal(false);
    } catch (err: any) {
      setMessage("❌ Error: " + err.message);
    }
  };

  const startEdit = (p: Product) => {
    setEditingId(p.id);
    setEditName(p.name);
    setEditCategory(p.category);
    setEditMeasurement(p.measurement);
    setEditPrice(p.price);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditName("");
    setEditCategory("");
    setEditMeasurement("");
    setEditPrice(0);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    const ref = doc(db, "products", editingId);
    await updateDoc(ref, {
      name: editName,
      category: editCategory,
      measurement: editMeasurement,
      price: parseFloat((editPrice || 0).toFixed(2)),
    });
    setProducts((prev) =>
      prev.map((x) =>
        x.id === editingId
          ? {
              ...x,
              name: editName,
              category: editCategory,
              measurement: editMeasurement,
              price: parseFloat((editPrice || 0).toFixed(2)),
            }
          : x
      )
    );
    cancelEdit();
  };

  // Activar / Desactivar (soft delete)
  const toggleActive = async (p: Product) => {
    const ref = doc(db, "products", p.id);
    const newActive = !(p.active !== false); // true -> false, false -> true
    await updateDoc(ref, { active: newActive });
    setProducts((prev) =>
      prev.map((x) => (x.id === p.id ? { ...x, active: newActive } : x))
    );
  };

  // Eliminar con validación de lotes asociados
  const deleteProduct = async (id: string) => {
    // 1) valida si tiene lotes
    const qB = query(
      collection(db, "inventory_batches"),
      where("productId", "==", id),
      limit(1)
    );
    const hasBatches = !(await getDocs(qB)).empty;
    if (hasBatches) {
      alert(
        "No se puede eliminar: hay lotes asociados a este producto.\n" +
          "Sugerencia: desactívalo para ocultarlo."
      );
      return;
    }

    // 2) confirmar y eliminar
    const ok = confirm("¿Eliminar este producto definitivamente?");
    if (!ok) return;
    await deleteDoc(doc(db, "products", id));
    setProducts((prev) => prev.filter((x) => x.id !== id));
  };

  // Filtrado para ocultar inactivos si showInactive=false
  const visibleRows = showInactive
    ? products
    : products.filter((p) => p.active !== false);

  return (
    <div className="max-w-6xl mx-auto">
      {/* Encabezado con botón para abrir modal */}
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-2xl font-bold">Productos</h2>
        <button
          className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700"
          onClick={() => {
            setMessage("");
            setShowCreateModal(true);
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

      {/* ===== Modal: Crear producto ===== */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setShowCreateModal(false)}
          />
          <div className="relative z-10 w-[95%] max-w-lg bg-white rounded-lg shadow-2xl border p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-green-700 flex items-center gap-2">
                <span className="inline-block bg-green-100 text-green-700 rounded-full p-2">
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    className="h-5 w-5"
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
                Registrar producto
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setShowCreateModal(false)}
              >
                Cerrar
              </button>
            </div>

            {/* Form Crear (idéntico, solo reubicado) */}
            <form onSubmit={handleSubmit} className="space-y-4">
              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Categoría
                </label>
                <select
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
                >
                  <option value="">Selecciona</option>
                  <option value="pollo">Pollo</option>
                  <option value="cerdo">Cerdo</option>
                  <option value="huevo">Huevos</option>
                  <option value="ropa">Ropa</option>
                  <option value="otros">Otros</option>
                </select>
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Nombre del producto
                </label>
                <input
                  type="text"
                  className="w-full border p-2 rounded"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </div>

              <div className="space-y-1">
                <label className="block text-sm font-semibold text-gray-700">
                  Tipo de unidad de medida
                </label>
                <select
                  value={measurement}
                  onChange={(e) => setMeasurement(e.target.value)}
                  className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
                >
                  <option value="">Selecciona</option>
                  <option value="lb">Libra</option>
                  <option value="kg">Kilogramo</option>
                  <option value="unidad">Unidad</option>
                </select>
              </div>

              <div>
                <label className="block text-sm">
                  Precio por unidad (ej: 55.50)
                </label>
                <input
                  type="number"
                  step="0.01"
                  className="w-full border p-2 rounded"
                  value={Number.isNaN(price) ? "" : price}
                  onChange={(e) => setPrice(parseFloat(e.target.value))}
                  onFocus={(e) =>
                    e.target.value === "0" ? setPrice(NaN) : null
                  }
                />
              </div>

              <button
                type="submit"
                className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
              >
                Agregar producto
              </button>

              {message && <p className="text-sm mt-2">{message}</p>}
            </form>
          </div>
        </div>
      )}

      {/* Controles de lista */}
      <div className="flex items-center justify-between mt-6 mb-2">
        <h3 className="text-lg font-semibold p-2">Productos</h3>
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={showInactive}
            onChange={(e) => setShowInactive(e.target.checked)}
          />
          Mostrar inactivos
        </label>
      </div>

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Nombre</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Unidad</th>
              <th className="p-2 border">Precio</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loadingList ? (
              <tr>
                <td colSpan={6} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : visibleRows.length === 0 ? (
              <tr>
                <td colSpan={6} className="p-4 text-center">
                  Sin productos
                </td>
              </tr>
            ) : (
              visibleRows.map((p) => {
                const isEditing = editingId === p.id;
                const isActive = p.active !== false;
                return (
                  <tr key={p.id} className="text-center">
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          className="w-full border p-1 rounded"
                          value={editName}
                          onChange={(e) => setEditName(e.target.value)}
                        />
                      ) : (
                        p.name
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={editCategory}
                          onChange={(e) => setEditCategory(e.target.value)}
                        >
                          <option value="">Selecciona</option>
                          <option value="pollo">Pollo</option>
                          <option value="cerdo">Cerdo</option>
                          <option value="huevo">Huevos</option>
                          <option value="ropa">Ropa</option>
                          <option value="otros">Otros</option>
                        </select>
                      ) : (
                        p.category
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <select
                          className="w-full border p-1 rounded"
                          value={editMeasurement}
                          onChange={(e) => setEditMeasurement(e.target.value)}
                        >
                          <option value="">Selecciona</option>
                          <option value="lb">Libra</option>
                          <option value="kg">Kilogramo</option>
                          <option value="unidad">Unidad</option>
                        </select>
                      ) : (
                        p.measurement
                      )}
                    </td>
                    <td className="p-2 border">
                      {isEditing ? (
                        <input
                          type="number"
                          step="0.01"
                          className="w-full border p-1 rounded text-right"
                          value={Number.isNaN(editPrice) ? "" : editPrice}
                          onChange={(e) =>
                            setEditPrice(parseFloat(e.target.value))
                          }
                        />
                      ) : (
                        money(p.price)
                      )}
                    </td>
                    <td className="p-2 border">
                      <span
                        className={`px-2 py-0.5 rounded text-xs ${
                          isActive
                            ? "bg-green-100 text-green-700"
                            : "bg-gray-200 text-gray-700"
                        }`}
                      >
                        {isActive ? "Activo" : "Inactivo"}
                      </span>
                    </td>
                    <td className="p-2 border space-x-2">
                      {isEditing ? (
                        <>
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
                        </>
                      ) : (
                        <>
                          <button
                            className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                            onClick={() => startEdit(p)}
                          >
                            Editar
                          </button>
                          <button
                            className={`px-2 py-1 rounded ${
                              isActive
                                ? "bg-gray-600 hover:bg-gray-700 text-white"
                                : "bg-green-600 hover:bg-green-700 text-white"
                            }`}
                            onClick={() => toggleActive(p)}
                          >
                            {isActive ? "Desactivar" : "Activar"}
                          </button>
                          <button
                            className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                            onClick={() => deleteProduct(p.id)}
                          >
                            Eliminar
                          </button>
                        </>
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
  );
}
