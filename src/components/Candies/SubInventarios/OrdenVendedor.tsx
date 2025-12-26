// src/components/Candies/VendorCandyOrders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  getDoc,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../../firebase";
import RefreshButton from "../../common/RefreshButton";
import useManualRefresh from "../../../hooks/useManualRefresh";
import { allocateSaleFIFOCandy } from "../../../Services/inventory_candies";
import { deleteVendorCandyOrderAndRestore } from "../../../Services/Candies_vendor_orders";

// ===== Tipos base =====
type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

interface Seller {
  id: string;
  name: string;
  email?: string;
  commissionPercent?: number; // % comisión sobre el total del pedido
  branch?: Branch;
  branchLabel?: string;
}

interface ProductCandy {
  id: string;
  name: string;
  category: string;
  providerPrice: number; // Precio proveedor (por paquete)
  packages: number;
  unitsPerPackage: number;
  // precios por paquete (lo que ya viene calculado desde la orden maestra)
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;
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

  providerPrice: number; // por paquete (costo)

  // Totales por sucursal (por este pedido de vendedor)
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;

  // Precios por paquete por sucursal
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  // Campos legacy / genéricos
  markupPercent: number; // ya no se usa, pero se mantiene por compatibilidad
  subtotal: number; // costo total (proveedor)
  totalVendor: number; // total a precio de venta (según sucursal del vendedor)
  gainVendor: number; // totalVendor - subtotal
  unitPriceVendor: number; // precio de venta por PAQUETE para este vendedor (según sucursal)

  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
}

// Ítem de pedido (UI del modal)
interface OrderItem {
  id: string; // en modo edición uso el id del doc de Firestore, en modo nuevo es temporal
  productId: string;
  productName: string;
  category: string;
  providerPrice: number; // costo por paquete
  unitsPerPackage: number;
  packages: number;

  // Totales y precios por sucursal (para este pedido)
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  // Campos genéricos que se usan en los KPIs y el print
  subtotal: number; // costo total
  totalVendor: number; // total a precio de venta (según sucursal del vendedor)
  gainVendor: number; // totalVendor - subtotal
  pricePerPackage: number; // precio de venta por paquete según sucursal del vendedor

  /** Paquetes restantes por producto en el detalle */
  remainingPackages?: number;
}

// Resumen de pedido para el listado
interface OrderSummaryRow {
  orderKey: string; // orderId ó fallback (id de la fila)
  sellerId: string;
  sellerName: string;
  date: string;
  totalPackages: number;
  totalRemainingPackages: number;
  subtotal: number;
  totalVendor: number;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// ===== Roles =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces";

interface VendorCandyOrdersProps {
  role?: RoleProp;
  sellerCandyId?: string; // id del vendedor de dulces asociado al usuario
  currentUserEmail?: string;
}

function normalizeBranch(raw: any): "RIVAS" | "SAN_JORGE" | "ISLA" | undefined {
  const v = String(raw || "")
    .trim()
    .toUpperCase();

  if (v.includes("ISLA")) return "ISLA";
  if (v.includes("JORGE")) return "SAN_JORGE";
  if (v.includes("RIVAS")) return "RIVAS";

  return undefined;
}

type MasterAllocation = {
  batchId: string;
  masterOrderId: string; // orderId del doc de inventory_candies
  units: number;
  unitsPerPackage: number;
};

const floor = (n: any) => Math.max(0, Math.floor(Number(n || 0)));

export default function VendorCandyOrders({
  role = "",
  sellerCandyId = "",
  currentUserEmail,
}: VendorCandyOrdersProps) {
  const { refreshKey, refresh } = useManualRefresh();

  const isAdmin = !role || role === "admin";
  const isVendor = role === "vendedor_dulces";
  const currentEmailNorm = (currentUserEmail || "").trim().toLowerCase();
  const isReadOnly = !isAdmin && isVendor;

  // ===== Catálogos =====
  const [sellers, setSellers] = useState<Seller[]>([]);
  // Mantener catálogo completo SIEMPRE (para edición/eliminación/restaurar)
  const [productsAll, setProductsAll] = useState<ProductCandy[]>([]);
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

  // Productos del pedido
  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [packagesToAdd, setPackagesToAdd] = useState<string>("0");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);

  // Bloqueo de boton de guardar
  const [isSaving, setIsSaving] = useState<boolean>(false);

  // Helpers memorizados
  const selectedSeller = useMemo(
    () => sellers.find((s) => s.id === sellerId) || null,
    [sellerId, sellers]
  );

  const sellerBranch: Branch | undefined = selectedSeller?.branch;

  // Producto seleccionado viene del catálogo completo
  const selectedProduct = useMemo(
    () => productsAll.find((p) => p.id === selectedProductId) || null,
    [selectedProductId, productsAll]
  );

  // Mejora UI: set de productos ya agregados al pedido
  const inOrderSet = useMemo(() => {
    return new Set(orderItems.map((x) => x.productId));
  }, [orderItems]);

  // Productos a mostrar en el selector:
  //  - Solo los que tengan disponibilidad
  //  - PERO si estás editando, también los que ya están en el pedido (aunque hoy tengan 0)
  const productsForPicker = useMemo(() => {
    return productsAll
      .filter((p) => {
        const avail = availablePacks[p.id] ?? 0;
        return avail > 0 || inOrderSet.has(p.id);
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [productsAll, availablePacks, inOrderSet]);

  const sellersById = useMemo(() => {
    const m: Record<string, Seller> = {};
    sellers.forEach((s) => (m[s.id] = s));
    return m;
  }, [sellers]);

  const currentSeller = useMemo(() => {
    if (!isVendor || !currentEmailNorm) return null;
    return (
      sellers.find(
        (s) => (s.email || "").trim().toLowerCase() === currentEmailNorm
      ) || null
    );
  }, [isVendor, currentEmailNorm, sellers]);

  // ===== Carga de datos =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // ===========================
        //   VENDEDORES
        // ===========================
        const sSnap = await getDocs(
          query(collection(db, "sellers_candies"), orderBy("name", "asc"))
        );

        const sList: Seller[] = [];
        sSnap.forEach((d) => {
          const x = d.data() as any;

          const rawBranch =
            x.branch ||
            x.branchLabel ||
            x.route ||
            x.sucursal ||
            x.location ||
            "";

          sList.push({
            id: d.id,
            name: x.name || "",
            email: x.email || "",
            commissionPercent: Number(x.commissionPercent || 0),
            branch: normalizeBranch(rawBranch),
            branchLabel: rawBranch,
          });
        });
        setSellers(sList);

        // ===========================
        //   INVENTARIO GENERAL (FUENTE REAL DE PRECIOS + DISPONIBILIDAD)
        //   - disponibilidad: remainingPackages
        //   - precios: unitPriceRivas/SJ/Isla (de orden maestra)
        // ===========================
        const invGeneralSnap = await getDocs(
          collection(db, "inventory_candies")
        );

        const avail: Record<string, number> = {};

        // Mapa: por productId guardamos el "mejor" doc para precios (más reciente)
        const pricePick: Record<
          string,
          {
            unitPriceRivas: number;
            unitPriceSanJorge: number;
            unitPriceIsla: number;
            date: string;
            createdAtSec: number;
          }
        > = {};

        invGeneralSnap.forEach((d) => {
          const x = d.data() as any;
          const pid = String(x.productId || "");
          if (!pid) return;

          // ----- disponibilidad -----
          const rp = Number(x.remainingPackages);
          if (Number.isFinite(rp)) {
            avail[pid] = (avail[pid] || 0) + Math.max(0, Math.floor(rp));
          } else {
            // fallback viejo
            const remainingUnits = Number(x.remaining ?? x.quantity ?? 0);
            const upp = Number(x.unitsPerPackage || 0);
            let packs = 0;
            if (upp > 0) packs = remainingUnits / upp;
            else packs = Number(x.packages || 0);
            avail[pid] = (avail[pid] || 0) + Math.max(0, packs);
          }

          // ----- precios (escoger el doc más reciente) -----
          const dateStr = String(x.date || "");
          const createdAtSec = Number(x.createdAt?.seconds ?? 0);

          const cand = {
            unitPriceRivas: Number(x.unitPriceRivas || 0),
            unitPriceSanJorge: Number(x.unitPriceSanJorge || 0),
            unitPriceIsla: Number(x.unitPriceIsla || 0),
            date: dateStr,
            createdAtSec,
          };

          const hasAnyPrice =
            cand.unitPriceRivas > 0 ||
            cand.unitPriceSanJorge > 0 ||
            cand.unitPriceIsla > 0;
          if (!hasAnyPrice) return;

          const prev = pricePick[pid];
          if (!prev) {
            pricePick[pid] = cand;
            return;
          }

          const prevKey = `${prev.date}#${String(prev.createdAtSec).padStart(
            10,
            "0"
          )}`;
          const candKey = `${cand.date}#${String(cand.createdAtSec).padStart(
            10,
            "0"
          )}`;

          if (candKey > prevKey) {
            pricePick[pid] = cand;
          }
        });

        Object.keys(avail).forEach((k) => (avail[k] = Math.floor(avail[k])));
        setAvailablePacks(avail);

        // ===========================
        //   PRODUCTOS (CATÁLOGO)
        //   ✅ INYECTAMOS PRECIOS desde inventory_candies
        // ===========================
        const pSnap = await getDocs(
          query(collection(db, "products_candies"), orderBy("name", "asc"))
        );

        const pList: ProductCandy[] = [];
        pSnap.forEach((d) => {
          const x = d.data() as any;
          const pid = d.id;

          const picked = pricePick[pid];

          pList.push({
            id: pid,
            name: x.name || "",
            category: x.category || "",
            providerPrice: Number(x.providerPrice || 0),
            packages: Number(x.packages || 0),
            unitsPerPackage: Number(x.unitsPerPackage || 0),

            unitPriceRivas: Number(picked?.unitPriceRivas || 0),
            unitPriceSanJorge: Number(picked?.unitPriceSanJorge || 0),
            unitPriceIsla: Number(picked?.unitPriceIsla || 0),
          });
        });

        setProductsAll(pList);

        // ===========================
        //   SUBINVENTARIO VENDEDORES
        // ===========================
        const invSnap = await getDocs(
          isVendor
            ? query(
                collection(db, "inventory_candies_sellers"),
                where("sellerId", "==", sellerCandyId),
                orderBy("createdAt", "desc")
              )
            : query(
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

            totalRivas: Number(x.totalRivas || 0),
            totalSanJorge: Number(x.totalSanJorge || 0),
            totalIsla: Number(x.totalIsla || 0),
            unitPriceRivas: Number(x.unitPriceRivas || 0),
            unitPriceSanJorge: Number(x.unitPriceSanJorge || 0),
            unitPriceIsla: Number(x.unitPriceIsla || 0),

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

  // ===== Filtrado por rol (solo sus pedidos si es vendedor de dulces) =====
  const rowsByRole = useMemo(() => {
    if (isVendor && currentSeller) {
      return rows.filter((r) => r.sellerId === currentSeller.id);
    }
    return rows;
  }, [rows, isVendor, currentSeller]);

  // ===== Resumen por pedido (agrupado) =====
  const orders: OrderSummaryRow[] = useMemo(() => {
    const map: Record<string, OrderSummaryRow> = {};

    for (const r of rowsByRole) {
      const key = r.orderId || r.id;
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
        if (dateStr > existing.date) existing.date = dateStr;
      }
    }

    return Object.values(map).sort((a, b) => b.date.localeCompare(a.date));
  }, [rowsByRole]);

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
    setSelectedProductId("");
    setPackagesToAdd("0");
    setOrderItems([]);
  };

  function recalcItemFinancials(base: {
    providerPrice: number;
    unitPriceRivas: number;
    unitPriceSanJorge: number;
    unitPriceIsla: number;
    packages: number;
    sellerBranch?: Branch;
  }) {
    const providerPrice = Number(base.providerPrice || 0);
    const packs = Number(base.packages || 0);

    const unitPriceRivas = Number(base.unitPriceRivas || 0);
    const unitPriceSanJorge = Number(base.unitPriceSanJorge || 0);
    const unitPriceIsla = Number(base.unitPriceIsla || 0);

    const subtotal = providerPrice * packs;

    const totalRivas = unitPriceRivas * packs;
    const totalSanJorge = unitPriceSanJorge * packs;
    const totalIsla = unitPriceIsla * packs;

    let pricePerPackage = unitPriceRivas;
    let totalVendor = totalRivas;

    switch (base.sellerBranch) {
      case "SAN_JORGE":
        pricePerPackage = unitPriceSanJorge;
        totalVendor = totalSanJorge;
        break;
      case "ISLA":
        pricePerPackage = unitPriceIsla;
        totalVendor = totalIsla;
        break;
      case "RIVAS":
      default:
        pricePerPackage = unitPriceRivas;
        totalVendor = totalRivas;
        break;
    }

    const gainVendor = totalVendor - subtotal;

    return {
      subtotal,
      totalVendor,
      gainVendor,
      pricePerPackage,
      totalRivas,
      totalSanJorge,
      totalIsla,
      unitPriceRivas,
      unitPriceSanJorge,
      unitPriceIsla,
    };
  }

  function buildOrderItem(product: ProductCandy, packs: number): OrderItem {
    const {
      subtotal,
      totalVendor,
      gainVendor,
      pricePerPackage,
      totalRivas,
      totalSanJorge,
      totalIsla,
      unitPriceRivas,
      unitPriceSanJorge,
      unitPriceIsla,
    } = recalcItemFinancials({
      providerPrice: product.providerPrice,
      unitPriceRivas: product.unitPriceRivas,
      unitPriceSanJorge: product.unitPriceSanJorge,
      unitPriceIsla: product.unitPriceIsla,
      packages: packs,
      sellerBranch,
    });

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
      totalRivas,
      totalSanJorge,
      totalIsla,
      unitPriceRivas,
      unitPriceSanJorge,
      unitPriceIsla,
      remainingPackages: packs,
    };
  }

  // ===== Agregar producto al pedido =====
  const handleAddItem = () => {
    if (isReadOnly) return;

    if (!selectedProduct) {
      setMsg("Selecciona un producto antes de agregarlo.");
      return;
    }

    // ✅ UI: si ya existe en el pedido, no dejar agregar
    if (inOrderSet.has(selectedProduct.id)) {
      setMsg("Ese producto ya está agregado en este pedido.");
      return;
    }

    const packsNum = Number(packagesToAdd || 0);
    if (packsNum <= 0) {
      setMsg("La cantidad de paquetes debe ser mayor a 0.");
      return;
    }

    const available = availablePacks[selectedProduct.id] ?? 0;
    if (!editingOrderKey && packsNum > available) {
      setMsg(
        `No hay suficientes paquetes en inventario general. Disponibles: ${available}`
      );
      return;
    }

    const item = buildOrderItem(selectedProduct, packsNum);

    setOrderItems((prev) => [...prev, item]);
    setSelectedProductId(""); // ✅ mejor UX
    setPackagesToAdd("0");
  };

  const handleRemoveItem = (id: string) => {
    if (isReadOnly) return;
    setOrderItems((prev) => prev.filter((x) => x.id !== id));
  };

  const handleItemFieldChange = (id: string, value: string) => {
    if (isReadOnly) return;

    const num = Number(value || 0);

    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;

        const {
          subtotal,
          totalVendor,
          gainVendor,
          pricePerPackage,
          totalRivas,
          totalSanJorge,
          totalIsla,
        } = recalcItemFinancials({
          providerPrice: it.providerPrice,
          unitPriceRivas: it.unitPriceRivas,
          unitPriceSanJorge: it.unitPriceSanJorge,
          unitPriceIsla: it.unitPriceIsla,
          packages: num,
          sellerBranch,
        });

        return {
          ...it,
          packages: num,
          subtotal,
          totalVendor,
          gainVendor,
          pricePerPackage,
          totalRivas,
          totalSanJorge,
          totalIsla,
        };
      })
    );
  };

  async function buildMasterAllocationsFromAllocate(
    productId: string,
    packs: number,
    saleDate: string
  ) {
    const result = await allocateSaleFIFOCandy({
      productId,
      quantityPacks: packs,
      saleDate,
    });

    const allocs = Array.isArray(result?.allocations) ? result.allocations : [];
    if (!allocs.length) return [] as MasterAllocation[];

    const batchIds = allocs
      .map((a: any) => String(a.batchId || ""))
      .filter(Boolean);
    const snaps = await Promise.all(
      batchIds.map((id: string) => getDoc(doc(db, "inventory_candies", id)))
    );

    const detailed: MasterAllocation[] = [];
    for (let i = 0; i < allocs.length; i++) {
      const a = allocs[i] as any;
      const batchId = String(a.batchId || "");
      const units = floor(a.qty || a.units || a.quantity || 0);
      const s = snaps[i];
      if (!batchId || units <= 0) continue;
      if (!s.exists()) continue;

      const data = s.data() as any;
      const masterOrderId = String(data.orderId || "");
      const upp = Math.max(1, floor(data.unitsPerPackage || 1));

      if (!masterOrderId) continue;

      detailed.push({
        batchId,
        masterOrderId,
        units,
        unitsPerPackage: upp,
      });
    }

    return detailed;
  }

  // ===== Guardar pedido (nuevo o edición) =====
  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();

    if (isSaving) return;
    if (!isAdmin) {
      setMsg("No tienes permiso para guardar pedidos.");
      return;
    }

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

    try {
      setLoading(true);
      setIsSaving(true);

      if (editingOrderKey) {
        const originalByProduct: Record<string, VendorCandyRow> = {};
        originalOrderRows.forEach((r) => {
          originalByProduct[r.productId] = r;
        });

        const newByProduct: Record<string, OrderItem> = {};
        orderItems.forEach((it) => {
          newByProduct[it.productId] = it;
        });

        // 1) Ajustar inventario principal según diferencias de paquetes
        for (const productId of Object.keys(newByProduct)) {
          const newItem = newByProduct[productId];
          const oldRow = originalByProduct[productId];
          const newPacks = Number(newItem.packages || 0);
          const oldPacks = oldRow ? Number(oldRow.packages || 0) : 0;
          const delta = newPacks - oldPacks;

          if (delta > 0) {
            // ✅ BLINDADO: guardamos masterAllocations por los packs asignados extra
            const allocDetails = await buildMasterAllocationsFromAllocate(
              productId,
              delta,
              dateStr
            );

            // guardamos esas allocations extra en el doc existente del vendedor (append)
            if (oldRow && allocDetails.length) {
              const oldDocRef = doc(db, "inventory_candies_sellers", oldRow.id);
              const oldSnap = await getDoc(oldDocRef);
              const oldData = oldSnap.exists() ? (oldSnap.data() as any) : {};
              const prev = Array.isArray(oldData.masterAllocations)
                ? oldData.masterAllocations
                : [];
              const merged = [...prev, ...allocDetails];

              await updateDoc(oldDocRef, {
                masterAllocations: merged,
                updatedAt: Timestamp.now(),
              });
            }
          } else if (delta < 0) {
            // (tu comentario original lo dejaba así para no romper lógica)
          }
        }

        // 2) Actualizar / crear / eliminar docs en inventory_candies_sellers
        let newRowsState = [...rows];

        for (const productId of Object.keys(newByProduct)) {
          const it = newByProduct[productId];
          const oldRow = originalByProduct[productId];
          const product = productsAll.find((p) => p.id === productId);
          const unitsPerPackage =
            product?.unitsPerPackage || it.unitsPerPackage || 0;
          const totalUnits =
            it.packages > 0 && unitsPerPackage > 0
              ? it.packages * unitsPerPackage
              : 0;

          if (oldRow) {
            await updateDoc(doc(db, "inventory_candies_sellers", oldRow.id), {
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
              totalRivas: it.totalRivas,
              totalSanJorge: it.totalSanJorge,
              totalIsla: it.totalIsla,
              unitPriceRivas: it.unitPriceRivas,
              unitPriceSanJorge: it.unitPriceSanJorge,
              unitPriceIsla: it.unitPriceIsla,
              markupPercent: 0,
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
                    totalRivas: it.totalRivas,
                    totalSanJorge: it.totalSanJorge,
                    totalIsla: it.totalIsla,
                    unitPriceRivas: it.unitPriceRivas,
                    unitPriceSanJorge: it.unitPriceSanJorge,
                    unitPriceIsla: it.unitPriceIsla,
                    markupPercent: 0,
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
            // ✅ si agregaron un producto nuevo en edición:
            // asignamos del inventario general y guardamos allocations blindadas
            const allocDetails = await buildMasterAllocationsFromAllocate(
              productId,
              it.packages,
              dateStr
            );

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
              totalRivas: it.totalRivas,
              totalSanJorge: it.totalSanJorge,
              totalIsla: it.totalIsla,
              unitPriceRivas: it.unitPriceRivas,
              unitPriceSanJorge: it.unitPriceSanJorge,
              unitPriceIsla: it.unitPriceIsla,
              markupPercent: 0,
              subtotal: it.subtotal,
              totalVendor: it.totalVendor,
              gainVendor: it.gainVendor,
              unitPriceVendor: it.pricePerPackage,
              date: dateStr,
              createdAt: Timestamp.now(),
              status: "ASIGNADO",
              masterAllocations: allocDetails,
            };

            const ref = await addDoc(
              collection(db, "inventory_candies_sellers"),
              docData as any
            );

            newRowsState = [{ id: ref.id, ...docData } as any, ...newRowsState];
          }
        }

        // Eliminados en edición: aquí sí borramos filas, PERO devolviendo con servicio seguro
        for (const productId of Object.keys(originalByProduct)) {
          if (!newByProduct[productId]) {
            const oldRow = originalByProduct[productId];

            await deleteVendorCandyOrderAndRestore(oldRow.id);

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
          const product = productsAll.find((p) => p.id === it.productId);
          if (!product) continue;

          const totalUnits =
            it.packages > 0 && product.unitsPerPackage > 0
              ? it.packages * product.unitsPerPackage
              : 0;

          // ✅ BLINDADO: asignación FIFO devuelve allocations por lote,
          // y guardamos masterAllocations para restaurar perfecto.
          const allocDetails = await buildMasterAllocationsFromAllocate(
            it.productId,
            it.packages,
            dateStr
          );

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
            totalRivas: it.totalRivas,
            totalSanJorge: it.totalSanJorge,
            totalIsla: it.totalIsla,
            unitPriceRivas: it.unitPriceRivas,
            unitPriceSanJorge: it.unitPriceSanJorge,
            unitPriceIsla: it.unitPriceIsla,
            markupPercent: 0,
            subtotal: it.subtotal,
            totalVendor: it.totalVendor,
            gainVendor: it.gainVendor,
            unitPriceVendor: it.pricePerPackage,
            date: dateStr,
            createdAt: Timestamp.now(),
            status: "ASIGNADO",
            masterAllocations: allocDetails, // ✅ CLAVE
          };

          const ref = await addDoc(
            collection(db, "inventory_candies_sellers"),
            docData as any
          );

          setRows((prev) => [
            { id: ref.id, ...(docData as any) } as any,
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
      setIsSaving(false);
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
    }${
      selectedSeller.branchLabel
        ? `<br/>Ruta / sucursal: <b>${esc(selectedSeller.branchLabel)}</b>`
        : ""
    }
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
      <div class="label">Total vendedor (precio venta)</div>
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
    const relatedRows = rowsByRole.filter(
      (r) => (r.orderId || r.id) === orderKey
    );
    if (!relatedRows.length) {
      setMsg("No se encontraron filas para este pedido.");
      return;
    }

    const first = relatedRows[0];

    if (isVendor && currentSeller && first.sellerId !== currentSeller.id) {
      setMsg("No tienes permiso para ver este pedido.");
      return;
    }

    setEditingOrderKey(orderKey);
    setOriginalOrderRows(relatedRows);
    setSellerId(first.sellerId);
    setDate(first.date);

    const items: OrderItem[] = relatedRows.map((r) => {
      const unitPriceRivas = r.unitPriceRivas || 0;
      const unitPriceSanJorge = r.unitPriceSanJorge || 0;
      const unitPriceIsla = r.unitPriceIsla || 0;

      const totalRivas =
        r.totalRivas || unitPriceRivas * Number(r.packages || 0);
      const totalSanJorge =
        r.totalSanJorge || unitPriceSanJorge * Number(r.packages || 0);
      const totalIsla = r.totalIsla || unitPriceIsla * Number(r.packages || 0);

      return {
        id: r.id,
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
        totalRivas,
        totalSanJorge,
        totalIsla,
        unitPriceRivas,
        unitPriceSanJorge,
        unitPriceIsla,
        remainingPackages: r.remainingPackages,
      };
    });

    setOrderItems(items);
    setSelectedProductId("");
    setPackagesToAdd("0");
    setOpenForm(true);
  };

  // ===== Eliminar pedido completo =====
  const handleDeleteOrder = async (orderKey: string) => {
    if (!isAdmin) {
      setMsg("No tienes permiso para borrar pedidos.");
      return;
    }

    const relatedRows = rows.filter((r) => (r.orderId || r.id) === orderKey);
    if (!relatedRows.length) return;

    const sellerName = relatedRows[0].sellerName || "";
    const ok = confirm(
      `¿Eliminar COMPLETAMENTE este pedido del vendedor "${sellerName}"? Se regresarán los paquetes al inventario principal.`
    );
    if (!ok) return;

    try {
      setLoading(true);

      for (const r of relatedRows) {
        await deleteVendorCandyOrderAndRestore(r.id);
      }

      setRows((prev) => prev.filter((r) => (r.orderId || r.id) !== orderKey));
      setMsg("🗑️ Pedido eliminado y paquetes regresados correctamente.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar el pedido / regresar paquetes.");
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
          {isAdmin && (
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
          )}
        </div>
      </div>

      {/* MODAL NUEVO / EDICIÓN DE PEDIDO */}
      {openForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-5xl max-h-[90vh] overflow-y-auto text-sm relative">
            {isSaving && (
              <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-50">
                <div className="bg-white border rounded-lg px-4 py-3 shadow text-sm font-semibold">
                  Guardando pedido...
                </div>
              </div>
            )}

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
                    disabled={isReadOnly}
                  >
                    <option value="">Selecciona un vendedor…</option>
                    {sellers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                        {s.branchLabel ? ` - ${s.branchLabel}` : ""}
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
                    disabled={isReadOnly}
                  />
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
                      disabled={isReadOnly}
                    >
                      <option value="">Selecciona un producto…</option>

                      {productsForPicker.map((p) => {
                        const avail = availablePacks[p.id] ?? 0;
                        const labelParts: string[] = [];

                        labelParts.push(
                          p.category ? `${p.category} - ${p.name}` : p.name
                        );

                        const precios: string[] = [];
                        if (p.unitPriceRivas > 0)
                          precios.push(`R: ${money(p.unitPriceRivas)}`);
                        if (p.unitPriceSanJorge > 0)
                          precios.push(`SJ: ${money(p.unitPriceSanJorge)}`);
                        if (p.unitPriceIsla > 0)
                          precios.push(`I: ${money(p.unitPriceIsla)}`);
                        if (precios.length)
                          labelParts.push(precios.join(" | "));

                        labelParts.push(`Disp: ${avail} paq`);

                        const disabled = inOrderSet.has(p.id);

                        return (
                          <option key={p.id} value={p.id} disabled={disabled}>
                            {disabled
                              ? `✅ (Agregado) ${labelParts.join(" — ")}`
                              : labelParts.join(" — ")}
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
                      disabled={isReadOnly}
                    />
                  </div>
                </div>

                <div className="flex justify-end mt-3">
                  <button
                    type="button"
                    onClick={handleAddItem}
                    className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
                    disabled={
                      isReadOnly ||
                      !selectedProductId ||
                      inOrderSet.has(selectedProductId)
                    }
                    title={
                      inOrderSet.has(selectedProductId)
                        ? "Ese producto ya está en el pedido"
                        : ""
                    }
                  >
                    Agregar producto al pedido
                  </button>
                </div>
              </div>

              {/* Tabla de productos del pedido */}
              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1100px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Categoría</th>
                      <th className="p-2 border">Paquetes</th>
                      <th className="p-2 border">Paquetes restantes</th>
                      <th className="p-2 border">Paq x Und (ref)</th>
                      <th className="p-2 border">P. proveedor (paq)</th>
                      <th className="p-2 border">Subtotal</th>
                      <th className="p-2 border">Total Rivas</th>
                      <th className="p-2 border">Total San Jorge</th>
                      <th className="p-2 border">Total Isla</th>
                      <th className="p-2 border">P. unidad Rivas</th>
                      <th className="p-2 border">P. unidad San Jorge</th>
                      <th className="p-2 border">P. unidad Isla</th>
                      <th className="p-2 border">P. paquete vendedor</th>
                      <th className="p-2 border">Total vendedor</th>
                      <th className="p-2 border">Acciones</th>
                    </tr>
                  </thead>
                  <tbody>
                    {orderItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={16}
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

                          <td className="p-2 border">
                            <input
                              type="number"
                              min={0}
                              className="border p-1 rounded text-right text-xs w-20"
                              value={it.packages}
                              onChange={(e) =>
                                handleItemFieldChange(it.id, e.target.value)
                              }
                              disabled={isReadOnly}
                            />
                          </td>

                          <td className="p-2 border">
                            {it.remainingPackages ?? it.packages}
                          </td>

                          <td className="p-2 border">
                            {it.unitsPerPackage || "—"}
                          </td>
                          <td className="p-2 border">
                            {money(it.providerPrice)}
                          </td>
                          <td className="p-2 border">{money(it.subtotal)}</td>
                          <td className="p-2 border">{money(it.totalRivas)}</td>
                          <td className="p-2 border">
                            {money(it.totalSanJorge)}
                          </td>
                          <td className="p-2 border">{money(it.totalIsla)}</td>
                          <td className="p-2 border">
                            {money(it.unitPriceRivas)}
                          </td>
                          <td className="p-2 border">
                            {money(it.unitPriceSanJorge)}
                          </td>
                          <td className="p-2 border">
                            {money(it.unitPriceIsla)}
                          </td>
                          <td className="p-2 border">
                            {money(it.pricePerPackage)}
                          </td>
                          <td className="p-2 border">
                            {money(it.totalVendor)}
                          </td>
                          <td className="p-2 border">
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs disabled:opacity-50"
                              onClick={() => handleRemoveItem(it.id)}
                              disabled={isReadOnly}
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
                    Total vendedor (precio venta)
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
                {isAdmin && (
                  <button
                    type="button"
                    onClick={resetOrder}
                    className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-60"
                    disabled={isSaving}
                  >
                    Limpiar pedido
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    resetOrder();
                    setOpenForm(false);
                  }}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-60"
                  disabled={isSaving}
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
                {isAdmin && (
                  <button
                    type="submit"
                    className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    disabled={
                      isSaving || !selectedSeller || orderItems.length === 0
                    }
                  >
                    {isSaving ? "Guardando..." : "Guardar pedido"}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LISTADO: POR PEDIDO */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto mt-4">
        <h3 className="text-lg font-semibold mb-2">Listado de pedidos</h3>
        <table className="min-w-[1000px] text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Vendedor</th>
              <th className="p-2 border">Paquetes totales</th>
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
                    <td className="p-2 border">
                      {o.sellerName}
                      {seller?.branchLabel ? ` - ${seller.branchLabel}` : ""}
                    </td>
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
                        {isAdmin && (
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                            onClick={() => handleDeleteOrder(o.orderKey)}
                          >
                            Borrar
                          </button>
                        )}
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
