// src/components/Candies/VendorCandyOrders.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  runTransaction,
  arrayUnion,
  writeBatch,
} from "firebase/firestore";
import { db } from "../../../firebase";
import RefreshButton from "../../common/RefreshButton";
import useManualRefresh from "../../../hooks/useManualRefresh";
import { hasRole } from "../../../utils/roles";
import {
  deleteVendorCandyOrderAndRestore,
  allocateVendorCandyPacks,
  restoreVendorCandyPacks,
} from "../../../Services/Candies_vendor_orders";
import TrasladosModal from "./TrasladosModal";

// ===== Tipos base =====
type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

interface Seller {
  id: string;
  name: string;
  email?: string;

  // ⚠️ MISMO CAMPO EN BD para no romper nada.
  // Ahora significa: Margen del vendedor (% sobre Utilidad Aproximada).
  commissionPercent?: number;

  branch?: Branch;
  branchLabel?: string;
}

/**
 * Producto “disponible” viene de candy_main_orders (orden maestra)
 * - existingPacks = SUMA remainingPackages en todas las órdenes maestras
 * - price* = unitPrice* (por paquete)
 * - uApproxPerPack* = Utilidad Aproximada POR PAQUETE (viene desde Orden Maestra)
 */
interface ProductCandyFromMain {
  id: string; // productId
  name: string;
  category: string;

  unitsPerPackage: number;

  // Precio de proveedor por paquete (desde orden maestra)
  providerPrice: number;

  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  grossProfitPerPackRivas: number;
  grossProfitPerPackSanJorge: number;
  grossProfitPerPackIsla: number;

  uApproxPerPackRivas: number;
  uApproxPerPackSanJorge: number;
  uApproxPerPackIsla: number;

  // Prorrateo logístico por paquete (desde Orden Maestra)
  logisticAllocatedPerPack: number;

  existingPacks: number;
}

// Sub-inventario por vendedor (cada doc = 1 producto de 1 pedido)
interface VendorCandyRow {
  id: string;
  sellerId: string;
  sellerName: string;

  productId: string;
  productName: string;
  category: string;

  orderId?: string | null;

  packages: number;
  unitsPerPackage: number;
  totalUnits: number;

  remainingPackages: number;
  remainingUnits: number;

  // Totales por sucursal (por pedido)
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;

  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  grossProfit: number; // U. Bruta total

  // Gastos (prorrateo logístico) por producto
  logisticAllocated?: number;

  // === PLAN: mover cálculo aquí ===
  vendorMarginPercent: number; // % vendedor sobre U Aproximada
  uAproximada: number; // total
  uVendor: number; // U. Vendedor
  uInvestor: number; // U. Inversionista

  // ⚠️ Compatibilidad: se mantiene vendorProfit (pero ahora equivale a uVendor)
  vendorProfit: number;

  transferDelta?: number;

  subtotal?: number;
  providerPrice?: number;

  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
}

// Ítem de pedido (UI del modal)
interface OrderItem {
  id: string;
  productId: string;
  productName: string;
  category: string;

  unitsPerPackage: number;
  packages: number;

  totalExpected: number;
  pricePerPackage: number;

  // Solo visible para admin en UI/CSV
  providerPrice?: number;

  grossProfit: number;

  // Gastos (prorrateo logístico) por producto
  logisticAllocated: number;

  // === PLAN ===
  vendorMarginPercent: number;
  uAproximada: number;
  uVendor: number;
  uInvestor: number;

  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;

  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  remainingPackages: number; // ✅ NO se quita
  transferDelta?: number;
}

// Resumen de pedido para listado
interface OrderSummaryRow {
  orderKey: string;
  sellerId: string;
  sellerName: string;
  date: string;

  totalPackages: number;
  totalActivePackages: number;
  totalRemainingPackages: number;

  totalExpected: number;
  totalExpectedActive: number;
  grossProfit: number;
  grossProfitActive: number;
  vendorProfit: number; // ahora = U. Vendedor (por compat)
  vendorProfitActive: number;

  // Gastos prorrateados traídos desde la orden maestra (sum por productos)
  gastos?: number;
  gastosActive?: number;

  transferredOut: number;
  transferredIn: number;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface VendorCandyOrdersProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
  roles?: string[];
}

function normalizeBranch(raw: any): Branch | undefined {
  const v = String(raw || "")
    .trim()
    .toUpperCase();
  if (v.includes("ISLA")) return "ISLA";
  if (v.includes("JORGE")) return "SAN_JORGE";
  if (v.includes("RIVAS")) return "RIVAS";
  return undefined;
}

const floor = (n: any) => Math.max(0, Math.floor(Number(n || 0)));

const escapeCsv = (v: any) => {
  const s = String(v ?? "");
  if (/[,"\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
};

const parseCsv = (text: string) => {
  const rowsParsed: string[][] = [];
  let cur: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ",") {
      cur.push(field);
      field = "";
      continue;
    }

    if (ch === "\n") {
      cur.push(field);
      field = "";
      if (cur.some((x) => String(x ?? "").trim() !== "")) rowsParsed.push(cur);
      cur = [];
      continue;
    }

    if (ch === "\r") continue;

    field += ch;
  }

  cur.push(field);
  if (cur.some((x) => String(x ?? "").trim() !== "")) rowsParsed.push(cur);

  return rowsParsed;
};

const clampPercent = (n: any) => {
  const v = Number(n || 0);
  if (!isFinite(v)) return 0;
  if (v < 0) return 0;
  return v;
};

const calcSplit = (uAproximada: number, vendorMarginPercent: number) => {
  const pct = clampPercent(vendorMarginPercent);
  const uVendor = Number(uAproximada || 0) * (pct / 100);
  const uInvestor = Number(uAproximada || 0) - uVendor;
  return {
    uAproximada: Number(uAproximada || 0),
    vendorMarginPercent: pct,
    uVendor,
    uInvestor,
  };
};

const calcSplitFromGross = (
  grossProfit: number,
  vendorMarginPercent: number,
) => {
  const pct = clampPercent(vendorMarginPercent);
  const uVendor = Number(grossProfit || 0) * (pct / 100);
  const uInvestor = Number(grossProfit || 0) - uVendor;
  return {
    vendorMarginPercent: pct,
    uVendor,
    uInvestor,
  };
};
export default function VendorCandyOrders({
  role = "",
  sellerCandyId = "",
  currentUserEmail,
  roles,
}: VendorCandyOrdersProps) {
  const { refreshKey, refresh } = useManualRefresh();

  const subject = roles && roles.length ? roles : role;
  const isAdmin = !subject || hasRole(subject, "admin");
  const isVendor = hasRole(subject, "vendedor_dulces");
  const currentEmailNorm = (currentUserEmail || "").trim().toLowerCase();
  const isReadOnly = !isAdmin && isVendor;

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // ===== Catálogos =====
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [productsAll, setProductsAll] = useState<ProductCandyFromMain[]>([]);
  const [availablePacks, setAvailablePacks] = useState<Record<string, number>>(
    {},
  );

  // ===== Sub-inventario (docs por vendedor) =====
  const [rows, setRows] = useState<VendorCandyRow[]>([]);
  const rowsByIdRef = useRef<Record<string, VendorCandyRow>>({});

  useEffect(() => {
    const map: Record<string, VendorCandyRow> = {};
    rows.forEach((r) => {
      map[r.id] = r;
    });
    rowsByIdRef.current = map;
  }, [rows]);

  // ===== Modal pedido =====
  const [openForm, setOpenForm] = useState(false);
  const [editingOrderKey, setEditingOrderKey] = useState<string | null>(null);

  const [sellerId, setSellerId] = useState<string>("");
  const [date, setDate] = useState<string>("");

  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [packagesToAdd, setPackagesToAdd] = useState<string>("0");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [productSearch, setProductSearch] = useState("");
  const [associatedSearch, setAssociatedSearch] = useState("");

  const [isSaving, setIsSaving] = useState(false);
  const [isBackfilling, setIsBackfilling] = useState(false);

  // ===== Mobile collapse (filtros + KPIs) =====
  const [mobileMetaOpen, setMobileMetaOpen] = useState(false);

  // ===== Listado: paginado 20 =====
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  // ===== Modal items: paginado 20 =====
  const ITEMS_PAGE_SIZE = 20;
  const [itemsPage, setItemsPage] = useState(1);
  const [openCategoryMap, setOpenCategoryMap] = useState<
    Record<string, boolean>
  >({});
  const [mobileAddOpen, setMobileAddOpen] = useState(false);

  // ===== Mobile cards =====

  // ===== Traslados (agg) =====
  const [transferAgg, setTransferAgg] = useState<
    Record<string, { out: number; in: number }>
  >({});
  const [transferRowDeltas, setTransferRowDeltas] = useState<
    Record<string, number>
  >({});
  const [openTransferModal, setOpenTransferModal] = useState(false);

  const selectedSeller = useMemo(
    () => sellers.find((s) => s.id === sellerId) || null,
    [sellerId, sellers],
  );

  const sellerBranch: Branch | undefined = selectedSeller?.branch;

  useEffect(() => {
    if (!openForm || !sellerId || !orderItems.length) return;

    setOrderItems((prev) =>
      prev.map((it) => {
        const p = productsAll.find((x) => x.id === it.productId) || null;
        const s = sellers.find((x) => x.id === sellerId) || null;
        const br = s?.branch;

        const packs = floor(it.packages);

        const pricePerPackage = p
          ? getPricePerPack(p, br)
          : Number(it.pricePerPackage || 0);

        const grossPerPack = p ? getGrossProfitPerPack(p, br) : 0;
        const grossProfit = grossPerPack * packs;

        const logisticAllocated = p
          ? p.logisticAllocatedPerPack * packs
          : Number(it.logisticAllocated || 0);

        const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
        const uAproximada = uApproxPerPack * packs;

        const sellerMargin = getSellerMarginPercent(sellerId);
        const vendorMarginPercent = sellerMargin;

        const split = calcSplitFromGross(grossProfit, vendorMarginPercent);

        return {
          ...it,
          pricePerPackage,
          totalExpected: pricePerPackage * packs,
          grossProfit,
          logisticAllocated,
          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,
          totalRivas: (p?.unitPriceRivas || it.unitPriceRivas || 0) * packs,
          totalSanJorge:
            (p?.unitPriceSanJorge || it.unitPriceSanJorge || 0) * packs,
          totalIsla: (p?.unitPriceIsla || it.unitPriceIsla || 0) * packs,
          unitPriceRivas: p?.unitPriceRivas || it.unitPriceRivas || 0,
          unitPriceSanJorge: p?.unitPriceSanJorge || it.unitPriceSanJorge || 0,
          unitPriceIsla: p?.unitPriceIsla || it.unitPriceIsla || 0,
        };
      }),
    );
  }, [openForm, sellerId, orderItems.length, productsAll, sellers]);

  const currentSeller = useMemo(() => {
    if (!isVendor || !currentEmailNorm) return null;
    return (
      sellers.find(
        (s) => (s.email || "").trim().toLowerCase() === currentEmailNorm,
      ) || null
    );
  }, [isVendor, currentEmailNorm, sellers]);

  // Set productos ya agregados
  const inOrderSet = useMemo(() => {
    return new Set(orderItems.map((x) => x.productId));
  }, [orderItems]);

  // Productos picker: existencias > 1
  const productsForPicker = useMemo(() => {
    return productsAll
      .filter((p) => {
        const avail = availablePacks[p.id] ?? 0;
        return avail > 1;
      })
      .sort((a, b) =>
        `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`),
      );
  }, [productsAll, availablePacks]);

  const filteredProductsForPicker = useMemo(() => {
    const q = productSearch.trim().toLowerCase();
    if (!q) return productsForPicker;
    return productsForPicker.filter((p) => {
      const name = `${p.category ?? ""} ${p.name ?? ""}`.toLowerCase();
      return name.includes(q);
    });
  }, [productsForPicker, productSearch]);

  const selectedProduct = useMemo(
    () => productsAll.find((p) => p.id === selectedProductId) || null,
    [selectedProductId, productsAll],
  );

  const rowsByRole = useMemo(() => {
    if (isVendor && currentSeller)
      return rows.filter((r) => r.sellerId === currentSeller.id);
    return rows;
  }, [rows, isVendor, currentSeller]);

  // =========================
  // CARGA TRANSFER AGG
  // =========================
  const loadTransferAgg = async () => {
    try {
      const colRef = collection(db, "inventory_transfers_candies");
      const bumpOrder = (
        map: Record<string, { out: number; in: number }>,
        key: string,
        mode: "out" | "in",
        packs: number,
      ) => {
        if (!key) return;
        map[key] = map[key] || { out: 0, in: 0 };
        map[key][mode] += packs;
      };

      const bumpRow = (
        map: Record<string, number>,
        rowId: unknown,
        delta: number,
      ) => {
        const key = String(rowId || "");
        if (!key) return;
        map[key] = (map[key] || 0) + delta;
      };

      const orderAgg: Record<string, { out: number; in: number }> = {};
      const rowAgg: Record<string, number> = {};
      const rowsMap = rowsByIdRef.current;

      const isDestRowNew = (x: any) => {
        if (x.destRowWasNew != null) return Boolean(x.destRowWasNew);
        const toRowId = String(x.toVendorRowId || "");
        if (!toRowId) return false;
        const row = rowsMap[toRowId];
        if (!row) return false;
        const rowCreatedTs = Number(row.createdAt?.seconds ?? 0);
        const transferTs = Number(x.createdAt?.seconds ?? 0);
        const timestampsClose =
          rowCreatedTs > 0 &&
          transferTs > 0 &&
          Math.abs(rowCreatedTs - transferTs) <= 1;
        const packagesMatch =
          Math.max(0, Number(row.packages || 0)) ===
          Math.max(0, Number(x.packagesMoved || 0));
        return timestampsClose && packagesMatch;
      };

      const processDoc = (d: any) => {
        const x = d.data() as any;
        const packs = Number(x.packagesMoved || 0);
        if (!(packs > 0)) return;
        bumpOrder(orderAgg, String(x.fromOrderKey || ""), "out", packs);
        bumpOrder(orderAgg, String(x.toOrderKey || ""), "in", packs);
        bumpRow(rowAgg, x.fromVendorRowId, -packs);
        if (!isDestRowNew(x)) {
          bumpRow(rowAgg, x.toVendorRowId, packs);
        }
      };

      if (!isVendor) {
        const snap = await getDocs(colRef);
        snap.forEach(processDoc);
      } else {
        const qFrom = query(colRef, where("fromSellerId", "==", sellerCandyId));
        const qTo = query(colRef, where("toSellerId", "==", sellerCandyId));
        const [sFrom, sTo] = await Promise.all([getDocs(qFrom), getDocs(qTo)]);
        const seen = new Set<string>();
        const apply = (docs: any[]) => {
          docs.forEach((d) => {
            if (seen.has(d.id)) return;
            seen.add(d.id);
            processDoc(d);
          });
        };
        apply(sFrom.docs);
        apply(sTo.docs);
      }

      setTransferAgg(orderAgg);
      setTransferRowDeltas(rowAgg);
    } catch (e) {
      console.error(e);
      setTransferAgg({});
      setTransferRowDeltas({});
    }
  };
  // =========================
  // CARGA DE DATOS
  // =========================
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // 1) SELLERS
        const sSnap = await getDocs(
          query(collection(db, "sellers_candies"), orderBy("name", "asc")),
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

        // 2) CATÁLOGO DESDE candy_main_orders
        const mainSnap = await getDocs(
          query(
            collection(db, "candy_main_orders"),
            orderBy("createdAt", "desc"),
          ),
        );

        const existing: Record<string, number> = {};
        const pick: Record<
          string,
          {
            id: string;
            name: string;
            category: string;
            unitsPerPackage: number;

            providerPrice: number;

            unitPriceRivas: number;
            unitPriceSanJorge: number;
            unitPriceIsla: number;

            grossProfitPerPackRivas: number;
            grossProfitPerPackSanJorge: number;
            grossProfitPerPackIsla: number;

            uApproxPerPackRivas: number;
            uApproxPerPackSanJorge: number;
            uApproxPerPackIsla: number;

            logisticAllocatedPerPack: number;

            key: string;
          }
        > = {};

        const makeKey = (dateStr: string, createdAtSec: number) =>
          `${dateStr}#${String(createdAtSec).padStart(10, "0")}`;

        mainSnap.forEach((d) => {
          const x = d.data() as any;
          const createdAtSec = Number(x.createdAt?.seconds ?? 0);
          const dateStr = String(x.date || "");

          const items = Array.isArray(x.items) ? x.items : [];
          for (const it of items) {
            const pid = String(it.id || it.productId || "");
            if (!pid) continue;

            const remainingPackages = floor(
              it.remainingPackages ?? it.remainingPacks ?? 0,
            );
            if (remainingPackages > 0) {
              existing[pid] = (existing[pid] || 0) + remainingPackages;
            }

            const packsLine = Math.max(1, floor(it.packages ?? 0));

            const providerPrice = Number(
              it.providerPrice ??
                it.provider_price ??
                it.priceProvider ??
                it.costProvider ??
                0,
            );

            const upr = Number(it.unitPriceRivas || 0);
            const ups = Number(it.unitPriceSanJorge || 0);
            const upi = Number(it.unitPriceIsla || 0);

            const gpR = Number(
              it.gainRivas ?? it.grossProfitRivas ?? it.grossProfit ?? 0,
            );
            const gpSJ = Number(
              it.gainSanJorge ?? it.grossProfitSanJorge ?? it.grossProfit ?? 0,
            );
            const gpI = Number(
              it.gainIsla ?? it.grossProfitIsla ?? it.grossProfit ?? 0,
            );

            const logisticAllocatedTotal = Number(
              it.logisticAllocated ??
                it.prorrateo ??
                it.prorrateoLogistico ??
                it.gastos ??
                0,
            );

            // === U Aproximada total (compat) ===
            // Orden Maestra final debe guardar U Aproximada.
            // Mientras tanto, se toma en este orden de fallback:
            // uAproximada / uApprox / netProfit / vendorProfit / gainVendor
            const uApproxTotal = Number(
              it.uAproximada ??
                it.uApprox ??
                it.netProfit ??
                it.vendorProfit ??
                it.gainVendor ??
                0,
            );

            const uApproxPerPack = uApproxTotal / packsLine;
            const logisticAllocatedPerPack = logisticAllocatedTotal / packsLine;

            const cand = {
              id: pid,
              name: String(it.name || it.productName || ""),
              category: String(it.category || ""),
              unitsPerPackage: floor(it.unitsPerPackage ?? 0),

              providerPrice,

              unitPriceRivas: upr,
              unitPriceSanJorge: ups,
              unitPriceIsla: upi,

              grossProfitPerPackRivas: gpR / packsLine,
              grossProfitPerPackSanJorge: gpSJ / packsLine,
              grossProfitPerPackIsla: gpI / packsLine,

              uApproxPerPackRivas: uApproxPerPack,
              uApproxPerPackSanJorge: uApproxPerPack,
              uApproxPerPackIsla: uApproxPerPack,

              logisticAllocatedPerPack,

              key: makeKey(dateStr, createdAtSec),
            };

            const prev = pick[pid];
            if (!prev || cand.key > prev.key) pick[pid] = cand;
          }
        });

        // 3) SUBINVENTARIO VENDEDORES
        const invSnap = await getDocs(
          isVendor
            ? query(
                collection(db, "inventory_candies_sellers"),
                where("sellerId", "==", sellerCandyId),
                orderBy("createdAt", "desc"),
              )
            : query(
                collection(db, "inventory_candies_sellers"),
                orderBy("createdAt", "desc"),
              ),
        );

        const avail: Record<string, number> = {};
        Object.keys(existing).forEach((pid) => {
          const masterRemaining = floor(existing[pid]);

          // ✅ Disponibles reales para nuevos pedidos (ya descuenta asignaciones)
          avail[pid] = Math.max(0, masterRemaining);
        });

        setAvailablePacks(avail);

        const pList: ProductCandyFromMain[] = Object.keys(pick)
          .map((pid) => {
            const p = pick[pid];
            return {
              id: p.id,
              name: p.name,
              category: p.category,
              unitsPerPackage: p.unitsPerPackage,

              providerPrice: p.providerPrice,

              unitPriceRivas: p.unitPriceRivas,
              unitPriceSanJorge: p.unitPriceSanJorge,
              unitPriceIsla: p.unitPriceIsla,

              grossProfitPerPackRivas: p.grossProfitPerPackRivas,
              grossProfitPerPackSanJorge: p.grossProfitPerPackSanJorge,
              grossProfitPerPackIsla: p.grossProfitPerPackIsla,

              uApproxPerPackRivas: p.uApproxPerPackRivas,
              uApproxPerPackSanJorge: p.uApproxPerPackSanJorge,
              uApproxPerPackIsla: p.uApproxPerPackIsla,

              logisticAllocatedPerPack: p.logisticAllocatedPerPack,

              existingPacks: avail[p.id] ?? 0,
            };
          })
          .sort((a, b) =>
            `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`),
          );

        setProductsAll(pList);

        const invList: VendorCandyRow[] = [];
        invSnap.forEach((d) => {
          const x = d.data() as any;
          const hasTransferDeltaField = Object.prototype.hasOwnProperty.call(
            x,
            "transferDelta",
          );

          const sellerFallback = sList.find((s) => s.id === x.sellerId) || null;
          const vendorMarginPercent = clampPercent(
            x.vendorMarginPercent ??
              x.vendorMargin ??
              x.commissionPercent ??
              sellerFallback?.commissionPercent ??
              0,
          );

          const uAproximada = Number(
            x.uAproximada ??
              x.uApprox ??
              x.netProfit ??
              x.uAprox ??
              x.uApproxTotal ??
              0,
          );

          // si viene pre-calculado, usarlo; si no, calcular
          const uVendorRaw = x.uVendor ?? x.vendorProfit ?? x.gainVendor ?? 0;
          const hasUVendor = x.uVendor != null;

          const splitGross = calcSplitFromGross(
            Number(x.grossProfit ?? x.gainVendor ?? 0),
            vendorMarginPercent,
          );

          const split = hasUVendor
            ? {
                uAproximada: Number(uAproximada || 0),
                vendorMarginPercent,
                uVendor: Number(uVendorRaw || 0),
                uInvestor: Number(uAproximada || 0) - Number(uVendorRaw || 0),
              }
            : {
                uAproximada: Number(uAproximada || 0),
                vendorMarginPercent: splitGross.vendorMarginPercent,
                uVendor: splitGross.uVendor,
                uInvestor: splitGross.uInvestor,
              };

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

            totalRivas: Number(x.totalRivas || 0),
            totalSanJorge: Number(x.totalSanJorge || 0),
            totalIsla: Number(x.totalIsla || 0),

            unitPriceRivas: Number(x.unitPriceRivas || 0),
            unitPriceSanJorge: Number(x.unitPriceSanJorge || 0),
            unitPriceIsla: Number(x.unitPriceIsla || 0),

            grossProfit: Number(x.grossProfit ?? x.gainVendor ?? 0),
            logisticAllocated: Number(
              x.logisticAllocated ?? x.gastos ?? x.gasto ?? 0,
            ),

            vendorMarginPercent: split.vendorMarginPercent,
            uAproximada: split.uAproximada,
            uVendor: split.uVendor,
            uInvestor: split.uInvestor,

            vendorProfit: Number(x.vendorProfit ?? split.uVendor ?? 0),

            transferDelta:
              hasTransferDeltaField && typeof x.transferDelta === "number"
                ? Number(x.transferDelta || 0)
                : undefined,

            subtotal: Number(x.subtotal || 0),
            providerPrice: Number(x.providerPrice || 0),

            date: x.date || "",
            createdAt: x.createdAt || Timestamp.now(),
          });
        });

        const nextRowsMap: Record<string, VendorCandyRow> = {};
        invList.forEach((r) => {
          nextRowsMap[r.id] = r;
        });
        rowsByIdRef.current = nextRowsMap;
        setRows(invList);
        await loadTransferAgg();
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando datos de vendedores / pedidos.");
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey, role, sellerCandyId]);
  // =========================
  // HELPERS: orderKey y branch calc
  // =========================
  const buildOrderKey = (sid: string, d: string) => `${sid}__${d}`;
  const getRowOrderKey = (row: VendorCandyRow) =>
    row.orderId || buildOrderKey(row.sellerId, row.date);

  const getPricePerPack = (p: ProductCandyFromMain, b?: Branch) => {
    if (!b)
      return p.unitPriceIsla || p.unitPriceRivas || p.unitPriceSanJorge || 0;
    if (b === "RIVAS") return p.unitPriceRivas || 0;
    if (b === "SAN_JORGE") return p.unitPriceSanJorge || 0;
    return p.unitPriceIsla || 0;
  };

  const getGrossProfitPerPack = (p: ProductCandyFromMain, b?: Branch) => {
    if (!b)
      return (
        p.grossProfitPerPackIsla ||
        p.grossProfitPerPackRivas ||
        p.grossProfitPerPackSanJorge ||
        0
      );
    if (b === "RIVAS") return p.grossProfitPerPackRivas || 0;
    if (b === "SAN_JORGE") return p.grossProfitPerPackSanJorge || 0;
    return p.grossProfitPerPackIsla || 0;
  };

  const getUApproxPerPack = (p: ProductCandyFromMain, b?: Branch) => {
    if (!b)
      return (
        p.uApproxPerPackIsla ||
        p.uApproxPerPackRivas ||
        p.uApproxPerPackSanJorge ||
        0
      );
    if (b === "RIVAS") return p.uApproxPerPackRivas || 0;
    if (b === "SAN_JORGE") return p.uApproxPerPackSanJorge || 0;
    return p.uApproxPerPackIsla || 0;
  };

  const getSellerMarginPercent = (sid: string) => {
    const s = sellers.find((x) => x.id === sid) || null;
    return clampPercent(s?.commissionPercent ?? 0);
  };

  const getRowTransferDelta = (row: VendorCandyRow) => {
    const delta = transferRowDeltas[row.id];
    if (typeof delta === "number" && Number.isFinite(delta)) {
      return delta;
    }
    if (typeof row.transferDelta === "number") {
      return Number(row.transferDelta || 0);
    }
    return 0;
  };

  const getRowActivePackages = (row: VendorCandyRow) => {
    const base = Math.max(0, Number(row.packages || 0));
    const delta = getRowTransferDelta(row);
    return Math.max(0, base + delta);
  };

  // =========================
  // AGRUPAR a "pedidos" (OrderSummaryRow)
  // =========================
  const orderSummaries = useMemo(() => {
    const agg = new Map<string, OrderSummaryRow>();

    for (const r of rowsByRole) {
      const key = getRowOrderKey(r);
      const cur =
        agg.get(key) ||
        ({
          orderKey: key,
          sellerId: r.sellerId,
          sellerName: r.sellerName,
          date: r.date,
          totalPackages: 0,
          totalActivePackages: 0,
          totalRemainingPackages: 0,
          totalExpected: 0,
          totalExpectedActive: 0,
          grossProfit: 0,
          grossProfitActive: 0,
          vendorProfit: 0,
          vendorProfitActive: 0,
          gastos: 0,
          gastosActive: 0,
          transferredOut: 0,
          transferredIn: 0,
        } as OrderSummaryRow);

      const packages = Math.max(0, Number(r.packages || 0));
      const remaining = Math.max(0, Number(r.remainingPackages || 0));
      const activePackages = getRowActivePackages(r);
      const activeRatio = packages > 0 ? activePackages / packages : 1;

      cur.totalPackages += packages;
      cur.totalRemainingPackages += remaining;
      cur.totalActivePackages += activePackages;

      const seller = sellers.find((s) => s.id === r.sellerId) || null;
      const br = seller?.branch;

      const p = productsAll.find((x) => x.id === String(r.productId)) || null;

      const pricePerPackage = p
        ? getPricePerPack(p, br)
        : br === "RIVAS"
          ? Number(r.unitPriceRivas || 0)
          : br === "SAN_JORGE"
            ? Number(r.unitPriceSanJorge || 0)
            : Number(r.unitPriceIsla || 0);

      const totalExpectedRow = pricePerPackage * packages;
      const totalExpectedActiveRow = pricePerPackage * activePackages;
      cur.totalExpected += Number(totalExpectedRow || 0);
      cur.totalExpectedActive += Number(totalExpectedActiveRow || 0);

      const grossPerPack = p
        ? getGrossProfitPerPack(p, br)
        : packages > 0
          ? Number(r.grossProfit || 0) / packages
          : 0;
      const grossProfitRow = grossPerPack * packages;
      const grossProfitActiveRow = grossPerPack * activePackages;
      cur.grossProfit += Number(grossProfitRow || 0);
      cur.grossProfitActive += Number(grossProfitActiveRow || 0);

      const logisticPerPack =
        typeof p?.logisticAllocatedPerPack === "number"
          ? Number(p.logisticAllocatedPerPack || 0)
          : (() => {
              const totalLog = Number(
                r.logisticAllocated ??
                  (r as any).gastos ??
                  (r as any).gasto ??
                  0,
              );
              const base = packages > 0 ? packages : activePackages || 1;
              return base > 0 ? totalLog / base : 0;
            })();
      const logisticAllocated = logisticPerPack * packages;
      const logisticAllocatedActive = logisticPerPack * activePackages;
      cur.gastos = (cur.gastos || 0) + Number(logisticAllocated || 0);
      cur.gastosActive =
        (cur.gastosActive || 0) + Number(logisticAllocatedActive || 0);

      const vendorMarginPercent = getSellerMarginPercent(r.sellerId);
      const split = calcSplitFromGross(grossProfitRow, vendorMarginPercent);
      cur.vendorProfit += Number(split.uVendor || 0);
      cur.vendorProfitActive += Number(split.uVendor || 0) * activeRatio;

      agg.set(key, cur);
    }

    const out: OrderSummaryRow[] = [];
    for (const v of agg.values()) {
      const tr = transferAgg[v.orderKey] || { out: 0, in: 0 };
      v.transferredOut = tr.out || 0;
      v.transferredIn = tr.in || 0;
      if (!Number.isFinite(v.totalExpectedActive)) {
        v.totalExpectedActive = v.totalExpected;
      }
      if (!Number.isFinite(v.grossProfitActive)) {
        v.grossProfitActive = v.grossProfit;
      }
      if (!Number.isFinite(v.vendorProfitActive)) {
        v.vendorProfitActive = v.vendorProfit;
      }
      if (!Number.isFinite(v.gastosActive || 0)) {
        v.gastosActive = v.gastos;
      }
      out.push(v);
    }

    out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return out;
  }, [rowsByRole, sellers, transferAgg, productsAll, transferRowDeltas]);

  // ✅ paginado 20 pedidos por página
  const totalPages = useMemo(() => {
    return Math.max(1, Math.ceil(orderSummaries.length / PAGE_SIZE));
  }, [orderSummaries.length]);

  useEffect(() => {
    if (page > totalPages) setPage(totalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [totalPages]);

  const pagedOrders = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return orderSummaries.slice(start, start + PAGE_SIZE);
  }, [orderSummaries, page]);

  const goPrevPage = () => setPage((p) => Math.max(1, p - 1));
  const goNextPage = () => setPage((p) => Math.min(totalPages, p + 1));

  // =========================
  // Modal items paginado 20
  // =========================
  const filteredOrderItems = useMemo(() => {
    const q = associatedSearch.trim().toLowerCase();
    if (!q) return orderItems;
    return orderItems.filter((it) => {
      const name = String(it.productName || "").toLowerCase();
      const cat = String(it.category || "").toLowerCase();
      return name.includes(q) || cat.includes(q);
    });
  }, [orderItems, associatedSearch]);

  const itemsTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(filteredOrderItems.length / ITEMS_PAGE_SIZE));
  }, [filteredOrderItems.length]);

  useEffect(() => {
    if (itemsPage > itemsTotalPages) setItemsPage(itemsTotalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsTotalPages]);

  const pagedOrderItems = useMemo(() => {
    const start = (itemsPage - 1) * ITEMS_PAGE_SIZE;
    return filteredOrderItems.slice(start, start + ITEMS_PAGE_SIZE);
  }, [filteredOrderItems, itemsPage]);

  const pagedItemsByCategory = useMemo(() => {
    const map = new Map<string, OrderItem[]>();
    for (const it of pagedOrderItems) {
      const key = (it.category || "Sin categoría").trim() || "Sin categoría";
      const list = map.get(key) || [];
      list.push(it);
      map.set(key, list);
    }
    return Array.from(map.entries());
  }, [pagedOrderItems]);

  const toggleCategory = (cat: string) => {
    setOpenCategoryMap((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  const itemsPrev = () => setItemsPage((p) => Math.max(1, p - 1));
  const itemsNext = () => setItemsPage((p) => Math.min(itemsTotalPages, p + 1));

  // =========================
  // KPIs del modal (orden actual)
  // =========================
  const getItemActivePackages = (it: OrderItem) => {
    const base = Math.max(0, Number(it.packages || 0));
    const delta = Number(it.transferDelta || 0);
    return Math.max(0, base + delta);
  };

  const getItemActiveRatio = (it: OrderItem) => {
    const base = Math.max(0, Number(it.packages || 0));
    const active = getItemActivePackages(it);
    if (base === 0) return active > 0 ? 1 : 0;
    return active / base;
  };

  const getItemActiveValue = (it: OrderItem, value: number) =>
    Number(value || 0) * getItemActiveRatio(it);

  const getItemLogisticBase = (it: OrderItem) =>
    Number(
      it.logisticAllocated ??
        (it as any).logisticAllocated ??
        (it as any).gastos ??
        (it as any).gasto ??
        0,
    );

  const getItemActiveFinancials = (it: OrderItem) => {
    const totalExpected = getItemActiveValue(it, Number(it.totalExpected || 0));
    const grossProfit = getItemActiveValue(it, Number(it.grossProfit || 0));
    const gastos = getItemActiveValue(it, getItemLogisticBase(it));
    const uVendor = getItemActiveValue(it, Number(it.uVendor || 0));
    const uNeta = grossProfit - gastos - uVendor;
    return { totalExpected, grossProfit, gastos, uVendor, uNeta };
  };

  const kpiTotals = useMemo(() => {
    return orderItems.reduce(
      (acc, it) => {
        const packages = Math.max(0, Number(it.packages || 0));
        const active = getItemActivePackages(it);
        const financials = getItemActiveFinancials(it);

        acc.totalPackages += packages;
        acc.totalActivePackages += active;
        acc.totalExpected += financials.totalExpected;
        acc.grossProfit += financials.grossProfit;
        acc.gastosTotal += financials.gastos;
        acc.uVendor += financials.uVendor;
        return acc;
      },
      {
        totalPackages: 0,
        totalActivePackages: 0,
        totalExpected: 0,
        grossProfit: 0,
        gastosTotal: 0,
        uVendor: 0,
      },
    );
  }, [orderItems]);

  const kpiUNeta = useMemo(() => {
    return kpiTotals.grossProfit - kpiTotals.gastosTotal - kpiTotals.uVendor;
  }, [kpiTotals.grossProfit, kpiTotals.gastosTotal, kpiTotals.uVendor]);

  // =========================
  // ACCIONES: abrir modal / editar / reset
  // =========================
  const resetForm = () => {
    setEditingOrderKey(null);
    setSellerId("");
    setDate("");
    setSelectedProductId("");
    setPackagesToAdd("0");
    setOrderItems([]);
    setProductSearch("");
    setItemsPage(1);
  };

  const openNewOrder = () => {
    setMsg("");
    resetForm();

    if (isVendor && currentSeller) {
      setSellerId(currentSeller.id);
    }
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, "0");
    const dd = String(today.getDate()).padStart(2, "0");
    setDate(`${yyyy}-${mm}-${dd}`);

    setOpenForm(true);
  };

  const closeForm = () => {
    setOpenForm(false);
  };

  const openEditOrder = (orderKey: string) => {
    setMsg("");
    resetForm();
    setEditingOrderKey(orderKey);

    const [sid, d] = orderKey.split("__");
    setSellerId(sid || "");
    setDate(d || "");

    const orderRows = rowsByRole.filter((r) => getRowOrderKey(r) === orderKey);

    const seller = sellers.find((s) => s.id === sid) || null;
    const br = seller?.branch;

    const items: OrderItem[] = orderRows.map((r) => {
      const p = productsAll.find((x) => x.id === String(r.productId)) || null;

      const unitPriceRivas = Number(r.unitPriceRivas || p?.unitPriceRivas || 0);
      const unitPriceSanJorge = Number(
        r.unitPriceSanJorge || p?.unitPriceSanJorge || 0,
      );
      const unitPriceIsla = Number(r.unitPriceIsla || p?.unitPriceIsla || 0);

      const packs = Number(r.packages || 0);

      const pricePerPackage =
        br === "RIVAS"
          ? unitPriceRivas
          : br === "SAN_JORGE"
            ? unitPriceSanJorge
            : unitPriceIsla;

      const totalRivas = Number(r.totalRivas || 0);
      const totalSanJorge = Number(r.totalSanJorge || 0);
      const totalIsla = Number(r.totalIsla || 0);

      const totalExpected =
        br === "RIVAS"
          ? totalRivas
          : br === "SAN_JORGE"
            ? totalSanJorge
            : totalIsla;

      const vendorMarginPercent = clampPercent(
        r.vendorMarginPercent ?? getSellerMarginPercent(sid),
      );

      const split = calcSplitFromGross(
        Number(r.grossProfit || 0),
        vendorMarginPercent,
      );

      const logisticAllocated =
        Number((r as any).logisticAllocated ?? (r as any).gastos ?? 0) ||
        (p ? p.logisticAllocatedPerPack * packs : 0);

      return {
        id: r.id,
        productId: String(r.productId || ""),
        productName: r.productName || p?.name || "",
        category: r.category || p?.category || "",

        unitsPerPackage: Number(r.unitsPerPackage || p?.unitsPerPackage || 0),
        packages: packs,

        totalExpected,
        pricePerPackage,

        grossProfit: Number(r.grossProfit || 0),

        logisticAllocated,

        vendorMarginPercent: split.vendorMarginPercent,
        uAproximada: Number(r.uAproximada || 0),
        uVendor: Number(r.uVendor ?? split.uVendor ?? 0),
        uInvestor: Number(r.uInvestor ?? split.uInvestor ?? 0),

        totalRivas,
        totalSanJorge,
        totalIsla,

        unitPriceRivas,
        unitPriceSanJorge,
        unitPriceIsla,

        providerPrice: Number((r as any).providerPrice || 0),

        remainingPackages: Number(r.remainingPackages || 0),
        transferDelta: getRowTransferDelta(r),
      };
    });

    setOrderItems(items);
    setOpenForm(true);
  };

  // =========================
  // AGREGAR / QUITAR ITEM
  // =========================
  const addItemToOrder = () => {
    setMsg("");
    if (!sellerId) return setMsg("⚠️ Seleccioná un vendedor.");
    if (!date) return setMsg("⚠️ Seleccioná una fecha.");
    if (!selectedProductId) return setMsg("⚠️ Seleccioná un producto.");

    const packs = floor(packagesToAdd);
    if (packs <= 0) return setMsg("⚠️ Paquetes debe ser > 0.");

    const p = productsAll.find((x) => x.id === selectedProductId);
    if (!p) return setMsg("⚠️ Producto no encontrado.");

    if (orderItems.some((x) => x.productId === p.id)) {
      return setMsg("⚠️ Ese producto ya está agregado al pedido.");
    }

    const s = sellers.find((x) => x.id === sellerId) || null;
    const br = s?.branch;

    const pricePerPackage = getPricePerPack(p, br);
    const grossPerPack = getGrossProfitPerPack(p, br);

    const uApproxPerPack = getUApproxPerPack(p, br);
    const uAproximada = uApproxPerPack * packs;

    const totalExpected = pricePerPackage * packs;
    const grossProfit = grossPerPack * packs;
    const logisticAllocated = p.logisticAllocatedPerPack * packs;

    const vendorMarginPercent = getSellerMarginPercent(sellerId);
    const split = calcSplitFromGross(grossProfit, vendorMarginPercent);

    const item: OrderItem = {
      id: `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
      productId: p.id,
      productName: p.name,
      category: p.category,

      unitsPerPackage: p.unitsPerPackage,
      packages: packs,

      totalExpected,
      pricePerPackage,

      grossProfit,

      logisticAllocated,

      providerPrice: p.providerPrice,

      vendorMarginPercent: split.vendorMarginPercent,
      uAproximada,
      uVendor: split.uVendor,
      uInvestor: split.uInvestor,

      totalRivas: (p.unitPriceRivas || 0) * packs,
      totalSanJorge: (p.unitPriceSanJorge || 0) * packs,
      totalIsla: (p.unitPriceIsla || 0) * packs,

      unitPriceRivas: p.unitPriceRivas || 0,
      unitPriceSanJorge: p.unitPriceSanJorge || 0,
      unitPriceIsla: p.unitPriceIsla || 0,

      remainingPackages: packs,
      transferDelta: 0,
    };

    setOrderItems((prev) => [item, ...prev]);
    setSelectedProductId("");
    setPackagesToAdd("0");
    setItemsPage(1);
  };

  const removeItem = (id: string) => {
    setOrderItems((prev) => prev.filter((x) => x.id !== id));
  };

  const updateItemPackages = (id: string, packsRaw: any) => {
    const packs = Math.max(0, floor(packsRaw));
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;

        const p = productsAll.find((x) => x.id === it.productId);
        const s = sellers.find((x) => x.id === sellerId) || null;
        const br = s?.branch;

        const pricePerPackage = p
          ? getPricePerPack(p, br)
          : it.pricePerPackage || 0;

        const grossPerPack = p ? getGrossProfitPerPack(p, br) : 0;
        const grossProfit = grossPerPack * packs;

        const logisticAllocated = p
          ? p.logisticAllocatedPerPack * packs
          : it.logisticAllocated || 0;

        const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
        const uAproximada = uApproxPerPack * packs;

        const vendorMarginPercent =
          it.vendorMarginPercent != null
            ? it.vendorMarginPercent
            : getSellerMarginPercent(sellerId);

        const split = calcSplitFromGross(grossProfit, vendorMarginPercent);

        const shouldSyncRemaining =
          String(it.id || "").startsWith("tmp_") ||
          Number(it.remainingPackages || 0) === Number(it.packages || 0);

        return {
          ...it,
          packages: packs,
          pricePerPackage,
          totalExpected: pricePerPackage * packs,
          grossProfit,

          logisticAllocated,

          providerPrice:
            p?.providerPrice ??
            it.providerPrice ??
            Number(it.providerPrice || 0),

          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,

          totalRivas: (p?.unitPriceRivas || it.unitPriceRivas || 0) * packs,
          totalSanJorge:
            (p?.unitPriceSanJorge || it.unitPriceSanJorge || 0) * packs,
          totalIsla: (p?.unitPriceIsla || it.unitPriceIsla || 0) * packs,
          remainingPackages: shouldSyncRemaining ? packs : it.remainingPackages,
        };
      }),
    );
  };

  const updateItemVendorMarginPercent = (id: string, pctRaw: any) => {
    const pct = clampPercent(pctRaw);

    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== id) return it;

        const p = productsAll.find((x) => x.id === it.productId);
        const s = sellers.find((x) => x.id === sellerId) || null;
        const br = s?.branch;

        const packs = floor(it.packages);

        const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
        const uAproximada = uApproxPerPack * packs;

        const grossProfit = Number(it.grossProfit || 0);
        const split = calcSplitFromGross(grossProfit, pct);

        return {
          ...it,
          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,
        };
      }),
    );
  };

  // =========================
  // BACKFILL CAMPOS CALCULADOS
  // =========================
  const backfillCalculatedFields = async () => {
    if (!isAdmin) return;
    if (isBackfilling) return;

    try {
      setIsBackfilling(true);
      setMsg("");

      const list = rows;
      if (!list.length) {
        setMsg("⚠️ No hay documentos para actualizar.");
        return;
      }

      const findProduct = (pid: string) =>
        productsAll.find((p) => p.id === pid) || null;

      const pickBranch = (sid: string) => {
        const s = sellers.find((x) => x.id === sid) || null;
        return s?.branch;
      };

      const diff = (a: any, b: any) =>
        Math.abs(Number(a || 0) - Number(b || 0)) > 0.01;

      let batch = writeBatch(db);
      let pending = 0;
      let updated = 0;

      for (const r of list) {
        const br = pickBranch(r.sellerId) || "ISLA";

        // Recalcular P. asociados (packages) de forma idempotente
        const unitsPerPackage = Math.max(
          1,
          Number(r.unitsPerPackage || 0) || 1,
        );
        const totalUnits = Number(r.totalUnits || 0);
        const remainingUnits = Number(r.remainingUnits || 0);
        const soldUnits = Math.max(0, totalUnits - remainingUnits);
        const soldPacks = soldUnits / unitsPerPackage;
        const remainingPacks = Number(r.remainingPackages || 0);
        const packs = Math.max(0, remainingPacks + soldPacks);

        const p = findProduct(String(r.productId || ""));

        const grossProfit =
          p && packs > 0
            ? getGrossProfitPerPack(p, br) * packs
            : Number(r.grossProfit || 0);

        const logisticAllocated =
          p && packs > 0
            ? p.logisticAllocatedPerPack * packs
            : Number(r.logisticAllocated || 0);

        const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
        const uAproximada = packs > 0 ? uApproxPerPack * packs : 0;

        const vendorMarginPercent =
          r.vendorMarginPercent != null
            ? clampPercent(r.vendorMarginPercent)
            : getSellerMarginPercent(r.sellerId);

        const split = calcSplitFromGross(grossProfit, vendorMarginPercent);
        const uVendor = split.uVendor;
        const uInvestor = split.uInvestor;
        const uNeta = grossProfit - logisticAllocated - uVendor;

        const needsUpdate =
          diff(r.packages, packs) ||
          (r as any).uVendor == null ||
          (r as any).uNeta == null ||
          (r as any).uAproximada == null ||
          (r as any).uInvestor == null ||
          (r as any).logisticAllocated == null ||
          diff((r as any).uVendor, uVendor) ||
          diff((r as any).uNeta, uNeta) ||
          diff((r as any).uAproximada, uAproximada) ||
          diff((r as any).uInvestor, uInvestor) ||
          diff((r as any).logisticAllocated, logisticAllocated);

        if (!needsUpdate) continue;

        const ref = doc(db, "inventory_candies_sellers", r.id);
        batch.update(ref, {
          // Corrige P. asociados a partir de unidades vendidas + restantes
          packages: packs,
          vendorMarginPercent,
          grossProfit,
          logisticAllocated,
          uAproximada,
          uVendor,
          uInvestor,
          uNeta,
          vendorProfit: uVendor,
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

      if (pending > 0) await batch.commit();

      setMsg(`✅ Actualizados ${updated} documentos.`);
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error actualizando documentos.");
    } finally {
      setIsBackfilling(false);
    }
  };

  // =========================
  // FIX LEGACY: P. asociados = P. restantes en filas con traslados
  // =========================
  const fixLegacyAssociatedFromRemaining = async () => {
    if (!isAdmin) return;
    if (isBackfilling) return;

    try {
      setIsBackfilling(true);
      setMsg("");

      const list = rows;
      if (!list.length) {
        setMsg("⚠️ No hay documentos para reparar.");
        return;
      }

      let batch = writeBatch(db);
      let pending = 0;
      let updated = 0;

      for (const r of list) {
        const currentPacks = floor(r.packages);
        const remainingPacks = floor(r.remainingPackages);
        if (currentPacks === remainingPacks) continue;

        const ref = doc(db, "inventory_candies_sellers", r.id);
        batch.update(ref, {
          packages: remainingPacks,
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

      if (pending > 0) await batch.commit();

      setMsg(`✅ Reparadas ${updated} filas legacy de P. asociados.`);
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error reparando P. asociados legacy.");
    } finally {
      setIsBackfilling(false);
    }
  };

  // =========================
  // CSV / DESCARGAS (Excel)
  // =========================
  const downloadTextFile = (
    filename: string,
    content: string,
    mime = "text/plain;charset=utf-8",
  ) => {
    const blob = new Blob([content], { type: mime });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const exportAssociatedItemsToCsv = () => {
    if (!isAdmin) {
      setMsg("⚠️ Solo admin puede exportar CSV.");
      return;
    }
    const headers = [
      "Vendedor",
      "Sucursal",
      "Fecha",
      "Producto ID",
      "Producto",
      "Categoría",
      "Paquetes",
      "Paquetes restantes",
      "Precio paquete",
      "Precio proveedor",
      "Total esperado",
      "U. Bruta",
      "U. Vendedor",
      "U. Neta",
      "P. Rivas",
      "P. San Jorge",
      "P. Isla",
      "Total Rivas",
      "Total San Jorge",
      "Total Isla",
      "Unidades x paquete",
      // === PLAN (obligatorio en export): NO eliminar previas, SOLO agregar ===
      "vendorMarginPercent",
      "uVendor",
    ];

    const seller = sellers.find((s) => s.id === sellerId) || null;
    const branchLabel =
      seller?.branch || normalizeBranch(seller?.branchLabel) || "—";

    const lines = [
      headers.join(","),
      ...orderItems.map((it) => {
        const { totalExpected, grossProfit, gastos, uVendor, uNeta } =
          getItemActiveFinancials(it);
        const row = [
          seller?.name || "",
          String(branchLabel || ""),
          date || "",
          it.productId,
          it.productName,
          it.category,
          String(Number(it.packages || 0)),
          String(Number(it.remainingPackages || 0)),
          String(Number(it.pricePerPackage || 0).toFixed(2)),
          String(Number((it as any).providerPrice || 0).toFixed(2)),
          String(Number(totalExpected || 0).toFixed(2)),
          String(Number(grossProfit || 0).toFixed(2)),
          String(Number(uVendor || 0).toFixed(2)),
          String(Number(uNeta || 0).toFixed(2)),
          String(Number(it.unitPriceRivas || 0).toFixed(2)),
          String(Number(it.unitPriceSanJorge || 0).toFixed(2)),
          String(Number(it.unitPriceIsla || 0).toFixed(2)),
          String(Number(it.totalRivas || 0).toFixed(2)),
          String(Number(it.totalSanJorge || 0).toFixed(2)),
          String(Number(it.totalIsla || 0).toFixed(2)),
          String(Number(it.unitsPerPackage || 0)),
          String(Number(it.vendorMarginPercent || 0).toFixed(2)),
          String(Number(it.uVendor || 0).toFixed(2)),
        ];
        return row.map(escapeCsv).join(",");
      }),
    ].join("\n");

    const name = `vendor_order_items_${(seller?.name || "vendedor").replace(
      /\s+/g,
      "_",
    )}_${date || "sin_fecha"}.csv`;
    downloadTextFile(name, lines, "text/csv;charset=utf-8");
  };

  const downloadTemplateFromMainOrders = () => {
    const headers = [
      "productId",
      "productName",
      "category",
      "Existentes",
      "Paquetes",
      // === PLAN: permitir margen en import ===
      "vendorMarginPercent",
      "uNeta",
    ];

    const list = productsAll
      .map((p) => ({
        id: p.id,
        name: p.name,
        category: p.category,
        existentes: Number(p.existingPacks || 0),
      }))
      .filter((x) => x.existentes > 0)
      .sort((a, b) =>
        `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`),
      );

    const lines = [
      headers.join(","),
      ...list.map((x) =>
        [x.id, x.name, x.category, String(x.existentes), "", "", ""]
          .map(escapeCsv)
          .join(","),
      ),
    ].join("\n");

    downloadTextFile(
      "plantilla_productos_orden_maestra.csv",
      lines,
      "text/csv;charset=utf-8",
    );
  };

  const onImportTemplateFile = async (file: File) => {
    try {
      setMsg("");
      const text = await file.text();
      const rowsCsv = parseCsv(text);
      if (!rowsCsv.length) return setMsg("⚠️ Archivo vacío.");

      const header = rowsCsv[0].map((h) =>
        String(h || "")
          .trim()
          .toLowerCase(),
      );
      const idxProductId = header.findIndex(
        (h) => h === "productid" || h === "producto id" || h === "id",
      );
      const idxPackages = header.findIndex(
        (h) => h === "paquetes" || h === "packages",
      );
      const idxMargin = header.findIndex(
        (h) =>
          h === "vendormarginpercent" ||
          h === "vendor_margin_percent" ||
          h === "marginvendorpercent" ||
          h === "margen" ||
          h === "margen vendedor" ||
          h === "margen_del_vendedor",
      );

      if (idxProductId < 0 || idxPackages < 0) {
        return setMsg(
          "❌ Plantilla inválida: debe tener columnas productId y Paquetes.",
        );
      }

      if (!sellerId)
        return setMsg("⚠️ Seleccioná un vendedor antes de importar.");
      if (!date) return setMsg("⚠️ Seleccioná una fecha antes de importar.");

      const seller = sellers.find((s) => s.id === sellerId) || null;
      const br = seller?.branch;

      const fallbackMargin = getSellerMarginPercent(sellerId);

      const toAdd: OrderItem[] = [];

      for (let i = 1; i < rowsCsv.length; i++) {
        const r = rowsCsv[i] || [];
        const pid = String(r[idxProductId] || "").trim();
        if (!pid) continue;

        const packs = floor(r[idxPackages]);
        if (packs <= 0) continue;

        const p = productsAll.find((x) => x.id === pid);
        if (!p) continue;

        const marginFromFile = idxMargin >= 0 ? clampPercent(r[idxMargin]) : 0;
        const vendorMarginPercent =
          idxMargin >= 0 && String(r[idxMargin] ?? "").trim() !== ""
            ? marginFromFile
            : fallbackMargin;

        const pricePerPackage = getPricePerPack(p, br);
        const grossPerPack = getGrossProfitPerPack(p, br);

        const totalExpected = pricePerPackage * packs;
        const grossProfit = grossPerPack * packs;
        const logisticAllocated = p.logisticAllocatedPerPack * packs;

        const uApproxPerPack = getUApproxPerPack(p, br);
        const uAproximada = uApproxPerPack * packs;
        const split = calcSplitFromGross(grossProfit, vendorMarginPercent);

        const exists = orderItems.find((x) => x.productId === pid);
        if (exists) {
          // mantener margen del archivo si viene, si no mantener el que ya tenía
          const nextMargin =
            idxMargin >= 0 && String(r[idxMargin] ?? "").trim() !== ""
              ? vendorMarginPercent
              : exists.vendorMarginPercent;

          const recalc = calcSplitFromGross(grossProfit, nextMargin);

          setOrderItems((prev) =>
            prev.map((it) =>
              it.id === exists.id
                ? {
                    ...it,
                    packages: packs,
                    pricePerPackage,
                    totalExpected,
                    grossProfit,

                    logisticAllocated,

                    vendorMarginPercent: recalc.vendorMarginPercent,
                    uAproximada,
                    uVendor: recalc.uVendor,
                    uInvestor: recalc.uInvestor,

                    totalRivas: (p.unitPriceRivas || 0) * packs,
                    totalSanJorge: (p.unitPriceSanJorge || 0) * packs,
                    totalIsla: (p.unitPriceIsla || 0) * packs,
                  }
                : it,
            ),
          );
          continue;
        }

        const item: OrderItem = {
          id: `tmp_${Date.now()}_${Math.random().toString(16).slice(2)}`,
          productId: p.id,
          productName: p.name,
          category: p.category,

          unitsPerPackage: p.unitsPerPackage,
          packages: packs,

          pricePerPackage,
          totalExpected,

          grossProfit,

          logisticAllocated,

          providerPrice: p.providerPrice,

          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,

          totalRivas: (p.unitPriceRivas || 0) * packs,
          totalSanJorge: (p.unitPriceSanJorge || 0) * packs,
          totalIsla: (p.unitPriceIsla || 0) * packs,

          unitPriceRivas: p.unitPriceRivas || 0,
          unitPriceSanJorge: p.unitPriceSanJorge || 0,
          unitPriceIsla: p.unitPriceIsla || 0,

          remainingPackages: packs,
        };

        toAdd.push(item);
      }

      if (!toAdd.length)
        return setMsg("⚠️ No se encontraron filas con Paquetes > 0.");

      setOrderItems((prev) => [...toAdd, ...prev]);
      setItemsPage(1);
      setMsg(`✅ Importados ${toAdd.length} productos desde plantilla.`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error importando archivo.");
    }
  };
  // =========================
  // GUARDAR PEDIDO (crear/editar)
  // =========================
  const saveOrder = async () => {
    try {
      setMsg("");
      if (isReadOnly) return setMsg("⚠️ Solo lectura.");
      if (!sellerId) return setMsg("⚠️ Seleccioná un vendedor.");
      if (!date) return setMsg("⚠️ Seleccioná una fecha.");
      if (!orderItems.length) return setMsg("⚠️ Agregá al menos 1 producto.");

      const seller = sellers.find((s) => s.id === sellerId) || null;
      if (!seller) return setMsg("⚠️ Vendedor inválido.");

      const br = seller.branch;

      // ====== SOLO SI ESTAMOS EDITANDO: sacar filas viejas del pedido ======
      const prevRows = editingOrderKey
        ? rowsByRole.filter((r) => getRowOrderKey(r) === editingOrderKey)
        : [];

      const prevByProduct = new Map<string, VendorCandyRow>();
      prevRows.forEach((r) => prevByProduct.set(String(r.productId), r));

      for (const it of orderItems) {
        const newPacks = floor(it.packages);
        const prev = editingOrderKey ? prevByProduct.get(it.productId) : null;
        const oldPacks = prev ? floor(prev.packages) : 0;

        const delta = newPacks - oldPacks; // ✅ solo lo extra que se agrega

        if (delta > 0) {
          const avail = availablePacks[it.productId] ?? 0;
          if (delta > avail) {
            return setMsg(
              `❌ "${it.productName}" excede existencias de orden maestra. Existentes: ${avail} (faltan ${delta})`,
            );
          }
        }
      }

      setIsSaving(true);

      const createdAt = Timestamp.now();
      const orderKey = buildOrderKey(sellerId, date);

      const fallbackMargin = getSellerMarginPercent(sellerId);

      // ====== EDIT: devolver paquetes si bajaron o si se quitó un producto ======
      if (editingOrderKey) {
        // A) productos quitados completamente
        const orderItemIds = new Set(
          orderItems.map((it) => String(it.id || "")),
        );
        const removed = prevRows.filter(
          (r) => !orderItemIds.has(String(r.id || "")),
        );

        const removedIds: string[] = [];
        for (const r of removed) {
          await deleteVendorCandyOrderAndRestore(r.id);
          removedIds.push(r.id);
        }

        if (removedIds.length) {
          setRows((prev) => prev.filter((row) => !removedIds.includes(row.id)));
        }

        // B) productos que siguen pero bajaron paquetes
        for (const it of orderItems) {
          const prev = prevByProduct.get(it.productId);
          if (!prev) continue;

          const newPacks = floor(it.packages);
          const oldPacks = floor(prev.packages);
          const delta = newPacks - oldPacks;

          if (delta < 0) {
            const packsToReturn = Math.abs(delta);

            // ⚠️ seguridad: no devolver más de lo que queda
            const canReturn = floor(prev.remainingPackages);
            if (packsToReturn > canReturn) {
              return setMsg(
                `❌ No podés bajar "${it.productName}" en ${packsToReturn} porque solo quedan ${canReturn} paquetes restantes.`,
              );
            }

            await restoreVendorCandyPacks({
              vendorInventoryId: prev.id,
              packagesToReturn: packsToReturn,
            });
          }
        }
      }

      // ====== Asignar paquetes NUEVOS desde orden maestra (delta > 0) ======
      const allocationsByProduct = new Map<string, any[]>();
      for (const it of orderItems) {
        const newPacks = floor(it.packages);
        const prev = editingOrderKey ? prevByProduct.get(it.productId) : null;
        const oldPacks = prev ? floor(prev.packages) : 0;
        const delta = newPacks - oldPacks;

        if (delta > 0) {
          const { allocations } = await allocateVendorCandyPacks({
            productId: it.productId,
            packagesToAllocate: delta,
          });
          allocationsByProduct.set(it.productId, allocations || []);
        }
      }

      await runTransaction(db, async (tx) => {
        for (const it of orderItems) {
          const packs = floor(it.packages);
          const unitsPerPackage = floor(it.unitsPerPackage);
          const totalUnits = packs * unitsPerPackage;

          const prev = editingOrderKey ? prevByProduct.get(it.productId) : null;
          const prevPacks = prev ? floor(prev.packages) : 0;
          const prevRemaining = prev ? floor(prev.remainingPackages) : 0;
          const delta = packs - prevPacks;

          const remainingPackages = prev
            ? Math.max(0, prevRemaining + delta)
            : packs;
          const remainingUnits = remainingPackages * unitsPerPackage;

          const p = productsAll.find((x) => x.id === it.productId);

          const pricePerPackage = p
            ? getPricePerPack(p, br)
            : Number(it.pricePerPackage || 0);

          const grossPerPack = p ? getGrossProfitPerPack(p, br) : 0;
          const grossProfit = grossPerPack * packs;

          const logisticAllocated = p
            ? p.logisticAllocatedPerPack * packs
            : it.logisticAllocated || 0;

          const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
          const uAproximada = uApproxPerPack * packs;

          const vendorMarginPercent =
            it.vendorMarginPercent != null
              ? it.vendorMarginPercent
              : fallbackMargin;

          const split = calcSplitFromGross(grossProfit, vendorMarginPercent);
          const uNeta =
            Number(grossProfit || 0) -
            Number(logisticAllocated || 0) -
            Number(split.uVendor || 0);

          const totalRivas =
            (p?.unitPriceRivas || it.unitPriceRivas || 0) * packs;
          const totalSanJorge =
            (p?.unitPriceSanJorge || it.unitPriceSanJorge || 0) * packs;
          const totalIsla = (p?.unitPriceIsla || it.unitPriceIsla || 0) * packs;

          const payload: any = {
            sellerId: seller.id,
            sellerName: seller.name,
            sellerEmail: seller.email || "",
            branch: seller.branch || "",
            branchLabel: seller.branchLabel || "",

            productId: it.productId,
            productName: it.productName,
            category: it.category,

            orderId: orderKey,
            date,
            createdAt,

            packages: packs,
            unitsPerPackage,
            totalUnits,

            remainingPackages,
            remainingUnits,

            totalRivas,
            totalSanJorge,
            totalIsla,

            unitPriceRivas: p?.unitPriceRivas || it.unitPriceRivas || 0,
            unitPriceSanJorge:
              p?.unitPriceSanJorge || it.unitPriceSanJorge || 0,
            unitPriceIsla: p?.unitPriceIsla || it.unitPriceIsla || 0,

            grossProfit,

            // prorrateo logístico por producto
            logisticAllocated,

            // === PLAN: guardar trazabilidad y split ===
            vendorMarginPercent: split.vendorMarginPercent,
            uVendor: split.uVendor,
            uNeta,
            uAproximada,
            uInvestor: split.uInvestor,

            providerPrice: Number(it.providerPrice ?? p?.providerPrice ?? 0),

            // ⚠️ compat: vendorProfit ahora es U. Vendedor
            vendorProfit: split.uVendor,

            transferDelta: prev ? Number(prev.transferDelta || 0) : 0,
          };

          const extraAllocs = allocationsByProduct.get(it.productId) || [];

          if (editingOrderKey) {
            if (String(it.id || "").startsWith("tmp_")) {
              const ref = doc(collection(db, "inventory_candies_sellers"));
              payload.masterAllocations = extraAllocs;
              tx.set(ref, payload);
            } else {
              const ref = doc(db, "inventory_candies_sellers", it.id);
              if (extraAllocs.length > 0) {
                payload.masterAllocations = arrayUnion(...extraAllocs);
              }
              tx.set(ref, payload, { merge: true });
            }
          } else {
            const ref = doc(collection(db, "inventory_candies_sellers"));
            payload.masterAllocations = extraAllocs;
            tx.set(ref, payload);
          }
        }
      });

      setMsg("✅ Pedido guardado.");
      setOpenForm(false);
      resetForm();
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error guardando el pedido.");
    } finally {
      setIsSaving(false);
    }
  };

  // =========================
  // ADMIN: eliminar pedido completo
  // =========================
  const deleteOrder = async (orderKey: string) => {
    try {
      setMsg("");
      if (!isAdmin) return setMsg("⚠️ Solo admin.");
      setIsSaving(true);
      const orderRows = rowsByRole.filter(
        (r) => getRowOrderKey(r) === orderKey,
      );

      for (const r of orderRows) {
        await deleteVendorCandyOrderAndRestore(r.id);
      }
      setMsg("✅ Pedido eliminado.");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando pedido.");
    } finally {
      setIsSaving(false);
    }
  };

  // =========================
  // INPUT FILE IMPORT (CSV)
  // =========================
  const importInputRef = React.useRef<HTMLInputElement | null>(null);

  const triggerImport = () => {
    if (isReadOnly) return setMsg("⚠️ Solo lectura.");
    if (!sellerId) return setMsg("⚠️ Seleccioná un vendedor.");
    if (!date) return setMsg("⚠️ Seleccioná una fecha.");
    importInputRef.current?.click();
  };

  const onImportChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = "";
    if (!f) return;
    await onImportTemplateFile(f);
  };

  // =========================
  // UI helpers
  // =========================
  // Solo admin puede cambiar el vendedor en el selector
  const disableSellerSelect = !isAdmin;
  const desktopColumns = isAdmin ? 11 : 8;

  // =========================
  // RENDER
  // =========================
  return (
    <div className="p-3 md:p-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center gap-2 md:gap-3 mb-3">
        <div className="flex-1">
          <h2 className="text-lg md:text-2xl font-semibold">
            Órdenes de Vendedor (Dulces)
          </h2>
          <p className="text-xs md:text-sm text-gray-600">
            Pedidos agrupados por vendedor + fecha. U. Bruta viene de la orden
            maestra. U. Neta = U. Bruta - Gastos - U. Vendedor.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <RefreshButton onClick={refresh} />
          {isAdmin && (
            <button
              onClick={() => setOpenTransferModal(true)}
              className="px-3 py-2 rounded bg-amber-600 text-white text-sm hover:bg-amber-700"
            >
              Traslados
            </button>
          )}
          {!isReadOnly && (
            <button
              onClick={openNewOrder}
              className="px-3 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
            >
              + Nuevo pedido
            </button>
          )}
        </div>
      </div>

      {/* Mensajes */}
      {msg && !openForm && (
        <div className="mb-3 p-2 rounded border text-sm bg-white">{msg}</div>
      )}

      {/* Loading */}
      {loading ? (
        <div className="p-4 text-sm text-gray-600">Cargando…</div>
      ) : (
        <>
          {/* Desktop table */}
          <div className="hidden md:block bg-white border rounded">
            <div className="p-3 border-b flex items-center justify-between">
              <div className="text-sm text-gray-700">
                Total pedidos: <b>{orderSummaries.length}</b>
              </div>

              <div className="flex items-center gap-2">
                {isAdmin && (
                  <button
                    className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                    onClick={() => {
                      if (!openForm) {
                        setMsg(
                          "⚠️ Abrí un pedido para exportar productos asociados.",
                        );
                        return;
                      }
                      exportAssociatedItemsToCsv();
                    }}
                  >
                    Exportar asociados
                  </button>
                )}
                {isAdmin && (
                  <>
                    <button
                      className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                      onClick={backfillCalculatedFields}
                      disabled={isBackfilling}
                    >
                      {isBackfilling
                        ? "Actualizando campos..."
                        : "Actualizar campos calculados"}
                    </button>
                    {/* <button
                      className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                      onClick={fixLegacyAssociatedFromRemaining}
                      disabled={isBackfilling}
                    >
                      Reparar P. asociados legacy
                    </button> */}
                  </>
                )}
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[1100px] w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">Fecha</th>
                    <th className="text-left p-2 border-b">Vendedor</th>
                    <th className="text-right p-2 border-b">P. Asociados</th>
                    <th className="text-right p-2 border-b">P. Restantes</th>
                    {isAdmin && (
                      <th className="text-right p-2 border-b">
                        Total esperado
                      </th>
                    )}
                    {isAdmin && (
                      <th className="text-right p-2 border-b">U. Bruta</th>
                    )}
                    {isAdmin && (
                      <th className="text-right p-2 border-b">Gastos</th>
                    )}
                    <th className="text-right p-2 border-b">U. Vendedor</th>
                    <th className="text-right p-2 border-b">Trasl. Salida</th>
                    <th className="text-right p-2 border-b">Trasl. Entrada</th>
                    <th className="text-left p-2 border-b">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {pagedOrders.map((o) => (
                    <tr key={o.orderKey} className="hover:bg-gray-50">
                      <td className="p-2 border-b">{o.date}</td>
                      <td className="p-2 border-b">{o.sellerName}</td>
                      <td className="p-2 border-b text-right">
                        {o.totalPackages}
                      </td>
                      <td className="p-2 border-b text-right">
                        {o.totalRemainingPackages}
                      </td>
                      {isAdmin && (
                        <td className="p-2 border-b text-right">
                          {money(o.totalExpectedActive ?? o.totalExpected)}
                        </td>
                      )}
                      {isAdmin && (
                        <td className="p-2 border-b text-right">
                          {money(o.grossProfitActive ?? o.grossProfit)}
                        </td>
                      )}
                      {isAdmin && (
                        <td className="p-2 border-b text-right">
                          {money((o.gastosActive ?? o.gastos) || 0)}
                        </td>
                      )}
                      <td className="p-2 border-b text-right">
                        {money(o.vendorProfitActive ?? o.vendorProfit)}
                      </td>
                      <td className="p-2 border-b text-right">
                        {o.transferredOut}
                      </td>
                      <td className="p-2 border-b text-right">
                        {o.transferredIn}
                      </td>
                      <td className="p-2 border-b">
                        <div className="flex gap-2">
                          <button
                            className="px-3 py-1.5 rounded bg-gray-900 text-white text-xs hover:bg-black"
                            onClick={() => openEditOrder(o.orderKey)}
                          >
                            Ver / Editar
                          </button>
                          {isAdmin && (
                            <button
                              className="px-3 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700"
                              onClick={() => {
                                if (
                                  confirm("¿Eliminar este pedido completo?")
                                ) {
                                  deleteOrder(o.orderKey);
                                }
                              }}
                            >
                              Eliminar
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}

                  {!pagedOrders.length && (
                    <tr>
                      <td
                        className="p-3 text-sm text-gray-600"
                        colSpan={desktopColumns}
                      >
                        No hay pedidos.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Pagination */}
            <div className="p-3 flex items-center justify-between">
              <div className="text-xs text-gray-600">
                Página {page} / {totalPages}
              </div>
              <div className="flex gap-2">
                <button
                  className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
                  onClick={goPrevPage}
                  disabled={page <= 1}
                >
                  ←
                </button>
                <button
                  className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
                  onClick={goNextPage}
                  disabled={page >= totalPages}
                >
                  →
                </button>
              </div>
            </div>
          </div>

          {/* Mobile cards */}
          <div className="md:hidden space-y-2">
            <div className="bg-white border rounded p-2 flex items-center justify-between">
              <div className="text-xs text-gray-700">
                Total pedidos: <b>{orderSummaries.length}</b>
              </div>
              <div className="text-xs text-gray-600">
                {page}/{totalPages}
              </div>
            </div>

            {pagedOrders.map((o) => (
              <div
                key={o.orderKey}
                className="bg-white border rounded"
                role="button"
                tabIndex={0}
                onClick={() => openEditOrder(o.orderKey)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    openEditOrder(o.orderKey);
                  }
                }}
              >
                <div className="p-2 flex items-center justify-between">
                  <div>
                    <div className="text-sm font-semibold">{o.sellerName}</div>
                    <div className="text-xs text-gray-600">{o.date}</div>
                  </div>

                  {isAdmin && (
                    <button
                      className="px-3 py-2 rounded border text-sm text-red-600"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (confirm("¿Eliminar este pedido completo?")) {
                          deleteOrder(o.orderKey);
                        }
                      }}
                    >
                      Eliminar
                    </button>
                  )}
                </div>

                <div className="px-2 pb-2">
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="border rounded p-2">
                      <div className="text-gray-600">P. Asociados</div>
                      <div className="font-semibold">{o.totalPackages}</div>
                    </div>
                    <div className="border rounded p-2">
                      <div className="text-gray-600">P. Restantes</div>
                      <div className="font-semibold">
                        {o.totalRemainingPackages}
                      </div>
                    </div>
                    {isAdmin && (
                      <div className="border rounded p-2">
                        <div className="text-gray-600">Total esperado</div>
                        <div className="font-semibold">
                          {money(o.totalExpectedActive ?? o.totalExpected)}
                        </div>
                      </div>
                    )}
                    <div className="border rounded p-2">
                      <div className="text-gray-600">U. Vendedor</div>
                      <div className="font-semibold">
                        {money(o.vendorProfitActive ?? o.vendorProfit)}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            ))}

            {!pagedOrders.length && (
              <div className="p-3 text-sm text-gray-600 bg-white border rounded">
                No hay pedidos.
              </div>
            )}

            <div className="flex gap-2">
              <button
                className="flex-1 px-3 py-2 rounded border text-sm"
                onClick={goPrevPage}
                disabled={page <= 1}
              >
                ←
              </button>
              <button
                className="flex-1 px-3 py-2 rounded border text-sm"
                onClick={goNextPage}
                disabled={page >= totalPages}
              >
                →
              </button>
            </div>
          </div>
        </>
      )}

      {/* ===================== MODAL ===================== */}
      {openForm && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3 md:p-6">
          <div className="bg-white w-full max-w-5xl max-h-[90vh] overflow-y-auto rounded shadow relative">
            {isSaving && (
              <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-50">
                <div className="text-sm font-semibold">Guardando…</div>
              </div>
            )}

            <div className="p-3 md:p-5 border-b flex items-center justify-between">
              <div>
                <div className="text-lg font-semibold">
                  {editingOrderKey ? "Editar pedido" : "Nuevo pedido"}
                </div>
                <div className="text-xs text-gray-600">
                  U. Bruta viene de Orden Maestra. U. Vendedor e Inversionista
                  se calculan aquí. U. Neta = U. Bruta - Gastos - U. Vendedor.
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                  onClick={closeForm}
                >
                  Cerrar
                </button>
                {!isReadOnly && (
                  <button
                    className="px-3 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
                    onClick={saveOrder}
                  >
                    Guardar
                  </button>
                )}
              </div>
            </div>

            {/* Form */}
            <div className="p-3 md:p-5 space-y-3">
              {/* Mobile collapse toggle */}
              <button
                type="button"
                className="md:hidden w-full px-3 py-2 rounded border text-sm flex items-center justify-between"
                onClick={() => setMobileMetaOpen((v) => !v)}
              >
                <span>Filtros y KPIs</span>
                <span>{mobileMetaOpen ? "−" : "+"}</span>
              </button>

              <div
                className={`${mobileMetaOpen ? "block" : "hidden"} md:block space-y-3`}
              >
                {/* Top selectors */}
                <div className="grid md:grid-cols-3 gap-2">
                  <div>
                    <label className="text-xs text-gray-600">Vendedor</label>
                    <select
                      className="w-full border rounded p-2 text-sm"
                      value={sellerId}
                      onChange={(e) => setSellerId(e.target.value)}
                      disabled={disableSellerSelect}
                    >
                      <option value="">-- Seleccionar --</option>
                      {sellers.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.name} {s.branch ? `(${s.branch})` : ""}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="text-xs text-gray-600">Fecha</label>
                    <input
                      type="date"
                      className="w-full border rounded p-2 text-sm"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>

                  <div className="flex items-end gap-2">
                    <button
                      className="flex-1 px-3 py-2 rounded border text-sm hover:bg-gray-50"
                      onClick={downloadTemplateFromMainOrders}
                    >
                      Plantilla
                    </button>

                    <button
                      className="flex-1 px-3 py-2 rounded border text-sm hover:bg-gray-50"
                      onClick={triggerImport}
                    >
                      Importar CSV
                    </button>

                    <input
                      ref={importInputRef}
                      type="file"
                      accept=".csv,text/csv"
                      className="hidden"
                      onChange={onImportChange}
                    />
                  </div>
                </div>

                {/* KPIs */}
                <div className="grid grid-cols-2 md:grid-cols-6 gap-2">
                  <div className="border rounded p-2">
                    <div className="text-xs text-gray-600">P. asociados</div>
                    <div className="text-lg font-semibold">
                      {kpiTotals.totalPackages}
                    </div>
                  </div>

                  {isAdmin && (
                    <>
                      <div className="border rounded p-2">
                        <div className="text-xs text-gray-600">
                          Total esperado
                        </div>
                        <div className="text-lg font-semibold">
                          {money(kpiTotals.totalExpected)}
                        </div>
                      </div>
                      <div className="border rounded p-2">
                        <div className="text-xs text-gray-600">U. Bruta</div>
                        <div className="text-lg font-semibold">
                          {money(kpiTotals.grossProfit)}
                        </div>
                      </div>
                    </>
                  )}

                  <div className="border rounded p-2">
                    <div className="text-xs text-gray-600">U. Vendedor</div>
                    <div className="text-lg font-semibold">
                      {money(kpiTotals.uVendor)}
                    </div>
                  </div>

                  {isAdmin && (
                    <div className="border rounded p-2">
                      <div className="text-xs text-gray-600">U. Neta</div>
                      <div className="text-lg font-semibold">
                        {money(kpiUNeta)}
                      </div>
                    </div>
                  )}
                </div>
              </div>

              {/* Add product row */}
              <div className="border rounded p-3 space-y-2">
                <button
                  type="button"
                  className="md:hidden w-full px-3 py-2 rounded border text-sm flex items-center justify-between"
                  onClick={() => setMobileAddOpen((v) => !v)}
                >
                  <span>Agregar producto</span>
                  <span>{mobileAddOpen ? "−" : "+"}</span>
                </button>

                <div
                  className={`${mobileAddOpen ? "block" : "hidden"} md:block space-y-2`}
                >
                  <div className="text-sm font-semibold hidden md:block">
                    Agregar producto
                  </div>

                  <div className="grid md:grid-cols-4 gap-2">
                    <div className="md:col-span-2">
                      <label className="text-xs text-gray-600">Buscar</label>
                      <input
                        className="w-full border rounded p-2 text-sm"
                        value={productSearch}
                        onChange={(e) => setProductSearch(e.target.value)}
                        placeholder="Buscar por categoría o nombre…"
                      />
                    </div>

                    <div className="md:col-span-2">
                      <label className="text-xs text-gray-600">Producto</label>
                      <select
                        className="w-full border rounded p-2 text-sm"
                        value={selectedProductId}
                        onChange={(e) => setSelectedProductId(e.target.value)}
                      >
                        <option value="">-- Seleccionar --</option>
                        {filteredProductsForPicker.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.category} - {p.name} (exist:{" "}
                            {availablePacks[p.id] ?? 0})
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="text-xs text-gray-600">Paquetes</label>
                      <input
                        className="w-full border rounded p-2 text-sm"
                        value={packagesToAdd}
                        onChange={(e) => setPackagesToAdd(e.target.value)}
                        inputMode="numeric"
                      />
                    </div>

                    <div className="flex items-end">
                      <button
                        className="w-full px-3 py-2 rounded bg-gray-900 text-white text-sm hover:bg-black"
                        onClick={addItemToOrder}
                        disabled={!selectedProduct}
                      >
                        Agregar
                      </button>
                    </div>
                  </div>
                </div>
              </div>

              {/* Items table */}
              <div className="border rounded">
                <div className="p-3 border-b flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    Productos asociados ({orderItems.length})
                  </div>

                  <div className="flex gap-2">
                    <input
                      className="border rounded px-2 py-1 text-sm"
                      placeholder="Buscar producto"
                      value={associatedSearch}
                      onChange={(e) => {
                        setAssociatedSearch(e.target.value);
                        setItemsPage(1);
                      }}
                    />
                    {isAdmin && (
                      <button
                        className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                        onClick={exportAssociatedItemsToCsv}
                        disabled={!orderItems.length}
                      >
                        Exportar CSV
                      </button>
                    )}
                  </div>
                </div>

                {/* Desktop table */}
                <div className="hidden md:block overflow-x-auto">
                  <table className="min-w-[1400px] w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left p-2 border-b">Categoría</th>
                        <th className="text-left p-2 border-b">Producto</th>
                        <th className="text-right p-2 border-b">
                          P. Asociados{" "}
                        </th>
                        <th className="text-right p-2 border-b">
                          P. Restantes
                        </th>
                        {isAdmin && (
                          <th className="text-right p-2 border-b">
                            Precio prov.
                          </th>
                        )}
                        <th className="text-right p-2 border-b">Precio/paq</th>
                        <th className="text-right p-2 border-b">
                          Total esperado
                        </th>
                        {isAdmin && (
                          <>
                            <th className="text-right p-2 border-b">
                              U. Bruta
                            </th>
                            <th className="text-right p-2 border-b">Gastos</th>
                            <th className="text-right p-2 border-b">U. Neta</th>
                          </>
                        )}
                        <th className="text-right p-2 border-b">U. Vendedor</th>
                        <th className="text-right p-2 border-b">Margen (%)</th>
                        <th className="text-left p-2 border-b">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedOrderItems.map((it) => {
                        const {
                          totalExpected,
                          grossProfit,
                          gastos,
                          uVendor,
                          uNeta,
                        } = getItemActiveFinancials(it);

                        return (
                          <tr key={it.id} className="hover:bg-gray-50">
                            <td className="p-2 border-b">{it.category}</td>
                            <td className="p-2 border-b">{it.productName}</td>

                            <td className="p-2 border-b text-right">
                              {!isReadOnly ? (
                                <input
                                  className="w-20 border rounded p-1 text-right"
                                  value={String(it.packages)}
                                  onChange={(e) =>
                                    updateItemPackages(it.id, e.target.value)
                                  }
                                  inputMode="numeric"
                                />
                              ) : (
                                <span>{it.packages}</span>
                              )}
                            </td>

                            <td className="p-2 border-b text-right">
                              {it.remainingPackages}
                            </td>

                            {isAdmin && (
                              <td className="p-2 border-b text-right">
                                {money((it as any).providerPrice || 0)}
                              </td>
                            )}

                            <td className="p-2 border-b text-right">
                              {money(it.pricePerPackage)}
                            </td>

                            <td className="p-2 border-b text-right">
                              {money(totalExpected)}
                            </td>

                            {isAdmin && (
                              <>
                                <td className="p-2 border-b text-right">
                                  {money(grossProfit)}
                                </td>

                                <td className="p-2 border-b text-right">
                                  {money(gastos)}
                                </td>

                                <td className="p-2 border-b text-right">
                                  {money(uNeta)}
                                </td>
                              </>
                            )}

                            <td className="p-2 border-b text-right">
                              {money(uVendor)}
                            </td>

                            <td className="p-2 border-b text-right">
                              {!isReadOnly ? (
                                <input
                                  type="number"
                                  step="0.01"
                                  min={0}
                                  className="w-20 border rounded p-1 text-right"
                                  value={String(
                                    it.vendorMarginPercent ??
                                      getSellerMarginPercent(sellerId),
                                  )}
                                  onChange={(e) =>
                                    updateItemVendorMarginPercent(
                                      it.id,
                                      e.target.value,
                                    )
                                  }
                                  inputMode="decimal"
                                />
                              ) : (
                                <span>
                                  {Number(
                                    it.vendorMarginPercent ??
                                      getSellerMarginPercent(sellerId),
                                  ).toFixed(2)}
                                  %
                                </span>
                              )}
                            </td>

                            <td className="p-2 border-b">
                              {!isReadOnly && (
                                <button
                                  className="px-3 py-1.5 rounded bg-red-600 text-white text-xs hover:bg-red-700"
                                  onClick={() => removeItem(it.id)}
                                >
                                  Quitar
                                </button>
                              )}
                            </td>
                          </tr>
                        );
                      })}

                      {!pagedOrderItems.length && (
                        <tr>
                          <td
                            className="p-3 text-sm text-gray-600"
                            colSpan={isAdmin ? 13 : 9}
                          >
                            No hay productos asociados.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile cards by category */}
                <div className="md:hidden p-3 space-y-2">
                  {pagedItemsByCategory.map(([cat, items]) => {
                    const expanded = !!openCategoryMap[cat];
                    return (
                      <div key={cat} className="border rounded">
                        <button
                          type="button"
                          className="w-full px-3 py-2 flex items-center justify-between text-sm"
                          onClick={() => toggleCategory(cat)}
                        >
                          <span className="font-semibold">{cat}</span>
                          <span className="text-xs text-gray-600">
                            {items.length}{" "}
                            {items.length === 1 ? "producto" : "productos"}
                          </span>
                        </button>

                        {expanded && (
                          <div className="px-3 pb-3 space-y-2">
                            {items.map((it) => {
                              const {
                                totalExpected,
                                grossProfit,
                                gastos,
                                uVendor,
                                uNeta,
                              } = getItemActiveFinancials(it);

                              return (
                                <div
                                  key={it.id}
                                  className="border rounded p-2 text-xs space-y-2"
                                >
                                  <div className="font-semibold text-sm">
                                    {it.productName}
                                  </div>

                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <div className="text-gray-600">
                                        Paquetes
                                      </div>
                                      {!isReadOnly ? (
                                        <input
                                          className="w-full border rounded p-1 text-right"
                                          value={String(it.packages)}
                                          onChange={(e) =>
                                            updateItemPackages(
                                              it.id,
                                              e.target.value,
                                            )
                                          }
                                          inputMode="numeric"
                                        />
                                      ) : (
                                        <div className="font-semibold">
                                          {it.packages}
                                        </div>
                                      )}
                                    </div>
                                    <div>
                                      <div className="text-gray-600">
                                        Restantes
                                      </div>
                                      <div className="font-semibold">
                                        {it.remainingPackages}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-gray-600">
                                        Precio/paq
                                      </div>
                                      <div className="font-semibold">
                                        {money(it.pricePerPackage)}
                                      </div>
                                    </div>
                                    <div>
                                      <div className="text-gray-600">
                                        Total esperado
                                      </div>
                                      <div className="font-semibold">
                                        {money(totalExpected)}
                                      </div>
                                    </div>
                                    {isAdmin && (
                                      <>
                                        <div>
                                          <div className="text-gray-600">
                                            U. Bruta
                                          </div>
                                          <div className="font-semibold">
                                            {money(grossProfit)}
                                          </div>
                                        </div>
                                        <div>
                                          <div className="text-gray-600">
                                            Gastos
                                          </div>
                                          <div className="font-semibold">
                                            {money(gastos)}
                                          </div>
                                        </div>
                                      </>
                                    )}
                                    <div>
                                      <div className="text-gray-600">
                                        U. Vendedor
                                      </div>
                                      <div className="font-semibold">
                                        {money(uVendor)}
                                      </div>
                                    </div>
                                    {isAdmin && (
                                      <div>
                                        <div className="text-gray-600">
                                          U. Neta
                                        </div>
                                        <div className="font-semibold">
                                          {money(uNeta)}
                                        </div>
                                      </div>
                                    )}
                                  </div>

                                  <div className="flex items-center gap-2">
                                    <div className="flex-1">
                                      <div className="text-gray-600">
                                        Margen (%)
                                      </div>
                                      {!isReadOnly ? (
                                        <input
                                          type="number"
                                          step="0.01"
                                          min={0}
                                          className="w-full border rounded p-1 text-right"
                                          value={String(
                                            it.vendorMarginPercent ??
                                              getSellerMarginPercent(sellerId),
                                          )}
                                          onChange={(e) =>
                                            updateItemVendorMarginPercent(
                                              it.id,
                                              e.target.value,
                                            )
                                          }
                                          inputMode="decimal"
                                        />
                                      ) : (
                                        <div className="font-semibold">
                                          {Number(
                                            it.vendorMarginPercent ??
                                              getSellerMarginPercent(sellerId),
                                          ).toFixed(2)}
                                          %
                                        </div>
                                      )}
                                    </div>

                                    {!isReadOnly && (
                                      <button
                                        className="px-3 py-2 rounded bg-red-600 text-white text-xs"
                                        onClick={() => removeItem(it.id)}
                                      >
                                        Quitar
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}

                  {!pagedOrderItems.length && (
                    <div className="p-3 text-sm text-gray-600 text-center">
                      No hay productos asociados.
                    </div>
                  )}
                </div>
                {/* items pagination */}
                <div className="p-3 flex items-center justify-between">
                  <div className="text-xs text-gray-600">
                    Página items {itemsPage} / {itemsTotalPages}
                  </div>
                  <div className="flex gap-2">
                    <button
                      className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
                      onClick={itemsPrev}
                      disabled={itemsPage <= 1}
                    >
                      ←
                    </button>
                    <button
                      className="px-3 py-1.5 rounded border text-sm hover:bg-gray-50"
                      onClick={itemsNext}
                      disabled={itemsPage >= itemsTotalPages}
                    >
                      →
                    </button>
                  </div>
                </div>
              </div>

              {/* Footer actions */}
              <div className="flex flex-col md:flex-row gap-2 md:items-center md:justify-between">
                <div className="text-xs text-gray-600">
                  {editingOrderKey ? (
                    <>
                      Editando: <b>{editingOrderKey}</b>
                    </>
                  ) : (
                    <>Nuevo pedido (aún no guardado)</>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                    onClick={closeForm}
                  >
                    Cancelar
                  </button>

                  {!isReadOnly && (
                    <button
                      className="px-3 py-2 rounded bg-blue-600 text-white text-sm hover:bg-blue-700"
                      onClick={saveOrder}
                    >
                      Guardar pedido
                    </button>
                  )}
                </div>
              </div>

              {/* msg inside modal */}
              {msg && <div className="text-sm text-gray-700">{msg}</div>}
            </div>
          </div>
        </div>
      )}

      {/* Traslados modal */}
      <TrasladosModal
        open={openTransferModal}
        onClose={() => setOpenTransferModal(false)}
        orders={orderSummaries}
        rows={rows}
        setRows={setRows}
        isAdmin={isAdmin}
        currentUserEmail={currentUserEmail || ""}
        currentUserName={""} // Ajusta si tienes el nombre del usuario
        sellerCandyId={sellerCandyId}
        sellers={sellers}
        products={productsAll}
        transferAgg={transferAgg}
        setTransferAgg={setTransferAgg}
        setTransferRowDeltas={setTransferRowDeltas}
      />
    </div>
  );
}
