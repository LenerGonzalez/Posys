// src/components/Candies/CandyMainOrders.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  updateDoc,
  writeBatch,
  Timestamp,
} from "firebase/firestore";
import * as XLSX from "xlsx";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

// Small helpers used in this file
const safeInt = (v: any) => Math.max(0, Math.floor(Number(v) || 0));
const roundToInt = (n: number) => Math.round(n || 0);

// Helpers consistentes con inventory_candies.ts / InventoryCandyBatches
function getBaseUnitsFromInvDoc(data: any): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = safeInt(data.totalUnits || 0);
  const quantity = safeInt(data.quantity || 0);
  const packages = safeInt(data.packages || 0);

  if (totalUnits > 0) return totalUnits;
  if (quantity > 0) return quantity;
  if (packages > 0) return packages * unitsPerPackage;
  return 0;
}

function getRemainingUnitsFromInvDoc(data: any): number {
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.floor(remainingField);
  }
  return getBaseUnitsFromInvDoc(data);
}

function getRemainingPackagesFromInvDoc(data: any): number {
  const rp = Number(data.remainingPackages);
  if (Number.isFinite(rp)) return Math.max(0, Math.floor(rp));

  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const remainingUnits = getRemainingUnitsFromInvDoc(data);
  return Math.max(0, Math.floor(remainingUnits / unitsPerPackage));
}

function getInitialPackagesFromInvDoc(data: any): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = getBaseUnitsFromInvDoc(data);
  return Math.max(0, Math.floor(totalUnits / unitsPerPackage));
}

// =====================
// Tipos
// =====================
type CatalogCandyProduct = {
  id: string; // doc id en products_candies
  name: string;
  category: string;
  providerPrice: number; // por PAQUETE
  unitsPerPackage: number;
};

interface CandyOrderItem {
  id: string; // productId (catalog)
  name: string;
  category: string;

  providerPrice: number; // por paquete
  packages: number;
  unitsPerPackage: number;

  // Márgenes por sucursal (San Jorge solo compat interna)
  marginRivas: number; // % (ej 40)
  marginSanJorge: number; // legacy
  marginIsla: number; // % (ej 50)

  // Costo / Esperados
  subtotal: number; // Facturado costo (proveedor)
  totalRivas: number; // Esperado Rivas
  totalSanJorge: number; // legacy
  totalIsla: number; // Esperado Isla

  gainRivas: number; // base utilidad bruta
  gainSanJorge: number; // legacy
  gainIsla: number; // legacy (no la usamos)

  // precio por PAQUETE (tu label viejo “P. unidad”)
  unitPriceRivas: number;
  unitPriceSanJorge: number; // legacy
  unitPriceIsla: number;

  remainingPackages?: number;

  // ===== NUEVO: utilidades (guardables) =====
  grossProfit?: number;
  grossProfitIsla?: number;
  logisticAllocated?: number;
}

interface CandyOrderSummaryRow {
  id: string;
  name: string;
  date: string;

  totalPackages: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number; // legacy
  totalIsla: number;

  marginRivas: number;
  marginSanJorge: number; // legacy
  marginIsla: number;

  // NUEVO (orden)
  logisticsCost?: number; // monto total orden

  // Extras para UI listado (opcionales)
  grossTotal?: number;
  vendorTotal?: number;
  netTotal?: number;

  createdAt: Timestamp;
}

interface OrderInventoryAgg {
  orderId: string;
  totalPackages: number;
  remainingPackages: number;
}

type CandyMainOrderDoc = {
  name: string;
  date: string;

  totalPackages: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number; // legacy
  totalIsla: number;

  marginRivas: number;
  marginSanJorge: number; // legacy
  marginIsla: number;

  // NUEVO
  logisticsCost?: number;

  createdAt: Timestamp;
  items: CandyOrderItem[];
};

type MobileTab = "DATOS" | "AGREGAR" | "ITEMS" | "TOTALES";

// =====================
// Excel helpers
// =====================
function norm(s: any) {
  return String(s ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function num(v: any): number {
  const raw = String(v ?? "").trim();
  if (!raw) return 0;

  // soporta "1234,56" o "1,234.56" (sin volverse loco)
  const cleaned = raw.replace(/,/g, ".");
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : 0;
}

function pctTo01(v: any): number {
  const n = num(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n > 1) return n / 100; // 30 => 0.30
  return n; // 0.3 => 0.3
}

function getRowValue(row: any, keys: string[]) {
  const map: Record<string, any> = {};
  Object.keys(row || {}).forEach((k) => (map[norm(k)] = (row as any)[k]));
  for (const k of keys) {
    const val = map[norm(k)];
    if (val !== undefined && val !== null && String(val).trim() !== "")
      return val;
  }
  return undefined;
}

// =====================
// Cálculos (manteniendo tu lógica)
// =====================
function calcTotalsByMargins(
  providerPriceNum: number,
  packagesNum: number,
  margins: { marginR: number; marginSJ: number; marginIsla: number },
) {
  const subtotalCalc = providerPriceNum * packagesNum;

  const mR = Math.min(Math.max(margins.marginR, 0), 99.9) / 100;
  const mSJ = Math.min(Math.max(margins.marginSJ, 0), 99.9) / 100;
  const mIsla = Math.min(Math.max(margins.marginIsla, 0), 99.9) / 100;

  // ✅ total = subtotal / (1 - margen)
  const totalR =
    packagesNum > 0 && mR < 1 ? subtotalCalc / (1 - mR) : subtotalCalc;
  const totalSJ =
    packagesNum > 0 && mSJ < 1 ? subtotalCalc / (1 - mSJ) : subtotalCalc;
  const totalIO =
    packagesNum > 0 && mIsla < 1 ? subtotalCalc / (1 - mIsla) : subtotalCalc;

  const gainR = totalR - subtotalCalc;
  const gainSJ = totalSJ - subtotalCalc;
  const gainIO = totalIO - subtotalCalc;

  const unitR = packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0;
  const unitSJ = packagesNum > 0 ? roundToInt(totalSJ / packagesNum) : 0;
  const unitIO = packagesNum > 0 ? roundToInt(totalIO / packagesNum) : 0;

  return {
    subtotal: subtotalCalc,
    totalRivas: totalR,
    totalSanJorge: totalSJ,
    totalIsla: totalIO,
    gainRivas: gainR,
    gainSanJorge: gainSJ,
    gainIsla: gainIO,
    unitPriceRivas: unitR,
    unitPriceSanJorge: unitSJ,
    unitPriceIsla: unitIO,
  };
}

// ✅ Utilidad bruta base = gainRivas (lo pediste “A partir de UTILIDAD BRUTA”)
function getGrossProfitBase(it: CandyOrderItem): number {
  return Number(it.gainRivas || 0);
}

function getGrossProfitIslaBase(it: CandyOrderItem): number {
  return Number(it.gainIsla || 0);
}

function applyProfitSplitAndLogistics(
  it: CandyOrderItem,
  logisticsTotal: number,
  orderSubtotalTotal: number,
): CandyOrderItem {
  const gross = getGrossProfitBase(it);
  const grossIsla = getGrossProfitIslaBase(it);

  // prorrateo por subtotal (facturado/costo)
  const subtotal = Number(it.subtotal || 0);
  const logisticAllocated =
    logisticsTotal > 0 && orderSubtotalTotal > 0
      ? (logisticsTotal * subtotal) / orderSubtotalTotal
      : 0;

  return {
    ...it,
    grossProfit: gross,
    grossProfitIsla: grossIsla,
    logisticAllocated,
  };
}

export default function CandyMainOrders() {
  const { refreshKey, refresh } = useManualRefresh();

  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);

  // ====== CATÁLOGO (products_candies) ======
  const [catalog, setCatalog] = useState<CatalogCandyProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // listado de órdenes
  const [orders, setOrders] = useState<CandyOrderSummaryRow[]>([]);

  // agregados inventario por orden (para “restantes” del listado)
  const [orderInventoryAgg, setOrderInventoryAgg] = useState<
    Record<string, OrderInventoryAgg>
  >({});

  // modal orden
  const [openOrderModal, setOpenOrderModal] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);

  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>("");

  // % ganancia por sucursal (SJ legacy solo compat interna)
  const [marginRivas, setMarginRivas] = useState<string>("20");
  const [marginSanJorge, setMarginSanJorge] = useState<string>("15"); // legacy (no UI)
  const [marginIsla, setMarginIsla] = useState<string>("30");

  // ✅ NUEVO: Gastos logísticos
  const [logisticsCost, setLogisticsCost] = useState<string>("0"); // monto total

  // items de la orden
  const [orderItems, setOrderItems] = useState<CandyOrderItem[]>([]);

  // selección producto
  const [orderCategory, setOrderCategory] = useState<string>("");
  const [orderProductId, setOrderProductId] = useState<string>("");

  // auto-llenados desde catálogo (solo lectura)
  const [orderProviderPrice, setOrderProviderPrice] = useState<string>("");
  const [orderUnitsPerPackage, setOrderUnitsPerPackage] = useState<string>("1");
  const [orderPackages, setOrderPackages] = useState<string>("0");

  // Tabs (solo móvil)
  const [mobileTab, setMobileTab] = useState<MobileTab>("DATOS");

  const [itemSearch, setItemSearch] = useState("");

  // Paginado tabla (desktop)
  const [page, setPage] = useState<number>(1);
  const PAGE_SIZE = 15;
  const totalPages = useMemo(
    () => Math.max(1, Math.ceil(orders.length / PAGE_SIZE)),
    [orders.length],
  );

  // Resetear página si cambia el número total de órdenes
  useEffect(() => setPage(1), [orders.length]);

  const pagedOrders = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return orders.slice(start, start + PAGE_SIZE);
  }, [orders, page]);

  // ==== categorías dinámicas desde catálogo ====
  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of catalog) {
      const c = String(p.category || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
  }, [catalog]);

  useEffect(() => {
    if (!orderCategory && catalogCategories.length > 0) {
      setOrderCategory(catalogCategories[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogCategories]);

  // ===== Cargar catálogo =====
  const loadCatalog = async () => {
    setCatalogLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, "products_candies"), orderBy("createdAt", "desc")),
      );

      const list: CatalogCandyProduct[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          name: String(x.name ?? "").trim(),
          category: String(x.category ?? "").trim() || "Caramelo",
          providerPrice: Number(x.providerPrice ?? 0),
          unitsPerPackage: Number(x.unitsPerPackage ?? 1),
        });
      });

      setCatalog(list);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error cargando catálogo de dulces.");
    } finally {
      setCatalogLoading(false);
    }
  };

  useEffect(() => {
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const catalogByCategory = useMemo(() => {
    const list =
      orderCategory.trim().length > 0
        ? catalog.filter((p) => p.category === orderCategory)
        : catalog;
    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [catalog, orderCategory]);

  // al seleccionar producto, auto-llenar datos
  useEffect(() => {
    if (!orderProductId) {
      setOrderProviderPrice("");
      setOrderUnitsPerPackage("1");
      return;
    }
    const p = catalog.find((x) => x.id === orderProductId);
    if (!p) return;
    setOrderProviderPrice(String(p.providerPrice ?? 0));
    setOrderUnitsPerPackage(String(p.unitsPerPackage ?? 1));
  }, [orderProductId, catalog]);

  // Reset form
  const resetOrderForm = () => {
    setEditingOrderId(null);
    setOrderName("");
    setOrderDate("");
    setOrderItems([]);

    setOrderCategory(catalogCategories[0] || "");
    setOrderProductId("");
    setOrderProviderPrice("");
    setOrderPackages("0");
    setOrderUnitsPerPackage("1");

    setMarginRivas("20");
    setMarginSanJorge("15"); // legacy
    setMarginIsla("30");

    setLogisticsCost("0");
    // previously set vendor/investor defaults — removed

    setMobileTab("DATOS");
    setItemSearch("");
  };

  // =========================
  // Add item (nuevo o edición)
  // =========================
  const addItemToOrder = () => {
    setMsg("");
    if (!orderProductId) {
      setMsg("Selecciona un producto del catálogo.");
      return;
    }

    const catProd = catalog.find((x) => x.id === orderProductId);
    if (!catProd) {
      setMsg("Producto de catálogo no encontrado (refresca).");
      return;
    }

    const providerPriceNum = Number(catProd.providerPrice || 0);
    const packagesNum = safeInt(orderPackages || 0);
    const unitsNum = safeInt(catProd.unitsPerPackage || 0);

    if (providerPriceNum < 0) {
      setMsg("El precio proveedor no puede ser negativo.");
      return;
    }
    if (packagesNum <= 0) {
      setMsg("Los paquetes deben ser mayor que 0.");
      return;
    }
    if (unitsNum <= 0) {
      setMsg("Las unidades por paquete deben ser mayor que 0.");
      return;
    }

    const mR = Number(marginRivas || 0);
    const mSJ = Number(marginSanJorge || 0); // legacy
    const mI = Number(marginIsla || 0);

    // ✅ respeta tu cálculo
    const vals = calcTotalsByMargins(providerPriceNum, packagesNum, {
      marginR: mR,
      marginSJ: mSJ,
      marginIsla: mI,
    });

    const existing = orderItems.find((it) => it.id === catProd.id);

    if (existing) {
      setOrderItems((prev) =>
        prev.map((it) => {
          if (it.id !== catProd.id) return it;

          const newPackages = safeInt(it.packages || 0) + packagesNum;
          const newVals = calcTotalsByMargins(providerPriceNum, newPackages, {
            marginR: Number(it.marginRivas ?? mR),
            marginSJ: Number(it.marginSanJorge ?? mSJ),
            marginIsla: Number(it.marginIsla ?? mI),
          });

          // si está en edición, remainingPackages viene del inventario. Sumamos el delta de paquetes agregados.
          const baseRemaining = safeInt(it.remainingPackages ?? it.packages);
          const newRemaining = baseRemaining + packagesNum;

          return {
            ...it,
            providerPrice: providerPriceNum,
            unitsPerPackage: unitsNum,
            packages: newPackages,
            remainingPackages: newRemaining,
            ...newVals,
          };
        }),
      );
    } else {
      const newItem: CandyOrderItem = {
        id: catProd.id,
        name: catProd.name,
        category: catProd.category,
        providerPrice: providerPriceNum,
        packages: packagesNum,
        unitsPerPackage: unitsNum,

        marginRivas: mR,
        marginSanJorge: mSJ, // legacy
        marginIsla: mI,

        subtotal: vals.subtotal,
        totalRivas: vals.totalRivas,
        totalSanJorge: vals.totalSanJorge,
        totalIsla: vals.totalIsla,

        gainRivas: vals.gainRivas,
        gainSanJorge: vals.gainSanJorge,
        gainIsla: vals.gainIsla,

        unitPriceRivas: vals.unitPriceRivas,
        unitPriceSanJorge: vals.unitPriceSanJorge,
        unitPriceIsla: vals.unitPriceIsla,

        remainingPackages: packagesNum,
      };

      setOrderItems((prev) => [...prev, newItem]);
    }

    setOrderProductId("");
    setOrderPackages("0");
    setMobileTab("ITEMS");
  };

  const removeItemFromOrder = (id: string) => {
    setOrderItems((prev) => prev.filter((it) => it.id !== id));
  };

  // =========================
  // Cambios por item (edición)
  // =========================
  const handleItemFieldChange = (
    itemId: string,
    field: keyof CandyOrderItem,
    value: string,
  ) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;

        let updated: CandyOrderItem = { ...it };

        if (field === "packages") updated.packages = safeInt(value || 0);
        if (field === "unitsPerPackage")
          updated.unitsPerPackage = safeInt(value || 0);

        if (field === "marginRivas") updated.marginRivas = Number(value || 0);
        if (field === "marginIsla") updated.marginIsla = Number(value || 0);

        // San Jorge: no UI, pero preservo
        if (field === "marginSanJorge")
          updated.marginSanJorge = Number(value || 0);

        if (
          field === "packages" ||
          field === "marginRivas" ||
          field === "marginIsla" ||
          field === "marginSanJorge"
        ) {
          const vals = calcTotalsByMargins(
            updated.providerPrice,
            updated.packages,
            {
              marginR: Number(updated.marginRivas || 0),
              marginSJ: Number(updated.marginSanJorge || 0),
              marginIsla: Number(updated.marginIsla || 0),
            },
          );
          updated = { ...updated, ...vals };
        }

        // remainingPackages: si no existe, igualo a packages. Si existe (edición), NO lo rompo.
        if (
          updated.remainingPackages === undefined ||
          updated.remainingPackages === null
        ) {
          updated.remainingPackages = updated.packages;
        }

        return updated;
      }),
    );
  };

  // =========================
  // Summary base (legacy)
  // =========================
  const orderSummaryBase = useMemo(() => {
    const totalPackages = orderItems.reduce(
      (acc, it) => acc + safeInt(it.packages),
      0,
    );
    const subtotal = orderItems.reduce(
      (acc, it) => acc + Number(it.subtotal || 0),
      0,
    );
    const totalRivas = orderItems.reduce(
      (acc, it) => acc + Number(it.totalRivas || 0),
      0,
    );
    const totalSanJorge = orderItems.reduce(
      (acc, it) => acc + Number(it.totalSanJorge || 0),
      0,
    );
    const totalIsla = orderItems.reduce(
      (acc, it) => acc + Number(it.totalIsla || 0),
      0,
    );
    return { totalPackages, subtotal, totalRivas, totalSanJorge, totalIsla };
  }, [orderItems]);

  // =========================
  // Computed items (utilidades + logística)
  // =========================
  const computed = useMemo(() => {
    const logisticsTotal = Math.max(0, num(logisticsCost || 0));
    const orderSubtotalTotal = Number(orderSummaryBase.subtotal || 0);
    const items = orderItems.map((it) =>
      applyProfitSplitAndLogistics(it, logisticsTotal, orderSubtotalTotal),
    );

    const grossTotal = items.reduce(
      (acc, it) => acc + Number(it.grossProfit || 0),
      0,
    );
    const grossIslaTotal = items.reduce(
      (acc, it) => acc + Number(it.grossProfitIsla || 0),
      0,
    );
    const logisticAllocatedTotal = items.reduce(
      (acc, it) => acc + Number(it.logisticAllocated || 0),
      0,
    );
    return {
      items,
      logisticsTotal,
      grossTotal,
      grossIslaTotal,
      logisticAllocatedTotal,
    };
  }, [orderItems, logisticsCost, orderSummaryBase.subtotal]);
  const filteredItems = useMemo(() => {
    const q = String(itemSearch || "")
      .trim()
      .toLowerCase();
    if (!q) return computed.items;

    return computed.items.filter((it) => {
      const name = String(it.name || "").toLowerCase();
      const cat = String(it.category || "").toLowerCase();
      return name.includes(q) || cat.includes(q);
    });
  }, [computed.items, itemSearch]);

  // Paginado para la tabla de ITEMS (desktop)
  const [itemPage, setItemPage] = useState<number>(1);
  const ITEMS_PAGE_SIZE = 15;
  const totalItemPages = useMemo(
    () => Math.max(1, Math.ceil(filteredItems.length / ITEMS_PAGE_SIZE)),
    [filteredItems.length],
  );

  // Resetear página cuando cambian los filtros/items
  useEffect(() => setItemPage(1), [filteredItems.length]);

  const pagedFilteredItems = useMemo(() => {
    const start = (itemPage - 1) * ITEMS_PAGE_SIZE;
    return filteredItems.slice(start, start + ITEMS_PAGE_SIZE);
  }, [filteredItems, itemPage]);

  // Mobile: collapsed state for item cards (start collapsed)
  const [expandedItems, setExpandedItems] = useState<Record<string, boolean>>(
    {},
  );
  useEffect(() => setExpandedItems({}), [filteredItems.length]);
  const toggleItemExpanded = (id: string) =>
    setExpandedItems((s) => ({ ...s, [id]: !s[id] }));

  // Mobile: collapsed state for order cards (start collapsed)
  const [expandedOrders, setExpandedOrders] = useState<Record<string, boolean>>(
    {},
  );
  useEffect(() => {
    const map: Record<string, boolean> = {};
    for (const o of orders) {
      if (o && o.id) map[o.id] = false;
    }
    setExpandedOrders(map);
  }, [orders]);
  const toggleOrderExpanded = (id: string) =>
    setExpandedOrders((s) => ({ ...s, [id]: !s[id] }));

  // =========================
  // KPIs (pedido)
  // =========================
  const orderKPIs = useMemo(() => {
    return {
      totalPackages: orderSummaryBase.totalPackages,
      subtotalCosto: orderSummaryBase.subtotal,
      esperadoRivas: orderSummaryBase.totalRivas,
      esperadoIsla: orderSummaryBase.totalIsla,
      gastosLogisticos: computed.logisticsTotal,
      utilidadBrutaRivas: computed.grossTotal,
      utilidadBrutaIsla: computed.grossIslaTotal,
    };
  }, [orderSummaryBase, computed]);

  // =========================
  // Excel: plantilla (Productos + Config)
  // =========================
  const handleDownloadTemplate = () => {
    setMsg("");
    if (!catalog.length) {
      setMsg("❌ No hay catálogo cargado para generar plantilla.");
      return;
    }

    const mR = Number(marginRivas || 0);
    const mI = Number(marginIsla || 0);

    // Sheet Productos (según tu excel)
    const rows = catalog
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map((p) => ({
        Producto: p.name,
        Paquetes: "",
        "Margen rivas": mR,
        "Margen Isla": mI,
        "P. unidad Rivas": "",
        "P. unidad Isla": "",
      }));

    // Sheet Config
    const cfgRows = [
      { Campo: "Gastos logisticos", Valor: num(logisticsCost || 0) },
    ];

    const wb = XLSX.utils.book_new();
    const wsProd = XLSX.utils.json_to_sheet(rows);
    const wsCfg = XLSX.utils.json_to_sheet(cfgRows);

    XLSX.utils.book_append_sheet(wb, wsProd, "Productos");
    XLSX.utils.book_append_sheet(wb, wsCfg, "Config");

    const dateStr =
      (orderDate && String(orderDate).trim()) ||
      new Date().toISOString().slice(0, 10);

    XLSX.writeFile(wb, `plantilla_orden_maestra_${dateStr}.xlsx`);
  };

  // =========================
  // Excel: exportar orden (Productos + Resumen)
  // =========================
  const handleExportOrderToExcel = () => {
    setMsg("");
    if (!computed.items.length) {
      setMsg("❌ No hay items para exportar.");
      return;
    }

    const rows = computed.items
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map((it) => ({
        Categoría: it.category,
        Producto: it.name,
        Paquetes: safeInt(it.packages),
        "Paquetes restantes": safeInt(it.remainingPackages ?? it.packages),
        "Und x Paquete": safeInt(it.unitsPerPackage),
        "Precio proveedor": Number(it.providerPrice || 0),
        Facturado: Number(it.subtotal || 0),
        "Esperado Rivas": Number(it.totalRivas || 0),
        "Esperado Isla": Number(it.totalIsla || 0),
        "MV Rivas": Number(it.marginRivas || 0),
        "MV Isla": Number(it.marginIsla || 0),
        "Utilidad Bruta": Number(it.grossProfit || 0),
        "Utilidad Bruta Isla": Number(it.grossProfitIsla || 0),
        "Prorrateo logistico": Number(it.logisticAllocated || 0),
        "Precio Rivas": Number(it.unitPriceRivas || 0),
        "Precio Isla": Number(it.unitPriceIsla || 0),
      }));

    const resumen = [
      { KPI: "Paquetes totales", Valor: orderKPIs.totalPackages },
      { KPI: "Subtotal costo", Valor: orderKPIs.subtotalCosto },
      { KPI: "Esperado Rivas", Valor: orderKPIs.esperadoRivas },
      { KPI: "Esperado Isla", Valor: orderKPIs.esperadoIsla },
      { KPI: "Gastos logísticos", Valor: orderKPIs.gastosLogisticos },
      { KPI: "Utilidad Bruta Rivas", Valor: orderKPIs.utilidadBrutaRivas },
      { KPI: "Utilidad Bruta Isla", Valor: orderKPIs.utilidadBrutaIsla },
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(rows),
      "Productos",
    );
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.json_to_sheet(resumen),
      "Resumen",
    );

    const dateStr =
      (orderDate && String(orderDate).trim()) ||
      new Date().toISOString().slice(0, 10);
    const name = (orderName && String(orderName).trim()) || `Orden_${dateStr}`;

    XLSX.writeFile(
      wb,
      `orden_maestra_${name.replace(/[^\w\-]+/g, "_")}_${dateStr}.xlsx`,
    );
  };

  // =========================
  // Excel: Import (lee Productos + Config)
  // =========================
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  const handlePickExcel = () => {
    if (!catalog.length) {
      setMsg("❌ Catálogo no cargado todavía. Esperá y probá de nuevo.");
      return;
    }
    fileInputRef.current?.click();
  };

  const handleExcelFileChange = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    if (!file) return;
    e.target.value = "";

    setImporting(true);
    setMsg("");

    try {
      const buffer = await file.arrayBuffer();
      const wb = XLSX.read(buffer, { type: "array" });

      // Detect sheets
      const sheetNames = wb.SheetNames || [];
      const wsProducts =
        wb.Sheets["Productos"] ||
        wb.Sheets["Plantilla"] ||
        wb.Sheets[sheetNames[0]];

      if (!wsProducts) {
        setMsg("❌ No se encontró hoja de Productos/Plantilla.");
        return;
      }

      const rows: any[] = XLSX.utils.sheet_to_json(wsProducts, { defval: "" });
      if (!rows.length) {
        setMsg("❌ El Excel viene vacío.");
        return;
      }

      // Leer config si existe (solo gastos logísticos)
      let cfgLogistics = 0;

      const wsCfg = wb.Sheets["Config"];
      if (wsCfg) {
        const cfgRows: any[] = XLSX.utils.sheet_to_json(wsCfg, { defval: "" });
        const mapCfg = new Map<string, any>();

        for (const r of cfgRows) {
          const k = norm(getRowValue(r, ["Campo", "Key", "Nombre"]) ?? "");
          const v = getRowValue(r, ["Valor", "Value"]);
          if (k) mapCfg.set(k, v);
        }

        if (mapCfg.has("gastos logisticos"))
          cfgLogistics = Math.max(0, num(mapCfg.get("gastos logisticos")));
      } else {
        // compat: si viene columna gastos en productos
        for (const r of rows) {
          const g = getRowValue(r, [
            "Gastos",
            "Gasto",
            "Gastos logisticos",
            "Logistica",
          ]);
          const gv = num(g);
          if (gv > 0) {
            cfgLogistics = gv;
            break;
          }
        }
      }

      // aplicar a UI
      setLogisticsCost(String(cfgLogistics || 0));

      // index por nombre (catálogo)
      const catalogByName = new Map<string, CatalogCandyProduct>();
      for (const p of catalog) catalogByName.set(norm(p.name), p);

      const errors: string[] = [];

      // Acumular por productId
      const incomingById = new Map<
        string,
        {
          packages: number;
          mR: number;
          mI: number;
          puR?: number;
          puI?: number;
        }
      >();

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        const productName = getRowValue(r, [
          "Producto",
          "Product",
          "Nombre",
          "Name",
        ]);
        const packagesVal = getRowValue(r, ["Paquetes", "Packages"]);

        const mRVal = getRowValue(r, [
          "Margen rivas",
          "Margen Rivas",
          "MV Rivas",
        ]);
        const mIVal = getRowValue(r, ["Margen Isla", "Margen isla", "MV Isla"]);

        const puRVal = getRowValue(r, [
          "P. unidad Rivas",
          "P unidad Rivas",
          "Precio Rivas",
        ]);
        const puIVal = getRowValue(r, [
          "P. unidad Isla",
          "P unidad Isla",
          "Precio Isla",
        ]);

        const prodKey = norm(productName);
        if (!prodKey) continue;

        const catProd = catalogByName.get(prodKey);
        if (!catProd) {
          errors.push(
            `Fila ${i + 2}: Producto no existe en catálogo: "${String(productName).trim()}".`,
          );
          continue;
        }

        const packagesNum = Math.floor(num(packagesVal));
        if (packagesNum <= 0) {
          errors.push(
            `Fila ${i + 2}: "Paquetes" inválido para "${catProd.name}".`,
          );
          continue;
        }

        const mR =
          String(mRVal ?? "").trim() !== ""
            ? num(mRVal)
            : Number(marginRivas || 0);
        const mI =
          String(mIVal ?? "").trim() !== ""
            ? num(mIVal)
            : Number(marginIsla || 0);

        const puR = Math.floor(num(puRVal));
        const puI = Math.floor(num(puIVal));

        const prev = incomingById.get(catProd.id);
        if (prev) {
          incomingById.set(catProd.id, {
            packages: prev.packages + packagesNum,
            mR,
            mI,
            puR: puR > 0 ? puR : prev.puR,
            puI: puI > 0 ? puI : prev.puI,
          });
        } else {
          incomingById.set(catProd.id, {
            packages: packagesNum,
            mR,
            mI,
            puR: puR > 0 ? puR : undefined,
            puI: puI > 0 ? puI : undefined,
          });
        }
      }

      const newItems: CandyOrderItem[] = [];

      incomingById.forEach((x, productId) => {
        const catProd = catalog.find((p) => p.id === productId);
        if (!catProd) return;

        const providerPriceNum = Number(catProd.providerPrice || 0);
        const unitsNum = Math.max(1, safeInt(catProd.unitsPerPackage || 1));
        const packagesNum = Math.max(1, safeInt(x.packages));

        const subtotalCalc = providerPriceNum * packagesNum;

        const priceR = Number(x.puR || 0);
        const priceI = Number(x.puI || 0);
        const hasAnyPrice = priceR > 0 || priceI > 0;

        let finalMR = x.mR;
        let finalMI = x.mI;

        // San Jorge legacy: calculo con el header actual pero no se usa en UI
        const mSJ = Number(marginSanJorge || 0);

        let vals: ReturnType<typeof calcTotalsByMargins>;

        if (hasAnyPrice) {
          const fallback = calcTotalsByMargins(providerPriceNum, packagesNum, {
            marginR: finalMR,
            marginSJ: mSJ,
            marginIsla: finalMI,
          });

          const totalR =
            priceR > 0 ? priceR * packagesNum : fallback.totalRivas;
          const totalI = priceI > 0 ? priceI * packagesNum : fallback.totalIsla;

          const deriveMargin = (total: number) => {
            if (!Number.isFinite(total) || total <= 0) return 0;
            const m = (1 - subtotalCalc / total) * 100;
            return Math.min(Math.max(m, 0), 99.9);
          };

          if (priceR > 0) finalMR = deriveMargin(totalR);
          if (priceI > 0) finalMI = deriveMargin(totalI);

          vals = {
            subtotal: subtotalCalc,
            totalRivas: totalR,
            totalSanJorge: fallback.totalSanJorge,
            totalIsla: totalI,
            gainRivas: totalR - subtotalCalc,
            gainSanJorge: fallback.gainSanJorge,
            gainIsla: totalI - subtotalCalc,
            unitPriceRivas:
              packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0,
            unitPriceSanJorge: fallback.unitPriceSanJorge,
            unitPriceIsla:
              packagesNum > 0 ? roundToInt(totalI / packagesNum) : 0,
          };
        } else {
          vals = calcTotalsByMargins(providerPriceNum, packagesNum, {
            marginR: finalMR,
            marginSJ: mSJ,
            marginIsla: finalMI,
          });
        }

        newItems.push({
          id: catProd.id,
          name: catProd.name,
          category: catProd.category,
          providerPrice: providerPriceNum,
          packages: packagesNum,
          unitsPerPackage: unitsNum,
          marginRivas: finalMR,
          marginSanJorge: mSJ,
          marginIsla: finalMI,

          subtotal: vals.subtotal,
          totalRivas: vals.totalRivas,
          totalSanJorge: vals.totalSanJorge,
          totalIsla: vals.totalIsla,

          gainRivas: vals.gainRivas,
          gainSanJorge: vals.gainSanJorge,
          gainIsla: vals.gainIsla,

          unitPriceRivas: vals.unitPriceRivas,
          unitPriceSanJorge: vals.unitPriceSanJorge,
          unitPriceIsla: vals.unitPriceIsla,

          remainingPackages: packagesNum,
        });
      });

      // Merge con existente (sumar paquetes)
      setOrderItems((prev) => {
        const map = new Map<string, CandyOrderItem>();
        prev.forEach((it) => map.set(it.id, it));

        for (const it of newItems) {
          const existing = map.get(it.id);

          if (!existing) {
            map.set(it.id, it);
          } else {
            const mergedPackages =
              safeInt(existing.packages) + safeInt(it.packages);

            const vals = calcTotalsByMargins(
              existing.providerPrice,
              mergedPackages,
              {
                marginR: it.marginRivas,
                marginSJ: Number(existing.marginSanJorge || 0),
                marginIsla: it.marginIsla,
              },
            );

            map.set(it.id, {
              ...existing,
              packages: mergedPackages,
              marginRivas: it.marginRivas,
              marginIsla: it.marginIsla,
              remainingPackages:
                safeInt(existing.remainingPackages ?? existing.packages) +
                safeInt(it.packages),
              ...vals,
            });
          }
        }

        return Array.from(map.values()).sort((a, b) =>
          a.name.localeCompare(b.name, "es"),
        );
      });

      setMobileTab("ITEMS");

      if (errors.length) {
        setMsg(`⚠️ Importado con detalles. Errores: ${errors.length}.`);
        console.warn("Errores import:", errors);
      } else {
        setMsg(`✅ Importación lista: ${newItems.length} productos agregados.`);
      }
    } catch (err) {
      console.error(err);
      setMsg(
        "❌ Error importando Excel. Revisá hojas: Productos + Config (o Plantilla).",
      );
    } finally {
      setImporting(false);
    }
  };

  // =========================
  // Load lista pedidos + agregados inventario
  // =========================
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const qO = query(
          collection(db, "candy_main_orders"),
          orderBy("createdAt", "desc"),
        );
        const snapO = await getDocs(qO);

        const ordersList: CandyOrderSummaryRow[] = [];
        snapO.forEach((d) => {
          const x = d.data() as any;

          ordersList.push({
            id: d.id,
            name: x.name ?? "",
            date: x.date ?? "",
            totalPackages: Number(x.totalPackages ?? 0),
            subtotal: Number(x.subtotal ?? 0),
            totalRivas: Number(x.totalRivas ?? 0),
            totalSanJorge: Number(x.totalSanJorge ?? 0), // legacy
            totalIsla: Number(x.totalIsla ?? 0),

            marginRivas: Number(x.marginRivas ?? 20),
            marginSanJorge: Number(x.marginSanJorge ?? 15), // legacy
            marginIsla: Number(x.marginIsla ?? 30),

            // NUEVO
            logisticsCost: Number(x.logisticsCost ?? 0),

            createdAt: x.createdAt ?? Timestamp.now(),
          });
        });

        setOrders(ordersList);

        // agregados por orden desde inventory_candies (consistente con helpers)
        const invSnap = await getDocs(collection(db, "inventory_candies"));
        const agg: Record<string, OrderInventoryAgg> = {};

        invSnap.forEach((d) => {
          const x = d.data() as any;
          const orderId = x.orderId as string | undefined;
          if (!orderId) return;

          const totalPackages = getInitialPackagesFromInvDoc(x);
          const remainingPackages = getRemainingPackagesFromInvDoc(x);

          if (!agg[orderId]) {
            agg[orderId] = { orderId, totalPackages: 0, remainingPackages: 0 };
          }
          agg[orderId].totalPackages += totalPackages;
          agg[orderId].remainingPackages += remainingPackages;
        });

        setOrderInventoryAgg(agg);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando pedidos generales.");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  const getOrderListDate = (o: CandyOrderSummaryRow) => {
    if (o.date) return o.date;
    if ((o.createdAt as any)?.toDate)
      return (o.createdAt as any).toDate().toISOString().slice(0, 10);
    return "—";
  };

  // =========================
  // Guardar pedido (crea / edita)
  // =========================
  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    setSavingOrder(true);

    if (!orderItems.length) {
      setMsg("Agrega al menos un producto a la orden.");
      return;
    }

    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const dateStr = orderDate || todayStr;

      const marginR = Number(marginRivas || 0);
      const marginSJ = Number(marginSanJorge || 0); // legacy
      const marginI = Number(marginIsla || 0);

      const logisticsTotal = Math.max(0, num(logisticsCost || 0));

      // Validaciones mínimas (NO cambio tu lógica)
      for (const it of orderItems) {
        if (!String(it.name || "").trim()) {
          setMsg("Hay un producto sin nombre en el pedido.");
          return;
        }
        if (Number(it.providerPrice || 0) < 0) {
          setMsg(
            `El precio proveedor no puede ser negativo (producto: ${it.name}).`,
          );
          return;
        }
        if (safeInt(it.packages) <= 0) {
          setMsg(`Los paquetes deben ser mayor que 0 (producto: ${it.name}).`);
          return;
        }
        if (safeInt(it.unitsPerPackage) <= 0) {
          setMsg(
            `Las unidades por paquete deben ser mayor que 0 (producto: ${it.name}).`,
          );
          return;
        }
      }

      // ✅ guardo items con utilidades ya calculadas (para export / auditoría)
      const subtotalTotal = Number(orderSummaryBase.subtotal || 0);
      const itemsToSave = orderItems.map((it) =>
        applyProfitSplitAndLogistics(it, logisticsTotal, subtotalTotal),
      );

      const summary = {
        totalPackages: orderSummaryBase.totalPackages,
        subtotal: orderSummaryBase.subtotal,
        totalRivas: orderSummaryBase.totalRivas,
        totalSanJorge: orderSummaryBase.totalSanJorge, // legacy
        totalIsla: orderSummaryBase.totalIsla,
      };

      const header: Omit<CandyMainOrderDoc, "createdAt"> & {
        createdAt?: Timestamp;
      } = {
        name: orderName || `Pedido ${dateStr}`,
        date: dateStr,

        totalPackages: summary.totalPackages,
        subtotal: summary.subtotal,
        totalRivas: summary.totalRivas,
        totalSanJorge: summary.totalSanJorge, // legacy
        totalIsla: summary.totalIsla,

        marginRivas: marginR,
        marginSanJorge: marginSJ, // legacy
        marginIsla: marginI,

        // ✅ NUEVO
        logisticsCost: logisticsTotal,

        items: itemsToSave,
      };

      if (editingOrderId) {
        // 1) actualizar pedido
        await updateDoc(doc(db, "candy_main_orders", editingOrderId), {
          ...header,
        });

        // 2) upsert inventario por (orderId, productId)
        for (const it of itemsToSave) {
          const invSnap = await getDocs(
            query(
              collection(db, "inventory_candies"),
              where("orderId", "==", editingOrderId),
              where("productId", "==", it.id),
            ),
          );

          const unitsPerPackageLocal = Math.max(
            1,
            safeInt(it.unitsPerPackage || 1),
          );
          const totalUnitsNew = safeInt(it.packages) * unitsPerPackageLocal;

          if (invSnap.empty) {
            // si es nuevo producto agregado en edición -> se crea inventario
            await addDoc(collection(db, "inventory_candies"), {
              productId: it.id,
              productName: it.name,
              category: it.category,
              measurement: "unidad",

              quantity: totalUnitsNew,
              remaining: totalUnitsNew,

              packages: safeInt(it.packages),
              remainingPackages: safeInt(it.packages),

              unitsPerPackage: unitsPerPackageLocal,
              totalUnits: totalUnitsNew,

              providerPrice: it.providerPrice,
              subtotal: it.subtotal,
              totalRivas: it.totalRivas,
              totalSanJorge: it.totalSanJorge, // legacy
              totalIsla: it.totalIsla,

              gainRivas: it.gainRivas,
              gainSanJorge: it.gainSanJorge, // legacy
              gainIsla: it.gainIsla,

              unitPriceRivas: it.unitPriceRivas,
              unitPriceSanJorge: it.unitPriceSanJorge, // legacy
              unitPriceIsla: it.unitPriceIsla,

              date: dateStr,
              createdAt: Timestamp.now(),
              status: "PENDIENTE",
              orderId: editingOrderId,
            });
          } else {
            // existe -> ajusto delta sin romper ventas previas
            for (const invDoc of invSnap.docs) {
              const data = invDoc.data() as any;

              const oldTotalUnits = safeInt(data.totalUnits ?? 0);
              const oldRemaining = safeInt(data.remaining ?? oldTotalUnits);

              const deltaUnits = totalUnitsNew - oldTotalUnits;
              const newRemaining = Math.max(0, oldRemaining + deltaUnits);
              const newRemainingPackages = Math.max(
                0,
                Math.floor(newRemaining / unitsPerPackageLocal),
              );

              await updateDoc(doc(db, "inventory_candies", invDoc.id), {
                productName: it.name,
                category: it.category,

                unitsPerPackage: unitsPerPackageLocal,
                totalUnits: totalUnitsNew,
                quantity: totalUnitsNew,

                remaining: newRemaining,
                packages: safeInt(it.packages),
                remainingPackages: newRemainingPackages,

                providerPrice: it.providerPrice,
                subtotal: it.subtotal,
                totalRivas: it.totalRivas,
                totalSanJorge: it.totalSanJorge, // legacy
                totalIsla: it.totalIsla,

                gainRivas: it.gainRivas,
                gainSanJorge: it.gainSanJorge, // legacy
                gainIsla: it.gainIsla,

                unitPriceRivas: it.unitPriceRivas,
                unitPriceSanJorge: it.unitPriceSanJorge, // legacy
                unitPriceIsla: it.unitPriceIsla,

                date: dateStr,
              });
            }
          }
        }

        // 3) eliminar inventarios de productos que ya no estén en la orden
        const invAll = await getDocs(
          query(
            collection(db, "inventory_candies"),
            where("orderId", "==", editingOrderId),
          ),
        );

        const itemIds = new Set(itemsToSave.map((x) => x.id));
        for (const invDoc of invAll.docs) {
          const x = invDoc.data() as any;
          const pid = String(x.productId || "");
          if (pid && !itemIds.has(pid)) {
            await deleteDoc(doc(db, "inventory_candies", invDoc.id));
          }
        }

        // 4) refrescar listado en memoria (sin recargar todo)
        setOrders((prev) =>
          prev.map((o) =>
            o.id === editingOrderId
              ? {
                  ...o,
                  name: header.name,
                  date: header.date,
                  totalPackages: header.totalPackages,
                  subtotal: header.subtotal,
                  totalRivas: header.totalRivas,
                  totalSanJorge: header.totalSanJorge,
                  totalIsla: header.totalIsla,
                  marginRivas: header.marginRivas,
                  marginSanJorge: header.marginSanJorge,
                  marginIsla: header.marginIsla,
                  logisticsCost: header.logisticsCost,
                }
              : o,
          ),
        );

        setMsg("✅ Orden maestra actualizada (pedido + inventario).");
        resetOrderForm();
        setOpenOrderModal(false);
        refresh();
        return;
      }

      // =========================
      // CREAR NUEVA ORDEN
      // =========================
      const orderRef = await addDoc(collection(db, "candy_main_orders"), {
        ...header,
        createdAt: Timestamp.now(),
      } as CandyMainOrderDoc);

      const orderId = orderRef.id;

      const batch = writeBatch(db);

      for (const it of itemsToSave) {
        const unitsPerPackageLocal = Math.max(
          1,
          safeInt(it.unitsPerPackage || 1),
        );
        const totalUnits = safeInt(it.packages) * unitsPerPackageLocal;

        const invRef = doc(collection(db, "inventory_candies"));
        batch.set(invRef, {
          productId: it.id,
          productName: it.name,
          category: it.category,
          measurement: "unidad",

          quantity: totalUnits,
          remaining: totalUnits,

          packages: safeInt(it.packages),
          remainingPackages: safeInt(it.packages),

          unitsPerPackage: unitsPerPackageLocal,
          totalUnits,

          providerPrice: it.providerPrice,
          subtotal: it.subtotal,
          totalRivas: it.totalRivas,
          totalSanJorge: it.totalSanJorge, // legacy
          totalIsla: it.totalIsla,

          gainRivas: it.gainRivas,
          gainSanJorge: it.gainSanJorge, // legacy
          gainIsla: it.gainIsla,

          unitPriceRivas: it.unitPriceRivas,
          unitPriceSanJorge: it.unitPriceSanJorge, // legacy
          unitPriceIsla: it.unitPriceIsla,

          date: dateStr,
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
          orderId,
        });
      }

      await batch.commit();

      setMsg("✅ Orden maestra creada y registrada en inventario.");
      resetOrderForm();
      setOpenOrderModal(false);
      refresh();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar orden maestra.");
    } finally {
      setSavingOrder(false);
    }
  };

  // =========================
  // Abrir orden para ver / editar
  // =========================
  const openOrderForEdit = async (order: CandyOrderSummaryRow) => {
    try {
      setLoading(true);
      setMsg("");

      setEditingOrderId(order.id);
      setOrderName(order.name);
      setOrderDate(order.date);

      // márgenes por sucursal (SJ legacy)
      setMarginRivas(String(order.marginRivas ?? 20));
      setMarginSanJorge(String(order.marginSanJorge ?? 15));
      setMarginIsla(String(order.marginIsla ?? 30));

      // ✅ NUEVO: logística
      const lg = Number(order.logisticsCost ?? 0);
      setLogisticsCost(String(lg || 0));

      // tab inicial
      setMobileTab("DATOS");

      // getDoc orden
      const orderDocRef = doc(db, "candy_main_orders", order.id);
      const orderSnap = await getDoc(orderDocRef);
      if (!orderSnap.exists()) {
        setMsg("❌ No se encontró la orden.");
        return;
      }
      const orderData = orderSnap.data() as any;

      const itemsFromDoc: CandyOrderItem[] = Array.isArray(orderData.items)
        ? (orderData.items as CandyOrderItem[])
        : [];

      // inventario para paquetes restantes por producto (orderId)
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id),
        ),
      );

      const remainingByProduct: Record<string, number> = {};
      invSnap.forEach((d) => {
        const x = d.data() as any;
        const productId = String(x.productId || "");
        if (!productId) return;

        const remainingPackages = getRemainingPackagesFromInvDoc(x);
        remainingByProduct[productId] =
          (remainingByProduct[productId] || 0) + remainingPackages;
      });

      // normalizar contra catálogo + recalcular totales (NO rompo tu lógica)
      const normalized = itemsFromDoc.map((it) => {
        const cat = catalog.find((c) => c.id === it.id);

        const providerPrice = Number(
          cat?.providerPrice ?? it.providerPrice ?? 0,
        );
        const unitsPerPackage = Math.max(
          1,
          safeInt(cat?.unitsPerPackage ?? it.unitsPerPackage ?? 1),
        );

        const mR = Number(it.marginRivas ?? 0);
        const mSJ = Number(it.marginSanJorge ?? Number(marginSanJorge || 0)); // legacy
        const mI = Number(it.marginIsla ?? 0);

        const vals = calcTotalsByMargins(
          providerPrice,
          safeInt(it.packages || 0),
          {
            marginR: mR,
            marginSJ: mSJ,
            marginIsla: mI,
          },
        );

        return {
          ...it,
          // nombre/categoría desde catálogo si existe
          name: String(cat?.name ?? it.name ?? "").trim(),
          category: String(cat?.category ?? it.category ?? "Caramelo").trim(),

          providerPrice,
          unitsPerPackage,

          // restantes desde inventario (si no existe, fallback)
          remainingPackages:
            remainingByProduct[it.id] ??
            it.remainingPackages ??
            it.packages ??
            0,

          ...vals,
        };
      });

      setOrderItems(normalized);
      setOpenOrderModal(true);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al abrir orden maestra.");
    } finally {
      setLoading(false);
    }
  };

  // =========================
  // Eliminar orden (y su inventario)
  // =========================
  const handleDeleteOrder = async (order: CandyOrderSummaryRow) => {
    const ok = confirm(
      `¿Eliminar la orden "${order.name}" y todo su inventario asociado?`,
    );
    if (!ok) return;

    setMsg("");
    try {
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id),
        ),
      );

      for (const d of invSnap.docs) {
        await deleteDoc(doc(db, "inventory_candies", d.id));
      }

      await deleteDoc(doc(db, "candy_main_orders", order.id));
      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setMsg("✅ Orden maestra eliminada.");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar orden maestra.");
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header / acciones */}
      <div className="mb-3">
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Ordenes Maestras</h2>
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div />

          <div className="flex items-center gap-2">
            <RefreshButton
              onClick={refresh}
              loading={loading || catalogLoading}
            />

            <button
              className="inline-flex items-center gap-2 bg-indigo-600 text-white px-2 md:px-3 py-2 rounded-2xl hover:bg-indigo-700 w-full md:w-auto max-w-[220px] justify-center"
              onClick={() => {
                resetOrderForm();
                setOpenOrderModal(true);
              }}
            >
              <span className="items-center gap-4 inline-block bg-indigo-700/40 rounded-full p-1">
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
              Nueva Orden
            </button>
          </div>
        </div>

        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>

      {/* MODAL ORDEN MAESTRA */}
      {openOrderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-3">
          <div className="relative bg-white p-4 md:p-6 rounded shadow-lg w-full max-w-6xl max-h-[90vh] overflow-y-auto text-sm">
            {savingOrder && (
              <div className="absolute inset-0 bg-white/70 z-50 flex items-center justify-center">
                <div className="bg-white border rounded-xl px-4 py-3 shadow flex items-center gap-3">
                  <svg
                    className="animate-spin h-5 w-5 text-gray-700"
                    xmlns="http://www.w3.org/2000/svg"
                    fill="none"
                    viewBox="0 0 24 24"
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
                  <div className="text-sm font-semibold">Guardando orden…</div>
                </div>
              </div>
            )}

            {/* Header sticky */}
            <div className="sticky top-0 bg-white z-20 pb-3 border-b">
              <div className="flex items-center gap-3">
                <h3 className="text-lg md:text-xl font-bold">
                  {editingOrderId
                    ? "Editar Orden Maestra"
                    : "Nueva Orden Maestra"}
                </h3>

                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-60"
                    disabled={savingOrder}
                    onClick={() => {
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                  >
                    Cerrar
                  </button>
                </div>
              </div>

              {/* Config rápida (logística + % utilidades) */}
              <div className="mt-3 grid grid-cols-1 md:grid-cols-1 gap-2">
                <div>
                  <label className="block text-xs font-semibold">
                    Gastos logísticos (orden)
                  </label>
                  <input
                    type="number"
                    className="w-full border p-2 rounded"
                    value={logisticsCost}
                    onChange={(e) => setLogisticsCost(e.target.value)}
                    placeholder="0"
                    min={0}
                  />
                </div>
              </div>

              {/* Tabs (solo móvil) */}
              <div className="md:hidden mt-3">
                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setMobileTab("DATOS")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "DATOS"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Datos
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("AGREGAR")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "AGREGAR"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Agregar
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("ITEMS")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "ITEMS"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Items ({orderItems.length})
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("TOTALES")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "TOTALES"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Totales
                  </button>
                </div>
              </div>
            </div>

            <form onSubmit={handleSaveOrder} className="space-y-4 pt-4">
              {/* file input (oculto) */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx,.xls,.csv"
                className="hidden"
                onChange={handleExcelFileChange}
              />

              {/* ===== DATOS ===== */}
              <div
                className={`${mobileTab === "DATOS" ? "block" : "hidden"} md:block`}
              >
                <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                  <div className="md:col-span-2">
                    <label className="block text-sm font-semibold">
                      Nombre de Orden
                    </label>
                    <input
                      className="w-full border p-2 rounded"
                      value={orderName}
                      onChange={(e) => setOrderName(e.target.value)}
                      placeholder="Ej: Pedido enero 19"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Fecha del pedido
                    </label>
                    <input
                      type="date"
                      className="w-full border p-2 rounded"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value)}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      % Ganancia Rivas
                    </label>
                    <input
                      type="number"
                      className="w-full border p-2 rounded"
                      value={marginRivas}
                      onChange={(e) => setMarginRivas(e.target.value)}
                    />
                  </div>

                  {/* San Jorge legacy: lo mantenemos oculto en UI */}
                  <input type="hidden" value={marginSanJorge} readOnly />

                  <div>
                    <label className="block text-sm font-semibold">
                      % Ganancia Isla Ometepe
                    </label>
                    <input
                      type="number"
                      className="w-full border p-2 rounded"
                      value={marginIsla}
                      onChange={(e) => setMarginIsla(e.target.value)}
                    />
                  </div>
                </div>
              </div>

              {/* ===== AGREGAR ===== */}
              <div
                className={`${mobileTab === "AGREGAR" ? "block" : "hidden"} md:block`}
              >
                <div className="border rounded p-3 bg-gray-50">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-sm font-semibold">
                        Categoría (dinámica)
                      </label>
                      <select
                        className="w-full border p-2 rounded"
                        value={orderCategory}
                        onChange={(e) => {
                          setOrderCategory(e.target.value);
                          setOrderProductId("");
                        }}
                        disabled={catalogLoading}
                      >
                        {catalogCategories.length === 0 ? (
                          <option value="">
                            {catalogLoading
                              ? "Cargando..."
                              : "No hay categorías en catálogo"}
                          </option>
                        ) : (
                          catalogCategories.map((c) => (
                            <option key={c} value={c}>
                              {c}
                            </option>
                          ))
                        )}
                      </select>
                    </div>

                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold">
                        Producto (catálogo)
                      </label>
                      <select
                        className="w-full border p-2 rounded"
                        value={orderProductId}
                        onChange={(e) => setOrderProductId(e.target.value)}
                      >
                        <option value="">
                          {catalogLoading
                            ? "Cargando catálogo..."
                            : "Selecciona producto"}
                        </option>
                        {catalogByCategory.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="block text-sm font-semibold">
                        Precio proveedor (paq)
                      </label>
                      <input
                        type="number"
                        className="w-full border p-2 rounded bg-gray-100"
                        value={orderProviderPrice}
                        readOnly
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold">
                        Paquetes
                      </label>
                      <input
                        type="number"
                        min={0}
                        className="w-full border p-2 rounded"
                        value={orderPackages}
                        onChange={(e) => setOrderPackages(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold">
                        Unidades por paquete
                      </label>
                      <input
                        type="number"
                        className="w-full border p-2 rounded bg-gray-100"
                        value={orderUnitsPerPackage}
                        readOnly
                      />
                    </div>
                  </div>

                  <div className="flex flex-col md:flex-row md:items-center md:justify-end gap-2 mt-3">
                    <button
                      type="button"
                      onClick={addItemToOrder}
                      className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Agregar producto
                    </button>
                  </div>
                </div>
              </div>

              {/* Acciones Excel (desktop) */}
              <div className="hidden md:flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={handleDownloadTemplate}
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  title="Descarga plantilla (Productos + Config)"
                >
                  Descargar plantilla
                </button>

                <button
                  type="button"
                  onClick={handlePickExcel}
                  disabled={importing}
                  className="px-3 py-2 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-60"
                  title="Importa desde Excel (Productos + Config)"
                >
                  {importing ? "Importando..." : "Importar Excel"}
                </button>

                <button
                  type="button"
                  onClick={handleExportOrderToExcel}
                  className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                  title="Exporta la orden actual (Productos + Resumen)"
                >
                  Exportar Excel
                </button>
              </div>

              {/* ===== ITEMS ===== */}
              <div
                className={`${mobileTab === "ITEMS" ? "block" : "hidden"} md:block`}
              >
                <div className="mt-2">
                  <div className="mb-2 flex flex-col md:flex-row md:items-center md:justify-between gap-2">
                    <div className="text-xs text-gray-600">
                      Items:{" "}
                      <span className="font-semibold">{orderItems.length}</span>
                      {itemSearch.trim() ? (
                        <>
                          {" "}
                          · Mostrando{" "}
                          <span className="font-semibold">
                            {filteredItems.length}
                          </span>
                        </>
                      ) : null}
                    </div>

                    <input
                      value={itemSearch}
                      onChange={(e) => setItemSearch(e.target.value)}
                      placeholder="Buscar producto o categoría…"
                      className="w-full md:w-80 border rounded px-3 py-2 text-sm"
                    />
                  </div>

                  {/* Desktop: Tabla */}
                  <div className="hidden md:block">
                    <div className="overflow-x-auto border rounded pb-5">
                      <table className="min-w-[1400px] w-full text-xs">
                        <thead className="bg-gray-100">
                          <tr>
                            <th className="text-left p-2">Categoría</th>
                            <th className="text-left p-2">Producto</th>
                            <th className="text-right p-2">Paquetes</th>
                            <th className="text-right p-2">Restantes</th>
                            <th className="text-right p-2">Und x Paq</th>
                            <th className="text-right p-2">Precio prov</th>

                            <th className="text-right p-2">Facturado</th>

                            <th className="text-right p-2">Esperado Rivas</th>
                            <th className="text-right p-2">Esperado Isla</th>

                            <th className="text-right p-2">MV Rivas</th>
                            <th className="text-right p-2">MV Isla</th>

                            <th className="text-right p-2">U. Bruta Rivas</th>
                            <th className="text-right p-2">U. Bruta Isla</th>
                            <th className="text-right p-2">Prorrateo</th>

                            <th className="text-right p-2">Precio Rivas</th>
                            <th className="text-right p-2">Precio Isla</th>

                            <th className="text-center p-2">Acciones</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedFilteredItems.map((it) => (
                            <tr key={it.id} className="border-t">
                              <td className="p-2">{it.category}</td>
                              <td className="p-2 font-semibold">{it.name}</td>

                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  className="w-20 border rounded p-1 text-right"
                                  value={it.packages}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "packages",
                                      e.target.value,
                                    )
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">
                                <span className="inline-block min-w-[60px] text-right">
                                  {safeInt(it.remainingPackages ?? it.packages)}
                                </span>
                              </td>

                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  className="w-20 border rounded p-1 text-right"
                                  value={it.unitsPerPackage}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "unitsPerPackage",
                                      e.target.value,
                                    )
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.providerPrice || 0).toFixed(2)}
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.subtotal || 0).toFixed(2)}
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.totalRivas || 0).toFixed(2)}
                              </td>
                              <td className="p-2 text-right">
                                {Number(it.totalIsla || 0).toFixed(2)}
                              </td>

                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  className="w-16 border rounded p-1 text-right"
                                  value={Number(it.marginRivas ?? 0)}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "marginRivas",
                                      e.target.value,
                                    )
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">
                                <input
                                  type="number"
                                  className="w-16 border rounded p-1 text-right"
                                  value={Number(it.marginIsla ?? 0)}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "marginIsla",
                                      e.target.value,
                                    )
                                  }
                                />
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.grossProfit || 0).toFixed(2)}
                              </td>
                              <td className="p-2 text-right">
                                {Number(it.grossProfitIsla || 0).toFixed(2)}
                              </td>
                              <td className="p-2 text-right">
                                {Number(it.logisticAllocated || 0).toFixed(2)}
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.unitPriceRivas || 0)}
                              </td>
                              <td className="p-2 text-right">
                                {Number(it.unitPriceIsla || 0)}
                              </td>

                              <td className="p-2 text-center">
                                <button
                                  type="button"
                                  className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700"
                                  onClick={() => removeItemFromOrder(it.id)}
                                >
                                  Quitar
                                </button>
                              </td>
                            </tr>
                          ))}
                          {filteredItems.length === 0 && (
                            <tr>
                              <td
                                colSpan={17}
                                className="p-4 text-center text-gray-500"
                              >
                                No hay productos en la orden.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {/* Paginación items (desktop) */}
                    <div className="mt-2 flex items-center justify-between">
                      <div className="text-sm text-gray-600">
                        Mostrando{" "}
                        {Math.min(
                          (itemPage - 1) * ITEMS_PAGE_SIZE + 1,
                          filteredItems.length,
                        )}
                        -
                        {Math.min(
                          itemPage * ITEMS_PAGE_SIZE,
                          filteredItems.length,
                        )}{" "}
                        de {filteredItems.length}
                      </div>

                      <div className="flex items-center gap-2">
                        <button
                          type="button"
                          disabled={itemPage <= 1}
                          onClick={() => setItemPage((p) => Math.max(1, p - 1))}
                          className="px-2 py-1 rounded border disabled:opacity-50 text-sm"
                        >
                          Anterior
                        </button>

                        <div className="px-3 py-1 border rounded text-sm">
                          {itemPage} / {totalItemPages}
                        </div>

                        <button
                          type="button"
                          disabled={itemPage >= totalItemPages}
                          onClick={() =>
                            setItemPage((p) => Math.min(totalItemPages, p + 1))
                          }
                          className="px-2 py-1 rounded border disabled:opacity-50 text-sm"
                        >
                          Siguiente
                        </button>
                      </div>
                    </div>
                  </div>

                  {/* MÓVIL: Cards */}
                  <div className="md:hidden space-y-3">
                    {filteredItems.length === 0 ? (
                      <div className="p-4 border rounded bg-gray-50 text-gray-600">
                        No hay productos en esta orden.
                      </div>
                    ) : (
                      filteredItems.map((it) => (
                        <div
                          key={it.id}
                          className="border rounded-xl p-3 shadow-sm"
                        >
                          <div className="flex items-start gap-2">
                            <div className="flex-1 min-w-0">
                              <div className="font-semibold text-base leading-tight truncate">
                                {it.name}
                              </div>
                              <div className="text-xs text-gray-500 truncate">
                                {it.category}
                              </div>
                            </div>

                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                              onClick={() => removeItemFromOrder(it.id)}
                            >
                              Quitar
                            </button>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3">
                            <div>
                              <label className="text-xs text-gray-600">
                                Paquetes
                              </label>
                              <input
                                type="number"
                                className="w-full border p-2 rounded text-right"
                                value={it.packages}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "packages",
                                    e.target.value,
                                  )
                                }
                              />
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                Paquetes restantes
                              </label>
                              <input
                                className="w-full border p-2 rounded text-right bg-gray-100"
                                value={it.remainingPackages ?? it.packages}
                                readOnly
                              />
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                Und x Paquete
                              </label>
                              <input
                                type="number"
                                className="w-full border p-2 rounded text-right"
                                value={it.unitsPerPackage}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "unitsPerPackage",
                                    e.target.value,
                                  )
                                }
                              />
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                Precio proveedor
                              </label>
                              <input
                                className="w-full border p-2 rounded text-right bg-gray-100"
                                value={Number(it.providerPrice || 0).toFixed(2)}
                                readOnly
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3">
                            <div>
                              <label className="text-xs text-gray-600">
                                MV Rivas (%)
                              </label>
                              <input
                                type="number"
                                className="w-full border p-2 rounded text-right"
                                value={it.marginRivas ?? 0}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "marginRivas",
                                    e.target.value,
                                  )
                                }
                              />
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                MV Isla (%)
                              </label>
                              <input
                                type="number"
                                className="w-full border p-2 rounded text-right"
                                value={it.marginIsla ?? 0}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "marginIsla",
                                    e.target.value,
                                  )
                                }
                              />
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                            <div className="p-2 rounded bg-gray-50 border">
                              <div className="text-xs text-gray-600">
                                Facturado
                              </div>
                              <div className="font-semibold">
                                {Number(it.subtotal || 0).toFixed(2)}
                              </div>
                            </div>

                            <div className="p-2 rounded bg-gray-50 border">
                              <div className="text-xs text-gray-600">
                                Esperado Rivas
                              </div>
                              <div className="font-semibold">
                                {Number(it.totalRivas || 0).toFixed(2)}
                              </div>
                            </div>

                            <div className="p-2 rounded bg-gray-50 border">
                              <div className="text-xs text-gray-600">
                                Esperado Isla
                              </div>
                              <div className="font-semibold">
                                {Number(it.totalIsla || 0).toFixed(2)}
                              </div>
                            </div>

                            <div className="p-2 rounded bg-gray-50 border">
                              <div className="text-xs text-gray-600">
                                Prorrateo logístico
                              </div>
                              <div className="font-semibold">
                                {Number(it.logisticAllocated || 0).toFixed(2)}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                            <div className="p-2 rounded bg-emerald-50 border">
                              <div className="text-gray-600">
                                U. Bruta Rivas
                              </div>
                              <div className="font-semibold">
                                {Number(it.grossProfit || 0).toFixed(2)}
                              </div>
                            </div>
                            <div className="p-2 rounded bg-emerald-50 border">
                              <div className="text-gray-600">U. Bruta Isla</div>
                              <div className="font-semibold">
                                {Number(it.grossProfitIsla || 0).toFixed(2)}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3 text-xs">
                            <div className="p-2 rounded bg-blue-50 border">
                              <div className="text-gray-600">
                                Precio Rivas (paq)
                              </div>
                              <div className="font-semibold">
                                {it.unitPriceRivas}
                              </div>
                            </div>

                            <div className="p-2 rounded bg-blue-50 border">
                              <div className="text-gray-600">
                                Precio Isla (paq)
                              </div>
                              <div className="font-semibold">
                                {it.unitPriceIsla}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>

              {/* ===== TOTALES / KPIs ===== */}
              <div
                className={`${mobileTab === "TOTALES" ? "block" : "hidden"} md:block`}
              >
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
                  <div className="p-3 border rounded bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Paquetes totales
                    </div>
                    <div className="text-lg font-semibold">
                      {orderKPIs.totalPackages}
                    </div>
                  </div>
                  <div className="p-3 border rounded bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Subtotal costo (facturado)
                    </div>
                    <div className="text-lg font-semibold">
                      {Number(orderKPIs.subtotalCosto || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="p-3 border rounded bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Esperado (Rivas / Isla)
                    </div>
                    <div className="text-sm font-semibold">
                      Rivas: {Number(orderKPIs.esperadoRivas || 0).toFixed(2)}
                      <br />
                      Isla: {Number(orderKPIs.esperadoIsla || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="p-3 border rounded bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Gastos logísticos
                    </div>
                    <div className="text-lg font-semibold">
                      {Number(orderKPIs.gastosLogisticos || 0).toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="mt-3">
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="p-3 border rounded bg-emerald-50">
                      <div className="text-xs text-gray-600">
                        Utilidad Bruta Rivas
                      </div>
                      <div className="text-lg font-semibold">
                        {Number(orderKPIs.utilidadBrutaRivas || 0).toFixed(2)}
                      </div>
                    </div>

                    <div className="p-3 border rounded bg-emerald-50">
                      <div className="text-xs text-gray-600">
                        Utilidad Bruta Isla
                      </div>
                      <div className="text-lg font-semibold">
                        {Number(orderKPIs.utilidadBrutaIsla || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 border rounded p-3 bg-white">
                    <div className="flex justify-end">
                      <button
                        type="button"
                        className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                        onClick={handleExportOrderToExcel}
                        disabled={!computed.items.length}
                        title="Exporta la orden actual (productos + resumen)"
                      >
                        Exportar orden a Excel
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* ===== Botonera sticky ===== */}
              <div className="sticky bottom-0 bg-white pt-3 mt-4 border-t">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetOrderForm}
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  >
                    Limpiar orden
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  >
                    Cerrar
                  </button>

                  <button
                    type="submit"
                    className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                    disabled={savingOrder || orderItems.length === 0}
                  >
                    {savingOrder ? "Guardando..." : "Guardar orden"}
                  </button>
                </div>

                {/* Atajo móvil */}
                <div className="md:hidden mt-2">
                  <button
                    type="button"
                    className="w-full px-3 py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm"
                    onClick={() => {
                      if (mobileTab === "DATOS" && !editingOrderId)
                        setMobileTab("AGREGAR");
                      else if (mobileTab === "DATOS") setMobileTab("ITEMS");
                      else if (mobileTab === "AGREGAR") setMobileTab("ITEMS");
                      else if (mobileTab === "ITEMS") setMobileTab("TOTALES");
                      else setMobileTab("DATOS");
                    }}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LISTADO */}
      <div className="mt-4">
        {/* MÓVIL: Cards */}
        <div className="md:hidden space-y-3">
          {loading ? (
            <div className="p-4 border rounded bg-white text-center">
              Cargando…
            </div>
          ) : orders.length === 0 ? (
            <div className="p-4 border rounded bg-white text-center">
              Sin ordenes maestras.
            </div>
          ) : (
            orders.map((o) => {
              const agg = orderInventoryAgg[o.id];
              const fecha = getOrderListDate(o);
              const precioProveedor =
                o.totalPackages > 0
                  ? (o.subtotal / o.totalPackages).toFixed(2)
                  : "0.00";

              const logi = Number(o.logisticsCost || 0);
              const grossEst =
                Number(o.totalRivas || 0) - Number(o.subtotal || 0);

              return (
                <div
                  key={o.id}
                  className="border rounded-xl p-3 bg-white shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="text-xs text-gray-500">{fecha}</div>
                      <div className="font-semibold text-base leading-tight">
                        {o.name}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        className="px-3 py-2 rounded bg-blue-600 text-white text-xs"
                        onClick={() => openOrderForEdit(o)}
                      >
                        Ver
                      </button>
                      <button
                        className="px-3 py-2 rounded bg-red-600 text-white text-xs"
                        onClick={() => handleDeleteOrder(o)}
                      >
                        Borrar
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Paquetes</div>
                      <div className="font-semibold">{o.totalPackages}</div>
                    </div>
                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Restantes</div>
                      <div className="font-semibold">
                        {agg ? agg.remainingPackages : 0}
                      </div>
                    </div>

                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">P. Proveedor</div>
                      <div className="font-semibold">{precioProveedor}</div>
                    </div>
                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Subtotal</div>
                      <div className="font-semibold">
                        {Number(o.subtotal || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                    <div className="p-2 rounded bg-blue-50 border">
                      <div className="text-gray-600">Esperado Rivas</div>
                      <div className="font-semibold">
                        {Number(o.totalRivas || 0).toFixed(2)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-blue-50 border">
                      <div className="text-gray-600">Esperado Isla</div>
                      <div className="font-semibold">
                        {Number(o.totalIsla || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-2 text-xs">
                    <div className="p-2 rounded bg-emerald-50 border">
                      <div className="text-gray-600">Gastos log.</div>
                      <div className="font-semibold">{logi.toFixed(2)}</div>
                    </div>
                    <div className="p-2 rounded bg-emerald-50 border">
                      <div className="text-gray-600">U. Bruta (est)</div>
                      <div className="font-semibold">{grossEst.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* DESKTOP: tabla */}
        <div className="hidden md:block bg-white p-2 rounded shadow border w-full overflow-x-auto">
          <table className="min-w-[1100px] text-xs md:text-sm">
            <thead className="bg-gray-100">
              <tr className="whitespace-nowrap">
                <th className="p-2 border">Fecha</th>
                <th className="p-2 border">Nombre</th>
                <th className="p-2 border">Paquetes totales</th>
                <th className="p-2 border">Paquetes restantes</th>
                <th className="p-2 border">Precio Proveedor</th>
                <th className="p-2 border">Subtotal</th>
                <th className="p-2 border">Esperado Rivas</th>
                <th className="p-2 border">Esperado Isla</th>
                <th className="p-2 border">Gastos log.</th>
                <th className="p-2 border">U. Bruta (est)</th>
                <th className="p-2 border">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={11} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : orders.length === 0 ? (
                <tr>
                  <td colSpan={11} className="p-4 text-center">
                    Sin ordenes maestras.
                  </td>
                </tr>
              ) : (
                pagedOrders.map((o) => {
                  const agg = orderInventoryAgg[o.id];
                  const fecha = getOrderListDate(o);

                  const precioProveedor =
                    o.totalPackages > 0
                      ? (o.subtotal / o.totalPackages).toFixed(2)
                      : "0.00";

                  const logi = Number(o.logisticsCost || 0);
                  const grossEst =
                    Number(o.totalRivas || 0) - Number(o.subtotal || 0);

                  return (
                    <tr key={o.id} className="text-center whitespace-nowrap">
                      <td className="p-2 border">{fecha}</td>
                      <td className="p-2 border text-left">{o.name}</td>
                      <td className="p-2 border">{o.totalPackages}</td>
                      <td className="p-2 border">
                        {agg ? agg.remainingPackages : 0}
                      </td>
                      <td className="p-2 border">{precioProveedor}</td>
                      <td className="p-2 border">
                        {Number(o.subtotal || 0).toFixed(2)}
                      </td>
                      <td className="p-2 border">
                        {Number(o.totalRivas || 0).toFixed(2)}
                      </td>
                      <td className="p-2 border">
                        {Number(o.totalIsla || 0).toFixed(2)}
                      </td>
                      <td className="p-2 border">{logi.toFixed(2)}</td>
                      <td className="p-2 border">{grossEst.toFixed(2)}</td>
                      <td className="p-2 border">
                        <div className="flex gap-1 justify-center">
                          <button
                            className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                            onClick={() => openOrderForEdit(o)}
                          >
                            Ver / Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                            onClick={() => handleDeleteOrder(o)}
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
          {/* Paginación (desktop) */}
          <div className="mt-2 flex items-center justify-between">
            <div className="text-sm text-gray-600">
              Mostrando {Math.min((page - 1) * PAGE_SIZE + 1, orders.length)}-
              {Math.min(page * PAGE_SIZE, orders.length)} de {orders.length}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="px-2 py-1 rounded border disabled:opacity-50 text-sm"
              >
                Anterior
              </button>

              <div className="px-3 py-1 border rounded text-sm">
                {page} / {totalPages}
              </div>

              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="px-2 py-1 rounded border disabled:opacity-50 text-sm"
              >
                Siguiente
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
