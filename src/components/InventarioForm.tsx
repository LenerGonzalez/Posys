
import React, { useState } from "react";

const InventarioForm = () => {
  const [categoria, setCategoria] = useState("");
  const [producto, setProducto] = useState("");
  const [precioCompra, setPrecioCompra] = useState(0);
  const [precioVenta, setPrecioVenta] = useState(0);
  const [cantidad, setCantidad] = useState(0);

  const inversion = precioCompra * cantidad;
  const ingresoEsperado = precioVenta * cantidad;
  const gananciaEsperada = ingresoEsperado - inversion;

  return (
    <div className="border p-4 rounded shadow-sm mt-4">
      <h2 className="text-lg font-bold mb-2">Agregar Inventario</h2>
      <input placeholder="Categoría" className="border p-1 w-full mb-2" value={categoria} onChange={e => setCategoria(e.target.value)} />
      <input placeholder="Producto" className="border p-1 w-full mb-2" value={producto} onChange={e => setProducto(e.target.value)} />
      <input type="number" placeholder="Precio Compra" className="border p-1 w-full mb-2" value={precioCompra} onChange={e => setPrecioCompra(+e.target.value)} />
      <input type="number" placeholder="Precio Venta" className="border p-1 w-full mb-2" value={precioVenta} onChange={e => setPrecioVenta(+e.target.value)} />
      <input type="number" placeholder="Cantidad" className="border p-1 w-full mb-2" value={cantidad} onChange={e => setCantidad(+e.target.value)} />
      <p>Inversión: <strong>{inversion.toFixed(2)} C$</strong></p>
      <p>Ingreso esperado: <strong>{ingresoEsperado.toFixed(2)} C$</strong></p>
      <p>Ganancia esperada: <strong>{gananciaEsperada.toFixed(2)} C$</strong></p>
    </div>
  );
};

export default InventarioForm;
