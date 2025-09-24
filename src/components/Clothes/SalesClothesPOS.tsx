// src/components/Clothes/SalesClothesPOS.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy, // (no usado para precio; lo dejo porque ya lo traías)
  query,
  Timestamp,
  where,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";

type ClientType = "CONTADO" | "CREDITO";
type Status = "ACTIVO" | "BLOQUEADO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

const PLACES = [
  "Altagracia",
  "Taguizapa",
  "El paso",
  "Calaysa",
  "Urbaite",
  "Las Pilas",
] as const;
type Place = (typeof PLACES)[number];

interface Customer {
  id: string;
  name: string;
  phone: string;
  place: Place | "";
  status: Status;
  creditLimit?: number;
  balance?: number;
}

interface Product {
  id: string;
  name: string;
  sku?: string;
}

interface ClothesBatch {
  id: string;
  productId: string;
  date: string; // yyyy-MM-dd
  remaining: number; // unidades
}

// 🔹 Helper: tomar salePrice del lote MÁS RECIENTE del producto (sin orderBy, sin índice)
async function getLatestSalePriceForClothes(
  productId: string
): Promise<number> {
  if (!productId) return 0;

  const q = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(q);

  let latest: {
    date: string;
    createdAt?: { seconds?: number; nanoseconds?: number };
    salePrice: number;
  } | null = null;

  snap.forEach((d) => {
    const x = d.data() as any;
    const salePrice = Number(x.salePrice || 0);
    const dateStr = String(x.date || "0000-00-00"); // yyyy-MM-dd
    const createdAt = x.createdAt; // Timestamp opcional

    if (!latest) {
      latest = { date: dateStr, createdAt, salePrice };
      return;
    }

    // Comparar por fecha; si empata, por createdAt
    const cmp = dateStr.localeCompare(latest.date);
    if (cmp > 0) {
      latest = { date: dateStr, createdAt, salePrice };
    } else if (cmp === 0) {
      const a =
        (createdAt?.seconds ?? 0) * 1000 + (createdAt?.nanoseconds ?? 0) / 1e6;
      const b =
        (latest.createdAt?.seconds ?? 0) * 1000 +
        (latest.createdAt?.nanoseconds ?? 0) / 1e6;
      if (a > b) latest = { date: dateStr, createdAt, salePrice };
    }
  });

  return Number(latest?.salePrice || 0);
}

function normalizePhone(input: string): string {
  const prefix = "+505 ";
  if (!input.startsWith(prefix)) {
    const digits = input.replace(/\D/g, "");
    return prefix + digits.slice(0, 8);
  }
  const rest = input.slice(prefix.length).replace(/\D/g, "");
  return prefix + rest.slice(0, 8);
}

export default function SalesClothesPOS() {
  // ===== Catálogos =====
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  // ===== Form venta =====
  const [clientType, setClientType] = useState<ClientType>("CONTADO");
  const [customerId, setCustomerId] = useState<string>("");
  const [customerNameCash, setCustomerNameCash] = useState<string>("");
  const [saleDate, setSaleDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );
  const [productId, setProductId] = useState<string>("");
  const [quantity, setQuantity] = useState<number>(0); // 👈 ahora inicia en 0
  const [totalAmount, setTotalAmount] = useState<number>(0);
  const [downPayment, setDownPayment] = useState<number>(0);

  // ✅ precio unitario para calcular total (precargado del inventario)
  const [unitPrice, setUnitPrice] = useState<number>(0);

  const [msg, setMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // ===== Modal "Nuevo cliente" =====
  const [showModal, setShowModal] = useState(false);
  const [mName, setMName] = useState("");
  const [mPhone, setMPhone] = useState("+505 ");
  const [mPlace, setMPlace] = useState<Place | "">("");
  const [mNotes, setMNotes] = useState("");
  const [mStatus, setMStatus] = useState<Status>("ACTIVO");
  const [mCreditLimit, setMCreditLimit] = useState<number>(0);
  const resetModal = () => {
    setMName("");
    setMPhone("+505 ");
    setMPlace("");
    setMNotes("");
    setMStatus("ACTIVO");
    setMCreditLimit(0);
  };

  // ===== Cargar catálogos =====
  useEffect(() => {
    (async () => {
      // Clientes
      const qC = query(
        collection(db, "customers_clothes"),
        orderBy("createdAt", "desc")
      );
      const cSnap = await getDocs(qC);
      const listC: Customer[] = [];
      cSnap.forEach((d) => {
        const x = d.data() as any;
        listC.push({
          id: d.id,
          name: x.name ?? "",
          phone: x.phone ?? "+505 ",
          place: x.place ?? "",
          status: (x.status as Status) ?? "ACTIVO",
          creditLimit: Number(x.creditLimit ?? 0),
          balance: 0,
        });
      });

      // Saldos
      for (const c of listC) {
        try {
          const qMov = query(
            collection(db, "ar_movements"),
            where("customerId", "==", c.id)
          );
          const mSnap = await getDocs(qMov);
          let sum = 0;
          mSnap.forEach((m) => (sum += Number((m.data() as any).amount || 0)));
          c.balance = sum;
        } catch {
          c.balance = 0;
        }
      }
      setCustomers(listC);

      // Productos
      const qP = query(
        collection(db, "products_clothes"),
        orderBy("createdAt", "desc")
      );
      const pSnap = await getDocs(qP);
      const listP: Product[] = [];
      pSnap.forEach((d) => {
        const x = d.data() as any;
        listP.push({
          id: d.id,
          name: x.name ?? "(sin nombre)",
          sku: x.sku ?? "",
        });
      });
      setProducts(listP);
    })();
  }, []);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId]
  );

  const currentBalance = selectedCustomer?.balance || 0;
  const projectedBalance =
    clientType === "CREDITO"
      ? currentBalance +
        Math.max(0, Number(totalAmount || 0)) -
        Math.max(0, Number(downPayment || 0))
      : 0;

  // 🔹 PRECARGAR PRECIO unitario desde inventario (lote más reciente)
  useEffect(() => {
    let alive = true;
    (async () => {
      if (!productId) {
        if (alive) setUnitPrice(0);
        return;
      }

      // 1) Buscar salePrice en inventory_clothes_batches (más reciente)
      let price = await getLatestSalePriceForClothes(productId);

      // 2) Fallback al precio del catálogo (por si faltara)
      if (!price) {
        const p = products.find((pp) => pp.id === productId) as any;
        price = Number(p?.price || 0);
      }

      if (alive) setUnitPrice(price);
    })();
    return () => {
      alive = false;
    };
  }, [productId, products]);

  // 🔹 Calcular total = precio × cantidad (2 decimales)
  useEffect(() => {
    const q = Number(quantity) || 0;
    const p = Number(unitPrice) || 0;
    const total = Math.floor(p * q * 100) / 100;
    setTotalAmount(total);
  }, [unitPrice, quantity]);

  // ===== Validaciones =====
  const validate = async (): Promise<string | null> => {
    if (!productId) return "Selecciona un producto.";
    if (!saleDate) return "Selecciona la fecha.";
    if (!Number.isInteger(Number(quantity)) || Number(quantity) <= 0)
      return "La cantidad debe ser un entero mayor a cero.";
    if (!(totalAmount > 0)) return "Ingresa el monto total (> 0).";
    if (clientType === "CONTADO") {
      if (!customerNameCash.trim())
        return "Ingresa el nombre del cliente (contado).";
    } else {
      if (!customerId) return "Selecciona un cliente (crédito).";
      if (downPayment < 0) return "El pago inicial no puede ser negativo.";
      if (downPayment > totalAmount)
        return "El pago inicial no puede superar el total.";
      if (selectedCustomer?.status === "BLOQUEADO")
        return "El cliente está BLOQUEADO. No se puede facturar a crédito.";
    }

    // 🚧 Validar inventario disponible (unidades) en inventory_clothes_batches
    const qB = query(
      collection(db, "inventory_clothes_batches"),
      where("productId", "==", productId)
    );
    const bSnap = await getDocs(qB);
    let available = 0;
    bSnap.forEach((d) => {
      const x = d.data() as any;
      available += Number(x.remaining || 0);
    });
    if (Number(quantity) > available) {
      return `Inventario insuficiente. Disponible: ${available} unidades.`;
    }
    return null;
  };

  // ===== Guardar venta =====
  const saveSale = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const err = await validate();
    if (err) {
      setMsg("❌ " + err);
      return;
    }

    try {
      setSaving(true);

      const prod = products.find((p) => p.id === productId);
      const payload: any = {
        type: clientType, // CONTADO | CREDITO
        date: saleDate,
        createdAt: Timestamp.now(),
        itemsTotal: Number(totalAmount) || 0,
        total: Number(totalAmount) || 0,
        quantity: Number(quantity) || 0,
        item: {
          productId,
          productName: prod?.name || "",
          sku: prod?.sku || "",
          qty: Number(quantity) || 0,
          total: Number(totalAmount) || 0,
        },
      };

      if (clientType === "CONTADO") {
        payload.customerName = customerNameCash.trim();
      } else {
        payload.customerId = customerId;
        payload.downPayment = Number(downPayment) || 0;
      }

      // 1) Crear venta
      const saleRef = await addDoc(collection(db, "sales_clothes"), payload);

      // 2) CxC si es crédito
      if (clientType === "CREDITO" && customerId) {
        const base = {
          customerId,
          date: saleDate,
          createdAt: Timestamp.now(),
          ref: { saleId: saleRef.id },
        };
        // CARGO
        await addDoc(collection(db, "ar_movements"), {
          ...base,
          type: "CARGO",
          amount: Number(totalAmount) || 0,
        });
        // ABONO inicial (opcional)
        if (Number(downPayment) > 0) {
          await addDoc(collection(db, "ar_movements"), {
            ...base,
            type: "ABONO",
            amount: -Number(downPayment),
          });
        }
      }

      // 3) Descontar INVENTARIO por FIFO (por fecha asc)
      let toConsume = Number(quantity) || 0;
      if (toConsume > 0) {
        const qB = query(
          collection(db, "inventory_clothes_batches"),
          where("productId", "==", productId)
        );
        const bSnap = await getDocs(qB);
        const batches: ClothesBatch[] = [];
        bSnap.forEach((d) => {
          const x = d.data() as any;
          batches.push({
            id: d.id,
            productId: x.productId,
            date: x.date || "",
            remaining: Number(x.remaining || 0),
          });
        });
        // Orden FIFO por date (asc)
        batches.sort((a, b) => a.date.localeCompare(b.date));

        for (const b of batches) {
          if (toConsume <= 0) break;
          if (b.remaining <= 0) continue;
          const use = Math.min(b.remaining, toConsume);
          toConsume -= use;
          await updateDoc(doc(db, "inventory_clothes_batches", b.id), {
            remaining: Number((b.remaining - use).toFixed(0)),
          });
        }
      }

      // Reset
      setClientType("CONTADO");
      setCustomerId("");
      setCustomerNameCash("");
      setSaleDate(new Date().toISOString().slice(0, 10));
      setProductId("");
      setQuantity(0); // vuelve a 0
      setTotalAmount(0);
      setDownPayment(0);
      setUnitPrice(0);

      // Recalcular saldos localmente si crédito
      if (clientType === "CREDITO" && customerId) {
        setCustomers((prev) =>
          prev.map((c) =>
            c.id === customerId
              ? {
                  ...c,
                  balance:
                    (c.balance || 0) +
                    (Number(totalAmount) || 0) -
                    (Number(downPayment) || 0),
                }
              : c
          )
        );
      }

      setMsg("✅ Venta registrada");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar la venta");
    } finally {
      setSaving(false);
    }
  };

  // ===== Crear cliente desde modal =====
  const createCustomerFromModal = async () => {
    setMsg("");
    if (!mName.trim()) {
      setMsg("Ingresa el nombre del nuevo cliente.");
      return;
    }
    const cleanPhone = normalizePhone(mPhone);
    try {
      const ref = await addDoc(collection(db, "customers_clothes"), {
        name: mName.trim(),
        phone: cleanPhone,
        place: mPlace || "",
        notes: mNotes || "",
        status: mStatus,
        creditLimit: Number(mCreditLimit || 0),
        createdAt: Timestamp.now(),
      });

      const newC: Customer = {
        id: ref.id,
        name: mName.trim(),
        phone: cleanPhone,
        place: mPlace || "",
        status: mStatus,
        creditLimit: Number(mCreditLimit || 0),
        balance: 0,
      };

      setCustomers((prev) => [newC, ...prev]);
      setCustomerId(ref.id); // queda seleccionado
      resetModal();
      setShowModal(false);
      setMsg("✅ Cliente creado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al crear cliente");
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-2xl font-bold mb-3">Ventas (Ropa)</h2>

      <form
        onSubmit={saveSale}
        className="bg-white p-4 rounded shadow border mb-6 grid grid-cols-1 md:grid-cols-2 gap-4"
      >
        {/* Tipo de cliente */}
        <div>
          <label className="block text-sm font-semibold">Tipo de cliente</label>
          <select
            className="w-full border p-2 rounded"
            value={clientType}
            onChange={(e) => setClientType(e.target.value as ClientType)}
          >
            <option value="CONTADO">Contado</option>
            <option value="CREDITO">Crédito</option>
          </select>
        </div>

        {/* Cliente contado o crédito */}
        {clientType === "CONTADO" ? (
          <div>
            <label className="block text-sm font-semibold">
              Nombre del cliente (contado)
            </label>
            <input
              className="w-full border p-2 rounded"
              placeholder="Ej: Cliente Mostrador"
              value={customerNameCash}
              onChange={(e) => setCustomerNameCash(e.target.value)}
            />
          </div>
        ) : (
          <div className="md:col-span-2">
            <label className="block text-sm font-semibold">
              Cliente (crédito)
            </label>
            <div className="flex gap-2">
              <select
                className="flex-1 border p-2 rounded"
                value={customerId}
                onChange={(e) => setCustomerId(e.target.value)}
              >
                <option value="">Selecciona un cliente</option>
                {customers.map((c) => (
                  <option
                    key={c.id}
                    value={c.status === "ACTIVO" ? c.id : ""}
                    disabled={c.status === "BLOQUEADO"}
                  >
                    {c.name} | {c.phone} | Saldo: {money(c.balance || 0)}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="px-20 py-2 rounded bg-green-600 text-white hover:bg-green-700"
                onClick={() => setShowModal(true)}
              >
                Crear Cliente
              </button>
            </div>

            {/* Saldos */}
            <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-2 rounded bg-gray-50 border">
                <div className="text-xs text-gray-600">Saldo actual</div>
                <div className="text-lg font-semibold">
                  {money(currentBalance)}
                </div>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Pago inicial (opcional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={downPayment === 0 ? "" : downPayment}
                  onChange={(e) =>
                    setDownPayment(Math.max(0, Number(e.target.value || 0)))
                  }
                  placeholder="0.00"
                />
              </div>
              <div className="p-2 rounded bg-gray-50 border">
                <div className="text-xs text-gray-600">Saldo proyectado</div>
                <div className="text-lg font-semibold">
                  {money(projectedBalance)}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Producto */}
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Producto</label>
          <select
            className="w-full border p-2 rounded"
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
          >
            <option value="">Selecciona un producto</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} {p.sku ? `— ${p.sku}` : ""}
              </option>
            ))}
          </select>
        </div>

        {/* Fecha */}
        <div>
          <label className="block text-sm font-semibold">Fecha de venta</label>
          <input
            type="date"
            className="w-full border p-2 rounded"
            value={saleDate}
            onChange={(e) => setSaleDate(e.target.value)}
          />
        </div>

        {/* Cantidad (entero) */}
        <div>
          <label className="block text-sm font-semibold">
            Cantidad (piezas)
          </label>
          <input
            type="number"
            step="1"
            min={0}
            className="w-full border p-2 rounded"
            value={Number.isNaN(quantity) || quantity === 0 ? "" : quantity}
            onChange={(e) => {
              const v = e.target.value;
              if (v === "") {
                setQuantity(0);
                return;
              }
              const n = Math.max(0, Math.floor(Number(v)));
              setQuantity(n);
            }}
            inputMode="numeric"
            placeholder="0"
          />
        </div>

        {/* Precio unitario (auto, readOnly) */}
        <div>
          <label className="block text-sm font-semibold">
            Precio unitario (pza)
          </label>
          <input
            type="text"
            className="w-full border p-2 rounded bg-gray-100"
            value={money(unitPrice)}
            readOnly
            title="Se precarga desde el inventario (salePrice del lote más reciente)."
          />
        </div>

        {/* Total (auto, readOnly) */}
        <div>
          <label className="block text-sm font-semibold">Monto total</label>
          <input
            type="text"
            className="w-full border p-2 rounded bg-gray-100"
            value={money(totalAmount)}
            readOnly
          />
          <div className="text-xs text-gray-500 mt-1">
            Se calcula automáticamente (precio × cantidad).
          </div>
        </div>

        {/* Botón guardar */}
        <div className="md:col-span-2">
          <button
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
            disabled={saving}
          >
            {saving ? "Guardando..." : "Registrar venta"}
          </button>
        </div>
      </form>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* ===== Modal: Crear cliente rápido ===== */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-xl p-4">
            <h3 className="text-lg font-bold mb-3">Nuevo cliente</h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-semibold">Nombre</label>
                <input
                  className="w-full border p-2 rounded"
                  value={mName}
                  onChange={(e) => setMName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">Teléfono</label>
                <input
                  className="w-full border p-2 rounded"
                  value={mPhone}
                  onChange={(e) => setMPhone(normalizePhone(e.target.value))}
                  placeholder="+505 88888888"
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="block text-sm font-semibold">Lugar</label>
                <select
                  className="w-full border p-2 rounded"
                  value={mPlace}
                  onChange={(e) => setMPlace(e.target.value as Place)}
                >
                  <option value="">—</option>
                  {PLACES.map((p) => (
                    <option key={p} value={p}>
                      {p}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">Estado</label>
                <select
                  className="w-full border p-2 rounded"
                  value={mStatus}
                  onChange={(e) => setMStatus(e.target.value as Status)}
                >
                  <option value="ACTIVO">ACTIVO</option>
                  <option value="BLOQUEADO">BLOQUEADO</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-semibold">
                  Límite de crédito (opcional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={mCreditLimit === 0 ? "" : mCreditLimit}
                  onChange={(e) =>
                    setMCreditLimit(Math.max(0, Number(e.target.value || 0)))
                  }
                  placeholder="Ej: 2000"
                />
              </div>
              <div className="md:col-span-2">
                <label className="block text-sm font-semibold">
                  Comentario
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-20"
                  value={mNotes}
                  onChange={(e) => setMNotes(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => {
                  resetModal();
                  setShowModal(false);
                }}
              >
                Cancelar
              </button>
              <button
                className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
                onClick={createCustomerFromModal}
              >
                Guardar cliente
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
