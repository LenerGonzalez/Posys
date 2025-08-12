// CierreVentas.tsx
import React, { useEffect, useState, useRef } from "react";
import { db } from "../firebase";
import {
  collection,
  getDocs,
  addDoc,
  Timestamp,
  query,
  where,
} from "firebase/firestore";
import { format } from "date-fns";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";

interface SaleData {
  id: string;
  productName: string;
  quantity: number;
  amount: number;
  amountSuggested: number;
  date: string;
  userEmail: string;
}

interface ClosureData {
  id: string;
  date: string;
  createdAt: any;
  products: {
    productName: string;
    quantity: number;
    amount: number;
  }[];
  totalUnits: number;
  totalCharged: number;
  totalSuggested: number;
  totalDifference: number;
}

export default function CierreVentas(): React.ReactElement {
  const [sales, setSales] = useState<SaleData[]>([]);
  const [closure, setClosure] = useState<ClosureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const today = format(new Date(), "yyyy-MM-dd");
  const pdfRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fetchSales = async () => {
      const querySnapshot = await getDocs(collection(db, "sales"));
      const todaySales: SaleData[] = [];

      querySnapshot.forEach((doc) => {
        const sale = doc.data() as SaleData;
        if (sale.date === today) {
          todaySales.push({ ...sale, id: doc.id });
        }
      });

      setSales(todaySales);
    };

    const fetchClosure = async () => {
      const q = query(
        collection(db, "daily_closures"),
        where("date", "==", today)
      );
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const doc = snapshot.docs[0];
        setClosure({ id: doc.id, ...doc.data() } as ClosureData);
      }
    };

    Promise.all([fetchSales(), fetchClosure()]).finally(() =>
      setLoading(false)
    );
  }, [today]);

  const totalSuggested = sales.reduce((sum, s) => sum + s.amountSuggested, 0);
  const totalCharged = sales.reduce((sum, s) => sum + s.amount, 0);
  const totalDifference = totalCharged - totalSuggested;
  const totalUnits = sales.reduce((sum, s) => sum + s.quantity, 0);

  const handleSave = async () => {
    try {
      await addDoc(collection(db, "daily_closures"), {
        date: today,
        createdAt: Timestamp.now(),
        totalCharged,
        totalSuggested,
        totalDifference,
        totalUnits,
        products: sales.map((s) => ({
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
        })),
      });
      setMessage("✅ Cierre del día guardado exitosamente.");
    } catch (error) {
      setMessage("❌ Error al guardar el cierre.");
    }
  };

  const handleDownloadPDF = async () => {
    if (pdfRef.current) {
      const canvas = await html2canvas(pdfRef.current);
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_${today}.pdf`);
    }
  };

  return (
    <div className="max-w-4xl mx-auto bg-white p-6 rounded shadow">
      <h2 className="text-xl font-bold mb-4">Cierre de Ventas - {today}</h2>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          {closure ? (
            <>
              <h3 className="font-semibold text-green-700 mb-2">
                Cierre ya guardado:
              </h3>
              <table className="min-w-full border text-sm mb-4">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Cantidad</th>
                    <th className="border p-2">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {closure.products.map((p, index) => (
                    <tr key={index} className="text-center">
                      <td className="border p-1">{p.productName}</td>
                      <td className="border p-1">{p.quantity}</td>
                      <td className="border p-1">C${p.amount.toFixed(2)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <p>
                Total libras/unidades vendidas:{" "}
                <strong>{closure.totalUnits}</strong>
              </p>
              <p>
                Total sugerido:{" "}
                <strong>C${closure.totalSuggested.toFixed(2)}</strong>
              </p>
              <p>
                Total cobrado:{" "}
                <strong>C${closure.totalCharged.toFixed(2)}</strong>
              </p>
              <p
                className={`font-bold ${
                  closure.totalDifference < 0
                    ? "text-red-600"
                    : "text-green-600"
                }`}
              >
                Diferencia: C${closure.totalDifference.toFixed(2)}
              </p>
            </>
          ) : (
            <>
              <table className="min-w-full border text-sm mb-4">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="border p-2">Producto</th>
                    <th className="border p-2">Cantidad</th>
                    <th className="border p-2">Monto</th>
                    <th className="border p-2">Vendedor</th>
                  </tr>
                </thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.id} className="text-center">
                      <td className="border p-1">{sale.productName}</td>
                      <td className="border p-1">{sale.quantity}</td>
                      <td className="border p-1">C${sale.amount.toFixed(2)}</td>
                      <td className="border p-1">{sale.userEmail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <p>
                Total libras/unidades vendidas: <strong>{totalUnits}</strong>
              </p>
              <p>
                Total sugerido: <strong>C${totalSuggested.toFixed(2)}</strong>
              </p>
              <p>
                Total cobrado: <strong>C${totalCharged.toFixed(2)}</strong>
              </p>
              <p
                className={`font-bold ${
                  totalDifference < 0 ? "text-red-600" : "text-green-600"
                }`}
              >
                Diferencia: C${totalDifference.toFixed(2)}
              </p>

              <button
                onClick={handleSave}
                className="mt-4 bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
              >
                Guardar cierre del día
              </button>
            </>
          )}
        </div>
      )}

      {!loading && (
        <button
          onClick={handleDownloadPDF}
          className="mt-4 bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Descargar PDF
        </button>
      )}

      {message && <p className="mt-2 text-sm">{message}</p>}
    </div>
  );
}
