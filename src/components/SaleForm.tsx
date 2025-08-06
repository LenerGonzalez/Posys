import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  addDoc,
  getDocs,
  query,
  where,
  Timestamp,
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";

interface Product {
  id: string;
  productName: string;
  price: number;
}

export default function SaleForm({ user }: { user: any }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [amountSuggested, setAmountSuggested] = useState<number>(0);
  const [amountCharged, setAmountCharged] = useState<number>(0);
  const [message, setMessage] = useState("");
  const [clientName, setClientName] = useState("");
  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  useEffect(() => {
    async function fetchProducts() {
      const querySnapshot = await getDocs(collection(db, "products"));
      const data: Product[] = [];
      querySnapshot.forEach((doc) => {
        const item = doc.data();
        data.push({
          id: doc.id,
          productName: item.name,
          price: item.price,
        });
      });
      setProducts(data);
    }
    fetchProducts();
  }, []);

  useEffect(() => {
    const product = products.find((p) => p.id === selectedProductId);
    if (product && quantity > 0) {
      const calculated = +(product.price * quantity).toFixed(2);
      setAmountSuggested(calculated);
      setAmountCharged(calculated);
    }
  }, [selectedProductId, quantity]);

  useEffect(() => {
    if (amountReceived && amountCharged > 0) {
      const calculated = (amountReceived - amountCharged).toFixed(2);
      setChange(calculated);
    }
  }, [amountReceived, amountCharged]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selectedProductId || quantity <= 0) {
      setMessage("Selecciona un producto y cantidad válida.");
      return;
    }

    try {
      await addDoc(collection(db, "sales"), {
        id: uuidv4(),
        productId: selectedProductId,
        productName: products.find((p) => p.id === selectedProductId)
          ?.productName,
        quantity,
        amountSuggested,
        amountCharged,
        amountReceived,
        change: amountChange,
        clientName,
        difference: +(amountCharged - amountSuggested).toFixed(2),
        timestamp: Timestamp.now(),
      });
      setMessage("✅ Venta registrada correctamente.");
      setQuantity(0);
      setAmountSuggested(0);
      setAmountCharged(0);
      setSelectedProductId("");
      setClientName("");
    } catch (err) {
      setMessage("❌ Error al registrar la venta.");
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="max-w-md mx-auto bg-white p-8 shadow-lg rounded-lg space-y-6 border border-gray-200"
    >
      <h2 className="text-2xl font-bold mb-4 text-blue-700 flex items-center gap-2">
        <span className="inline-block bg-blue-100 text-blue-700 rounded-full p-2">
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
              d="M12 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 10c-4.41 0-8-1.79-8-4V6c0-2.21 3.59-4 8-4s8 1.79 8 4v8c0 2.21-3.59 4-8 4z"
            />
          </svg>
        </span>
        Registrar venta
      </h2>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Producto
        </label>
        <select
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
        >
          <option value="">Selecciona un producto</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.productName} - C$ {product.price}/lb
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Cantidad (Libras)
        </label>
        <input
          type="number"
          step="0.01"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={quantity}
          onChange={(e) => setQuantity(parseFloat(e.target.value))}
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💡 Monto total a pagar
        </label>
        <input
          type="text"
          readOnly
          value={amountSuggested.toFixed(2)}
          className="w-full border border-gray-300 p-2 rounded bg-gray-100"
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Monto final cobrado
        </label>
        <input
          type="number"
          step="0.01"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountCharged}
          onChange={(e) => setAmountCharged(parseFloat(e.target.value))}
        />
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Cliente paga con:
        </label>
        <input
          type="number"
          step="0.01"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountReceived}
          onChange={(e) => setAmountReceived(parseFloat(e.target.value))}
        />
      </div>
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Vuelto al cliente:
        </label>
        <input
          type="text"
          readOnly
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountChange}
          onChange={(e) => setChange(e.target.value)}
        />
        <div className="space-y-1">
          <label className="block text-sm font-semibold text-gray-700">
            💵 Nombre de cliente:
          </label>
          <input
            type="text"
            placeholder="Nombre del cliente"
            className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
            value={clientName}
            onChange={(e) => setClientName(e.target.value)}
          />
        </div>
      </div>
      <button
        type="submit"
        className="w-full bg-blue-600 text-white px-4 py-2 rounded-lg font-semibold shadow hover:bg-blue-700 transition"
      >
        Guardar venta
      </button>

      {message && (
        <p
          className={`text-sm mt-2 ${
            message.startsWith("✅") ? "text-green-600" : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
