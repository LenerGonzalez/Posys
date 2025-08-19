import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  updateDoc,
} from "firebase/firestore";

const money = (n: number) => `C$${(Number(n) || 0).toFixed(2)}`;

interface Product {
  id: string;
  name: string;
  price: number;
  category: string;
  measurement: string;
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

  // edición en tabla
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState("");
  const [editCategory, setEditCategory] = useState("");
  const [editMeasurement, setEditMeasurement] = useState("");
  const [editPrice, setEditPrice] = useState<number>(0);

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
      const newRef = await addDoc(collection(db, "products"), {
        name,
        price: parseFloat(price.toFixed(2)),
        category,
        measurement,
      });

      // actualiza UI sin recargar
      setProducts((prev) => [
        {
          id: newRef.id,
          name,
          price: parseFloat(price.toFixed(2)),
          category,
          measurement,
        },
        ...prev,
      ]);

      setMessage("✅ Producto registrado.");
      setName("");
      setPrice(0);
      setMeasurement("");
      setCategory("");
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

  const deleteProduct = async (id: string) => {
    const ok = confirm("¿Eliminar este producto?");
    if (!ok) return;
    await deleteDoc(doc(db, "products", id));
    setProducts((prev) => prev.filter((x) => x.id !== id));
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* Form Crear */}
      <form
        onSubmit={handleSubmit}
        className="max-w-md mx-auto bg-white p-8 shadow-lg rounded-lg space-y-6 border border-gray-200"
      >
        <h2 className="text-2xl font-bold mb-4 text-green-700 flex items-center gap-2">
          <span className="inline-block bg-green-100 text-green-700 rounded-full p-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="h-6 w-6"
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
        </h2>

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
          <label className="block text-sm">Precio por unidad (ej: 55.50)</label>
          <input
            type="number"
            step="0.01"
            className="w-full border p-2 rounded"
            value={Number.isNaN(price) ? "" : price}
            onChange={(e) => setPrice(parseFloat(e.target.value))}
            onFocus={(e) => (e.target.value === "0" ? setPrice(NaN) : null)}
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

      {/* Tabla */}
      <div className="bg-white p-2 rounded shadow border overflow-x-auto mt-6">
        <h3 className="text-lg font-semibold p-2">Productos</h3>
        <table className="min-w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Nombre</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Unidad</th>
              <th className="p-2 border">Precio</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loadingList ? (
              <tr>
                <td colSpan={5} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : products.length === 0 ? (
              <tr>
                <td colSpan={5} className="p-4 text-center">
                  Sin productos
                </td>
              </tr>
            ) : (
              products.map((p) => {
                const isEditing = editingId === p.id;
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
