import React, { useState } from "react";
import { db } from "../firebase";
import { addDoc, collection } from "firebase/firestore";

const InventarioForm = () => {
  const [categoria, setCategoria] = useState("Selecciona");
  const [producto, setProducto] = useState("");
  const [precioCompra, setPrecioCompra] = useState<number>(0);
  const [precioVenta, setPrecioVenta] = useState<number>(0);
  const [cantidad, setCantidad] = useState<number>(0);
  const [unidad, setUnidad] = useState("");
  const [message, setMessage] = useState("");
  const [inversion, setInversion] = useState(0);
  const [ingresoEsperado, setIngresoEsperado] = useState(0);
  const [gananciaEsperada, setGananciaEsperada] = useState(0);

  React.useEffect(() => {
    const nuevaInversion = precioCompra * cantidad;
    const nuevoIngresoEsperado = precioVenta * cantidad;
    const nuevaGananciaEsperada = nuevoIngresoEsperado - nuevaInversion;
    setInversion(nuevaInversion);
    setIngresoEsperado(nuevoIngresoEsperado);
    setGananciaEsperada(nuevaGananciaEsperada);
  }, [precioCompra, precioVenta, cantidad]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    if (
      !categoria ||
      precioCompra <= 0 ||
      precioVenta <= 0 ||
      cantidad <= 0 ||
      !unidad
    ) {
      setMessage("❌ Completa todos los campos con valores válidos");
      return;
    }

    try {
      await addDoc(collection(db, "inventory"), {
        categoria,
        producto,
        preciocompra: parseFloat(precioCompra.toFixed(2)),
        precioventa: parseFloat(precioVenta.toFixed(2)),
        cantidad,
        unidad,
        inversion: parseFloat(inversion.toFixed(2)),
        ingresoEsperado: parseFloat(ingresoEsperado.toFixed(2)),
        gananciaEsperada: parseFloat(gananciaEsperada.toFixed(2)),
      });

      setMessage("✅ Inventario registrado.");
      setCategoria("Selecciona");
      setProducto("");
      setPrecioCompra(0);
      setPrecioVenta(0);
      setCantidad(0);
      setUnidad("");
      setInversion(0);
      setIngresoEsperado(0);
      setGananciaEsperada(0);
    } catch (err: any) {
      setMessage("❌ Error: " + err.message);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-md mx-auto bg-white p-8 shadow-lg rounded-lg space-y-6 border border-gray-200 "
    >
      <div className="border p-4 rounded-3xl shadow-sm mt-4">
        <h2 className="text-lg font-bold mb-2">Agregar Inventario</h2>
        <div>
          <label className="block text-sm font-semibold text-gray-700">
            Categoría de producto
          </label>
          <select
            value={categoria}
            onChange={(e) => setCategoria(e.target.value)}
            className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
          >
            {" "}
            <option value="selecciona">Seleccione</option>
            <option value="pollo">Pollo</option>
            <option value="cerdo">Cerdo</option>
            <option value="huevo">Huevos</option>
            <option value="ropa">Ropa</option>
            <option value="otros">Otros</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700">
            Nombre del producto
          </label>
          <input
            placeholder="Producto"
            className="border p-1 w-full mb-2"
            value={producto}
            onChange={(e) => setProducto(e.target.value)}
          />
        </div>

        <div>
          <label className="block text-sm font-semibold text-gray-700">
            Precio de compra{" "}
          </label>
          <input
            type="number"
            placeholder="Precio Compra"
            className="border p-1 w-full mb-2"
            value={precioCompra}
            onChange={(e) => setPrecioCompra(+e.target.value)}
            onFocus={(e) =>
              e.target.value === "0" ? setPrecioCompra(NaN) : null
            }
          />
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700">
            Precio de venta{" "}
          </label>
          <input
            type="number"
            placeholder="Precio Venta"
            className="border p-1 w-full mb-2"
            value={precioVenta}
            onChange={(e) => setPrecioVenta(+e.target.value)}
            //Para eliminar el cero al hacer input
            onFocus={(e) =>
              e.target.value === "0" ? setPrecioVenta(NaN) : null
            }
          />
        </div>
        <div className="space-y-1">
          <label className="block text-sm font-semibold text-gray-700">
            Tipo de unidad de medida
          </label>
          <select
            value={unidad}
            onChange={(e) => setUnidad(e.target.value)}
            className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
          >
            <option value="">Selecciona</option>
            <option value="lb">Libra</option>
            <option value="kg">Kilogramo</option>
            <option value="unidad">Unidad</option>
          </select>
        </div>
        <div>
          <label className="block text-sm font-semibold text-gray-700">
            Cantidad{" "}
          </label>
          <input
            type="number"
            placeholder="Cantidad"
            className="border p-1 w-full mb-2"
            value={cantidad}
            onChange={(e) => setCantidad(+e.target.value)}
            onFocus={(e) => (e.target.value === "0" ? setCantidad(NaN) : null)}
          />
        </div>
        <p>
          Inversión: <strong>{inversion.toFixed(2)} C$</strong>
        </p>
        <p>
          Ingreso esperado: <strong>{ingresoEsperado.toFixed(2)} C$</strong>
        </p>
        <p>
          Ganancia esperada: <strong>{gananciaEsperada.toFixed(2)} C$</strong>
        </p>

        <button
          type="submit"
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 w-full"
        >
          Agregar producto
        </button>

        {message && <p className="text-sm mt-2">{message}</p>}
      </div>
    </form>
  );
};

export default InventarioForm;
