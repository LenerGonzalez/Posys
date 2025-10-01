// src/components/SaleForm.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../firebase";
import {
  collection,
  addDoc,
  getDocs,
  Timestamp,
  query,
  where,
  updateDoc,
  doc as fsDoc,
} from "firebase/firestore";
import { v4 as uuidv4 } from "uuid";
import { format } from "date-fns";
import { Role } from "../apis/apis";
import allocateFIFOAndUpdateBatches from "../Services/allocateFIFO";
import { roundQty, addQty, gteQty } from "../Services/decimal";

// --- FIX RÁPIDO: actualizar productId en lotes por NOMBRE (usar solo si hay desfasados)
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

// Ítem del carrito
type CartItem = {
  productId: string;
  productName: string;
  measurement: string; // "lb" o unidad
  price: number; // unitario
  stock: number; // existencias calculadas
  qty: number; // cantidad elegida
  discount: number; // entero C$ por línea
};

export default function SaleForm({ user }: { user: any }) {
  // ===== Catálogos =====
  const [products, setProducts] = useState<Product[]>([]);
  const [users, setUsers] = useState<Users[]>([]);

  // ===== Form =====
  const [selectedProductId, setSelectedProductId] = useState("");
  const [saleDate, setSaleDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );
  const [clientName, setClientName] = useState("");

  // Carrito
  const [items, setItems] = useState<CartItem[]>([]);

  // Totales (mantengo tus nombres para compatibilidad)
  const [amountCharged, setAmountCharged] = useState<number>(0); // total neto
  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  const [message, setMessage] = useState("");

  // 🔵 NUEVO: overlay de guardado
  const [saving, setSaving] = useState(false);

  // 🔵 NUEVO: mapa de existencias por productId para filtrar el selector
  const [stockById, setStockById] = useState<Record<string, number>>({});

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const qty3 = (n: number) => roundQty(n).toFixed(3);

  // ---- helpers stock (a 3 decimales) ---------------------------------------
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
      total = addQty(total, Number(b.remaining || 0));
    });
    return roundQty(total);
  };

  const getDisponibleByName = async (productName: string) => {
    if (!productName) return 0;
    const all = await getDocs(collection(db, "inventory_batches"));
    let total = 0;
    all.forEach((d) => {
      const b = d.data() as any;
      const name = (b.productName || "").trim().toLowerCase();
      if (name === productName.trim().toLowerCase()) {
        total = addQty(total, Number(b.remaining || 0));
      }
    });
    return roundQty(total);
  };
  // --------------------------------------------------------------------------

  // Cargar productos (activos)
  useEffect(() => {
    (async () => {
      const snap = await getDocs(collection(db, "products"));
      const list: Product[] = [];
      snap.forEach((docSnap) => {
        const x = docSnap.data() as any;
        if (x?.active === false) return;
        list.push({
          id: docSnap.id,
          productName: x.name ?? x.productName ?? "(sin nombre)",
          price: Number(x.price ?? 0),
          measurement: x.measurement ?? "(sin unidad)",
          category: x.category ?? "(sin categoría)",
        });
      });
      setProducts(list);
    })();
  }, []);

  // 🔵 NUEVO: cargar existencias por productId para filtrar el selector
  useEffect(() => {
    (async () => {
      const snap = await getDocs(collection(db, "inventory_batches"));
      const m: Record<string, number> = {};
      snap.forEach((d) => {
        const x = d.data() as any;
        const pid = x.productId;
        const rem = Number(x.remaining || 0);
        if (pid) m[pid] = addQty(m[pid] || 0, rem);
      });
      // redondeo a 3 decimales como el resto del módulo
      Object.keys(m).forEach((k) => (m[k] = roundQty(m[k])));
      setStockById(m);
    })();
  }, []);

  // Cargar usuarios (igual que tenías)
  useEffect(() => {
    (async () => {
      const snap = await getDocs(collection(db, "users"));
      const list: Users[] = [];
      snap.forEach((docSnap) => {
        const x = docSnap.data() as any;
        list.push({
          id: docSnap.id,
          email: x.email ?? "(sin email)",
          role: x.role ?? "USER",
        });
      });
      setUsers(list);
    })();
  }, []);

  // Agregar producto al carrito (bloquea repetidos)
  const addSelectedProduct = async () => {
    if (!selectedProductId) return;
    const p = products.find((pp) => pp.id === selectedProductId);
    if (!p) return;
    if (items.some((it) => it.productId === p.id)) {
      setSelectedProductId("");
      return;
    }
    const stock = await getDisponibleByProductId(p.id);
    setItems((prev) => [
      ...prev,
      {
        productId: p.id,
        productName: p.productName,
        measurement: p.measurement,
        price: Number(p.price || 0),
        stock,
        qty: 0,
        discount: 0,
      },
    ]);
    setSelectedProductId("");
  };

  // Quitar producto
  const removeItem = (productId: string) => {
    setItems((prev) => prev.filter((it) => it.productId !== productId));
  };

  // Actualizar cantidad (solo cambia qty; existencias visibles = stock - qty)
  const setItemQty = async (productId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== productId) return it;
        const isUnit = (it.measurement || "").toLowerCase() !== "lb";
        const num = raw === "" ? 0 : Number(raw);
        const qty = isUnit ? Math.max(0, Math.round(num)) : roundQty(num);
        return { ...it, qty };
      })
    );
  };

  // Actualizar descuento (entero)
  const setItemDiscount = (productId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== productId) return it;
        const d = Math.max(0, Math.floor(Number(raw || 0)));
        return { ...it, discount: d };
      })
    );
  };

  // Recalcular total neto (precio×cantidad − descuento)
  const cartTotal = useMemo(() => {
    let sum = 0;
    for (const it of items) {
      const line = Number(it.price || 0) * Number(it.qty || 0);
      const net = Math.max(0, line - Math.max(0, Number(it.discount || 0)));
      sum += net;
    }
    return round2(sum);
  }, [items]);

  // Sincroniza total con tu campo amountCharged
  useEffect(() => {
    setAmountCharged(cartTotal);
  }, [cartTotal]);

  // Calcular vuelto
  useEffect(() => {
    const validReceived = Number(amountReceived) || 0;
    const validCharged = Number(amountCharged) || 0;
    setChange((validReceived - validCharged).toFixed(2));
  }, [amountReceived, amountCharged]);

  // Bloquear coma y permitir punto
  const numberKeyGuard = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ",") {
      e.preventDefault();
      (e.target as HTMLInputElement).value += ".";
    }
  };

  // Validación rápida
  const validate = async (): Promise<string | null> => {
    if (items.length === 0) return "Agrega al menos un producto.";
    for (const it of items) {
      if (!it.qty || it.qty <= 0) {
        return `Cantidad inválida para "${it.productName}".`;
      }
      const disponibleById = await getDisponibleByProductId(it.productId);
      if (!gteQty(disponibleById, it.qty)) {
        const disponibleByName = await getDisponibleByName(it.productName);
        if (gteQty(disponibleByName, 0) && !gteQty(disponibleById, 0)) {
          const changed = await fixBatchesProductIdByName(
            it.productName,
            it.productId
          );
          const dispAfter = await getDisponibleByProductId(it.productId);
          if (!gteQty(dispAfter, it.qty)) {
            return `Stock insuficiente tras corregir ${changed} lote(s) para "${it.productName}".`;
          }
        } else {
          return `Stock insuficiente para "${it.productName}". Disponible: ${disponibleById}`;
        }
      }
    }
    return null;
  };

  // Guardar venta (multi-ítem)
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage("");

    const err = await validate();
    if (err) {
      setMessage("❌ " + err);
      return;
    }

    try {
      setSaving(true); // 🔵 overlay ON

      // 1) Asignar FIFO y descontar por ítem
      const enriched = [];
      for (const it of items) {
        const qty = it.qty;
        const { allocations, avgUnitCost, cogsAmount } =
          await allocateFIFOAndUpdateBatches(db, it.productName, qty, false);

        const line = Number(it.price || 0) * Number(qty || 0);
        const discount = Math.max(0, Number(it.discount || 0));
        const net = Math.max(0, line - discount);

        enriched.push({
          productId: it.productId,
          productName: it.productName,
          measurement: it.measurement,
          unitPrice: Number(it.price || 0),
          qty,
          discount,
          lineTotal: round2(line),
          lineFinal: round2(net),
          allocations,
          avgUnitCost,
          cogsAmount,
        });
      }

      // 2) Totales
      const itemsTotal = enriched.reduce((a, x) => a + x.lineFinal, 0);
      const qtyTotal = enriched.reduce((a, x) => a + Number(x.qty || 0), 0);

      // 3) Registrar venta en salesV2
      await addDoc(collection(db, "salesV2"), {
        id: uuidv4(),
        quantity: qtyTotal,
        amount: itemsTotal,
        amountCharged: itemsTotal,
        amountReceived: Number(amountReceived) || 0,
        change: amountChange,
        clientName: clientName.trim(),

        timestamp: Timestamp.now(),
        date: saleDate,
        userEmail: users[0]?.email ?? "sin usuario",
        vendor: users[0]?.role ?? "sin usuario",
        status: "FLOTANTE",

        items: enriched,
        itemsTotal: itemsTotal,
      });

      setMessage("✅ Venta registrada y asignada a inventario (FIFO).");
      setItems([]);
      setSelectedProductId("");
      setAmountCharged(0);
      setAmountReceived(0);
      setChange("0");
      setClientName("");
      setSaleDate(format(new Date(), "yyyy-MM-dd"));
    } catch (err: any) {
      console.error(err);
      setMessage(`❌ ${err?.message || "Error al registrar la venta."}`);
    } finally {
      setSaving(false); // 🔵 overlay OFF
    }
  };

  // Productos ya elegidos (para bloquear en el select)
  const chosenIds = useMemo(
    () => new Set(items.map((i) => i.productId)),
    [items]
  );

  // 🔵 NUEVO: solo mostrar en el selector los que tienen stock > 0
  const selectableProducts = useMemo(
    () => products.filter((p) => (stockById[p.id] || 0) > 0),
    [products, stockById]
  );

  return (
    <div className="relative">
      <form
        onSubmit={handleSubmit}
        className="w-full mx-auto bg-white rounded-2xl shadow-2xl
                 p-4 sm:p-6 md:p-8
                 max-w-5xl space-y-4"
      >
        <div className="flex items-center justify-between">
          <h2 className="text-xl sm:text-2xl font-bold text-blue-700 whitespace-nowrap">
            Registrar venta (Pollo)
          </h2>
        </div>

        {/* Selector de producto */}
        <div className="space-y-1">
          <label className="block text-sm font-semibold text-gray-700">
            Producto | Precio por Libra/Unidad
          </label>
          <div className="flex gap-2">
            <select
              className="flex-1 border border-gray-300 p-2 rounded-2xl shadow-2xl focus:ring-2 focus:ring-blue-400"
              value={selectedProductId}
              onChange={(e) => setSelectedProductId(e.target.value)}
            >
              <option value="" disabled>
                Selecciona un producto
              </option>
              {selectableProducts.map((p) => (
                <option
                  key={p.id}
                  value={p.id}
                  disabled={chosenIds.has(p.id)}
                  title={
                    chosenIds.has(p.id)
                      ? "Ya está en la lista"
                      : `Disponible: ${qty3(stockById[p.id] || 0)}`
                  }
                >
                  {p.productName} — {p.measurement} — C$ {p.price} (disp:{" "}
                  {qty3(stockById[p.id] || 0)})
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={addSelectedProduct}
              disabled={!selectedProductId || chosenIds.has(selectedProductId)}
              className="px-3 py-2 rounded-2xl shadow-2xl bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Agregar
            </button>
          </div>
        </div>

        {/* Fecha / Cliente */}
        <div className="grid md:grid-cols-2 gap-3">
          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Fecha de la venta
            </label>
            <input
              type="date"
              className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl focus:ring-2 focus:ring-blue-400"
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Cliente
            </label>
            <input
              className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
              value={clientName}
              onChange={(e) => setClientName(e.target.value)}
              placeholder="Opcional"
            />
          </div>
        </div>

        {/* Lista de ítems */}
        <div className="rounded border overflow-x-auto shadow-2xl">
          <table className="min-w-full text-sm r">
            <thead className="bg-gray-100">
              <tr className="text-center">
                <th className="p-2 border whitespace-nowrap">Producto</th>
                <th className="p-2 border whitespace-nowrap">Precio</th>
                <th className="p-2 border whitespace-nowrap">Existencias</th>
                <th className="p-2 border whitespace-nowrap">Cantidad</th>
                <th className="p-2 border whitespace-nowrap">Descuento</th>
                <th className="p-2 border whitespace-nowrap">Monto</th>
                <th className="p-2 border">—</th>
              </tr>
            </thead>
            <tbody>
              {items.length === 0 ? (
                <tr>
                  <td colSpan={7} className="p-4 text-center text-gray-500">
                    Agrega productos al carrito.
                  </td>
                </tr>
              ) : (
                items.map((it) => {
                  const line = Number(it.price || 0) * Number(it.qty || 0);
                  const net = Math.max(
                    0,
                    line - Math.max(0, Number(it.discount || 0))
                  );
                  const isUnit = (it.measurement || "").toLowerCase() !== "lb";
                  const shownExist = roundQty(
                    Number(it.stock) - Number(it.qty || 0)
                  ); // 🔵 stock dinámico
                  return (
                    <tr key={it.productId} className="text-center">
                      <td className="p-2 border whitespace-nowrap">
                        {it.productName} — {it.measurement}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        C$ {round2(it.price).toFixed(2)}
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        {shownExist.toFixed(3)}
                      </td>
                      <td className="p-2 border">
                        <input
                          type="number"
                          step={isUnit ? 1 : 0.01}
                          inputMode={isUnit ? "numeric" : "decimal"}
                          className="w-28 border p-1 rounded text-right"
                          value={it.qty === 0 ? "" : it.qty}
                          onKeyDown={numberKeyGuard}
                          onChange={(e) =>
                            setItemQty(it.productId, e.target.value)
                          }
                          placeholder="0"
                          title="Cantidad"
                        />
                      </td>
                      <td className="p-2 border">
                        <input
                          type="number"
                          step={1}
                          min={0}
                          className="w-24 border p-1 rounded text-right"
                          value={it.discount === 0 ? "" : it.discount}
                          onChange={(e) =>
                            setItemDiscount(it.productId, e.target.value)
                          }
                          inputMode="numeric"
                          placeholder="0"
                          title="Descuento (entero C$)"
                        />
                      </td>
                      <td className="p-2 border whitespace-nowrap">
                        C$ {round2(net).toFixed(2)}
                      </td>
                      <td className="p-2 border">
                        <button
                          type="button"
                          className="px-2 py-1 rounded bg-red-100 text-red-600 hover:bg-red-200"
                          onClick={() => removeItem(it.productId)}
                          title="Quitar"
                        >
                          ✕
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Total de la venta (readOnly) */}
        <div className="space-y-1 ">
          <label className="block text-sm font-semibold text-gray-700 ">
            💵 Monto total
          </label>
          <input
            type="text"
            className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl bg-gray-100"
            value={`C$ ${amountCharged.toFixed(2)}`}
            readOnly
            title="Suma de (precio × cantidad − descuento) de cada producto."
          />
        </div>

        {/* Pago recibido / Cambio */}
        <div className="grid grid-cols-2 gap-x-3">
          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Monto recibido
            </label>
            <input
              type="number"
              step="0.01"
              inputMode="decimal"
              className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
              value={amountReceived === 0 ? "" : amountReceived}
              onChange={(e) => setAmountReceived(Number(e.target.value || 0))}
            />
          </div>
          <div className="space-y-1">
            <label className="block text-sm font-semibold text-gray-700">
              Cambio
            </label>
            <input
              type="text"
              className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl bg-gray-100"
              value={`C$ ${amountChange}`}
              readOnly
            />
          </div>
        </div>

        {/* Guardar */}
        <button
          type="submit"
          className="w-full bg-blue-600 text-white px-4 py-3 sm:py-2 rounded-2xl shadow-2xl font-semibold shadow hover:bg-blue-700 transition disabled:opacity-50"
          disabled={items.length === 0 || saving}
        >
          {saving ? "Guardando..." : "Guardar venta"}
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

      {/* 🔵 Overlay de guardado (igual estilo que ropa) */}
      {saving && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl border px-6 py-5">
            <div className="flex items-center gap-3">
              <svg
                className="animate-spin h-5 w-5"
                viewBox="0 0 24 24"
                fill="none"
              >
                <circle
                  className="opacity-25"
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="4"
                />
                <path
                  className="opacity-75"
                  fill="currentColor"
                  d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
                />
              </svg>
              <span className="font-semibold">Guardando venta…</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
