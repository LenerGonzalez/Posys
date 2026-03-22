// src/components/Candies/CandyStockPedidosPage.tsx

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
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

type SellerStatus = "ACTIVO" | "INACTIVO";
type PedidoStatus = "PENDIENTE" | "FINALIZADO";

interface CandyStockPedidosPageProps {
  role?: RoleProp;
  roles?: string[];
  sellerCandyId?: string;
  currentUserEmail?: string;
}

interface Vendor {
  id: string;
  name: string;
  status?: SellerStatus;
  branch?: string;
  branchLabel?: string;
  commissionPercent?: number;
}

interface MasterProductAgg {
  productId: string;
  category: string;
  productName: string;
  unitsPerPackage: number;
  priceIsla: number;
  stockPackages: number;
  stockUnits: number;
  assigned: boolean;
  available: boolean;
  latestSortKey: number;
}

interface PossibleOrderItem {
  productId: string;
  category: string;
  productName: string;
  unitsPerPackage: number;
  priceIsla: number;
  qtyPackages: number;
  subtotal: number;
  stockPackagesAtMoment: number;
}

interface PossibleOrder {
  id: string;
  date: string;
  sellerId: string;
  sellerName: string;
  customerName: string;
  customerPhone: string;
  customerAddress: string;
  items: PossibleOrderItem[];
  total: number;
  productsCount: number;
  packagesTotal: number;
  status: PedidoStatus;
  createdAt?: any;
  updatedAt?: any;
  finalizedAt?: any;
}

const POSSIBLE_ORDERS_COLLECTION = "candy_possible_orders";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

function norm(v: any) {
  return String(v ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toNum(v: any, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function parseDateKey(dateStr: any) {
  const s = String(dateStr || "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function todayLocalISO() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function startOfMonthISO() {
  const d = new Date();
  d.setDate(1);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}

function inDateRange(date: string, from: string, to: string) {
  const x = String(date || "");
  if (!x) return false;
  if (from && x < from) return false;
  if (to && x > to) return false;
  return true;
}

function statusBadgeClasses(
  kind: "available" | "out" | "assigned" | "unassigned",
) {
  switch (kind) {
    case "available":
      return "bg-emerald-50 text-emerald-700 border-emerald-200";
    case "out":
      return "bg-red-50 text-red-700 border-red-200";
    case "assigned":
      return "bg-blue-50 text-blue-700 border-blue-200";
    case "unassigned":
      return "bg-amber-50 text-amber-700 border-amber-200";
    default:
      return "bg-gray-50 text-gray-700 border-gray-200";
  }
}

function SectionCard({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="font-semibold text-slate-900">{title}</div>
        {subtitle ? (
          <div className="text-xs text-slate-500 mt-0.5">{subtitle}</div>
        ) : null}
      </div>
      <div className="p-4">{children}</div>
    </div>
  );
}

function KpiCard({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
      <div className="text-xs uppercase tracking-wide text-slate-500">
        {label}
      </div>
      <div className="mt-1 text-2xl font-bold text-slate-900">{value}</div>
    </div>
  );
}

export default function CandyStockPedidosPage({
  role = "",
  roles,
  sellerCandyId = "",
}: CandyStockPedidosPageProps) {
  const STOCK_PAGE_SIZE = 10;
  const [stockPage, setStockPage] = useState<number>(1);
  const subject = roles && roles.length ? roles : role;
  const isAdmin = hasRole(subject, "admin");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const isContador = hasRole(subject, "contador");

  const [tab, setTab] = useState<"STOCK" | "PEDIDOS">("STOCK");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState("");

  const [from, setFrom] = useState(startOfMonthISO());
  const [to, setTo] = useState(todayLocalISO());

  const [vendors, setVendors] = useState<Vendor[]>([]);
  const [masterProducts, setMasterProducts] = useState<MasterProductAgg[]>([]);
  const [possibleOrders, setPossibleOrders] = useState<PossibleOrder[]>([]);

  // filtros STOCK
  const [stockProductFilter, setStockProductFilter] = useState("");
  const [stockCategoryFilter, setStockCategoryFilter] = useState("");
  const [onlyAvailable, setOnlyAvailable] = useState(false);
  const [filtersOpenMobile, setFiltersOpenMobile] = useState(false);
  const [mobileOpenSections, setMobileOpenSections] = useState<
    Record<string, boolean>
  >({ vendedor: false, cliente: false, pedido: false, listado: false });

  const [assignedByNameMap, setAssignedByNameMap] = useState<
    Record<string, string>
  >({});

  const [globalFiltersOpenMobile, setGlobalFiltersOpenMobile] = useState(false);

  function ProductCard({ product }: { product: MasterProductAgg }) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <div className="font-semibold text-slate-900">
              {product.productName}
            </div>
            <div className="text-xs text-slate-500 mt-0.5">
              {product.category || "—"}
            </div>
          </div>
          <div className="text-right">
            <div className="text-xs text-slate-500">Precio Isla</div>
            <div className="font-semibold">{money(product.priceIsla)}</div>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs text-slate-500">Stock</div>
            <div className="font-bold text-lg">
              {Number(product.stockPackages || 0)}
            </div>
          </div>
          <div className="rounded-xl bg-slate-50 p-3">
            <div className="text-xs text-slate-500">Unidades</div>
            <div className="font-bold text-lg">
              {Number(product.stockUnits || 0)}
            </div>
          </div>
        </div>

        <div className="flex gap-2 flex-wrap mt-4">
          <span
            className={`px-2 py-1 rounded-full border text-xs font-semibold ${statusBadgeClasses(
              product.available ? "available" : "out",
            )}`}
          >
            {product.available ? "Disponible" : "Agotado"}
          </span>
          <span
            className={`px-2 py-1 rounded-full border text-xs font-semibold ${statusBadgeClasses(
              assignedByNameMap[String(product.productId)]
                ? "assigned"
                : "unassigned",
            )}`}
          >
            {assignedByNameMap[String(product.productId)]
              ? `Asignado ${assignedByNameMap[String(product.productId)]}`
              : "No asignado"}
          </span>
        </div>
      </div>
    );
  }

  const [categoryOpenMap, setCategoryOpenMap] = useState<
    Record<string, boolean>
  >({});

  // selección vendedor para pantalla
  const [selectedSellerId, setSelectedSellerId] = useState<string>("");

  // form PEDIDOS
  const [editingOrderId, setEditingOrderId] = useState<string>("");
  const [orderDate, setOrderDate] = useState(todayLocalISO());
  const [orderSellerId, setOrderSellerId] = useState<string>("");
  const [customerName, setCustomerName] = useState("");
  const [customerPhone, setCustomerPhone] = useState("");
  const [customerAddress, setCustomerAddress] = useState("");

  const [productSearch, setProductSearch] = useState("");
  const [selectedCatalogProductId, setSelectedCatalogProductId] = useState("");
  const [orderItems, setOrderItems] = useState<PossibleOrderItem[]>([]);
  const [ordersSearch, setOrdersSearch] = useState("");
  const [ordersStatusFilter, setOrdersStatusFilter] = useState<
    "" | PedidoStatus
  >("");

  const refreshAll = async () => {
    setLoading(true);
    setMsg("");
    try {
      // vendedores
      const vendorsSnap = await getDocs(
        query(collection(db, "sellers_candies")),
      );
      const vendorsList: Vendor[] = vendorsSnap.docs.map((d) => {
        const x = d.data() as any;
        return {
          id: d.id,
          name: String(x.name || x.sellerName || "").trim(),
          status: (x.status || "ACTIVO") as SellerStatus,
          branch: String(x.branch || "").trim(),
          branchLabel: String(x.branchLabel || "").trim(),
          commissionPercent: Number(x.commissionPercent || 0),
        };
      });

      const activeOrAll = vendorsList
        .filter(
          (v) => (v.status || "ACTIVO") === "ACTIVO" || isAdmin || isContador,
        )
        .sort((a, b) => a.name.localeCompare(b.name, "es"));

      setVendors(activeOrAll);

      // seleccionar vendedor por defecto: dejar en "Todos" para la mayoría
      // salvo cuando hay un sellerCandyId forzado (vendedor logueado)
      const nextDefaultSeller =
        sellerCandyId && activeOrAll.some((v) => v.id === sellerCandyId)
          ? sellerCandyId
          : selectedSellerId &&
              activeOrAll.some((v) => v.id === selectedSellerId)
            ? selectedSellerId
            : "";

      setSelectedSellerId(nextDefaultSeller);

      if (!orderSellerId) {
        setOrderSellerId(
          sellerCandyId && activeOrAll.some((v) => v.id === sellerCandyId)
            ? sellerCandyId
            : activeOrAll[0]?.id || "",
        );
      }

      // pedidos posibles
      const ordersSnap = await getDocs(
        query(
          collection(db, POSSIBLE_ORDERS_COLLECTION),
          orderBy("date", "desc"),
        ),
      );

      const ordersList: PossibleOrder[] = ordersSnap.docs.map((d) => {
        const x = d.data() as any;
        return {
          id: d.id,
          date: String(x.date || ""),
          sellerId: String(x.sellerId || ""),
          sellerName: String(x.sellerName || ""),
          customerName: String(x.customerName || ""),
          customerPhone: String(x.customerPhone || ""),
          customerAddress: String(x.customerAddress || ""),
          items: Array.isArray(x.items) ? x.items : [],
          total: Number(x.total || 0),
          productsCount: Number(x.productsCount || 0),
          packagesTotal: Number(x.packagesTotal || 0),
          status: (x.status || "PENDIENTE") as PedidoStatus,
          createdAt: x.createdAt,
          updatedAt: x.updatedAt,
          finalizedAt: x.finalizedAt,
        };
      });

      setPossibleOrders(ordersList);

      // stock maestro + asignación vendedor
      const mainSnap = await getDocs(
        query(collection(db, "candy_main_orders")),
      );
      const sellerInvSnap = await getDocs(
        query(collection(db, "inventory_candies_sellers")),
      );

      const assignedBySeller: Record<string, Set<string>> = {};
      sellerInvSnap.forEach((d) => {
        const x = d.data() as any;
        const sid = String(x.sellerId || x.seller || "").trim();
        const pid = String(
          x.productId || x.product || x.id || (x.product && x.product.id) || "",
        ).trim();
        if (!sid || !pid) return;
        if (!assignedBySeller[sid]) assignedBySeller[sid] = new Set<string>();
        assignedBySeller[sid].add(pid);
      });

      // build map productId -> sellerName for badges
      const sellerNameById: Record<string, string> = {};
      activeOrAll.forEach((v) => {
        if (v.id) sellerNameById[v.id] = v.name || "";
      });

      const assignedNameMap: Record<string, string> = {};
      sellerInvSnap.forEach((d) => {
        const x = d.data() as any;
        const sid = String(x.sellerId || x.seller || "").trim();
        const pid = String(
          x.productId || x.product || x.id || (x.product && x.product.id) || "",
        ).trim();
        if (pid && sid) {
          const name = sellerNameById[sid] || "";
          if (name) {
            if (!assignedNameMap[pid]) assignedNameMap[pid] = name;
          }
        }
      });

      setAssignedByNameMap(assignedNameMap);

      const map = new Map<string, MasterProductAgg>();

      mainSnap.forEach((d) => {
        const x = d.data() as any;
        const docDate = String(x.date || "");
        if (!inDateRange(docDate, from, to)) return;

        const dateKey = parseDateKey(docDate);
        const createdAtMs =
          x?.createdAt?.toMillis?.() ||
          (x?.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0) ||
          0;
        const sortKey = Math.max(dateKey, createdAtMs);

        const items: any[] = Array.isArray(x.items) ? x.items : [];
        for (const it of items) {
          const productId = String(it?.id || it?.productId || "").trim();
          if (!productId) continue;

          const productName = String(it?.name || it?.productName || "").trim();
          const category = String(it?.category || "").trim();
          const unitsPerPackage = Math.max(
            1,
            Math.floor(Number(it?.unitsPerPackage || it?.unitsPerPack || 1)),
          );

          const rawRemainingPackages = Number(
            it?.remainingPackages ??
              it?.packagesRemaining ??
              it?.stockPackages ??
              NaN,
          );

          const rawRemainingUnits = Number(
            it?.remainingUnits ?? it?.remaining ?? it?.stockUnits ?? NaN,
          );

          let remainingPackages = 0;
          let remainingUnits = 0;

          if (Number.isFinite(rawRemainingPackages)) {
            remainingPackages = Math.max(0, rawRemainingPackages);
            remainingUnits = Math.max(0, remainingPackages * unitsPerPackage);
          } else if (Number.isFinite(rawRemainingUnits)) {
            remainingUnits = Math.max(0, rawRemainingUnits);
            remainingPackages = Math.floor(remainingUnits / unitsPerPackage);
          } else {
            const fallbackPackages = Number(it?.packages || 0);
            remainingPackages = Math.max(0, fallbackPackages);
            remainingUnits = Math.max(0, remainingPackages * unitsPerPackage);
          }

          const priceIsla = Number(
            it?.unitPriceIsla ?? it?.priceIsla ?? it?.totalUnitPriceIsla ?? 0,
          );

          const current = map.get(productId);

          if (!current) {
            map.set(productId, {
              productId,
              category,
              productName,
              unitsPerPackage,
              priceIsla,
              stockPackages: remainingPackages,
              stockUnits: remainingUnits,
              assigned: false,
              available: remainingPackages > 0,
              latestSortKey: sortKey,
            });
          } else {
            current.stockPackages += remainingPackages;
            current.stockUnits += remainingUnits;

            if (sortKey >= current.latestSortKey) {
              current.category = category || current.category;
              current.productName = productName || current.productName;
              current.unitsPerPackage =
                unitsPerPackage || current.unitsPerPackage;
              current.priceIsla = priceIsla;
              current.latestSortKey = sortKey;
            }
            current.available = current.stockPackages > 0;
          }
        }
      });

      const selectedSet =
        assignedBySeller[nextDefaultSeller] || new Set<string>();

      const list = Array.from(map.values())
        .map((row) => ({
          ...row,
          assigned: selectedSet.has(row.productId),
          available: row.stockPackages > 0,
        }))
        .sort((a, b) => a.productName.localeCompare(b.productName, "es"));

      setMasterProducts(list);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error cargando stock/pedidos.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    refreshAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [from, to]);

  // recalcular badge asignado cuando cambia vendedor sin volver a pegar a Firestore
  useEffect(() => {
    (async () => {
      try {
        if (!selectedSellerId) return;
        const sellerInvSnap = await getDocs(
          query(collection(db, "inventory_candies_sellers")),
        );
        const set = new Set<string>();
        sellerInvSnap.forEach((d) => {
          const x = d.data() as any;
          const sid = String(x.sellerId || "").trim();
          const pid = String(x.productId || "").trim();
          if (sid === selectedSellerId && pid) set.add(pid);
        });

        setMasterProducts((prev) =>
          prev.map((r) => ({
            ...r,
            assigned: set.has(r.productId),
            available: r.stockPackages > 0,
          })),
        );
      } catch (e) {
        console.error(e);
      }
    })();
  }, [selectedSellerId]);

  // lock vendedor para vendedor_dulces
  useEffect(() => {
    if (sellerCandyId && (isVendDulces || !isAdmin)) {
      setSelectedSellerId(sellerCandyId);
      setOrderSellerId(sellerCandyId);
    }
  }, [sellerCandyId, isVendDulces, isAdmin]);

  const categories = useMemo(() => {
    return Array.from(
      new Set(masterProducts.map((x) => x.category).filter(Boolean)),
    ).sort((a, b) => a.localeCompare(b, "es"));
  }, [masterProducts]);

  const filteredStock = useMemo(() => {
    return masterProducts.filter((r) => {
      const okProduct =
        !stockProductFilter ||
        norm(r.productName).includes(norm(stockProductFilter));
      const okCategory =
        !stockCategoryFilter || norm(r.category) === norm(stockCategoryFilter);
      const okAvailable = !onlyAvailable || Number(r.stockPackages || 0) > 0;
      return okProduct && okCategory && okAvailable;
    });
  }, [masterProducts, stockProductFilter, stockCategoryFilter, onlyAvailable]);

  // pagination for stock (web + mobile)
  const totalStockPages = Math.max(
    1,
    Math.ceil(filteredStock.length / STOCK_PAGE_SIZE),
  );
  useEffect(() => {
    setStockPage(1);
  }, [filteredStock]);

  const paginatedStock = useMemo(() => {
    const start = (stockPage - 1) * STOCK_PAGE_SIZE;
    return filteredStock.slice(start, start + STOCK_PAGE_SIZE);
  }, [filteredStock, stockPage]);

  const stockKpis = useMemo(() => {
    return {
      stockPackages: filteredStock.reduce(
        (acc, x) => acc + Number(x.stockPackages || 0),
        0,
      ),
      productsCount: filteredStock.length,
    };
  }, [filteredStock]);

  const catalogForOrder = useMemo(() => {
    return [...masterProducts].sort((a, b) =>
      a.productName.localeCompare(b.productName, "es"),
    );
  }, [masterProducts]);

  const productSearchResults = useMemo(() => {
    const term = norm(productSearch);
    if (!term) return catalogForOrder.slice(0, 50);
    return catalogForOrder
      .filter(
        (p) =>
          norm(p.productName).includes(term) ||
          norm(p.category).includes(term) ||
          norm(p.productId).includes(term),
      )
      .slice(0, 50);
  }, [catalogForOrder, productSearch]);

  const orderSeller = useMemo(
    () => vendors.find((v) => v.id === orderSellerId) || null,
    [vendors, orderSellerId],
  );

  const orderTotal = useMemo(
    () => orderItems.reduce((acc, x) => acc + Number(x.subtotal || 0), 0),
    [orderItems],
  );
  const orderPackagesTotal = useMemo(
    () => orderItems.reduce((acc, x) => acc + Number(x.qtyPackages || 0), 0),
    [orderItems],
  );
  const orderProductsTotal = useMemo(() => orderItems.length, [orderItems]);

  const filteredOrders = useMemo(() => {
    return possibleOrders.filter((o) => {
      if (!inDateRange(o.date, from, to)) return false;

      const lockedByVendor =
        sellerCandyId && (isVendDulces || !isAdmin)
          ? o.sellerId === sellerCandyId
          : true;

      const bySeller = selectedSellerId
        ? o.sellerId === selectedSellerId
        : true;
      const byStatus = ordersStatusFilter
        ? o.status === ordersStatusFilter
        : true;

      const q = norm(ordersSearch);
      const bySearch =
        !q ||
        norm(o.customerName).includes(q) ||
        norm(o.customerPhone).includes(q) ||
        norm(o.customerAddress).includes(q) ||
        norm(o.sellerName).includes(q) ||
        o.items.some((it) => norm(it.productName).includes(q));

      return lockedByVendor && bySeller && byStatus && bySearch;
    });
  }, [
    possibleOrders,
    from,
    to,
    sellerCandyId,
    isVendDulces,
    isAdmin,
    selectedSellerId,
    ordersStatusFilter,
    ordersSearch,
  ]);

  const orderKpis = useMemo(() => {
    const pending = filteredOrders.filter((x) => x.status === "PENDIENTE");
    const finalized = filteredOrders.filter((x) => x.status === "FINALIZADO");

    return {
      totalPedidos: filteredOrders.length,
      pendientes: pending.length,
      finalizados: finalized.length,
      montoPF: finalized.reduce((acc, x) => acc + Number(x.total || 0), 0),
      montoPP: pending.reduce((acc, x) => acc + Number(x.total || 0), 0),
      productosTotales: filteredOrders.reduce(
        (acc, x) => acc + Number(x.productsCount || 0),
        0,
      ),
      paquetesTotales: filteredOrders.reduce(
        (acc, x) => acc + Number(x.packagesTotal || 0),
        0,
      ),
    };
  }, [filteredOrders]);

  const clearOrderForm = () => {
    setEditingOrderId("");
    setOrderDate(todayLocalISO());
    setOrderSellerId(
      sellerCandyId && (isVendDulces || !isAdmin)
        ? sellerCandyId
        : selectedSellerId || vendors[0]?.id || "",
    );
    setCustomerName("");
    setCustomerPhone("");
    setCustomerAddress("");
    setProductSearch("");
    setSelectedCatalogProductId("");
    setOrderItems([]);
  };

  const addCatalogProductToOrder = (productId: string) => {
    const p = catalogForOrder.find((x) => x.productId === productId);
    if (!p) return;

    setOrderItems((prev) => {
      const idx = prev.findIndex((x) => x.productId === p.productId);
      if (idx >= 0) {
        const next = [...prev];
        const current = next[idx];
        const qtyPackages = Number(current.qtyPackages || 0) + 1;
        next[idx] = {
          ...current,
          qtyPackages,
          subtotal: qtyPackages * Number(current.priceIsla || 0),
        };
        return next;
      }

      return [
        ...prev,
        {
          productId: p.productId,
          category: p.category,
          productName: p.productName,
          unitsPerPackage: p.unitsPerPackage,
          priceIsla: p.priceIsla,
          qtyPackages: 1,
          subtotal: Number(p.priceIsla || 0),
          stockPackagesAtMoment: Number(p.stockPackages || 0),
        },
      ];
    });
  };

  const updateOrderItem = (
    productId: string,
    patch: Partial<PossibleOrderItem>,
  ) => {
    setOrderItems((prev) =>
      prev.map((x) => {
        if (x.productId !== productId) return x;
        const next = { ...x, ...patch };
        const qtyPackages = Math.max(0, Number(next.qtyPackages || 0));
        const priceIsla = Math.max(0, Number(next.priceIsla || 0));
        return {
          ...next,
          qtyPackages,
          priceIsla,
          subtotal: qtyPackages * priceIsla,
        };
      }),
    );
  };

  const removeOrderItem = (productId: string) => {
    setOrderItems((prev) => prev.filter((x) => x.productId !== productId));
  };

  const savePossibleOrder = async () => {
    if (!orderSellerId) {
      setMsg("⚠️ Seleccioná un vendedor.");
      return;
    }
    if (!orderDate) {
      setMsg("⚠️ Seleccioná fecha de pedido.");
      return;
    }
    if (!customerName.trim()) {
      setMsg("⚠️ Ingresá nombre del cliente.");
      return;
    }
    if (!orderItems.length) {
      setMsg("⚠️ Agregá al menos un producto.");
      return;
    }

    const seller = vendors.find((v) => v.id === orderSellerId);
    const payload = {
      date: orderDate,
      sellerId: orderSellerId,
      sellerName: seller?.name || "",
      customerName: customerName.trim(),
      customerPhone: customerPhone.trim(),
      customerAddress: customerAddress.trim(),
      items: orderItems.map((it) => ({
        ...it,
        qtyPackages: Number(it.qtyPackages || 0),
        priceIsla: Number(it.priceIsla || 0),
        subtotal: Number(it.subtotal || 0),
        stockPackagesAtMoment: Number(it.stockPackagesAtMoment || 0),
      })),
      total: Number(orderTotal || 0),
      productsCount: Number(orderProductsTotal || 0),
      packagesTotal: Number(orderPackagesTotal || 0),
      status: "PENDIENTE" as PedidoStatus,
      updatedAt: Timestamp.now(),
    };

    setSaving(true);
    setMsg("");
    try {
      if (editingOrderId) {
        const current = possibleOrders.find((x) => x.id === editingOrderId);
        const keepStatus = current?.status || "PENDIENTE";

        await updateDoc(doc(db, POSSIBLE_ORDERS_COLLECTION, editingOrderId), {
          ...payload,
          status: keepStatus,
        });
        setMsg("✅ Pedido actualizado.");
      } else {
        await addDoc(collection(db, POSSIBLE_ORDERS_COLLECTION), {
          ...payload,
          createdAt: Timestamp.now(),
        });
        setMsg("✅ Pedido creado.");
      }

      clearOrderForm();
      await refreshAll();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error guardando pedido.");
    } finally {
      setSaving(false);
    }
  };

  const editOrder = (order: PossibleOrder) => {
    setTab("PEDIDOS");
    setEditingOrderId(order.id);
    setOrderDate(order.date || todayLocalISO());
    setOrderSellerId(order.sellerId || "");
    setCustomerName(order.customerName || "");
    setCustomerPhone(order.customerPhone || "");
    setCustomerAddress(order.customerAddress || "");
    setOrderItems(Array.isArray(order.items) ? order.items : []);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const finalizeOrder = async (order: PossibleOrder) => {
    if (order.status === "FINALIZADO") {
      setMsg("ℹ️ Ese pedido ya está finalizado.");
      return;
    }
    const ok = window.confirm(`¿Finalizar el pedido de ${order.customerName}?`);
    if (!ok) return;

    try {
      await updateDoc(doc(db, POSSIBLE_ORDERS_COLLECTION, order.id), {
        status: "FINALIZADO",
        finalizedAt: Timestamp.now(),
        updatedAt: Timestamp.now(),
      });
      setMsg("✅ Pedido finalizado.");
      await refreshAll();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error finalizando pedido.");
    }
  };

  const deleteOrder = async (order: PossibleOrder) => {
    const ok = window.confirm(`¿Eliminar el pedido de ${order.customerName}?`);
    if (!ok) return;

    try {
      await deleteDoc(doc(db, POSSIBLE_ORDERS_COLLECTION, order.id));
      setMsg("✅ Pedido eliminado.");
      if (editingOrderId === order.id) clearOrderForm();
      await refreshAll();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando pedido.");
    }
  };

  const renderStockTable = () => (
    <div className="hidden md:block bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-700">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Categoría</th>
              <th className="text-left px-4 py-3 font-semibold">Producto</th>
              <th className="text-right px-4 py-3 font-semibold">Stock</th>
              <th className="text-right px-4 py-3 font-semibold">Unidades</th>
              <th className="text-right px-4 py-3 font-semibold">
                Precio Isla
              </th>
              <th className="text-left px-4 py-3 font-semibold">Badges</th>
            </tr>
          </thead>
          <tbody>
            {filteredStock.length === 0 ? (
              <tr>
                <td
                  colSpan={6}
                  className="px-4 py-8 text-center text-slate-500"
                >
                  No hay productos para ese filtro.
                </td>
              </tr>
            ) : (
              filteredStock.map((r) => (
                <tr key={r.productId} className="border-t">
                  <td className="px-4 py-3">{r.category || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {r.productName}
                    </div>
                    <div className="text-xs text-slate-500">{r.productId}</div>
                  </td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {Number(r.stockPackages || 0)}
                  </td>
                  <td className="px-4 py-3 text-right">
                    {Number(r.stockUnits || 0)}
                  </td>
                  <td className="px-4 py-3 text-right">{money(r.priceIsla)}</td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 flex-wrap">
                      <span
                        className={`px-2 py-1 rounded-full border text-xs font-semibold ${statusBadgeClasses(
                          r.available ? "available" : "out",
                        )}`}
                      >
                        {r.available ? "Disponible" : "Agotado"}
                      </span>
                      <span
                        className={`px-2 py-1 rounded-full border text-xs font-semibold ${statusBadgeClasses(
                          assignedByNameMap[String(r.productId)]
                            ? "assigned"
                            : "unassigned",
                        )}`}
                      >
                        {assignedByNameMap[String(r.productId)]
                          ? `Asignado ${assignedByNameMap[String(r.productId)]}`
                          : "No asignado"}
                      </span>
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderStockMobile = () => (
    <div className="md:hidden space-y-3">
      {filteredStock.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 text-sm text-slate-500">
          No hay productos para ese filtro.
        </div>
      ) : (
        // Group paginated products by category and render collapsible category cards (mobile only)
        (() => {
          const cats = Array.from(
            new Set(paginatedStock.map((p) => p.category).filter(Boolean)),
          ).sort((a, b) => String(a).localeCompare(String(b), "es"));

          return cats.map((c) => {
            const products = paginatedStock.filter(
              (p) => (p.category || "") === c,
            );
            return (
              <div key={c} className="space-y-2">
                <div className="bg-white border border-slate-200 rounded-2xl shadow-sm">
                  <button
                    type="button"
                    onClick={() =>
                      setCategoryOpenMap((s) => ({ ...s, [c]: !s[c] }))
                    }
                    className={`w-full px-4 py-3 rounded-2xl flex items-center justify-between ${
                      categoryOpenMap[c]
                        ? "bg-yellow-50 border-yellow-200"
                        : "bg-white"
                    }`}
                  >
                    <div className="text-left">
                      <div className="font-semibold">{c}</div>
                      <div className="text-xs text-slate-500">
                        {products.length} productos
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      {categoryOpenMap[c] ? "Cerrar" : "Abrir"}
                    </div>
                  </button>

                  <div className={`${categoryOpenMap[c] ? "" : "hidden"} p-3`}>
                    {products.length === 0 ? (
                      <div className="text-sm text-slate-500">
                        No hay productos en esta categoría.
                      </div>
                    ) : (
                      <div className="space-y-2">
                        {products.map((p) => (
                          <ProductCard key={p.productId} product={p} />
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          });
        })()
      )}
    </div>
  );

  const renderOrdersTable = () => (
    <div className="hidden md:block bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-slate-700">
            <tr>
              <th className="text-left px-4 py-3 font-semibold">Fecha</th>
              <th className="text-left px-4 py-3 font-semibold">Vendedor</th>
              <th className="text-left px-4 py-3 font-semibold">Cliente</th>
              <th className="text-left px-4 py-3 font-semibold">Teléfono</th>
              <th className="text-right px-4 py-3 font-semibold">Productos</th>
              <th className="text-right px-4 py-3 font-semibold">Paquetes</th>
              <th className="text-right px-4 py-3 font-semibold">Total</th>
              <th className="text-left px-4 py-3 font-semibold">Estado</th>
              <th className="text-left px-4 py-3 font-semibold">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {filteredOrders.length === 0 ? (
              <tr>
                <td
                  colSpan={9}
                  className="px-4 py-8 text-center text-slate-500"
                >
                  No hay pedidos en ese rango/filtro.
                </td>
              </tr>
            ) : (
              filteredOrders.map((o) => (
                <tr key={o.id} className="border-t align-top">
                  <td className="px-4 py-3">{o.date}</td>
                  <td className="px-4 py-3">{o.sellerName || "—"}</td>
                  <td className="px-4 py-3">
                    <div className="font-medium text-slate-900">
                      {o.customerName || "—"}
                    </div>
                    {o.customerAddress ? (
                      <div className="text-xs text-slate-500 mt-0.5">
                        {o.customerAddress}
                      </div>
                    ) : null}
                  </td>
                  <td className="px-4 py-3">{o.customerPhone || "—"}</td>
                  <td className="px-4 py-3 text-right">{o.productsCount}</td>
                  <td className="px-4 py-3 text-right">{o.packagesTotal}</td>
                  <td className="px-4 py-3 text-right font-semibold">
                    {money(o.total)}
                  </td>
                  <td className="px-4 py-3">
                    <span
                      className={`px-2 py-1 rounded-full border text-xs font-semibold ${
                        o.status === "FINALIZADO"
                          ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                          : "bg-amber-50 text-amber-700 border-amber-200"
                      }`}
                    >
                      {o.status}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800"
                        onClick={() => editOrder(o)}
                      >
                        Editar
                      </button>
                      <button
                        type="button"
                        className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700"
                        onClick={() => deleteOrder(o)}
                      >
                        Eliminar
                      </button>
                      {o.status !== "FINALIZADO" ? (
                        <button
                          type="button"
                          className="px-3 py-1.5 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                          onClick={() => finalizeOrder(o)}
                        >
                          Finalizar
                        </button>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );

  const renderOrdersMobile = () => (
    <div className="md:hidden space-y-3">
      {filteredOrders.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 text-sm text-slate-500">
          No hay pedidos en ese rango/filtro.
        </div>
      ) : (
        filteredOrders.map((o) => (
          <div
            key={o.id}
            className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4"
          >
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="font-semibold text-slate-900">
                  {o.customerName || "—"}
                </div>
                <div className="text-xs text-slate-500 mt-0.5">
                  {o.date} • {o.sellerName || "—"}
                </div>
              </div>
              <span
                className={`px-2 py-1 rounded-full border text-xs font-semibold ${
                  o.status === "FINALIZADO"
                    ? "bg-emerald-50 text-emerald-700 border-emerald-200"
                    : "bg-amber-50 text-amber-700 border-amber-200"
                }`}
              >
                {o.status}
              </span>
            </div>

            <div className="grid grid-cols-2 gap-3 mt-4 text-sm">
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">Productos</div>
                <div className="font-bold text-lg">{o.productsCount}</div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3">
                <div className="text-xs text-slate-500">Paquetes</div>
                <div className="font-bold text-lg">{o.packagesTotal}</div>
              </div>
              <div className="rounded-xl bg-slate-50 p-3 col-span-2">
                <div className="text-xs text-slate-500">Total</div>
                <div className="font-bold text-lg">{money(o.total)}</div>
              </div>
            </div>

            <div className="mt-3 text-sm text-slate-600">
              <div>Tel: {o.customerPhone || "—"}</div>
              <div>Dir: {o.customerAddress || "—"}</div>
            </div>

            <div className="flex gap-2 flex-wrap mt-4">
              <button
                type="button"
                className="px-3 py-2 rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-800"
                onClick={() => editOrder(o)}
              >
                Editar
              </button>
              <button
                type="button"
                className="px-3 py-2 rounded-lg bg-red-50 hover:bg-red-100 text-red-700"
                onClick={() => deleteOrder(o)}
              >
                Eliminar
              </button>
              {o.status !== "FINALIZADO" ? (
                <button
                  type="button"
                  className="px-3 py-2 rounded-lg bg-emerald-50 hover:bg-emerald-100 text-emerald-700"
                  onClick={() => finalizeOrder(o)}
                >
                  Finalizar
                </button>
              ) : null}
            </div>
          </div>
        ))
      )}
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-900">Stock y Pedidos</h2>
          <div className="text-sm text-slate-500">
            Stock maestro desde <b>candy_main_orders</b> y asignación desde{" "}
            <b>inventory_candies_sellers</b>.
          </div>
        </div>

        <div className="flex gap-2 flex-wrap">
          <button
            type="button"
            onClick={() => setTab("STOCK")}
            className={`px-4 py-2 rounded-full border text-sm font-semibold ${
              tab === "STOCK"
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-700 border-slate-300"
            }`}
          >
            Stock
          </button>
          <button
            type="button"
            onClick={() => setTab("PEDIDOS")}
            className={`px-4 py-2 rounded-full border text-sm font-semibold ${
              tab === "PEDIDOS"
                ? "bg-slate-900 text-white border-slate-900"
                : "bg-white text-slate-700 border-slate-300"
            }`}
          >
            Pedidos
          </button>
          <button
            type="button"
            onClick={refreshAll}
            className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 text-sm font-semibold"
          >
            Refrescar
          </button>
        </div>
      </div>

      {/* filtros globales (visible en móvil para PEDIDOS y STOCK) */}
      {tab === "PEDIDOS" || tab === "STOCK" ? (
        <div className="md:hidden mb-3">
          <button
            type="button"
            onClick={() => setGlobalFiltersOpenMobile((v) => !v)}
            className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
              globalFiltersOpenMobile
                ? "bg-yellow-50 border-yellow-200"
                : "bg-white border-slate-200"
            }`}
          >
            <div className="text-left">
              <div className="font-semibold">Filtros</div>
              <div className="text-xs text-slate-500">
                Desde / Hasta / Vendedor
              </div>
            </div>
            <div className="text-sm font-semibold">
              {globalFiltersOpenMobile ? "Cerrar" : "Abrir"}
            </div>
          </button>
        </div>
      ) : null}

      <div className={`${globalFiltersOpenMobile ? "" : "hidden"} md:block`}>
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 mb-4">
          <div className="grid grid-cols-1 md:grid-cols-5 gap-3 items-end">
            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Desde
              </label>
              <input
                type="date"
                className="w-full border rounded-xl px-3 py-2"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700">
                Hasta
              </label>
              <input
                type="date"
                className="w-full border rounded-xl px-3 py-2"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>

            <div className="md:col-span-2">
              <label className="block text-xs font-semibold text-slate-700">
                Vendedor
              </label>
              <select
                className="w-full border rounded-xl px-3 py-2"
                value={selectedSellerId}
                onChange={(e) => setSelectedSellerId(e.target.value)}
                disabled={Boolean(sellerCandyId && (isVendDulces || !isAdmin))}
              >
                <option value="">Todos</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex items-end">
              <div className="text-xs text-slate-500">
                {loading ? "Cargando..." : "Datos actualizados"}
              </div>
            </div>
          </div>

          {msg ? (
            <div className="mt-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
              {msg}
            </div>
          ) : null}
        </div>
      </div>

      {tab === "STOCK" ? (
        <>
          {/* Desktop/tablet: two KPI cards. Mobile: single card with two columns */}
          <div className="hidden md:grid grid-cols-2 gap-3 mb-4">
            <KpiCard label="Stock" value={stockKpis.stockPackages} />
            <KpiCard label="Productos" value={stockKpis.productsCount} />
          </div>

          <div className="md:hidden mb-4">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">
                    Stock
                  </div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {stockKpis.stockPackages}
                  </div>
                </div>

                <div>
                  <div className="text-xs uppercase tracking-wide text-slate-500">
                    Productos
                  </div>
                  <div className="mt-1 text-2xl font-bold text-slate-900">
                    {stockKpis.productsCount}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* filtros stock mobile */}
          <div className="md:hidden mb-3">
            <button
              type="button"
              onClick={() => setFiltersOpenMobile((v) => !v)}
              className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
                stockProductFilter || stockCategoryFilter || onlyAvailable
                  ? "bg-yellow-50 border-yellow-200"
                  : "bg-white border-slate-200"
              }`}
            >
              <div className="text-left">
                <div className="font-semibold">Filtros de stock</div>
                <div className="text-xs text-slate-500">
                  {filteredStock.length} productos visibles
                </div>
              </div>
              <div className="text-sm font-semibold">
                {filtersOpenMobile ? "Cerrar" : "Abrir"}
              </div>
            </button>

            {filtersOpenMobile ? (
              <div className="mt-2 bg-white border border-slate-200 rounded-2xl shadow-sm p-3 space-y-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Producto
                  </label>
                  <input
                    className="w-full border rounded-xl px-3 py-2"
                    value={stockProductFilter}
                    onChange={(e) => setStockProductFilter(e.target.value)}
                    placeholder="Buscar producto..."
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Categoría
                  </label>
                  <select
                    className="w-full border rounded-xl px-3 py-2"
                    value={stockCategoryFilter}
                    onChange={(e) => setStockCategoryFilter(e.target.value)}
                  >
                    <option value="">Todas</option>
                    {categories.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                </div>

                <label className="flex items-center justify-between rounded-xl border px-3 py-3">
                  <div>
                    <div className="font-semibold text-sm">
                      Todos / Disponibles
                    </div>
                    <div className="text-xs text-slate-500">
                      {onlyAvailable
                        ? "Mostrando solo stock mayor a 0"
                        : "Mostrando todos, incluyendo stock 0"}
                    </div>
                  </div>
                  <input
                    type="checkbox"
                    className="h-5 w-5"
                    checked={onlyAvailable}
                    onChange={(e) => setOnlyAvailable(e.target.checked)}
                  />
                </label>

                <button
                  type="button"
                  className="w-full px-3 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold"
                  onClick={() => {
                    setStockProductFilter("");
                    setStockCategoryFilter("");
                    setOnlyAvailable(false);
                  }}
                >
                  Limpiar filtros
                </button>
              </div>
            ) : null}
          </div>

          {/* filtros stock web */}
          <div className="hidden md:block bg-white border border-slate-200 rounded-2xl shadow-sm p-4 mb-3">
            <div className="grid grid-cols-4 gap-3 items-end">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Filtrar por producto
                </label>
                <input
                  className="w-full border rounded-xl px-3 py-2"
                  value={stockProductFilter}
                  onChange={(e) => setStockProductFilter(e.target.value)}
                  placeholder="Ej: Bombón, Conito..."
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Filtrar por categoría
                </label>
                <select
                  className="w-full border rounded-xl px-3 py-2"
                  value={stockCategoryFilter}
                  onChange={(e) => setStockCategoryFilter(e.target.value)}
                >
                  <option value="">Todas</option>
                  {categories.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Mostrar
                </label>
                <div className="flex items-center gap-3 border rounded-xl px-3 py-2 h-[42px]">
                  <span
                    className={`text-sm ${!onlyAvailable ? "font-semibold" : "text-slate-500"}`}
                  >
                    Todos
                  </span>
                  <input
                    type="checkbox"
                    checked={onlyAvailable}
                    onChange={(e) => setOnlyAvailable(e.target.checked)}
                  />
                  <span
                    className={`text-sm ${onlyAvailable ? "font-semibold" : "text-slate-500"}`}
                  >
                    Disponibles
                  </span>
                </div>
              </div>

              <div className="text-right">
                <button
                  type="button"
                  className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold"
                  onClick={() => {
                    setStockProductFilter("");
                    setStockCategoryFilter("");
                    setOnlyAvailable(false);
                  }}
                >
                  Limpiar filtros
                </button>
              </div>
            </div>
          </div>

          {renderStockTable()}
          {renderStockMobile()}

          {/* Paginación stock */}
          <div className="mt-3 flex items-center justify-between">
            <div className="text-sm text-slate-500">
              {filteredStock.length === 0
                ? "Sin resultados"
                : `Mostrando ${Math.min(filteredStock.length, STOCK_PAGE_SIZE)} de ${filteredStock.length}`}
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setStockPage((s) => Math.max(1, s - 1))}
                disabled={stockPage <= 1}
                className={`px-3 py-2 rounded-lg text-sm border ${stockPage <= 1 ? "text-slate-400 border-slate-200 bg-white" : "bg-white hover:bg-slate-50 text-slate-700"}`}
              >
                Anterior
              </button>

              <div className="text-sm text-slate-700">
                Página {stockPage} / {totalStockPages}
              </div>

              <button
                type="button"
                onClick={() =>
                  setStockPage((s) => Math.min(totalStockPages, s + 1))
                }
                disabled={stockPage >= totalStockPages}
                className={`px-3 py-2 rounded-lg text-sm border ${stockPage >= totalStockPages ? "text-slate-400 border-slate-200 bg-white" : "bg-white hover:bg-slate-50 text-slate-700"}`}
              >
                Siguiente
              </button>
            </div>
          </div>
        </>
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-7 gap-3">
            <KpiCard label="Pedidos" value={orderKpis.totalPedidos} />
            <KpiCard label="Pendientes" value={orderKpis.pendientes} />
            <KpiCard label="Finalizados" value={orderKpis.finalizados} />
            <KpiCard label="Monto PF" value={money(orderKpis.montoPF)} />
            <KpiCard label="Monto PP" value={money(orderKpis.montoPP)} />
            <KpiCard
              label="Productos totales"
              value={orderKpis.productosTotales}
            />
            <KpiCard
              label="Paquetes totales"
              value={orderKpis.paquetesTotales}
            />
          </div>

          <SectionCard
            title={editingOrderId ? "Editar pedido" : "Crear pedido"}
            subtitle="Registro de posible venta. No descuenta inventario."
          >
            <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
              {/* vendedor */}
              <div className="space-y-4">
                <div className="md:hidden mb-3">
                  <button
                    type="button"
                    onClick={() =>
                      setMobileOpenSections((s) => ({
                        ...s,
                        vendedor: !s.vendedor,
                      }))
                    }
                    className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
                      mobileOpenSections.vendedor
                        ? "bg-yellow-50 border-yellow-200"
                        : "bg-white border-slate-200"
                    }`}
                  >
                    <div className="text-left">
                      <div className="font-semibold">Datos del vendedor</div>
                      <div className="text-xs text-slate-500">
                        Seleccioná vendedor y fecha de pedido
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      {mobileOpenSections.vendedor ? "Cerrar" : "Abrir"}
                    </div>
                  </button>
                </div>

                <div
                  className={`${mobileOpenSections.vendedor ? "" : "hidden"} md:block`}
                >
                  <SectionCard title="Datos del vendedor">
                    <div className="space-y-3">
                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          Vendedor
                        </label>
                        <select
                          className="w-full border rounded-xl px-3 py-2"
                          value={orderSellerId}
                          onChange={(e) => setOrderSellerId(e.target.value)}
                          disabled={Boolean(
                            sellerCandyId && (isVendDulces || !isAdmin),
                          )}
                        >
                          <option value="">Seleccionar</option>
                          {vendors.map((v) => (
                            <option key={v.id} value={v.id}>
                              {v.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-xs font-semibold text-slate-700">
                          Fecha de pedido
                        </label>
                        <input
                          type="date"
                          className="w-full border rounded-xl px-3 py-2"
                          value={orderDate}
                          onChange={(e) => setOrderDate(e.target.value)}
                        />
                      </div>

                      <div className="rounded-xl bg-slate-50 p-3 text-sm">
                        <div className="text-xs text-slate-500">
                          Contenedor vendedor
                        </div>
                        <div className="font-semibold text-slate-900 mt-1">
                          {orderSeller?.name || "Sin seleccionar"}
                        </div>
                      </div>
                    </div>
                  </SectionCard>
                </div>
              </div>

              <div className="md:hidden mb-3">
                <button
                  type="button"
                  onClick={() =>
                    setMobileOpenSections((s) => ({
                      ...s,
                      cliente: !s.cliente,
                    }))
                  }
                  className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
                    mobileOpenSections.cliente
                      ? "bg-yellow-50 border-yellow-200"
                      : "bg-white border-slate-200"
                  }`}
                >
                  <div className="text-left">
                    <div className="font-semibold">Datos del cliente</div>
                    <div className="text-xs text-slate-500">
                      Nombre, teléfono y dirección
                    </div>
                  </div>
                  <div className="text-sm font-semibold">
                    {mobileOpenSections.cliente ? "Cerrar" : "Abrir"}
                  </div>
                </button>
              </div>

              <div
                className={`${mobileOpenSections.cliente ? "" : "hidden"} md:block`}
              >
                <SectionCard title="Datos del cliente">
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Nombre del cliente
                      </label>
                      <input
                        className="w-full border rounded-xl px-3 py-2"
                        value={customerName}
                        onChange={(e) => setCustomerName(e.target.value)}
                        placeholder="Nombre del cliente"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Número de teléfono
                      </label>
                      <input
                        className="w-full border rounded-xl px-3 py-2"
                        value={customerPhone}
                        onChange={(e) => setCustomerPhone(e.target.value)}
                        placeholder="Teléfono"
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Dirección
                      </label>
                      <textarea
                        className="w-full border rounded-xl px-3 py-2 min-h-[96px]"
                        value={customerAddress}
                        onChange={(e) => setCustomerAddress(e.target.value)}
                        placeholder="Dirección del cliente"
                      />
                    </div>
                  </div>
                </SectionCard>
              </div>
            </div>

            {/* productos */}
            <div className="xl:col-span-2 space-y-4">
              <div className="md:hidden mb-3">
                <button
                  type="button"
                  onClick={() =>
                    setMobileOpenSections((s) => ({ ...s, pedido: !s.pedido }))
                  }
                  className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
                    mobileOpenSections.pedido
                      ? "bg-yellow-50 border-yellow-200"
                      : "bg-white border-slate-200"
                  }`}
                >
                  <div className="text-left">
                    <div className="font-semibold">Datos del pedido</div>
                    <div className="text-xs text-slate-500">
                      Podés agregar productos aunque su stock sea 0
                    </div>
                  </div>
                  <div className="text-sm font-semibold">
                    {mobileOpenSections.pedido ? "Cerrar" : "Abrir"}
                  </div>
                </button>
              </div>

              <div
                className={`${mobileOpenSections.pedido ? "" : "hidden"} md:block`}
              >
                <SectionCard
                  title="Datos del pedido"
                  subtitle="Podés agregar productos aunque su stock sea 0"
                >
                  <div className="grid grid-cols-1 lg:grid-cols-[1fr_220px_auto] gap-3 items-end">
                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Buscar producto
                      </label>
                      <input
                        className="w-full border rounded-xl px-3 py-2"
                        value={productSearch}
                        onChange={(e) => setProductSearch(e.target.value)}
                        placeholder="Buscar por nombre, categoría o id..."
                      />
                    </div>

                    <div>
                      <label className="block text-xs font-semibold text-slate-700">
                        Seleccionar
                      </label>
                      <select
                        className="w-full border rounded-xl px-3 py-2"
                        value={selectedCatalogProductId}
                        onChange={(e) =>
                          setSelectedCatalogProductId(e.target.value)
                        }
                      >
                        <option value="">Seleccionar producto</option>
                        {productSearchResults.map((p) => (
                          <option key={p.productId} value={p.productId}>
                            {p.productName} • {p.category || "—"} • Stock:{" "}
                            {p.stockPackages}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <button
                        type="button"
                        className="w-full px-4 py-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold"
                        onClick={() => {
                          if (!selectedCatalogProductId) return;
                          addCatalogProductToOrder(selectedCatalogProductId);
                          setSelectedCatalogProductId("");
                        }}
                      >
                        Agregar
                      </button>
                    </div>
                  </div>

                  <div className="mt-4">
                    <div className="hidden md:block overflow-x-auto border rounded-2xl">
                      <table className="w-full text-sm">
                        <thead className="bg-slate-50">
                          <tr>
                            <th className="text-left px-3 py-2 font-semibold">
                              Producto
                            </th>
                            <th className="text-left px-3 py-2 font-semibold">
                              Categoría
                            </th>
                            <th className="text-right px-3 py-2 font-semibold">
                              Stock
                            </th>
                            <th className="text-right px-3 py-2 font-semibold">
                              Precio Isla
                            </th>
                            <th className="text-right px-3 py-2 font-semibold">
                              Paquetes
                            </th>
                            <th className="text-right px-3 py-2 font-semibold">
                              Subtotal
                            </th>
                            <th className="text-left px-3 py-2 font-semibold">
                              Acción
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {orderItems.length === 0 ? (
                            <tr>
                              <td
                                colSpan={7}
                                className="px-3 py-8 text-center text-slate-500"
                              >
                                Aún no hay productos agregados.
                              </td>
                            </tr>
                          ) : (
                            orderItems.map((it) => (
                              <tr key={it.productId} className="border-t">
                                <td className="px-3 py-2">
                                  <div className="font-medium">
                                    {it.productName}
                                  </div>
                                  <div className="text-xs text-slate-500">
                                    {it.productId}
                                  </div>
                                </td>
                                <td className="px-3 py-2">
                                  {it.category || "—"}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  {it.stockPackagesAtMoment}
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    className="w-24 border rounded-lg px-2 py-1 text-right"
                                    inputMode="decimal"
                                    value={String(it.priceIsla)}
                                    onChange={(e) =>
                                      updateOrderItem(it.productId, {
                                        priceIsla: toNum(e.target.value, 0),
                                      })
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2 text-right">
                                  <input
                                    className="w-20 border rounded-lg px-2 py-1 text-right"
                                    inputMode="numeric"
                                    value={String(it.qtyPackages)}
                                    onChange={(e) =>
                                      updateOrderItem(it.productId, {
                                        qtyPackages: Math.max(
                                          0,
                                          Math.floor(toNum(e.target.value, 0)),
                                        ),
                                      })
                                    }
                                  />
                                </td>
                                <td className="px-3 py-2 text-right font-semibold">
                                  {money(it.subtotal)}
                                </td>
                                <td className="px-3 py-2">
                                  <button
                                    type="button"
                                    className="px-3 py-1.5 rounded-lg bg-red-50 hover:bg-red-100 text-red-700"
                                    onClick={() =>
                                      removeOrderItem(it.productId)
                                    }
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

                    <div className="md:hidden space-y-3">
                      {orderItems.length === 0 ? (
                        <div className="rounded-2xl border p-4 text-sm text-slate-500">
                          Aún no hay productos agregados.
                        </div>
                      ) : (
                        orderItems.map((it) => (
                          <div
                            key={it.productId}
                            className="rounded-2xl border p-4 bg-white"
                          >
                            <div className="flex items-start justify-between gap-3">
                              <div>
                                <div className="font-semibold">
                                  {it.productName}
                                </div>
                                <div className="text-xs text-slate-500">
                                  {it.category || "—"}
                                </div>
                              </div>
                              <button
                                type="button"
                                className="px-3 py-1.5 rounded-lg bg-red-50 text-red-700"
                                onClick={() => removeOrderItem(it.productId)}
                              >
                                Quitar
                              </button>
                            </div>

                            <div className="grid grid-cols-2 gap-3 mt-3">
                              <div>
                                <label className="block text-xs font-semibold text-slate-700">
                                  Stock
                                </label>
                                <div className="w-full border rounded-xl px-3 py-2 bg-slate-50">
                                  {it.stockPackagesAtMoment}
                                </div>
                              </div>

                              <div>
                                <label className="block text-xs font-semibold text-slate-700">
                                  Precio Isla
                                </label>
                                <input
                                  className="w-full border rounded-xl px-3 py-2 text-right"
                                  inputMode="decimal"
                                  value={String(it.priceIsla)}
                                  onChange={(e) =>
                                    updateOrderItem(it.productId, {
                                      priceIsla: toNum(e.target.value, 0),
                                    })
                                  }
                                />
                              </div>

                              <div>
                                <label className="block text-xs font-semibold text-slate-700">
                                  Paquetes
                                </label>
                                <input
                                  className="w-full border rounded-xl px-3 py-2 text-right"
                                  inputMode="numeric"
                                  value={String(it.qtyPackages)}
                                  onChange={(e) =>
                                    updateOrderItem(it.productId, {
                                      qtyPackages: Math.max(
                                        0,
                                        Math.floor(toNum(e.target.value, 0)),
                                      ),
                                    })
                                  }
                                />
                              </div>

                              <div>
                                <label className="block text-xs font-semibold text-slate-700">
                                  Subtotal
                                </label>
                                <div className="w-full border rounded-xl px-3 py-2 bg-slate-50 text-right font-semibold">
                                  {money(it.subtotal)}
                                </div>
                              </div>
                            </div>
                          </div>
                        ))
                      )}
                    </div>
                  </div>

                  <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Productos</div>
                      <div className="font-bold text-xl">
                        {orderProductsTotal}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Paquetes</div>
                      <div className="font-bold text-xl">
                        {orderPackagesTotal}
                      </div>
                    </div>
                    <div className="rounded-xl bg-slate-50 p-3">
                      <div className="text-xs text-slate-500">Total</div>
                      <div className="font-bold text-xl">
                        {money(orderTotal)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-4 flex flex-col md:flex-row gap-3">
                    <button
                      type="button"
                      className="px-4 py-3 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold"
                      onClick={savePossibleOrder}
                      disabled={saving}
                    >
                      {saving
                        ? "Guardando..."
                        : editingOrderId
                          ? "Guardar cambios"
                          : "Crear pedido"}
                    </button>

                    <button
                      type="button"
                      className="px-4 py-3 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold"
                      onClick={clearOrderForm}
                    >
                      Limpiar formulario
                    </button>
                  </div>
                </SectionCard>
              </div>
            </div>
          </SectionCard>

          <div className="md:hidden mb-3">
            <button
              type="button"
              onClick={() =>
                setMobileOpenSections((s) => ({ ...s, listado: !s.listado }))
              }
              className={`w-full px-4 py-3 rounded-2xl border shadow-sm flex items-center justify-between ${
                mobileOpenSections.listado
                  ? "bg-yellow-50 border-yellow-200"
                  : "bg-white border-slate-200"
              }`}
            >
              <div className="text-left">
                <div className="font-semibold">Listado de pedidos</div>
                <div className="text-xs text-slate-500">
                  Acciones: editar, eliminar y finalizar
                </div>
              </div>
              <div className="text-sm font-semibold">
                {mobileOpenSections.listado ? "Cerrar" : "Abrir"}
              </div>
            </button>
          </div>

          <div
            className={`${mobileOpenSections.listado ? "" : "hidden"} md:block`}
          >
            <SectionCard
              title="Listado de pedidos"
              subtitle="Acciones: editar, eliminar y finalizar"
            >
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Buscar
                  </label>
                  <input
                    className="w-full border rounded-xl px-3 py-2"
                    value={ordersSearch}
                    onChange={(e) => setOrdersSearch(e.target.value)}
                    placeholder="Cliente, producto, teléfono..."
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-700">
                    Estado
                  </label>
                  <select
                    className="w-full border rounded-xl px-3 py-2"
                    value={ordersStatusFilter}
                    onChange={(e) =>
                      setOrdersStatusFilter(e.target.value as "" | PedidoStatus)
                    }
                  >
                    <option value="">Todos</option>
                    <option value="PENDIENTE">Pendiente</option>
                    <option value="FINALIZADO">Finalizado</option>
                  </select>
                </div>

                <div className="md:col-span-2 flex items-end">
                  <button
                    type="button"
                    className="px-4 py-2 rounded-xl bg-slate-200 hover:bg-slate-300 text-slate-800 font-semibold"
                    onClick={() => {
                      setOrdersSearch("");
                      setOrdersStatusFilter("");
                    }}
                  >
                    Limpiar filtros
                  </button>
                </div>
              </div>

              {renderOrdersTable()}
              {renderOrdersMobile()}
            </SectionCard>
          </div>
        </div>
      )}
    </div>
  );
}
