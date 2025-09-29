// src/components/Clothes/SalesClothesPOS.tsx
import { allocateSaleFIFOClothes } from "../../Services/inventory_clothes";
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
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

interface SelectedItem {
  productId: string;
  productName: string;
  sku?: string;
  unitPrice: number; // precio del lote más reciente
  available: number; // existencias actuales
  qty: number; // piezas
  discount: number; // NUEVO: entero (C$) aplicado a este ítem
}

// Helpers
async function getLatestSalePriceForClothes(
  productId: string
): Promise<number> {
  if (!productId) return 0;
  const qRef = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(qRef);

  let bestDate = "0000-00-00";
  let bestCreatedAtMs = -1;
  let bestSalePrice = 0;

  snap.forEach((d) => {
    const x = d.data() as any;
    const dateStr: string = String(x.date || "0000-00-00");
    const salePrice: number = Number(x.salePrice || 0);
    const ca = x.createdAt;
    const createdAtMs =
      (ca?.seconds ?? 0) * 1000 + (ca?.nanoseconds ?? 0) / 1e6;

    if (dateStr > bestDate) {
      bestDate = dateStr;
      bestCreatedAtMs = createdAtMs;
      bestSalePrice = salePrice;
    } else if (dateStr === bestDate && createdAtMs > bestCreatedAtMs) {
      bestCreatedAtMs = createdAtMs;
      bestSalePrice = salePrice;
    }
  });

  return Number(bestSalePrice || 0);
}

async function getAvailableUnitsForClothes(productId: string): Promise<number> {
  if (!productId) return 0;
  const qRef = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(qRef);
  let available = 0;
  snap.forEach((d) => (available += Number((d.data() as any).remaining || 0)));
  return available;
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
  // Catálogos
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);

  // 🔵 Stock por producto (para mostrar/en gris en el selector)
  const [stockByProduct, setStockByProduct] = useState<Record<string, number>>(
    {}
  );

  // Generales
  const [clientType, setClientType] = useState<ClientType>("CONTADO");
  const [customerId, setCustomerId] = useState<string>("");
  const [customerNameCash, setCustomerNameCash] = useState<string>("");
  const [saleDate, setSaleDate] = useState<string>(
    new Date().toISOString().slice(0, 10)
  );

  // Selección de productos (múltiple)
  const [productId, setProductId] = useState<string>("");
  const [items, setItems] = useState<SelectedItem[]>([]);

  // Totales
  const totalPieces = useMemo(
    () => items.reduce((acc, it) => acc + (it.qty || 0), 0),
    [items]
  );
  const totalAmount = useMemo(() => {
    const sum = items.reduce((acc, it) => {
      const line = Math.max(
        0,
        (Number(it.unitPrice) || 0) * (it.qty || 0) - (Number(it.discount) || 0)
      );
      return acc + line;
    }, 0);
    return Math.floor(sum * 100) / 100;
  }, [items]);

  const [downPayment, setDownPayment] = useState<number>(0);
  const [msg, setMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // Modal cliente
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

  // Cargar catálogos
  useEffect(() => {
    (async () => {
      // clientes
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
      // saldos
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

      // productos
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

      // 🔵 cargar stock disponible por productId (solo remaining > 0)
      const qStock = query(
        collection(db, "inventory_clothes_batches"),
        where("remaining", ">", 0)
      );
      const sSnap = await getDocs(qStock);
      const map: Record<string, number> = {};
      sSnap.forEach((d) => {
        const b = d.data() as any;
        const pid = b.productId || "";
        const rem = Number(b.remaining || 0);
        if (!pid) return;
        map[pid] = (map[pid] || 0) + rem;
      });
      setStockByProduct(map);
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

  // Añadir producto (bloquea duplicados)
  const addProductToList = async (pid: string) => {
    if (!pid) return;
    if (items.some((it) => it.productId === pid)) {
      setProductId("");
      return;
    }

    const prod = products.find((p) => p.id === pid);
    if (!prod) {
      setProductId("");
      return;
    }

    let price = await getLatestSalePriceForClothes(pid);
    if (!price) price = Number((prod as any)?.price || 0);
    const available = await getAvailableUnitsForClothes(pid);

    const newItem: SelectedItem = {
      productId: pid,
      productName: prod.name || "",
      sku: prod.sku || "",
      unitPrice: Number(price) || 0,
      available: Number(available) || 0,
      qty: 0,
      discount: 0, // NUEVO
    };
    setItems((prev) => [...prev, newItem]);
    setProductId("");
  };

  const setItemQty = (pid: string, qtyRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (qtyRaw === "") return { ...it, qty: 0 };
        const n = Math.max(0, Math.floor(Number(qtyRaw)));
        return { ...it, qty: n };
      })
    );
  };

  // NUEVO: actualizar descuento (entero)
  const setItemDiscount = (pid: string, discRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (discRaw === "") return { ...it, discount: 0 };
        // Solo enteros >= 0
        const n = Math.max(0, Math.floor(Number(discRaw)));
        return { ...it, discount: n };
      })
    );
  };

  const removeItem = (pid: string) =>
    setItems((prev) => prev.filter((it) => it.productId !== pid));

  // Validaciones
  const validate = async (): Promise<string | null> => {
    if (!saleDate) return "Selecciona la fecha.";
    if (items.length === 0) return "Agrega al menos un producto.";
    const itemsWithQty = items.filter((it) => (it.qty || 0) > 0);
    if (itemsWithQty.length === 0)
      return "Debes ingresar cantidades (> 0) en al menos un producto.";
    if (!(totalAmount > 0)) return "El total debe ser mayor a cero.";

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

    // Stock y descuentos por ítem
    for (const it of itemsWithQty) {
      const available = await getAvailableUnitsForClothes(it.productId);
      if (it.qty > available)
        return `Inventario insuficiente para "${it.productName}". Disponible: ${available} unidades.`;
      const lineGross = (Number(it.unitPrice) || 0) * (it.qty || 0);
      const disc = Number(it.discount) || 0;
      if (!Number.isInteger(disc) || disc < 0)
        return `El descuento en "${it.productName}" debe ser entero y ≥ 0.`;
      if (disc > lineGross)
        return `El descuento en "${
          it.productName
        }" no puede exceder C$ ${lineGross.toFixed(2)}.`;
    }
    return null;
  };

  // Guardar
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

      const itemsToSave = items
        .filter((it) => (it.qty || 0) > 0)
        .map((it) => {
          const lineGross = (Number(it.unitPrice) || 0) * (it.qty || 0);
          const disc = Math.max(0, Math.floor(Number(it.discount) || 0));
          const lineNet = Math.max(0, lineGross - disc);
          return {
            productId: it.productId,
            productName: it.productName,
            sku: it.sku || "",
            qty: it.qty,
            unitPrice: Number(it.unitPrice) || 0,
            discount: disc, // NUEVO
            total: Math.floor(lineNet * 100) / 100,
          };
        });

      const payload: any = {
        type: clientType,
        date: saleDate,
        createdAt: Timestamp.now(),
        itemsTotal: Number(totalAmount) || 0,
        total: Number(totalAmount) || 0,
        quantity: Number(totalPieces) || 0,
        items: itemsToSave,
      };

      if (clientType === "CONTADO") {
        payload.customerName = customerNameCash.trim();
      } else {
        payload.customerId = customerId;
        payload.downPayment = Number(downPayment) || 0;
      }

      // 1) Crear venta
      const saleRef = await addDoc(collection(db, "sales_clothes"), payload);

      // 2) CxC crédito
      if (clientType === "CREDITO" && customerId) {
        const base = {
          customerId,
          date: saleDate,
          createdAt: Timestamp.now(),
          ref: { saleId: saleRef.id },
        };
        await addDoc(collection(db, "ar_movements"), {
          ...base,
          type: "CARGO",
          amount: Number(totalAmount) || 0,
        });
        if (Number(downPayment) > 0) {
          await addDoc(collection(db, "ar_movements"), {
            ...base,
            type: "ABONO",
            amount: -Number(downPayment),
          });
        }
      }

      // 3) FIFO por producto
      const allocationsByItem: Record<
        string,
        { productId: string; allocations: any[] }
      > = {};
      for (const it of itemsToSave) {
        if (it.qty > 0) {
          const { allocations } = await allocateSaleFIFOClothes({
            productId: it.productId,
            quantity: it.qty,
            saleDate,
            saleId: saleRef.id,
          });
          allocationsByItem[it.productId] = {
            productId: it.productId,
            allocations,
          };
        }
      }

      // 4) Guardar allocations
      await updateDoc(doc(db, "sales_clothes", saleRef.id), {
        allocationsByItem,
      });

      // Reset
      setClientType("CONTADO");
      setCustomerId("");
      setCustomerNameCash("");
      setSaleDate(new Date().toISOString().slice(0, 10));
      setItems([]);
      setDownPayment(0);

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

      // 🔵 Actualizar mapa de stock tras la venta (para el selector)
      (async () => {
        const qStock = query(
          collection(db, "inventory_clothes_batches"),
          where("remaining", ">", 0)
        );
        const sSnap = await getDocs(qStock);
        const map: Record<string, number> = {};
        sSnap.forEach((d) => {
          const b = d.data() as any;
          const pid = b.productId || "";
          const rem = Number(b.remaining || 0);
          if (!pid) return;
          map[pid] = (map[pid] || 0) + rem;
        });
        setStockByProduct(map);
      })();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar la venta");
    } finally {
      setSaving(false);
    }
  };

  // UI
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

        {/* Selector de producto (agrega a lista) */}
        <div className="md:col-span-2">
          <label className="block text-sm font-semibold">Producto</label>
          <select
            className="w-full border p-2 rounded"
            value={productId}
            onChange={async (e) => {
              const pid = e.target.value;
              setProductId(pid);
              await addProductToList(pid);
            }}
          >
            <option value="">Selecciona un producto</option>
            {products.map((p) => {
              const already = items.some((it) => it.productId === p.id);
              const stock = stockByProduct[p.id] || 0;
              const disabled = already || stock <= 0;
              return (
                <option
                  key={p.id}
                  value={disabled ? "" : p.id}
                  disabled={disabled}
                >
                  {p.name} {p.sku ? `— ${p.sku}` : ""}{" "}
                  {stock > 0 ? `(disp: ${stock})` : "(sin stock)"}
                  {already ? " (seleccionado)" : ""}
                </option>
              );
            })}
          </select>
          <div className="text-xs text-gray-500 mt-1">
            Productos sin existencias se muestran en gris y no se pueden
            seleccionar.
          </div>
        </div>

        {/* Lista de productos seleccionados */}
        <div className="md:col-span-2">
          <div className="border rounded overflow-hidden">
            <div className="grid grid-cols-12 bg-gray-50 px-3 py-2 text-xs font-semibold border-b">
              <div className="col-span-4">Producto</div>
              <div className="col-span-2 text-right">Precio</div>
              <div className="col-span-2 text-right">Existencias</div>
              <div className="col-span-1 text-right">Cantidad</div>
              <div className="col-span-1 text-right">Descuento</div>
              {/* NUEVO */}
              <div className="col-span-1 text-right">Monto</div>
              {/* NUEVO */}
              <div className="col-span-1 text-center">Quitar</div>
            </div>

            {items.length === 0 ? (
              <div className="px-3 py-4 text-sm text-gray-500">
                No hay productos agregados.
              </div>
            ) : (
              items.map((it) => {
                const visualStock = Math.max(
                  0,
                  (it.available || 0) - (it.qty || 0)
                );
                const lineGross = (Number(it.unitPrice) || 0) * (it.qty || 0);
                const lineNet = Math.max(
                  0,
                  lineGross - (Number(it.discount) || 0)
                );

                return (
                  <div
                    key={it.productId}
                    className="grid grid-cols-12 items-center px-3 py-2 border-b text-sm gap-x-2"
                  >
                    <div className="col-span-4">
                      {/* Nombre + SKU concatenado */}
                      <div className="font-medium">
                        {it.productName}
                        {it.sku ? ` — ${it.sku}` : ""}
                      </div>
                    </div>

                    <div className="col-span-2 text-right">
                      {money(it.unitPrice)}
                    </div>
                    <div className="col-span-2 text-right">{visualStock}</div>

                    <div className="col-span-1">
                      <input
                        type="number"
                        step="0"
                        min={0}
                        className="w-full border p-1 rounded text-right"
                        value={
                          Number.isNaN(it.qty) || it.qty === 0 ? "" : it.qty
                        }
                        onChange={(e) =>
                          setItemQty(it.productId, e.target.value)
                        }
                        inputMode="numeric"
                        placeholder="0"
                        title="Cantidad de piezas"
                      />
                    </div>

                    {/* NUEVO: Descuento entero */}
                    <div className="col-span-1">
                      <input
                        type="number"
                        step="1"
                        min={0}
                        className="w-full border p-1 rounded text-right"
                        value={
                          Number.isNaN(it.discount) || it.discount === 0
                            ? ""
                            : it.discount
                        }
                        onChange={(e) =>
                          setItemDiscount(it.productId, e.target.value)
                        }
                        inputMode="numeric"
                        placeholder="0"
                        title="Descuento entero (C$)"
                      />
                    </div>

                    {/* NUEVO: Monto por fila */}
                    <div className="col-span-1 text-right">
                      {money(lineNet)}
                    </div>

                    <div className="col-span-1 text-center">
                      <button
                        type="button"
                        className="px-2 py-1 rounded bg-red-100 hover:bg-red-200"
                        onClick={() => removeItem(it.productId)}
                        title="Quitar producto"
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>

          {items.length > 0 && (
            <div className="flex justify-end gap-6 mt-3 text-sm">
              <div>
                <span className="text-gray-600">Piezas totales: </span>
                <span className="font-semibold">{totalPieces}</span>
              </div>
              <div>
                <span className="text-gray-600">Total: </span>
                <span className="font-semibold">{money(totalAmount)}</span>
              </div>
            </div>
          )}
        </div>

        {/* Guardar */}
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

      {/* Modal: Crear cliente rápido */}
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
                onClick={async () => {
                  setMsg("");
                  if (!mName.trim()) {
                    setMsg("Ingresa el nombre del nuevo cliente.");
                    return;
                  }
                  const cleanPhone = normalizePhone(mPhone);
                  try {
                    const ref = await addDoc(
                      collection(db, "customers_clothes"),
                      {
                        name: mName.trim(),
                        phone: cleanPhone,
                        place: mPlace || "",
                        notes: mNotes || "",
                        status: mStatus,
                        creditLimit: Number(mCreditLimit || 0),
                        createdAt: Timestamp.now(),
                      }
                    );
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
                    setCustomerId(ref.id);
                    resetModal();
                    setShowModal(false);
                    setMsg("✅ Cliente creado");
                  } catch (e) {
                    console.error(e);
                    setMsg("❌ Error al crear cliente");
                  }
                }}
              >
                Guardar cliente
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 🔵 Overlay de guardado */}
      {saving && (
        <div className="fixed inset-0 z-[70] bg-black/40 flex items-center justify-center">
          <div className="bg-white rounded-lg shadow-xl border px-4 py-3 flex items-center gap-3">
            <svg
              className="h-5 w-5 animate-spin"
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
            <span className="font-medium">Guardando venta…</span>
          </div>
        </div>
      )}
    </div>
  );
}
