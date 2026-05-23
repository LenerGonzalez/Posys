import React, { useEffect, useMemo, useRef, useState } from "react";
import {
  addDoc,
  collection,
  deleteField,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  serverTimestamp,
  updateDoc,
  writeBatch,
  where,
} from "firebase/firestore";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import { db, auth } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import Button from "../common/Button";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Toast from "../common/Toast";
import KpiCard from "../common/KpiCard";
import useManualRefresh from "../../hooks/useManualRefresh";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerMoneyStrip,
  DrawerSectionTitle,
  DrawerDetailDlCard,
  DrawerStatGrid,
} from "../common/DrawerContentCards";
import {
  fetchBaseSummaryCandies,
  type BaseSummaryCandies,
} from "../../Services/baseSummaryCandies";
import CandiesUtilidadesPanel, {
  UTILIDADES_ATRIB_VISTAS_TEXT,
  UTILIDADES_UTIL_GLOSSARY_TEXT,
} from "./CandiesUtilidadesPanel";

interface Seller {
  id: string;
  name: string;
  commissionPercent?: number;
}

interface Customer {
  id: string;
  name: string;
}

type UnifiedRow = {
  id: string;
  date?: string;
  movement?: string;
  type?: string;
  vendorId?: string;
  vendorName?: string;
  customerId?: string;
  customerName?: string;
  saleAmount?: number;
  saleCost?: number;
  saleGrossProfit?: number;
  commission?: number;
  packages?: number;
  saleId?: string;
  description?: string;
  reference?: any;
  inAmount?: number;
  outAmount?: number;
  source?: string;
  createdAt?: any;
  createdBy?: any;
  balance?: number;
  evolutive?: number;
  commissionEvol?: number;
  corteDesde?: string | null;
  corteHasta?: string | null;
};

type SaleType = "CONTADO" | "CREDITO";
const today = () => format(new Date(), "yyyy-MM-dd");
const firstOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth(), 1), "yyyy-MM-dd");
};
const lastOfMonth = () => {
  const d = new Date();
  return format(new Date(d.getFullYear(), d.getMonth() + 1, 0), "yyyy-MM-dd");
};

const money = (n: unknown) => {
  const v = Number(n ?? 0) || 0;
  return `C$${v.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
};

type LedgerType =
  | "GASTO"
  | "REABASTECIMIENTO"
  | "RETIRO"
  | "DEPOSITO"
  | "CORTE"
  | "PERDIDA"
  | "PAGO_COMISION"
  | "PRESTAMO A NEGOCIO POR DUENO"
  | "DEVOLUCION A DUENO POR PRESTAMO";
function ensureDate(x: any): string {
  if (x?.date) return x.date;
  if (x?.createdAt?.toDate) return format(x.createdAt.toDate(), "yyyy-MM-dd");
  return "";
}

function normalizeSale(d: any, id: string): any | null {
  const date = ensureDate(d);
  if (!date) return null;

  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];

  let quantity = 0; // paquetes
  let total = 0;
  let commissionFromItems = 0;

  if (itemsArray.length > 0) {
    quantity = itemsArray.reduce((acc: number, it: any) => {
      const packsDirect = Number(
        it.packages ?? it.qtyPackages ?? it.packagesTotal ?? 0,
      );
      if (packsDirect > 0) return acc + packsDirect;

      const qtyUnits = Number(it.qty ?? it.quantity ?? 0) || 0;
      const upp = Math.max(1, Number(it.unitsPerPackage ?? 1));
      return acc + (qtyUnits > 0 ? qtyUnits / upp : 0);
    }, 0);

    total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
    if (!total) {
      total = itemsArray.reduce(
        (acc: number, it: any) =>
          acc + (Number(it.total ?? it.lineFinal ?? 0) || 0),
        0,
      );
    }

    commissionFromItems = itemsArray.reduce(
      (acc: number, it: any) => acc + (Number(it.margenVendedor || 0) || 0),
      0,
    );
  } else {
    const rootPackages = Number(
      d.packagesTotal ??
        d.packages ??
        d.item?.packages ??
        d.item?.qtyPackages ??
        d.item?.packagesTotal ??
        0,
    );
    if (rootPackages > 0) {
      quantity = rootPackages;
    } else {
      const rootQtyUnits = Number(
        d.qty ?? d.quantity ?? d.item?.qty ?? d.item?.quantity ?? 0,
      );
      const rootUPP = Math.max(
        1,
        Number(d.unitsPerPackage ?? d.item?.unitsPerPackage ?? 1),
      );
      quantity = rootQtyUnits > 0 ? rootQtyUnits / rootUPP : 0;
    }

    total = Number(d.total ?? d.item?.total ?? 0) || 0;
  }

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total: Number(total || 0),
    quantity: Number(quantity || 0),
    downPayment: Number(d.downPayment || 0) || 0,
    vendorId: d.vendorId || "",
    vendorName: d.vendorName || d.vendor || "",
    vendorCommissionAmount: Number(d.vendorCommissionAmount || 0) || 0,
    commissionFromItems: Number(commissionFromItems || 0) || 0,
  };
}

function getSaleCostAndGross(raw: any, saleTotal: number) {
  const items = Array.isArray(raw?.items)
    ? raw.items
    : raw?.item
      ? [raw.item]
      : raw
        ? [raw]
        : [];

  let costFromItems = 0;
  let utilityFromNetPerPack = 0;
  let hasUtilityFromNetPerPack = false;
  let qtyFromItems = 0;

  const saleQtyFallback =
    Number(raw?.packagesTotal ?? raw?.quantity ?? raw?.packages ?? 0) || 0;

  const linePacksFromSaleItem = (it: any): number => {
    const fromDoc = Math.max(
      0,
      Number(it?.packages ?? it?.qtyPackages ?? it?.packagesTotal ?? 0),
    );
    if (fromDoc > 0) return Math.floor(fromDoc);

    const qtyUnits = Math.max(0, Number(it?.qty ?? it?.quantity ?? 0));
    const upp = Math.max(1, Math.floor(Number(it?.unitsPerPackage ?? 1)));
    if (qtyUnits > 0) return Math.floor(qtyUnits / upp);

    return 0;
  };

  for (const it of items) {
    let qty = linePacksFromSaleItem(it);
    if (qty <= 0 && items.length === 1 && saleQtyFallback > 0) {
      qty = saleQtyFallback;
    }
    qtyFromItems += qty;

    // providerPrice llega en la venta y representa el costo por paquete real de ese item.
    const providerPrice = Number(
      it?.providerPricePerPackage ??
        it?.provider_price_per_package ??
        it?.providerPrice ??
        it?.provider_price ??
        it?.priceProvider ??
        it?.costProvider ??
        raw?.providerPricePerPackage ??
        raw?.provider_price_per_package ??
        raw?.providerPrice ??
        raw?.provider_price ??
        raw?.priceProvider ??
        raw?.costProvider ??
        0,
    );
    const cogs = Number(it?.cogsAmount ?? 0);
    const lineCost = Number(it?.lineCost ?? 0);
    const avgUnitCost = Number(it?.avgUnitCost ?? it?.unitCost ?? 0);
    const costTotal = Number(it?.costTotal ?? 0);

    if (qty > 0 && Number.isFinite(providerPrice) && providerPrice > 0) {
      costFromItems += qty * providerPrice;
    } else if (Number.isFinite(cogs) && cogs > 0) {
      costFromItems += cogs;
    } else if (Number.isFinite(lineCost) && lineCost > 0) {
      costFromItems += lineCost;
    } else if (Number.isFinite(costTotal) && costTotal > 0) {
      costFromItems += costTotal;
    } else if (qty > 0 && Number.isFinite(avgUnitCost) && avgUnitCost > 0) {
      costFromItems += qty * avgUnitCost;
    }

    // En Cierre de ventas la utilidad se toma desde uNetaPorPaquete.
    const uNetaPorPaquete = Number(
      it?.uNetaPorPaquete ?? it?.uNetaPorPack ?? NaN,
    );
    if (qty > 0 && Number.isFinite(uNetaPorPaquete)) {
      utilityFromNetPerPack += qty * uNetaPorPaquete;
      hasUtilityFromNetPerPack = true;
    }
  }

  const rawSubtotal = Number(raw?.subtotal ?? raw?.costTotal ?? 0);
  const safeCost =
    costFromItems > 0
      ? costFromItems
      : Number.isFinite(rawSubtotal) && rawSubtotal > 0
        ? rawSubtotal
        : Number(
              raw?.providerPricePerPackage ??
                raw?.provider_price_per_package ??
                raw?.providerPrice ??
                raw?.provider_price ??
                0,
            ) > 0 && saleQtyFallback > 0
          ? Number(
              raw?.providerPricePerPackage ??
                raw?.provider_price_per_package ??
                raw?.providerPrice ??
                raw?.provider_price ??
                0,
            ) * saleQtyFallback
          : 0;

  if (!hasUtilityFromNetPerPack) {
    const saleQty =
      qtyFromItems > 0
        ? qtyFromItems
        : Number(raw?.packagesTotal ?? raw?.quantity ?? raw?.packages ?? 0) ||
          0;
    const saleUNetaPorPaquete = Number(
      raw?.uNetaPorPaquete ?? raw?.uNetaPorPack ?? NaN,
    );
    if (saleQty > 0 && Number.isFinite(saleUNetaPorPaquete)) {
      utilityFromNetPerPack = saleQty * saleUNetaPorPaquete;
      hasUtilityFromNetPerPack = true;
    }
  }

  const safeGross = hasUtilityFromNetPerPack
    ? utilityFromNetPerPack
    : Number(saleTotal || 0) - Number(safeCost || 0);

  return {
    cost: Number(safeCost.toFixed(2)),
    gross: Number(safeGross.toFixed(2)),
  };
}

function getSaleTotalVendorGain(raw: any) {
  const items = Array.isArray(raw?.items)
    ? raw.items
    : raw?.item
      ? [raw.item]
      : raw
        ? [raw]
        : [];

  const linePacks = (it: any) => {
    const direct = Number(
      it?.packages ?? it?.qtyPackages ?? it?.packagesTotal ?? it?.quantity ?? 0,
    );
    if (direct > 0) return direct;
    const qtyUnits = Number(it?.qty ?? 0);
    const upp = Math.max(1, Math.floor(Number(it?.unitsPerPackage ?? 1)));
    return qtyUnits > 0 ? qtyUnits / upp : 0;
  };

  const total = items.reduce((acc: number, it: any) => {
    const direct = Number(
      it?.vendorGain ?? it?.uVendor ?? it?.margenVendedor ?? 0,
    );
    if (Number.isFinite(direct) && direct !== 0) return acc + direct;

    const perPack = Number(it?.uvXpaq ?? it?.uVendorPorPaquete ?? 0);
    const packs = linePacks(it);
    if (Number.isFinite(perPack) && perPack !== 0 && packs > 0) {
      return acc + perPack * packs;
    }

    return acc;
  }, 0);

  return Number(total.toFixed(2));
}

function getSaleTotalsByPackages(raw: any) {
  const items = Array.isArray(raw?.items)
    ? raw.items
    : raw?.item
      ? [raw.item]
      : raw
        ? [raw]
        : [];

  const linePacks = (it: any) => {
    const direct = Number(
      it?.packages ??
        it?.qtyPackages ??
        it?.packagesTotal ??
        (items.length === 1
          ? raw?.packages ?? raw?.packagesTotal ?? raw?.item?.packages ?? 0
          : 0),
    );
    return direct > 0 ? direct : 0;
  };

  let totalCost = 0;
  let totalUNeta = 0;
  let totalVendorGain = 0;

  for (const it of items) {
    const packs = linePacks(it);

    const costPerPack = Number(
      it?.providerPricePerPackage ??
        raw?.providerPricePerPackage ??
        raw?.providerPrice ??
        0,
    );
    if (packs > 0 && Number.isFinite(costPerPack) && costPerPack > 0) {
      totalCost += packs * costPerPack;
    }

    const uNetaPerPack = Number(
      it?.uNetaPorPaquete ??
        raw?.uNetaPorPaquete ??
        0,
    );
    if (packs > 0 && Number.isFinite(uNetaPerPack) && uNetaPerPack !== 0) {
      totalUNeta += packs * uNetaPerPack;
    }

    const vendorPerPack = Number(it?.uvXpaq ?? raw?.uvXpaq ?? 0);
    if (packs > 0 && Number.isFinite(vendorPerPack) && vendorPerPack !== 0) {
      totalVendorGain += packs * vendorPerPack;
    }
  }

  return {
    totalCost: Number(totalCost.toFixed(2)),
    totalUneta: Number(totalUNeta.toFixed(2)),
    totalVendorGain: Number(totalVendorGain.toFixed(2)),
  };
}

const getCommissionAmount = (
  sale: any,
  sellersById: Record<string, Seller>,
) => {
  const itemsCommission = Number(sale.commissionFromItems || 0);
  if (itemsCommission > 0) return Number(itemsCommission.toFixed(2));

  const stored = Number(sale.vendorCommissionAmount || 0);
  if (stored > 0) return Number(stored.toFixed(2));

  const vendorId = String(sale.vendorId || "");
  if (!vendorId) return 0;
  const v = sellersById[vendorId];
  if (!v || !v.commissionPercent) return 0;

  const calc =
    ((Number(sale.total) || 0) * (Number(v.commissionPercent) || 0)) / 100;
  return Number(calc.toFixed(2));
};
function pickAmountAR(x: any): number {
  // tu data real: amount viene NEGATIVO en ABONO
  const n = Number(x?.amount ?? 0);
  if (Number.isFinite(n) && n !== 0) return Math.abs(n);

  // fallbacks por si existen docs con otros campos
  const candidates = [
    x.amountPaid,
    x.paidAmount,
    x.paymentAmount,
    x.value,
    x.total,
    x.inAmount,
  ];

  for (const c of candidates) {
    const v = Number(c);
    if (Number.isFinite(v) && v !== 0) return Math.abs(v);
  }

  return 0;
}

// ✅ para NO confundir CARGO con ABONO
function getARKind(x: any): "ABONO" | "CARGO" | "OTHER" {
  const raw = String(
    x.kind ?? x.type ?? x.movement ?? x.movementType ?? x.action ?? "",
  )
    .trim()
    .toUpperCase();

  if (raw === "ABONO" || raw === "PAGO" || raw === "PAYMENT") return "ABONO";
  if (raw === "CARGO" || raw === "CHARGE") return "CARGO";
  return "OTHER";
}

type CandyCashSaleLine = {
  id: string;
  date: string;
  productName: string;
  unitPrice: number;
  packages: number;
  amount: number;
  grossProfit: number;
  commission: number;
  seller: string;
};

function aggregateCandyCashSaleLines(lines: CandyCashSaleLine[]) {
  const products = new Set<string>();
  let packages = 0;
  let amount = 0;
  let grossProfit = 0;
  let commission = 0;
  for (const line of lines) {
    products.add(line.productName);
    packages += Number(line.packages || 0);
    amount += Number(line.amount || 0);
    grossProfit += Number(line.grossProfit || 0);
    commission += Number(line.commission || 0);
  }
  return {
    productCount: products.size,
    lineCount: lines.length,
    packages: Number(packages.toFixed(2)),
    amount: Number(amount.toFixed(2)),
    grossProfit: Number(grossProfit.toFixed(2)),
    commission: Number(commission.toFixed(2)),
  };
}

export default function EstadoCuentaCandies(): React.ReactElement {
  const [from, setFrom] = useState(firstOfMonth());
  const [to, setTo] = useState(lastOfMonth());
  const [loading, setLoading] = useState(true);

  const [base, setBase] = useState<BaseSummaryCandies | null>(null);

  // vendedores (para filtro + comisión fallback)
  const [sellers, setSellers] = useState<Seller[]>([]);
  const sellersById = useMemo(() => {
    const m: Record<string, Seller> = {};
    sellers.forEach((s) => (m[s.id] = s));
    return m;
  }, [sellers]);

  // clientes (para nombre en abonos)
  const [customers, setCustomers] = useState<Customer[]>([]);
  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  // ledger manual candies
  const [ledger, setLedger] = useState<UnifiedRow[]>([]);
  // ventas y abonos
  const [salesRows, setSalesRows] = useState<UnifiedRow[]>([]);
  const [abonosRows, setAbonosRows] = useState<UnifiedRow[]>([]);

  // ===== drawer items (detalle de productos de la venta) =====
  const [itemsDrawerOpen, setItemsDrawerOpen] = useState(false);
  const [itemsDrawerLoading, setItemsDrawerLoading] = useState(false);
  const [itemsDrawerSale, setItemsDrawerSale] = useState<{
    saleId: string;
    date: string;
    vendorName: string;
    saleAmount: number;
    commission: number;
    packages: number;
    type: string;
  } | null>(null);
  const [itemsDrawerRows, setItemsDrawerRows] = useState<
    {
      productName: string;
      qty: number;
      unitPrice: number;
      discount?: number;
      total: number;
      cost: number;
      netProfit: number;
      commission?: number;
    }[]
  >([]);
  const [movimientoDrawerRow, setMovimientoDrawerRow] =
    useState<UnifiedRow | null>(null);
  const [movimientoDrawerLoading, setMovimientoDrawerLoading] = useState(false);
  const [movimientoDrawerLines, setMovimientoDrawerLines] = useState<
    CandyCashSaleLine[]
  >([]);

  const openItemsDrawer = async (saleId: string, row?: UnifiedRow) => {
    setItemsDrawerOpen(true);
    setItemsDrawerLoading(true);
    setItemsDrawerSale({
      saleId,
      date: row?.date || "",
      vendorName: row?.vendorName || "—",
      saleAmount: Number(row?.saleAmount || 0),
      commission: Number(row?.commission || 0),
      packages: Number(row?.packages || 0),
      type: row?.type || "",
    });
    setItemsDrawerRows([]);

    try {
      const docSnap = await getDoc(doc(db, "sales_candies", saleId));
      const data = docSnap.exists() ? (docSnap.data() as any) : null;
      if (!data) return;

      const arr = Array.isArray(data?.items)
        ? data.items
        : data?.item
          ? [data.item]
          : [];

      const rows = arr.map((it: any) => {
        const qtyPackagesFromDoc = Number(
          it.packages ?? it.qtyPackages ?? it.packagesTotal ?? 0,
        );
        const qtyUnits = Number(it.qty ?? it.quantity ?? 0);
        const unitsPerPackage = Math.max(
          1,
          Math.floor(Number(it.unitsPerPackage ?? 1)),
        );
        const qtyPackages =
          qtyPackagesFromDoc > 0
            ? qtyPackagesFromDoc
            : qtyUnits > 0
              ? qtyUnits / unitsPerPackage
              : 0;

        const providerPricePerPackage = Number(
          it.providerPricePerPackage ??
            it.provider_price_per_package ??
            it.providerPrice ??
            it.provider_price ??
            it.priceProvider ??
            it.costProvider ??
            0,
        );

        const costByProvider =
          qtyPackages > 0 &&
          Number.isFinite(providerPricePerPackage) &&
          providerPricePerPackage > 0
            ? qtyPackages * providerPricePerPackage
            : 0;

        const fallbackCost = Number(
          it.cogsAmount ??
            it.lineCost ??
            it.costTotal ??
            (qtyPackages > 0
              ? qtyPackages * Number(it.avgUnitCost ?? it.unitCost ?? 0)
              : 0),
        );
        const safeCost = costByProvider > 0 ? costByProvider : fallbackCost;

        const uNetaPorPaquete = Number(
          it.uNetaPorPaquete ?? it.uNetaPorPack ?? it.upaquete ?? NaN,
        );
        const netByPackage =
          qtyPackages > 0 && Number.isFinite(uNetaPorPaquete)
            ? qtyPackages * uNetaPorPaquete
            : NaN;

        const lineTotal = Number(it.total ?? it.lineFinal ?? 0);
        const safeNet =
          Number.isFinite(netByPackage) && netByPackage > 0
            ? netByPackage
            : lineTotal - Number(safeCost || 0);

        return {
          productName: String(it.productName || it.name || ""),
          qty: qtyPackages,
          unitPrice: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
          discount: Number(it.discount || 0),
          total: lineTotal,
          cost: Number(safeCost || 0),
          netProfit: Number(safeNet || 0),
          commission: Number(it.margenVendedor || 0),
        };
      });

      setItemsDrawerRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsDrawerLoading(false);
    }
  };

  useEffect(() => {
    const row = movimientoDrawerRow;
    const isCorte = String(row?.movement || "").toUpperCase() === "CORTE";
    if (!row || !isCorte) {
      setMovimientoDrawerLoading(false);
      setMovimientoDrawerLines([]);
      return;
    }

    const desde = String(row.corteDesde || "").trim().slice(0, 10);
    const hasta = String(row.corteHasta || "").trim().slice(0, 10);
    if (!desde || !hasta || desde > hasta) {
      setMovimientoDrawerLoading(false);
      setMovimientoDrawerLines([]);
      return;
    }

    let cancelled = false;
    setMovimientoDrawerLoading(true);
    (async () => {
      try {
        const qs = query(
          collection(db, "sales_candies"),
          where("date", ">=", desde),
          where("date", "<=", hasta),
        );
        const sSnap = await getDocs(qs);
        const selectedVendorId = String(row.vendorId || "").trim();
        const nextLines: CandyCashSaleLine[] = [];

        sSnap.forEach((docSnap) => {
          const raw = docSnap.data() as any;
          const sale = normalizeSale(raw, docSnap.id);
          if (!sale) return;
          if (String(sale.type || "").toUpperCase() !== "CONTADO") return;
          if (selectedVendorId && String(sale.vendorId || "") !== selectedVendorId)
            return;

          const items = Array.isArray(raw?.items)
            ? raw.items
            : raw?.item
              ? [raw.item]
              : [];
          if (items.length === 0) return;

          items.forEach((it: any, idx: number) => {
            const packsDirect = Number(
              it.packages ?? it.qtyPackages ?? it.packagesTotal ?? 0,
            );
            const qtyUnits = Number(it.qty ?? it.quantity ?? 0);
            const upp = Math.max(1, Number(it.unitsPerPackage ?? 1));
            const packages =
              packsDirect > 0 ? packsDirect : qtyUnits > 0 ? qtyUnits / upp : 0;

            const lineTotal = Number(
              it.total ??
                it.lineFinal ??
                (Number(it.unitPricePackage ?? it.unitPrice ?? 0) * packages -
                  Number(it.discount || 0)),
            );

            const providerPricePerPackage = Number(
              it.providerPricePerPackage ??
                it.provider_price_per_package ??
                it.providerPrice ??
                it.provider_price ??
                it.priceProvider ??
                it.costProvider ??
                0,
            );
            const lineCost =
              packages > 0 && providerPricePerPackage > 0
                ? packages * providerPricePerPackage
                : Number(it.cogsAmount ?? it.lineCost ?? it.costTotal ?? 0);

            const uNetaPorPaquete = Number(
              it.uNetaPorPaquete ?? it.uNetaPorPack ?? NaN,
            );
            const gross =
              Number.isFinite(uNetaPorPaquete) && packages > 0
                ? packages * uNetaPorPaquete
                : lineTotal - lineCost;

            const sellerName =
              String(sale.vendorName || "").trim() ||
              sellersById[String(sale.vendorId || "")]?.name ||
              "—";

            nextLines.push({
              id: `${docSnap.id}-${idx}`,
              date: String(sale.date || "").trim().slice(0, 10),
              productName: String(it.productName || it.name || "—"),
              unitPrice: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
              packages: Number(packages || 0),
              amount: Number(lineTotal || 0),
              grossProfit: Number(gross || 0),
              commission: Number(it.margenVendedor || 0),
              seller: sellerName,
            });
          });
        });

        if (!cancelled) {
          setMovimientoDrawerLines(nextLines);
          setMovimientoDrawerLoading(false);
        }
      } catch (e) {
        console.error("Error loading corte drawer candies:", e);
        if (!cancelled) {
          setMovimientoDrawerLines([]);
          setMovimientoDrawerLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [movimientoDrawerRow, sellersById]);

  // ===== formulario modal (agregar/editar movimiento manual) =====
  const [modalOpen, setModalOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const modalRef = useRef<HTMLDivElement | null>(null);

  const [date, setDate] = useState(today());
  const [type, setType] = useState<LedgerType>("GASTO");
  const [description, setDescription] = useState("");
  const [reference, setReference] = useState("");
  const [inAmount, setInAmount] = useState<string>("");
  const [outAmount, setOutAmount] = useState<string>("");
  const [corteDesde, setCorteDesde] = useState<string>("");
  const [corteHasta, setCorteHasta] = useState<string>("");
  const [corteVendorOptions, setCorteVendorOptions] = useState<
    { value: string; label: string }[]
  >([{ value: "ALL", label: "Todos" }]);
  const [corteModalPreview, setCorteModalPreview] = useState<{
    loading: boolean;
    ventasMonto: number;
    abonosMonto: number;
    ventasCount: number;
    abonosCount: number;
    gastosSum: number;
    totalCashOutCaja: number;
    totalCashInCaja: number;
    comisionCash: number;
    comisionCredit: number;
    comisionAbonos: number;
    comisionTotal: number;
    utilidadNeta: number;
  }>({
    loading: false,
    ventasMonto: 0,
    abonosMonto: 0,
    ventasCount: 0,
    abonosCount: 0,
    gastosSum: 0,
    totalCashOutCaja: 0,
    totalCashInCaja: 0,
    comisionCash: 0,
    comisionCredit: 0,
    comisionAbonos: 0,
    comisionTotal: 0,
    utilidadNeta: 0,
  });

  // vendor en movimiento manual (para Pago Comisión)
  const [vendorId, setVendorId] = useState<string>("");

  // kebab
  const [actionOpenId, setActionOpenId] = useState<string | null>(null);
  const actionMenuRef = useRef<HTMLDivElement | null>(null);

  // colapsables de indicadores
  const [collapsePacks, setCollapsePacks] = useState(false);
  const [collapseVentas, setCollapseVentas] = useState(false);
  const [collapseGastos, setCollapseGastos] = useState(false);
  const [collapseComisiones, setCollapseComisiones] = useState(false);
  const allCollapsed =
    collapsePacks && collapseVentas && collapseGastos && collapseComisiones;
  const toggleAllKpis = () => {
    const next = !allCollapsed;
    setCollapsePacks(next);
    setCollapseVentas(next);
    setCollapseGastos(next);
    setCollapseComisiones(next);
  };

  // filtros de tabla
  const [movementTypeFilter, setMovementTypeFilter] = useState<string>("ALL");
  const [vendorFilter, setVendorFilter] = useState<string>("ALL");
  const [toastMsg, setToastMsg] = useState("");
  const [backfillModalOpen, setBackfillModalOpen] = useState(false);
  const [backfillRunning, setBackfillRunning] = useState(false);

  // ABONO modal
  const [abonoModalOpen, setAbonoModalOpen] = useState(false);
  const [abonoLoading, setAbonoLoading] = useState(false);
  const [abonoCustomer, setAbonoCustomer] = useState<any | null>(null);
  const [abonoKpis, setAbonoKpis] = useState({
    saldoActual: 0,
    totalAbonado: 0,
    lastAbonoDate: "",
    lastAbonoAmount: 0,
  });

  // modal para ver detalle de comisiones por vendedor
  const [comisionesModalOpen, setComisionesModalOpen] = useState(false);

  const getEffectiveInitialDebt = (
    initialDebtValue: number,
    initialDebtDate: string,
    movements: { date?: string; amount?: number; ref?: any }[],
  ) => {
    const init = Number(initialDebtValue || 0);
    if (!init) return 0;

    const initDate = String(initialDebtDate || "").trim();
    if (!initDate) return init;

    const hasDup = movements.some((m) => {
      const amt = Number(m.amount || 0);
      if (!(amt > 0)) return false;
      const sameAmount = Math.abs(amt - init) < 0.01;
      const sameDate = String(m.date || "").trim() === initDate;
      const hasSale = Boolean(m.ref?.saleId);
      return sameAmount && sameDate && hasSale;
    });

    return hasDup ? 0 : init;
  };

  const openAbonoModal = async (customerId: string) => {
    if (!customerId) return;
    setAbonoModalOpen(true);
    setAbonoLoading(true);
    setAbonoCustomer(null);
    setAbonoKpis({
      saldoActual: 0,
      totalAbonado: 0,
      lastAbonoDate: "",
      lastAbonoAmount: 0,
    });

    try {
      const custSnap = await getDoc(doc(db, "customers_candies", customerId));
      const custData = custSnap.exists() ? (custSnap.data() as any) : null;
      setAbonoCustomer(
        custData ? { id: customerId, ...custData } : { id: customerId },
      );

      // load ar_movements for this customer
      const q = query(
        collection(db, "ar_movements"),
        where("customerId", "==", customerId),
      );
      const snap = await getDocs(q);
      const moves: {
        date?: string;
        amount?: number;
        createdAt?: any;
        ref?: any;
      }[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        moves.push({
          date: x.date,
          amount: Number(x.amount || 0),
          createdAt: x.createdAt,
          ref: x.ref || {},
        });
      });

      // filter by date <= to
      const limitTo = String(to || "");
      const movesUpTo = moves.filter((m) => {
        if (!m.date) return true;
        return String(m.date) <= limitTo;
      });

      const sumMov = movesUpTo.reduce((a, b) => a + Number(b.amount || 0), 0);

      const totalAbonado = movesUpTo
        .filter((m) => Number(m.amount || 0) < 0)
        .reduce((a, b) => a + Math.abs(Number(b.amount || 0)), 0);

      // last abono (by createdAt timestamp)
      let lastAbonoDate = "";
      let lastAbonoAmount = 0;
      let lastTs = 0;
      for (const m of movesUpTo) {
        const amt = Number(m.amount || 0);
        if (amt < 0) {
          const ts = m.createdAt?.seconds ? Number(m.createdAt.seconds) : 0;
          if (ts > lastTs) {
            lastTs = ts;
            lastAbonoDate = m.date || "";
            lastAbonoAmount = Math.abs(amt);
          }
        }
      }

      const init = Number(custData?.initialDebt || 0);
      const initDate = String(custData?.initialDebtDate || "");
      const effectiveInit = getEffectiveInitialDebt(
        init,
        initDate,
        movesUpTo as any,
      );
      const saldoActual = Number(effectiveInit || 0) + sumMov;

      setAbonoKpis({
        saldoActual,
        totalAbonado,
        lastAbonoDate,
        lastAbonoAmount,
      });
    } catch (e) {
      console.error("Error loading abono details:", e);
    } finally {
      setAbonoLoading(false);
    }
  };

  const round2 = (n: unknown) => Number((Number(n || 0) || 0).toFixed(2));

  const runSalesTotalsBackfill = async () => {
    setBackfillRunning(true);
    try {
      const snap = await getDocs(
        query(collection(db, "sales_candies"), orderBy("__name__")),
      );

      let processed = 0;
      let updated = 0;
      let zeroTotals = 0;
      let batch = writeBatch(db);
      let pendingWrites = 0;

      for (const d of snap.docs) {
        processed += 1;
        const raw = d.data() as any;

        const totals = getSaleTotalsByPackages(raw);

        const nextCost = round2(totals.totalCost);
        const nextUNeta = round2(totals.totalUneta);
        const nextVendor = round2(totals.totalVendorGain);

        if (nextCost === 0 && nextUNeta === 0 && nextVendor === 0) {
          zeroTotals += 1;
        }

        batch.update(d.ref, {
          totalCost: nextCost,
          totalUneta: nextUNeta,
          totalVendorGain: nextVendor,
          totalsBackfillAt: serverTimestamp(),
          totalsBackfillMode: "strict_packages_x_fields",
          updatedAt: serverTimestamp(),
        });
        pendingWrites += 1;
        updated += 1;

        if (pendingWrites >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          pendingWrites = 0;
        }
      }

      if (pendingWrites > 0) {
        await batch.commit();
      }

      setToastMsg(
        `✅ Backfill completado. Procesadas: ${processed}. Actualizadas: ${updated}. En cero: ${zeroTotals}.`,
      );
      setBackfillModalOpen(false);
      refresh();
    } catch (e) {
      console.error("Error backfill sales totals:", e);
      setToastMsg("❌ Error ejecutando backfill de totales en ventas.");
    } finally {
      setBackfillRunning(false);
    }
  };

  const [typeFilter, setTypeFilter] = useState<"ALL" | "Cash" | "Crédito">(
    "ALL",
  ); // ✅ nuevo

  const { refreshKey, refresh } = useManualRefresh();
  const [candiesAccountView, setCandiesAccountView] = useState<
    "estado" | "utilidades"
  >("estado");
  const [utilidadesGlossaryOpen, setUtilidadesGlossaryOpen] = useState(false);
  const [tipoFiltroInfoOpen, setTipoFiltroInfoOpen] = useState(false);

  // 0) cargar sellers + customers
  useEffect(() => {
    (async () => {
      try {
        const [vSnap, cSnap] = await Promise.all([
          getDocs(collection(db, "sellers_candies")),
          getDocs(collection(db, "customers_candies")),
        ]);

        const vList: Seller[] = vSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            name: data.name || "",
            commissionPercent: Number(data.commissionPercent || 0) || 0,
          };
        });
        setSellers(vList);

        const cList: Customer[] = cSnap.docs.map((d) => {
          const data = d.data() as any;
          return { id: d.id, name: data.name || "" };
        });
        setCustomers(cList);
      } catch (e) {
        console.error("Error loading sellers/customers:", e);
        setSellers([]);
        setCustomers([]);
      }
    })();
  }, []);

  // 1) KPIs base
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        const summary = await fetchBaseSummaryCandies(from, to);
        setBase(summary);
      } catch (e) {
        console.error("Error base summary candies:", e);
        setBase(null);
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, refreshKey]);

  // 2) ledger manual (cash_ledger_candies) + gastos (expenses_candies)
  useEffect(() => {
    (async () => {
      try {
        const qLed = query(
          collection(db, "cash_ledger_candies"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qLed);

        const ledgerRows: UnifiedRow[] = snap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: d.id,
            date: x.date || today(),
            movement: String(x.type || ""),
            type: "",
            vendorId: x.vendorId || "",
            vendorName: x.vendorName || "",
            description: x.description || "",
            reference: x.reference || null,
            inAmount: Number(x.inAmount || 0) || 0,
            outAmount: Number(x.outAmount || 0) || 0,
            corteDesde: x.corteDesde ?? null,
            corteHasta: x.corteHasta ?? null,
            createdAt: x.createdAt ?? null,
            createdBy: x.createdBy ?? null,
            source: "ledger",
          };
        });

        const qExp = query(
          collection(db, "expenses_candies"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const expSnap = await getDocs(qExp);
        const expenseRows: UnifiedRow[] = expSnap.docs.map((d) => {
          const x = d.data() as any;
          return {
            id: `exp_${d.id}`,
            date: x.date || today(),
            movement: "GASTO",
            type: "",
            description: x.description || "Gasto",
            reference: x.category || x.reference || null,
            inAmount: 0,
            outAmount: Number(x.amount || 0) || 0,
            createdAt: x.createdAt ?? null,
            createdBy: x.createdBy ?? null,
            source: "expenses",
          };
        });

        setLedger(
          [...ledgerRows, ...expenseRows].sort((a, b) =>
            (a.date || "").localeCompare(b.date || ""),
          ),
        );
      } catch (e) {
        console.error("Error ledger candies:", e);
        setLedger([]);
      }
    })();
  }, [from, to, refreshKey]);

  // 3) ventas (sales_candies) en rango
  useEffect(() => {
    (async () => {
      try {
        const sSnap = await getDocs(
          query(collection(db, "sales_candies"), orderBy("createdAt", "desc")),
        );
        const list: UnifiedRow[] = [];

        sSnap.forEach((d) => {
          const raw = d.data();
          const sale = normalizeSale(raw, d.id);
          if (!sale) return;
          if (sale.date < from || sale.date > to) return;

          const saleFinancials = getSaleCostAndGross(
            raw,
            Number(sale.total || 0),
          );

          const commission = getCommissionAmount(sale, sellersById);
          const isCash = sale.type === "CONTADO";
          const uiType = isCash ? "Cash" : "Crédito";

          // Entrada real (caja):
          // - Cash: total
          // - Crédito: solo downPayment si existe (si no, 0)
          const entradaReal = isCash
            ? sale.total
            : Number(sale.downPayment || 0);

          list.push({
            id: `sale_${sale.id}`,
            date: sale.date,
            movement: "Venta",
            type: uiType,
            vendorId: sale.vendorId || "",
            vendorName:
              sale.vendorName ||
              (sale.vendorId ? sellersById[sale.vendorId]?.name : "") ||
              "",
            saleAmount: sale.total,
            saleCost: saleFinancials.cost,
            saleGrossProfit: saleFinancials.gross,
            commission,
            packages: sale.quantity,
            saleId: sale.id,
            description: "Venta",
            reference: sale.id,
            inAmount: Number(entradaReal || 0),
            outAmount: 0,
            source: "sales",
          });
        });

        setSalesRows(
          list.sort((a, b) => (a.date || "").localeCompare(b.date || "")),
        );
      } catch (e) {
        console.error("Error sales rows:", e);
        setSalesRows([]);
      }
    })();
  }, [from, to, refreshKey, sellersById]);

  // 4) abonos (ar_movements) en rango -> SOLO ABONOS (NO CARGOS)
  useEffect(() => {
    (async () => {
      try {
        const qAr = query(
          collection(db, "ar_movements"),
          where("date", ">=", from),
          where("date", "<=", to),
          orderBy("date", "asc"),
        );
        const snap = await getDocs(qAr);

        const list: UnifiedRow[] = snap.docs
          .map((d) => {
            const x = d.data() as any;

            const kind = getARKind(x);
            if (kind !== "ABONO") return null; // ✅ ignora CARGO

            const amt = pickAmountAR(x);

            const ref =
              x?.ref?.saleId || x?.ref?.id || x?.reference || x?.saleId || null;

            const custId = String(x.customerId || "").trim();
            const custName = custId ? customersById[custId] || "" : "";

            return {
              id: `ar_${d.id}`,
              date: x.date || today(),
              movement: "Abono",
              type: "Crédito",
              // customerId may be in x.customerId
              vendorId: x.vendorId || x.customerId || "",
              vendorName: x.vendorName || "",
              customerId: custId || undefined,
              customerName: custName || undefined,
              description: "Abono",
              reference: ref,
              inAmount: Number(amt || 0),
              outAmount: 0,
              source: "ar",
            };
          })
          .filter(Boolean) as UnifiedRow[];

        setAbonosRows(
          list.sort((a, b) => (a.date || "").localeCompare(b.date || "")),
        );
      } catch (e) {
        console.error("Error ar rows:", e);
        setAbonosRows([]);
      }
    })();
  }, [from, to, refreshKey, customersById]);

  // ===== saldo base y saldo final =====
  const saldoBase = base?.saldoBase ?? 0;

  const mergedRows = useMemo(() => {
    return [...salesRows, ...abonosRows, ...ledger].sort((a, b) =>
      (a.date || "").localeCompare(b.date || ""),
    );
  }, [salesRows, abonosRows, ledger]);

  const rowsWithBalance = useMemo(() => {
    let bal = Number(saldoBase || 0);
    let evol = 0; // acumulado de ventas mostrado en la tabla
    let cumCom = 0; // acumulado de comisiones mostrado en la tabla
    return mergedRows.map((r) => {
      // sumar al evolutivo solo los montos de venta (saleAmount)
      evol = evol + Number(r.saleAmount || 0);

      // acumulador de comisiones (solo suma si existe comision en la fila)
      cumCom = cumCom + Number(r.commission || 0);

      // saldoBase ya incluye ventas (cash + downPayments) y abonosPeriodo,
      // por eso NO debemos volver a sumar inAmount/outAmount de filas
      // cuya fuente sea 'sales' o 'ar' — solo aplicamos cambios del ledger manual.
      const isPrecounted = r.source === "sales" || r.source === "ar";
      const delta = isPrecounted
        ? 0
        : Number(r.inAmount || 0) - Number(r.outAmount || 0);
      bal = bal + delta;
      return {
        ...r,
        balance: bal,
        evolutive: evol,
        commissionEvol: cumCom,
      } as any;
    });
  }, [mergedRows, saldoBase]);

  const saldoFinal = rowsWithBalance.length
    ? Number(rowsWithBalance[rowsWithBalance.length - 1].balance || 0)
    : saldoBase;

  // ===== KPIs del ledger manual (como pollo) =====
  const totalsLedger = useMemo(() => {
    const inSum = ledger.reduce((a, r) => a + Number(r.inAmount || 0), 0);

    const gastosSum = ledger.reduce(
      (a, r) => (r.movement === "GASTO" ? a + Number(r.outAmount || 0) : a),
      0,
    );

    const outSumNonGastos = ledger.reduce((a, r) => {
      return r.movement === "GASTO" ||
        r.movement === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a
        : a + Number(r.outAmount || 0);
    }, 0);

    const abonoDueno = ledger.reduce((a, r) => {
      return r.movement === "DEVOLUCION A DUENO POR PRESTAMO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const reabastecimientoSum = ledger.reduce((a, r) => {
      return r.movement === "REABASTECIMIENTO"
        ? a + Number(r.outAmount || 0)
        : a;
    }, 0);

    const depositSum = ledger.reduce((a, r) => {
      return r.movement === "DEPOSITO" ? a + Number(r.outAmount || 0) : a;
    }, 0);

    return {
      inSum,
      gastosSum,
      outSumNonGastos,
      abonoDueno,
      reabastecimientoSum,
      depositSum,
    };
  }, [ledger]);

  const deudaDueno = useMemo(() => {
    const prestado = ledger.reduce((a, r) => {
      if (r.movement !== "PRESTAMO A NEGOCIO POR DUENO") return a;
      return a + Number(r.inAmount || 0) - Number(r.outAmount || 0);
    }, 0);

    const devuelto = ledger.reduce((a, r) => {
      if (r.movement !== "DEVOLUCION A DUENO POR PRESTAMO") return a;
      return a + Number(r.outAmount || 0) - Number(r.inAmount || 0);
    }, 0);

    return Math.max(0, Number(prestado || 0) - Number(devuelto || 0));
  }, [ledger]);

  const salesCostPeriodo = useMemo(
    () => salesRows.reduce((a, r) => a + Number(r.saleCost || 0), 0),
    [salesRows],
  );

  const valorVentasCashPeriodo = useMemo(
    () =>
      salesRows.reduce(
        (a, r) => (r.type === "Cash" ? a + Number(r.saleAmount || 0) : a),
        0,
      ),
    [salesRows],
  );

  const utilidadBrutaPeriodo = useMemo(
    () => salesRows.reduce((a, r) => a + Number(r.saleGrossProfit || 0), 0),
    [salesRows],
  );

  // ===== filtros (Movimiento + Vendedor + Tipo Cash/Crédito) =====
  const movementTypes = useMemo(() => {
    const s = new Set<string>();
    s.add("ALL");
    for (const r of rowsWithBalance) s.add(String(r.movement || ""));
    return Array.from(s);
  }, [rowsWithBalance]);

  const movementTypeFilterSelectOptions = useMemo(
    () =>
      movementTypes.map((t) => ({
        value: t,
        label: t === "ALL" ? "Todos" : t,
      })),
    [movementTypes],
  );

  const vendorFilterSelectOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      ...sellers.map((v) => ({ value: v.id, label: v.name })),
    ],
    [sellers],
  );

  const saleTypeFilterOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      { value: "Cash", label: "Cash" },
      { value: "Crédito", label: "Crédito" },
    ],
    [],
  );

  const modalLedgerTypeOptions = useMemo(
    () => [
      { value: "GASTO", label: "Gasto" },
      { value: "REABASTECIMIENTO", label: "Reabastecimiento" },
      { value: "RETIRO", label: "Retiro" },
      { value: "DEPOSITO", label: "Deposito (salida)" },
      { value: "CORTE", label: "Corte de caja (retiro total/parcial)" },
      { value: "PERDIDA", label: "Perdida por robo" },
      { value: "PAGO_COMISION", label: "Pago Comisión" },
      {
        value: "PRESTAMO A NEGOCIO POR DUENO",
        label: "Préstamo a negocio por dueño",
      },
      {
        value: "DEVOLUCION A DUENO POR PRESTAMO",
        label: "Devolución a dueño por préstamo",
      },
    ],
    [],
  );

  const vendorModalSelectOptions = useMemo(() => {
    const placeholder =
      type === "PAGO_COMISION" || type === "DEPOSITO" ? "Seleccionar..." : "—";
    return [
      { value: "", label: placeholder },
      ...sellers.map((v) => ({ value: v.id, label: v.name })),
    ];
  }, [type, sellers]);

  const corteVendorSelectOptions = useMemo(
    () =>
      corteVendorOptions.length > 0
        ? corteVendorOptions
        : [{ value: "ALL", label: "Todos" }],
    [corteVendorOptions],
  );

  const filteredRows = useMemo(() => {
    let rows = rowsWithBalance;

    if (movementTypeFilter && movementTypeFilter !== "ALL") {
      rows = rows.filter(
        (r) => String(r.movement || "") === movementTypeFilter,
      );
    }

    if (vendorFilter && vendorFilter !== "ALL") {
      rows = rows.filter((r) => String(r.vendorId || "") === vendorFilter);
    }

    if (typeFilter !== "ALL") {
      rows = rows.filter((r) => String(r.type || "") === typeFilter);
    }

    return rows;
  }, [rowsWithBalance, movementTypeFilter, vendorFilter, typeFilter]);

  // ===== export excel (tabla) =====
  const downloadExcelFile = (
    filename: string,
    rows: (string | number)[][],
    sheetName = "Hoja1",
  ) => {
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    XLSX.utils.book_append_sheet(wb, ws, sheetName);
    XLSX.writeFile(wb, filename);
  };

  const exportToExcel = () => {
    const rows: (string | number)[][] = [];
    rows.push([
      "Fecha",
      "Movimiento",
      "Tipo",
      "Vendedor",
      "Cliente",
      "Venta",
      "Paquetes",
      "Comision",
      "Evolutivo",
      "Entrada",
      "Salida",
      "Evolutivo",
      "Saldo",
      "Descripcion",
      "Referencia",
      "Fuente",
    ]);

    (filteredRows || []).forEach((r) => {
      rows.push([
        r.date || "",
        r.movement || "",
        r.type || "",
        r.vendorName || "",
        r.customerName || r.customerId || "",
        Number(r.saleAmount || 0),
        Number(r.packages || 0),
        Number(r.commission || 0),
        Number((r as any).commissionEvol || 0),
        Number(r.inAmount || 0),
        Number(r.outAmount || 0),
        Number((r as any).evolutive || 0),
        Number(r.balance || 0),
        r.description || "",
        r.reference || "",
        r.source || "",
      ]);
    });

    const name = `estado_cuenta_candies_${from}_${to}.xlsx`;
    downloadExcelFile(name, rows, "EstadoCuenta");
  };

  // ===== modal save (solo cash_ledger_candies) =====
  const affectsOwnerDebt = (t: LedgerType) =>
    t === "PRESTAMO A NEGOCIO POR DUENO" ||
    t === "DEVOLUCION A DUENO POR PRESTAMO";

  const saveMovement = async () => {
    const inVal = Number(inAmount || 0);
    const outVal = Number(outAmount || 0);

    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
      "PAGO_COMISION",
    ];
    const onlyInTypes: LedgerType[] = ["PRESTAMO A NEGOCIO POR DUENO"];
    const isOnlyOut = onlyOutTypes.includes(type);
    const isOnlyIn = onlyInTypes.includes(type);

    if (!date) {
      setToastMsg("⚠️ Poné una fecha.");
      return;
    }
    if (!description.trim()) {
      setToastMsg("⚠️ Poné una descripción.");
      return;
    }

    if (type === "PAGO_COMISION") {
      if (!vendorId) {
        setToastMsg("⚠️ Seleccioná un vendedor para Pago Comisión.");
        return;
      }
    }

    const corteDTrim = corteDesde.trim().slice(0, 10);
    const corteHTrim = corteHasta.trim().slice(0, 10);
    if (type === "CORTE") {
      if (!corteDTrim || !corteHTrim) {
        setToastMsg("⚠️ Poné Desde y Hasta para el corte de caja.");
        return;
      }
      if (corteDTrim > corteHTrim) {
        setToastMsg("⚠️ La fecha Desde no puede ser posterior a Hasta.");
        return;
      }
    }

    if (isOnlyIn) {
      if (inVal <= 0) {
        setToastMsg("⚠️ Poné una entrada para este tipo.");
        return;
      }
    } else if (isOnlyOut) {
      if (outVal <= 0) {
        setToastMsg("⚠️ Poné una salida para este tipo.");
        return;
      }
    } else {
      if (inVal <= 0 && outVal <= 0) {
        setToastMsg("⚠️ Poné una entrada o una salida.");
        return;
      }
      if (inVal > 0 && outVal > 0) {
        setToastMsg("⚠️ Usá solo entrada o salida, no ambos.");
        return;
      }
    }

    const user = auth.currentUser;
    const vName = vendorId ? sellersById[vendorId]?.name || "" : "";

    const payload = {
      date,
      type,
      description: description.trim(),
      reference: reference.trim() || null,
      inAmount: inVal > 0 ? inVal : 0,
      outAmount: outVal > 0 ? outVal : 0,
      vendorId: type === "CORTE" || vendorId === "ALL" ? null : vendorId || null,
      vendorName:
        type === "CORTE" || vendorId === "ALL" ? null : vendorId ? vName : null,
      createdAt: serverTimestamp(),
      createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
      periodFrom: from,
      periodTo: to,
    } as any;

    if (type === "CORTE") {
      payload.corteDesde = corteDTrim;
      payload.corteHasta = corteHTrim;
    }

    try {
      if (editingId) {
        if (type !== "CORTE") {
          payload.corteDesde = deleteField();
          payload.corteHasta = deleteField();
        }
        // ✅ solo edita lo manual (cash_ledger_candies)
        await updateDoc(doc(db, "cash_ledger_candies", editingId), payload);
        setToastMsg("✅ Movimiento actualizado.");
      } else {
        await addDoc(collection(db, "cash_ledger_candies"), payload);
        setToastMsg("✅ Movimiento guardado.");
      }
    } catch (e) {
      console.error(e);
      setToastMsg("❌ No se pudo guardar el movimiento. Revisa la consola.");
      return;
    }

    setDescription("");
    setReference("");
    setInAmount("");
    setOutAmount("");
    setVendorId("");
    setCorteDesde("");
    setCorteHasta("");

    refresh();
    setModalOpen(false);
    setEditingId(null);
  };

  // limpiar inputs deshabilitados cuando cambia tipo
  useEffect(() => {
    const onlyOutTypes: LedgerType[] = [
      "GASTO",
      "REABASTECIMIENTO",
      "RETIRO",
      "DEPOSITO",
      "CORTE",
      "PERDIDA",
      "DEVOLUCION A DUENO POR PRESTAMO",
      "PAGO_COMISION",
    ];
    const onlyInTypes: LedgerType[] = ["PRESTAMO A NEGOCIO POR DUENO"];

    if (onlyOutTypes.includes(type)) setInAmount("");
    if (onlyInTypes.includes(type)) setOutAmount("");

    if (type !== "PAGO_COMISION" && type !== "DEPOSITO" && type !== "CORTE") {
      setVendorId("");
    }

    if (type !== "CORTE" && vendorId === "ALL") {
      setVendorId("");
    }
  }, [type, vendorId]);

  useEffect(() => {
    if (type !== "CORTE") {
      setCorteDesde("");
      setCorteHasta("");
      setCorteVendorOptions([{ value: "ALL", label: "Todos" }]);
      setCorteModalPreview({
        loading: false,
        ventasMonto: 0,
        abonosMonto: 0,
        ventasCount: 0,
        abonosCount: 0,
        gastosSum: 0,
        totalCashOutCaja: 0,
        totalCashInCaja: 0,
        comisionCash: 0,
        comisionCredit: 0,
        comisionAbonos: 0,
        comisionTotal: 0,
        utilidadNeta: 0,
      });
    }
  }, [type]);

  useEffect(() => {
    if (type !== "CORTE") return;
    const d = String(date || "").trim().slice(0, 10);
    if (!d) return;
    setCorteDesde((prev) => prev || d);
    setCorteHasta((prev) => prev || d);
    setVendorId((prev) => prev || "ALL");
  }, [type, date]);

  useEffect(() => {
    if (!modalOpen || type !== "CORTE") return;
    const d0 = corteDesde.trim().slice(0, 10);
    const d1 = corteHasta.trim().slice(0, 10);
    if (!d0 || !d1 || d0 > d1) {
      setCorteModalPreview({
        loading: false,
        ventasMonto: 0,
        abonosMonto: 0,
        ventasCount: 0,
        abonosCount: 0,
        gastosSum: 0,
        totalCashOutCaja: 0,
        totalCashInCaja: 0,
        comisionCash: 0,
        comisionCredit: 0,
        comisionAbonos: 0,
        comisionTotal: 0,
        utilidadNeta: 0,
      });
      return;
    }

    let cancelled = false;
    setCorteModalPreview((p) => ({ ...p, loading: true }));
    (async () => {
      try {
        const qs = query(
          collection(db, "sales_candies"),
          where("date", ">=", d0),
          where("date", "<=", d1),
        );
        const sSnap = await getDocs(qs);
        let ventasMonto = 0;
        let ventasCount = 0;
        let utilidadNeta = 0;
        let comisionCash = 0;
        let comisionCredit = 0;
        const vendorMap = new Map<string, string>();

        sSnap.forEach((docSnap) => {
          const x = docSnap.data() as any;
          const sale = normalizeSale(x, docSnap.id);
          if (!sale) return;

          const vId = String(sale.vendorId || "").trim();
          const vName = String(sale.vendorName || "").trim();
          if (vId) vendorMap.set(vId, vName || sellersById[vId]?.name || vId);

          const selectedVendor = String(vendorId || "ALL");
          if (selectedVendor !== "ALL" && vId !== selectedVendor) return;

          const com = getCommissionAmount(sale, sellersById);
          if (String(sale.type || "").toUpperCase() === "CONTADO") {
            comisionCash += Number(com || 0);
          } else {
            comisionCredit += Number(com || 0);
          }

          const fin = getSaleCostAndGross(x, Number(sale.total || 0));
          utilidadNeta += Number(fin.gross || 0);

          if (String(sale.type || "").toUpperCase() !== "CONTADO") return;
          ventasCount += 1;
          ventasMonto += Number(sale.total || 0);
        });
        ventasMonto = round2(ventasMonto);
        utilidadNeta = round2(utilidadNeta);
        comisionCash = round2(comisionCash);
        comisionCredit = round2(comisionCredit);

        const nextVendorOptions = [
          { value: "ALL", label: "Todos" },
          ...Array.from(vendorMap.entries())
            .sort((a, b) => a[1].localeCompare(b[1]))
            .map(([id, name]) => ({ value: id, label: name })),
        ];
        if (!cancelled) {
          setCorteVendorOptions(nextVendorOptions);
          const selectedVendor = String(vendorId || "ALL");
          if (
            selectedVendor !== "ALL" &&
            !nextVendorOptions.some((o) => o.value === selectedVendor)
          ) {
            setVendorId("ALL");
          }
        }

        const qar = query(
          collection(db, "ar_movements"),
          where("date", ">=", d0),
          where("date", "<=", d1),
        );
        const arSnap = await getDocs(qar);
        let abonosMonto = 0;
        let abonosCount = 0;
        let comisionAbonos = 0;
        arSnap.forEach((docSnap) => {
          const m = docSnap.data() as any;
          if (getARKind(m) !== "ABONO") return;

          const selectedVendor = String(vendorId || "ALL");
          const rowVendor = String(m.vendorId || m.sellerId || "");
          if (selectedVendor !== "ALL" && selectedVendor !== rowVendor) return;

          abonosCount += 1;
          abonosMonto += pickAmountAR(m);
          comisionAbonos += Number(m.commissionOnPayment || 0);
        });
        abonosMonto = round2(abonosMonto);
        comisionAbonos = round2(comisionAbonos);

        const qLed = query(
          collection(db, "cash_ledger_candies"),
          where("date", ">=", d0),
          where("date", "<=", d1),
        );
        const qExp = query(
          collection(db, "expenses_candies"),
          where("date", ">=", d0),
          where("date", "<=", d1),
        );
        const [ledSnap, expSnap] = await Promise.all([
          getDocs(qLed),
          getDocs(qExp),
        ]);

        const ledgerRows = ledSnap.docs.map((docSnap) => {
          const x = docSnap.data() as any;
          return {
            movement: String(x.type || ""),
            inAmount: Number(x.inAmount || 0),
            outAmount: Number(x.outAmount || 0),
          };
        });

        const expRows = expSnap.docs.map((docSnap) => {
          const x = docSnap.data() as any;
          return {
            movement: "GASTO",
            inAmount: 0,
            outAmount: Number(x.amount || 0),
          };
        });

        const merged = [...ledgerRows, ...expRows];
        let gastosSum = 0;
        let totalCashOutCaja = 0;
        let totalCashInCaja = 0;
        for (const r of merged) {
          totalCashOutCaja += Number(r.outAmount || 0);
          totalCashInCaja += Number(r.inAmount || 0);
          if (r.movement === "GASTO") gastosSum += Number(r.outAmount || 0);
        }

        const comisionTotal = round2(comisionCash + comisionAbonos);
        totalCashOutCaja = round2(totalCashOutCaja + comisionTotal);

        if (!cancelled) {
          setCorteModalPreview({
            loading: false,
            ventasMonto: round2(ventasMonto),
            abonosMonto: round2(abonosMonto),
            ventasCount,
            abonosCount,
            gastosSum: round2(gastosSum),
            totalCashOutCaja: round2(totalCashOutCaja),
            totalCashInCaja: round2(totalCashInCaja),
            comisionCash,
            comisionCredit,
            comisionAbonos,
            comisionTotal,
            utilidadNeta,
          });
        }
      } catch (e) {
        console.error("Corte modal KPI preview candies:", e);
        if (!cancelled) {
          setCorteModalPreview({
            loading: false,
            ventasMonto: 0,
            abonosMonto: 0,
            ventasCount: 0,
            abonosCount: 0,
            gastosSum: 0,
            totalCashOutCaja: 0,
            totalCashInCaja: 0,
            comisionCash: 0,
            comisionCredit: 0,
            comisionAbonos: 0,
            comisionTotal: 0,
            utilidadNeta: 0,
          });
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [modalOpen, type, corteDesde, corteHasta, vendorId, sellersById]);

  // close modal/menu on outside click or Escape
  useEffect(() => {
    const onDocMouseDown = (ev: MouseEvent) => {
      const target = ev.target as Node;
      if (modalOpen) {
        if (modalRef.current && !modalRef.current.contains(target)) {
          setModalOpen(false);
          setEditingId(null);
        }
      }
      if (actionOpenId) {
        if (actionMenuRef.current && !actionMenuRef.current.contains(target)) {
          setActionOpenId(null);
        }
      }
    };

    const onKey = (ev: KeyboardEvent) => {
      if (ev.key === "Escape") {
        setActionOpenId(null);
        setModalOpen(false);
        setEditingId(null);
      }
    };

    document.addEventListener("mousedown", onDocMouseDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocMouseDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [modalOpen, actionOpenId]);

  // ===== cards comisiones =====
  const totalComisionCash = base?.comisionCash ?? 0;
  const totalComisionCredit = base?.comisionCredit ?? 0;
  const totalComisionParcialAbonos = base?.comisionParcialAbonos ?? 0;
  const totalComisionCashYParcial =
    Number(totalComisionCash || 0) + Number(totalComisionParcialAbonos || 0);
  const saldoPostComision =
    Number(saldoFinal || 0) - Number(totalComisionCash || 0);
  const listComCash = base?.comisionesCashBySeller ?? [];
  const listComCredit = base?.comisionesCreditBySeller ?? [];

  const itemsDrawerTotals = useMemo(() => {
    const totals = itemsDrawerRows.reduce(
      (acc, it) => {
        acc.cost += Number(it.cost || 0);
        acc.net += Number(it.netProfit || 0);
        acc.commission += Number(it.commission || 0);
        return acc;
      },
      { cost: 0, net: 0, commission: 0 },
    );

    const commissionFallback = Number(itemsDrawerSale?.commission || 0);

    return {
      cost: Number(totals.cost.toFixed(2)),
      net: Number(totals.net.toFixed(2)),
      commission: Number(
        (totals.commission > 0
          ? totals.commission
          : commissionFallback
        ).toFixed(2),
      ),
    };
  }, [itemsDrawerRows, itemsDrawerSale]);

  const movimientoDrawerKpis = useMemo(
    () => aggregateCandyCashSaleLines(movimientoDrawerLines),
    [movimientoDrawerLines],
  );

  const renderMovementChip = (r: UnifiedRow) => {
    const isLedger = r.source === "ledger";
    const onClick = () => isLedger && setMovimientoDrawerRow(r);

    const baseClass =
      "text-[11px] px-2 py-[2px] rounded-full border font-medium";
    const actionClass = isLedger
      ? " cursor-pointer hover:opacity-90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-300"
      : "";

    if (r.movement === "Venta") {
      return (
        <span className={`${baseClass} bg-blue-100 text-blue-800 border-blue-200`}>
          VENTA
        </span>
      );
    }

    if (r.movement === "Abono") {
      if (r.customerId) {
        return (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-[11px] !px-2 !py-[2px] !rounded-full !font-normal bg-emerald-100 text-emerald-800 border border-emerald-200 hover:bg-emerald-200/80"
            onClick={() => openAbonoModal(String(r.customerId))}
            title="Ver detalle de abono"
          >
            ABONO
          </Button>
        );
      }

      return (
        <span
          className={`${baseClass} bg-emerald-100 text-emerald-800 border-emerald-200`}
        >
          ABONO
        </span>
      );
    }

    const label =
      r.movement === "PRESTAMO A NEGOCIO POR DUENO"
        ? "PRESTAMO"
        : r.movement === "DEVOLUCION A DUENO POR PRESTAMO"
          ? "PAGO A PRESTAMO"
          : String(r.movement || "SALIDA").toUpperCase();

    const toneClass =
      String(r.movement || "").toUpperCase() === "CORTE"
        ? "bg-purple-100 text-purple-800 border-purple-200"
        : Number(r.outAmount || 0) > 0
          ? "bg-red-100 text-red-800 border-red-200"
          : "bg-amber-100 text-amber-800 border-amber-200";

    if (!isLedger) {
      return <span className={`${baseClass} ${toneClass}`}>{label}</span>;
    }

    return (
      <button type="button" className={`${baseClass} ${toneClass}${actionClass}`} onClick={onClick}>
        {label}
      </button>
    );
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">Estado de Cuenta</h2>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setBackfillModalOpen(true)}
            className="!rounded-xl !text-amber-700 border-amber-300 hover:!bg-amber-50"
          >
            Backfill Totales
          </Button>
          <RefreshButton onClick={refresh} loading={loading} />
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={exportToExcel}
            className="!rounded-xl"
          >
            Excel
          </Button>
        </div>
      </div>

      {/* Filtros fecha */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 mb-4">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-4">
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => setCandiesAccountView("estado")}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
              candiesAccountView === "estado"
                ? "bg-indigo-600 text-white border-indigo-600 shadow-sm"
                : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
            }`}
          >
            Estado cuenta
          </button>
          <button
            type="button"
            onClick={() => setCandiesAccountView("utilidades")}
            className={`px-4 py-2 rounded-full text-sm font-semibold border transition-colors ${
              candiesAccountView === "utilidades"
                ? "bg-emerald-600 text-white border-emerald-600 shadow-sm"
                : "bg-white text-gray-700 border-gray-200 hover:bg-gray-50"
            }`}
          >
            Utilidades
          </button>
          {candiesAccountView === "utilidades" ? (
            <button
              type="button"
              title="Definiciones: Dispersión, UB efectiva, comisiones, U. Neta…"
              aria-label="Definiciones de utilidades"
              onClick={() => setUtilidadesGlossaryOpen(true)}
              className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-5 w-5"
                viewBox="0 0 20 20"
                fill="currentColor"
                aria-hidden
              >
                <path
                  fillRule="evenodd"
                  d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-9-3a1 1 0 10-2 0 1 1 0 002 0zM9 9a1 1 0 00-1 1v4a1 1 0 102 0v-4a1 1 0 00-1-1z"
                  clipRule="evenodd"
                />
              </svg>
            </button>
          ) : null}
        </div>
        {candiesAccountView === "estado" ? (
          <Button
            type="button"
            variant="primary"
            size="sm"
            onClick={toggleAllKpis}
            className={`!rounded-xl text-sm !px-3 !py-1 shrink-0 ${
              allCollapsed
                ? "!bg-blue-600 hover:!bg-blue-700"
                : "!bg-red-600 hover:!bg-red-700"
            }`}
          >
            {allCollapsed ? "Ver indicadores" : "Ocultar indicadores"}
          </Button>
        ) : null}
      </div>

      {candiesAccountView === "utilidades" ? (
        <CandiesUtilidadesPanel from={from} to={to} refreshKey={refreshKey} />
      ) : (
        <>
          {/* KPIs Desktop */}
          <div className="hidden md:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
            {/* Agrupación de 4 KPI en un solo contenedor */}
            <div className="sm:col-span-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
                {/* Ventas/Abonos */}
                <div className="border rounded-2xl p-3 bg-white">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Ventas / Abonos</div>
                  </div>
                  {!collapseVentas && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-gray-600">Ventas Cash $</div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(base?.salesCash ?? 0)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Ventas Crédito $ (no caja)
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(base?.salesCredit ?? 0)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Abonos al periodo $
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(base?.abonosPeriodo ?? 0)}
                      </div>
                    </div>
                  )}
                </div>

                {/* Paquetes (moved after Ventas/Abonos) */}
                <div className="border rounded-2xl p-3 bg-gray-50">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Paquetes</div>
                  </div>
                  {!collapsePacks && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-gray-600">
                        Paquetes vendidos Cash
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {Number(base?.packsCash ?? 0)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Paquetes vendidos Crédito
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {Number(base?.packsCredit ?? 0)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Total Paquetes
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {Number(
                          (base?.packsCash ?? 0) + (base?.packsCredit ?? 0),
                        )}
                      </div>
                    </div>
                  )}
                </div>

                {/* Comisiones (moved after Paquetes) */}
                <div className="border rounded-2xl p-3 bg-white">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">Comisiones</div>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setComisionesModalOpen(true)}
                      className="!p-1.5 !rounded-xl ml-2 !text-orange-500 hover:!text-orange-600 hover:!bg-orange-50"
                      title="Ver comisiones por vendedor"
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        viewBox="0 0 20 20"
                        fill="currentColor"
                      >
                        <path
                          fillRule="evenodd"
                          d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-9-3a1 1 0 10-2 0 1 1 0 002 0zM9 9a1 1 0 00-1 1v4a1 1 0 102 0v-4a1 1 0 00-1-1z"
                          clipRule="evenodd"
                        />
                      </svg>
                    </Button>
                  </div>
                  {!collapseComisiones && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-gray-600">
                        Comisiones Cash
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(totalComisionCash)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Comisiones Crédito (ventas)
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(totalComisionCredit)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Comisiones por abonos (parcial)
                      </div>
                      <div className="text-lg font-bold break-words max-w-full text-emerald-800">
                        {money(totalComisionParcialAbonos)}
                      </div>

                      <div className="border-t border-gray-200 pt-2 mt-2">
                        <div className="text-xs text-gray-700 font-semibold">
                          Total (cash + abonos parciales)
                        </div>
                        <div className="text-xl font-bold break-words max-w-full text-orange-700">
                          {money(totalComisionCashYParcial)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>

                {/* Gastos / Salidas */}
                <div className="border rounded-2xl p-3 bg-white">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold">
                      Gastos / Salidas
                    </div>
                  </div>
                  {!collapseGastos && (
                    <div className="mt-3 space-y-2">
                      <div className="text-xs text-gray-600">
                        Gastos del periodo
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(totalsLedger.gastosSum)}
                      </div>

                      <div className="text-xs text-gray-600 mt-2">
                        Salidas (Retiros, Depositos, Perdidas)
                      </div>
                      <div className="text-xl font-bold break-words max-w-full">
                        {money(totalsLedger.outSumNonGastos)}
                      </div>

                      <div className="border-t border-gray-200 pt-2 mt-2">
                        <div className="text-xs text-gray-700 font-semibold">
                          Ventas cash
                        </div>
                        <div className="text-lg font-bold break-words max-w-full text-slate-800">
                          {money(valorVentasCashPeriodo)}
                        </div>

                        <div className="text-xs text-gray-700 font-semibold">
                          Ventas al Costo
                        </div>
                        <div className="text-lg font-bold break-words max-w-full text-slate-800">
                          {money(salesCostPeriodo)}
                        </div>

                        <div className="text-xs text-gray-700 font-semibold mt-2">
                          Utilidad bruta
                        </div>
                        <div className="text-lg font-bold break-words max-w-full text-emerald-700">
                          {money(utilidadBrutaPeriodo)}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* Bloque KPIs principales */}
            <div className="sm:col-span-2 lg:col-span-3">
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
                {/* Prestamo-related KPIs hidden */}

                {/* KPI cards moved above; old duplicated KPI blocks removed */}
              </div>

              {/* Commission details removed (now summarized in the Comisiones card above) */}

              {/* KPIs secundarios (fila 2) */}
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="border rounded-2xl p-3 bg-blue-50">
                  <div className="text-xs text-gray-600">Arqueo Ventas</div>
                  <div className="text-2xl font-bold break-words max-w-full">
                    {money(totalsLedger.depositSum || 0)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-teal-50">
                  <div className="text-xs text-gray-600">
                    Saldo post comisión
                  </div>
                  <div className="text-xs text-gray-500 mt-0.5">
                    Saldo final − comisión cash
                  </div>
                  <div className="text-2xl font-bold break-words max-w-full mt-1">
                    {money(saldoPostComision)}
                  </div>
                </div>

                <div className="border rounded-2xl p-3 bg-gray-900 text-white">
                  <div className="text-xs opacity-80">
                    Saldo final (corriente)
                  </div>
                  <div className="text-3xl font-extrabold break-words max-w-full">
                    {money(saldoFinal)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* KPIs Mobile (Ventas -> Paquetes -> Comisiones -> Gastos) */}
          <div className="md:hidden mb-4">
            <div className="grid grid-cols-2 gap-2">
              <div className="border rounded-2xl p-3 bg-blue-50 text-center">
                <div className="text-xs text-gray-600">Ventas Cash</div>
                <div className="text-lg font-bold break-words max-w-full">
                  {money(base?.salesCash ?? 0)}
                </div>
              </div>

              <div className="border rounded-2xl p-3 bg-gray-50 text-center">
                <div className="text-xs text-gray-600">Paquetes</div>
                <div className="text-lg font-bold break-words max-w-full">
                  {Number((base?.packsCash ?? 0) + (base?.packsCredit ?? 0))}
                </div>
              </div>

              <div className="border rounded-2xl p-3 bg-sky-50 text-center col-span-2">
                <div className="text-xs text-gray-600">Comisiones Cash</div>
                <div className="text-lg font-bold break-words max-w-full">
                  {money(totalComisionCash)}
                </div>
                <div className="text-xs text-gray-600 mt-2">
                  Parcial (abonos)
                </div>
                <div className="text-base font-bold text-emerald-800">
                  {money(totalComisionParcialAbonos)}
                </div>
                <div className="text-xs text-gray-700 mt-2 font-semibold">
                  Total cash + parcial
                </div>
                <div className="text-lg font-bold text-orange-700">
                  {money(totalComisionCashYParcial)}
                </div>
              </div>

              <div className="border rounded-2xl p-3 bg-red-50 text-center col-span-2">
                <div className="text-xs text-gray-600">Gastos del periodo</div>
                <div className="text-lg font-bold break-words max-w-full">
                  {money(totalsLedger.gastosSum)}
                </div>

                <div className="border-t border-red-200 pt-2 mt-2">
                  <div className="text-xs text-gray-700 font-semibold">
                    Ventas cash
                  </div>
                  <div className="text-base font-bold break-words max-w-full text-slate-800">
                    {money(valorVentasCashPeriodo)}
                  </div>

                  <div className="text-xs text-gray-700 font-semibold">
                    Ventas al Costo
                  </div>
                  <div className="text-base font-bold break-words max-w-full text-slate-800">
                    {money(salesCostPeriodo)}
                  </div>

                  <div className="text-xs text-gray-700 font-semibold mt-2">
                    Utilidad bruta
                  </div>
                  <div className="text-base font-bold break-words max-w-full text-emerald-700">
                    {money(utilidadBrutaPeriodo)}
                  </div>
                </div>
              </div>
            </div>
          </div>

          {/* Botón + filtros */}
          <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
            <Button
              type="button"
              variant="primary"
              onClick={() => {
                setEditingId(null);
                setDate(today());
                setType("GASTO");
                setDescription("");
                setReference("");
                setInAmount("");
                setOutAmount("");
                setVendorId("");
                setCorteDesde("");
                setCorteHasta("");
                setModalOpen(true);
              }}
              className="!rounded-xl"
            >
              Agregar movimiento
            </Button>

            <div className="flex flex-col sm:flex-row gap-2 flex-wrap">
              <div className="w-full sm:w-auto min-w-0 sm:min-w-[12rem]">
                <MobileHtmlSelect
                  label="Movimiento"
                  value={movementTypeFilter}
                  onChange={setMovementTypeFilter}
                  options={movementTypeFilterSelectOptions}
                  sheetTitle="Filtrar movimiento"
                  selectClassName="border rounded px-2 py-2 text-sm w-full"
                  buttonClassName="border rounded px-2 py-2 text-sm w-full text-left flex items-center justify-between gap-2 bg-white"
                />
              </div>

              <div className="w-full sm:w-auto min-w-0 sm:min-w-[12rem]">
                <MobileHtmlSelect
                  label="Vendedor"
                  value={vendorFilter}
                  onChange={setVendorFilter}
                  options={vendorFilterSelectOptions}
                  sheetTitle="Filtrar vendedor"
                  selectClassName="border rounded px-2 py-2 text-sm w-full"
                  buttonClassName="border rounded px-2 py-2 text-sm w-full text-left flex items-center justify-between gap-2 bg-white"
                />
              </div>

              <div className="hidden w-full sm:w-auto min-w-0 sm:min-w-[10rem] md:block">
                <MobileHtmlSelect
                  label="Tipo"
                  value={typeFilter}
                  onChange={(v) =>
                    setTypeFilter(v as "ALL" | "Cash" | "Crédito")
                  }
                  options={saleTypeFilterOptions}
                  sheetTitle="Cash / Crédito"
                  selectClassName="border rounded px-2 py-2 text-sm w-full"
                  buttonClassName="border rounded px-2 py-2 text-sm w-full text-left flex items-center justify-between gap-2 bg-white"
                />
              </div>
            </div>

            {/* Móvil: tipo venta en una sola fila (Todos · Cash · Crédito · ℹ) */}
            <div className="flex flex-nowrap items-stretch gap-1 md:hidden">
              <button
                type="button"
                onClick={() => setTypeFilter("ALL")}
                className={`flex-1 min-w-0 rounded-full border px-2 py-2 text-center text-[11px] font-semibold leading-tight transition-colors ${
                  typeFilter === "ALL"
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-gray-200 bg-white text-gray-700"
                }`}
              >
                Todos
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter("Cash")}
                className={`flex-1 min-w-0 rounded-full border px-2 py-2 text-center text-[11px] font-semibold leading-tight transition-colors ${
                  typeFilter === "Cash"
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-gray-200 bg-white text-gray-700"
                }`}
              >
                Cash
              </button>
              <button
                type="button"
                onClick={() => setTypeFilter("Crédito")}
                className={`flex-1 min-w-0 rounded-full border px-2 py-2 text-center text-[11px] font-semibold leading-tight transition-colors ${
                  typeFilter === "Crédito"
                    ? "border-indigo-600 bg-indigo-600 text-white"
                    : "border-gray-200 bg-white text-gray-700"
                }`}
              >
                Crédito
              </button>
              <button
                type="button"
                title="Qué significa cada vista de tipo"
                aria-label="Ayuda: filtro Tipo (ventas)"
                onClick={() => setTipoFiltroInfoOpen(true)}
                className="flex w-9 shrink-0 items-center justify-center rounded-full border border-gray-200 bg-white text-gray-600"
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-4 w-4"
                  viewBox="0 0 20 20"
                  fill="currentColor"
                  aria-hidden
                >
                  <path
                    fillRule="evenodd"
                    d="M18 10A8 8 0 11 2 10a8 8 0 0116 0zm-9-3a1 1 0 10-2 0 1 1 0 002 0zM9 9a1 1 0 00-1 1v4a1 1 0 102 0v-4a1 1 0 00-1-1z"
                    clipRule="evenodd"
                  />
                </svg>
              </button>
            </div>
          </div>

          {/* Modal agregar/editar movimiento */}
          {modalOpen && (
            <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => setModalOpen(false)}
              />
              <div
                ref={modalRef}
                className="relative bg-white rounded-2xl p-4 w-full max-w-2xl shadow-xl max-h-[92vh] overflow-hidden"
              >
                <div className="flex items-center justify-between mb-3">
                  <h3 className="font-semibold">
                    {editingId ? "Editar movimiento" : "Agregar movimiento"}
                  </h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setModalOpen(false)}
                    className="!rounded-xl !text-gray-500 hover:!text-gray-700 !px-2"
                    aria-label="Cerrar"
                  >
                    ✕
                  </Button>
                </div>

                <div className="max-h-[78vh] overflow-y-auto pr-1">
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      {type === "CORTE" ? "Fecha de corte" : "Fecha"}
                    </label>
                    <input
                      type="date"
                      className="border rounded px-3 py-2 w-full"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                  </div>

                  {type === "CORTE" && (
                    <div className="sm:col-span-2 lg:col-span-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">
                          Desde (ventas incluidas)
                        </label>
                        <input
                          type="date"
                          className="border rounded px-3 py-2 w-full"
                          value={corteDesde}
                          onChange={(e) => setCorteDesde(e.target.value)}
                        />
                      </div>
                      <div>
                        <label className="block text-sm text-gray-600 mb-1">
                          Hasta (ventas incluidas)
                        </label>
                        <input
                          type="date"
                          className="border rounded px-3 py-2 w-full"
                          value={corteHasta}
                          onChange={(e) => setCorteHasta(e.target.value)}
                        />
                      </div>
                      <p className="sm:col-span-2 text-xs text-gray-500">
                        El detalle del movimiento mostrará las ventas cash (CONTADO)
                        con fecha de venta entre Desde y Hasta.
                      </p>
                      <div className="sm:col-span-2 rounded-xl border border-indigo-200 bg-gradient-to-br from-indigo-50/95 via-white to-violet-50/60 p-3 shadow-sm">
                        <div className="text-[11px] font-semibold uppercase tracking-wide text-indigo-900 mb-2">
                          Vista previa del periodo (Desde → Hasta)
                        </div>
                        {corteModalPreview.loading ? (
                          <p className="text-xs text-indigo-700 py-2">
                            Calculando ventas, abonos y movimientos de caja...
                          </p>
                        ) : (
                          <div className="space-y-3">
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
                              <div className="rounded-lg border border-emerald-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-emerald-900">
                                  Ventas (monto cash)
                                </div>
                                <div className="text-lg font-bold tabular-nums text-emerald-950">
                                  {money(corteModalPreview.ventasMonto)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-lime-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-lime-900">
                                  Utilidad Neta
                                </div>
                                <div className="text-lg font-bold tabular-nums text-lime-950">
                                  {money(corteModalPreview.utilidadNeta)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-violet-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-violet-900">
                                  Abonos (monto)
                                </div>
                                <div className="text-lg font-bold tabular-nums text-violet-950">
                                  {money(corteModalPreview.abonosMonto)}
                                </div>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                              <div className="rounded-lg border border-sky-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-sky-900">
                                  Comisión Cash
                                </div>
                                <div className="text-base font-bold tabular-nums text-sky-950">
                                  {money(corteModalPreview.comisionCash)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-slate-700">
                                  Comisión Crédito
                                </div>
                                <div className="text-base font-bold tabular-nums text-slate-900">
                                  {money(corteModalPreview.comisionCredit)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-violet-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-violet-900">
                                  Comisión Abonos
                                </div>
                                <div className="text-base font-bold tabular-nums text-violet-950">
                                  {money(corteModalPreview.comisionAbonos)}
                                </div>
                              </div>
                              <div className="rounded-lg border border-indigo-300 bg-indigo-50/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-indigo-950">
                                  Comisión Total Vendor
                                </div>
                                <div className="text-base font-extrabold tabular-nums text-indigo-950">
                                  {money(corteModalPreview.comisionTotal)}
                                </div>
                              </div>
                            </div>
                            <div className="rounded-lg border border-indigo-300 bg-indigo-50/80 px-3 py-2">
                              <div className="text-[11px] font-medium text-indigo-950">
                                Ventas + Abonos
                              </div>
                              <div className="text-xl font-extrabold tabular-nums text-indigo-950">
                                {money(
                                  round2(
                                    corteModalPreview.ventasMonto +
                                      corteModalPreview.abonosMonto,
                                  ),
                                )}
                              </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="rounded-lg border border-rose-200 bg-white/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-rose-900">
                                  Gastos + Salidas (salen de caja)
                                </div>
                                <div className="text-lg font-bold tabular-nums text-rose-950">
                                  {money(corteModalPreview.totalCashOutCaja)}
                                </div>
                                <p className="text-[10px] text-rose-800/85 mt-1 leading-snug">
                                  Gastos {money(corteModalPreview.gastosSum)} · Otras
                                  salidas {" "}
                                  {money(
                                    round2(
                                      corteModalPreview.totalCashOutCaja -
                                        corteModalPreview.gastosSum -
                                        corteModalPreview.comisionTotal,
                                    ),
                                  )}
                                  {" "}· Comisión vendedor{" "}
                                  {money(corteModalPreview.comisionTotal)}
                                </p>
                              </div>
                              <div className="rounded-lg border border-emerald-300 bg-emerald-50/90 px-3 py-2">
                                <div className="text-[11px] font-medium text-emerald-950">
                                  Saldo Final
                                </div>
                                <div className="text-lg font-extrabold tabular-nums text-emerald-950">
                                  {money(
                                    round2(
                                      corteModalPreview.ventasMonto -
                                        corteModalPreview.totalCashOutCaja,
                                    ),
                                  )}
                                </div>
                                <p className="text-[10px] text-emerald-900/85 mt-1 leading-snug">
                                  Fórmula: Ventas Cash − Gastos/Salidas.
                                </p>
                              </div>
                            </div>
                            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                                <div className="text-[11px] font-medium text-slate-600">
                                  Transacciones (ventas cash)
                                </div>
                                <div className="text-2xl font-bold tabular-nums text-slate-900">
                                  {corteModalPreview.ventasCount}
                                </div>
                              </div>
                              <div className="rounded-lg border border-slate-200 bg-white px-3 py-2">
                                <div className="text-[11px] font-medium text-slate-600">
                                  Abonos (registros)
                                </div>
                                <div className="text-2xl font-bold tabular-nums text-slate-900">
                                  {corteModalPreview.abonosCount}
                                </div>
                              </div>
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  )}

                  <div>
                    <MobileHtmlSelect
                      label="Tipo movimiento"
                      value={type}
                      onChange={(v) => setType(v as LedgerType)}
                      options={modalLedgerTypeOptions}
                      sheetTitle="Tipo de movimiento"
                      selectClassName="border rounded px-3 py-2 w-full"
                      buttonClassName="border rounded px-3 py-2 w-full text-left flex items-center justify-between gap-2 bg-white"
                    />

                    {affectsOwnerDebt(type) && (
                      <div className="mt-1 text-xs text-amber-700">
                        Este movimiento afecta la deuda del negocio con el
                        dueño.
                      </div>
                    )}
                  </div>

                  {/* Vendedor para pago comisión */}
                  <div>
                    <MobileHtmlSelect
                      label="Vendedor"
                      value={vendorId}
                      onChange={setVendorId}
                      options={
                        type === "CORTE"
                          ? corteVendorSelectOptions
                          : vendorModalSelectOptions
                      }
                      disabled={
                        !(
                          type === "PAGO_COMISION" ||
                          type === "DEPOSITO" ||
                          type === "CORTE"
                        )
                      }
                      sheetTitle="Vendedor"
                      selectClassName="border rounded px-3 py-2 w-full"
                      buttonClassName="border rounded px-3 py-2 w-full text-left flex items-center justify-between gap-2 bg-white"
                    />
                    {type === "CORTE" && (
                      <div className="mt-1 text-xs text-gray-600">
                        Filtra vista previa por vendedor activo en el rango.
                      </div>
                    )}
                    {type === "PAGO_COMISION" && (
                      <div className="mt-1 text-xs text-gray-600">
                        Obligatorio: para que cuadre en la lista de comisiones.
                      </div>
                    )}
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Referencia
                    </label>
                    <input
                      className="border rounded px-3 py-2 w-full"
                      value={reference}
                      onChange={(e) => setReference(e.target.value)}
                      placeholder="Factura, recibo, etc."
                    />
                  </div>

                  <div className="sm:col-span-2 lg:col-span-3">
                    <label className="block text-sm text-gray-600 mb-1">
                      Descripción
                    </label>
                    <input
                      className="border rounded px-3 py-2 w-full"
                      value={description}
                      onChange={(e) => setDescription(e.target.value)}
                      placeholder="Ej: Pago comisión vendedor / compra bolsas / reabastecimiento..."
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Entrada (+)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="^\\d*(\\.\\d{0,2})?$"
                      className="border rounded px-3 py-2 w-full"
                      value={inAmount}
                      onChange={(e) => {
                        let val = e.target.value.replace(/,/g, ".");
                        if (
                          /^\d*(\.\d{0,2})?$/.test(val) ||
                          val === "." ||
                          val === ""
                        ) {
                          setInAmount(val === "." ? "." : val);
                        }
                      }}
                      placeholder="0.00"
                      disabled={[
                        "GASTO",
                        "REABASTECIMIENTO",
                        "RETIRO",
                        "DEPOSITO",
                        "CORTE",
                        "PERDIDA",
                        "DEVOLUCION A DUENO POR PRESTAMO",
                        "PAGO_COMISION",
                      ].includes(String(type))}
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Salida (−)
                    </label>
                    <input
                      type="text"
                      inputMode="decimal"
                      pattern="^\\d*(\\.\\d{0,2})?$"
                      className="border rounded px-3 py-2 w-full"
                      value={outAmount}
                      onChange={(e) => {
                        let val = e.target.value.replace(/,/g, ".");
                        if (
                          /^\d*(\.\d{0,2})?$/.test(val) ||
                          val === "." ||
                          val === ""
                        ) {
                          setOutAmount(val === "." ? "." : val);
                        }
                      }}
                      placeholder="0.00"
                      disabled={["PRESTAMO A NEGOCIO POR DUENO"].includes(
                        String(type),
                      )}
                    />
                  </div>

                    <div className="sm:col-span-3 flex gap-2 justify-end mt-2">
                    <Button
                      type="button"
                      variant="outline"
                      onClick={() => setModalOpen(false)}
                      className="!rounded-xl"
                    >
                      Cancelar
                    </Button>
                    <Button
                      type="button"
                      variant="primary"
                      onClick={saveMovement}
                      className="!rounded-xl"
                    >
                      Guardar movimiento
                    </Button>
                  </div>
                </div>
                </div>
              </div>
            </div>
          )}

          {/* Modal confirmar backfill ventas */}
          {backfillModalOpen && (
            <div className="fixed inset-0 z-[75] flex items-center justify-center p-4">
              <div
                className="absolute inset-0 bg-black/40"
                onClick={() => !backfillRunning && setBackfillModalOpen(false)}
              />
              <div className="relative bg-white rounded-2xl p-4 w-full max-w-lg shadow-xl border">
                <div className="flex items-center justify-between mb-2">
                  <h3 className="font-semibold">Backfill</h3>
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() =>
                      !backfillRunning && setBackfillModalOpen(false)
                    }
                    className="!rounded-xl !text-gray-500 hover:!text-gray-700 !px-2"
                    disabled={backfillRunning}
                  >
                    ✕
                  </Button>
                </div>

                <p className="text-sm text-gray-600">
                  Se actualizarán las ventas de la colección sales_candies para
                  guardar estos campos en cada documento: totalCost, totalUneta
                  y totalVendorGain.
                </p>

                <p className="text-xs text-amber-700 mt-2">
                  Recomendación: ejecutar fuera de horas pico.
                </p>

                <p className="text-xs text-gray-500 mt-2">
                  Fórmula usada: packages x providerPricePerPackage, packages x
                  uNetaPorPaquete y packages x uvXpaq.
                </p>

                <div className="mt-4 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => setBackfillModalOpen(false)}
                    className="!rounded-xl"
                    disabled={backfillRunning}
                  >
                    Cancelar
                  </Button>
                  <Button
                    type="button"
                    variant="primary"
                    onClick={runSalesTotalsBackfill}
                    className="!rounded-xl"
                    disabled={backfillRunning}
                  >
                    {backfillRunning ? "Procesando..." : "Ejecutar backfill"}
                  </Button>
                </div>
              </div>
            </div>
          )}

          {/* Modal comisiones por vendedor */}
          {comisionesModalOpen && (
            <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[80]">
              <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-2xl p-4">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-lg font-bold">Comisiones por Vendedor</h3>
                  <Button
                    variant="secondary"
                    size="sm"
                    className="!rounded-xl"
                    onClick={() => setComisionesModalOpen(false)}
                  >
                    Cerrar
                  </Button>
                </div>

                <div className="space-y-4 text-sm max-h-[60vh] overflow-auto">
                  <div>
                    <div className="font-semibold">Comisiones Cash</div>
                    {listComCash.length === 0 ? (
                      <div className="text-gray-500">
                        Sin comisiones en efectivo.
                      </div>
                    ) : (
                      <ul className="divide-y">
                        {listComCash.map((it: any, idx: number) => (
                          <li
                            key={it.sellerId ?? it.id ?? idx}
                            className="py-2 flex justify-between"
                          >
                            <span>
                              {it.sellerName ?? it.name ?? it.sellerId ?? "—"}
                            </span>
                            <span className="font-mono">
                              {money(it.amount ?? it.total ?? 0)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>

                  <div>
                    <div className="font-semibold">Comisiones Crédito</div>
                    {listComCredit.length === 0 ? (
                      <div className="text-gray-500">
                        Sin comisiones en crédito.
                      </div>
                    ) : (
                      <ul className="divide-y">
                        {listComCredit.map((it: any, idx: number) => (
                          <li
                            key={it.sellerId ?? it.id ?? idx}
                            className="py-2 flex justify-between"
                          >
                            <span>
                              {it.sellerName ?? it.name ?? it.sellerId ?? "—"}
                            </span>
                            <span className="font-mono">
                              {money(it.amount ?? it.total ?? 0)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              </div>
            </div>
          )}

          {tipoFiltroInfoOpen ? (
            <div
              className="fixed inset-0 z-[85] flex items-center justify-center bg-black/40 p-4"
              role="dialog"
              aria-modal="true"
              aria-labelledby="tipo-filtro-info-title"
              onClick={() => setTipoFiltroInfoOpen(false)}
            >
              <div
                className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 shadow-xl"
                onClick={(e) => e.stopPropagation()}
              >
                <h3
                  id="tipo-filtro-info-title"
                  className="text-base font-bold text-gray-900"
                >
                  Filtro por tipo de venta
                </h3>
                <p className="mt-3 text-sm leading-relaxed text-gray-600">
                  <strong>Todos</strong>: muestra movimientos sin filtrar por
                  venta cash o crédito. <strong>Cash</strong>: solo filas cuyo
                  tipo es venta al contado (CONTADO). <strong>Crédito</strong>:
                  solo ventas a crédito. En la vista <strong>Utilidades</strong>
                  , las tres vistas (todas / contado / crédito) reparten
                  importes entre órdenes maestras así:
                </p>
                <p className="mt-2 text-sm leading-relaxed text-gray-600">
                  {UTILIDADES_ATRIB_VISTAS_TEXT}
                </p>
                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    variant="outline"
                    className="!rounded-xl"
                    onClick={() => setTipoFiltroInfoOpen(false)}
                  >
                    Cerrar
                  </Button>
                </div>
              </div>
            </div>
          ) : null}

          {/* Tabla (desktop + móvil) */}
          <div className="block overflow-x-auto">
            <table className="min-w-full w-full border text-sm table-auto">
              <thead className="bg-gray-100">
                <tr>
                  <th className="border p-2">Fecha</th>
                  <th className="border p-2">Movimiento</th>
                  <th className="border p-2">Tipo</th>
                  <th className="border p-2">Vendedor</th>
                  <th className="border p-2">Venta</th>
                  <th className="border p-2">Paquetes</th>
                  <th className="border p-2">Comisión</th>
                  <th className="border p-2">Evolutivo</th>
                  <th className="border p-2">Entrada</th>
                  <th className="border p-2">Salida</th>
                  <th className="border p-2">Evolutivo</th>
                  <th className="border p-2">Saldo</th>
                  <th className="border p-2">Acciones</th>
                </tr>
              </thead>
              <tbody>
                {/* fila saldo inicial */}
                <tr className="text-center bg-indigo-50">
                  <td className="border p-1">
                    {from} → {to}
                  </td>
                  <td className="border p-1">SALDO_INICIAL</td>
                  <td className="border p-1">—</td>
                  <td className="border p-1">—</td>
                  <td className="border p-1">
                    <span className="text-green-600 font-medium">
                      {money(0)}
                    </span>
                  </td>
                  <td className="border p-1">—</td>
                  <td className="border p-1">{money(0)}</td>
                  <td className="border p-1">
                    <span className="text-green-600 font-medium">
                      {money(0)}
                    </span>
                  </td>
                  <td className="border p-1">{money(saldoBase)}</td>
                  <td className="border p-1">{money(0)}</td>
                  <td className="border p-1">{money(0)}</td>
                  <td className="border p-1 font-semibold">
                    {money(saldoBase)}
                  </td>
                  <td className="border p-1">—</td>
                </tr>

                {filteredRows.map((r) => (
                  <tr key={r.id} className="text-center">
                    <td className="border p-1">{r.date}</td>

                    <td className="border p-1">
                      {renderMovementChip(r)}
                    </td>

                    <td className="border p-1">{r.type || "—"}</td>
                    <td className="border p-1">{r.vendorName || "—"}</td>

                    <td className="border p-1">{money(r.saleAmount || 0)}</td>

                    <td className="border p-1">
                      {typeof r.packages === "number" && r.saleId ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="!h-auto !px-1 !py-0 !rounded-md underline !text-blue-600 hover:!text-blue-800 hover:!bg-blue-50 !font-normal"
                          onClick={() => openItemsDrawer(r.saleId!, r)}
                          title="Ver detalle de productos"
                        >
                          {r.packages}
                        </Button>
                      ) : (
                        "—"
                      )}
                    </td>

                    <td className="border p-1">
                      {typeof r.commission === "number" && r.commission > 0
                        ? money(r.commission)
                        : "—"}
                    </td>

                    <td className="border p-1">
                      <span className="text-green-600 font-medium">
                        {money((r as any).commissionEvol || 0)}
                      </span>
                    </td>

                    <td className="border p-1">{money(r.inAmount)}</td>
                    <td className="border p-1">{money(r.outAmount)}</td>

                    <td className="border p-1">
                      <span className="text-green-600 font-medium">
                        {money((r as any).evolutive || 0)}
                      </span>
                    </td>
                    <td className="border p-1 font-semibold">
                      {money(r.balance)}
                    </td>

                    <td className="border p-1 relative">
                      {/* ✅ SOLO editable/eliminable: lo manual (cash_ledger_candies) */}
                      {r.source !== "ledger" ? (
                        <div className="text-xs text-gray-400">—</div>
                      ) : (
                        <div className="inline-block">
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            onClick={() =>
                              setActionOpenId(
                                actionOpenId === r.id ? null : r.id,
                              )
                            }
                            className="!px-2 !py-1 !rounded-lg"
                            aria-label="Acciones"
                          >
                            ⋯
                          </Button>

                          {actionOpenId === r.id && (
                            <div
                              ref={(el) => {
                                actionMenuRef.current =
                                  el as HTMLDivElement | null;
                              }}
                              className="absolute right-2 mt-1 bg-white border rounded shadow-md z-50 text-left text-sm"
                            >
                              <Button
                                type="button"
                                variant="ghost"
                                className="block w-full !rounded-none justify-start px-3 py-2 text-sm font-normal"
                                onClick={() => {
                                  setEditingId(r.id);
                                  setDate(r.date);
                                  setType(r.movement as LedgerType);
                                  setDescription(r.description || "");
                                  setReference(r.reference || "");
                                  setVendorId(r.vendorId || "");
                                  setCorteDesde(
                                    String((r as any).corteDesde || "").slice(0, 10),
                                  );
                                  setCorteHasta(
                                    String((r as any).corteHasta || "").slice(0, 10),
                                  );
                                  setInAmount(
                                    Number(r.inAmount || 0) === 0
                                      ? ""
                                      : String(Number(r.inAmount)),
                                  );
                                  setOutAmount(
                                    Number(r.outAmount || 0) === 0
                                      ? ""
                                      : String(Number(r.outAmount)),
                                  );
                                  setModalOpen(true);
                                  setActionOpenId(null);
                                }}
                              >
                                Editar
                              </Button>
                              <Button
                                type="button"
                                variant="ghost"
                                className="block w-full !rounded-none justify-start px-3 py-2 text-sm !text-red-600 hover:!bg-red-50"
                                onClick={async () => {
                                  setActionOpenId(null);
                                  if (
                                    !window.confirm(
                                      "¿Eliminar este movimiento?",
                                    )
                                  )
                                    return;

                                  try {
                                    await deleteDoc(
                                      doc(db, "cash_ledger_candies", r.id),
                                    );
                                    refresh();
                                    setToastMsg("✅ Movimiento eliminado.");
                                  } catch (e) {
                                    console.error(e);
                                    setToastMsg(
                                      "❌ No se pudo eliminar el movimiento. Revisa la consola.",
                                    );
                                  }
                                }}
                              >
                                Eliminar
                              </Button>
                            </div>
                          )}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}

                {filteredRows.length === 0 && (
                  <tr>
                    <td colSpan={13} className="p-3 text-center text-gray-500">
                      No hay datos en este rango.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      )}

      {/* Fuera del bloque «estado» para que funcione en vista Utilidades */}
      {utilidadesGlossaryOpen ? (
        <div
          className="fixed inset-0 z-[90] flex items-center justify-center bg-black/40 p-4"
          role="dialog"
          aria-modal="true"
          aria-labelledby="utilidades-glossary-title"
          onClick={() => setUtilidadesGlossaryOpen(false)}
        >
          <div
            className="max-h-[85vh] w-full max-w-lg overflow-y-auto rounded-2xl border border-gray-200 bg-white p-4 shadow-xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3
              id="utilidades-glossary-title"
              className="text-base font-bold text-gray-900"
            >
              Definiciones (utilidades dulces)
            </h3>
            <p className="mt-3 text-sm leading-relaxed text-gray-600 whitespace-pre-wrap">
              {UTILIDADES_UTIL_GLOSSARY_TEXT}
            </p>
            <div className="mt-4 flex justify-end">
              <Button
                type="button"
                variant="outline"
                className="!rounded-xl"
                onClick={() => setUtilidadesGlossaryOpen(false)}
              >
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      ) : null}

      {/* Drawer detalle items de venta */}
      <SlideOverDrawer
        open={itemsDrawerOpen}
        onClose={() => setItemsDrawerOpen(false)}
        title={`Venta${itemsDrawerSale?.type ? ` — ${itemsDrawerSale.type}` : ""}`}
        subtitle={itemsDrawerSale?.date || ""}
        badge={
          itemsDrawerSale?.vendorName && itemsDrawerSale.vendorName !== "—" ? (
            <span className="text-[11px] px-2 py-[2px] rounded-full bg-blue-100 text-blue-800 border border-blue-200">
              {itemsDrawerSale.vendorName}
            </span>
          ) : null
        }
        titleId="drawer-items-candies"
      >
        {itemsDrawerSale && (
          <DrawerMoneyStrip
            items={[
              {
                label: "Total venta",
                value: money(itemsDrawerSale.saleAmount),
                tone: "blue",
              },
              {
                label: "Paquetes",
                value: String(itemsDrawerSale.packages),
                tone: "slate",
              },
              {
                label: "Costo total",
                value: money(itemsDrawerTotals.cost),
                tone: "slate",
              },
              {
                label: "U. neta",
                value: money(itemsDrawerTotals.net),
                tone: "emerald",
              },
              {
                label: "Comisión total",
                value: money(itemsDrawerTotals.commission),
                tone: "blue",
              },
            ]}
          />
        )}

        <DrawerSectionTitle>
          Productos ({itemsDrawerRows.length})
        </DrawerSectionTitle>

        <div className="mt-2 space-y-2">
          {itemsDrawerLoading ? (
            <div className="text-sm text-gray-500 text-center py-6">
              Cargando…
            </div>
          ) : itemsDrawerRows.length === 0 ? (
            <div className="text-sm text-gray-500 text-center py-6">
              Sin ítems en esta venta.
            </div>
          ) : (
            itemsDrawerRows.map((it, idx) => (
              <DrawerDetailDlCard
                key={idx}
                title={it.productName || "Sin nombre"}
                rows={[
                  { label: "Paquetes", value: it.qty },
                  { label: "Precio unit.", value: money(it.unitPrice) },
                  { label: "Descuento", value: money(it.discount || 0) },
                  {
                    label: "Monto línea",
                    value: money(it.total),
                    ddClassName: "text-sm font-bold tabular-nums text-gray-900",
                  },
                  {
                    label: "Costo",
                    value: money(it.cost || 0),
                    ddClassName:
                      "text-sm font-semibold tabular-nums text-slate-700",
                  },
                  {
                    label: "Utilidad neta",
                    value: money(it.netProfit || 0),
                    ddClassName:
                      "text-sm font-semibold tabular-nums text-emerald-700",
                  },
                  ...(Number(it.commission || 0) > 0
                    ? [
                        {
                          label: "Comisión",
                          value: money(it.commission || 0),
                          ddClassName:
                            "text-sm font-semibold tabular-nums text-emerald-700",
                        },
                      ]
                    : []),
                ]}
              />
            ))
          )}
        </div>
      </SlideOverDrawer>

      <SlideOverDrawer
        open={movimientoDrawerRow !== null}
        onClose={() => setMovimientoDrawerRow(null)}
        title="Detalle del movimiento"
        subtitle={movimientoDrawerRow?.date || ""}
        titleId="drawer-movimiento-candies"
        panelMaxWidthClassName="max-w-2xl"
      >
        {movimientoDrawerRow ? (
          <div className="space-y-0">
            <DrawerDetailDlCard
              title={String(movimientoDrawerRow.movement || "—")}
              rows={[
                {
                  label:
                    String(movimientoDrawerRow.movement || "").toUpperCase() ===
                    "CORTE"
                      ? "Fecha de corte"
                      : "Fecha",
                  value: String(movimientoDrawerRow.date || "—"),
                },
                {
                  label: "Descripción",
                  value: String(movimientoDrawerRow.description || "—"),
                  ddClassName: "text-sm text-gray-800",
                },
                {
                  label: "Referencia",
                  value: String(movimientoDrawerRow.reference || "—"),
                },
                {
                  label: "Vendedor",
                  value: String(movimientoDrawerRow.vendorName || "—"),
                },
                ...(String(movimientoDrawerRow.movement || "").toUpperCase() ===
                "CORTE"
                  ? [
                      {
                        label: "Ventas incluidas desde",
                        value: String(movimientoDrawerRow.corteDesde || "—"),
                        ddClassName: "text-sm font-medium text-purple-900",
                      },
                      {
                        label: "Ventas incluidas hasta",
                        value: String(movimientoDrawerRow.corteHasta || "—"),
                        ddClassName: "text-sm font-medium text-purple-900",
                      },
                    ]
                  : []),
                {
                  label: "Entrada",
                  value: money(movimientoDrawerRow.inAmount),
                  ddClassName: "tabular-nums text-emerald-800 font-semibold",
                },
                {
                  label: "Salida",
                  value: money(movimientoDrawerRow.outAmount),
                  ddClassName: "tabular-nums text-red-800 font-semibold",
                },
                {
                  label: "Saldo",
                  value: money(movimientoDrawerRow.balance),
                  ddClassName: "tabular-nums font-bold",
                },
                {
                  label: "Fuente",
                  value: String(movimientoDrawerRow.source || "ledger"),
                },
                {
                  label: "Usuario",
                  value:
                    movimientoDrawerRow.createdBy?.displayName ||
                    movimientoDrawerRow.createdBy?.name ||
                    movimientoDrawerRow.createdBy?.email ||
                    movimientoDrawerRow.createdBy?.uid ||
                    "—",
                  ddClassName: "text-sm",
                },
                {
                  label: "ID",
                  value: String(movimientoDrawerRow.id || "—"),
                  ddClassName: "font-mono text-xs",
                },
              ]}
            />

            {String(movimientoDrawerRow.movement || "").toUpperCase() ===
            "CORTE" ? (
              <>
                <DrawerSectionTitle className="mt-4 mb-2">
                  Ventas del corte
                </DrawerSectionTitle>

                {movimientoDrawerLoading ? (
                  <p className="text-sm text-gray-500 px-1">Cargando ventas del corte...</p>
                ) : movimientoDrawerLines.length === 0 ? (
                  <p className="text-sm text-gray-500 px-1">
                    Sin ventas CONTADO en el rango guardado para este corte.
                  </p>
                ) : (
                  <div className="space-y-3">
                    <DrawerStatGrid
                      items={[
                        {
                          label: "Productos distintos",
                          value: movimientoDrawerKpis.productCount,
                          tone: "slate",
                        },
                        {
                          label: "Líneas",
                          value: movimientoDrawerKpis.lineCount,
                          tone: "sky",
                        },
                        {
                          label: "Paquetes",
                          value: movimientoDrawerKpis.packages,
                          tone: "amber",
                        },
                        {
                          label: "Monto",
                          value: money(movimientoDrawerKpis.amount),
                          tone: "indigo",
                          valueClassName: "",
                        },
                        {
                          label: "Utilidad neta",
                          value: money(movimientoDrawerKpis.grossProfit),
                          tone: "emerald",
                          valueClassName: "",
                        },
                        {
                          label: "Comisión",
                          value: money(movimientoDrawerKpis.commission),
                          tone: "violet",
                          valueClassName: "",
                        },
                      ]}
                    />

                    <DrawerSectionTitle className="mt-0">
                      {movimientoDrawerLines.length} línea(s) · solo cash (CONTADO)
                    </DrawerSectionTitle>

                    {movimientoDrawerLines.map((line) => (
                      <DrawerDetailDlCard
                        key={line.id}
                        title={line.productName}
                        rows={[
                          { label: "Fecha venta", value: line.date },
                          {
                            label: "Precio",
                            value: money(line.unitPrice),
                            ddClassName: "tabular-nums",
                          },
                          {
                            label: "Paquetes",
                            value: Number(line.packages || 0).toFixed(2),
                            ddClassName: "tabular-nums",
                          },
                          {
                            label: "Monto",
                            value: money(line.amount),
                            ddClassName: "tabular-nums font-semibold",
                          },
                          {
                            label: "Utilidad neta",
                            value: money(line.grossProfit),
                            ddClassName:
                              "tabular-nums text-emerald-800 font-semibold",
                          },
                          {
                            label: "Comisión",
                            value: money(line.commission),
                            ddClassName:
                              "tabular-nums text-violet-800 font-semibold",
                          },
                          {
                            label: "Vendedor",
                            value: line.seller,
                            ddClassName: "text-sm break-all",
                          },
                        ]}
                      />
                    ))}
                  </div>
                )}
              </>
            ) : null}
          </div>
        ) : null}
      </SlideOverDrawer>

      {/* Modal pequeño para ABONO (cliente) */}
      {abonoModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[70]">
          <div className="bg-white rounded-lg shadow-xl border w-[90%] max-w-md p-4">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Detalle Abono</h3>
              <Button
                variant="secondary"
                size="sm"
                className="!rounded-xl"
                onClick={() => setAbonoModalOpen(false)}
              >
                Cerrar
              </Button>
            </div>

            {abonoLoading ? (
              <div className="p-6 text-center">Cargando…</div>
            ) : (
              <div className="space-y-2 text-sm">
                <div>
                  <span className="font-semibold">Cliente:</span>{" "}
                  {abonoCustomer?.name || abonoCustomer?.id || "—"}
                </div>
                <div>
                  <span className="font-semibold">Saldo pendiente:</span>{" "}
                  {money(abonoKpis.saldoActual)}
                </div>
                <div>
                  <span className="font-semibold">Abonado a la fecha:</span>{" "}
                  {money(abonoKpis.totalAbonado)}
                </div>
                <div>
                  <span className="font-semibold">Último abono:</span>{" "}
                  {abonoKpis.lastAbonoAmount
                    ? `${money(abonoKpis.lastAbonoAmount)} • ${abonoKpis.lastAbonoDate}`
                    : "—"}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
      {toastMsg && <Toast message={toastMsg} onClose={() => setToastMsg("")} />}
    </div>
  );
}
