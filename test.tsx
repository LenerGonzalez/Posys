// src/components/Candies/VendorCandyOrders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  runTransaction,
} from "firebase/firestore";
import { db } from "../../../firebase";
import RefreshButton from "../../common/RefreshButton";
import useManualRefresh from "../../../hooks/useManualRefresh";
import { deleteVendorCandyOrderAndRestore } from "../../../Services/Candies_vendor_orders";
import { hasRole } from "../../../utils/roles";

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

  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  grossProfitPerPackRivas: number;
  grossProfitPerPackSanJorge: number;
  grossProfitPerPackIsla: number;

  uApproxPerPackRivas: number;
  uApproxPerPackSanJorge: number;
  uApproxPerPackIsla: number;

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

  // === PLAN: mover cálculo aquí ===
  vendorMarginPercent: number; // % vendedor sobre U Aproximada
  uAproximada: number; // total
  uVendor: number; // U. Vendedor
  uInvestor: number; // U. Inversionista

  // ⚠️ Compatibilidad: se mantiene vendorProfit (pero ahora equivale a uVendor)
  vendorProfit: number;

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

  grossProfit: number;

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
}

// Resumen de pedido para listado
interface OrderSummaryRow {
  orderKey: string;
  sellerId: string;
  sellerName: string;
  date: string;

  totalPackages: number;
  totalRemainingPackages: number;

  totalExpected: number;
  grossProfit: number;
  vendorProfit: number; // ahora = U. Vendedor (por compat)

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

  // ===== Modal pedido =====
  const [openForm, setOpenForm] = useState(false);
  const [editingOrderKey, setEditingOrderKey] = useState<string | null>(null);

  const [sellerId, setSellerId] = useState<string>("");
  const [date, setDate] = useState<string>("");

  const [selectedProductId, setSelectedProductId] = useState<string>("");
  const [packagesToAdd, setPackagesToAdd] = useState<string>("0");
  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [productSearch, setProductSearch] = useState("");

  const [isSaving, setIsSaving] = useState(false);

  // ===== Listado: paginado 20 =====
  const PAGE_SIZE = 20;
  const [page, setPage] = useState(1);

  // ===== Modal items: paginado 20 =====
  const ITEMS_PAGE_SIZE = 20;
  const [itemsPage, setItemsPage] = useState(1);

  // ===== Mobile cards =====
  const [expandedOrderKey, setExpandedOrderKey] = useState<string | null>(null);

  // ===== Traslados (agg) =====
  const [transferAgg, setTransferAgg] = useState<
    Record<string, { out: number; in: number }>
  >({});

  const selectedSeller = useMemo(
    () => sellers.find((s) => s.id === sellerId) || null,
    [sellerId, sellers],
  );

  const sellerBranch: Branch | undefined = selectedSeller?.branch;

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

  // Productos picker: existencias > 0 (o si ya está en orden)
  const productsForPicker = useMemo(() => {
    return productsAll
      .filter((p) => {
        const avail = availablePacks[p.id] ?? 0;
        return avail > 0 || inOrderSet.has(p.id);
      })
      .sort((a, b) =>
        `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`),
      );
  }, [productsAll, availablePacks, inOrderSet]);

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

      if (!isVendor) {
        const snap = await getDocs(colRef);
        const agg: Record<string, { out: number; in: number }> = {};

        snap.forEach((d) => {
          const x = d.data() as any;
          const packs = Number(x.packagesMoved || 0);
          const fromKey = String(x.fromOrderKey || "");
          const toKey = String(x.toOrderKey || "");

          if (fromKey) {
            agg[fromKey] = agg[fromKey] || { out: 0, in: 0 };
            agg[fromKey].out += packs;
          }
          if (toKey) {
            agg[toKey] = agg[toKey] || { out: 0, in: 0 };
            agg[toKey].in += packs;
          }
        });

        setTransferAgg(agg);
        return;
      }

      const qFrom = query(colRef, where("fromSellerId", "==", sellerCandyId));
      const qTo = query(colRef, where("toSellerId", "==", sellerCandyId));
      const [sFrom, sTo] = await Promise.all([getDocs(qFrom), getDocs(qTo)]);

      const agg: Record<string, { out: number; in: number }> = {};

      const apply = (docs: any[], mode: "out" | "in") => {
        docs.forEach((d) => {
          const x = d.data() as any;
          const packs = Number(x.packagesMoved || 0);
          const key =
            mode === "out"
              ? String(x.fromOrderKey || "")
              : String(x.toOrderKey || "");
          if (!key) return;
          agg[key] = agg[key] || { out: 0, in: 0 };
          agg[key][mode] += packs;
        });
      };

      apply(sFrom.docs, "out");
      apply(sTo.docs, "in");

      setTransferAgg(agg);
    } catch (e) {
      console.error(e);
      setTransferAgg({});
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

            unitPriceRivas: number;
            unitPriceSanJorge: number;
            unitPriceIsla: number;

            grossProfitPerPackRivas: number;
            grossProfitPerPackSanJorge: number;
            grossProfitPerPackIsla: number;

            uApproxPerPackRivas: number;
            uApproxPerPackSanJorge: number;
            uApproxPerPackIsla: number;

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

            const cand = {
              id: pid,
              name: String(it.name || it.productName || ""),
              category: String(it.category || ""),
              unitsPerPackage: floor(it.unitsPerPackage ?? 0),

              unitPriceRivas: upr,
              unitPriceSanJorge: ups,
              unitPriceIsla: upi,

              grossProfitPerPackRivas: gpR / packsLine,
              grossProfitPerPackSanJorge: gpSJ / packsLine,
              grossProfitPerPackIsla: gpI / packsLine,

              uApproxPerPackRivas: uApproxPerPack,
              uApproxPerPackSanJorge: uApproxPerPack,
              uApproxPerPackIsla: uApproxPerPack,

              key: makeKey(dateStr, createdAtSec),
            };

            const prev = pick[pid];
            if (!prev || cand.key > prev.key) pick[pid] = cand;
          }
        });

        const avail: Record<string, number> = {};
        Object.keys(existing).forEach((k) => (avail[k] = floor(existing[k])));
        setAvailablePacks(avail);

        const pList: ProductCandyFromMain[] = Object.keys(pick)
          .map((pid) => {
            const p = pick[pid];
            return {
              id: p.id,
              name: p.name,
              category: p.category,
              unitsPerPackage: p.unitsPerPackage,

              unitPriceRivas: p.unitPriceRivas,
              unitPriceSanJorge: p.unitPriceSanJorge,
              unitPriceIsla: p.unitPriceIsla,

              grossProfitPerPackRivas: p.grossProfitPerPackRivas,
              grossProfitPerPackSanJorge: p.grossProfitPerPackSanJorge,
              grossProfitPerPackIsla: p.grossProfitPerPackIsla,

              uApproxPerPackRivas: p.uApproxPerPackRivas,
              uApproxPerPackSanJorge: p.uApproxPerPackSanJorge,
              uApproxPerPackIsla: p.uApproxPerPackIsla,

              existingPacks: avail[p.id] ?? 0,
            };
          })
          .sort((a, b) =>
            `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`),
          );

        setProductsAll(pList);

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

        const invList: VendorCandyRow[] = [];
        invSnap.forEach((d) => {
          const x = d.data() as any;

          const vendorMarginPercent = clampPercent(
            x.vendorMarginPercent ?? x.vendorMargin ?? x.commissionPercent ?? 0,
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

          const split = hasUVendor
            ? {
                uAproximada: Number(uAproximada || 0),
                vendorMarginPercent,
                uVendor: Number(uVendorRaw || 0),
                uInvestor: Number(uAproximada || 0) - Number(uVendorRaw || 0),
              }
            : calcSplit(uAproximada, vendorMarginPercent);

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

            vendorMarginPercent: split.vendorMarginPercent,
            uAproximada: split.uAproximada,
            uVendor: split.uVendor,
            uInvestor: split.uInvestor,

            vendorProfit: Number(x.vendorProfit ?? split.uVendor ?? 0),

            subtotal: Number(x.subtotal || 0),
            providerPrice: Number(x.providerPrice || 0),

            date: x.date || "",
            createdAt: x.createdAt || Timestamp.now(),
          });
        });

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

  // =========================
  // AGRUPAR a "pedidos" (OrderSummaryRow)
  // =========================
  const orderSummaries = useMemo(() => {
    const agg = new Map<string, OrderSummaryRow>();

    for (const r of rowsByRole) {
      const key = buildOrderKey(r.sellerId, r.date);
      const cur =
        agg.get(key) ||
        ({
          orderKey: key,
          sellerId: r.sellerId,
          sellerName: r.sellerName,
          date: r.date,
          totalPackages: 0,
          totalRemainingPackages: 0,
          totalExpected: 0,
          grossProfit: 0,
          vendorProfit: 0,
          transferredOut: 0,
          transferredIn: 0,
        } as OrderSummaryRow);

      cur.totalPackages += Number(r.packages || 0);
      cur.totalRemainingPackages += Number(r.remainingPackages || 0);

      const seller = sellers.find((s) => s.id === r.sellerId) || null;
      const br = seller?.branch;

      if (br === "RIVAS") cur.totalExpected += Number(r.totalRivas || 0);
      else if (br === "SAN_JORGE")
        cur.totalExpected += Number(r.totalSanJorge || 0);
      else cur.totalExpected += Number(r.totalIsla || 0);

      cur.grossProfit += Number(r.grossProfit || 0);

      // vendorProfit (compat) = U. Vendedor
      cur.vendorProfit += Number(r.uVendor ?? r.vendorProfit ?? 0);

      agg.set(key, cur);
    }

    const out: OrderSummaryRow[] = [];
    for (const v of agg.values()) {
      const tr = transferAgg[v.orderKey] || { out: 0, in: 0 };
      v.transferredOut = tr.out || 0;
      v.transferredIn = tr.in || 0;
      out.push(v);
    }

    out.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
    return out;
  }, [rowsByRole, sellers, transferAgg]);

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
  const itemsTotalPages = useMemo(() => {
    return Math.max(1, Math.ceil(orderItems.length / ITEMS_PAGE_SIZE));
  }, [orderItems.length]);

  useEffect(() => {
    if (itemsPage > itemsTotalPages) setItemsPage(itemsTotalPages);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemsTotalPages]);

  const pagedOrderItems = useMemo(() => {
    const start = (itemsPage - 1) * ITEMS_PAGE_SIZE;
    return orderItems.slice(start, start + ITEMS_PAGE_SIZE);
  }, [orderItems, itemsPage]);

  const itemsPrev = () => setItemsPage((p) => Math.max(1, p - 1));
  const itemsNext = () => setItemsPage((p) => Math.min(itemsTotalPages, p + 1));

  // =========================
  // KPIs del modal (orden actual)
  // =========================
 const kpiTotals = useMemo(() => {
   const totalPackages = orderItems.reduce(
     (acc, it) => acc + Number(it.packages || 0),
     0,
   );

   const totalExpected = orderItems.reduce(
     (acc, it) => acc + Number(it.totalExpected || 0),
     0,
   );

   const grossProfit = orderItems.reduce(
     (acc, it) => acc + Number(it.grossProfit || 0),
     0,
   );

   const uAproximada = orderItems.reduce(
     (acc, it) => acc + Number(it.uAproximada || 0),
     0,
   );

   const uVendor = orderItems.reduce(
     (acc, it) => acc + Number(it.uVendor || 0),
     0,
   );

   const uInvestor = orderItems.reduce(
     (acc, it) => acc + Number(it.uInvestor || 0),
     0,
   );

   // compat (si todavía lo ocupás en otro lado)
   const vendorProfit = uVendor;

   return {
     totalPackages,
     totalExpected,
     grossProfit,
     uAproximada,
     uVendor,
     uInvestor,
     vendorProfit,
   };
 }, [orderItems]);

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
    setExpandedOrderKey(null);
  };

  const openEditOrder = (orderKey: string) => {
    setMsg("");
    resetForm();
    setEditingOrderKey(orderKey);

    const [sid, d] = orderKey.split("__");
    setSellerId(sid || "");
    setDate(d || "");

    const orderRows = rowsByRole.filter(
      (r) => buildOrderKey(r.sellerId, r.date) === orderKey,
    );

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

      const split = calcSplit(Number(r.uAproximada || 0), vendorMarginPercent);

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

        vendorMarginPercent: split.vendorMarginPercent,
        uAproximada: split.uAproximada,
        uVendor: Number(r.uVendor ?? split.uVendor ?? 0),
        uInvestor: Number(r.uInvestor ?? split.uInvestor ?? 0),

        totalRivas,
        totalSanJorge,
        totalIsla,

        unitPriceRivas,
        unitPriceSanJorge,
        unitPriceIsla,

        remainingPackages: Number(r.remainingPackages || 0),
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

    const vendorMarginPercent = getSellerMarginPercent(sellerId);
    const split = calcSplit(uAproximada, vendorMarginPercent);

    const totalExpected = pricePerPackage * packs;
    const grossProfit = grossPerPack * packs;

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

      vendorMarginPercent: split.vendorMarginPercent,
      uAproximada: split.uAproximada,
      uVendor: split.uVendor,
      uInvestor: split.uInvestor,

      totalRivas: (p.unitPriceRivas || 0) * packs,
      totalSanJorge: (p.unitPriceSanJorge || 0) * packs,
      totalIsla: (p.unitPriceIsla || 0) * packs,

      unitPriceRivas: p.unitPriceRivas || 0,
      unitPriceSanJorge: p.unitPriceSanJorge || 0,
      unitPriceIsla: p.unitPriceIsla || 0,

      remainingPackages: 0,
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
    const packs = floor(packsRaw);
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

        const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
        const uAproximada = uApproxPerPack * packs;

        const vendorMarginPercent =
          it.vendorMarginPercent != null
            ? it.vendorMarginPercent
            : getSellerMarginPercent(sellerId);

        const split = calcSplit(uAproximada, vendorMarginPercent);

        return {
          ...it,
          packages: packs,
          pricePerPackage,
          totalExpected: pricePerPackage * packs,
          grossProfit,

          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada: split.uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,

          totalRivas: (p?.unitPriceRivas || it.unitPriceRivas || 0) * packs,
          totalSanJorge:
            (p?.unitPriceSanJorge || it.unitPriceSanJorge || 0) * packs,
          totalIsla: (p?.unitPriceIsla || it.unitPriceIsla || 0) * packs,
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

        const split = calcSplit(uAproximada, pct);

        return {
          ...it,
          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada: split.uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,
        };
      }),
    );
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
      "Total esperado",
      "U. Bruta",
      "U. Vendedor",
      "U. Inversionista",
      "P. Rivas",
      "P. San Jorge",
      "P. Isla",
      "Total Rivas",
      "Total San Jorge",
      "Total Isla",
      "Unidades x paquete",
      // === PLAN (obligatorio en export): NO eliminar previas, SOLO agregar ===
      "vendorMarginPercent",
      "uAproximada",
      "uVendor",
      "uInvestor",
    ];

    const seller = sellers.find((s) => s.id === sellerId) || null;
    const branchLabel =
      seller?.branch || normalizeBranch(seller?.branchLabel) || "—";

    const lines = [
      headers.join(","),
      ...orderItems.map((it) => {
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
          String(Number(it.totalExpected || 0).toFixed(2)),
          String(Number(it.grossProfit || 0).toFixed(2)),
          String(Number(it.uVendor || 0).toFixed(2)),
          String(Number(it.uInvestor || 0).toFixed(2)),
          String(Number(it.unitPriceRivas || 0).toFixed(2)),
          String(Number(it.unitPriceSanJorge || 0).toFixed(2)),
          String(Number(it.unitPriceIsla || 0).toFixed(2)),
          String(Number(it.totalRivas || 0).toFixed(2)),
          String(Number(it.totalSanJorge || 0).toFixed(2)),
          String(Number(it.totalIsla || 0).toFixed(2)),
          String(Number(it.unitsPerPackage || 0)),
          String(Number(it.vendorMarginPercent || 0).toFixed(2)),
          String(Number(it.uAproximada || 0).toFixed(2)),
          String(Number(it.uVendor || 0).toFixed(2)),
          String(Number(it.uInvestor || 0).toFixed(2)),
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
        [x.id, x.name, x.category, String(x.existentes), "", ""]
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

        const uApproxPerPack = getUApproxPerPack(p, br);
        const uAproximada = uApproxPerPack * packs;
        const split = calcSplit(uAproximada, vendorMarginPercent);

        const exists = orderItems.find((x) => x.productId === pid);
        if (exists) {
          // mantener margen del archivo si viene, si no mantener el que ya tenía
          const nextMargin =
            idxMargin >= 0 && String(r[idxMargin] ?? "").trim() !== ""
              ? vendorMarginPercent
              : exists.vendorMarginPercent;

          const recalc = calcSplit(uAproximada, nextMargin);

          setOrderItems((prev) =>
            prev.map((it) =>
              it.id === exists.id
                ? {
                    ...it,
                    packages: packs,
                    pricePerPackage,
                    totalExpected,
                    grossProfit,

                    vendorMarginPercent: recalc.vendorMarginPercent,
                    uAproximada: recalc.uAproximada,
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

          vendorMarginPercent: split.vendorMarginPercent,
          uAproximada: split.uAproximada,
          uVendor: split.uVendor,
          uInvestor: split.uInvestor,

          totalRivas: (p.unitPriceRivas || 0) * packs,
          totalSanJorge: (p.unitPriceSanJorge || 0) * packs,
          totalIsla: (p.unitPriceIsla || 0) * packs,

          unitPriceRivas: p.unitPriceRivas || 0,
          unitPriceSanJorge: p.unitPriceSanJorge || 0,
          unitPriceIsla: p.unitPriceIsla || 0,

          remainingPackages: 0,
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

      for (const it of orderItems) {
        const avail = availablePacks[it.productId] ?? 0;
        if (Number(it.packages || 0) > avail) {
          return setMsg(
            `❌ "${it.productName}" excede existencias de orden maestra. Existentes: ${avail}`,
          );
        }
      }

      setIsSaving(true);

      if (editingOrderKey) {
        try {
          await (deleteVendorCandyOrderAndRestore as any)(editingOrderKey);
        } catch (e) {
          console.warn(
            "deleteVendorCandyOrderAndRestore falló o no aplica:",
            e,
          );
        }
      }

      const createdAt = Timestamp.now();
      const orderKey = buildOrderKey(sellerId, date);

      const fallbackMargin = getSellerMarginPercent(sellerId);

      await runTransaction(db, async (tx) => {
        for (const it of orderItems) {
          const packs = floor(it.packages);
          const totalUnits = packs * floor(it.unitsPerPackage);

          const p = productsAll.find((x) => x.id === it.productId);

          const pricePerPackage = p
            ? getPricePerPack(p, br)
            : Number(it.pricePerPackage || 0);

          const grossPerPack = p ? getGrossProfitPerPack(p, br) : 0;
          const grossProfit = grossPerPack * packs;

          const uApproxPerPack = p ? getUApproxPerPack(p, br) : 0;
          const uAproximada = uApproxPerPack * packs;

          const vendorMarginPercent =
            it.vendorMarginPercent != null
              ? it.vendorMarginPercent
              : fallbackMargin;

          const split = calcSplit(uAproximada, vendorMarginPercent);

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
            unitsPerPackage: floor(it.unitsPerPackage),
            totalUnits,

            remainingPackages: packs,
            remainingUnits: totalUnits,

            totalRivas,
            totalSanJorge,
            totalIsla,

            unitPriceRivas: p?.unitPriceRivas || it.unitPriceRivas || 0,
            unitPriceSanJorge:
              p?.unitPriceSanJorge || it.unitPriceSanJorge || 0,
            unitPriceIsla: p?.unitPriceIsla || it.unitPriceIsla || 0,

            grossProfit,

            // === PLAN: guardar trazabilidad y split ===
            vendorMarginPercent: split.vendorMarginPercent,
            uAproximada: split.uAproximada,
            uVendor: split.uVendor,
            uInvestor: split.uInvestor,

            // ⚠️ compat: vendorProfit ahora es U. Vendedor
            vendorProfit: split.uVendor,
          };

          if (editingOrderKey) {
            if (String(it.id || "").startsWith("tmp_")) {
              const ref = doc(collection(db, "inventory_candies_sellers"));
              tx.set(ref, payload);
            } else {
              const ref = doc(db, "inventory_candies_sellers", it.id);
              tx.set(ref, payload, { merge: true });
            }
          } else {
            const ref = doc(collection(db, "inventory_candies_sellers"));
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
      await (deleteVendorCandyOrderAndRestore as any)(orderKey);
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
  const toggleExpand = (key: string) => {
    setExpandedOrderKey((prev) => (prev === key ? null : key));
  };

  const disableSellerSelect = isVendor && !!currentSeller;

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
            maestra. U. Vendedor y U. Inversionista se calculan aquí sobre U.
            Aproximada.
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          <RefreshButton onClick={refresh} />
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
      {msg && (
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
              </div>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-[1100px] w-full text-sm">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="text-left p-2 border-b">Fecha</th>
                    <th className="text-left p-2 border-b">Vendedor</th>
                    <th className="text-right p-2 border-b">Paquetes</th>
                    <th className="text-right p-2 border-b">Restantes</th>
                    <th className="text-right p-2 border-b">Total esperado</th>
                    <th className="text-right p-2 border-b">U. Bruta</th>
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
                      <td className="p-2 border-b text-right">
                        {money(o.totalExpected)}
                      </td>
                      <td className="p-2 border-b text-right">
                        {money(o.grossProfit)}
                      </td>
                      <td className="p-2 border-b text-right">
                        {money(o.vendorProfit)}
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
                      <td className="p-3 text-sm text-gray-600" colSpan={10}>
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

            {pagedOrders.map((o) => {
              const expanded = expandedOrderKey === o.orderKey;
              return (
                <div key={o.orderKey} className="bg-white border rounded">
                  <div className="p-2 flex items-center justify-between">
                    <div>
                      <div className="text-sm font-semibold">
                        {o.sellerName}
                      </div>
                      <div className="text-xs text-gray-600">{o.date}</div>
                    </div>

                    <button
                      className="px-3 py-2 rounded border text-sm"
                      onClick={() => toggleExpand(o.orderKey)}
                    >
                      {expanded ? "−" : "+"}
                    </button>
                  </div>

                  <div className="px-2 pb-2">
                    <div className="grid grid-cols-2 gap-2 text-xs">
                      <div className="border rounded p-2">
                        <div className="text-gray-600">Paquetes</div>
                        <div className="font-semibold">{o.totalPackages}</div>
                      </div>
                      <div className="border rounded p-2">
                        <div className="text-gray-600">Restantes</div>
                        <div className="font-semibold">
                          {o.totalRemainingPackages}
                        </div>
                      </div>
                      <div className="border rounded p-2">
                        <div className="text-gray-600">Total esperado</div>
                        <div className="font-semibold">
                          {money(o.totalExpected)}
                        </div>
                      </div>
                      <div className="border rounded p-2">
                        <div className="text-gray-600">U. Vendedor</div>
                        <div className="font-semibold">
                          {money(o.vendorProfit)}
                        </div>
                      </div>
                    </div>
                  </div>

                  {expanded && (
                    <div className="p-2 border-t">
                      <div className="grid grid-cols-2 gap-2 text-xs mb-2">
                        <div className="border rounded p-2">
                          <div className="text-gray-600">U. Bruta</div>
                          <div className="font-semibold">
                            {money(o.grossProfit)}
                          </div>
                        </div>
                        <div className="border rounded p-2">
                          <div className="text-gray-600">Traslados</div>
                          <div className="font-semibold">
                            −{o.transferredOut} / +{o.transferredIn}
                          </div>
                        </div>
                      </div>

                      <div className="flex gap-2">
                        <button
                          className="flex-1 px-3 py-2 rounded bg-gray-900 text-white text-sm"
                          onClick={() => openEditOrder(o.orderKey)}
                        >
                          Ver / Editar
                        </button>

                        {isAdmin && (
                          <button
                            className="px-3 py-2 rounded bg-red-600 text-white text-sm"
                            onClick={() => {
                              if (confirm("¿Eliminar este pedido completo?")) {
                                deleteOrder(o.orderKey);
                              }
                            }}
                          >
                            🗑
                          </button>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

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
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
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
                  se calculan aquí sobre U. Aproximada según el margen del
                  vendedor.
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
                  <div className="text-xs text-gray-600">Paquetes totales</div>
                  <div className="text-lg font-semibold">
                    {kpiTotals.totalPackages}
                  </div>
                </div>
                <div className="border rounded p-2">
                  <div className="text-xs text-gray-600">Total esperado</div>
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
                <div className="border rounded p-2">
                  <div className="text-xs text-gray-600">U. Aproximada</div>
                  <div className="text-lg font-semibold">
                    {money(kpiTotals.uAproximada)}
                  </div>
                </div>
                <div className="border rounded p-2">
                  <div className="text-xs text-gray-600">U. Vendedor</div>
                  <div className="text-lg font-semibold">
                    {money(kpiTotals.uVendor)}
                  </div>
                </div>
                <div className="border rounded p-2">
                  <div className="text-xs text-gray-600">U. Inversionista</div>
                  <div className="text-lg font-semibold">
                    {money(kpiTotals.uInvestor)}
                  </div>
                </div>
              </div>

              {/* Add product row */}
              <div className="border rounded p-3 space-y-2">
                <div className="text-sm font-semibold">Agregar producto</div>

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

              {/* Items table */}
              <div className="border rounded">
                <div className="p-3 border-b flex items-center justify-between">
                  <div className="text-sm font-semibold">
                    Productos asociados ({orderItems.length})
                  </div>

                  <div className="flex gap-2">
                    <button
                      className="px-3 py-2 rounded border text-sm hover:bg-gray-50"
                      onClick={exportAssociatedItemsToCsv}
                      disabled={!orderItems.length}
                    >
                      Exportar CSV
                    </button>
                  </div>
                </div>

                <div className="overflow-x-auto">
                  <table className="min-w-[1300px] w-full text-sm">
                    <thead className="bg-gray-50">
                      <tr>
                        <th className="text-left p-2 border-b">Categoría</th>
                        <th className="text-left p-2 border-b">Producto</th>
                        <th className="text-right p-2 border-b">Paquetes</th>
                        <th className="text-right p-2 border-b">Restantes</th>
                        <th className="text-right p-2 border-b">Precio/paq</th>
                        <th className="text-right p-2 border-b">
                          Total esperado
                        </th>
                        <th className="text-right p-2 border-b">U. Bruta</th>
                        <th className="text-right p-2 border-b">U. Vendedor</th>
                        <th className="text-right p-2 border-b">
                          U. Inversionista
                        </th>
                        <th className="text-right p-2 border-b">
                          U. Aproximada
                        </th>
                        <th className="text-right p-2 border-b">Margen (%)</th>
                        <th className="text-left p-2 border-b">Acciones</th>
                      </tr>
                    </thead>
                    <tbody>
                      {pagedOrderItems.map((it) => (
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

                          <td className="p-2 border-b text-right">
                            {money(it.pricePerPackage)}
                          </td>

                          <td className="p-2 border-b text-right">
                            {money(it.totalExpected)}
                          </td>

                          <td className="p-2 border-b text-right">
                            {money(it.grossProfit)}
                          </td>

                          <td className="p-2 border-b text-right">
                            {money(it.uVendor)}
                          </td>

                          <td className="p-2 border-b text-right">
                            {money(it.uInvestor)}
                          </td>

                          <td className="p-2 border-b text-right">
                            {money(it.uAproximada)}
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
                      ))}

                      {!pagedOrderItems.length && (
                        <tr>
                          <td
                            className="p-3 text-sm text-gray-600"
                            colSpan={12}
                          >
                            No hay productos asociados.
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
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
    </div>
  );
}

