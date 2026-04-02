// src/components/SaleForm.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
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
import { isBatchStockActivo } from "../../Services/batchStockStatus";
import { roundQty, addQty, gteQty } from "../../Services/decimal";
import RefreshButton from "../../components/common/RefreshButton";
import Button from "../../components/common/Button";
import MobileHtmlSelect from "../../components/common/MobileHtmlSelect";
import Toast from "../../components/common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";

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
  activeSalePrice?: number;
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

  const todayStr = format(new Date(), "yyyy-MM-dd");
  const [clientName, setClientName] = useState("");

  // mobile product / cliente crédito: búsqueda + panel tipo lista
  const [productQuery, setProductQuery] = useState("");
  const [customerQuery, setCustomerQuery] = useState("");
  const [mobileSheet, setMobileSheet] = useState<null | "product" | "customer">(
    null,
  );

  // Carrito
  const [items, setItems] = useState<CartItem[]>([]);

  // Totales (mantengo tus nombres para compatibilidad)
  const [amountCharged, setAmountCharged] = useState<number>(0); // total neto
  const [amountReceived, setAmountReceived] = useState<number>(0);
  const [amountChange, setChange] = useState<string>("0");

  const [message, setMessage] = useState("");

  const { refreshKey, refresh } = useManualRefresh();

  const [isRefreshing, setIsRefreshing] = useState(false);

  // Recalcula los precios del carrito desde los lotes y actualiza items
  const refreshCartPrices = async () => {
    if (!items || items.length === 0) return;
    try {
      const updated: CartItem[] = [];
      const changes: string[] = [];
      for (const it of items) {
        const resolved = await getSalePriceFromBatches(
          it.productId,
          Number(it.price || 0),
        );
        const newPrice = Number(resolved || it.price || 0);
        if (Number(it.price || 0) !== newPrice) {
          changes.push(
            `${it.productName}: C$ ${Number(it.price).toFixed(2)} → C$ ${newPrice.toFixed(2)}`,
          );
        }
        updated.push({ ...it, price: newPrice });
      }
      setItems(updated);

      if (changes.length > 0) {
        const note = `Precios actualizados: ${changes.join("; ")}`;
        setMessage(note);
      }
    } catch (e) {
      // no bloquear la UX por errores de precio
      console.error("Error actualizando precios del carrito:", e);
    }
  };

  // Extract loaders so handleRefresh can call them deterministically
  const loadProducts = async () => {
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
        activeSalePrice:
          x.activeSalePrice != null ? Number(x.activeSalePrice) : undefined,
      });
    });
    setProducts(list);
  };

  const loadInventoryBatches = async () => {
    const snap = await getDocs(collection(db, "inventory_batches"));
    const m: Record<string, number> = {};
    const batchesByProduct: Record<string, Array<any>> = {};
    snap.forEach((d) => {
      const x = d.data() as any;
      if (!isBatchStockActivo(x)) return;
      const pid = x.productId;
      const rem = Number(x.remaining || 0);
      if (pid) m[pid] = addQty(m[pid] || 0, rem);
      if (pid) {
        batchesByProduct[pid] = batchesByProduct[pid] || [];
        batchesByProduct[pid].push({ id: d.id, data: x });
      }
    });
    Object.keys(m).forEach((k) => (m[k] = roundQty(m[k])));
    setStockById(m);

    const priceMap: Record<string, number> = {};
    for (const pid of Object.keys(batchesByProduct)) {
      const prod = products.find((p) => p.id === pid);
      if (
        prod?.activeSalePrice != null &&
        Number.isFinite(prod.activeSalePrice) &&
        prod.activeSalePrice > 0
      ) {
        priceMap[pid] = prod.activeSalePrice;
        continue;
      }
      const list = batchesByProduct[pid].slice().sort((a, b) => {
        const da = (a.data.date ?? "") as string;
        const dbs = (b.data.date ?? "") as string;
        if (da !== dbs) return da > dbs ? -1 : 1;
        const ca = a.data.createdAt?.seconds ?? 0;
        const cb = b.data.createdAt?.seconds ?? 0;
        return cb - ca;
      });
      for (const entry of list) {
        const b = entry.data as any;
        const candidate = Number(b.salePrice ?? b.sale_price ?? b.price ?? NaN);
        if (!Number.isNaN(candidate)) {
          priceMap[pid] = Number(candidate);
          break;
        }
      }
    }
    setLatestPriceById(priceMap);
  };

  const loadUsers = async () => {
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
  };

  const loadCustomers = async () => {
    try {
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

      list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
      setCustomers(list);
    } catch (e) {
      console.error("Error cargando customers_pollo:", e);
      setCustomers([]);
    }
  };

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      // deterministic reload of all main datasets used by this component
      await loadProducts();
      await loadInventoryBatches();
      await loadUsers();
      await loadCustomers();

      // also call the global/manual refresh hook to notify other components
      try {
        refresh();
      } catch (e) {
        // non-fatal
        console.warn("refresh() hook failed:", e);
      }

      // update cart prices after loads
      await refreshCartPrices();
      setMessage("✅ Datos actualizados.");
    } finally {
      setIsRefreshing(false);
    }
  };

  // 🔵 overlay de guardado
  const [saving, setSaving] = useState(false);

  // 🔵 mapa de existencias por productId para filtrar el selector
  const [stockById, setStockById] = useState<Record<string, number>>({});
  // mapa de precio más reciente por productId (desde inventory_batches)
  const [latestPriceById, setLatestPriceById] = useState<
    Record<string, number>
  >({});

  const round2 = (n: number) =>
    Math.round((n + Number.EPSILON) * 100) / 100;
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
      setCustomerQuery("");
      setMobileSheet((s) => (s === "customer" ? null : s));
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
      if (!isBatchStockActivo(b)) return;
      total = addQty(total, Number(b.remaining || 0));
    });
    return roundQty(total);
  };

  // Precio de venta: prioridad → activeSalePrice del producto (precio vigente),
  // luego último lote, luego catálogo.
  const getSalePriceFromBatches = async (
    productId: string,
    fallbackPrice = 0,
  ) => {
    const prod = products.find((p) => p.id === productId);
    if (
      prod?.activeSalePrice != null &&
      Number.isFinite(prod.activeSalePrice) &&
      prod.activeSalePrice > 0
    ) {
      return prod.activeSalePrice;
    }

    try {
      const q = query(
        collection(db, "inventory_batches"),
        where("productId", "==", productId),
      );
      const snap = await getDocs(q);
      const docsSorted = snap.docs
        .map((d) => ({ id: d.id, data: d.data() as any }))
        .sort((a, b) => {
          const da = (a.data.date ?? "") as string;
          const dbs = (b.data.date ?? "") as string;
          if (da !== dbs) return da > dbs ? -1 : 1;

          const ca = a.data.createdAt?.seconds ?? 0;
          const cb = b.data.createdAt?.seconds ?? 0;
          return cb - ca;
        });

      for (const d of docsSorted) {
        const b = d.data as any;
        if (!isBatchStockActivo(b)) continue;
        const candidate = Number(b.salePrice ?? b.sale_price ?? b.price ?? NaN);
        if (!Number.isNaN(candidate)) {
          return Number(candidate);
        }
      }
      return Number(fallbackPrice ?? 0);
    } catch (e) {
      return Number(fallbackPrice ?? 0);
    }
  };

  const getDisponibleByName = async (productName: string) => {
    if (!productName) return 0;
    const all = await getDocs(collection(db, "inventory_batches"));
    let total = 0;
    all.forEach((d) => {
      const b = d.data() as any;
      if (!isBatchStockActivo(b)) return;
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
    loadProducts();
  }, [refreshKey]);

  // cargar existencias por productId para filtrar el selector
  useEffect(() => {
    loadInventoryBatches();
  }, [refreshKey]);

  // Cargar usuarios (igual que tenías)
  useEffect(() => {
    loadUsers();
  }, [refreshKey]);

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
    const resolvedPrice = await getSalePriceFromBatches(
      p.id,
      Number(p.price || 0),
    );
    setItems((prev) => [
      ...prev,
      {
        productId: p.id,
        productName: p.productName,
        measurement: p.measurement,
        price: Number(resolvedPrice || p.price || 0),
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
    const resolvedPrice = await getSalePriceFromBatches(
      p.id,
      Number(p.price || 0),
    );
    setItems((prev) => [
      ...prev,
      {
        productId: p.id,
        productName: p.productName,
        measurement: p.measurement,
        price: Number(resolvedPrice || p.price || 0),
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
              : String(roundQty(qty));
          return { ...it, qty, qtyInput: limitedInput };
        }

        // Para medidas en peso (no unidad) preservamos el texto tal como lo
        // escribe el usuario (incluyendo ceros finales) para evitar que al
        // teclear '0' se elimine el punto decimal (ej. 1.080).
        const nextInput = isUnit ? String(qty) : txt;

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
    loadCustomers();
  }, [refreshKey]);

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

  const missingContadoClient = clientType === "CONTADO" && !clientName.trim();

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
        const lineGross = round2(net - Number(cogsAmount ?? 0));

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

          /** Venta − costo (FIFO) por línea; mismo criterio que cierre de ventas. */
          grossProfit: lineGross,

          allocations,
          avgUnitCost,
          cogsAmount,
        });
      }

      // 2) Totales
      const itemsTotal = enriched.reduce((a, x) => a + x.lineFinal, 0);
      const grossProfitTotal = round2(
        enriched.reduce((a, x) => a + Number(x.grossProfit ?? 0), 0),
      );
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
        grossProfitTotal,

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

  const filteredCustomersForPicker = useMemo(() => {
    const q = String(customerQuery || "")
      .trim()
      .toLowerCase();
    if (!q) return customers;
    return customers.filter((c) =>
      `${c.name || ""}`.toLowerCase().includes(q),
    );
  }, [customers, customerQuery]);

  const productHtmlSelectOptions = useMemo(
    () => [
      {
        value: "",
        label: "Selecciona un producto",
        disabled: true,
      },
      ...selectableProducts.map((p) => ({
        value: p.id,
        label: `${p.productName} — ${p.measurement} — Precio C$ ${latestPriceById[p.id] ?? p.price} (Existencia: ${qty3(stockById[p.id] || 0)})`,
        disabled: chosenIds.has(p.id),
      })),
    ],
    [selectableProducts, latestPriceById, stockById, chosenIds],
  );

  const creditCustomerSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un cliente" },
      ...customers.map((c) => ({
        value: c.id,
        label: `${c.name} — Saldo: ${money(c.balance || 0)}`,
        disabled: c.status === "BLOQUEADO",
      })),
    ],
    [customers],
  );

  const clientTypeOptions = useMemo(
    () => [
      { value: "CONTADO", label: "Contado" },
      { value: "CREDITO", label: "Crédito" },
    ],
    [],
  );

  const inpBase =
    "w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 transition-colors";

  if (isMobile) {
    return (
      <div className="w-full max-w-lg mx-auto p-3 overflow-x-hidden min-w-0">
        <div className="bg-white rounded-xl border border-slate-200/90 shadow-sm p-4 space-y-4 min-w-0 max-w-full">
          <div className="flex items-start justify-between gap-3 pb-3 border-b border-slate-100">
            <div>
              <h2 className="font-semibold text-lg text-slate-900 tracking-tight">
                Registrar venta
              </h2>
              <p className="text-xs text-slate-500 mt-0.5">Pollo — venta en mostrador</p>
            </div>
            <input
              type="date"
              className={`${inpBase} w-auto shrink-0 max-w-[11rem] text-slate-700`}
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
              max={todayStr}
              aria-label="Fecha de la venta"
            />
          </div>
          <MobileHtmlSelect
            label="Tipo de cliente"
            value={clientType}
            onChange={(v) => handleClientTypeChange(v as ClientType)}
            options={clientTypeOptions}
            selectClassName={`${inpBase} py-2`}
            buttonClassName="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
            sheetTitle="Tipo de cliente"
          />

          {clientType === "CONTADO" ? (
            <div className="space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cliente (Contado)
              </label>
              <input
                className={inpBase}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Ej: Cliente Mostrador"
              />
            </div>
          ) : (
            <div className="space-y-3 w-full min-w-0 rounded-lg border border-slate-100 bg-slate-50/60 p-3">
              <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cliente (Crédito)
              </label>
              <div className="flex gap-2 items-center min-w-0">
                <input
                  type="search"
                  enterKeyHint="search"
                  className={`${inpBase} flex-1 min-w-0 box-border`}
                  placeholder="Buscar cliente por nombre..."
                  value={customerQuery}
                  onChange={(e) => setCustomerQuery(e.target.value)}
                />
                {customerQuery ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="!rounded-xl shrink-0 !text-xs"
                    onClick={() => setCustomerQuery("")}
                  >
                    Limpiar
                  </Button>
                ) : null}
              </div>
              <Button
                type="button"
                variant="outline"
                className="w-full min-w-0 !rounded-xl !px-3 !py-2.5 text-sm flex items-center justify-between gap-2 text-left !font-normal transition-colors"
                onClick={() => setMobileSheet("customer")}
              >
                <span className="truncate min-w-0 text-gray-700">
                  {customerId
                    ? customers.find((c) => c.id === customerId)?.name ??
                      "Cliente"
                    : "Elegir cliente (lista)"}
                </span>
                <span className="text-slate-400 shrink-0 text-xs">▼</span>
              </Button>

              <div className="grid grid-cols-2 gap-2">
                <div
                  className={`p-3 rounded-lg border ${
                    clientType === "CREDITO"
                      ? "bg-white border-slate-200 shadow-sm"
                      : "bg-slate-100/80 border-slate-200"
                  }`}
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo actual
                  </div>
                  <div className="text-base font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(currentBalance)}
                  </div>
                </div>
                <div
                  className={`p-3 rounded-lg border ${
                    clientType === "CREDITO"
                      ? "bg-white border-slate-200 shadow-sm"
                      : "bg-slate-100/80 border-slate-200"
                  }`}
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo proyectado
                  </div>
                  <div className="text-base font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(projectedBalance)}
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs font-semibold text-slate-600">
                  Pago inicial
                </label>
                <input
                  className={`${inpBase} mt-1`}
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
                <div className="text-[11px] text-slate-500 mt-1">
                  Máximo: {money(maxDownPayment)}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-2 w-full min-w-0 rounded-lg border border-slate-100 bg-white p-3 shadow-sm">
            <label className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Producto
            </label>
            <div className="flex gap-2 items-center min-w-0 mb-2">
              <input
                type="search"
                enterKeyHint="search"
                className={`${inpBase} flex-1 min-w-0 box-border`}
                placeholder="Buscar producto por nombre..."
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
              />
              {productQuery ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="!rounded-xl shrink-0 !text-xs"
                  onClick={() => setProductQuery("")}
                >
                  Limpiar
                </Button>
              ) : null}
            </div>
            <Button
              type="button"
              variant="outline"
              className="w-full min-w-0 border-dashed !border-slate-300 !rounded-xl !px-3 !py-2.5 text-sm flex items-center justify-between gap-2 text-left !font-normal bg-slate-50/80 hover:!bg-slate-100/80 active:!bg-slate-100 transition-colors"
              onClick={() => setMobileSheet("product")}
            >
              <span className="truncate min-w-0 text-gray-700">
                Elegir producto (lista)
              </span>
              <span className="text-slate-400 shrink-0 text-xs">▼</span>
            </Button>
          </div>

          {mobileSheet &&
            createPortal(
              <div
                className="fixed inset-0 z-[200] flex flex-col justify-end md:justify-center"
                role="dialog"
                aria-modal="true"
                aria-label={
                  mobileSheet === "product"
                    ? "Lista de productos"
                    : "Lista de clientes"
                }
              >
                <Button
                  type="button"
                  variant="ghost"
                  className="absolute inset-0 bg-black/45 !rounded-none border-0 cursor-default !h-full !min-h-0 !p-0 hover:!bg-black/45"
                  aria-label="Cerrar"
                  onClick={() => setMobileSheet(null)}
                />
                <div
                  className="relative z-10 bg-white rounded-t-2xl md:rounded-xl border border-slate-200/90 shadow-2xl w-full max-h-[min(78vh,520px)] flex flex-col mx-auto md:max-w-md md:my-auto"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between gap-2 px-4 py-3.5 border-b border-slate-100 bg-slate-50/80 shrink-0 rounded-t-2xl md:rounded-t-xl">
                    <span className="font-semibold text-slate-900 text-sm">
                      {mobileSheet === "product"
                        ? "Productos con stock"
                        : "Clientes"}
                    </span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="!rounded-xl !text-blue-600 hover:!text-blue-800 hover:!bg-blue-50 !font-medium"
                      onClick={() => setMobileSheet(null)}
                    >
                      Cerrar
                    </Button>
                  </div>
                  <div className="overflow-y-auto overscroll-contain px-1 pb-4 flex-1 min-h-0">
                    {mobileSheet === "product" ? (
                      filteredProductsForPicker.length === 0 ? (
                        <div className="text-center text-gray-500 text-sm py-8 px-4">
                          No hay productos con ese criterio o sin stock.
                        </div>
                      ) : (
                        filteredProductsForPicker.map((p) => {
                          const disabled = chosenIds.has(p.id);
                          const price = latestPriceById[p.id] ?? p.price;
                          const stock = stockById[p.id] || 0;
                          return (
                            <Button
                              key={p.id}
                              type="button"
                              variant="ghost"
                              disabled={disabled}
                              className="w-full !justify-start text-left !px-3 !py-3.5 border-b border-slate-100 last:border-b-0 !rounded-xl mx-1 active:!bg-blue-50/80 disabled:opacity-40 !font-normal"
                              onClick={async () => {
                                if (disabled) return;
                                await addProductById(p.id);
                                setMobileSheet(null);
                              }}
                            >
                              <div className="font-medium text-sm text-slate-900 break-words">
                                {p.productName}
                              </div>
                              <div className="text-xs text-slate-600 mt-1">
                                Precio: C$ {price} · Existencia: {qty3(stock)} Lbs/Un
                                {disabled ? " · Ya en carrito" : ""}
                              </div>
                            </Button>
                          );
                        })
                      )
                    ) : filteredCustomersForPicker.length === 0 ? (
                      <div className="text-center text-gray-500 text-sm py-8 px-4">
                        No hay clientes con ese criterio.
                      </div>
                    ) : (
                      filteredCustomersForPicker.map((c) => {
                        const blocked = c.status === "BLOQUEADO";
                        return (
                          <Button
                            key={c.id}
                            type="button"
                            variant="ghost"
                            disabled={blocked}
                            className="w-full !justify-start text-left !px-3 !py-3.5 border-b border-slate-100 last:border-b-0 !rounded-xl mx-1 active:!bg-blue-50/80 disabled:opacity-40 !font-normal"
                            onClick={() => {
                              if (blocked) return;
                              setCustomerId(c.id);
                              setMobileSheet(null);
                            }}
                          >
                            <div className="font-medium text-sm text-slate-900 break-words">
                              {c.name}
                            </div>
                            <div className="text-xs text-slate-600 mt-1">
                              Saldo: {money(c.balance || 0)}
                              {blocked ? " · Bloqueado" : ""}
                            </div>
                          </Button>
                        );
                      })
                    )}
                  </div>
                </div>
              </div>,
              document.body,
            )}

          <div className="space-y-2">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Carrito
            </div>
            {items.length === 0 ? (
              <div className="text-sm text-slate-500 border border-dashed border-slate-200 rounded-lg py-6 px-3 text-center bg-slate-50/50">
                Agrega productos al carrito.
              </div>
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
                    <div
                      key={it.productId}
                      className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
                    >
                      <div className="flex justify-between items-start gap-2">
                        <div className="font-medium text-slate-900 text-sm leading-snug min-w-0">
                          {it.productName}
                        </div>
                        <div className="text-xs font-medium text-slate-500 tabular-nums shrink-0">
                          C$ {round2(unitApplied).toFixed(2)}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 items-center">
                        <input
                          className={`${inpBase} py-2 text-right text-sm`}
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
                          className={`${inpBase} py-2 text-right text-sm px-2`}
                          inputMode="numeric"
                          value={
                            it.discountInput ??
                            (it.discount === 0 ? "" : it.discount)
                          }
                          onChange={(e) =>
                            setItemDiscount(it.productId, e.target.value)
                          }
                          placeholder="Desc."
                          title="Descuento (C$)"
                        />
                        <input
                          className={`${inpBase} py-2 text-right text-sm`}
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
                      <div className="mt-2 flex items-center justify-between gap-2">
                        <div className="text-xs text-slate-500">
                          Exist. restante:{" "}
                          <span className="tabular-nums font-medium text-slate-700">
                            {roundQty(
                              Number(it.stock) - Number(it.qty || 0),
                            ).toFixed(3)}
                          </span>
                        </div>
                        <div className="font-semibold tabular-nums text-slate-900">
                          C$ {round2(net).toFixed(2)}
                        </div>
                      </div>
                      <div className="mt-2 flex justify-end">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="!rounded-xl !text-xs !font-medium !text-red-700 !border-red-100 !bg-red-50 hover:!bg-red-100/80"
                          onClick={() => removeItem(it.productId)}
                        >
                          Quitar
                        </Button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
              Monto total
            </div>
            <div className="text-2xl font-semibold tabular-nums text-slate-900 tracking-tight mt-1">
              C$ {amountCharged.toFixed(2)}
            </div>
          </div>

          {clientType === "CONTADO" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-500">
                  Monto recibido
                </label>
                <input
                  className={inpBase}
                  inputMode="decimal"
                  value={amountReceived === 0 ? "" : amountReceived}
                  onChange={(e) =>
                    setAmountReceived(Number(e.target.value || 0))
                  }
                  placeholder="0.00"
                />
              </div>
              <div className="space-y-1">
                <label className="text-[11px] font-medium text-slate-500">
                  Cambio
                </label>
                <div
                  className={`${inpBase} bg-slate-100 text-slate-800 font-medium tabular-nums`}
                >
                  C$ {amountChange}
                </div>
              </div>
            </div>
          )}

          <Button
            type="button"
            variant="primary"
            onClick={handleSubmit as any}
            disabled={items.length === 0 || saving || missingContadoClient}
            className="w-full !py-3.5 !rounded-xl text-sm shadow-md shadow-blue-600/20 hover:!shadow-lg active:scale-[0.99] disabled:active:scale-100"
          >
            {saving ? "Guardando..." : "Guardar venta"}
          </Button>

          {missingContadoClient && (
            <div
              role="alert"
              className="text-sm text-amber-900 bg-amber-50 border border-amber-200/80 rounded-lg p-3 flex gap-2 items-start"
            >
              <span className="shrink-0" aria-hidden>
                ⚠️
              </span>
              <span>Debe ingresar un cliente contado para registrar venta.</span>
            </div>
          )}

          {message && (
            <Toast message={message} onClose={() => setMessage("")} />
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="relative">
      <form
        onSubmit={handleSubmit}
        className="w-full mx-auto max-w-5xl space-y-6 bg-white rounded-xl border border-slate-200/90 shadow-sm p-4 sm:p-6 md:p-8"
      >
        <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b border-slate-100">
          <div>
            <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
              Registrar venta
            </h2>
            <p className="text-sm text-slate-500 mt-1">
              Pollo — precio por libra o unidad según producto
            </p>
          </div>
          <div className="shrink-0">
            <RefreshButton onClick={handleRefresh} loading={isRefreshing} />
          </div>
        </div>

        {/* Selector de producto */}
        <section className="rounded-xl border border-slate-100 bg-slate-50/50 p-4 space-y-3">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Agregar al carrito
          </label>
          <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
            <div className="flex-1 min-w-0">
              <MobileHtmlSelect
                value={selectedProductId}
                onChange={setSelectedProductId}
                options={productHtmlSelectOptions}
                sheetTitle="Producto"
                selectClassName={`${inpBase} py-2.5`}
                buttonClassName="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
              />
            </div>
            <Button
              type="button"
              variant="primary"
              onClick={addSelectedProduct}
              disabled={!selectedProductId || chosenIds.has(selectedProductId)}
              className="shrink-0 !px-5 !py-2.5 !rounded-xl text-sm shadow-md shadow-blue-600/15"
            >
              Agregar
            </Button>
          </div>
        </section>

        {/* Fecha / Cliente */}
        <div className="grid md:grid-cols-2 gap-4">
          <div className="space-y-1.5">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Fecha de la venta
            </label>
            <input
              type="date"
              className={inpBase}
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
              max={todayStr}
            />
          </div>

          <div className="space-y-1.5">
            <MobileHtmlSelect
              label="Tipo de cliente"
              value={clientType}
              onChange={(v) => handleClientTypeChange(v as ClientType)}
              options={clientTypeOptions}
              selectClassName={`${inpBase} py-2.5`}
              buttonClassName="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
              sheetTitle="Tipo de cliente"
            />
          </div>

          {clientType === "CONTADO" ? (
            <div className="md:col-span-2 space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cliente (Contado)
              </label>
              <input
                className={inpBase}
                value={clientName}
                onChange={(e) => setClientName(e.target.value)}
                placeholder="Ej: Cliente Mostrador"
              />
            </div>
          ) : (
            <div className="md:col-span-2 space-y-4 rounded-xl border border-slate-100 bg-slate-50/60 p-4">
              <MobileHtmlSelect
                label="Cliente (Crédito)"
                value={customerId}
                onChange={setCustomerId}
                options={creditCustomerSelectOptions}
                selectClassName={`${inpBase} py-2.5`}
                buttonClassName="w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
                sheetTitle="Cliente (crédito)"
              />

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                <div
                  className={`p-3 rounded-lg border ${
                    clientType === "CREDITO"
                      ? "bg-white border-slate-200 shadow-sm"
                      : "bg-slate-100/80 border-slate-200"
                  }`}
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo actual
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(currentBalance)}
                  </div>
                </div>

                <div className="space-y-1">
                  <label className="block text-xs font-semibold text-slate-600">
                    Pago inicial
                  </label>
                  <div className="text-[11px] text-slate-500">
                    Máximo: {money(maxDownPayment)}
                  </div>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    max={maxDownPayment}
                    className={inpBase}
                    value={downPayment === 0 ? "" : downPayment}
                    onChange={(e) => {
                      const v = Math.max(0, Number(e.target.value || 0));
                      const capped = Math.min(v, maxDownPayment);
                      setDownPayment(capped);
                    }}
                    placeholder="0.00"
                  />
                </div>

                <div
                  className={`p-3 rounded-lg border ${
                    clientType === "CREDITO"
                      ? "bg-white border-slate-200 shadow-sm"
                      : "bg-slate-100/80 border-slate-200"
                  }`}
                >
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo proyectado
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(projectedBalance)}
                  </div>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* Lista de ítems */}
        <section className="space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wide text-slate-500">
            Líneas del carrito
          </h3>
          <div className="rounded-xl border border-slate-200 overflow-x-auto bg-white shadow-sm">
          <table className="min-w-full text-sm">
            <thead className="bg-slate-100/90 text-slate-700">
              <tr className="text-center text-xs uppercase tracking-wide">
                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Producto
                </th>
                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Precio
                </th>

                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Precio especial
                </th>

                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Existencias
                </th>
                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Cantidad
                </th>
                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Descuento
                </th>
                <th className="p-2.5 border-b border-slate-200 whitespace-nowrap font-semibold">
                  Monto
                </th>
                <th className="p-2.5 border-b border-slate-200 w-12 font-semibold">
                  —
                </th>
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
                    <tr
                      key={it.productId}
                      className="text-center border-b border-slate-100 last:border-0 hover:bg-slate-50/60 transition-colors"
                    >
                      <td className="p-2.5 border-r border-slate-100 whitespace-nowrap text-left text-slate-800">
                        {it.productName} — {it.measurement}
                      </td>

                      {/* Precio normal */}
                      <td className="p-2.5 border-r border-slate-100 whitespace-nowrap tabular-nums text-slate-700">
                        C$ {round2(it.price).toFixed(2)}
                      </td>

                      {/* ✅ NUEVO: Precio especial */}
                      <td className="p-2 border-r border-slate-100">
                        <input
                          type="number"
                          step="0.01"
                          inputMode="decimal"
                          className="w-28 max-w-full border border-slate-200 rounded-md px-2 py-1.5 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
                          value={it.specialPrice === 0 ? "" : it.specialPrice}
                          onKeyDown={numberKeyGuard}
                          onChange={(e) =>
                            setItemSpecialPrice(it.productId, e.target.value)
                          }
                          placeholder="—"
                          title="Precio especial (si se deja vacío, se usa el precio normal)"
                        />
                        {/* opcional: mini hint del aplicado */}
                        <div className="text-[11px] text-slate-500 mt-1">
                          Aplicado: C$ {round2(unitApplied).toFixed(2)}
                        </div>
                      </td>

                      <td className="p-2.5 border-r border-slate-100 whitespace-nowrap tabular-nums text-slate-700">
                        {shownExist.toFixed(3)}
                      </td>

                      <td className="p-2 border-r border-slate-100">
                        <input
                          type="number"
                          step={isUnit ? 1 : 0.01}
                          inputMode={isUnit ? "numeric" : "decimal"}
                          className="w-28 max-w-full border border-slate-200 rounded-md px-2 py-1.5 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
                          value={it.qtyInput ?? (it.qty === 0 ? "" : it.qty)}
                          onKeyDown={numberKeyGuard}
                          onChange={(e) =>
                            setItemQty(it.productId, e.target.value)
                          }
                          placeholder="0"
                          title="Cantidad"
                        />
                      </td>

                      <td className="p-2 border-r border-slate-100">
                        <input
                          type="number"
                          step={1}
                          min={0}
                          className="w-24 max-w-full border border-slate-200 rounded-md px-2 py-1.5 text-right text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500"
                          value={it.discount === 0 ? "" : it.discount}
                          onChange={(e) =>
                            setItemDiscount(it.productId, e.target.value)
                          }
                          inputMode="numeric"
                          placeholder="0"
                          title="Descuento (entero C$)"
                        />
                      </td>

                      <td className="p-2.5 border-r border-slate-100 whitespace-nowrap font-medium tabular-nums text-slate-900">
                        C$ {round2(net).toFixed(2)}
                      </td>

                      <td className="p-2">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          className="!h-8 !w-8 !min-h-0 !rounded-lg !p-0 !text-red-700 !border-red-100 !bg-red-50 hover:!bg-red-100"
                          onClick={() => removeItem(it.productId)}
                          title="Quitar"
                          aria-label="Quitar"
                        >
                          ✕
                        </Button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        </section>

        {/* Total de la venta (readOnly) */}
        <div className="rounded-xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm space-y-1">
          <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
            Monto total
          </label>
          <input
            type="text"
            className="w-full border-0 bg-transparent p-0 text-2xl font-semibold tabular-nums text-slate-900 focus:ring-0 cursor-default"
            value={`C$ ${amountCharged.toFixed(2)}`}
            readOnly
            title="Suma de (precio aplicado × cantidad − descuento) de cada producto."
          />
        </div>

        {/* Pago recibido / Cambio */}
        {clientType === "CONTADO" && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Monto recibido
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className={inpBase}
                value={amountReceived === 0 ? "" : amountReceived}
                onChange={(e) =>
                  setAmountReceived(Number(e.target.value || 0))
                }
              />
            </div>
            <div className="space-y-1.5">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cambio
              </label>
              <input
                type="text"
                className={`${inpBase} bg-slate-100 font-medium tabular-nums cursor-default`}
                value={`C$ ${amountChange}`}
                readOnly
              />
            </div>
          </div>
        )}

        {/* Guardar */}
        <Button
          type="submit"
          variant="primary"
          className="w-full !py-3.5 !rounded-xl text-sm shadow-md shadow-blue-600/20 hover:!shadow-lg active:scale-[0.99] disabled:active:scale-100"
          disabled={items.length === 0 || saving || missingContadoClient}
        >
          {saving ? "Guardando..." : "Guardar venta"}
        </Button>

        {missingContadoClient && (
          <p
            role="alert"
            className="text-sm text-amber-900 bg-amber-50 border border-amber-200/80 rounded-lg p-3 flex gap-2 items-start"
          >
            <span className="shrink-0" aria-hidden>
              ⚠️
            </span>
            <span>Debe ingresar un cliente contado para registrar venta.</span>
          </p>
        )}

        {message && (
          <Toast message={message} onClose={() => setMessage("")} />
        )}
      </form>

      {/* Overlay de guardado */}
      {saving && (
        <div className="fixed inset-0 bg-black/45 backdrop-blur-[1px] z-[60] flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl border border-slate-200 px-8 py-6 max-w-sm w-full">
            <div className="flex items-center gap-4">
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
