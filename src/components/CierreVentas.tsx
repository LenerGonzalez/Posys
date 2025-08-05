
import React from "react";

const CierreVentas = () => {
  const totalVentas = 1250.50;
  const totalProductos = 45;
  const diferenciaAcumulada = -4.75;

  return (
    <div className="border mt-4 p-4 rounded">
      <h2 className="text-lg font-bold mb-2">Cierre Diario</h2>
      <p>Total en ventas: <strong>{totalVentas} C$</strong></p>
      <p>Productos vendidos: <strong>{totalProductos}</strong></p>
      <p>Diferencia: <strong className={diferenciaAcumulada < 0 ? "text-red-600" : "text-green-600"}>{diferenciaAcumulada} C$</strong></p>
    </div>
  );
};

export default CierreVentas;
