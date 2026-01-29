// src/components/SaleForm.tsx
import React, { useEffect, useMemo, useState } from "react";
import { db } from "../../firebase";
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
import { Role } from "../../apis/apis";
import { hasRole } from "../../utils/roles";
import allocateFIFOAndUpdateBatches from "../../Services/allocateFIFO";
import { roundQty, addQty, gteQty } from "../../Services/decimal";

// --- FIX RÁPIDO: actualizar productId en lotes por NOMBRE (usar solo si hay desfasados)
async function fixBatchesProductIdByName(
  productName: string,
  newProductId: string,
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
  price: number; // precio normal (catálogo)
  specialPrice: number; // ✅ NUEVO: precio especial digitado (0 = no aplica)
  stock: number; // existencias calculadas
  qty: number; // cantidad elegida
  qtyInput?: string; // texto temporal para permitir decimales
  specialPriceInput?: string; // texto temporal para precio sugerido
  discount: number; // entero C$ por línea
  discountInput?: string; // texto temporal para descuento
};

// ===== Crédito / Clientes (Pollo) =====
type ClientType = "CONTADO" | "CREDITO";
type Status = "ACTIVO" | "BLOQUEADO";

interface CustomerPollo {
  id: string;
  name: string;
  phone?: string;
  status: Status;
  creditLimit?: number;
  balance?: number;
  vendorId?: string; // si después querés filtrar por vendedor
  vendorName?: string;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

export default function SaleForm({
  user,
  role,
  roles,
}: {
  user: any;
  role?: string;
  roles?: string[];
}) {
  const subject = roles && roles.length ? roles : role;
  // ===== Catálogos =====
  const [products, setProducts] = useState<Product[]>([]);
  const [users, setUsers] = useState<Users[]>([]);

  // ===== Form =====
  const [selectedProductId, setSelectedProductId] = useState("");
  const [saleDate, setSaleDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [clientName, setClientName] = useState("");

  // mobile product search
  const [productQuery, setProductQuery] = useState("");

  // Carrito
  const [items, setItems] = useState<CartItem[]>([]);

  // Totales (mantengo tus nombres para compatibilidad)
  const [amountCharged, setAmountCharged] = useState<number>(0); // total neto
  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  const [message, setMessage] = useState("");

  // 🔵 overlay de guardado
  const [saving, setSaving] = useState(false);

  // 🔵 mapa de existencias por productId para filtrar el selector
  const [stockById, setStockById] = useState<Record<string, number>>({});

  const round2 = (n: number) => Math.round(n * 100) / 100;
  const qty3 = (n: number) => roundQty(n).toFixed(3);

  // ===== Tipo de cliente (CONTADO/CRÉDITO) =====
  const [clientType, setClientType] = useState<ClientType>("CONTADO");

  // ===== Clientes crédito =====
  const [customers, setCustomers] = useState<CustomerPollo[]>([]);
  const [customerId, setCustomerId] = useState<string>("");
  const [downPayment, setDownPayment] = useState<number>(0);

  const handleClientTypeChange = (v: ClientType) => {
    setClientType(v);

    if (v === "CREDITO") {
      // En crédito: no usamos recibido/cambio, y contado no aplica
      setClientName("");
      setAmountReceived(0);
      setChange("0.00");
    } else {
      // En contado: no usamos customer/downPayment
      setCustomerId("");
      setDownPayment(0);
    }
  };

  // ✅ precio aplicado por línea (si specialPrice > 0 usa ese; si no, usa price normal)
  const getAppliedUnitPrice = (
    it: Pick<CartItem, "price" | "specialPrice">,
  ) => {
    const sp = Number(it.specialPrice || 0);
    return sp > 0 ? sp : Number(it.price || 0);
  };

  // ---- helpers stock (a 3 decimales) ---------------------------------------
  const getDisponibleByProductId = async (productId: string) => {
    if (!productId) return 0;
    const qId = query(
      collection(db, "inventory_batches"),
      where("productId", "==", productId),
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

  // cargar existencias por productId para filtrar el selector
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
        specialPrice: 0, // ✅ NUEVO
        stock,
        qty: 0,
        qtyInput: "",
        specialPriceInput: "",
        discount: 0,
        discountInput: "",
      },
    ]);
    setSelectedProductId("");
  };

  // Add product by id (used by mobile auto-add on select)
  const addProductById = async (productId: string) => {
    if (!productId) return;
    const p = products.find((pp) => pp.id === productId);
    if (!p) return;
    if (items.some((it) => it.productId === p.id)) return;
    const stock = await getDisponibleByProductId(p.id);
    setItems((prev) => [
      ...prev,
      {
        productId: p.id,
        productName: p.productName,
        measurement: p.measurement,
        price: Number(p.price || 0),
        specialPrice: 0,
        stock,
        qty: 0,
        qtyInput: "",
        specialPriceInput: "",
        discount: 0,
        discountInput: "",
      },
    ]);
    setSelectedProductId("");
  };

  // Quitar producto
  const removeItem = (productId: string) => {
    setItems((prev) => prev.filter((it) => it.productId !== productId));
  };

  const normalizeDecimalInput = (raw: string) => {
    const cleaned = String(raw || "").replace(",", ".");
    if (cleaned === "") return "";
    const parts = cleaned.split(".");
    if (parts.length === 1) return cleaned;
    return `${parts[0]}.${parts.slice(1).join("")}`;
  };

  // Actualizar cantidad (solo cambia qty; existencias visibles = stock - qty)
  const setItemQty = async (productId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== productId) return it;
        const isUnit = (it.measurement || "").toLowerCase() !== "lb";
        const txt = normalizeDecimalInput(raw);

        if (txt.trim() === "") {
          return { ...it, qty: 0, qtyInput: "" };
        }

        if (!isUnit && txt === ".") {
          return { ...it, qty: 0, qtyInput: "0." };
        }

        const parsed = Number(txt);
        const num = Number.isFinite(parsed) ? parsed : 0;
        let qty = isUnit ? Math.max(0, Math.round(num)) : roundQty(num);

        // Limitar qty a las existencias conocidas (stock)
        const stockAvailable = isUnit
          ? Math.max(0, Math.floor(Number(it.stock || 0)))
          : roundQty(Number(it.stock || 0));

        if (qty > stockAvailable) {
          qty = stockAvailable;
          setMessage(`⚠️ Cantidad limitada a existencias (${stockAvailable})`);
          const limitedInput = isUnit
            ? String(qty)
            : qty === 0
              ? ""
              : String(qty);
          return { ...it, qty, qtyInput: limitedInput };
        }

        const nextInput = isUnit
          ? String(qty)
          : txt.endsWith(".")
            ? txt
            : String(qty);

        return { ...it, qty, qtyInput: nextInput };
      }),
    );
  };

  // ✅ NUEVO: actualizar precio especial
  const setItemSpecialPrice = (productId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== productId) return it;
        const txt = normalizeDecimalInput(raw);

        if (txt.trim() === "") {
          return { ...it, specialPrice: 0, specialPriceInput: "" };
        }

        if (txt === ".") {
          return { ...it, specialPrice: 0, specialPriceInput: "0." };
        }

        const num = Number(txt);
        const safe = Number.isFinite(num) ? Math.max(0, round2(num)) : 0;
        const nextInput = txt.endsWith(".") ? txt : String(safe);
        return { ...it, specialPrice: safe, specialPriceInput: nextInput };
      }),
    );
  };

  // Actualizar descuento (entero)
  const setItemDiscount = (productId: string, raw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== productId) return it;
        const txt = normalizeDecimalInput(raw);

        if (txt.trim() === "") {
          return { ...it, discount: 0, discountInput: "" };
        }

        if (txt === ".") {
          return { ...it, discount: 0, discountInput: "0." };
        }

        const num = Number(txt);
        const safe = Number.isFinite(num) ? Math.max(0, Math.floor(num)) : 0;
        const nextInput = txt.endsWith(".") ? txt : String(safe);
        return { ...it, discount: safe, discountInput: nextInput };
      }),
    );
  };

  // ✅ Recalcular total neto usando PRECIO APLICADO (special si existe)
  const cartTotal = useMemo(() => {
    let sum = 0;
    for (const it of items) {
      const unitApplied = getAppliedUnitPrice(it);
      const line = Number(unitApplied || 0) * Number(it.qty || 0);
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

  // responsive: mobile only UI
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  // ===== Cargar clientes (Pollo) + saldo desde CxC =====
  useEffect(() => {
    (async () => {
      try {
        // clientes pollo
        const cSnap = await getDocs(collection(db, "customers_pollo"));
        const list: CustomerPollo[] = [];
        cSnap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name ?? "",
            phone: x.phone ?? "",
            status: (x.status as Status) ?? "ACTIVO",
            creditLimit: Number(x.creditLimit ?? 0),
            vendorId: x.vendorId ?? "",
            vendorName: x.vendorName ?? "",
            balance: 0,
          });
        });

        // saldos por cliente (ar_movements_pollo)
        for (const c of list) {
          try {
            const qMov = query(
              collection(db, "ar_movements_pollo"),
              where("customerId", "==", c.id),
            );
            const mSnap = await getDocs(qMov);
            let sum = 0;
            mSnap.forEach((m) => {
              sum += Number((m.data() as any).amount || 0);
            });

            const initialDebt = Number((c as any).initialDebt || 0);
            c.balance = sum + initialDebt;
          } catch {
            c.balance = 0;
          }
        }

        // orden alfabético
        list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
        setCustomers(list);
      } catch (e) {
        console.error("Error cargando customers_pollo:", e);
        setCustomers([]);
      }
    })();
  }, []);

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId) || null,
    [customers, customerId],
  );

  const currentBalance = Number(selectedCustomer?.balance || 0);

  const maxDownPayment =
    clientType === "CREDITO"
      ? Math.max(
          0,
          Number(currentBalance || 0) + Math.max(0, Number(amountCharged || 0)),
        )
      : 0;

  useEffect(() => {
    if (clientType !== "CREDITO") return;
    setDownPayment((prev) =>
      Math.min(Math.max(0, Number(prev || 0)), maxDownPayment),
    );
  }, [clientType, maxDownPayment]);

  useEffect(() => {
    if (clientType === "CREDITO") {
      setAmountReceived(Number(downPayment || 0));
      setChange("0.00");
    }
  }, [clientType, downPayment]);

  const projectedBalance =
    clientType === "CREDITO"
      ? currentBalance +
        Math.max(0, Number(amountCharged || 0)) -
        Math.max(0, Number(downPayment || 0))
      : 0;

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
            it.productId,
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
      setSaving(true);

      // 1) Asignar FIFO y descontar por ítem
      const enriched = [];

      if (clientType === "CONTADO") {
        if (!clientName.trim())
          return "Ingresa el nombre del cliente (contado).";
      } else {
        if (!customerId) return "Selecciona un cliente (crédito).";
        if (downPayment < 0) return "El pago inicial no puede ser negativo.";
        if (downPayment > amountCharged)
          return "El pago inicial no puede superar el total.";
        if (selectedCustomer?.status === "BLOQUEADO")
          return "El cliente está BLOQUEADO. No se puede fiar.";
      }

      for (const it of items) {
        const qty = it.qty;
        const { allocations, avgUnitCost, cogsAmount } =
          await allocateFIFOAndUpdateBatches(db, it.productName, qty, false);

        const unitApplied = getAppliedUnitPrice(it); // ✅ precio aplicado
        const line = Number(unitApplied || 0) * Number(qty || 0);
        const discount = Math.max(0, Number(it.discount || 0));
        const net = Math.max(0, line - discount);

        enriched.push({
          productId: it.productId,
          productName: it.productName,
          measurement: it.measurement,

          // ✅ CLAVE: unitPrice queda como PRECIO APLICADO (para que transacciones/cierres/dashboard muestren lo correcto)
          unitPrice: Number(unitApplied || 0),

          // ✅ opcionales (no rompen nada): para auditoría
          regularPrice: Number(it.price || 0),
          specialPrice:
            Number(it.specialPrice || 0) > 0 ? Number(it.specialPrice) : null,

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

      const received =
        clientType === "CREDITO"
          ? Number(downPayment || 0)
          : Number(amountReceived || 0);

      const changeValue = clientType === "CREDITO" ? "0.00" : amountChange;

      // 3) Registrar venta en salesV2
      // 3) Registrar venta en colección correcta (POLLO)
      const salePayload: any = {
        id: uuidv4(),
        quantity: qtyTotal,
        amount: itemsTotal,
        amountCharged: itemsTotal,

        timestamp: Timestamp.now(),
        date: saleDate,

        // ⚠️ tu código actual usa users[0], eso es peligroso.
        // Mejor: usa el user actual si existe:
        userEmail: user?.email ?? users[0]?.email ?? "sin usuario",
        vendor: role ?? users[0]?.role ?? "sin usuario",
        status: "FLOTANTE",

        items: enriched,
        itemsTotal: itemsTotal,

        // ✅ crédito/contado
        type: clientType,
        amountReceived: received,
        change: changeValue,

        // ✅ cliente
        customerId: clientType === "CREDITO" ? customerId : "",
        customerName:
          clientType === "CREDITO"
            ? selectedCustomer?.name || ""
            : clientName.trim(),
        clientName: clientType === "CONTADO" ? clientName.trim() : "",
      };

      // ✅ Validaciones según tipo de cliente (NO usar return "string")
      if (clientType === "CONTADO") {
        if (!clientName.trim()) {
          setMessage("❌ Ingresa el nombre del cliente (contado).");
          return;
        }
      } else {
        if (!customerId) {
          setMessage("❌ Selecciona un cliente (crédito).");
          return;
        }
        if (downPayment < 0) {
          setMessage("❌ El pago inicial no puede ser negativo.");
          return;
        }
        if (downPayment > amountCharged) {
          setMessage("❌ El pago inicial no puede superar el total.");
          return;
        }
        if (selectedCustomer?.status === "BLOQUEADO") {
          setMessage("❌ El cliente está BLOQUEADO. No se puede fiar.");
          return;
        }

        // (opcional pero recomendado) límite de crédito
        const limit = Number(selectedCustomer?.creditLimit || 0);
        if (limit > 0 && projectedBalance > limit) {
          setMessage(
            `❌ Supera el límite de crédito (C$ ${limit.toFixed(2)}).`,
          );
          return;
        }
      }

      const saleRef = await addDoc(collection(db, "salesV2"), salePayload);

      // 4) CxC crédito (ar_movements_pollo)
      if (clientType === "CREDITO" && customerId) {
        const base = {
          customerId,
          date: saleDate,
          createdAt: Timestamp.now(),
          ref: { saleId: saleRef.id },
        };

        // CARGO (deuda)
        await addDoc(collection(db, "ar_movements_pollo"), {
          ...base,
          type: "CARGO",
          amount: Number(itemsTotal) || 0,
        });

        // ABONO (pago inicial)
        if (Number(downPayment) > 0) {
          await addDoc(collection(db, "ar_movements_pollo"), {
            ...base,
            type: "ABONO",
            amount: -Number(downPayment),
          });
        }

        // ✅ actualizar saldo local en UI (igual que dulces)
        setCustomers((prev) =>
          prev.map((c) =>
            c.id === customerId
              ? {
                  ...c,
                  balance:
                    Number(c.balance || 0) +
                    Number(itemsTotal || 0) -
                    Number(downPayment || 0),
                }
              : c,
          ),
        );
      }

      setMessage("✅ Venta registrada y asignada a inventario (FIFO).");
      setItems([]);
      setSelectedProductId("");
      setAmountCharged(0);
      setAmountReceived(0);
      setChange("0");
      setClientName("");
      setSaleDate(format(new Date(), "yyyy-MM-dd"));
      setCustomerId("");
      setDownPayment(0);
      setClientType("CONTADO");
    } catch (err: any) {
      console.error(err);
      setMessage(`❌ ${err?.message || "Error al registrar la venta."}`);
    } finally {
      setSaving(false);
    }
  };

  // Productos ya elegidos (para bloquear en el select)
  const chosenIds = useMemo(
    () => new Set(items.map((i) => i.productId)),
    [items],
  );

  // solo mostrar en el selector los que tienen stock > 0
  const selectableProducts = useMemo(
    () => products.filter((p) => (stockById[p.id] || 0) > 0),
    [products, stockById],
  );

  const filteredProductsForPicker = useMemo(() => {
    const q = String(productQuery || "")
      .trim()
      .toLowerCase();
    if (!q) return selectableProducts;
    return selectableProducts.filter((p) =>
      `${p.productName || ""}`.toLowerCase().includes(q),
    );
  }, [selectableProducts, productQuery]);

  if (isMobile) {
    return (
      <div className="w-full max-w-lg mx-auto p-3">
        <div className="bg-white rounded-2xl shadow p-3 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-lg text-blue-700">
              Registrar venta (Pollo)
            </h2>
            <input
              type="date"
              className="text-sm text-gray-700 border rounded px-2 py-1"
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
              aria-label="Fecha de la venta"
            />
          </div>
          <div className="space-y-2">
            <label className="text-sm font-semibold">Tipo de cliente</label>
            <select
              className="w-full border rounded px-2 py-2"
              value={clientType}
              onChange={(e) =>
                handleClientTypeChange(e.target.value as ClientType)
              }
            >
              <option value="CONTADO">Contado</option>
              <option value="CREDITO">Crédito</option>
            </select>
          </div>

          {clientType === "CONTADO" ? (
            <div className="space-y-2">
              <label className="text-sm font-semibold">Cliente (Contado)</label>
              <input
                className="w-full border rounded px-2 py-2"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Ej: Cliente Mostrador"
              />
            </div>
          ) : (
            <div className="space-y-2">
              <label className="text-sm font-semibold">Cliente (Crédito)</label>
              <select
                className="w-full border rounded px-2 py-2"
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
                    {c.name} — Saldo: {money(c.balance || 0)}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded bg-gray-50 border">
                  <div className="text-xs text-gray-600">Saldo actual</div>
                  <div className="text-base font-semibold">
                    {money(currentBalance)}
                  </div>
                </div>
                <div className="p-2 rounded bg-gray-50 border">
                  <div className="text-xs text-gray-600">Saldo proyectado</div>
                  <div className="text-base font-semibold">
                    {money(projectedBalance)}
                  </div>
                </div>
              </div>

              <div>
                <label className="text-sm font-semibold">Pago inicial</label>
                <input
                  className="w-full border rounded px-2 py-2"
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  max={maxDownPayment}
                  value={downPayment === 0 ? "" : downPayment}
                  onChange={(e) => {
                    const v = Math.max(0, Number(e.target.value || 0));
                    const capped = Math.min(v, maxDownPayment);
                    setDownPayment(capped);
                  }}
                  placeholder="0.00"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Máximo: {money(maxDownPayment)}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2">
            <label className="text-sm font-semibold">Producto</label>
            <input
              className="w-full border rounded px-2 py-2 mb-2"
              placeholder="Buscar producto por nombre..."
              value={productQuery}
              onChange={(e) => setProductQuery(e.target.value)}
            />
            <div className="flex gap-2">
              <select
                className="flex-1 border rounded px-1 py-2 text-sm"
                value={selectedProductId}
                onChange={async (e) => {
                  const id = e.target.value;
                  setSelectedProductId(id);
                  await addProductById(id);
                }}
              >
                <option value="" disabled>
                  Selecciona un producto
                </option>
                {filteredProductsForPicker.map((p) => (
                  <option
                    key={p.id}
                    value={p.id}
                    disabled={chosenIds.has(p.id)}
                  >
                    {p.productName} | C$ {p.price} | Disp:{" "}
                    {qty3(stockById[p.id] || 0)}
                  </option>
                ))}
              </select>
            </div>
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Items</div>
            {items.length === 0 ? (
              <div className="text-gray-500">Agrega productos al carrito.</div>
            ) : (
              <div className="space-y-2">
                {items.map((it) => {
                  const unitApplied = getAppliedUnitPrice(it);
                  const line = Number(unitApplied || 0) * Number(it.qty || 0);
                  const net = Math.max(
                    0,
                    line - Math.max(0, Number(it.discount || 0)),
                  );
                  const isUnit = (it.measurement || "").toLowerCase() !== "lb";
                  return (
                    <div key={it.productId} className="border rounded p-2">
                      <div className="flex justify-between items-center">
                        <div className="font-semibold">{it.productName}</div>
                        <div className="text-sm">
                          C$ {round2(unitApplied).toFixed(2)}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 items-center">
                        <input
                          className="border rounded px-2 py-1 text-right"
                          inputMode={isUnit ? "numeric" : "decimal"}
                          step={isUnit ? 1 : 0.01}
                          value={it.qtyInput ?? (it.qty === 0 ? "" : it.qty)}
                          onKeyDown={numberKeyGuard}
                          onChange={(e) =>
                            setItemQty(it.productId, e.target.value)
                          }
                          placeholder={isUnit ? "Unid" : "Libras"}
                          title={isUnit ? "Unidades" : "Libras"}
                        />
                        <input
                          className="border rounded px-1 py-1 text-right"
                          inputMode="numeric"
                          value={
                            it.discountInput ??
                            (it.discount === 0 ? "" : it.discount)
                          }
                          onChange={(e) =>
                            setItemDiscount(it.productId, e.target.value)
                          }
                          placeholder="Descuento"
                          title="Descuento (C$)"
                        />
                        <input
                          className="border rounded px-2 py-1 text-right"
                          inputMode="decimal"
                          value={
                            it.specialPriceInput ??
                            (it.specialPrice === 0 ? "" : it.specialPrice)
                          }
                          onChange={(e) =>
                            setItemSpecialPrice(it.productId, e.target.value)
                          }
                          placeholder="Sugerido"
                          title="Precio sugerido (opcional)"
                        />
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <div className="text-sm text-gray-600">
                          Exist:{" "}
                          {roundQty(
                            Number(it.stock) - Number(it.qty || 0),
                          ).toFixed(3)}
                        </div>
                        <div className="font-semibold">
                          C$ {round2(net).toFixed(2)}
                        </div>
                      </div>
                      <div className="mt-2 text-right">
                        <button
                          type="button"
                          className="px-2 py-1 rounded bg-red-100 text-red-600"
                          onClick={() => removeItem(it.productId)}
                        >
                          Quitar
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="space-y-2">
            <div className="text-sm font-semibold">Monto total</div>
            <div className="text-xl font-bold">
              C$ {amountCharged.toFixed(2)}
            </div>
          </div>

          {clientType === "CONTADO" && (
            <div className="grid grid-cols-2 gap-2">
              <input
                className="border rounded px-2 py-2"
                inputMode="decimal"
                value={amountReceived === 0 ? "" : amountReceived}
                onChange={(e) => setAmountReceived(Number(e.target.value || 0))}
                placeholder="Monto recibido"
              />
              <div className="border rounded px-2 py-2 bg-gray-100">
                Cambio: C$ {amountChange}
              </div>
            </div>
          )}

          <button
            onClick={handleSubmit as any}
            disabled={items.length === 0 || saving}
            className="w-full bg-blue-600 text-white px-4 py-2 rounded"
          >
            {saving ? "Guardando..." : "Guardar venta"}
          </button>

          {message && (
            <div
              className={`text-sm ${message.startsWith("✅") ? "text-green-600" : message.startsWith("⚠️") ? "text-yellow-600" : "text-red-600"}`}
            >
              {message}
            </div>
          )}
        </div>
      </div>
    );
  }

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
              Tipo de cliente
            </label>
            <select
              className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
              value={clientType}
              onChange={(e) =>
                handleClientTypeChange(e.target.value as ClientType)
              }
            >
              <option value="CONTADO">Contado</option>
              <option value="CREDITO">Crédito</option>
            </select>
          </div>

          {clientType === "CONTADO" ? (
            <div className="md:col-span-2 space-y-1">
              <label className="block text-sm font-semibold text-gray-700">
                Cliente (Contado)
              </label>
              <input
                className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Ej: Cliente Mostrador"
              />
            </div>
          ) : (
            <div className="md:col-span-2 space-y-2">
              <label className="block text-sm font-semibold text-gray-700">
                Cliente (Crédito)
              </label>

              <select
                className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
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
                    {c.name} — Saldo: {money(c.balance || 0)}
                  </option>
                ))}
              </select>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-2 rounded bg-gray-50 border">
                  <div className="text-xs text-gray-600">Saldo actual</div>
                  <div className="text-lg font-semibold">
                    {money(currentBalance)}
                  </div>
                </div>

                <div>
                  <label className="block text-sm font-semibold text-gray-700">
                    Pago inicial
                  </label>
                  <div className="text-xs text-gray-500 mt-1">
                    Máximo: {money(maxDownPayment)}
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    max={maxDownPayment}
                    className="w-full border border-gray-300 p-2 rounded-2xl shadow-2xl"
                    value={downPayment === 0 ? "" : downPayment}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value || 0));
                      const capped = Math.min(v, maxDownPayment);
                      setDownPayment(capped);
                    }}
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
        </div>

        {/* Lista de ítems */}
        <div className="rounded border overflow-x-auto shadow-2xl">
          <table className="min-w-full text-sm r">
            <thead className="bg-gray-100">
              <tr className="text-center">
                <th className="p-2 border whitespace-nowrap">Producto</th>
                <th className="p-2 border whitespace-nowrap">Precio</th>

                {/* ✅ NUEVO */}
                <th className="p-2 border whitespace-nowrap">
                  Precio especial
                </th>

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
                  <td colSpan={8} className="p-4 text-center text-gray-500">
                    Agrega productos al carrito.
                  </td>
                </tr>
              ) : (
                items.map((it) => {
                  const unitApplied = getAppliedUnitPrice(it);
                  const line = Number(unitApplied || 0) * Number(it.qty || 0);
                  const net = Math.max(
                    0,
                    line - Math.max(0, Number(it.discount || 0)),
                  );
                  const isUnit = (it.measurement || "").toLowerCase() !== "lb";
                  const shownExist = roundQty(
                    Number(it.stock) - Number(it.qty || 0),
                  );

                  return (
                    <tr key={it.productId} className="text-center">
                      <td className="p-2 border whitespace-nowrap">
                        {it.productName} — {it.measurement}
                      </td>

                      {/* Precio normal */}
                      <td className="p-2 border whitespace-nowrap">
                        C$ {round2(it.price).toFixed(2)}
                      </td>

                      {/* ✅ NUEVO: Precio especial */}
                      <td className="p-2 border">
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-28 border p-1 rounded text-right"
                          value={it.specialPrice === 0 ? "" : it.specialPrice}
                          onKeyDown={numberKeyGuard}
                          onChange={(e) =>
                            setItemSpecialPrice(it.productId, e.target.value)
                          }
                          placeholder="—"
                          title="Precio especial (si se deja vacío, se usa el precio normal)"
                        />
                        {/* opcional: mini hint del aplicado */}
                        <div className="text-[11px] text-gray-500 mt-1">
                          Aplicado: C$ {round2(unitApplied).toFixed(2)}
                        </div>
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
                          value={it.qtyInput ?? (it.qty === 0 ? "" : it.qty)}
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
            title="Suma de (precio aplicado × cantidad − descuento) de cada producto."
          />
        </div>

        {/* Pago recibido / Cambio */}
        {clientType === "CONTADO" && (
          <>
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
                  onChange={(e) =>
                    setAmountReceived(Number(e.target.value || 0))
                  }
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
          </>
        )}

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

      {/* Overlay de guardado */}
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
