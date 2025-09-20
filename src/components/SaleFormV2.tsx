import React, { useEffect, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  addDoc,
  getDocs,
  Timestamp,
  query,
  where,
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { Role } from "../apis/apis";
import allocateFIFOAndUpdateBatches from "../Services/allocateFIFO";
// --- FIX RÁPIDO: actualizar productId en lotes por NOMBRE (usar solo si hay desfasados)
import { updateDoc, doc as fsDoc } from "firebase/firestore";
import { roundQty, addQty, subQty, gteQty } from "../Services/decimal";

async function fixBatchesProductIdByName(
  productName: string,
  newProductId: string
) {
  const snap = await getDocs(collection(db, "inventory_batches"));
  const lower = productName.trim().toLowerCase();
  let updates = 0;
  for (const d of snap.docs) {
    const b = d.data() as any;
    const bn = (b.productName || "").trim().toLowerCase();
    if (bn === lower && b.productId !== newProductId) {
      await updateDoc(fsDoc(db, "inventory_batches", d.id), {
        productId: newProductId,
      });
      updates++;
    }
  }
  return updates;
}

interface Product {
  id: string;
  productName: string;
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

  // 👇 editable con flag (igual que tenías)
  const [amountCharged, setAmountCharged] = useState<number>(0);
  const [manualAmount, setManualAmount] = useState(false);

  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  const [message, setMessage] = useState("");
  const [users, setUsers] = useState<Users[]>([]);
  const [clientName, setClientName] = useState("");

  // 🔵 NUEVO: fecha de la venta (por defecto hoy)
  const [saleDate, setSaleDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );

  const round2 = (n: number) => Math.round(n * 100) / 100;

  // Detectar si el producto actual es de unidades (no libras)
  const selectedProduct = products.find((p) => p.id === selectedProductId);
  const isUnit = (selectedProduct?.measurement || "").toLowerCase() !== "lb";

  // ---- helpers de stock (ajustados a 3 decimales) --------------------------
  const getDisponibleByProductId = async (productId: string) => {
    if (!productId) return 0;
    const qId = query(
      collection(db, "inventory_batches"),
      where("productId", "==", productId)
    );
    const snap = await getDocs(qId);
    let total = 0;
    snap.forEach((d) => {
      const b = d.data() as any;
      total = addQty(total, Number(b.remaining || 0)); // 🔵 suma segura a 3 dec
    });
    return roundQty(total); // 🔵 normaliza
  };

  const getDisponibleByName = async (productName: string) => {
    if (!productName) return 0;
    const all = await getDocs(collection(db, "inventory_batches"));
    let total = 0;
    all.forEach((d) => {
      const b = d.data() as any;
      const name = (b.productName || "").trim().toLowerCase();
      if (name === productName.trim().toLowerCase()) {
        total = addQty(total, Number(b.remaining || 0)); // 🔵
      }
    });
    return roundQty(total); // 🔵
  };
  // -------------------------------------------------------------------------

  // Cargar productos (SOLO activos)
  useEffect(() => {
    async function fetchProducts() {
      const querySnapshot = await getDocs(collection(db, "products"));
      const data: Product[] = [];
      querySnapshot.forEach((docSnap) => {
        const item = docSnap.data() as any;
        if (item?.active === false) return;
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

  // Cargar usuarios
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

  // Si cambia el producto, volver a modo automático del monto
  useEffect(() => {
    setManualAmount(false);
  }, [selectedProductId]);

  // Calcular monto sugerido (cuando NO tocaste manualmente)
  useEffect(() => {
    const product = products.find((p) => p.id === selectedProductId);
    if (!product) {
      setAmountCharged(0);
      return;
    }
    const qty = Number(quantity) || 0;
    if (!manualAmount) {
      const calc = round2(product.price * qty);
      setAmountCharged(calc);
    }
  }, [selectedProductId, quantity, products, manualAmount]);

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
    // 🔵 qty normalizado: entero si unidad, 3 dec si libra
    const qtyRaw = Number(quantity) || 0;
    const qty = isUnit ? Math.max(0, Math.round(qtyRaw)) : roundQty(qtyRaw); // 🔵
    const chg = Number(amountCharged) || 0;

    if (!product || qty <= 0) {
      setMessage("Selecciona un producto y una cantidad válida.");
      return;
    }

    try {
      // --- Verificación previa de stock (con normalización) ---
      const disponibleById = await getDisponibleByProductId(product.id);

      if (!gteQty(disponibleById, qty)) {
        // 🔵 comparación robusta
        const disponibleByName = await getDisponibleByName(product.productName);

        if (gteQty(disponibleByName, 0) && !gteQty(disponibleById, 0)) {
          const changed = await fixBatchesProductIdByName(
            product.productName,
            product.id
          );
          const dispAfter = await getDisponibleByProductId(product.id);

          if (!gteQty(dispAfter, qty)) {
            const faltan = roundQty(qty - dispAfter);
            setMessage(
              `❌ Stock insuficiente tras corregir ${changed} lote(s). Faltan ${faltan.toFixed(
                3
              )} unidades.`
            );
            return;
          } else {
            setMessage(
              `✅ Lotes corregidos (${changed}). Continuando con la venta…`
            );
          }
        } else {
          const faltan = roundQty(qty - disponibleById);
          setMessage(
            `❌ Stock insuficiente para "${
              product.productName
            }". Faltan ${faltan.toFixed(3)} unidades.`
          );
          return;
        }
      }
      // -----------------------------------------------------------

      // 1) Asignar FIFO y descontar de lotes
      const { allocations, avgUnitCost, cogsAmount } =
        await allocateFIFOAndUpdateBatches(db, product.productName, qty, false);

      // 2) Registrar venta en salesV2
      await addDoc(collection(db, "salesV2"), {
        id: uuidv4(),
        productId: selectedProductId,
        productName: product.productName,
        price: product.price,

        quantity: qty, // 🔵 normalizado
        amount: chg,
        amountCharged: chg,

        amountReceived: Number(amountReceived) || 0,
        change: amountChange,
        clientName: clientName.trim(),

        timestamp: Timestamp.now(),
        date: saleDate, // 🔵 usa la fecha elegida

        userEmail: users[0]?.email ?? "sin usuario",
        vendor: users[0]?.role ?? "sin usuario",

        status: "FLOTANTE",

        allocations,
        avgUnitCost,
        cogsAmount,
      });

      setMessage("✅ Venta registrada y asignada a inventario (FIFO).");

      // Reset
      setSelectedProductId("");
      setQuantity(0);
      setManualAmount(false);
      setAmountCharged(0);
      setAmountReceived(0);
      setChange("0");
      setClientName("");
      setSaleDate(format(new Date(), "yyyy-MM-dd")); // reset a hoy
    } catch (err: any) {
      console.error(err);
      setMessage(`❌ ${err?.message || "Error al registrar la venta."}`);
    }
  };

  return (
    <form
      onSubmit={handleSubmit}
      className="w-full mx-auto bg-white rounded-2xl shadow-2xl
                 p-4 sm:p-6 md:p-8
                 max-w-md sm:max-w-lg md:max-w-xl lg:max-w-2xl
                 space-y-4"
    >
      <h2 className="text-xl sm:text-2xl font-bold mb-2 sm:mb-4 text-blue-700 flex items-center gap-2">
        <span className="block bg-blue-100 text-blue-700 rounded-full p-2">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-5 w-5 sm:h-6 sm:w-6"
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

      {/* 🔵 NUEVO: Fecha de la venta */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Fecha de la venta
        </label>
        <input
          type="date"
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={saleDate}
          onChange={(e) => setSaleDate(e.target.value)}
        />
      </div>

      {/* Cantidad */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          Libras - Unidad
        </label>
        <input
          type="number"
          lang="eng"
          step={isUnit ? 1 : 0.01}
          inputMode={isUnit ? "numeric" : "decimal"}
          className="w-full border border-gray-300 p-2 rounded focus:ring-2 focus:ring-blue-400"
          value={quantity === 0 ? "" : quantity}
          onKeyDown={numberKeyGuard}
          onFocus={(e) => {
            if (e.target.value === "0") e.target.value = "";
          }}
          onChange={(e) => {
            const value = e.target.value.replace(",", ".");
            const num = value === "" ? 0 : parseFloat(value);

            if (isUnit) {
              const intVal = Number.isFinite(num)
                ? Math.max(0, Math.round(num))
                : 0;
              setQuantity(intVal);
            } else {
              setQuantity(Number.isFinite(num) ? num : 0);
            }
          }}
          disabled={!selectedProductId}
          placeholder={
            !selectedProductId ? "Selecciona un producto primero" : ""
          }
          title={
            !selectedProductId ? "Selecciona un producto para habilitar" : ""
          }
        />
      </div>

      {/* Monto total (READONLY como lo tenías) */}
      <div className="space-y-1">
        <label className="block text-sm font-semibold text-gray-700">
          💵 Monto total
        </label>
        <input
          type="number"
          step="0.01"
          readOnly
          inputMode="decimal"
          className="w-full border border-gray-300 p-2 rounded bg-gray-100"
          value={amountCharged === 0 ? "" : amountCharged.toFixed(2)}
          onKeyDown={numberKeyGuard}
        />
      </div>

      {/* Botón */}
      <button
        type="submit"
        className="w-full bg-blue-600 text-white px-4 py-3 sm:py-2 rounded-lg font-semibold shadow hover:bg-blue-700 transition"
      >
        Guardar venta
      </button>

      {message && (
        <p
          className={`text-sm mt-2 ${
            message.startsWith("✅")
              ? "text-green-600"
              : message.startsWith("⚠️")
              ? "text-yellow-600"
              : "text-red-600"
          }`}
        >
          {message}
        </p>
      )}
    </form>
  );
}
