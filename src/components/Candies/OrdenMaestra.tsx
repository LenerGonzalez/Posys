// src/components/Candies/CandyMainOrders.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  documentId,
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
import Button from "../common/Button";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Toast from "../common/Toast";
import ActionMenu, { ActionMenuTrigger } from "../common/ActionMenu";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerDetailDlCard,
  DrawerSectionTitle,
  DrawerStatGrid,
} from "../common/DrawerContentCards";
import useManualRefresh from "../../hooks/useManualRefresh";
import { backfillCandyInventoryFromMainOrder } from "../../Services/inventory_candies";

// Small helpers used in this file
const safeInt = (v: any) => Math.max(0, Math.floor(Number(v) || 0));
const roundToInt = (n: number) => Math.round(n || 0);
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const MAX_MARGIN_PERCENT = 99.999;

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
  uBrutaGlobal?: number;

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
// Cálculos
// =====================
function chunkArray<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

/** Misma lógica que PreciosVenta: packagePrice* o unitPrice* × und/paq. */
function pkgPricesFromCurrentPricesDoc(
  p: Record<string, any> | undefined | null,
  unitsPerPackage: number,
): { rivas: number; isla: number } {
  const u = Math.max(1, safeInt(unitsPerPackage));
  let pkgIsla = Number(p?.packagePriceIsla ?? NaN);
  let pkgRivas = Number(p?.packagePriceRivas ?? NaN);
  if (!Number.isFinite(pkgIsla)) {
    const x = Number(p?.unitPriceIsla ?? NaN);
    pkgIsla = Number.isFinite(x) ? x * u : 0;
  }
  if (!Number.isFinite(pkgRivas)) {
    const x = Number(p?.unitPriceRivas ?? NaN);
    pkgRivas = Number.isFinite(x) ? x * u : 0;
  }
  return { rivas: pkgRivas, isla: pkgIsla };
}

function deriveMarginPercentFromSubtotalAndTotal(
  subtotal: number,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max((1 - subtotal / total) * 100, 0), MAX_MARGIN_PERCENT);
}

/** Precio Rivas/Isla por paquete fijado (p. ej. desde current_prices); SJ sigue por margen. */
function calcTotalsFromFixedPackageSalePrices(
  providerPriceNum: number,
  packagesNum: number,
  marginSanJorgePct: number,
  unitPriceRivasPerPkg: number,
  unitPriceIslaPerPkg: number,
) {
  const subtotalCalc = providerPriceNum * packagesNum;
  const limit = MAX_MARGIN_PERCENT;
  const mSJ = Math.min(Math.max(marginSanJorgePct, 0), limit) / 100;

  const totalR = unitPriceRivasPerPkg * packagesNum;
  const totalI = unitPriceIslaPerPkg * packagesNum;
  const totalSJ =
    packagesNum > 0 && mSJ < 1 ? subtotalCalc / (1 - mSJ) : subtotalCalc;

  const gainR = totalR - subtotalCalc;
  const gainSJ = totalSJ - subtotalCalc;
  const gainIO = totalI - subtotalCalc;

  const unitR = packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0;
  const unitSJ = packagesNum > 0 ? roundToInt(totalSJ / packagesNum) : 0;
  const unitIO = packagesNum > 0 ? roundToInt(totalI / packagesNum) : 0;

  const marginR = deriveMarginPercentFromSubtotalAndTotal(
    subtotalCalc,
    totalR,
  );
  const marginIsla = deriveMarginPercentFromSubtotalAndTotal(
    subtotalCalc,
    totalI,
  );

  return {
    subtotal: subtotalCalc,
    totalRivas: totalR,
    totalSanJorge: totalSJ,
    totalIsla: totalI,
    gainRivas: gainR,
    gainSanJorge: gainSJ,
    gainIsla: gainIO,
    unitPriceRivas: unitR,
    unitPriceSanJorge: unitSJ,
    unitPriceIsla: unitIO,
    marginRivas: marginR,
    marginIsla: marginIsla,
  };
}

async function fetchCurrentPricesByProductIds(
  ids: string[],
): Promise<Map<string, Record<string, any>>> {
  const map = new Map<string, Record<string, any>>();
  const clean = [...new Set(ids.filter(Boolean))];
  for (const group of chunkArray(clean, 30)) {
    if (!group.length) continue;
    const q = query(
      collection(db, "current_prices"),
      where(documentId(), "in", group),
    );
    const snap = await getDocs(q);
    snap.forEach((d) => map.set(d.id, d.data() as Record<string, any>));
  }
  return map;
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
  const [orderListMenu, setOrderListMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  const [modalItemMenu, setModalItemMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  /** Menús ⋮ dentro del modal (cabecera / Excel / pie) — móvil y web */
  const [masterModalHeaderMenu, setMasterModalHeaderMenu] = useState<{
    rect: DOMRect;
  } | null>(null);
  const [masterModalExcelMenu, setMasterModalExcelMenu] = useState<{
    rect: DOMRect;
  } | null>(null);
  const [masterModalFooterMenu, setMasterModalFooterMenu] = useState<{
    rect: DOMRect;
  } | null>(null);
  /** Menú ⋮ barra del listado (tabla web) */
  const [mainOrdersListToolbarMenu, setMainOrdersListToolbarMenu] = useState<{
    rect: DOMRect;
  } | null>(null);
  const orderFormRef = useRef<HTMLFormElement | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingOrder, setSavingOrder] = useState(false);
  const [addingItemToOrder, setAddingItemToOrder] = useState(false);
  const [refreshingSalePrices, setRefreshingSalePrices] = useState(false);
  const [isBackfillingMain, setIsBackfillingMain] = useState(false);
  const [backfillingInventory, setBackfillingInventory] = useState(false);

  // ====== CATÁLOGO (products_candies) ======
  const [catalog, setCatalog] = useState<CatalogCandyProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // listado de órdenes
  const [orders, setOrders] = useState<CandyOrderSummaryRow[]>([]);

  // agregados inventario por orden (para “restantes” del listado)
  const [orderInventoryAgg, setOrderInventoryAgg] = useState<
    Record<string, OrderInventoryAgg>
  >({});

  /** Detalle desde el listado (slide-over) */
  const [masterDrawerOpen, setMasterDrawerOpen] = useState(false);
  const [masterDrawerLoading, setMasterDrawerLoading] = useState(false);
  const [masterDrawerOrder, setMasterDrawerOrder] =
    useState<CandyOrderSummaryRow | null>(null);
  const [masterDrawerItems, setMasterDrawerItems] = useState<CandyOrderItem[]>(
    [],
  );
  const [masterDrawerUBrutaGlobal, setMasterDrawerUBrutaGlobal] = useState<
    number | null
  >(null);

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
  const originalOrderSnapshotRef = useRef<string>("");

  // ===== Edición inline (lápiz) =====
  const [editingPackagesMap, setEditingPackagesMap] = useState<
    Record<string, boolean>
  >({});
  const [editingUnitsMap, setEditingUnitsMap] = useState<
    Record<string, boolean>
  >({});
  const [editingRemainingMap, setEditingRemainingMap] = useState<
    Record<string, boolean>
  >({});
  const [editingProviderPriceMap, setEditingProviderPriceMap] = useState<
    Record<string, boolean>
  >({});

  const openPackagesEdit = (id: string) =>
    setEditingPackagesMap((prev) => ({ ...prev, [id]: true }));
  const closePackagesEdit = (id: string) =>
    setEditingPackagesMap((prev) => ({ ...prev, [id]: false }));

  const openUnitsEdit = (id: string) =>
    setEditingUnitsMap((prev) => ({ ...prev, [id]: true }));
  const closeUnitsEdit = (id: string) =>
    setEditingUnitsMap((prev) => ({ ...prev, [id]: false }));
  const openRemainingEdit = (id: string) =>
    setEditingRemainingMap((prev) => ({ ...prev, [id]: true }));
  const closeRemainingEdit = (id: string) =>
    setEditingRemainingMap((prev) => ({ ...prev, [id]: false }));
  const openProviderPriceEdit = (id: string) =>
    setEditingProviderPriceMap((prev) => ({ ...prev, [id]: true }));
  const closeProviderPriceEdit = (id: string) =>
    setEditingProviderPriceMap((prev) => ({ ...prev, [id]: false }));

  // selección producto
  const [orderCategory, setOrderCategory] = useState<string>("Todas");
  const [orderProductId, setOrderProductId] = useState<string>("");
  const [productSearch, setProductSearch] = useState<string>("");

  // auto-llenados desde catálogo (solo lectura)
  const [orderProviderPrice, setOrderProviderPrice] = useState<string>("");
  /** Precio venta Isla por paquete desde current_prices (solo lectura en el formulario). */
  const [orderSalePricePkgIsla, setOrderSalePricePkgIsla] = useState<string>("");
  const [orderUnitsPerPackage, setOrderUnitsPerPackage] = useState<string>("1");
  const [orderPackages, setOrderPackages] = useState<string>("0");

  // Tabs (solo móvil)
  const [mobileTab, setMobileTab] = useState<MobileTab>("DATOS");

  const [itemSearch, setItemSearch] = useState("");

  const serializeOrderState = (items: CandyOrderItem[]) => {
    const normalizedItems = items
      .map((it) => ({
        id: it.id,
        providerPrice: Number(it.providerPrice || 0),
        packages: safeInt(it.packages),
        unitsPerPackage: safeInt(it.unitsPerPackage),
        remainingPackages: safeInt(it.remainingPackages ?? it.packages),
        marginRivas: Number(it.marginRivas || 0),
        marginSanJorge: Number(it.marginSanJorge || 0),
        marginIsla: Number(it.marginIsla || 0),
        unitPriceRivas: Number(it.unitPriceRivas || 0),
        unitPriceIsla: Number(it.unitPriceIsla || 0),
      }))
      .sort((a, b) => a.id.localeCompare(b.id));

    return JSON.stringify({
      orderName: String(orderName || "").trim(),
      orderDate: String(orderDate || ""),
      marginRivas: Number(marginRivas || 0),
      marginSanJorge: Number(marginSanJorge || 0),
      marginIsla: Number(marginIsla || 0),
      logisticsCost: Number(logisticsCost || 0),
      items: normalizedItems,
    });
  };

  const parseOrderSnapshot = (snapshot: string) => {
    try {
      const parsed = JSON.parse(snapshot);
      const items = Array.isArray(parsed?.items) ? parsed.items : [];
      const itemMap = new Map<string, any>();
      items.forEach((it: any) => {
        if (!it?.id) return;
        itemMap.set(String(it.id), it);
      });
      return { ...parsed, itemMap };
    } catch {
      return { itemMap: new Map<string, any>() };
    }
  };

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
      setOrderCategory("Todas");
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
      orderCategory === "Todas" ||
      String(orderCategory || "").trim().length === 0
        ? catalog
        : catalog.filter((p) => p.category === orderCategory);
    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [catalog, orderCategory]);

  const productsForSelect = useMemo(() => {
    const q = String(productSearch || "")
      .trim()
      .toLowerCase();
    if (!q) return catalogByCategory;
    return catalogByCategory.filter(
      (p) =>
        String(p.name || "")
          .toLowerCase()
          .includes(q) ||
        String(p.id || "")
          .toLowerCase()
          .includes(q),
    );
  }, [catalogByCategory, productSearch]);

  const orderCategorySelectOptions = useMemo(() => {
    if (catalogCategories.length === 0) {
      return [
        {
          value: "",
          label: catalogLoading
            ? "Cargando..."
            : "No hay categorías en catálogo",
        },
      ];
    }
    return [
      { value: "Todas", label: "Todas" },
      ...catalogCategories.map((c) => ({ value: c, label: c })),
    ];
  }, [catalogCategories, catalogLoading]);

  const orderProductSelectOptions = useMemo(() => {
    const emptyLabel = catalogLoading
      ? "Cargando catálogo..."
      : "Selecciona producto";
    return [
      { value: "", label: emptyLabel },
      ...productsForSelect.map((p) => ({ value: p.id, label: p.name })),
    ];
  }, [productsForSelect, catalogLoading]);

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

  useEffect(() => {
    let cancelled = false;
    if (!orderProductId) {
      setOrderSalePricePkgIsla("");
      return;
    }
    const p = catalog.find((x) => x.id === orderProductId);
    if (!p) {
      setOrderSalePricePkgIsla("");
      return;
    }
    const units = Math.max(1, safeInt(p.unitsPerPackage));
    (async () => {
      try {
        const priceSnap = await getDoc(
          doc(db, "current_prices", orderProductId),
        );
        if (cancelled) return;
        if (!priceSnap.exists()) {
          setOrderSalePricePkgIsla("—");
          return;
        }
        const { isla } = pkgPricesFromCurrentPricesDoc(
          priceSnap.data() as Record<string, any>,
          units,
        );
        if (!Number.isFinite(isla) || isla <= 0) {
          setOrderSalePricePkgIsla("—");
          return;
        }
        setOrderSalePricePkgIsla(isla.toFixed(2));
      } catch {
        if (!cancelled) setOrderSalePricePkgIsla("—");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [orderProductId, catalog]);

  // Reset form
  const resetOrderForm = () => {
    setRefreshingSalePrices(false);
    setEditingOrderId(null);
    setOrderName("");
    setOrderItems([]);
    setEditingPackagesMap({});
    setEditingUnitsMap({});
    setEditingRemainingMap({});
    setEditingProviderPriceMap({});

    setOrderCategory("Todas");
    setOrderProductId("");
    setOrderProviderPrice("");
    setOrderSalePricePkgIsla("");
    setOrderPackages("0");
    setOrderUnitsPerPackage("1");

    setMarginRivas("0");
    setMarginSanJorge("0"); // legacy
    setMarginIsla("0");

    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    setOrderDate(`${yyyy}-${mm}-${dd}`);

    setLogisticsCost("0");
    // previously set vendor/investor defaults — removed

    setMobileTab("DATOS");
    setItemSearch("");
  };

  // =========================
  // Add item (nuevo o edición)
  // =========================
  const addItemToOrder = async () => {
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

    const mSJ = Number(marginSanJorge || 0); // legacy (SJ)

    setAddingItemToOrder(true);
    try {
      const priceSnap = await getDoc(
        doc(db, "current_prices", catProd.id),
      );
      if (!priceSnap.exists()) {
        setMsg(
          "Cargá primero los precios de venta en Precios ventas para este producto.",
        );
        return;
      }
      const raw = priceSnap.data() as Record<string, any>;
      const { rivas: pkgR, isla: pkgI } = pkgPricesFromCurrentPricesDoc(
        raw,
        unitsNum,
      );
      if (!(pkgR > 0 && pkgI > 0)) {
        setMsg(
          "Faltan precios Rivas e Isla válidos en Precios ventas para este producto.",
        );
        return;
      }

      const vals = calcTotalsFromFixedPackageSalePrices(
        providerPriceNum,
        packagesNum,
        mSJ,
        pkgR,
        pkgI,
      );

      const existing = orderItems.find((it) => it.id === catProd.id);

      if (existing) {
        setOrderItems((prev) =>
          prev.map((it) => {
            if (it.id !== catProd.id) return it;

            const newPackages = safeInt(it.packages || 0) + packagesNum;
            const newVals = calcTotalsFromFixedPackageSalePrices(
              providerPriceNum,
              newPackages,
              Number(it.marginSanJorge ?? mSJ),
              Number(it.unitPriceRivas || 0),
              Number(it.unitPriceIsla || 0),
            );

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

          marginRivas: vals.marginRivas,
          marginSanJorge: mSJ, // legacy
          marginIsla: vals.marginIsla,

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
    } catch (err) {
      console.error(err);
      setMsg("❌ Error leyendo precios de venta. Reintentá.");
    } finally {
      setAddingItemToOrder(false);
    }
  };

  const removeItemFromOrder = (id: string) => {
    setOrderItems((prev) => prev.filter((it) => it.id !== id));
  };

  /** Vuelve a leer Rivas/Isla desde current_prices y recalcula ítems (modal abierto). */
  const refreshSalePricesFromCurrentPrices = async (askConfirm: boolean) => {
    if (!orderItems.length) {
      setMsg(
        "No hay productos en la orden. Agregá ítems antes de actualizar precios.",
      );
      return;
    }
    if (askConfirm) {
      const ok = confirm(
        `¿Actualizar precios de venta desde Precios ventas para ${orderItems.length} producto(s)?`,
      );
      if (!ok) return;
    }

    setRefreshingSalePrices(true);
    try {
      const priceMap = await fetchCurrentPricesByProductIds(
        orderItems.map((it) => it.id),
      );
      let skipped = 0;
      setOrderItems((prev) =>
        prev.map((it) => {
          const pd = priceMap.get(it.id);
          const u = Math.max(1, safeInt(it.unitsPerPackage || 1));
          const { rivas, isla } = pkgPricesFromCurrentPricesDoc(pd, u);
          if (!(rivas > 0 && isla > 0)) {
            skipped += 1;
            return it;
          }
          const vals = calcTotalsFromFixedPackageSalePrices(
            Number(it.providerPrice || 0),
            safeInt(it.packages || 0),
            Number(it.marginSanJorge || 0),
            rivas,
            isla,
          );
          return { ...it, ...vals };
        }),
      );
      if (skipped > 0) {
        setMsg(
          `⚠️ ${skipped} producto(s) sin precios válidos en Precios ventas; no se modificaron.`,
        );
      } else {
        setMsg("✅ Precios actualizados desde Precios ventas.");
      }
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al sincronizar precios de venta.");
    } finally {
      setRefreshingSalePrices(false);
    }
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
        if (field === "providerPrice") {
          updated.providerPrice = Math.max(0, Number(value) || 0);
        }
        if (field === "remainingPackages") {
          const maxPackages = Math.max(0, safeInt(updated.packages || 0));
          const requested = safeInt(value || 0);
          updated.remainingPackages = Math.min(
            maxPackages,
            Math.max(0, requested),
          );
        }

        // San Jorge: no UI por ítem, pero preservo si llega por código
        if (field === "marginSanJorge")
          updated.marginSanJorge = Number(value || 0);

        const needsEconomicRecalc =
          field === "packages" ||
          field === "providerPrice" ||
          field === "unitsPerPackage" ||
          field === "marginSanJorge";

        if (needsEconomicRecalc) {
          const vals = calcTotalsFromFixedPackageSalePrices(
            Number(updated.providerPrice || 0),
            safeInt(updated.packages || 0),
            Number(updated.marginSanJorge || 0),
            Number(updated.unitPriceRivas || 0),
            Number(updated.unitPriceIsla || 0),
          );
          updated = { ...updated, ...vals };
        }

        // remainingPackages: si no existe, igualo a packages. Si existe (edición), NO lo rompo.
        if (
          updated.remainingPackages === undefined ||
          updated.remainingPackages === null
        ) {
          updated.remainingPackages = updated.packages;
        } else if (field === "packages") {
          const currentRemaining = safeInt(updated.remainingPackages);
          updated.remainingPackages = Math.min(
            currentRemaining,
            Math.max(0, updated.packages),
          );
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

    // Sheet Productos: id + nombre + paquetes; precios y márgenes vienen de current_prices al importar
    const rows = catalog
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name, "es"))
      .map((p) => ({
        "Producto id": p.id,
        Producto: p.name,
        Paquetes: "",
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
        "Producto id": it.id,
        Categoría: it.category,
        Producto: it.name,
        Paquetes: safeInt(it.packages),
        "Paquetes restantes": safeInt(it.remainingPackages ?? it.packages),
        "Und x Paquete": safeInt(it.unitsPerPackage),
        "Precio proveedor": Number(it.providerPrice || 0),
        Facturado: Number(it.subtotal || 0),
        "Precio Rivas": Number(it.unitPriceRivas || 0),
        "Precio Isla": Number(it.unitPriceIsla || 0),
        "Esperado Rivas": Number(it.totalRivas || 0),
        "Esperado Isla": Number(it.totalIsla || 0),
        "MV Rivas": Number(it.marginRivas || 0),
        "MV Isla": Number(it.marginIsla || 0),
        "Utilidad Bruta": Number(it.grossProfit || 0),
        "Utilidad Bruta Isla": Number(it.grossProfitIsla || 0),
        "Prorrateo logistico": Number(it.logisticAllocated || 0),
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

      // index por nombre e id (catálogo)
      const catalogByName = new Map<string, CatalogCandyProduct>();
      const catalogById = new Map<string, CatalogCandyProduct>();
      for (const p of catalog) {
        catalogByName.set(norm(p.name), p);
        catalogById.set(String(p.id || "").trim(), p);
      }

      const errors: string[] = [];

      // Acumular por productId (precios Rivas/Isla vienen de current_prices)
      const incomingById = new Map<string, { packages: number }>();

      for (let i = 0; i < rows.length; i++) {
        const r = rows[i];

        const productIdCell = getRowValue(r, [
          "Producto id",
          "Producto ID",
          "productId",
          "Product ID",
          "ID producto",
        ]);
        const pidRaw =
          productIdCell != null ? String(productIdCell).trim() : "";

        const productName = getRowValue(r, [
          "Producto",
          "Product",
          "Nombre",
          "Name",
        ]);
        const packagesVal = getRowValue(r, ["Paquetes", "Packages"]);

        let catProd: CatalogCandyProduct | undefined;
        if (pidRaw) {
          catProd = catalogById.get(pidRaw);
          if (!catProd) {
            errors.push(
              `Fila ${i + 2}: Producto id no está en catálogo: "${pidRaw}".`,
            );
            continue;
          }
        } else {
          const prodKey = norm(productName);
          if (!prodKey) continue;

          catProd = catalogByName.get(prodKey);
          if (!catProd) {
            errors.push(
              `Fila ${i + 2}: Producto no existe en catálogo: "${String(productName).trim()}".`,
            );
            continue;
          }
        }

        const packagesNum = Math.floor(num(packagesVal));
        if (packagesNum <= 0) {
          errors.push(
            `Fila ${i + 2}: "Paquetes" inválido para "${catProd.name}".`,
          );
          continue;
        }

        const prev = incomingById.get(catProd.id);
        if (prev) {
          incomingById.set(catProd.id, {
            packages: prev.packages + packagesNum,
          });
        } else {
          incomingById.set(catProd.id, {
            packages: packagesNum,
          });
        }
      }

      const priceMap = await fetchCurrentPricesByProductIds([
        ...incomingById.keys(),
      ]);

      const newItems: CandyOrderItem[] = [];

      incomingById.forEach((x, productId) => {
        const catProd = catalog.find((p) => p.id === productId);
        if (!catProd) return;

        const providerPriceNum = Number(catProd.providerPrice || 0);
        const unitsNum = Math.max(1, safeInt(catProd.unitsPerPackage || 1));
        const packagesNum = Math.max(1, safeInt(x.packages));

        const mSJ = Number(marginSanJorge || 0);
        const pDoc = priceMap.get(productId);
        const { rivas: pkgR, isla: pkgI } = pkgPricesFromCurrentPricesDoc(
          pDoc,
          unitsNum,
        );

        if (!(pkgR > 0 && pkgI > 0)) {
          errors.push(
            `Producto "${catProd.name}": sin precios Rivas/Isla en Precios ventas (current_prices).`,
          );
          return;
        }

        const vals = calcTotalsFromFixedPackageSalePrices(
          providerPriceNum,
          packagesNum,
          mSJ,
          pkgR,
          pkgI,
        );

        newItems.push({
          id: catProd.id,
          name: catProd.name,
          category: catProd.category,
          providerPrice: providerPriceNum,
          packages: packagesNum,
          unitsPerPackage: unitsNum,
          marginRivas: vals.marginRivas,
          marginSanJorge: mSJ,
          marginIsla: vals.marginIsla,

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

            const vals = calcTotalsFromFixedPackageSalePrices(
              existing.providerPrice,
              mergedPackages,
              Number(existing.marginSanJorge || 0),
              Number(existing.unitPriceRivas || 0),
              Number(existing.unitPriceIsla || 0),
            );

            map.set(it.id, {
              ...existing,
              packages: mergedPackages,
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

  const openMasterOrderDrawer = async (o: CandyOrderSummaryRow) => {
    setMasterDrawerOpen(true);
    setMasterDrawerOrder(o);
    setMasterDrawerItems([]);
    setMasterDrawerUBrutaGlobal(null);
    setMasterDrawerLoading(true);
    try {
      const orderSnap = await getDoc(doc(db, "candy_main_orders", o.id));
      if (!orderSnap.exists()) {
        setMsg("❌ No se encontró la orden.");
        setMasterDrawerOpen(false);
        return;
      }
      const orderData = orderSnap.data() as any;
      setMasterDrawerUBrutaGlobal(
        Number.isFinite(Number(orderData.uBrutaGlobal))
          ? Number(orderData.uBrutaGlobal)
          : null,
      );

      const itemsFromDoc: CandyOrderItem[] = Array.isArray(orderData.items)
        ? (orderData.items as CandyOrderItem[])
        : [];

      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", o.id),
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

      const itemsForUi = itemsFromDoc.map((it) => {
        const cat = catalog.find((c) => c.id === it.id);
        return {
          ...it,
          name: String(cat?.name ?? it.name ?? "").trim(),
          category: String(cat?.category ?? it.category ?? "Caramelo").trim(),
          remainingPackages:
            remainingByProduct[it.id] ??
            it.remainingPackages ??
            it.packages ??
            0,
        };
      });
      setMasterDrawerItems(itemsForUi);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al cargar el detalle de la orden.");
    } finally {
      setMasterDrawerLoading(false);
    }
  };

  // =========================
  // Guardar pedido (crea / edita)
  // =========================
  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    setSavingOrder(true);

    const nameTrim = String(orderName || "").trim();
    if (!nameTrim) {
      setMsg("Ingresá el nombre de la orden.");
      setSavingOrder(false);
      return;
    }
    if (!String(orderDate || "").trim()) {
      setMsg("Ingresá la fecha del pedido.");
      setSavingOrder(false);
      return;
    }

    if (!orderItems.length) {
      setMsg("Agrega al menos un producto a la orden.");
      setSavingOrder(false);
      return;
    }

    try {
      const dateStr = String(orderDate || "").trim();

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

      let editedItemsSummary: Array<{ name: string; fields: string[] }> = [];
      if (editingOrderId) {
        const currentSnapshot = serializeOrderState(orderItems);
        if (currentSnapshot === originalOrderSnapshotRef.current) {
          setMsg("ℹ️ No hay cambios para guardar.");
          setSavingOrder(false);
          return;
        }

        const prevSnap = parseOrderSnapshot(originalOrderSnapshotRef.current);
        const currSnap = parseOrderSnapshot(currentSnapshot);

        const fieldLabelMap: Record<string, string> = {
          providerPrice: "Precio prov",
          packages: "Paquetes",
          unitsPerPackage: "Und x Paq",
          remainingPackages: "Restantes",
          marginRivas: "MV Rivas",
          marginSanJorge: "MV SJ",
          marginIsla: "MV Isla",
          unitPriceRivas: "Precio Rivas",
          unitPriceIsla: "Precio Isla",
        };

        const detectItemChanges = (id: string) => {
          const prevItem = prevSnap.itemMap.get(id) || {};
          const currItem = currSnap.itemMap.get(id) || {};
          const fields = Object.keys(fieldLabelMap).filter(
            (key) => Number(prevItem[key] || 0) !== Number(currItem[key] || 0),
          );
          return fields.map((f) => fieldLabelMap[f]);
        };

        editedItemsSummary = orderItems
          .map((it) => ({
            name: String(it.name || it.id),
            fields: detectItemChanges(String(it.id)),
          }))
          .filter((x) => x.fields.length > 0);
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
        name: nameTrim,
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
        uBrutaGlobal: computed.grossTotal,

        items: itemsToSave,
      };

      if (editingOrderId) {
        const clampVendorPercent = (v: any) =>
          Math.min(Math.max(Number(v) || 0, 0), MAX_MARGIN_PERCENT);
        const pickVendorPricePerPack = (data: any) => {
          const direct = Number(data?.pricePerPackage || 0);
          if (direct > 0) return direct;
          const branch = String(data?.branch || "");
          if (branch === "RIVAS") return Number(data?.unitPriceRivas || 0);
          if (branch === "SAN_JORGE")
            return Number(data?.unitPriceSanJorge || 0);
          return Number(data?.unitPriceIsla || 0);
        };
        const updateVendorOrdersFromMaster = async (
          orderId: string,
          items: CandyOrderItem[],
        ) => {
          let batch = writeBatch(db);
          let pending = 0;
          let updated = 0;

          for (const it of items) {
            const vendSnap = await getDocs(
              query(
                collection(db, "inventory_candies_sellers"),
                where("productId", "==", it.id),
              ),
            );

            for (const d of vendSnap.docs) {
              const v = d.data() as any;
              const allocs = Array.isArray(v.masterAllocations)
                ? v.masterAllocations
                : [];
              const fromAlloc = allocs.some(
                (a: any) =>
                  String(a?.masterOrderId || a?.orderId || "") === orderId,
              );
              const fromOrderId = String(v.orderId || "") === orderId;
              if (!fromAlloc && !fromOrderId) continue;

              const packs = safeInt(v.packages || 0);
              const pricePerPackage = pickVendorPricePerPack(v);
              const providerPrice = Number(it.providerPrice || 0);
              const grossPerPack = pricePerPackage - providerPrice;
              const grossProfit = grossPerPack * packs;

              const vendorMarginPercent = clampVendorPercent(
                v.vendorMarginPercent,
              );
              const uVendor =
                Number(grossProfit || 0) * (vendorMarginPercent / 100);
              const uInvestor = Number(grossProfit || 0) - Number(uVendor || 0);

              const logisticAllocated = Number(
                v.logisticAllocated ?? v.gastos ?? 0,
              );
              const uNeta =
                Number(grossProfit || 0) -
                Number(logisticAllocated || 0) -
                Number(uVendor || 0);

              const upaquete =
                packs > 0 ? round2(Number(grossProfit || 0) / packs) : 0;
              const uvXpaq =
                packs > 0 ? round2(Number(uVendor || 0) / packs) : 0;

              batch.update(doc(db, "inventory_candies_sellers", d.id), {
                providerPrice,
                grossProfit,
                uVendor,
                uInvestor,
                uNeta,
                vendorProfit: uVendor,
                upaquete,
                uvXpaq,
                updatedAt: Timestamp.now(),
              });

              pending += 1;
              updated += 1;
              if (pending >= 400) {
                await batch.commit();
                batch = writeBatch(db);
                pending = 0;
              }
            }
          }

          if (pending > 0) await batch.commit();
          return updated;
        };

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
          const manualRemainingPackages = Math.min(
            safeInt(it.remainingPackages ?? it.packages),
            safeInt(it.packages),
          );
          const manualRemainingUnits = Math.max(
            0,
            manualRemainingPackages * unitsPerPackageLocal,
          );

          if (invSnap.empty) {
            // si es nuevo producto agregado en edición -> se crea inventario
            await addDoc(collection(db, "inventory_candies"), {
              productId: it.id,
              productName: it.name,
              category: it.category,
              measurement: "unidad",

              quantity: totalUnitsNew,
              remaining: manualRemainingUnits,

              packages: safeInt(it.packages),
              remainingPackages: manualRemainingPackages,

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
              await updateDoc(doc(db, "inventory_candies", invDoc.id), {
                productName: it.name,
                category: it.category,

                unitsPerPackage: unitsPerPackageLocal,
                totalUnits: totalUnitsNew,
                quantity: totalUnitsNew,

                remaining: manualRemainingUnits,
                packages: safeInt(it.packages),
                remainingPackages: manualRemainingPackages,

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

        const vendorUpdated = await updateVendorOrdersFromMaster(
          editingOrderId,
          itemsToSave,
        );

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

        if (editedItemsSummary.length > 0) {
          const details = editedItemsSummary
            .slice(0, 6)
            .map((x) => `${x.name}: ${x.fields.join(", ")}`)
            .join(" | ");
          const extra =
            editedItemsSummary.length > 6
              ? ` (+${editedItemsSummary.length - 6} más)`
              : "";
          setMsg(
            `✅ Orden maestra actualizada (pedido + inventario). ` +
              `Items: ${itemsToSave.length}.` +
              (vendorUpdated
                ? ` Vendedor: ${vendorUpdated} filas actualizadas.`
                : "") +
              `\nEditados: ${details}${extra}`,
          );

          await addDoc(collection(db, "candy_main_orders_logs"), {
            orderId: editingOrderId,
            orderName: header.name,
            orderDate: header.date,
            changes: editedItemsSummary,
            updatedAt: Timestamp.now(),
            type: "update_items",
          });
        } else {
          setMsg(
            `✅ Orden maestra actualizada (pedido + inventario). ` +
              `Items: ${itemsToSave.length}.` +
              (vendorUpdated
                ? ` Vendedor: ${vendorUpdated} filas actualizadas.`
                : ""),
          );
        }
        originalOrderSnapshotRef.current = serializeOrderState(orderItems);
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
        const manualRemainingPackages = Math.min(
          safeInt(it.remainingPackages ?? it.packages),
          safeInt(it.packages),
        );
        const manualRemainingUnits = Math.max(
          0,
          manualRemainingPackages * unitsPerPackageLocal,
        );

        const invRef = doc(collection(db, "inventory_candies"));
        batch.set(invRef, {
          productId: it.id,
          productName: it.name,
          category: it.category,
          measurement: "unidad",

          quantity: totalUnits,
          remaining: manualRemainingUnits,

          packages: safeInt(it.packages),
          remainingPackages: manualRemainingPackages,

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

      setMsg(
        `✅ Orden maestra creada y registrada en inventario. Items: ${itemsToSave.length}.`,
      );
      originalOrderSnapshotRef.current = "";
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

      const priceMap = await fetchCurrentPricesByProductIds(
        itemsFromDoc.map((it) => it.id),
      );

      let priceFallbackUsed = false;

      // normalizar contra catálogo + recalcular desde precios de venta (current_prices)
      const normalized = itemsFromDoc.map((it) => {
        const cat = catalog.find((c) => c.id === it.id);

        const providerPrice = Number(
          it.providerPrice ?? cat?.providerPrice ?? 0,
        );
        const unitsPerPackage = Math.max(
          1,
          safeInt(it.unitsPerPackage ?? cat?.unitsPerPackage ?? 1),
        );

        const mSJ = Number(it.marginSanJorge ?? Number(marginSanJorge || 0)); // legacy

        const pDoc = priceMap.get(it.id);
        let { rivas: pkgR, isla: pkgI } = pkgPricesFromCurrentPricesDoc(
          pDoc,
          unitsPerPackage,
        );

        if (!(pkgR > 0 && pkgI > 0)) {
          pkgR = Number(it.unitPriceRivas || 0);
          pkgI = Number(it.unitPriceIsla || 0);
          priceFallbackUsed = true;
        }

        const vals = calcTotalsFromFixedPackageSalePrices(
          providerPrice,
          safeInt(it.packages || 0),
          mSJ,
          pkgR,
          pkgI,
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

      if (priceFallbackUsed) {
        setMsg(
          "⚠️ Algunos ítems usaron precios guardados en la orden (faltaban datos en Precios ventas).",
        );
      }

      setOrderItems(normalized);
      originalOrderSnapshotRef.current = serializeOrderState(normalized);
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

  // =========================
  // BACKFILL PRORRATEO LOGÍSTICO (ORDEN MAESTRA)
  // =========================
  const backfillMainOrdersLogistics = async () => {
    if (isBackfillingMain) return;

    try {
      setIsBackfillingMain(true);
      setMsg("");

      const snap = await getDocs(collection(db, "candy_main_orders"));

      let batch = writeBatch(db);
      let pending = 0;
      let updated = 0;

      const diff = (a: any, b: any) =>
        Math.abs(Number(a || 0) - Number(b || 0)) > 0.01;

      snap.forEach((d) => {
        const data = d.data() as any;
        const items: CandyOrderItem[] = Array.isArray(data.items)
          ? (data.items as CandyOrderItem[])
          : [];
        if (!items.length) return;

        const subtotalTotal = items.reduce(
          (acc, it) => acc + Number(it.subtotal || 0),
          0,
        );

        let logisticsTotal = Number(
          data.logisticsCost ?? data.gastosLogisticos ?? data.gastos ?? 0,
        );
        if (!Number.isFinite(logisticsTotal)) logisticsTotal = 0;

        if (!logisticsTotal) {
          const existingSum = items.reduce(
            (acc, it) => acc + Number(it.logisticAllocated ?? 0),
            0,
          );
          logisticsTotal = Number(existingSum || 0);
        }

        const itemsUpdated = items.map((it) =>
          applyProfitSplitAndLogistics(it, logisticsTotal, subtotalTotal),
        );
        const uBrutaGlobal = itemsUpdated.reduce(
          (acc, it) => acc + Number(it.grossProfit || 0),
          0,
        );

        const needsUpdate =
          diff(data.logisticsCost, logisticsTotal) ||
          diff(data.uBrutaGlobal, uBrutaGlobal) ||
          itemsUpdated.some((it, idx) => {
            const prev = items[idx] || ({} as CandyOrderItem);
            return (
              diff(prev.logisticAllocated, it.logisticAllocated) ||
              diff(prev.grossProfit, it.grossProfit) ||
              diff(prev.grossProfitIsla, it.grossProfitIsla)
            );
          });

        if (!needsUpdate) return;

        const ref = doc(db, "candy_main_orders", d.id);
        batch.update(ref, {
          logisticsCost: logisticsTotal,
          uBrutaGlobal,
          items: itemsUpdated,
          updatedAt: Timestamp.now(),
        });

        pending += 1;
        updated += 1;

        if (pending >= 400) {
          batch.commit();
          batch = writeBatch(db);
          pending = 0;
        }
      });

      if (pending > 0) await batch.commit();

      setMsg(`✅ Ordenes maestras actualizadas: ${updated}`);
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error actualizando prorrateo de órdenes maestras.");
    } finally {
      setIsBackfillingMain(false);
    }
  };

  const backfillInventoryForCurrentOrder = async () => {
    if (!editingOrderId) return;
    if (backfillingInventory) return;

    try {
      setBackfillingInventory(true);
      setMsg("");

      const result = await backfillCandyInventoryFromMainOrder(editingOrderId);

      if (result.created > 0 || result.updated > 0) {
        setMsg(
          `✅ Inventario listo: ${result.created} creados, ${result.updated} reparados (de ${result.totalItems}).`,
        );
      } else if (result.totalItems > 0) {
        setMsg("ℹ️ No había inventario faltante para crear o reparar.");
      } else {
        setMsg("ℹ️ La orden no tiene items para crear inventario.");
      }

      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error creando inventario faltante.");
    } finally {
      setBackfillingInventory(false);
    }
  };

  return (
    <div className="p-3 md:p-6">
      {/* Header / acciones */}
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
        {/* <div className="flex-1">
          <h2 className="text-lg md:text-2xl font-semibold">
            Ordenes Maestras
          </h2>
          <p className="text-xs md:text-sm text-gray-600">
            Listado de pedidos de compra con costos, totales y gastos
            prorrateados.
          </p>
        </div> */}

      </div>

      {msg && <Toast message={msg} onClose={() => setMsg("")} />}

      {/* MODAL ORDEN MAESTRA */}
      {openOrderModal && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-2 md:p-6 bg-slate-900/50 backdrop-blur-[3px]"
          role="presentation"
        >
          <div
            className="relative flex flex-col w-[98vw] max-w-[min(100vw-1rem,1280px)] max-h-[96vh] overflow-hidden rounded-2xl border border-slate-200/80 bg-white text-sm shadow-2xl shadow-slate-900/12 ring-1 ring-slate-900/[0.04]"
            role="dialog"
            aria-modal="true"
            aria-labelledby="orden-maestra-modal-title"
          >
            {savingOrder && (
              <div className="absolute inset-0 z-[60] flex items-center justify-center rounded-2xl bg-white/75 backdrop-blur-sm">
                <div className="flex items-center gap-3 rounded-xl border border-slate-200/80 bg-white px-5 py-3.5 shadow-lg">
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
                  <div className="text-sm font-semibold text-slate-800">
                    Guardando orden…
                  </div>
                </div>
              </div>
            )}

            {/* Header sticky */}
            <div className="sticky top-0 z-20 shrink-0 border-b border-slate-200/90 bg-gradient-to-b from-slate-50 to-white px-3 pt-3 pb-3 sm:px-5 sm:pt-4 sm:pb-4 md:px-6">
              <div className="flex items-start gap-3">
                <div className="mt-0.5 hidden h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-indigo-600/10 text-indigo-700 sm:flex">
                  <svg
                    className="h-5 w-5"
                    fill="none"
                    viewBox="0 0 24 24"
                    stroke="currentColor"
                    strokeWidth={1.75}
                    aria-hidden
                  >
                    <path
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664v.75h.75M9 19h2.25m2.25 0h2.25m-2.25 0v-.75c0-.414.336-.75.75-.75h2.25m-2.25 0h2.25m-2.25 0v-.75c0-.414.336-.75.75-.75H15"
                    />
                  </svg>
                </div>
                <h3
                  id="orden-maestra-modal-title"
                  className="min-w-0 flex-1 text-base font-bold leading-snug tracking-tight text-slate-900 md:text-xl"
                >
                  {editingOrderId
                    ? "Editar Orden Maestra"
                    : "Nueva Orden Maestra"}
                </h3>

                <ActionMenuTrigger
                  className="shrink-0 !h-10 !w-10 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                  aria-label="Acciones de la orden"
                  title="Actualizar precios, inventario, cerrar"
                  iconClassName="h-[22px] w-[22px] text-slate-700"
                  onClick={(e) =>
                    setMasterModalHeaderMenu({
                      rect: (
                        e.currentTarget as HTMLElement
                      ).getBoundingClientRect(),
                    })
                  }
                />
              </div>

              {/* Config rápida (logística + % utilidades) */}
              <div className="mt-4 grid grid-cols-1 gap-2">
                <div className="rounded-xl border border-slate-200/80 bg-white/80 p-3 shadow-sm">
                  <label className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Gastos logísticos (orden)
                  </label>
                  <input
                    type="number"
                    className="mt-1.5 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums shadow-sm outline-none transition focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                    value={logisticsCost}
                    onChange={(e) => setLogisticsCost(e.target.value)}
                    placeholder="0"
                    min={0}
                  />
                </div>
              </div>

              {/* Tabs (solo móvil) */}
              <div className="md:hidden mt-4">
                <p className="mb-2 text-[11px] font-medium uppercase tracking-wide text-slate-500">
                  Secciones
                </p>
                <div className="grid grid-cols-4 gap-1 rounded-xl border border-slate-200/70 bg-slate-100/90 p-1">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMobileTab("DATOS")}
                    className={`!rounded-lg px-1.5 py-2.5 text-[11px] font-semibold leading-tight shadow-none transition-all ${
                      mobileTab === "DATOS"
                        ? "!border-transparent !bg-white !text-slate-900 shadow-sm"
                        : "!border-transparent !bg-transparent !text-slate-600 hover:!bg-white/70"
                    }`}
                  >
                    Datos
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMobileTab("AGREGAR")}
                    className={`!rounded-lg px-1.5 py-2.5 text-[11px] font-semibold leading-tight shadow-none transition-all ${
                      mobileTab === "AGREGAR"
                        ? "!border-transparent !bg-white !text-slate-900 shadow-sm"
                        : "!border-transparent !bg-transparent !text-slate-600 hover:!bg-white/70"
                    }`}
                  >
                    Agregar
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMobileTab("ITEMS")}
                    className={`!rounded-lg px-1.5 py-2.5 text-[11px] font-semibold leading-tight shadow-none transition-all ${
                      mobileTab === "ITEMS"
                        ? "!border-transparent !bg-white !text-slate-900 shadow-sm"
                        : "!border-transparent !bg-transparent !text-slate-600 hover:!bg-white/70"
                    }`}
                  >
                    Items ({orderItems.length})
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setMobileTab("TOTALES")}
                    className={`!rounded-lg px-1.5 py-2.5 text-[11px] font-semibold leading-tight shadow-none transition-all ${
                      mobileTab === "TOTALES"
                        ? "!border-transparent !bg-white !text-slate-900 shadow-sm"
                        : "!border-transparent !bg-transparent !text-slate-600 hover:!bg-white/70"
                    }`}
                  >
                    Totales
                  </Button>
                </div>
              </div>

              {msg && (
                <div
                  className="mt-3 rounded-lg border border-amber-200/90 bg-amber-50/95 p-3 text-sm text-amber-950 shadow-sm"
                  role="status"
                >
                  {msg}
                </div>
              )}
            </div>

            <form
              ref={orderFormRef}
              onSubmit={handleSaveOrder}
              className="flex min-h-0 flex-1 flex-col overflow-hidden px-3 sm:px-5 md:px-6"
            >
              <div className="flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain space-y-5 py-3 pb-4">
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
                <div className="rounded-xl border border-slate-200/80 bg-slate-50/40 p-4 shadow-sm">
                  <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Datos generales
                  </h4>
                  <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
                  <div className="md:col-span-2">
                    <label className="block text-[13px] font-semibold text-slate-700 md:text-sm">
                      Nombre de Orden
                    </label>
                    <input
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-[13px] leading-snug shadow-sm outline-none transition placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 md:text-sm md:leading-normal"
                      value={orderName}
                      onChange={(e) => setOrderName(e.target.value)}
                      placeholder="Ej: Pedido enero 19"
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold text-slate-700">
                      Fecha del pedido
                    </label>
                    <input
                      type="date"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                      value={orderDate}
                      onChange={(e) => setOrderDate(e.target.value)}
                    />
                  </div>

                  {/* <div>
                    <label className="block text-sm font-semibold text-slate-700">
                      % Ganancia Rivas
                    </label>
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                      value={marginRivas}
                      onChange={(e) => setMarginRivas(e.target.value)}
                    />
                  </div> */}

                  {/* San Jorge legacy: lo mantenemos oculto en UI */}
                  <input type="hidden" value={marginSanJorge} readOnly />

                  <div>
                    <label className="block text-sm font-semibold text-slate-700">
                      % Ganancia Isla Ometepe
                    </label>
                    <input
                      type="number"
                      className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                      value={marginIsla}
                      onChange={(e) => setMarginIsla(e.target.value)}
                    />
                  </div>
                </div>
                </div>
              </div>

              {/* ===== AGREGAR ===== */}
              <div
                className={`${mobileTab === "AGREGAR" ? "block" : "hidden"} md:block`}
              >
                <div className="rounded-xl border border-slate-200/80 bg-gradient-to-b from-white to-slate-50/90 p-4 shadow-sm">
                  <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Agregar producto a la orden
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <MobileHtmlSelect
                        label="Categoría (dinámica)"
                        value={
                          catalogCategories.length === 0 ? "" : orderCategory
                        }
                        onChange={(v) => {
                          setOrderCategory(v || "Todas");
                          setOrderProductId("");
                        }}
                        disabled={catalogLoading}
                        options={orderCategorySelectOptions}
                        sheetTitle="Categoría"
                        selectClassName="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                        buttonClassName="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm shadow-sm hover:border-slate-300"
                      />
                    </div>

                    <div className="md:col-span-2 space-y-2">
                      <div>
                        <label className="block text-sm font-semibold text-slate-700">
                          Buscar producto
                        </label>
                        <input
                          className="mb-2 mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                          placeholder="Buscar producto..."
                          value={productSearch}
                          onChange={(e) => setProductSearch(e.target.value)}
                        />
                      </div>

                      <MobileHtmlSelect
                        label="Producto (catálogo)"
                        value={orderProductId}
                        onChange={setOrderProductId}
                        disabled={catalogLoading}
                        options={orderProductSelectOptions}
                        sheetTitle="Producto"
                        selectClassName="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                        buttonClassName="flex w-full items-center justify-between gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left text-sm shadow-sm hover:border-slate-300"
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-slate-700">
                        Precio proveedor (paq)
                      </label>
                      <input
                        type="number"
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm tabular-nums text-slate-600"
                        value={orderProviderPrice}
                        readOnly
                      />
                      <label className="mt-2 block text-sm font-semibold text-slate-700">
                        Precio venta Isla (paq)
                      </label>
                      <input
                        type="text"
                        readOnly
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm tabular-nums text-slate-600"
                        value={orderSalePricePkgIsla || "—"}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-slate-700">
                        Paquetes
                      </label>
                      <input
                        type="number"
                        min={0}
                        className="mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm tabular-nums shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20"
                        value={orderPackages}
                        onChange={(e) => setOrderPackages(e.target.value)}
                      />
                    </div>

                    <div>
                      <label className="block text-sm font-semibold text-slate-700">
                        Unidades por paquete
                      </label>
                      <input
                        type="number"
                        className="mt-1 w-full cursor-not-allowed rounded-lg border border-slate-200 bg-slate-100 px-3 py-2 text-sm tabular-nums text-slate-600"
                        value={orderUnitsPerPackage}
                        readOnly
                      />
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col gap-2 md:flex-row md:items-center md:justify-end">
                    <Button
                      type="button"
                      variant="primary"
                      size="sm"
                      onClick={() => void addItemToOrder()}
                      disabled={addingItemToOrder}
                      className="!rounded-lg px-4 shadow-sm disabled:opacity-60"
                    >
                      {addingItemToOrder ? "Cargando…" : "Agregar producto"}
                    </Button>
                  </div>
                </div>
              </div>

              {/* Plantilla / import / export — menú ⋮ (móvil y web) */}
              <div className="flex items-center justify-between gap-3 rounded-xl border border-dashed border-slate-200/90 bg-slate-50/60 px-3 py-2.5">
                <span className="text-xs text-slate-600">
                  Excel: plantilla, importar o exportar
                </span>
                <ActionMenuTrigger
                  className="!h-10 !w-10 shrink-0 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                  aria-label="Plantilla, importar y exportar Excel"
                  title="Descargar plantilla, importar o exportar"
                  iconClassName="h-[22px] w-[22px] text-slate-700"
                  onClick={(e) =>
                    setMasterModalExcelMenu({
                      rect: (
                        e.currentTarget as HTMLElement
                      ).getBoundingClientRect(),
                    })
                  }
                />
              </div>

              {/* ===== ITEMS ===== */}
              <div
                className={`${mobileTab === "ITEMS" ? "block" : "hidden"} md:block`}
              >
                <div className="mt-1">
                  <h4 className="mb-3 text-[11px] font-semibold uppercase tracking-wide text-slate-500 md:hidden">
                    Líneas de la orden
                  </h4>
                  <div className="mb-3 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                    <div className="text-xs text-slate-600">
                      Items:{" "}
                      <span className="font-semibold text-slate-900">
                        {orderItems.length}
                      </span>
                      {itemSearch.trim() ? (
                        <>
                          {" "}
                          · Mostrando{" "}
                          <span className="font-semibold text-slate-900">
                            {filteredItems.length}
                          </span>
                        </>
                      ) : null}
                    </div>

                    <div className="flex w-full items-center gap-2 md:w-auto">
                      <input
                        value={itemSearch}
                        onChange={(e) => setItemSearch(e.target.value)}
                        placeholder="Buscar producto o categoría…"
                        className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm shadow-sm outline-none focus:border-indigo-500 focus:ring-2 focus:ring-indigo-500/20 md:w-80"
                      />

                      {/* Margen global deshabilitado: MV se recalcula desde precios de venta (current_prices)
                      <input
                        type="number"
                        placeholder="Margen %"
                        className="w-24 border rounded px-2 py-2 text-sm"
                        min={0}
                      />
                      */}

                      <Button
                        type="button"
                        variant="primary"
                        size="sm"
                        className="!rounded-lg !bg-emerald-600 shadow-sm hover:!bg-emerald-700 active:!bg-emerald-800 disabled:opacity-60"
                        disabled={refreshingSalePrices || !orderItems.length}
                        onClick={() =>
                          void refreshSalePricesFromCurrentPrices(true)
                        }
                      >
                        Aplicar
                      </Button>
                    </div>
                  </div>

                  {/* Desktop: Tabla */}
                  <div className="hidden md:block">
                    <div className="overflow-x-auto rounded-xl border border-slate-200/80 bg-white pb-1 shadow-sm">
                      <table className="min-w-[1150px] w-full text-xs">
                        <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100/95 backdrop-blur-sm">
                          <tr>
                            <th className="p-2 text-left font-semibold text-slate-700">
                              Categoría
                            </th>
                            <th className="p-2 text-left font-semibold text-slate-700">
                              Producto
                            </th>
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Paquetes
                            </th>
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Restantes
                            </th>
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Unidades
                            </th>
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Precio Proveedor
                            </th>

                            <th className="p-2 text-right font-semibold text-slate-700">
                              Facturado
                            </th>

                            {/* Columnas Rivas ocultas en UI (Precio / Esperado / MV / U. bruta) */}
                            {/* <th className="p-2 text-right font-semibold text-slate-700">
                              Precio Rivas
                            </th> */}
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Venta
                            </th>

                            {/* <th className="p-2 text-right font-semibold text-slate-700">
                              Esperado Rivas
                            </th> */}
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Esperado
                            </th>

                            {/* <th className="p-2 text-right font-semibold text-slate-700">
                              MV Rivas
                            </th> */}
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Margen
                            </th>

                            {/* <th className="p-2 text-right font-semibold text-slate-700">
                              U. Bruta Rivas
                            </th> */}
                            <th className="p-2 text-right font-semibold text-slate-700">
                              U. Bruta
                            </th>
                            <th className="p-2 text-right font-semibold text-slate-700">
                              Prorrateo
                            </th>

                            <th className="p-2 text-center font-semibold text-slate-700">
                              Opcion
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {pagedFilteredItems.map((it) => (
                            <tr
                              key={it.id}
                              className="border-t border-slate-100 transition-colors hover:bg-slate-50/80"
                            >
                              <td className="p-2 text-slate-600">{it.category}</td>
                              <td className="p-2 font-semibold text-slate-900">
                                {it.name}
                              </td>

                              <td className="p-2 text-right">
                                {editingPackagesMap[it.id] ? (
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
                                    onBlur={() => closePackagesEdit(it.id)}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" ||
                                        e.key === "Escape"
                                      ) {
                                        closePackagesEdit(it.id);
                                      }
                                    }}
                                    inputMode="numeric"
                                    autoFocus
                                  />
                                ) : (
                                  <div className="flex items-center justify-end gap-2">
                                    <span>{it.packages}</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                      onClick={() => openPackagesEdit(it.id)}
                                      aria-label="Editar paquetes"
                                    >
                                      ✏️
                                    </Button>
                                  </div>
                                )}
                              </td>

                              <td className="p-2 text-right">
                                {editingRemainingMap[it.id] ? (
                                  <input
                                    type="number"
                                    className="w-20 border rounded p-1 text-right"
                                    value={safeInt(
                                      it.remainingPackages ?? it.packages,
                                    )}
                                    onChange={(e) =>
                                      handleItemFieldChange(
                                        it.id,
                                        "remainingPackages",
                                        e.target.value,
                                      )
                                    }
                                    onBlur={() => closeRemainingEdit(it.id)}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" ||
                                        e.key === "Escape"
                                      ) {
                                        closeRemainingEdit(it.id);
                                      }
                                    }}
                                    inputMode="numeric"
                                    autoFocus
                                  />
                                ) : (
                                  <div className="flex items-center justify-end gap-2">
                                    <span>
                                      {safeInt(
                                        it.remainingPackages ?? it.packages,
                                      )}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                      onClick={() => openRemainingEdit(it.id)}
                                      aria-label="Editar paquetes restantes"
                                    >
                                      ✏️
                                    </Button>
                                  </div>
                                )}
                              </td>

                              <td className="p-2 text-right">
                                {editingUnitsMap[it.id] ? (
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
                                    onBlur={() => closeUnitsEdit(it.id)}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" ||
                                        e.key === "Escape"
                                      ) {
                                        closeUnitsEdit(it.id);
                                      }
                                    }}
                                    inputMode="numeric"
                                    autoFocus
                                  />
                                ) : (
                                  <div className="flex items-center justify-end gap-2">
                                    <span>{it.unitsPerPackage}</span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                      onClick={() => openUnitsEdit(it.id)}
                                      aria-label="Editar unidades por paquete"
                                    >
                                      ✏️
                                    </Button>
                                  </div>
                                )}
                              </td>

                              <td className="p-2 text-right">
                                {editingProviderPriceMap[it.id] ? (
                                  <input
                                    type="number"
                                    className="w-20 border rounded p-1 text-right"
                                    value={Number(it.providerPrice || 0)}
                                    onChange={(e) =>
                                      handleItemFieldChange(
                                        it.id,
                                        "providerPrice",
                                        e.target.value,
                                      )
                                    }
                                    onBlur={() => closeProviderPriceEdit(it.id)}
                                    onKeyDown={(e) => {
                                      if (
                                        e.key === "Enter" ||
                                        e.key === "Escape"
                                      ) {
                                        closeProviderPriceEdit(it.id);
                                      }
                                    }}
                                    inputMode="decimal"
                                    autoFocus
                                  />
                                ) : (
                                  <div className="flex items-center justify-end gap-2">
                                    <span>
                                      {Number(it.providerPrice || 0).toFixed(2)}
                                    </span>
                                    <Button
                                      type="button"
                                      variant="ghost"
                                      className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                      onClick={() =>
                                        openProviderPriceEdit(it.id)
                                      }
                                      aria-label="Editar precio proveedor"
                                    >
                                      ✏️
                                    </Button>
                                  </div>
                                )}
                              </td>

                              <td className="p-2 text-right">
                                {Number(it.subtotal || 0).toFixed(2)}
                              </td>

                              {/* <td className="p-2 text-right">
                                <span>{Number(it.unitPriceRivas || 0)}</span>
                              </td> */}
                              <td className="p-2 text-right">
                                <span>{Number(it.unitPriceIsla || 0)}</span>
                              </td>

                              {/* <td className="p-2 text-right">
                                {Number(it.totalRivas || 0).toFixed(2)}
                              </td> */}
                              <td className="p-2 text-right">
                                {Number(it.totalIsla || 0).toFixed(2)}
                              </td>

                              {/* <td className="p-2 text-right">
                                <span>
                                  {Number(it.marginRivas ?? 0).toFixed(3)}
                                </span>
                              </td> */}

                              <td className="p-2 text-right">
                                <span>
                                  {Number(it.marginIsla ?? 0).toFixed(3)}
                                </span>
                              </td>

                              {/* <td className="p-2 text-right">
                                {Number(it.grossProfit || 0).toFixed(2)}
                              </td> */}
                              <td className="p-2 text-right">
                                {Number(it.grossProfitIsla || 0).toFixed(2)}
                              </td>
                              <td className="p-2 text-right">
                                {Number(it.logisticAllocated || 0).toFixed(2)}
                              </td>

                              <td className="p-2 text-center">
                                <ActionMenuTrigger
                                  className="!h-8 !w-8"
                                  iconClassName="h-5 w-5 text-gray-700"
                                  aria-label="Acciones"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setModalItemMenu({
                                      id: it.id,
                                      rect: (
                                        e.currentTarget as HTMLElement
                                      ).getBoundingClientRect(),
                                    });
                                  }}
                                />
                              </td>
                            </tr>
                          ))}
                          {filteredItems.length === 0 && (
                            <tr>
                              <td
                                colSpan={13}
                                className="p-8 text-center text-sm text-slate-500"
                              >
                                No hay productos en la orden.
                              </td>
                            </tr>
                          )}
                        </tbody>
                      </table>
                    </div>
                    {/* Paginación items (desktop) */}
                    <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                      <div className="text-sm text-slate-600">
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
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={itemPage <= 1}
                          onClick={() => setItemPage((p) => Math.max(1, p - 1))}
                          className="!rounded-lg border-slate-200 shadow-sm disabled:opacity-50"
                        >
                          Anterior
                        </Button>

                        <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium tabular-nums text-slate-800 shadow-sm">
                          {itemPage} / {totalItemPages}
                        </div>

                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={itemPage >= totalItemPages}
                          onClick={() =>
                            setItemPage((p) => Math.min(totalItemPages, p + 1))
                          }
                          className="!rounded-lg border-slate-200 shadow-sm disabled:opacity-50"
                        >
                          Siguiente
                        </Button>
                      </div>
                    </div>
                  </div>

                  {/* MÓVIL: Cards */}
                  <div className="md:hidden space-y-3">
                    {filteredItems.length === 0 ? (
                      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-6 text-center text-sm text-slate-600">
                        No hay productos en esta orden.
                      </div>
                    ) : (
                      filteredItems.map((it) => (
                        <div
                          key={it.id}
                          className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03]"
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

                            <ActionMenuTrigger
                              className="!h-8 !w-8 shrink-0"
                              iconClassName="h-5 w-5 text-gray-700"
                              aria-label="Acciones"
                              onClick={(e) => {
                                e.stopPropagation();
                                setModalItemMenu({
                                  id: it.id,
                                  rect: (
                                    e.currentTarget as HTMLElement
                                  ).getBoundingClientRect(),
                                });
                              }}
                            />
                          </div>

                          <div className="grid grid-cols-2 gap-2 mt-3">
                            <div>
                              <label className="text-xs text-gray-600">
                                Paquetes
                              </label>
                              {editingPackagesMap[it.id] ? (
                                <input
                                  type="number"
                                  step="0.001"
                                  className="w-full border p-2 rounded text-right"
                                  value={it.packages}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "packages",
                                      e.target.value,
                                    )
                                  }
                                  onBlur={() => closePackagesEdit(it.id)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key === "Enter" ||
                                      e.key === "Escape"
                                    ) {
                                      closePackagesEdit(it.id);
                                    }
                                  }}
                                  inputMode="numeric"
                                  autoFocus
                                />
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <span className="font-semibold">
                                    {it.packages}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                    onClick={() => openPackagesEdit(it.id)}
                                    aria-label="Editar paquetes"
                                  >
                                    ✏️
                                  </Button>
                                </div>
                              )}
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                Paquetes restantes
                              </label>
                              {editingRemainingMap[it.id] ? (
                                <input
                                  type="number"
                                  className="w-full border p-2 rounded text-right"
                                  value={safeInt(
                                    it.remainingPackages ?? it.packages,
                                  )}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "remainingPackages",
                                      e.target.value,
                                    )
                                  }
                                  onBlur={() => closeRemainingEdit(it.id)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key === "Enter" ||
                                      e.key === "Escape"
                                    ) {
                                      closeRemainingEdit(it.id);
                                    }
                                  }}
                                  inputMode="numeric"
                                  autoFocus
                                />
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <span className="font-semibold">
                                    {safeInt(
                                      it.remainingPackages ?? it.packages,
                                    )}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                    onClick={() => openRemainingEdit(it.id)}
                                    aria-label="Editar paquetes restantes"
                                  >
                                    ✏️
                                  </Button>
                                </div>
                              )}
                            </div>

                            <div>
                              <label className="text-xs text-gray-600">
                                Und x Paquete
                              </label>
                              {editingUnitsMap[it.id] ? (
                                <input
                                  type="number"
                                  step="0.001"
                                  className="w-full border p-2 rounded text-right"
                                  value={it.unitsPerPackage}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "unitsPerPackage",
                                      e.target.value,
                                    )
                                  }
                                  onBlur={() => closeUnitsEdit(it.id)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key === "Enter" ||
                                      e.key === "Escape"
                                    ) {
                                      closeUnitsEdit(it.id);
                                    }
                                  }}
                                  inputMode="numeric"
                                  autoFocus
                                />
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <span className="font-semibold">
                                    {it.unitsPerPackage}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                    onClick={() => openUnitsEdit(it.id)}
                                    aria-label="Editar unidades por paquete"
                                  >
                                    ✏️
                                  </Button>
                                </div>
                              )}
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

                          <div className="mt-3">
                            {/* MV Rivas oculto en UI */}
                            <div>
                              <label className="text-xs text-gray-600">
                                MV Isla (%)
                              </label>
                              <div className="text-right font-semibold">
                                {Number(it.marginIsla ?? 0).toFixed(3)}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 grid grid-cols-2 gap-2 text-sm">
                            <div className="rounded border border-slate-200/80 bg-slate-50/90 p-2">
                              <div className="text-xs text-gray-600">
                                Facturado
                              </div>
                              <div className="font-semibold">
                                {Number(it.subtotal || 0).toFixed(2)}
                              </div>
                            </div>

                            {/* Precio Rivas (paq) oculto en UI */}

                            <div className="rounded border border-sky-200/80 bg-sky-50/90 p-2">
                              <div className="text-xs text-gray-600">
                                Precio Isla (paq)
                              </div>
                              <div className="text-right font-semibold">
                                {Number(it.unitPriceIsla || 0)}
                              </div>
                            </div>

                            {/* Esperado Rivas oculto en UI */}

                            <div className="rounded border border-slate-200/80 bg-slate-50/90 p-2">
                              <div className="text-xs text-gray-600">
                                Esperado Isla
                              </div>
                              <div className="font-semibold">
                                {Number(it.totalIsla || 0).toFixed(2)}
                              </div>
                            </div>

                            <div className="rounded border border-slate-200/80 bg-slate-50/90 p-2">
                              <div className="text-xs text-gray-600">
                                Prorrateo logístico
                              </div>
                              <div className="font-semibold">
                                {Number(it.logisticAllocated || 0).toFixed(2)}
                              </div>
                            </div>
                          </div>

                          <div className="mt-3 text-xs">
                            {/* U. Bruta Rivas oculto en UI */}
                            <div className="rounded border border-emerald-200/80 bg-emerald-50/90 p-2">
                              <div className="text-gray-600">U. Bruta Isla</div>
                              <div className="font-semibold">
                                {Number(it.grossProfitIsla || 0).toFixed(2)}
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-1 gap-2 mt-3 text-xs">
                            <div className="p-2 rounded bg-gray-50 border">
                              <div className="text-gray-600">
                                Precio proveedor (paq)
                              </div>
                              {editingProviderPriceMap[it.id] ? (
                                <input
                                  type="number"
                                  className="w-full border rounded p-2 text-right"
                                  value={Number(it.providerPrice || 0)}
                                  onChange={(e) =>
                                    handleItemFieldChange(
                                      it.id,
                                      "providerPrice",
                                      e.target.value,
                                    )
                                  }
                                  onBlur={() => closeProviderPriceEdit(it.id)}
                                  onKeyDown={(e) => {
                                    if (
                                      e.key === "Enter" ||
                                      e.key === "Escape"
                                    ) {
                                      closeProviderPriceEdit(it.id);
                                    }
                                  }}
                                  inputMode="decimal"
                                  autoFocus
                                />
                              ) : (
                                <div className="flex items-center justify-end gap-2">
                                  <span className="font-semibold">
                                    {Number(it.providerPrice || 0).toFixed(2)}
                                  </span>
                                  <Button
                                    type="button"
                                    variant="ghost"
                                    className="text-xs text-gray-600 hover:text-gray-900 !rounded-md shadow-none font-normal min-h-0 px-1 py-0.5"
                                    onClick={() => openProviderPriceEdit(it.id)}
                                    aria-label="Editar precio proveedor"
                                  >
                                    ✏️
                                  </Button>
                                </div>
                              )}
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
                <h4 className="mb-3 mt-1 text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                  Resumen de la orden
                </h4>
                <div className="mt-1 grid grid-cols-1 gap-3 md:grid-cols-4">
                  <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03]">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Paquetes totales
                    </div>
                    <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">
                      {orderKPIs.totalPackages}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03]">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Subtotal costo (facturado)
                    </div>
                    <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">
                      {Number(orderKPIs.subtotalCosto || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03]">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Esperado (Rivas / Isla)
                    </div>
                    <div className="mt-1 text-sm font-semibold leading-relaxed text-slate-800">
                      Rivas: {Number(orderKPIs.esperadoRivas || 0).toFixed(2)}
                      <br />
                      Isla: {Number(orderKPIs.esperadoIsla || 0).toFixed(2)}
                    </div>
                  </div>
                  <div className="rounded-xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03]">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                      Gastos logísticos
                    </div>
                    <div className="mt-1 text-xl font-bold tabular-nums text-slate-900">
                      {Number(orderKPIs.gastosLogisticos || 0).toFixed(2)}
                    </div>
                  </div>
                </div>

                <div className="mt-4">
                  <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div className="rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-sm">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-800/90">
                        Utilidad Bruta Rivas
                      </div>
                      <div className="mt-1 text-xl font-bold tabular-nums text-emerald-950">
                        {Number(orderKPIs.utilidadBrutaRivas || 0).toFixed(2)}
                      </div>
                    </div>

                    <div className="rounded-xl border border-emerald-200/80 bg-gradient-to-br from-emerald-50 to-white p-4 shadow-sm">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-emerald-800/90">
                        Utilidad Bruta Isla
                      </div>
                      <div className="mt-1 text-xl font-bold tabular-nums text-emerald-950">
                        {Number(orderKPIs.utilidadBrutaIsla || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 rounded-xl border border-dashed border-slate-200/90 bg-slate-50/60 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs text-slate-600">
                        Plantilla, importar o exportar (menú ⋮ arriba o aquí)
                      </span>
                      <ActionMenuTrigger
                        className="shrink-0 !h-10 !w-10 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                        aria-label="Excel: plantilla, importar, exportar"
                        iconClassName="h-[22px] w-[22px] text-slate-700"
                        onClick={(e) =>
                          setMasterModalExcelMenu({
                            rect: (
                              e.currentTarget as HTMLElement
                            ).getBoundingClientRect(),
                          })
                        }
                      />
                    </div>
                  </div>
                </div>
              </div>
              </div>

              {/* ===== Botonera sticky ===== */}
              <div className="shrink-0 border-t border-slate-200/90 bg-gradient-to-t from-slate-50/95 to-white px-0 pb-3 pt-3 shadow-[0_-8px_24px_-12px_rgba(15,23,42,0.08)]">
                <div className="flex items-center justify-end gap-2">
                  <span className="mr-auto hidden text-xs text-slate-500 sm:inline">
                    Guardar, limpiar o cerrar
                  </span>
                  <ActionMenuTrigger
                    className="!h-10 !w-10 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                    aria-label="Limpiar, cerrar o guardar orden"
                    iconClassName="h-[22px] w-[22px] text-slate-700"
                    onClick={(e) =>
                      setMasterModalFooterMenu({
                        rect: (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect(),
                      })
                    }
                  />
                </div>

                {/* Atajo móvil */}
                <div className="mt-2 md:hidden">
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="w-full !rounded-xl border border-slate-200 bg-white py-2.5 text-slate-800 shadow-sm hover:bg-slate-50"
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
                  </Button>
                </div>
              </div>
            </form>

            <ActionMenu
              anchorRect={masterModalHeaderMenu?.rect ?? null}
              isOpen={!!masterModalHeaderMenu}
              onClose={() => setMasterModalHeaderMenu(null)}
              width={260}
            >
              {masterModalHeaderMenu && (
                <div className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                      savingOrder ||
                      refreshingSalePrices ||
                      !orderItems.length
                        ? "text-gray-400 cursor-not-allowed"
                        : ""
                    }`}
                    disabled={
                      savingOrder ||
                      refreshingSalePrices ||
                      !orderItems.length
                    }
                    onClick={() => {
                      setMasterModalHeaderMenu(null);
                      void refreshSalePricesFromCurrentPrices(false);
                    }}
                  >
                    {refreshingSalePrices
                      ? "Actualizando…"
                      : "Actualizar precios"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                      catalogLoading ? "text-gray-400 cursor-not-allowed" : ""
                    }`}
                    disabled={catalogLoading}
                    onClick={() => {
                      setMasterModalHeaderMenu(null);
                      void loadCatalog();
                    }}
                  >
                    {catalogLoading ? "Cargando catálogo…" : "Actualizar productos"}
                  </Button>
                  {editingOrderId ? (
                    <Button
                      type="button"
                      variant="ghost"
                      className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                        savingOrder || backfillingInventory
                          ? "text-gray-400 cursor-not-allowed"
                          : ""
                      }`}
                      disabled={savingOrder || backfillingInventory}
                      onClick={() => {
                        setMasterModalHeaderMenu(null);
                        void backfillInventoryForCurrentOrder();
                      }}
                    >
                      {backfillingInventory
                        ? "Creando inventario..."
                        : "Crear inventario faltante"}
                    </Button>
                  ) : null}
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    disabled={savingOrder}
                    onClick={() => {
                      setMasterModalHeaderMenu(null);
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                  >
                    Cerrar
                  </Button>
                </div>
              )}
            </ActionMenu>

            <ActionMenu
              anchorRect={masterModalExcelMenu?.rect ?? null}
              isOpen={!!masterModalExcelMenu}
              onClose={() => setMasterModalExcelMenu(null)}
              width={220}
            >
              {masterModalExcelMenu && (
                <div className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    onClick={() => {
                      setMasterModalExcelMenu(null);
                      handleDownloadTemplate();
                    }}
                  >
                    Descargar plantilla
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                      importing ? "text-gray-400 cursor-not-allowed" : ""
                    }`}
                    disabled={importing}
                    onClick={() => {
                      setMasterModalExcelMenu(null);
                      handlePickExcel();
                    }}
                  >
                    {importing ? "Importando..." : "Importar Excel"}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    onClick={() => {
                      setMasterModalExcelMenu(null);
                      handleExportOrderToExcel();
                    }}
                  >
                    Exportar Excel
                  </Button>
                </div>
              )}
            </ActionMenu>

            <ActionMenu
              anchorRect={masterModalFooterMenu?.rect ?? null}
              isOpen={!!masterModalFooterMenu}
              onClose={() => setMasterModalFooterMenu(null)}
              width={200}
            >
              {masterModalFooterMenu && (
                <div className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    onClick={() => {
                      setMasterModalFooterMenu(null);
                      resetOrderForm();
                    }}
                  >
                    Limpiar orden
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    onClick={() => {
                      setMasterModalFooterMenu(null);
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                  >
                    Cerrar
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                      savingOrder || orderItems.length === 0
                        ? "text-gray-400 cursor-not-allowed font-normal"
                        : "font-semibold !text-blue-700"
                    }`}
                    disabled={savingOrder || orderItems.length === 0}
                    onClick={() => {
                      setMasterModalFooterMenu(null);
                      orderFormRef.current?.requestSubmit();
                    }}
                  >
                    {savingOrder ? "Guardando..." : "Guardar orden"}
                  </Button>
                </div>
              )}
            </ActionMenu>
          </div>
        </div>
      )}

      {/* LISTADO */}
      <div className="mt-6">
        <div className="mb-3 md:mb-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="min-w-0 text-base font-bold tracking-tight text-slate-900 md:text-lg">
              Órdenes Maestras
            </h2>
            <div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
              <RefreshButton
                onClick={refresh}
                loading={loading || catalogLoading}
              />
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="!rounded-md shadow-none"
                onClick={() => {
                  resetOrderForm();
                  setOpenOrderModal(true);
                }}
                aria-label="Nueva orden"
                title="Nueva orden"
              >
                +
              </Button>
            </div>
          </div>
          <p className="mt-0.5 text-xs text-slate-500 md:text-sm">
            Toca una orden para ver el detalle o usa el menú para editar.
          </p>
        </div>

        {/* MÓVIL: Cards */}
        <div className="md:hidden space-y-3">
          {loading ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center text-sm text-slate-600">
              Cargando…
            </div>
          ) : orders.length === 0 ? (
            <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/80 p-8 text-center text-sm text-slate-600">
              Sin órdenes maestras.
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
                  role="button"
                  tabIndex={0}
                  className="cursor-pointer rounded-2xl border border-slate-200/80 bg-white p-4 shadow-sm ring-1 ring-slate-900/[0.03] transition-all hover:border-slate-300 hover:shadow-md active:scale-[0.99]"
                  onClick={() => void openMasterOrderDrawer(o)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      void openMasterOrderDrawer(o);
                    }
                  }}
                >
                  <div className="flex items-start gap-3">
                    <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-indigo-50 text-[11px] font-bold text-indigo-800">
                      OM
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11px] font-medium uppercase tracking-wide text-slate-500">
                        {fecha}
                      </div>
                      <div className="font-semibold leading-snug text-slate-900">
                        {o.name}
                      </div>
                    </div>

                    <ActionMenuTrigger
                      className="shrink-0 !h-9 !w-9 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                      aria-label="Acciones de la orden"
                      iconClassName="h-5 w-5 text-slate-700"
                      onClick={(e) => {
                        e.stopPropagation();
                        setOrderListMenu({
                          id: o.id,
                          rect: (
                            e.currentTarget as HTMLElement
                          ).getBoundingClientRect(),
                        });
                      }}
                    />
                  </div>

                  <div className="mt-4 grid grid-cols-2 gap-2 text-sm">
                    <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 p-2.5">
                      <div className="text-[11px] font-medium text-slate-500">
                        Paquetes
                      </div>
                      <div className="font-semibold tabular-nums text-slate-900">
                        {o.totalPackages}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 p-2.5">
                      <div className="text-[11px] font-medium text-slate-500">
                        Restantes
                      </div>
                      <div className="font-semibold tabular-nums text-slate-900">
                        {agg ? agg.remainingPackages : 0}
                      </div>
                    </div>

                    <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 p-2.5">
                      <div className="text-[11px] font-medium text-slate-500">
                        P. proveedor
                      </div>
                      <div className="font-semibold tabular-nums text-slate-900">
                        {precioProveedor}
                      </div>
                    </div>
                    <div className="rounded-lg border border-slate-200/80 bg-slate-50/90 p-2.5">
                      <div className="text-[11px] font-medium text-slate-500">
                        Subtotal
                      </div>
                      <div className="font-semibold tabular-nums text-slate-900">
                        {Number(o.subtotal || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 text-xs">
                    <div className="rounded-lg border border-sky-200/70 bg-sky-50/90 p-2.5">
                      <div className="font-medium text-sky-900/80">
                        Esperado Isla
                      </div>
                      <div className="font-semibold tabular-nums text-sky-950">
                        {Number(o.totalIsla || 0).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs">
                    <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/90 p-2.5">
                      <div className="font-medium text-emerald-900/80">
                        Gastos log.
                      </div>
                      <div className="font-semibold tabular-nums text-emerald-950">
                        {logi.toFixed(2)}
                      </div>
                    </div>
                    <div className="rounded-lg border border-emerald-200/70 bg-emerald-50/90 p-2.5">
                      <div className="font-medium text-emerald-900/80">
                        U. bruta (est.)
                      </div>
                      <div className="font-semibold tabular-nums text-emerald-950">
                        {grossEst.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <ActionMenu
          anchorRect={mainOrdersListToolbarMenu?.rect ?? null}
          isOpen={!!mainOrdersListToolbarMenu}
          onClose={() => setMainOrdersListToolbarMenu(null)}
          width={240}
        >
          {mainOrdersListToolbarMenu && (
            <div className="py-1">
              <Button
                type="button"
                variant="ghost"
                className={`w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100 ${
                  isBackfillingMain ? "text-gray-400 cursor-not-allowed" : ""
                }`}
                disabled={isBackfillingMain}
                onClick={() => {
                  setMainOrdersListToolbarMenu(null);
                  void backfillMainOrdersLogistics();
                }}
              >
                {isBackfillingMain
                  ? "Actualizando prorrateo..."
                  : "Actualizar prorrateo"}
              </Button>
            </div>
          )}
        </ActionMenu>

        <ActionMenu
          anchorRect={orderListMenu?.rect ?? null}
          isOpen={!!orderListMenu}
          onClose={() => setOrderListMenu(null)}
          width={220}
        >
          {orderListMenu &&
            (() => {
              const o = orders.find((x) => x.id === orderListMenu.id);
              if (!o) {
                return (
                  <div className="px-3 py-2 text-sm text-gray-500">
                    Sin datos
                  </div>
                );
              }
              return (
                <div className="py-1">
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal hover:bg-gray-100"
                    onClick={() => {
                      setOrderListMenu(null);
                      openOrderForEdit(o);
                    }}
                  >
                    Ver / Editar orden
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700 hover:!bg-red-50"
                    onClick={() => {
                      setOrderListMenu(null);
                      void handleDeleteOrder(o);
                    }}
                  >
                    Eliminar orden
                  </Button>
                </div>
              );
            })()}
        </ActionMenu>

        <ActionMenu
          anchorRect={modalItemMenu?.rect ?? null}
          isOpen={!!modalItemMenu}
          onClose={() => setModalItemMenu(null)}
          width={200}
        >
          {modalItemMenu && (
            <div className="py-1">
              <Button
                type="button"
                variant="ghost"
                className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700 hover:!bg-red-50"
                onClick={() => {
                  const id = modalItemMenu.id;
                  setModalItemMenu(null);
                  removeItemFromOrder(id);
                }}
              >
                Quitar de la orden
              </Button>
            </div>
          )}
        </ActionMenu>

        {/* DESKTOP: tabla */}
        <div className="hidden md:block overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-sm ring-1 ring-slate-900/[0.04]">
          <div className="flex items-center justify-between gap-3 border-b border-slate-200/90 bg-gradient-to-r from-slate-50 to-white px-4 py-3">
            <div className="text-sm text-slate-700">
              <span className="font-semibold text-slate-900">
                {orders.length}
              </span>{" "}
              pedido{orders.length === 1 ? "" : "s"}
            </div>

            <ActionMenuTrigger
              className="shrink-0 !h-10 !w-10 rounded-xl border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
              aria-label="Acciones del listado"
              title="Actualizar prorrateo de órdenes maestras"
              iconClassName="h-[22px] w-[22px] text-slate-700"
              onClick={(e) =>
                setMainOrdersListToolbarMenu({
                  rect: (
                    e.currentTarget as HTMLElement
                  ).getBoundingClientRect(),
                })
              }
            />
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-[1100px] w-full text-xs">
              <thead className="sticky top-0 z-10 border-b border-slate-200 bg-slate-100/95 backdrop-blur-sm">
                <tr className="whitespace-nowrap">
                  <th className="border-b border-slate-200 p-2.5 text-left font-semibold text-slate-700">
                    Fecha
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-left font-semibold text-slate-700">
                    Nombre
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    P. Agregados
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    P. Restantes
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    Costo
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    Facturado
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    Esperado
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    Gastos
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-right font-semibold text-slate-700">
                    U. bruta
                  </th>
                  <th className="border-b border-slate-200 p-2.5 text-center font-semibold text-slate-700">
                    Acciones
                  </th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="p-10 text-center text-sm text-slate-500"
                    >
                      Cargando…
                    </td>
                  </tr>
                ) : orders.length === 0 ? (
                  <tr>
                    <td
                      colSpan={10}
                      className="p-10 text-center text-sm text-slate-500"
                    >
                      Sin órdenes maestras.
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
                      <tr
                        key={o.id}
                        className="cursor-pointer whitespace-nowrap border-b border-slate-100 transition-colors hover:bg-slate-50/90"
                        role="button"
                        tabIndex={0}
                        onClick={() => void openMasterOrderDrawer(o)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            void openMasterOrderDrawer(o);
                          }
                        }}
                      >
                        <td className="p-2.5 text-slate-600">{fecha}</td>
                        <td className="p-2.5 font-medium text-slate-900">
                          {o.name}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-slate-800">
                          {o.totalPackages}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-slate-800">
                          {agg ? agg.remainingPackages : 0}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-slate-800">
                          {precioProveedor}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-slate-800">
                          {Number(o.subtotal || 0).toFixed(2)}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-sky-900">
                          {Number(o.totalIsla || 0).toFixed(2)}
                        </td>
                        <td className="p-2.5 text-right tabular-nums text-slate-800">
                          {logi.toFixed(2)}
                        </td>
                        <td className="p-2.5 text-right tabular-nums font-medium text-emerald-800">
                          {grossEst.toFixed(2)}
                        </td>
                        <td className="p-2.5 text-center align-middle">
                          <ActionMenuTrigger
                            className="!h-8 !w-8 rounded-lg border border-slate-200/80 bg-white shadow-sm hover:bg-slate-50"
                            aria-label="Acciones de la orden"
                            iconClassName="h-5 w-5 text-slate-700"
                            onClick={(e) => {
                              e.stopPropagation();
                              setOrderListMenu({
                                id: o.id,
                                rect: (
                                  e.currentTarget as HTMLElement
                                ).getBoundingClientRect(),
                              });
                            }}
                          />
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {/* Paginación (desktop) */}
          <div className="flex flex-col gap-2 border-t border-slate-200/90 bg-slate-50/50 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-slate-600">
              Mostrando{" "}
              {Math.min((page - 1) * PAGE_SIZE + 1, orders.length)}-
              {Math.min(page * PAGE_SIZE, orders.length)} de {orders.length}
            </div>

            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                className="!rounded-lg border-slate-200 shadow-sm disabled:opacity-50"
              >
                Anterior
              </Button>

              <div className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-sm font-medium tabular-nums text-slate-800 shadow-sm">
                {page} / {totalPages}
              </div>

              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                className="!rounded-lg border-slate-200 shadow-sm disabled:opacity-50"
              >
                Siguiente
              </Button>
            </div>
          </div>
        </div>

        <SlideOverDrawer
          open={masterDrawerOpen}
          onClose={() => {
            setMasterDrawerOpen(false);
            setMasterDrawerOrder(null);
            setMasterDrawerItems([]);
            setMasterDrawerUBrutaGlobal(null);
          }}
          title={masterDrawerOrder?.name ?? "Orden maestra"}
          subtitle={
            masterDrawerOrder ? getOrderListDate(masterDrawerOrder) : undefined
          }
          badge={
            <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[11px] font-medium text-slate-700">
              Orden maestra
            </span>
          }
        >
          {masterDrawerLoading ? (
            <div className="py-8 text-center text-sm text-gray-600">
              Cargando detalle…
            </div>
          ) : masterDrawerOrder ? (
            <>
              {(() => {
                const o = masterDrawerOrder;
                const agg = orderInventoryAgg[o.id];
                const grossEst =
                  Number(o.totalRivas || 0) - Number(o.subtotal || 0);
                const uBruta =
                  masterDrawerUBrutaGlobal != null &&
                  masterDrawerUBrutaGlobal > 0
                    ? masterDrawerUBrutaGlobal
                    : grossEst;
                const logi = Number(o.logisticsCost || 0);
                const utilidadNeta = uBruta - logi;
                const sj = Number(o.totalSanJorge || 0);

                return (
                  <>
                    <DrawerStatGrid
                      items={[
                        {
                          label: "Productos (líneas)",
                          value: masterDrawerItems.length,
                          tone: "slate",
                        },
                        {
                          label: "Paquetes ingresados",
                          value: o.totalPackages,
                          tone: "sky",
                        },
                        {
                          label: "Paquetes restantes",
                          value: agg ? agg.remainingPackages : 0,
                          tone: "amber",
                        },
                        {
                          label: "Esperado Rivas",
                          value: `C$ ${Number(o.totalRivas || 0).toFixed(2)}`,
                          tone: "indigo",
                        },
                        {
                          label: "Esperado Isla",
                          value: `C$ ${Number(o.totalIsla || 0).toFixed(2)}`,
                          tone: "indigo",
                        },
                        ...(sj > 0.01
                          ? [
                              {
                                label: "Esperado San Jorge",
                                value: `C$ ${sj.toFixed(2)}`,
                                tone: "indigo" as const,
                              },
                            ]
                          : []),
                        {
                          label: "Total facturado (proveedor)",
                          value: `C$ ${Number(o.subtotal || 0).toFixed(2)}`,
                          tone: "violet",
                        },
                        {
                          label: "Gastos logísticos",
                          value: `C$ ${logi.toFixed(2)}`,
                          tone: "rose",
                        },
                        {
                          label: "U. bruta (est.)",
                          value: `C$ ${uBruta.toFixed(2)}`,
                          tone: "emerald",
                        },
                        {
                          label: "Utilidad neta (est.)",
                          value: `C$ ${utilidadNeta.toFixed(2)}`,
                          tone: "emerald",
                        },
                        {
                          label: "Utilidad vendedor",
                          value: "—",
                          tone: "slate",
                          valueClassName: "text-gray-500",
                        },
                        {
                          label: "Vendedor",
                          value: "—",
                          tone: "slate",
                          valueClassName: "text-gray-500",
                        },
                      ]}
                    />
                  </>
                );
              })()}

              <DrawerSectionTitle>Productos</DrawerSectionTitle>
              {masterDrawerItems.length === 0 ? (
                <div className="mt-2 text-sm text-gray-600">
                  Sin productos en esta orden.
                </div>
              ) : (
                <div className="mt-2 space-y-2">
                  {masterDrawerItems.map((it) => (
                    <DrawerDetailDlCard
                      key={it.id}
                      title={
                        <span className="leading-snug">{it.name || it.id}</span>
                      }
                      rows={[
                        { label: "Categoría", value: it.category || "—" },
                        {
                          label: "Precio costo (paq)",
                          value: `C$ ${Number(it.providerPrice || 0).toFixed(2)}`,
                        },
                        {
                          label: "Precio venta Isla (paq)",
                          value: `C$ ${Number(it.unitPriceIsla || 0).toFixed(2)}`,
                        },
                        {
                          label: "Paquetes",
                          value: String(it.packages ?? 0),
                        },
                        {
                          label: "Restantes",
                          value: String(it.remainingPackages ?? 0),
                        },
                        {
                          label: "Subtotal (proveedor)",
                          value: `C$ ${Number(it.subtotal || 0).toFixed(2)}`,
                        },
                        {
                          label: "Esperado Rivas",
                          value: `C$ ${Number(it.totalRivas || 0).toFixed(2)}`,
                        },
                        {
                          label: "Esperado Isla",
                          value: `C$ ${Number(it.totalIsla || 0).toFixed(2)}`,
                        },
                      ]}
                    />
                  ))}
                </div>
              )}
            </>
          ) : null}
        </SlideOverDrawer>
      </div>
    </div>
  );
}
