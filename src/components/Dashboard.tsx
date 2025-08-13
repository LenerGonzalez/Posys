import { useEffect, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  Timestamp,
  query,
  orderBy,
} from "firebase/firestore";
import jsPDF from "jspdf";

interface Sale {
  id: string;
  productName: string;
  category: string;
  quantity: number;
  amountSuggested: number;
  amountCharged: number;
  difference: number;
  vendor: string;
  timestamp: Timestamp;
}

export default function Dashboard() {
  const [sales, setSales] = useState<Sale[]>([]);
  const [totalDifference, setTotalDifference] = useState(0);

  useEffect(() => {
    async function fetchSales() {
      const q = query(collection(db, "sales"), orderBy("timestamp", "desc"));
      const querySnapshot = await getDocs(q);
      const data: Sale[] = [];

      querySnapshot.forEach((doc) => {
        const s = doc.data();
        data.push({
          id: doc.id,
          productName: s.productName,
          quantity: s.quantity,
          amountSuggested: s.amountSuggested,
          amountCharged: s.amountCharged,
          difference: s.difference,
          category: s.category,
          vendor: s.vendor,
          timestamp: s.timestamp,
        });
      });

      setSales(data);
      const total = data.reduce((acc, s) => acc + s.difference, 0);
      setTotalDifference(total);
    }
    fetchSales();
  }, []);

  const exportToPDF = () => {
    const doc = new jsPDF();
    doc.text("Reporte de Ventas", 14, 10);

    const rows = sales.map((s) => [
      s.productName,
      s.quantity,
      s.amountSuggested.toFixed(2),
      s.amountCharged.toFixed(2),
      s.difference.toFixed(2),
      s.vendor,
      s.timestamp.toDate().toLocaleString(),
    ]);

    (doc as any).autoTable({
      head: [
        [
          "Producto",
          "Cantidad",
          "Sugerido",
          "Cobrado",
          "Diferencia",
          "Vendedor",
          "Fecha",
        ],
      ],
      body: rows,
      startY: 20,
    });

    doc.save("reporte_ventas.pdf");
  };

  return (
    <div className="max-w-7xl mx-auto p-6">
      <h2 className="text-2xl font-bold mb-4">📊 Reporte de Ventas</h2>
      <div className="mb-4">
        <button
          onClick={exportToPDF}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Exportar a PDF
        </button>
      </div>
      <table className="w-full table-auto border">
        <thead className="bg-gray-100">
          <tr>
            <th className="p-2 border">Categoría</th>
            <th className="p-2 border">Producto</th>
            <th className="p-2 border">Cantidad</th>
            <th className="p-2 border">Sugerido</th>
            <th className="p-2 border">Cobrado</th>
            <th className="p-2 border">Diferencia</th>
            <th className="p-2 border">Vendedor</th>
            <th className="p-2 border">Fecha</th>
          </tr>
        </thead>
        <tbody>
          {sales.map((sale) => (
            <tr key={sale.id}>
              <td className="border p-1">{sale.category}</td>
              <td className="p-2 border">{sale.productName}</td>
              <td className="p-2 border">{sale.quantity}</td>
              <td className="p-2 border">
                C${sale.amountSuggested.toFixed(2)}
              </td>
              <td
                className={`p-2 border ${
                  sale.amountCharged < sale.amountSuggested
                    ? "text-red-600 font-bold"
                    : ""
                }`}
              >
                C${sale.amountCharged.toFixed(2)}
              </td>
              <td
                className={`p-2 border ${
                  sale.difference < 0 ? "text-red-600 font-bold" : ""
                }`}
              >
                {sale.difference >= 0 ? "+" : ""}
                {sale.difference.toFixed(2)}
              </td>
              <td className="p-2 border">{sale.vendor}</td>
              <td className="p-2 border">
                {sale.timestamp.toDate().toLocaleString()}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="mt-4 text-right text-lg font-semibold">
        🧮 Diferencia acumulada:{" "}
        <span
          className={`${
            totalDifference < 0 ? "text-red-600" : "text-green-700"
          }`}
        >
          {totalDifference >= 0 ? "+" : ""}
          {totalDifference.toFixed(2)} C$
        </span>
      </div>
    </div>
  );
}
