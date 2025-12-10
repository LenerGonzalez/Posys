// src/components/Candies/VendorCandyOrders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
  runTransaction,
} from "firebase/firestore";
import { db } from "../../../firebase";
import RefreshButton from "../../common/RefreshButton";
import useManualRefresh from "../../../hooks/useManualRefresh";
import { allocateSaleFIFOCandy } from "../../../Services/inventory_candies";

// ===== Tipos base =====
interface Seller {
  id: string;
  name: string;
  email?: string;
  commissionPercent?: number; // % comisión sobre el total del pedido
}

interface ProductCandy {
  id: string;
  name: string;
  category: string;
  providerPrice: number; // Precio proveedor (por paquete)
  packages: number;
  unitsPerPackage: number;
}

// Sub-inventario por vendedor (cada doc = 1 producto de 1 pedido)
interface VendorCandyRow {
  id: string;
  sellerId: string;
  sellerName: string;
  productId: string;
  productName: string;
  category: string;

  orderId?: string | null; // para agrupar el pedido

  packages: number;
  unitsPerPackage: number;
  totalUnits: number;
  remainingPackages: number;
  remainingUnits: number;

  providerPrice: number; // por paquete
  markupPercent: number; // % margen que ingresás
  subtotal: number; // costo
  totalVendor: number; // subtotal / (1 - %/100)
  gainVendor: number; // totalVendor - subtotal
  unitPriceVendor: number; // precio por PAQUETE para el vendedor

  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
}

// Ítem de pedido (UI del modal)
interface OrderItem {
  id: string; // en modo edición uso el id del doc de Firestore, en modo nuevo es temporal
  productId: string;
  productName: string;
  category: string;
  providerPrice: number;
  unitsPerPackage: number;
  packages: number;
  subtotal: number;
  totalVendor: number;
  gainVendor: number;
  pricePerPackage: number;
  /** Nuevo: para mostrar paquetes restantes por producto en el detalle */
  remainingPackages?: number;
}

// Resumen de pedido para el listado
interface OrderSummaryRow {
  orderKey: string; // orderId ó fallback (id de la fila)
  sellerId: string;
  sellerName: string;
  date: string;
  markupPercent: number;
  totalPackages: number;
  /** Nuevo: suma de remainingPackages por pedido */
  totalRemainingPackages: number;
  subtotal: number;
  totalVendor: number;
}

function roundToInt(v: number): number {
  if (!isFinite(v)) return 0;
  return Math.round(v);
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// ===== Helpers internos para manejar unidades en inventory_candies =====
function getBaseUnitsFromInventoryDoc(data: any): number {
  const unitsPerPackage = Math.max(
    1,
    Math.floor(Number(data.unitsPerPackage || 1))
  );
  const totalUnits = Number(data.totalUnits || 0);
  const quantity = Number(data.quantity || 0);
  const packages = Number(data.packages || 0);

  if (totalUnits > 0) return Math.floor(totalUnits);
  if (quantity > 0) return Math.floor(quantity);
  if (packages > 0) return Math.floor(packages * unitsPerPackage);
  return 0;
}

function getRemainingUnitsFromInventoryDoc(data: any): number {
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.floor(remainingField);
  }
  return getBaseUnitsFromInventoryDoc(data);
}

/**
 * Restaura paquetes al inventario principal **sin crear nuevos lotes**.
 *
 * 🔹 Comportamiento:
 * - Calcula cuántas unidades representan esos paquetes.
 * - Recorre los lotes de `inventory_candies` del producto en orden FIFO.
 * - Solo incrementa `remaining` hasta el máximo `baseUnits` de cada lote
 *   (es decir, repone lo que antes se había consumido).
 * - Si no hay lotes para ese producto, hace fallback al comportamiento
 *   anterior: crea un lote nuevo (caso raro, pero mantiene compatibilidad).
 *
 * ✅ Esto evita el bug de duplicar inventarios por producto cuando:
 *   - Editas un pedido de vendedor (delta negativo).
 *   - Borras un pedido de vendedor.
 */
async function restorePacksToMainInventory(
  product: ProductCandy | undefined,
  productId: string,
  packs: number,
  _dateStr: string
) {
  const safePacks = Math.max(0, Math.floor(Number(packs || 0)));
  if (safePacks <= 0) return;

  // 1) Determinar unitsPerPackage "global"
  let unitsPerPackageGlobal = Math.floor(Number(product?.unitsPerPackage || 0));
  if (unitsPerPackageGlobal <= 0) unitsPerPackageGlobal = 1;

  // 2) Buscar lotes existentes de este producto
  const qInv = query(
    collection(db, "inventory_candies"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(qInv);

  // Si no hay lotes, dejamos el comportamiento anterior como fallback:
  // crear un nuevo lote (caso muy raro).
  if (snap.empty) {
    const totalUnits = safePacks * unitsPerPackageGlobal;
    const providerPrice = Number(product?.providerPrice || 0);

    await addDoc(collection(db, "inventory_candies"), {
      productId: product?.id || productId,
      productName: product?.name || "",
      category: product?.category || "",
      measurement: "unidad",
      quantity: totalUnits,
      remaining: totalUnits,
      packages: safePacks,
      unitsPerPackage: unitsPerPackageGlobal,
      totalUnits,
      providerPrice,
      date: _dateStr,
      createdAt: Timestamp.now(),
      status: "DEVUELTO_VENDEDOR",
    });
    return;
  }

  // Si hay lotes, usamos FIFO por fecha + createdAt
  const docsSorted = snap.docs
    .map((d) => ({
      ref: d.ref,
      data: d.data() as any,
    }))
    .sort((a, b) => {
      const da = String(a.data.date || "");
      const dbs = String(b.data.date || "");
      if (da !== dbs) return da < dbs ? -1 : 1;
      const ca = a.data.createdAt?.seconds ?? 0;
      const cb = b.data.createdAt?.seconds ?? 0;
      return ca - cb;
    });

  const totalUnitsToReturn = safePacks * unitsPerPackageGlobal;

  await runTransaction(db, async (tx) => {
    let remainingUnitsToReturn = totalUnitsToReturn;

    const txSnaps = await Promise.all(docsSorted.map((d) => tx.get(d.ref)));

    for (let i = 0; i < docsSorted.length && remainingUnitsToReturn > 0; i++) {
      const snapDoc = txSnaps[i];
      if (!snapDoc.exists()) continue;

      const data = snapDoc.data() as any;
      const baseUnits = getBaseUnitsFromInventoryDoc(data);
      const remUnits = getRemainingUnitsFromInventoryDoc(data);

      // Capacidad que se puede recuperar en este lote (lo que se había consumido)
      const usedUnits = Math.max(0, baseUnits - remUnits);
      if (usedUnits <= 0) continue;

      const addUnits = Math.min(usedUnits, remainingUnitsToReturn);
      const newRemUnits = remUnits + addUnits;

      const localUnitsPerPack = Math.max(
        1,
        Math.floor(Number(data.unitsPerPackage || unitsPerPackageGlobal || 1))
      );
      const newRemainingPackages = Math.floor(newRemUnits / localUnitsPerPack);

      tx.update(docsSorted[i].ref, {
        remaining: newRemUnits,
        remainingPackages: newRemainingPackages,
        packages: newRemainingPackages,
      });

      remainingUnitsToReturn -= addUnits;
    }

    if (remainingUnitsToReturn > 0) {
      console.warn(
        "[restorePacksToMainInventory] Quedaron unidades por devolver, no se crearon nuevos lotes.",
        { productId, remainingUnitsToReturn }
      );
    }
  });
}

export default function VendorCandyOrders() {
  const { refreshKey, refresh } = useManualRefresh();

  // ===== Catálogos =====
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [products, setProducts] = useState<ProductCandy[]>([]);
  const [availablePacks, setAvailablePacks] = useState<Record<string, number>>(
    {}
  ); // productId -> paq disponibles

  // ===== Sub-inventario (todas las líneas por vendedor) =====
  const [rows, setRows] = useState<VendorCandyRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // ===== Modal pedido =====
  const [openForm, setOpenForm] = useState(false);
  const [editingOrderKey, setEditingOrderKey] = useState<string | null>(null);
  const [originalOrderRows, setOriginalOrderRows] = useState<VendorCandyRow[]>(
    []
  ); // snapshot del pedido antes de editar

  const [sellerId, setSellerId] = useState<string>("");
  const [date, setDate] = useState<string>("");

  // % margen global del pedido
  const [markupPercent, setMarkupPercent] = useState<string>("30");

  // Productos del pedido
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [packagesToAdd, setPackagesToAdd] = useState<string>("0");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);

  // Helpers memorizados
  const selectedSeller = useMemo(
    () => sellers.find((s) => s.id === sellerId) || null,
    [sellerId, sellers]
  );

  const selectedProduct = useMemo(
    () => products.find((p) => p.id === selectedProductId) || null,
    [selectedProductId, products]
  );

  const sellersById = useMemo(() => {
    const m: Record<string, Seller> = {};
    sellers.forEach((s) => (m[s.id] = s));
    return m;
  }, [sellers]);

  // ===== Carga de datos =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // Vendedores
        const sSnap = await getDocs(
          query(collection(db, "sellers_candies"), orderBy("name", "asc"))
        );
        const sList: Seller[] = [];
        sSnap.forEach((d) => {
          const x = d.data() as any;
          sList.push({
            id: d.id,
            name: x.name || "",
            email: x.email || "",
            commissionPercent: Number(x.commissionPercent || 0),
          });
        });
        setSellers(sList);

        // Productos
        const pSnap = await getDocs(
          query(collection(db, "products_candies"), orderBy("name", "asc"))
        );
        const pList: ProductCandy[] = [];
        pSnap.forEach((d) => {
          const x = d.data() as any;
          pList.push({
            id: d.id,
            name: x.name || "",
            category: x.category || "",
            providerPrice: Number(x.providerPrice || 0),
            packages: Number(x.packages || 0),
            unitsPerPackage: Number(x.unitsPerPackage || 0),
          });
        });
        setProducts(pList);

        // Inventario general (para ver disponibilidad en selector)
        const invGeneralSnap = await getDocs(
          collection(db, "inventory_candies")
        );
        const avail: Record<string, number> = {};
        invGeneralSnap.forEach((d) => {
          const x = d.data() as any;
          const pid = x.productId;
          if (!pid) return;
          const remainingUnits = Number(x.remaining ?? x.quantity ?? 0);
          const upp = Number(x.unitsPerPackage || 0);
          let packs = 0;
          if (upp > 0) {
            packs = remainingUnits / upp;
          } else {
            packs = Number(x.packages || 0);
          }
          avail[pid] = (avail[pid] || 0) + packs;
        });
        Object.keys(avail).forEach((k) => {
          avail[k] = Math.floor(avail[k]);
        });
        setAvailablePacks(avail);

        // Subinventario por vendedor (cada doc = línea de pedido)
        const invSnap = await getDocs(
          query(
            collection(db, "inventory_candies_sellers"),
            orderBy("createdAt", "desc")
          )
        );
        const invList: VendorCandyRow[] = [];
        invSnap.forEach((d) => {
          const x = d.data() as any;
          invList.push({
            id: d.id,
            sellerId: x.sellerId,
            sellerName: x.sellerName || "",
            productId: x.productId,
            productName: x.productName || "",
            category: x.category || "",
            orderId: x.orderId || null,
            packages: Number(x.packages || 0),
            unitsPerPackage: Number(x.unitsPerPackage || 0),
            totalUnits: Number(x.totalUnits || 0),
            remainingPackages: Number(x.remainingPackages || 0),
            remainingUnits: Number(x.remainingUnits || 0),
            providerPrice: Number(x.providerPrice || 0),
            markupPercent: Number(x.markupPercent || 0),
            subtotal: Number(x.subtotal || 0),
            totalVendor: Number(x.totalVendor || 0),
            gainVendor: Number(x.gainVendor || 0),
            unitPriceVendor: Number(x.unitPriceVendor || 0),
            date: x.date || "",
            createdAt: x.createdAt || Timestamp.now(),
          });
        });
        setRows(invList);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando datos de vendedores / pedidos.");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  // ===== Resumen por pedido (agrupado) =====
  const orders: OrderSummaryRow[] = useMemo(() => {
    const map: Record<string, OrderSummaryRow> = {};

    for (const r of rows) {
      const key = r.orderId || r.id; // si no hay orderId, cada fila es un pedido viejo
      const existing = map[key];

      const dateStr =
        r.date ||
        (r.createdAt?.toDate
          ? r.createdAt.toDate().toISOString().slice(0, 10)
          : "");

      if (!existing) {
        map[key] = {
          orderKey: key,
          sellerId: r.sellerId,
          sellerName: r.sellerName,
          date: dateStr,
          markupPercent: r.markupPercent,
          totalPackages: r.packages,
          totalRemainingPackages: r.remainingPackages,
          subtotal: r.subtotal,
          totalVendor: r.totalVendor,
        };
      } else {
        existing.totalPackages += r.packages;
        existing.totalRemainingPackages += r.remainingPackages;
        existing.subtotal += r.subtotal;
        existing.totalVendor += r.totalVendor;
        // Fecha nos quedamos con la más reciente
        if (dateStr > existing.date) existing.date = dateStr;
      }
    }

    return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
  }, [rows]);

  // ===== Resumen del pedido actual (para el modal) =====
  const orderSummary = useMemo(() => {
    const totalPackages = orderItems.reduce((acc, it) => acc + it.packages, 0);
    const subtotal = orderItems.reduce((acc, it) => acc + it.subtotal, 0);
    const totalVendor = orderItems.reduce((acc, it) => acc + it.totalVendor, 0);
    const gainVendor = orderItems.reduce((acc, it) => acc + it.gainVendor, 0);

    const commissionPercent = Number(selectedSeller?.commissionPercent || 0);
    const commissionAmount = (totalVendor * commissionPercent) / 100;

    return {
      totalPackages,
      subtotal,
      totalVendor,
      gainVendor,
      commissionPercent,
      commissionAmount,
    };
  }, [orderItems, selectedSeller]);

  // ===== Helpers =====
  const resetOrder = () => {
    setEditingOrderKey(null);
    setOriginalOrderRows([]);
    setSellerId("");
    setDate("");
    setMarkupPercent("30");
    setSelectedProductId("");
    setPackagesToAdd("0");
    setOrderItems([]);
  };

  // Lógica de cálculo por ítem según tu regla de margen
  function recalcItemWithMargin(
    base: {
      providerPrice: number;
      packages: number;
    },
    marginPercent: number
  ) {
    const providerPrice = Number(base.providerPrice || 0);
    const packs = Number(base.packages || 0);
    const subtotal = providerPrice * packs;

    const margin = marginPercent / 100;
    const divisor = 1 - margin;
    const totalVendor =
      subtotal > 0 && divisor > 0 ? subtotal / divisor : subtotal;
    const gainVendor = totalVendor - subtotal;
    const pricePerPackage = packs > 0 ? roundToInt(totalVendor / packs) : 0;

    return { subtotal, totalVendor, gainVendor, pricePerPackage };
  }

  function buildOrderItem(
    product: ProductCandy,
    packs: number,
    marginPercent: number
  ): OrderItem {
    const { subtotal, totalVendor, gainVendor, pricePerPackage } =
      recalcItemWithMargin(
        {
          providerPrice: product.providerPrice,
          packages: packs,
        },
        marginPercent
      );

    return {
      id: `${product.id}-${Date.now()}-${Math.random()}`,
      productId: product.id,
      productName: product.name,
      category: product.category,
      providerPrice: product.providerPrice,
      unitsPerPackage: product.unitsPerPackage,
      packages: packs,
      subtotal,
      totalVendor,
      gainVendor,
      pricePerPackage,
      // Nuevo: para pedidos nuevos, restantes = paquetes asignados
      remainingPackages: packs,
    };
  }

  // Recalcular todos los ítems cuando cambia el % margen
  const applyMarginToAllItems = (newMarginPercent: number) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        const { subtotal, totalVendor, gainVendor, pricePerPackage } =
          recalcItemWithMargin(
            {
              providerPrice: it.providerPrice,
              packages: it.packages,
            },
            newMarginPercent
          );
        return {
          ...it,
          subtotal,
          totalVendor,
          gainVendor,
          pricePerPackage,
        };
      })
    );
  };

  // ===== Agregar producto al pedido =====
  const handleAddItem = () => {
    if (!selectedProduct) {
      setMsg("Selecciona un producto antes de agregarlo.");
      return;
    }
    const packsNum = Number(packagesToAdd || 0);
    if (packsNum <= 0) {
      setMsg("La cantidad de paquetes debe ser mayor a 0.");
      return;
    }

    const available = availablePacks[selectedProduct.id] ?? 0;
    if (!editingOrderKey && packsNum > available) {
      // En modo nuevo pedido validamos disponibilidad
      setMsg(
        `No hay suficientes paquetes en inventario general. Disponibles: ${available}`
      );
      return;
    }

    const marginPercent = Number(markupPercent || 0);
    const item = buildOrderItem(selectedProduct, packsNum, marginPercent);

    setOrderItems((prev) => [...prev, item]);
    setPackagesToAdd("0");
  };

  const handleRemoveItem = (id: string) => {
    setOrderItems((prev) => prev.filter((x) => x.id !== id));
  };

  // Cambios en campos de ítem (ej. providerPrice o packages)
  const handleItemFieldChange = (
    id: string,
    field: "providerPrice" | "packages",
    value: string
  ) => {
    const num = Number(value || 0);
    const marginPercent = Number(markupPercent || 0);

    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;
        const newBase = {
          providerPrice:
            field === "providerPrice" ? num : Number(it.providerPrice || 0),
          packages: field === "packages" ? num : Number(it.packages || 0),
        };
        const { subtotal, totalVendor, gainVendor, pricePerPackage } =
          recalcItemWithMargin(newBase, marginPercent);

        return {
          ...it,
          providerPrice: newBase.providerPrice,
          packages: newBase.packages,
          subtotal,
          totalVendor,
          gainVendor,
          pricePerPackage,
        };
      })
    );
  };

  // ===== Guardar pedido (nuevo o edición) =====
  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!selectedSeller) {
      setMsg("Selecciona un vendedor.");
      return;
    }
    if (!orderItems.length) {
      setMsg("Agrega al menos un producto al pedido.");
      return;
    }

    const todayStr = new Date().toISOString().slice(0, 10);
    const dateStr = date || todayStr;
    const marginPercentNum = Number(markupPercent || 0);

    try {
      setLoading(true);

      if (editingOrderKey) {
        // ===== MODO EDICIÓN DE UN PEDIDO EXISTENTE =====
        // Mapa original por productId
        const originalByProduct: Record<string, VendorCandyRow> = {};
        originalOrderRows.forEach((r) => {
          originalByProduct[r.productId] = r;
        });

        // Mapa nuevo por productId
        const newByProduct: Record<string, OrderItem> = {};
        orderItems.forEach((it) => {
          newByProduct[it.productId] = it;
        });

        // 1) Ajustar inventario principal según diferencias
        //    a) productos nuevos o con delta de paquetes
        for (const productId of Object.keys(newByProduct)) {
          const newItem = newByProduct[productId];
          const oldRow = originalByProduct[productId];
          const newPacks = Number(newItem.packages || 0);
          const oldPacks = oldRow ? Number(oldRow.packages || 0) : 0;
          const delta = newPacks - oldPacks;

          if (delta > 0) {
            // asignás más paquetes al vendedor → quitar del inventario principal
            await allocateSaleFIFOCandy({
              productId,
              quantityPacks: delta,
              saleDate: dateStr,
            });
          } else if (delta < 0) {
            // le quitás paquetes al vendedor → regresar al inventario principal (SIN crear lotes nuevos)
            const prod = products.find((p) => p.id === productId);
            await restorePacksToMainInventory(prod, productId, -delta, dateStr);
          }
        }

        //    b) productos eliminados del pedido → regresar TODOS sus paquetes
        for (const productId of Object.keys(originalByProduct)) {
          if (!newByProduct[productId]) {
            const oldRow = originalByProduct[productId];
            const prod = products.find((p) => p.id === productId);
            await restorePacksToMainInventory(
              prod,
              productId,
              oldRow.packages,
              dateStr
            );
          }
        }

        // 2) Actualizar / crear / eliminar docs en inventory_candies_sellers
        let newRowsState = [...rows];

        // a) Actualizar o crear
        for (const productId of Object.keys(newByProduct)) {
          const it = newByProduct[productId];
          const oldRow = originalByProduct[productId];
          const product = products.find((p) => p.id === productId);
          const unitsPerPackage =
            product?.unitsPerPackage || it.unitsPerPackage || 0;
          const totalUnits =
            it.packages > 0 && unitsPerPackage > 0
              ? it.packages * unitsPerPackage
              : 0;

          if (oldRow) {
            // actualizar doc existente
            await updateDoc(doc(db, "inventory_candies_sellers", oldRow.id), {
              sellerId: selectedSeller.id,
              sellerName: selectedSeller.name,
              productId,
              productName: it.productName,
              category: it.category,
              packages: it.packages,
              unitsPerPackage,
              totalUnits,
              // mantenemos la lógica original: remaining = packages del pedido
              remainingPackages: it.packages,
              remainingUnits: totalUnits,
              providerPrice: it.providerPrice,
              markupPercent: marginPercentNum,
              subtotal: it.subtotal,
              totalVendor: it.totalVendor,
              gainVendor: it.gainVendor,
              unitPriceVendor: it.pricePerPackage,
              date: dateStr,
              orderId: oldRow.orderId || editingOrderKey,
              updatedAt: Timestamp.now(),
            });

            newRowsState = newRowsState.map((r) =>
              r.id === oldRow.id
                ? {
                    ...r,
                    sellerId: selectedSeller.id,
                    sellerName: selectedSeller.name,
                    productId,
                    productName: it.productName,
                    category: it.category,
                    packages: it.packages,
                    unitsPerPackage,
                    totalUnits,
                    remainingPackages: it.packages,
                    remainingUnits: totalUnits,
                    providerPrice: it.providerPrice,
                    markupPercent: marginPercentNum,
                    subtotal: it.subtotal,
                    totalVendor: it.totalVendor,
                    gainVendor: it.gainVendor,
                    unitPriceVendor: it.pricePerPackage,
                    date: dateStr,
                    orderId: oldRow.orderId || editingOrderKey,
                  }
                : r
            );
          } else {
            // producto nuevo en el pedido → crear doc
            const docData = {
              sellerId: selectedSeller.id,
              sellerName: selectedSeller.name,
              productId,
              productName: it.productName,
              category: it.category,
              orderId: editingOrderKey,
              packages: it.packages,
              unitsPerPackage,
              totalUnits,
              remainingPackages: it.packages,
              remainingUnits: totalUnits,
              providerPrice: it.providerPrice,
              markupPercent: marginPercentNum,
              subtotal: it.subtotal,
              totalVendor: it.totalVendor,
              gainVendor: it.gainVendor,
              unitPriceVendor: it.pricePerPackage,
              date: dateStr,
              createdAt: Timestamp.now(),
              status: "ASIGNADO",
            };

            const ref = await addDoc(
              collection(db, "inventory_candies_sellers"),
              docData
            );

            newRowsState = [
              {
                id: ref.id,
                ...docData,
              },
              ...newRowsState,
            ];
          }
        }

        // b) Eliminar docs de productos que ya no están en el pedido
        for (const productId of Object.keys(originalByProduct)) {
          if (!newByProduct[productId]) {
            const oldRow = originalByProduct[productId];
            await deleteDoc(doc(db, "inventory_candies_sellers", oldRow.id));
            newRowsState = newRowsState.filter((r) => r.id !== oldRow.id);
          }
        }

        setRows(newRowsState);
        setMsg(
          "✅ Pedido actualizado para el vendedor y sincronizado con inventario principal."
        );
      } else {
        // ===== MODO NUEVO PEDIDO =====
        const orderKey = `ORD-${Date.now()}-${Math.random()
          .toString(36)
          .slice(2, 8)}`;

        for (const it of orderItems) {
          const product = products.find((p) => p.id === it.productId);
          if (!product) continue;

          const totalUnits =
            it.packages > 0 && product.unitsPerPackage > 0
              ? it.packages * product.unitsPerPackage
              : 0;

          // 1) Descontar del inventario general en PAQUETES
          await allocateSaleFIFOCandy({
            productId: it.productId,
            quantityPacks: it.packages,
            saleDate: dateStr,
          });

          // 2) Crear el lote del vendedor
          const docData = {
            sellerId: selectedSeller.id,
            sellerName: selectedSeller.name,
            productId: it.productId,
            productName: it.productName,
            category: it.category,

            orderId: orderKey,

            packages: it.packages,
            unitsPerPackage: product.unitsPerPackage,
            totalUnits,
            remainingPackages: it.packages,
            remainingUnits: totalUnits,

            providerPrice: it.providerPrice,
            markupPercent: marginPercentNum,
            subtotal: it.subtotal,
            totalVendor: it.totalVendor,
            gainVendor: it.gainVendor,
            unitPriceVendor: it.pricePerPackage,

            date: dateStr,
            createdAt: Timestamp.now(),
            status: "ASIGNADO",
          };

          const ref = await addDoc(
            collection(db, "inventory_candies_sellers"),
            docData
          );

          setRows((prev) => [
            {
              id: ref.id,
              ...docData,
            },
            ...prev,
          ]);
        }

        setMsg("✅ Pedido asignado al vendedor y descontado del inventario.");
      }

      resetOrder();
      setOpenForm(false);
    } catch (err: any) {
      console.error(err);
      setMsg(
        err?.message ||
          "❌ Error al guardar el pedido del vendedor / ajustar inventario."
      );
    } finally {
      setLoading(false);
    }
  };

  // ===== Imprimir pedido actual =====
  const handlePrintOrder = () => {
    if (!selectedSeller) {
      setMsg("Selecciona un vendedor para imprimir el pedido.");
      return;
    }
    if (!orderItems.length) {
      setMsg("No hay productos en el pedido para imprimir.");
      return;
    }

    const dateStr = date || new Date().toISOString().slice(0, 10);
    const esc = (s: string) =>
      (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const title = "Pedido de dulces para vendedor";

    const rowsHtml = orderItems
      .map(
        (it) => `
      <tr>
        <td>${esc(it.productName)}</td>
        <td class="right">${esc(it.category || "")}</td>
        <td class="right">${it.packages}</td>
        <td class="right">${money(it.providerPrice)}</td>
        <td class="right">${money(it.subtotal)}</td>
        <td class="right">${money(it.pricePerPackage)}</td>
        <td class="right">${money(it.totalVendor)}</td>
      </tr>`
      )
      .join("");

    const html = `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>${esc(title)}</title>
  <style>
    *{font-family: Arial, sans-serif; box-sizing:border-box;}
    body{margin:16px;font-size:13px;}
    h1{font-size:18px;margin:0 0 4px;}
    h2{font-size:14px;margin:12px 0 6px;}
    .muted{color:#555;font-size:11px;margin-bottom:10px;}
    .grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:6px 18px;margin:10px 0 14px;}
    .card{border:1px solid #ddd;border-radius:6px;padding:6px 8px;background:#fafafa;}
    .label{font-size:11px;color:#555;margin-bottom:2px;}
    .value{font-size:14px;font-weight:bold;}
    table{width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;}
    th,td{border:1px solid #ddd;padding:4px 6px;}
    th{background:#f5f5f5;text-align:left;}
    .right{text-align:right;}
    @media print{
      @page{size:A5;margin:10mm;}
      body{margin:0;font-size:12px;}
    }
  </style>
</head>
<body>
  <h1>${esc(title)}</h1>
  <div class="muted">
    Fecha pedido: <b>${esc(dateStr)}</b><br/>
    Vendedor: <b>${esc(selectedSeller.name)}</b>${
      selectedSeller.commissionPercent
        ? ` &mdash; Comisión: <b>${selectedSeller.commissionPercent.toFixed(
            2
          )}%</b>`
        : ""
    }<br/>
    % margen aplicado sobre costo: <b>${esc(markupPercent)}%</b>
  </div>

  <div class="grid">
    <div class="card">
      <div class="label">Paquetes totales del pedido</div>
      <div class="value">${orderSummary.totalPackages}</div>
    </div>
    <div class="card">
      <div class="label">Subtotal costo (proveedor)</div>
      <div class="value">${money(orderSummary.subtotal)}</div>
    </div>
    <div class="card">
      <div class="label">Total con margen aplicado</div>
      <div class="value">${money(orderSummary.totalVendor)}</div>
    </div>
    <div class="card">
      <div class="label">Comisión posible del vendedor</div>
      <div class="value">${money(orderSummary.commissionAmount)}</div>
    </div>
  </div>

  <h2>Detalle del pedido</h2>
  <table>
    <thead>
      <tr>
        <th>Producto</th>
        <th class="right">Categoría</th>
        <th class="right">Paquetes</th>
        <th class="right">P. Proveedor (paq)</th>
        <th class="right">Subtotal</th>
        <th class="right">P. Paquete vendedor</th>
        <th class="right">Total vendedor</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml}
    </tbody>
  </table>

  <script>window.print()</script>
</body>
</html>`;

    const w = window.open("", "_blank");
    if (!w) {
      alert(
        "No se pudo abrir la ventana de impresión (revisa bloqueadores de pop-ups)."
      );
      return;
    }
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  // ===== Abrir un pedido del listado para ver/editar =====
  const openOrderForEdit = (orderKey: string) => {
    const relatedRows = rows.filter((r) => (r.orderId || r.id) === orderKey);
    if (!relatedRows.length) {
      setMsg("No se encontraron filas para este pedido.");
      return;
    }

    const first = relatedRows[0];
    setEditingOrderKey(orderKey);
    setOriginalOrderRows(relatedRows);
    setSellerId(first.sellerId);
    setDate(first.date);
    setMarkupPercent(first.markupPercent.toString());

    const items: OrderItem[] = relatedRows.map((r) => ({
      id: r.id, // importante: aquí id = docId de Firestore
      productId: r.productId,
      productName: r.productName,
      category: r.category,
      providerPrice: r.providerPrice,
      unitsPerPackage: r.unitsPerPackage,
      packages: r.packages,
      subtotal: r.subtotal,
      totalVendor: r.totalVendor,
      gainVendor: r.gainVendor,
      pricePerPackage: r.unitPriceVendor,
      // nuevo: para mostrar en el detalle
      remainingPackages: r.remainingPackages,
    }));

    setOrderItems(items);
    setSelectedProductId("");
    setPackagesToAdd("0");
    setOpenForm(true);
  };

  // ===== Eliminar pedido completo =====
  const handleDeleteOrder = async (orderKey: string) => {
    const relatedRows = rows.filter((r) => (r.orderId || r.id) === orderKey);
    if (!relatedRows.length) return;

    const sellerName = relatedRows[0].sellerName || "";
    const ok = confirm(
      `¿Eliminar COMPLETAMENTE este pedido del vendedor "${sellerName}"? Se regresarán los paquetes al inventario principal.`
    );
    if (!ok) return;

    try {
      setLoading(true);
      const todayStr = new Date().toISOString().slice(0, 10);

      for (const r of relatedRows) {
        const prod = products.find((p) => p.id === r.productId);
        // regresar los paquetes de este producto al inventario principal
        // 🔴 Ahora sin crear nuevos lotes, solo restaurando en los existentes
        await restorePacksToMainInventory(
          prod,
          r.productId,
          r.packages,
          todayStr
        );
        // borrar el doc del subinventario del vendedor
        await deleteDoc(doc(db, "inventory_candies_sellers", r.id));
      }

      setRows((prev) => prev.filter((r) => (r.orderId || r.id) !== orderKey));
      setMsg(
        "🗑️ Pedido eliminado y paquetes regresados al inventario principal."
      );
    } catch (e) {
      console.error(e);
      setMsg(
        "❌ Error al eliminar el pedido / regresar paquetes al inventario."
      );
    } finally {
      setLoading(false);
    }
  };

  // ===== Render =====
  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Ordenes de Rutas</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            className="inline-flex items-center gap-2 bg-green-600 text-white px-3 py-2 rounded hover:bg-green-700"
            onClick={() => {
              resetOrder();
              setOpenForm(true);
            }}
          >
            <span className="inline-block bg-green-700/40 rounded-full p-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </span>
            Nuevo pedido a vendedor
          </button>
        </div>
      </div>

      {/* MODAL NUEVO / EDICIÓN DE PEDIDO */}
      {openForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-5xl max-h-[90vh] overflow-y-auto text-sm">
            <h3 className="text-xl font-bold mb-4">
              {editingOrderKey
                ? "Editar pedido de vendedor"
                : "Nuevo pedido para vendedor"}
            </h3>

            {sellers.length === 0 && (
              <p className="text-sm text-red-600 mb-2">
                ⚠️ No hay vendedores. Primero crea vendedores en la pantalla
                correspondiente.
              </p>
            )}

            <form onSubmit={handleSaveOrder} className="space-y-4">
              {/* Header pedido */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Vendedor
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={sellerId}
                    onChange={(e) => setSellerId(e.target.value)}
                  >
                    <option value="">Selecciona un vendedor…</option>
                    {sellers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.commissionPercent
                          ? ` (${s.commissionPercent.toFixed(1)}% comisión)`
                          : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Fecha del pedido
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    % Ganancia (margen sobre costo)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full border p-2 rounded"
                    value={markupPercent}
                    onChange={(e) => {
                      const v = e.target.value;
                      setMarkupPercent(v);
                      const num = Number(v || 0);
                      applyMarginToAllItems(num);
                    }}
                    placeholder="Ej: 30"
                  />
                  <p className="text-[11px] text-gray-500 mt-1">
                    Se aplica como: subtotal / (1 - %/100). Ej: 30% → /0.70
                  </p>
                </div>
              </div>

              {/* Sección para agregar productos */}
              <div className="border rounded p-3 bg-gray-50">
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 items-end">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-semibold">
                      Producto
                    </label>
                    <select
                      className="w-full border p-2 rounded"
                      value={selectedProductId}
                      onChange={(e) => setSelectedProductId(e.target.value)}
                    >
                      <option value="">Selecciona un producto…</option>
                      {products.map((p) => {
                        const avail = availablePacks[p.id];
                        return (
                          <option key={p.id} value={p.id}>
                            {p.category ? `${p.category} - ` : ""}
                            {p.name}
                            {typeof avail === "number"
                              ? ` — Disp: ${avail} paq`
                              : ""}
                          </option>
                        );
                      })}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold">
                      Paquetes / bolsas
                    </label>
                    <input
                      type="number"
                      min={0}
                      className="w-full border p-2 rounded"
                      value={packagesToAdd}
                      onChange={(e) => setPackagesToAdd(e.target.value)}
                    />
                  </div>
                </div>
                <div className="flex justify-end mt-3">
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    disabled={!selectedProductId}
                  >
                    Agregar producto al pedido
                  </button>
                </div>
              </div>

              {/* Tabla de productos del pedido */}
              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[900px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Categoría</th>
                      <th className="p-2 border">Paquetes</th>
                      {/* NUEVA COLUMNA: paquetes restantes por producto */}
                      <th className="p-2 border">Paquetes restantes</th>
                      <th className="p-2 border">Paq x Und (ref)</th>
                      <th className="p-2 border">P. proveedor (paq)</th>
                      <th className="p-2 border">Subtotal</th>
                      <th className="p-2 border">P. paquete vendedor</th>
                      <th className="p-2 border">Total vendedor</th>
                      <th className="p-2 border">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={10}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay productos en este pedido. Agrega al menos uno.
                        </td>
                      </tr>
                    ) : (
                      orderItems.map((it) => (
                        <tr
                          key={it.id}
                          className="text-center whitespace-nowrap"
                        >
                          <td className="p-2 border">{it.productName}</td>
                          <td className="p-2 border">{it.category}</td>

                          {/* Paquetes: ahora se pueden editar también en modo edición */}
                          <td className="p-2 border">
                            <input
                              type="number"
                              min={0}
                              className="border p-1 rounded text-right text-xs w-20"
                              value={it.packages}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "packages",
                                  e.target.value
                                )
                              }
                            />
                          </td>

                          {/* NUEVO: Paquetes restantes (solo display) */}
                          <td className="p-2 border">
                            {it.remainingPackages ?? it.packages}
                          </td>

                          <td className="p-2 border">
                            {it.unitsPerPackage || "—"}
                          </td>

                          {/* P. proveedor editable si quisieras ajustar costo */}
                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              className="border p-1 rounded text-right text-xs w-24"
                              value={it.providerPrice}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "providerPrice",
                                  e.target.value
                                )
                              }
                            />
                          </td>

                          <td className="p-2 border">{money(it.subtotal)}</td>
                          <td className="p-2 border">
                            {money(it.pricePerPackage)}
                          </td>
                          <td className="p-2 border">
                            {money(it.totalVendor)}
                          </td>
                          <td className="p-2 border">
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                              onClick={() => handleRemoveItem(it.id)}
                            >
                              Quitar
                            </button>
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* KPIs del pedido */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes totales del pedido
                  </div>
                  <div className="text-lg font-semibold">
                    {orderSummary.totalPackages}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Subtotal costo (proveedor)
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderSummary.subtotal)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total con margen aplicado
                  </div>
                  <div className="text-lg font-semibold text-green-600">
                    {money(orderSummary.totalVendor)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Comisión posible vendedor
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderSummary.commissionAmount)}
                  </div>
                </div>
              </div>

              {/* Botones */}
              <div className="flex justify-end gap-2 mt-4">
                <button
                  type="button"
                  onClick={resetOrder}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Limpiar pedido
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetOrder();
                    setOpenForm(false);
                  }}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Cerrar
                </button>
                <button
                  type="button"
                  onClick={handlePrintOrder}
                  className="px-3 py-1 rounded bg-purple-600 text-white hover:bg-purple-700"
                  disabled={!selectedSeller || orderItems.length === 0}
                >
                  Imprimir pedido
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  disabled={!selectedSeller || orderItems.length === 0}
                >
                  Guardar pedido
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LISTADO: ahora es POR PEDIDO, no por producto */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto mt-4">
        <h3 className="text-lg font-semibold mb-2">Listado de pedidos</h3>
        <table className="min-w-[1000px] text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Vendedor</th>
              <th className="p-2 border">Paquetes totales</th>
              {/* NUEVA COLUMNA: paquetes restantes totales del pedido */}
              <th className="p-2 border">Paquetes restantes</th>
              <th className="p-2 border">Subtotal costo</th>
              <th className="p-2 border">Total vendedor</th>
              <th className="p-2 border">Comisión posible</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={8}>
                  Cargando…
                </td>
              </tr>
            ) : orders.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={8}>
                  Sin pedidos asignados a vendedores.
                </td>
              </tr>
            ) : (
              orders.map((o) => {
                const seller = sellersById[o.sellerId];
                const commissionPercent = Number(
                  seller?.commissionPercent || 0
                );
                const commissionAmount =
                  (o.totalVendor * commissionPercent) / 100;

                return (
                  <tr
                    key={o.orderKey}
                    className="text-center whitespace-nowrap"
                  >
                    <td className="p-2 border">{o.date || "—"}</td>
                    <td className="p-2 border">{o.sellerName}</td>
                    <td className="p-2 border">{o.totalPackages}</td>
                    <td className="p-2 border">{o.totalRemainingPackages}</td>
                    <td className="p-2 border">{money(o.subtotal)}</td>
                    <td className="p-2 border">{money(o.totalVendor)}</td>
                    <td className="p-2 border">{money(commissionAmount)}</td>
                    <td className="p-2 border">
                      <div className="flex gap-1 justify-center">
                        <button
                          className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                          onClick={() => openOrderForEdit(o.orderKey)}
                        >
                          Ver / Editar
                        </button>
                        <button
                          className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                          onClick={() => handleDeleteOrder(o.orderKey)}
                        >
                          Borrar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
