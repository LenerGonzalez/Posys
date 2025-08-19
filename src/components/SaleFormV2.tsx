import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import { collection, addDoc, getDocs, Timestamp } from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { Role } from "../apis/apis";
import allocateFIFOAndUpdateBatches from "../Services/allocateFIFO";

interface Product {
  id: string;
  productName: string; // mapeamos desde item.name
  price: number;
  measurement: string; // mapeamos desde item.measurement
  category: string; // mapeamos desde item.category
}

interface Users {
  id: string;
  email: string;
  role: Role;
}

export default function SaleForm({ user }: { user: any }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [selectedProductId, setSelectedProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);

  // 👇 SIGUE EDITABLE, como pediste
  const [amountCharged, setAmountCharged] = useState<number>(0);

  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  const [message, setMessage] = useState("");
  const [users, setUsers] = useState<Users[]>([]);
  const [clientName, setClientName] = useState("");

  // Cargar productos
  useEffect(() => {
    async function fetchProducts() {
      const querySnapshot = await getDocs(collection(db, "products"));
      const data: Product[] = [];
      querySnapshot.forEach((docSnap) => {
        const item = docSnap.data() as any;
        data.push({
          id: docSnap.id,
          productName: item.name ?? item.productName ?? "(sin nombre)",
          price: Number(item.price ?? 0),
          measurement: item.measurement ?? "(sin unidad)",
          category: item.category ?? "(sin categoría)",
        });
      });
      setProducts(data);
    }
    fetchProducts();
  }, []);

  // Cargar usuarios (mantengo tu misma lógica)
  useEffect(() => {
    async function fetchUsers() {
      const querySnapshot = await getDocs(collection(db, "users"));
      const data: Users[] = [];
      querySnapshot.forEach((docSnap) => {
        const item = docSnap.data() as any;
        data.push({
          id: docSnap.id,
          email: item.email ?? "(sin email)",
          role: item.role ?? "USER",
        });
      });
      setUsers(data);
    }
    fetchUsers();
  }, []);

  // Calcular monto sugerido por producto*cantidad y
  // precargar amountCharged con ese valor (pero sigue editable)
  useEffect(() => {
    const product = products.find((p) => p.id === selectedProductId);
    if (product && quantity > 0) {
      const calc = Number((product.price * quantity).toFixed(2));
      setAmountCharged((prev) => (prev === 0 ? calc : prev)); // si ya editaste, no te lo pisa
    } else {
      setAmountCharged(0);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProductId, quantity, products]);

  // Calcular vuelto
  useEffect(() => {
    const validReceived = Number(amountReceived) || 0;
    const validCharged = Number(amountCharged) || 0;
    const change = (validReceived - validCharged).toFixed(2);
    setChange(change);
  }, [amountReceived, amountCharged]);

  // Bloquear coma y permitir punto en inputs numéricos
  const numberKeyGuard = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ",") {
      e.preventDefault();
      (e.target as HTMLInputElement).value += ".";
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    const product = products.find((p) => p.id === selectedProductId);
    const qty = Number(quantity) || 0;
    const chg = Number(amountCharged) || 0;

    if (!product || qty <= 0) {
      setMessage("Selecciona un producto y una cantidad válida.");
      return;
    }

    try {
      // 1) Asignar FIFO y descontar de lotes (manteniendo tu flujo)
      const { allocations, avgUnitCost, cogsAmount } =
        await allocateFIFOAndUpdateBatches(db, product.productName, qty, false);

      // 2) Registrar venta en salesV2 (SIN cambiar tu mapeo de usuario)
      await addDoc(collection(db, "salesV2"), {
        id: uuidv4(),
        productId: selectedProductId,
        productName: product.productName,
        price: product.price,

        quantity: qty,
        amount: chg, // tu campo principal de ingreso
        amountCharged: chg, // compatibilidad

        amountReceived: Number(amountReceived) || 0,
        change: amountChange,
        clientName: clientName.trim(),

        timestamp: Timestamp.now(),
        date: format(new Date(), "yyyy-MM-dd"),

        // 👇 conservando tu lógica original
        userEmail: users[0]?.email ?? "sin usuario",
        vendor: users[0]?.role ?? "sin usuario",

        status: "FLOTANTE",

        // Costeo real (para finanzas/liquidaciones)
        allocations, // [{ batchId, qty, unitCost, lineCost }]
        avgUnitCost, // costo promedio unitario ponderado
        cogsAmount, // suma de lineCost
      });

      setMessage("✅ Venta registrada y asignada a inventario (FIFO).");

      // Reset
      setSelectedProductId("");
      setQuantity(0);
      setAmountCharged(0);
      setAmountReceived(0);
      setChange("0");
      setClientName("");
    } catch (err: any) {
      console.error(err);
      setMessage(`❌ ${err?.message || "Error al registrar la venta."}`);
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

      {/* Producto */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Producto | Precio por Libra/Unidad
        </label>
        <select
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={selectedProductId}
          onChange={(e) => setSelectedProductId(e.target.value)}
        >
          <option value="" disabled>
            Selecciona un producto
          </option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.productName} - C$ {product.price}
            </option>
          ))}
        </select>
      </div>

      {/* Cantidad */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Libras - Unidad
        </label>
        <input
          type="number"
          lang="eng"
          step="0.01"
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={quantity === 0 ? "" : quantity}
          onKeyDown={numberKeyGuard}
          onFocus={(e) => {
            if (e.target.value === "0") e.target.value = "";
          }}
          onChange={(e) => {
            const value = e.target.value.replace(",", ".");
            const num = value === "" ? 0 : parseFloat(value);
            const truncated = Math.floor(num * 100) / 100;
            setQuantity(truncated);
          }}
        />
      </div>

      {/* Monto total (EDITABLE, como tenías) */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Monto total
        </label>
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountCharged === 0 ? "" : amountCharged}
          onKeyDown={numberKeyGuard}
          onFocus={(e) => {
            if (e.target.value === "0") e.target.value = "";
          }}
          onChange={(e) => {
            const value = e.target.value.replace(",", ".");
            const num = value === "" ? 0 : parseFloat(value);
            const truncated = Math.floor(num * 100) / 100;
            setAmountCharged(truncated);
          }}
        />
      </div>

      {/* Paga con */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Cliente paga con:
        </label>
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountReceived === 0 ? "" : amountReceived}
          onKeyDown={numberKeyGuard}
          onFocus={(e) => {
            if (e.target.value === "0") e.target.value = "";
          }}
          onChange={(e) => {
            const value = e.target.value.replace(",", ".");
            const num = value === "" ? 0 : parseFloat(value);
            const truncated = Math.floor(num * 100) / 100;
            setAmountReceived(truncated);
          }}
        />
      </div>

      {/* Vuelto */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Vuelto al cliente:
        </label>
        <input
          type="text"
          readOnly
          className="w-full border border-gray-300 p-2 rounded bg-gray-100"
          value={amountChange}
        />
      </div>
      {/* 
      Cliente opcional
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
      </div> */}

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
