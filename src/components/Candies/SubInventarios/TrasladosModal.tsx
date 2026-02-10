import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../../firebase";

// Tipos mínimos requeridos (ajusta según tu modelo real)
interface OrderRow {
  id: string;
  orderId?: string | null;
  sellerId: string;
  sellerName: string;
  productId: string;
  productName: string;
  category: string;
  remainingPackages: number;
  providerPrice?: number;
  unitPriceRivas?: number;
  unitPriceIsla?: number;
  unitsPerPackage?: number;
  remainingUnits?: number;
  unitPriceSanJorge?: number;
  packages?: number;
  grossProfit?: number;
  logisticAllocated?: number;
  uAproximada?: number;
  transferDelta?: number;
}

interface TransferRow {
  id: string;
  createdAt: any;
  date: string;
  createdByEmail: string;
  createdByName: string;
  productId: string;
  productName: string;
  packagesMoved: number;
  providerPrice: number;
  unitPriceRivas: number;
  unitPriceIsla: number;
  toSellerId: string;
  toSellerName: string;
  toOrderKey: string;
  toOrderLabel: string;
  comment: string;
  fromSellerId: string;
  fromSellerName: string;
  fromOrderKey: string;
  fromOrderLabel: string;
  fromVendorRowId: string;
  toVendorRowId: string;
  destRowWasNew?: boolean;
}

interface SellerInfo {
  id: string;
  name: string;
  email?: string;
  branch?: string;
  branchLabel?: string;
  commissionPercent?: number;
}

interface ProductInfo {
  id: string;
  name: string;
  category: string;
  unitsPerPackage: number;
  logisticAllocatedPerPack: number;
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;
  grossProfitPerPackRivas: number;
  grossProfitPerPackSanJorge: number;
  grossProfitPerPackIsla: number;
  uApproxPerPackRivas: number;
  uApproxPerPackSanJorge: number;
  uApproxPerPackIsla: number;
}

interface Props<T extends OrderRow = OrderRow> {
  open: boolean;
  onClose: () => void;
  orders: any[];
  rows: T[];
  setRows: React.Dispatch<React.SetStateAction<T[]>>;
  isAdmin: boolean;
  currentUserEmail: string;
  currentUserName: string;
  sellerCandyId?: string;
  sellers: SellerInfo[];
  products: ProductInfo[];
  transferAgg: Record<string, { out: number; in: number }>;
  setTransferAgg: (
    fn: (
      prev: Record<string, { out: number; in: number }>,
    ) => Record<string, { out: number; in: number }>,
  ) => void;
  setTransferRowDeltas: React.Dispatch<
    React.SetStateAction<Record<string, number>>
  >;
}

type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const buildOrderKey = (sellerId: string, date: string) =>
  `${sellerId}__${date}`;
const resolveDate = (raw: any) => {
  if (!raw) return "";
  if (typeof raw === "string") return raw;
  if (raw?.seconds) {
    const d = new Date(raw.seconds * 1000);
    return d.toISOString().slice(0, 10);
  }
  if (raw?.toDate) {
    const d = raw.toDate();
    return d.toISOString().slice(0, 10);
  }
  return "";
};

const getOrderKeyForRow = (row: OrderRow) => {
  const seller = row.sellerId || "";
  const dateStr = resolveDate((row as any).date);
  if (seller && dateStr) return buildOrderKey(seller, dateStr);
  if (row.orderId) return row.orderId;
  return row.id;
};

const parseDateInput = (iso: string, endOfDay = false) => {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  if (endOfDay) d.setHours(23, 59, 59, 999);
  else d.setHours(0, 0, 0, 0);
  return d;
};

const getTransferDate = (t: TransferRow) => {
  if (t.createdAt?.toDate) return t.createdAt.toDate();
  if (t.createdAt?.seconds) return new Date(t.createdAt.seconds * 1000);
  if (t.date) {
    const d = new Date(t.date);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
};

const normalizeBranch = (raw?: string): Branch | undefined => {
  const v = String(raw || "")
    .trim()
    .toUpperCase();
  if (v.includes("ISLA")) return "ISLA";
  if (v.includes("JORGE")) return "SAN_JORGE";
  if (v.includes("RIVAS")) return "RIVAS";
  return undefined;
};

const clampPercent = (n: any) => {
  const v = Number(n || 0);
  if (!isFinite(v)) return 0;
  if (v < 0) return 0;
  return v;
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

const getPricePerPack = (product: ProductInfo, branch?: Branch) => {
  if (!branch) return product.unitPriceIsla || 0;
  if (branch === "RIVAS") return product.unitPriceRivas || 0;
  if (branch === "SAN_JORGE") return product.unitPriceSanJorge || 0;
  return product.unitPriceIsla || 0;
};

const getGrossProfitPerPack = (product: ProductInfo, branch?: Branch) => {
  if (!branch) return product.grossProfitPerPackIsla || 0;
  if (branch === "RIVAS") return product.grossProfitPerPackRivas || 0;
  if (branch === "SAN_JORGE") return product.grossProfitPerPackSanJorge || 0;
  return product.grossProfitPerPackIsla || 0;
};

const getUApproxPerPack = (product: ProductInfo, branch?: Branch) => {
  if (!branch) return product.uApproxPerPackIsla || 0;
  if (branch === "RIVAS") return product.uApproxPerPackRivas || 0;
  if (branch === "SAN_JORGE") return product.uApproxPerPackSanJorge || 0;
  return product.uApproxPerPackIsla || 0;
};

export default function TrasladosModal<T extends OrderRow = OrderRow>({
  open,
  onClose,
  orders,
  rows,
  setRows,
  isAdmin,
  currentUserEmail,
  currentUserName,
  sellerCandyId,
  sellers,
  products,
  transferAgg,
  setTransferAgg,
  setTransferRowDeltas,
}: Props<T>) {
  const [transfersLoading, setTransfersLoading] = useState(false);
  const [transfersRows, setTransfersRows] = useState<TransferRow[]>([]);
  const [trFromOrderKey, setTrFromOrderKey] = useState("");
  const [trFromVendorRowId, setTrFromVendorRowId] = useState("");
  const [trToOrderKey, setTrToOrderKey] = useState("");
  const [trToVendorRowId, setTrToVendorRowId] = useState("");
  const [trPackages, setTrPackages] = useState("0");
  const [trComment, setTrComment] = useState("");
  const [trSaving, setTrSaving] = useState(false);
  const [msg, setMsg] = useState("");
  const [createNewOrder, setCreateNewOrder] = useState(false);
  const [newOrderSellerId, setNewOrderSellerId] = useState("");
  const [newOrderDate, setNewOrderDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );
  const [originProductSearch, setOriginProductSearch] = useState("");
  const [historyStartDate, setHistoryStartDate] = useState(() => {
    const now = new Date();
    const start = new Date(now.getFullYear(), now.getMonth(), 1);
    return start.toISOString().slice(0, 10);
  });
  const [historyEndDate, setHistoryEndDate] = useState(() =>
    new Date().toISOString().slice(0, 10),
  );

  const sellersById = useMemo(() => {
    const map: Record<string, SellerInfo> = {};
    sellers.forEach((s) => {
      map[s.id] = s;
    });
    return map;
  }, [sellers]);

  const productsById = useMemo(() => {
    const map: Record<string, ProductInfo> = {};
    products.forEach((p) => {
      map[p.id] = p;
    });
    return map;
  }, [products]);

  const newOrderSeller = newOrderSellerId
    ? sellersById[newOrderSellerId] || null
    : null;

  const orderKeysForTransfer = useMemo(
    () => orders.map((o) => o.orderKey),
    [orders],
  );
  const ordersByKey = useMemo(() => {
    const map: Record<string, any> = {};
    orders.forEach((o) => (map[o.orderKey] = o));
    return map;
  }, [orders]);

  const rowsByRole = rows; // Ajusta si necesitas filtrar

  const rowsGroupedByOrderKey = useMemo(() => {
    const map: Record<string, T[]> = {};
    rowsByRole.forEach((row) => {
      const primaryKey = getOrderKeyForRow(row);
      const keys = new Set<string>();
      if (primaryKey) keys.add(primaryKey);
      if (row.orderId) keys.add(String(row.orderId));
      keys.add(row.id);
      keys.forEach((key) => {
        if (!map[key]) map[key] = [];
        map[key].push(row);
      });
    });
    return map;
  }, [rowsByRole]);

  const fromOrderVendorRows = useMemo(() => {
    if (!trFromOrderKey) return [];
    return rowsGroupedByOrderKey[trFromOrderKey] || [];
  }, [rowsGroupedByOrderKey, trFromOrderKey]);

  const fromOrderVendorRowsWithRemaining = useMemo(() => {
    return fromOrderVendorRows.filter((r) => {
      const remaining =
        r.remainingPackages ?? (r as any).remaining ?? r.packages ?? 0;
      return Number(remaining || 0) > 0;
    });
  }, [fromOrderVendorRows]);

  const filteredFromOrderRows = useMemo(() => {
    const q = originProductSearch.trim().toLowerCase();
    if (!q) return fromOrderVendorRowsWithRemaining;
    return fromOrderVendorRowsWithRemaining.filter((r) => {
      const haystack = `${r.category || ""} ${r.productName || ""}`
        .toLowerCase()
        .trim();
      return haystack.includes(q);
    });
  }, [fromOrderVendorRowsWithRemaining, originProductSearch]);

  const selectedFromVendorRow = useMemo(() => {
    if (!trFromVendorRowId) return null;
    return rowsByRole.find((r) => r.id === trFromVendorRowId) || null;
  }, [rowsByRole, trFromVendorRowId]);

  const originSellerId = useMemo(() => {
    if (selectedFromVendorRow?.sellerId) return selectedFromVendorRow.sellerId;
    const originOrder = ordersByKey[trFromOrderKey];
    return originOrder?.sellerId || "";
  }, [selectedFromVendorRow, ordersByKey, trFromOrderKey]);

  const toOrderVendorRows = useMemo(() => {
    if (!trToOrderKey) return [];
    return rowsGroupedByOrderKey[trToOrderKey] || [];
  }, [rowsGroupedByOrderKey, trToOrderKey]);

  const possibleToRowsForSelectedProduct = useMemo(() => {
    if (!selectedFromVendorRow) return [];
    return toOrderVendorRows.filter(
      (r) => r.productId === selectedFromVendorRow.productId,
    );
  }, [toOrderVendorRows, selectedFromVendorRow]);

  const loadTransfers = async () => {
    try {
      setTransfersLoading(true);
      let list: TransferRow[] = [];
      if (!isAdmin && sellerCandyId) {
        const qFrom = query(
          collection(db, "inventory_transfers_candies"),
          where("fromSellerId", "==", sellerCandyId),
          orderBy("createdAt", "desc"),
        );
        const qTo = query(
          collection(db, "inventory_transfers_candies"),
          where("toSellerId", "==", sellerCandyId),
          orderBy("createdAt", "desc"),
        );
        const [s1, s2] = await Promise.all([getDocs(qFrom), getDocs(qTo)]);
        const seen = new Set<string>();
        const pushSnap = (snap: any) => {
          snap.forEach((d: any) => {
            if (seen.has(d.id)) return;
            seen.add(d.id);
            const x = d.data() as any;
            list.push({
              id: d.id,
              ...x,
            });
          });
        };
        pushSnap(s1);
        pushSnap(s2);
        list.sort((a, b) => {
          const as = a.createdAt?.seconds || 0;
          const bs = b.createdAt?.seconds || 0;
          return bs - as;
        });
      } else {
        const qAll = query(
          collection(db, "inventory_transfers_candies"),
          orderBy("createdAt", "desc"),
        );
        const snap = await getDocs(qAll);
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            ...x,
          });
        });
      }
      setTransfersRows(list);
    } catch (e) {
      setMsg("❌ Error cargando traslados.");
    } finally {
      setTransfersLoading(false);
    }
  };

  useEffect(() => {
    if (open) loadTransfers();
    // eslint-disable-next-line
  }, [open]);

  const filteredTransfersRows = useMemo(() => {
    const start = parseDateInput(historyStartDate);
    const end = parseDateInput(historyEndDate, true);
    return transfersRows.filter((t) => {
      const dt = getTransferDate(t);
      if (!dt) return true;
      if (start && dt < start) return false;
      if (end && dt > end) return false;
      return true;
    });
  }, [transfersRows, historyStartDate, historyEndDate]);

  useEffect(() => {
    setOriginProductSearch("");
  }, [trFromOrderKey]);

  useEffect(() => {
    if (!createNewOrder) return;
    if (!newOrderSellerId) {
      const origin = ordersByKey[trFromOrderKey];
      if (origin?.sellerId) {
        setNewOrderSellerId(origin.sellerId);
      }
    }
    if (!newOrderDate) {
      setNewOrderDate(new Date().toISOString().slice(0, 10));
    }
  }, [
    createNewOrder,
    newOrderSellerId,
    newOrderDate,
    ordersByKey,
    trFromOrderKey,
  ]);

  const resetTransferForm = () => {
    setTrFromOrderKey("");
    setTrFromVendorRowId("");
    setTrToOrderKey("");
    setTrToVendorRowId("");
    setTrPackages("0");
    setTrComment("");
    setCreateNewOrder(false);
    setNewOrderSellerId("");
    setNewOrderDate(new Date().toISOString().slice(0, 10));
  };

  const saveTransfer = async () => {
    if (!isAdmin) {
      setMsg("No tienes permiso para hacer traslados.");
      return;
    }
    setMsg("");
    const packs = Number(trPackages || 0);
    if (!(packs > 0)) {
      setMsg("La cantidad de paquetes debe ser mayor a 0.");
      return;
    }
    if (!trComment.trim()) {
      setMsg("Debes escribir el motivo de la movida.");
      return;
    }
    if (!trFromOrderKey || !trFromVendorRowId) {
      setMsg("Selecciona el pedido origen y el producto.");
      return;
    }
    const creatingNew = createNewOrder;
    if (!creatingNew && !trToOrderKey) {
      setMsg("Selecciona el pedido destino.");
      return;
    }
    if (creatingNew) {
      if (!newOrderSellerId) {
        setMsg("Selecciona el vendedor de la nueva orden.");
        return;
      }
      if (!newOrderDate) {
        setMsg("Selecciona la fecha de la nueva orden.");
        return;
      }
    }
    const destOrderInfo =
      !creatingNew && trToOrderKey ? ordersByKey[trToOrderKey] || null : null;
    if (!creatingNew && !destOrderInfo) {
      setMsg("Selecciona un pedido destino válido.");
      return;
    }
    const destOrderSeller = destOrderInfo
      ? sellersById[destOrderInfo.sellerId] || {
          id: destOrderInfo.sellerId || "",
          name: destOrderInfo.sellerName || "",
          email: destOrderInfo.sellerEmail || "",
          branch: destOrderInfo.branch,
          branchLabel: destOrderInfo.branchLabel,
          commissionPercent:
            destOrderInfo.vendorMarginPercent ??
            destOrderInfo.commissionPercent ??
            0,
        }
      : null;

    const fromRow = rows.find((r) => r.id === trFromVendorRowId) || null;
    const toRow =
      !creatingNew && trToVendorRowId
        ? rows.find((r) => r.id === trToVendorRowId) || null
        : null;
    if (!fromRow) {
      setMsg("No se encontró la fila origen/destino.");
      return;
    }
    if (!creatingNew && toRow && trFromVendorRowId === trToVendorRowId) {
      setMsg("Origen y destino no pueden ser el mismo.");
      return;
    }
    if (!creatingNew && toRow && fromRow.productId !== toRow.productId) {
      setMsg("El producto destino no coincide con el producto origen.");
      return;
    }
    if (Number(fromRow.remainingPackages || 0) < packs) {
      setMsg("El origen no tiene suficientes paquetes disponibles.");
      return;
    }
    const newOrderSellerData = creatingNew ? newOrderSeller : null;
    if (creatingNew && !newOrderSellerData) {
      setMsg("Selecciona un vendedor destino válido.");
      return;
    }

    const productInfo = productsById[fromRow.productId] || null;
    const destBranch = creatingNew
      ? normalizeBranch(
          newOrderSellerData?.branch || newOrderSellerData?.branchLabel,
        )
      : undefined;
    const shouldCreateDestRowInExistingOrder =
      !creatingNew && !trToVendorRowId && !!destOrderInfo;
    const destRowWasNew = creatingNew || shouldCreateDestRowInExistingOrder;

    let newOrderDraft: any = null;
    let newRowForExistingOrderDraft: any = null;
    let newOrderKey = "";
    if (creatingNew && newOrderSellerData) {
      const sellerMargin = clampPercent(
        newOrderSellerData.commissionPercent ?? 0,
      );
      const branch = destBranch;
      const unitsPerPackage = Number(
        productInfo?.unitsPerPackage ?? fromRow.unitsPerPackage ?? 0,
      );
      const totalUnits = unitsPerPackage > 0 ? unitsPerPackage * packs : 0;
      const pricePerPackage = productInfo
        ? getPricePerPack(productInfo, branch)
        : Number(fromRow.unitPriceRivas || fromRow.unitPriceIsla || 0);
      const grossPerPack = productInfo
        ? getGrossProfitPerPack(productInfo, branch)
        : Number(fromRow.grossProfit || 0) / Math.max(1, fromRow.packages || 1);
      const grossProfit = grossPerPack * packs;
      const logisticAllocated = productInfo
        ? Number(productInfo.logisticAllocatedPerPack || 0) * packs
        : Number((fromRow as any).logisticAllocated || 0);
      const uApproxPerPack = productInfo
        ? getUApproxPerPack(productInfo, branch)
        : Number((fromRow as any).uAproximada || 0) /
          Math.max(1, fromRow.packages || 1);
      const uAproximada = uApproxPerPack * packs;
      const split = calcSplitFromGross(grossProfit, sellerMargin);
      const uNeta =
        Number(grossProfit || 0) -
        Number(logisticAllocated || 0) -
        Number(split.uVendor || 0);

      const totalRivas =
        (productInfo?.unitPriceRivas || fromRow.unitPriceRivas || 0) * packs;
      const totalSanJorge =
        (productInfo?.unitPriceSanJorge || fromRow.unitPriceSanJorge || 0) *
        packs;
      const totalIsla =
        (productInfo?.unitPriceIsla || fromRow.unitPriceIsla || 0) * packs;

      newOrderKey = buildOrderKey(newOrderSellerData.id, newOrderDate);

      newOrderDraft = {
        sellerId: newOrderSellerData.id,
        sellerName: newOrderSellerData.name,
        sellerEmail: newOrderSellerData.email || "",
        branch: branch || "",
        branchLabel: newOrderSellerData.branchLabel || "",
        productId: fromRow.productId,
        productName: fromRow.productName,
        category: fromRow.category,
        orderId: newOrderKey,
        date: newOrderDate,
        packages: packs,
        unitsPerPackage,
        totalUnits,
        remainingPackages: packs,
        remainingUnits: totalUnits,
        totalRivas,
        totalSanJorge,
        totalIsla,
        unitPriceRivas:
          productInfo?.unitPriceRivas || fromRow.unitPriceRivas || 0,
        unitPriceSanJorge:
          productInfo?.unitPriceSanJorge || fromRow.unitPriceSanJorge || 0,
        unitPriceIsla: productInfo?.unitPriceIsla || fromRow.unitPriceIsla || 0,
        grossProfit,
        logisticAllocated,
        vendorMarginPercent: split.vendorMarginPercent,
        uVendor: split.uVendor,
        uInvestor: split.uInvestor,
        uAproximada,
        uNeta,
        providerPrice: fromRow.providerPrice,
        transferDelta: 0,
      };
    }
    if (shouldCreateDestRowInExistingOrder && destOrderInfo) {
      const sellerMargin = clampPercent(
        destOrderSeller?.commissionPercent ??
          destOrderInfo.vendorMarginPercent ??
          0,
      );
      const branch = normalizeBranch(
        destOrderSeller?.branch ||
          destOrderSeller?.branchLabel ||
          destOrderInfo.branch ||
          destOrderInfo.branchLabel,
      );
      const unitsPerPackage = Number(
        productInfo?.unitsPerPackage ?? fromRow.unitsPerPackage ?? 0,
      );
      const totalUnits = unitsPerPackage > 0 ? unitsPerPackage * packs : 0;
      const pricePerPackage = productInfo
        ? getPricePerPack(productInfo, branch)
        : Number(fromRow.unitPriceRivas || fromRow.unitPriceIsla || 0);
      const grossPerPack = productInfo
        ? getGrossProfitPerPack(productInfo, branch)
        : Number(fromRow.grossProfit || 0) / Math.max(1, fromRow.packages || 1);
      const grossProfit = grossPerPack * packs;
      const logisticAllocated = productInfo
        ? Number(productInfo.logisticAllocatedPerPack || 0) * packs
        : Number((fromRow as any).logisticAllocated || 0);
      const uApproxPerPack = productInfo
        ? getUApproxPerPack(productInfo, branch)
        : Number((fromRow as any).uAproximada || 0) /
          Math.max(1, fromRow.packages || 1);
      const uAproximada = uApproxPerPack * packs;
      const split = calcSplitFromGross(grossProfit, sellerMargin);
      const uNeta =
        Number(grossProfit || 0) -
        Number(logisticAllocated || 0) -
        Number(split.uVendor || 0);
      const totalRivas =
        (productInfo?.unitPriceRivas || fromRow.unitPriceRivas || 0) * packs;
      const totalSanJorge =
        (productInfo?.unitPriceSanJorge || fromRow.unitPriceSanJorge || 0) *
        packs;
      const totalIsla =
        (productInfo?.unitPriceIsla || fromRow.unitPriceIsla || 0) * packs;

      newRowForExistingOrderDraft = {
        sellerId: destOrderInfo.sellerId,
        sellerName: destOrderSeller?.name || destOrderInfo.sellerName || "",
        sellerEmail: destOrderSeller?.email || destOrderInfo.sellerEmail || "",
        branch: branch || destOrderInfo.branch || "",
        branchLabel:
          destOrderSeller?.branchLabel || destOrderInfo.branchLabel || "",
        productId: fromRow.productId,
        productName: fromRow.productName,
        category: fromRow.category,
        orderId: destOrderInfo.orderKey || trToOrderKey,
        date: destOrderInfo.date || new Date().toISOString().slice(0, 10),
        packages: packs,
        unitsPerPackage,
        totalUnits,
        remainingPackages: packs,
        remainingUnits: totalUnits,
        totalRivas,
        totalSanJorge,
        totalIsla,
        unitPriceRivas:
          productInfo?.unitPriceRivas || fromRow.unitPriceRivas || 0,
        unitPriceSanJorge:
          productInfo?.unitPriceSanJorge || fromRow.unitPriceSanJorge || 0,
        unitPriceIsla: productInfo?.unitPriceIsla || fromRow.unitPriceIsla || 0,
        grossProfit,
        logisticAllocated,
        vendorMarginPercent: split.vendorMarginPercent,
        uVendor: split.uVendor,
        uInvestor: split.uInvestor,
        uAproximada,
        uNeta,
        providerPrice: fromRow.providerPrice,
        transferDelta: 0,
      };
    }
    try {
      setTrSaving(true);
      const fromRef = doc(db, "inventory_candies_sellers", fromRow.id);
      const toRef =
        creatingNew || shouldCreateDestRowInExistingOrder
          ? doc(collection(db, "inventory_candies_sellers"))
          : doc(db, "inventory_candies_sellers", toRow!.id);
      const now = Timestamp.now();
      const dateStr = new Date().toISOString().slice(0, 10);
      let newRowLocal: any = null;
      await runTransaction(db, async (tx) => {
        const fromSnap = await tx.get(fromRef);
        if (!fromSnap.exists()) throw new Error("Orden origen no existe.");
        const a = fromSnap.data() as any;
        const aRem = Number(a.remainingPackages || 0);
        if (aRem < packs)
          throw new Error("Origen no tiene suficientes paquetes.");
        let existingDestSnapshot: any = null;
        if (!creatingNew && !shouldCreateDestRowInExistingOrder) {
          const toSnap = await tx.get(toRef);
          if (!toSnap.exists()) throw new Error("Orden destino no existe.");
          existingDestSnapshot = toSnap.data();
        }
        const originUnitsPerPack = Number(
          a.unitsPerPackage || fromRow.unitsPerPackage || 0,
        );
        const unitsMovedFrom =
          originUnitsPerPack > 0 ? packs * originUnitsPerPack : 0;
        const fromTransferDelta = Number(a.transferDelta || 0);
        tx.update(fromRef, {
          // P. asociados (packages) baja cuando la orden EMITE paquetes
          packages: Math.max(0, Number(a.packages || 0) - packs),
          remainingPackages: aRem - packs,
          ...(originUnitsPerPack > 0
            ? {
                remainingUnits: Number(a.remainingUnits || 0) - unitsMovedFrom,
              }
            : {}),
          updatedAt: now,
          transferDelta: fromTransferDelta - packs,
        });
        let destSnapshot: any = null;
        if (creatingNew) {
          const payload = {
            ...newOrderDraft,
            createdAt: now,
            updatedAt: now,
            remainingPackages: packs,
            remainingUnits:
              Number(newOrderDraft?.unitsPerPackage || 0) > 0
                ? packs * Number(newOrderDraft?.unitsPerPackage || 0)
                : newOrderDraft?.remainingUnits,
            transferDelta: 0,
          };
          tx.set(toRef, payload);
          destSnapshot = payload;
          newRowLocal = { id: toRef.id, ...payload };
        } else if (
          shouldCreateDestRowInExistingOrder &&
          newRowForExistingOrderDraft
        ) {
          const payload = {
            ...newRowForExistingOrderDraft,
            createdAt: now,
            updatedAt: now,
            remainingPackages: packs,
            remainingUnits:
              Number(newRowForExistingOrderDraft.unitsPerPackage || 0) > 0
                ? packs *
                  Number(newRowForExistingOrderDraft.unitsPerPackage || 0)
                : newRowForExistingOrderDraft.remainingUnits,
            transferDelta: 0,
          };
          tx.set(toRef, payload);
          destSnapshot = payload;
          newRowLocal = { id: toRef.id, ...payload };
        } else {
          const b = existingDestSnapshot as any;
          const destUnitsPerPack = Number(
            b.unitsPerPackage || fromRow.unitsPerPackage || 0,
          );
          const unitsMoved =
            destUnitsPerPack > 0 ? packs * destUnitsPerPack : 0;
          const toTransferDelta = Number(b.transferDelta || 0);
          tx.update(toRef, {
            // P. asociados (packages) sube cuando la orden RECIBE paquetes
            packages: Math.max(0, Number(b.packages || 0) + packs),
            remainingPackages: Number(b.remainingPackages || 0) + packs,
            ...(destUnitsPerPack > 0
              ? { remainingUnits: Number(b.remainingUnits || 0) + unitsMoved }
              : {}),
            updatedAt: now,
            transferDelta: toTransferDelta + packs,
          });
          destSnapshot = {
            ...b,
            remainingPackages: Number(b.remainingPackages || 0) + packs,
            remainingUnits:
              destUnitsPerPack > 0
                ? Number(b.remainingUnits || 0) + unitsMoved
                : b.remainingUnits,
            sellerId: b.sellerId,
            sellerName: b.sellerName,
            orderId: b.orderId || toRow?.id || "",
            transferDelta: toTransferDelta + packs,
          };
        }
        const auditRef = doc(collection(db, "inventory_transfers_candies"));
        tx.set(auditRef, {
          createdAt: now,
          date: dateStr,
          createdByEmail: (currentUserEmail || "").trim(),
          createdByName: String(currentUserName || "").trim(),
          productId: String(a.productId || ""),
          productName: String(a.productName || ""),
          packagesMoved: packs,
          providerPrice: Number(a.providerPrice || 0),
          unitPriceRivas: Number(a.unitPriceRivas || 0),
          unitPriceIsla: Number(a.unitPriceIsla || 0),
          fromSellerId: String(a.sellerId || ""),
          fromSellerName: String(a.sellerName || ""),
          fromOrderKey: String(a.orderId || fromRow.id || ""),
          fromOrderLabel: String(a.orderId || fromRow.id || ""),
          toSellerId: creatingNew
            ? newOrderSellerData?.id || ""
            : String(destSnapshot?.sellerId || ""),
          toSellerName: creatingNew
            ? newOrderSellerData?.name || ""
            : String(destSnapshot?.sellerName || ""),
          toOrderKey: creatingNew
            ? newOrderKey
            : String(destSnapshot?.orderId || trToOrderKey || ""),
          toOrderLabel: creatingNew
            ? newOrderKey
            : String(destSnapshot?.orderId || trToOrderKey || ""),
          fromVendorRowId: fromRow.id,
          toVendorRowId: creatingNew
            ? toRef.id
            : shouldCreateDestRowInExistingOrder
              ? toRef.id
              : toRow!.id,
          comment: trComment.trim(),
          destRowWasNew,
        });
      });
      setRows((prev) => {
        const updated = prev.reduce<T[]>((acc, r) => {
          if (r.id === fromRow.id) {
            const upp = Number(r.unitsPerPackage || 0);
            const unitsMoved = upp > 0 ? packs * upp : 0;
            acc.push({
              ...r,
              // P. asociados baja en la orden origen
              packages: Math.max(0, Number(r.packages || 0) - packs),
              remainingPackages: Number(r.remainingPackages || 0) - packs,
              remainingUnits:
                upp > 0
                  ? Number(r.remainingUnits || 0) - unitsMoved
                  : r.remainingUnits,
              transferDelta: Number(r.transferDelta || 0) - packs,
            });
            return acc;
          }
          if (!creatingNew && toRow && r.id === toRow.id) {
            const upp = Number(r.unitsPerPackage || 0);
            const unitsMoved = upp > 0 ? packs * upp : 0;
            acc.push({
              ...r,
              // P. asociados sube en la orden destino (misma fila)
              packages: Math.max(0, Number(r.packages || 0) + packs),
              remainingPackages: Number(r.remainingPackages || 0) + packs,
              remainingUnits:
                upp > 0
                  ? Number(r.remainingUnits || 0) + unitsMoved
                  : r.remainingUnits,
              transferDelta: Number(r.transferDelta || 0) + packs,
            });
            return acc;
          }
          acc.push(r);
          return acc;
        }, []);
        if (newRowLocal) {
          return [...updated, newRowLocal];
        }
        return updated;
      });
      await loadTransfers();
      setTransferAgg((prev) => {
        const next = { ...prev };
        const fromKey = trFromOrderKey;
        const toKey = creatingNew ? newOrderKey : trToOrderKey;
        if (fromKey) {
          next[fromKey] = next[fromKey] || { out: 0, in: 0 };
          next[fromKey].out += packs;
        }
        if (toKey) {
          next[toKey] = next[toKey] || { out: 0, in: 0 };
          next[toKey].in += packs;
        }
        return next;
      });
      setTransferRowDeltas((prev) => {
        const next = { ...prev };
        if (fromRow.id) {
          next[fromRow.id] = (next[fromRow.id] || 0) - packs;
        }
        if (!destRowWasNew) {
          const destId =
            shouldCreateDestRowInExistingOrder || creatingNew
              ? newRowLocal?.id
              : toRow?.id;
          if (destId) {
            next[destId] = (next[destId] || 0) + packs;
          }
        }
        return next;
      });
      resetTransferForm();
      setMsg("✅ Traslado realizado.");
    } catch (e: any) {
      setMsg(e?.message || "❌ Error realizando el traslado.");
    } finally {
      setTrSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[55]">
      <div className="bg-white p-6 rounded shadow-lg w-full max-w-7xl max-h-[90vh] overflow-y-auto text-sm relative">
        {trSaving && (
          <div className="absolute inset-0 bg-white/70 flex items-center justify-center z-50">
            <div className="bg-white border rounded-lg px-4 py-3 shadow text-sm font-semibold">
              Guardando traslado...
            </div>
          </div>
        )}
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xl font-bold">Traslado de paquetes</h3>
          <button
            className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
            onClick={() => {
              onClose();
              resetTransferForm();
            }}
            type="button"
          >
            Cerrar
          </button>
        </div>
        {/* FORM TRASLADO */}
        <div className="border rounded p-3 bg-gray-50 mb-4">
          <div className="text-sm font-semibold mb-2">
            Crear traslado (requiere motivo)
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <label className="block text-sm font-semibold">
                Pedido origen
              </label>
              <select
                className="w-full border p-2 rounded"
                value={trFromOrderKey}
                onChange={(e) => {
                  setTrFromOrderKey(e.target.value);
                  setTrFromVendorRowId("");
                  setTrToOrderKey("");
                  setTrToVendorRowId("");
                  setTrPackages("0");
                }}
                disabled={!isAdmin}
              >
                <option value="">Selecciona…</option>
                {orderKeysForTransfer.map((k) => {
                  const o = ordersByKey[k];
                  return (
                    <option key={k} value={k}>
                      Vendedor: {o?.sellerName || "—"} — Existencias:{" "}
                      {o?.totalRemainingPackages || "0"} Paquetes - Fecha Orden:{" "}
                      {o?.date || "—"}
                    </option>
                  );
                })}
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold">
                Producto (desde el pedido origen)
              </label>
              <input
                type="text"
                className="mt-1 mb-2 w-full border p-2 rounded text-sm"
                placeholder="Buscar producto..."
                value={originProductSearch}
                onChange={(e) => setOriginProductSearch(e.target.value)}
                disabled={!isAdmin || !trFromOrderKey}
              />
              <select
                className="w-full border p-2 rounded"
                value={trFromVendorRowId}
                onChange={(e) => {
                  setTrFromVendorRowId(e.target.value);
                  setTrToOrderKey("");
                  setTrToVendorRowId("");
                  setTrPackages("0");
                }}
                disabled={!isAdmin || !trFromOrderKey}
              >
                <option value="">Selecciona…</option>
                {filteredFromOrderRows.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.productName} — Existencias:{" "}
                    {Number(r.remainingPackages ?? r.packages ?? 0)} Paquetes -
                    Precio Costo: ${r.providerPrice}
                  </option>
                ))}
              </select>
            </div>
            {!createNewOrder && (
              <>
                <div>
                  <label className="block text-sm font-semibold">
                    Pedido destino
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={trToOrderKey}
                    onChange={(e) => {
                      setTrToOrderKey(e.target.value);
                      setTrToVendorRowId("");
                    }}
                    disabled={!isAdmin || !trFromVendorRowId}
                  >
                    <option value="">Selecciona…</option>
                    {orderKeysForTransfer
                      .filter((k) => k !== trFromOrderKey)
                      .map((k) => {
                        const o = ordersByKey[k];
                        return (
                          <option key={k} value={k}>
                            Vendedor: {o?.sellerName || "—"} — Existencias:{" "}
                            {o?.totalRemainingPackages || "0"} - Fecha Orden:{" "}
                            {o?.date || "—"}
                          </option>
                        );
                      })}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Producto destino (mismo producto)
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={trToVendorRowId}
                    onChange={(e) => setTrToVendorRowId(e.target.value)}
                    disabled={
                      !isAdmin || !trToOrderKey || !selectedFromVendorRow
                    }
                  >
                    <option value="">Selecciona…</option>
                    {possibleToRowsForSelectedProduct.map((r) => (
                      <option key={r.id} value={r.id}>
                        Tipo: {r.category} - {r.productName} — Existencias:{" "}
                        {Number(r.remainingPackages ?? r.packages ?? 0)}
                        Paquetes - Precio Costo: ${r.providerPrice}
                      </option>
                    ))}
                  </select>
                  {trToOrderKey &&
                    selectedFromVendorRow &&
                    possibleToRowsForSelectedProduct.length === 0 && (
                      <div className="text-xs text-red-600 mt-1">
                        ⚠️ El pedido destino no tiene este producto. Si dejas
                        este campo vacío se creará automáticamente al moverlo.
                      </div>
                    )}
                  {trToOrderKey && (
                    <div className="text-xs text-gray-500 mt-1">
                      Este campo es opcional; úsalo solo si el pedido ya tiene
                      el producto y quieres sumar a esa fila.
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={createNewOrder}
                onChange={(e) => {
                  const next = e.target.checked;
                  setCreateNewOrder(next);
                  if (next) {
                    setTrToOrderKey("");
                    setTrToVendorRowId("");
                  }
                }}
                disabled={!isAdmin}
              />
              <span className="text-sm font-semibold">
                Crear nueva orden destino (independiente)
              </span>
            </div>
            {createNewOrder && (
              <>
                <div>
                  <label className="block text-sm font-semibold">
                    Vendedor destino (nueva orden)
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={newOrderSellerId}
                    onChange={(e) => setNewOrderSellerId(e.target.value)}
                    disabled={!isAdmin}
                  >
                    <option value="">Selecciona…</option>
                    {sellers.map((s) => (
                      <option
                        key={s.id}
                        value={s.id}
                        disabled={s.id === originSellerId}
                      >
                        {s.name}
                        {s.id === originSellerId ? " (origen)" : ""}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Fecha de la nueva orden
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={newOrderDate}
                    onChange={(e) => setNewOrderDate(e.target.value)}
                    disabled={!isAdmin}
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    Esta orden será independiente. Asegúrate de usar una fecha
                    que no tenga otro pedido activo para el mismo vendedor.
                  </div>
                </div>
              </>
            )}
            <div>
              <label className="block text-sm font-semibold">
                Cantidad paquetes a mover
              </label>
              <input
                type="number"
                min={0}
                className="w-full border p-2 rounded"
                value={trPackages}
                onChange={(e) => setTrPackages(e.target.value)}
                disabled={
                  !isAdmin ||
                  !trFromVendorRowId ||
                  (!createNewOrder && !trToOrderKey)
                }
              />
            </div>
            <div className="md:col-span-2">
              <label className="block text-sm font-semibold">
                Motivo de movida (obligatorio)
              </label>
              <textarea
                className="w-full border p-2 rounded resize-y min-h-20"
                value={trComment}
                onChange={(e) => setTrComment(e.target.value)}
                disabled={!isAdmin}
                placeholder="Ej: Se cambió de ruta por reorganización"
                maxLength={250}
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-3">
            <button
              type="button"
              className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300 disabled:opacity-60"
              onClick={resetTransferForm}
              disabled={!isAdmin || trSaving}
            >
              Limpiar
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-60"
              onClick={saveTransfer}
              disabled={
                !isAdmin ||
                trSaving ||
                !trFromVendorRowId ||
                (!createNewOrder && !trToOrderKey) ||
                Number(trPackages || 0) <= 0 ||
                !trComment.trim()
              }
            >
              Hacer traslado
            </button>
          </div>
          {msg && <div className="text-sm text-red-600 mt-2">{msg}</div>}
        </div>
        {/* HISTORIAL */}
        <div className="bg-white rounded border overflow-x-auto">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between p-2">
            <div className="text-lg font-semibold">Historial de traslados</div>
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-gray-600">Desde</span>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={historyStartDate}
                onChange={(e) => setHistoryStartDate(e.target.value)}
              />
              <span className="text-gray-600">Hasta</span>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={historyEndDate}
                onChange={(e) => setHistoryEndDate(e.target.value)}
              />
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={loadTransfers}
                disabled={transfersLoading}
                type="button"
              >
                {transfersLoading ? "Cargando..." : "Recargar"}
              </button>
            </div>
          </div>
          <table className="min-w-[1400px] text-xs md:text-sm">
            <thead className="bg-gray-100">
              <tr className="whitespace-nowrap">
                <th className="p-2 border">Fecha y hora</th>
                <th className="p-2 border">Usuario</th>
                <th className="p-2 border">Producto</th>
                <th className="p-2 border">Cantidad paquetes</th>
                <th className="p-2 border">Precio proveedor</th>
                <th className="p-2 border">Precio Rivas</th>
                <th className="p-2 border">Precio Isla</th>
                <th className="p-2 border">Desde vendedor</th>
                <th className="p-2 border">Desde orden</th>
                <th className="p-2 border">Hacia vendedor</th>
                <th className="p-2 border">Hacia orden</th>
                <th className="p-2 border">Motivo de movida</th>
              </tr>
            </thead>
            <tbody>
              {transfersLoading ? (
                <tr>
                  <td colSpan={12} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : filteredTransfersRows.length === 0 ? (
                <tr>
                  <td colSpan={12} className="p-4 text-center">
                    Sin traslados
                  </td>
                </tr>
              ) : (
                filteredTransfersRows.map((t) => {
                  const dt =
                    t.createdAt?.toDate?.() ||
                    (t.createdAt ? new Date(t.createdAt.seconds * 1000) : null);
                  const dtLabel = dt
                    ? `${dt.toISOString().slice(0, 10)} ${dt.toISOString().slice(11, 19)}`
                    : t.date || "—";
                  const userLabel =
                    (t.createdByName || "").trim() ||
                    (t.createdByEmail || "").trim() ||
                    "—";
                  return (
                    <tr key={t.id} className="text-center whitespace-nowrap">
                      <td className="p-2 border">{dtLabel}</td>
                      <td className="p-2 border">{userLabel}</td>
                      <td className="p-2 border text-left">
                        {t.productName || "—"}
                      </td>
                      <td className="p-2 border">
                        {Number(t.packagesMoved || 0)}
                      </td>
                      <td className="p-2 border">
                        {money(t.providerPrice || 0)}
                      </td>
                      <td className="p-2 border">
                        {money(t.unitPriceRivas || 0)}
                      </td>
                      <td className="p-2 border">
                        {money(t.unitPriceIsla || 0)}
                      </td>
                      <td className="p-2 border">{t.fromSellerName || "—"}</td>
                      <td className="p-2 border">
                        {t.fromOrderLabel || t.fromOrderKey || "—"}
                      </td>
                      <td className="p-2 border">{t.toSellerName || "—"}</td>
                      <td className="p-2 border">
                        {t.toOrderLabel || t.toOrderKey || "—"}
                      </td>
                      <td className="p-2 border text-left">
                        {t.comment || "—"}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
        <div className="text-xs text-gray-500 mt-2">
          Nota: el traslado mueve EXISTENCIA (remainingPackages/remainingUnits)
          del pedido origen al destino.
        </div>
      </div>
    </div>
  );
}
