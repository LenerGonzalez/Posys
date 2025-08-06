import React, { useState } from "react";

const InventarioForm = () => {
  const [categoria, setCategoria] = useState("Selecciona");
  const [producto, setProducto] = useState("");
  const [precioCompra, setPrecioCompra] = useState<number>(0);
  const [precioVenta, setPrecioVenta] = useState<number>(0);
  const [cantidad, setCantidad] = useState<number>(0);

  const inversion = precioCompra * cantidad;
  const ingresoEsperado = precioVenta * cantidad;
  const gananciaEsperada = ingresoEsperado - inversion;

  return (
    <div className="border p-4 rounded shadow-sm mt-4">
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
        />
      </div>
      <input
        type="number"
        placeholder="Precio Venta"
        className="border p-1 w-full mb-2"
        value={precioVenta}
        onChange={(e) => setPrecioVenta(+e.target.value)}
      />
      <input
        type="number"
        placeholder="Cantidad"
        className="border p-1 w-full mb-2"
        value={cantidad}
        onChange={(e) => setCantidad(+e.target.value)}
      />
      <p>
        Inversión: <strong>{inversion.toFixed(2)} C$</strong>
      </p>
      <p>
        Ingreso esperado: <strong>{ingresoEsperado.toFixed(2)} C$</strong>
      </p>
      <p>
        Ganancia esperada: <strong>{gananciaEsperada.toFixed(2)} C$</strong>
      </p>
    </div>
  );
};

export default InventarioForm;
