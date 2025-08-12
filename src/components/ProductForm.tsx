import React, { useState } from "react";
import { db } from "../firebase";
import { addDoc, collection } from "firebase/firestore";

export default function ProductForm() {
  const [name, setName] = useState("");
  const [price, setPrice] = useState<number>(0);
  const [message, setMessage] = useState("");
  const [category, setCategory] = useState("");
  const [measurement, setMeasurement] = useState("");

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (!name || price <= 0) {
      setMessage("❌ Completa nombre, precio válido y unidad de medida");
      return;
    }

    try {
      await addDoc(collection(db, "products"), {
        name,
        price: parseFloat(price.toFixed(2)),
        category,
        measurement,
      });

      setMessage("✅ Producto registrado.");
      setName("");
      setPrice(0);
      setMeasurement("");
    } catch (err: any) {
      setMessage("❌ Error: " + err.message);
    }
  };

  return (
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
          value={price}
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
  );
}
