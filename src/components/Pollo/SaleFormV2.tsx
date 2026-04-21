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
import { ImageWithFallback } from "../../components/common/ImageWithFallback";
import useManualRefresh from "../../hooks/useManualRefresh";
import { Calendar, CreditCard, Search, Trash2, Wallet } from "lucide-react";
import { resolveProductImageSrc } from "./figmaSalePlaceholderImages";

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
  imageUrl?: string;
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

function isCajillaHuevoProductName(name: string): boolean {
  const n = (name || "").toLowerCase();
  return /cajilla/.test(n) && /huevo/.test(n);
}

function lineUsesIntegerQty(it: Pick<CartItem, "productName" | "measurement">) {
  if (isCajillaHuevoProductName(it.productName)) return true;
  return (it.measurement || "").toLowerCase() !== "lb";
}

/** URL de imagen en documento `products` (varios alias + primer string de `images[]`). */
function pickRawImageUrlFromProductDoc(x: Record<string, unknown>): string | undefined {
  const images = x.images;
  const firstFromArray =
    Array.isArray(images) &&
    images.length > 0 &&
    typeof images[0] === "string"
      ? (images[0] as string).trim()
      : "";
  const cands: unknown[] = [
    x.imageUrl,
    x.image,
    x.photo,
    x.picture,
    x.thumbnail,
    x.img,
    x.imageURL,
    x.displayImageUrl,
    x.photoUrl,
    firstFromArray || undefined,
  ];
  for (const v of cands) {
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return undefined;
}

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
        setMessage(`ℹ️ ${note}`);
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
        imageUrl: pickRawImageUrlFromProductDoc(x as Record<string, unknown>),
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

  /** Imagen de la línea = la del producto en catálogo (`productId`), no datos del ítem. */
  const cartLineImageSrc = (it: CartItem) =>
    resolveProductImageSrc(
      products.find((p) => p.id === it.productId)?.imageUrl,
      it.productId,
      it.productName,
    );

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
        const intQty = lineUsesIntegerQty(it);
        let txt = normalizeDecimalInput(raw);

        if (txt.trim() === "") {
          return { ...it, qty: 0, qtyInput: "" };
        }

        if (!intQty && txt === ".") {
          return { ...it, qty: 0, qtyInput: "0." };
        }

        if (!intQty && txt.includes(".")) {
          const [whole, frac = ""] = txt.split(".", 2);
          const digitsOnly = frac.replace(/\D/g, "").slice(0, 3);
          if (txt.endsWith(".") && digitsOnly === "") {
            txt = `${whole}.`;
          } else {
            txt = digitsOnly !== "" ? `${whole}.${digitsOnly}` : whole;
          }
        }

        const parsed = Number(txt);
        const num = Number.isFinite(parsed) ? parsed : 0;
        let qty = intQty ? Math.max(0, Math.round(num)) : roundQty(num);

        // Limitar qty a las existencias conocidas (stock)
        const stockAvailable = intQty
          ? Math.max(0, Math.floor(Number(it.stock || 0)))
          : roundQty(Number(it.stock || 0));

        if (qty > stockAvailable) {
          qty = stockAvailable;
          setMessage(`⚠️ Cantidad limitada a existencias (${stockAvailable})`);
          const limitedInput = intQty
            ? String(qty)
            : qty === 0
              ? ""
              : String(roundQty(qty));
          return { ...it, qty, qtyInput: limitedInput };
        }

        // Para medidas en peso (no unidad) preservamos el texto tal como lo
        // escribe el usuario (incluyendo ceros finales) para evitar que al
        // teclear '0' se elimine el punto decimal (ej. 1.080).
        const nextInput = intQty ? String(qty) : txt;

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

  /** Suma cantidades: líneas en lb (decimal) vs unidades enteras (resto). */
  const cartQtyTotals = useMemo(() => {
    let libras = 0;
    let unidades = 0;
    for (const it of items) {
      const q = Number(it.qty || 0);
      if (!Number.isFinite(q) || q <= 0) continue;
      if (lineUsesIntegerQty(it)) {
        unidades += Math.round(q);
      } else {
        libras = addQty(libras, q);
      }
    }
    return {
      librasTotal: roundQty(libras),
      unidadesTotal: unidades,
    };
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

  /** Inputs / selects estilo panel Figma (web). */
  const webFigmaInput =
    "w-full border-2 border-gray-300 rounded-lg px-3 py-2 text-sm text-gray-900 placeholder:text-gray-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent transition-colors";
  const webFigmaSelectBtn =
    "w-full border-2 border-gray-300 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white hover:bg-blue-50/60 focus:outline-none focus:ring-2 focus:ring-blue-500";

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
                              className="w-full !justify-start text-left !px-3 !py-3.5 border-b border-slate-100 last:border-b-0 !rounded-xl mx-1 transition-all duration-200 ease-out hover:!bg-slate-50 hover:!shadow-sm hover:translate-x-0.5 active:!bg-blue-50/80 disabled:opacity-40 !font-normal"
                              onClick={async () => {
                                if (disabled) return;
                                await addProductById(p.id);
                                setMobileSheet(null);
                              }}
                            >
                              <div className="flex gap-3 w-full items-start">
                                <div className="w-12 h-12 shrink-0 rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                                  <ImageWithFallback
                                    src={resolveProductImageSrc(
                                      p.imageUrl,
                                      p.id,
                                      p.productName,
                                    )}
                                    alt=""
                                    className="w-full h-full object-cover"
                                  />
                                </div>
                                <div className="min-w-0 flex-1 text-left">
                                  <div className="font-medium text-sm text-slate-900 break-words">
                                    {p.productName}
                                  </div>
                                  <div className="text-xs text-slate-600 mt-1">
                                    Precio: C$ {price} · Existencia:{" "}
                                    {qty3(stock)} Lbs/Un
                                    {disabled ? " · Ya en carrito" : ""}
                                  </div>
                                </div>
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

          <div className="flex gap-2 items-stretch w-full min-w-0">
            <div className="flex-1 rounded-lg border border-slate-200 bg-gradient-to-br from-slate-50 to-white px-2.5 py-1.5 shadow-sm">
              <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[10px] leading-tight text-slate-600">
                <div className="flex items-baseline gap-1">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">
                    Monto
                  </span>
                  <span className="tabular-nums font-semibold text-slate-900 text-sm">
                    C$ {amountCharged.toFixed(2)}
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">
                    Lb
                  </span>
                  <span className="tabular-nums font-medium text-slate-800">
                    {qty3(cartQtyTotals.librasTotal)}
                  </span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className="font-semibold uppercase tracking-wide text-slate-500">
                    Unid.
                  </span>
                  <span className="tabular-nums font-medium text-slate-800">
                    {cartQtyTotals.unidadesTotal}
                  </span>
                </div>
              </div>
            </div>
            <Button
              type="button"
              variant="primary"
              onClick={handleSubmit as any}
              disabled={items.length === 0 || saving || missingContadoClient}
              className="shrink-0 self-stretch px-4 !rounded-lg !text-xs font-semibold min-w-[6rem] flex items-center justify-center !py-2"
            >
              {saving ? "Guardando..." : "Guardar"}
            </Button>
          </div>

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
                  const shownExist = roundQty(
                    Number(it.stock) - Number(it.qty || 0),
                  );
                  return (
                    <div
                      key={it.productId}
                      className="rounded-lg border border-slate-200 bg-white p-3 shadow-sm"
                    >
                      <div className="flex gap-3">
                        <div className="w-14 h-14 shrink-0 rounded-lg overflow-hidden border border-slate-200 bg-slate-100">
                          <ImageWithFallback
                            src={cartLineImageSrc(it)}
                            alt=""
                            className="w-full h-full object-cover"
                          />
                        </div>
                        <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-start gap-2">
                        <div className="font-medium text-slate-900 text-sm leading-snug min-w-0 flex-1 basis-[8rem]">
                          {it.productName}
                        </div>
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2 py-0.5 text-[11px] font-semibold uppercase tracking-wide text-slate-700 shrink-0">
                          {it.measurement}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-semibold tabular-nums text-slate-800 shrink-0">
                          Post: {shownExist.toFixed(3)}
                        </span>
                        <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2 py-0.5 text-[11px] font-bold tabular-nums text-green-800 shrink-0">
                          C$ {round2(it.price).toFixed(2)}
                        </span>
                        <div className="text-[11px] font-medium text-slate-500 tabular-nums shrink-0 w-full sm:w-auto sm:ml-auto">
                          Aplicado: C$ {round2(unitApplied).toFixed(2)}
                        </div>
                      </div>
                      <div className="mt-2 grid grid-cols-3 gap-2 items-center">
                        <input
                          className={`${inpBase} py-2 text-right text-sm`}
                          inputMode={isUnit ? "numeric" : "decimal"}
                          step={isUnit ? 1 : 0.001}
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
                      <div className="mt-2 flex items-center justify-end gap-2">
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
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
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
        className="w-full mx-auto max-w-[1600px] space-y-5 bg-gray-50 rounded-xl border border-gray-200 shadow-sm p-4 sm:p-5 lg:p-6"
      >
        <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-gray-200">
          <div>
            <h2 className="text-xl sm:text-2xl font-bold text-gray-900 tracking-tight">
              Registrar venta
            </h2>
            <p className="text-sm text-gray-600 mt-1">
              Elegí productos a la izquierda; completá líneas a la derecha.
            </p>
          </div>
          <div className="shrink-0">
            <RefreshButton onClick={handleRefresh} loading={isRefreshing} />
          </div>
        </div>

        <div className="flex flex-col lg:flex-row gap-5 lg:items-stretch">
          {/* —— Catálogo (Figma: grid con imagen) —— */}
          <aside className="w-full lg:w-[min(42%,480px)] xl:w-[min(40%,520px)] shrink-0 flex flex-col rounded-xl border-2 border-gray-200 bg-white overflow-hidden shadow-sm max-h-[85vh] lg:max-h-[calc(100vh-8rem)]">
            <div className="p-3 border-b border-gray-100 bg-gradient-to-r from-blue-50 to-white">
              <h3 className="font-bold text-gray-900 text-sm mb-2">
                Productos con existencia
              </h3>
              <div className="relative">
                <Search
                  className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none"
                  aria-hidden
                />
                <input
                  type="search"
                  className={`${webFigmaInput} pl-10`}
                  placeholder="Buscar por nombre…"
                  value={productQuery}
                  onChange={(e) => setProductQuery(e.target.value)}
                />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto overscroll-contain p-3 min-h-[280px]">
              {filteredProductsForPicker.length === 0 ? (
                <p className="text-center text-gray-500 text-sm py-10">
                  No hay productos con stock que coincidan.
                </p>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-2 gap-3">
                  {filteredProductsForPicker.map((p) => {
                    const inCart = chosenIds.has(p.id);
                    const price = latestPriceById[p.id] ?? p.price;
                    const stock = stockById[p.id] || 0;
                    const imgSrc = resolveProductImageSrc(
                      p.imageUrl,
                      p.id,
                      p.productName,
                    );
                    return (
                      <button
                        key={p.id}
                        type="button"
                        disabled={inCart}
                        onClick={() => void addProductById(p.id)}
                        className={`bg-white rounded-xl border-2 text-left overflow-hidden transition-all duration-200 ease-out ${
                          inCart
                            ? "border-gray-200 opacity-55 cursor-not-allowed"
                            : "border-gray-200 shadow-sm hover:border-blue-400 hover:shadow-lg hover:-translate-y-0.5 hover:ring-2 hover:ring-blue-400/25 active:translate-y-0 active:shadow-md group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 focus-visible:ring-offset-2"
                        }`}
                      >
                        <div className="aspect-[4/3] bg-gray-100 relative overflow-hidden">
                          <ImageWithFallback
                            src={imgSrc}
                            alt=""
                            className={`w-full h-full object-cover transition-transform duration-300 ease-out ${
                              inCart ? "" : "group-hover:scale-105"
                            }`}
                          />
                          {stock > 0 && stock < 20 && (
                            <span className="absolute top-2 right-2 bg-red-500 text-white text-[10px] px-2 py-0.5 rounded-full font-semibold">
                              Bajo stock
                            </span>
                          )}
                        </div>
                        <div className="p-2.5">
                          <div className="font-semibold text-xs text-gray-900 line-clamp-2 min-h-[2.25rem]">
                            {p.productName}
                          </div>
                          <div className="mt-2 space-y-1 text-sm">
                            <div className="flex justify-between gap-2 text-gray-700">
                              <span className="font-semibold">Precio</span>
                              <span className="font-bold text-green-600 tabular-nums text-base">
                                {money(price)}
                              </span>
                            </div>
                            <div className="flex justify-between gap-2 text-gray-700">
                              <span className="font-semibold">Stock</span>
                              <span
                                className={`font-bold tabular-nums text-base ${
                                  stock < 20 ? "text-red-600" : "text-gray-900"
                                }`}
                              >
                                {qty3(stock)} {p.measurement}
                              </span>
                            </div>
                          </div>
                          {inCart ? (
                            <p className="text-[10px] text-amber-700 font-medium mt-1">
                              En carrito
                            </p>
                          ) : null}
                        </div>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </aside>

          {/* —— Panel venta / carrito —— */}
          <div className="flex-1 min-w-0 flex flex-col gap-4">
            <div className="rounded-xl border-2 border-gray-200 bg-white p-4 shadow-sm space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-700 mb-1.5">
                    <Calendar className="w-4 h-4 text-blue-600 shrink-0" />
                    Fecha de la venta
                  </label>
                  <input
                    type="date"
                    className={webFigmaInput}
                    value={saleDate}
                    onChange={(e) => setSaleDate(e.target.value)}
                    max={todayStr}
                  />
                </div>
                <div>
                  <label className="flex items-center gap-2 text-xs font-semibold text-gray-700 mb-1.5">
                    {clientType === "CREDITO" ? (
                      <CreditCard className="w-4 h-4 text-blue-600 shrink-0" />
                    ) : (
                      <Wallet className="w-4 h-4 text-green-600 shrink-0" />
                    )}
                    Tipo de cliente
                  </label>
                  <MobileHtmlSelect
                    value={clientType}
                    onChange={(v) => handleClientTypeChange(v as ClientType)}
                    options={clientTypeOptions}
                    selectClassName={`${webFigmaInput} py-2.5`}
                    buttonClassName={webFigmaSelectBtn}
                    sheetTitle="Tipo de cliente"
                  />
                </div>
              </div>

              {clientType === "CONTADO" ? (
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                    Cliente (contado)
                  </label>
                  <input
                    className={webFigmaInput}
                    value={clientName}
                    onChange={(e) => setClientName(e.target.value)}
                    placeholder="Ej: Cliente mostrador"
                  />
                </div>
              ) : (
                <div className="space-y-4 rounded-xl border-2 border-blue-100 bg-blue-50/40 p-4">
                  <MobileHtmlSelect
                    label="Cliente (crédito)"
                    value={customerId}
                    onChange={setCustomerId}
                    options={creditCustomerSelectOptions}
                    selectClassName={`${webFigmaInput} py-2.5`}
                    buttonClassName={webFigmaSelectBtn}
                    sheetTitle="Cliente (crédito)"
                  />
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="p-3 rounded-lg border-2 border-blue-200 bg-white shadow-sm">
                      <div className="text-[11px] font-semibold text-blue-800 uppercase tracking-wide">
                        Saldo actual
                      </div>
                      <div className="text-lg font-bold tabular-nums text-gray-900 mt-0.5">
                        {money(currentBalance)}
                      </div>
                    </div>
                    <div className="space-y-1">
                      <label className="block text-xs font-semibold text-gray-700">
                        Pago inicial
                      </label>
                      <p className="text-[11px] text-gray-500">
                        Máx. {money(maxDownPayment)}
                      </p>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        max={maxDownPayment}
                        className={webFigmaInput}
                        value={downPayment === 0 ? "" : downPayment}
                        onChange={(e) => {
                          const v = Math.max(0, Number(e.target.value || 0));
                          setDownPayment(Math.min(v, maxDownPayment));
                        }}
                        placeholder="0.00"
                      />
                    </div>
                    <div className="p-3 rounded-lg border-2 border-blue-200 bg-white shadow-sm">
                      <div className="text-[11px] font-semibold text-blue-800 uppercase tracking-wide">
                        Saldo proyectado
                      </div>
                      <div className="text-lg font-bold tabular-nums text-gray-900 mt-0.5">
                        {money(projectedBalance)}
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>

            <div className="flex flex-col sm:flex-row gap-2 sm:items-stretch">
              <div className="flex-1 rounded-lg border border-green-300/90 bg-gradient-to-r from-green-50/90 to-green-100/70 px-2.5 py-1.5 shadow-sm">
                <div className="flex flex-wrap items-baseline gap-x-4 gap-y-0.5 text-[13px] leading-tight text-green-900/85">
                  <div className="flex items-baseline gap-1">
                    <span className="font-bold uppercase tracking-wide text-green-800/90">
                      Monto:
                    </span>
                    <span className="tabular-nums font-semibold text-green-950 text-sm">
                      C$ {amountCharged.toFixed(2)}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-bold uppercase tracking-wide text-green-800/90">
                      Libras totales:
                    </span>
                    <span className="tabular-nums font-semibold text-green-950">
                      {qty3(cartQtyTotals.librasTotal)}
                    </span>
                  </div>
                  <div className="flex items-baseline gap-1">
                    <span className="font-bold uppercase tracking-wide text-green-800/90">
                      Unidades totales:
                    </span>
                    <span className="tabular-nums font-semibold text-green-950">
                      {cartQtyTotals.unidadesTotal}
                    </span>
                  </div>
                </div>
              </div>
              <Button
                type="submit"
                variant="primary"
                disabled={items.length === 0 || saving || missingContadoClient}
                className="sm:self-stretch sm:min-w-[8.5rem] !py-2 !rounded-lg !text-xs !font-semibold !bg-green-600 hover:!bg-green-700 !shadow-sm disabled:!bg-gray-300 shrink-0 flex items-center justify-center"
              >
                {saving ? "Guardando..." : "Guardar"}
              </Button>
            </div>

            <section>
              <h2 className="text-xs font-bold uppercase tracking-wide text-gray-500 mb-2">
                Productos Agregados
              </h2>
              <div className="space-y-3 max-h-[min(52vh,560px)] overflow-y-auto pr-1">
                {items.length === 0 ? (
                  <div className="text-sm text-gray-500 border-2 border-dashed border-gray-300 rounded-xl py-10 px-4 text-center bg-white">
                    Hacé clic en un producto de la izquierda para agregarlo.
                  </div>
                ) : (
                  items.map((it) => {
                    const unitApplied = getAppliedUnitPrice(it);
                    const grossLine = round2(
                      Number(unitApplied || 0) * Number(it.qty || 0),
                    );
                    const net = Math.max(
                      0,
                      grossLine - Math.max(0, Number(it.discount || 0)),
                    );
                    const intQtyLine = lineUsesIntegerQty(it);
                    const shownExist = roundQty(
                      Number(it.stock) - Number(it.qty || 0),
                    );
                    return (
                      <div
                        key={it.productId}
                        className="rounded-xl border-2 border-gray-200 bg-white p-4 shadow-sm"
                      >
                        <div className="flex gap-3 mb-3">
                          <div className="w-16 h-16 shrink-0 rounded-xl overflow-hidden border border-gray-200 bg-gray-100">
                            <ImageWithFallback
                              src={cartLineImageSrc(it)}
                              alt=""
                              className="w-full h-full object-cover"
                            />
                          </div>
                          <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-start gap-2">
                          <div className="font-semibold text-gray-900 text-sm leading-snug min-w-0 flex-1 basis-[10rem]">
                            {it.productName}
                          </div>
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-100 px-2.5 py-0.5 text-xs font-semibold uppercase tracking-wide text-slate-700 shrink-0">
                            {it.measurement}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-semibold tabular-nums text-slate-800 shrink-0">
                            Post-venta: {shownExist.toFixed(3)}
                          </span>
                          <span className="inline-flex items-center rounded-full border border-green-200 bg-green-50 px-2.5 py-0.5 text-xs font-bold tabular-nums text-green-800 shrink-0">
                            C$ {round2(it.price).toFixed(2)}
                          </span>
                          <button
                            type="button"
                            onClick={() => removeItem(it.productId)}
                            className="shrink-0 p-2 rounded-lg text-red-600 hover:bg-red-50 border border-red-100 transition-colors sm:ml-auto"
                            title="Quitar"
                            aria-label="Quitar línea"
                          >
                            <Trash2 className="w-4 h-4" />
                          </button>
                        </div>
                          </div>
                        </div>
                        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 text-xs">
                          <div className="sm:col-span-1">
                            <div className="text-gray-500 font-semibold mb-1">
                              Precio especial
                            </div>
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className={`${webFigmaInput} py-1.5 text-right tabular-nums`}
                              value={
                                it.specialPrice === 0 ? "" : it.specialPrice
                              }
                              onKeyDown={numberKeyGuard}
                              onChange={(e) =>
                                setItemSpecialPrice(
                                  it.productId,
                                  e.target.value,
                                )
                              }
                              placeholder="—"
                            />
                            <p className="text-[10px] text-gray-500 mt-0.5">
                              Aplicado: C$ {round2(unitApplied).toFixed(2)}
                            </p>
                          </div>
                          <div>
                            <div className="text-gray-500 font-semibold mb-1">
                              Cantidad
                            </div>
                            <input
                              type="number"
                              step={intQtyLine ? 1 : 0.001}
                              inputMode={intQtyLine ? "numeric" : "decimal"}
                              className={`${webFigmaInput} py-1.5 text-right tabular-nums`}
                              value={
                                it.qtyInput ?? (it.qty === 0 ? "" : it.qty)
                              }
                              onKeyDown={numberKeyGuard}
                              onChange={(e) =>
                                setItemQty(it.productId, e.target.value)
                              }
                              placeholder="0"
                            />
                          </div>
                          <div>
                            <div className="text-gray-500 font-semibold mb-1">
                              Descuento (C$)
                            </div>
                            <input
                              type="number"
                              step={1}
                              min={0}
                              className={`${webFigmaInput} py-1.5 text-right tabular-nums`}
                              value={
                                it.discount === 0 ? "" : it.discount
                              }
                              onChange={(e) =>
                                setItemDiscount(it.productId, e.target.value)
                              }
                              inputMode="numeric"
                              placeholder="0"
                            />
                          </div>
                          <div>
                            <div className="text-gray-500 font-semibold mb-1">
                              Monto
                            </div>
                            <div className="tabular-nums font-bold text-green-700 text-base">
                              C$ {round2(net).toFixed(2)}
                            </div>
                          </div>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </section>

            {clientType === "CONTADO" && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                    Monto recibido
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className={webFigmaInput}
                    value={amountReceived === 0 ? "" : amountReceived}
                    onChange={(e) =>
                      setAmountReceived(Number(e.target.value || 0))
                    }
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-gray-700 mb-1.5">
                    Cambio
                  </label>
                  <div
                    className={`${webFigmaInput} bg-gray-100 font-semibold tabular-nums cursor-default`}
                  >
                    C$ {amountChange}
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

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
