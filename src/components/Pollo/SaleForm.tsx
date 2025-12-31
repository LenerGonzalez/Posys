import React, { useEffect, useState } from "react";
import { db } from "../../firebase";
import { collection, addDoc, getDocs, Timestamp } from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { Role } from "../../apis/apis";

interface Product {
  id: string;
  productName: string; // mapeamos desde item.name
  price: number;
  measurement: string;
  category: string;
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
  const [amountSuggested, setAmountSuggested] = useState<number>(0);
  const [amountCharged, setAmountCharged] = useState<number>(0);
  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");
  const [clientName, setClientName] = useState("");
  const [message, setMessage] = useState("");
  const [measurement, setMeasurement] = useState<string>("");
  const [users, setUsers] = useState<any[]>([]); // Cargar usuarios
  const [category, setCategory] = useState<string>("");

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

  //Cargar usuario
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

  // Calcular monto sugerido al seleccionar producto o cambiar cantidad
  useEffect(() => {
    const product = products.find((p) => p.id === selectedProductId);
    if (product && quantity > 0) {
      const calc = Number((product.price * quantity).toFixed(2));
      setAmountSuggested(calc);
      // Por defecto sugerimos cobrar lo calculado
      setAmountCharged(calc);
    } else {
      setAmountSuggested(0);
      setAmountCharged(0);
    }
  }, [selectedProductId, quantity, products]);

  // Calcular vuelto cuando cambie lo recibido o el cobrado
  useEffect(() => {
    const validReceived = Number(amountReceived) || 0;
    const validCharged = Number(amountCharged) || 0;
    const change = (validReceived - validCharged).toFixed(2);
    setChange(change);
  }, [amountReceived, amountCharged]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const product = products.find((p) => p.id === selectedProductId);
    const qty = Number(quantity) || 0;
    const sug = Number(amountSuggested) || 0;
    const chg = Number(amountCharged) || 0;

    if (!product || qty <= 0) {
      setMessage("Selecciona un producto y una cantidad válida.");
      return;
    }

    try {
      await addDoc(collection(db, "sales"), {
        //Datos de producto ya creado
        id: uuidv4(),
        productId: selectedProductId,
        productName: product.productName,
        measurement: product.measurement,
        category: product.category,

        // Cantidad e importes
        quantity: qty,
        amountSuggested: sug,
        amount: chg, // 👈 campo estándar que usa CierreVentas
        amountCharged: chg, // 👈 compatibilidad con docs existentes

        // Cliente y efectivo
        amountReceived: Number(amountReceived) || 0,
        change: amountChange, // string formateado
        clientName: clientName.trim(),

        // Auditoría
        difference: Number((chg - sug).toFixed(2)),
        timestamp: Timestamp.now(),
        date: format(new Date(), "yyyy-MM-dd"), // 👈 fecha local (coincide con CierreVentas)
        userEmail: users[0]?.email ?? "sin usuario",
        vendor: users[0]?.role ?? "sin usuario", // compatibilidad

        // Estado de flujo para cierre
        status: "FLOTANTE", // 👈 requerido por el cierre
      });

      setMessage("✅ Venta registrada correctamente.");
      // Reset de campos
      setSelectedProductId("");
      setQuantity(0);
      setAmountSuggested(0);
      setAmountCharged(0);
      setAmountReceived(0);
      setChange("0");
      setClientName("");
      setCategory("");
      setMeasurement("");
    } catch (err) {
      console.error(err);
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
          Categoria
        </label>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
        >
          {" "}
          <option value="" disabled>
            Seleccione categoria
          </option>
          <option value="pollo">Pollo</option>
          <option value="cerdo">Cerdo</option>
          <option value="huevo">Huevos</option>
          <option value="ropa">Ropa</option>
          <option value="otros">Otros</option>
        </select>
      </div>
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
              {product.productName} - C${product.price}
            </option>
          ))}
        </select>
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Unidad de medida
        </label>
        <select
          value={measurement}
          onChange={(e) => setMeasurement(e.target.value)}
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-green-400"
        >
          <option value="" disabled>
            Selecciona una medida
          </option>
          <option value="lb">Libra</option>
          <option value="kg">Kilogramo</option>
          <option value="unidad">Unidad</option>
        </select>
      </div>

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Cantidad
        </label>
        <input
          type="number"
          step="0.01"
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={quantity === 0 ? "" : quantity}
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

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💡 Monto total a pagar (sugerido)
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
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={amountCharged === 0 ? "" : amountCharged}
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

      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          🧍 Nombre de cliente:
        </label>
        <input
          type="text"
          placeholder="Nombre del cliente"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={clientName}
          onChange={(e) => setClientName(e.target.value)}
        />
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
