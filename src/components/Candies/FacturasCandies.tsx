// src/components/Candies/InvoiceCandiesModal.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  addDoc,
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { format } from "date-fns";

type SellerCandy = {
  id: string;
  name: string;
  email?: string;
  commissionPercent?: number;
};

const safeNum = (v: any): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const pad2 = (n: number) => (n < 10 ? `0${n}` : String(n));
const toYMD = (d: Date) =>
  `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

function normalizeDate(v: any): string | null {
  if (v == null) return null;
  try {
    if (typeof v === "object" && typeof (v as any).toDate === "function") {
      v = (v as any).toDate();
    }
    if (typeof v === "number") v = new Date(v);
    if (typeof v === "string") {
      // already yyyy-MM-dd
      if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
      const parsed = new Date(v);
      if (!isNaN(parsed.getTime())) return toYMD(parsed);
      return null;
    }
    if (v instanceof Date && !isNaN(v.getTime())) return toYMD(v);
  } catch (e) {
    return null;
  }
  return null;
}

function todayStr(): string {
  return toYMD(new Date());
}

function firstDayOfMonth(): string {
  const d = new Date();
  return toYMD(new Date(d.getFullYear(), d.getMonth(), 1));
}

const qty3 = (n: any) => Number(n ?? 0).toFixed(3);
const money = (n: any) => Number(n ?? 0).toFixed(2);

function pickVendorName(data: any): string {
  return (
    data.vendorName || data.sellerName || data.vendor || data.seller || "—"
  );
}

type CandyTransaction = {
  id: string;
  date: string | null; // yyyy-MM-dd or null when unknown
  productId?: string | null;
  productName: string;
  vendorName: string;
  sellerEmail?: string | null;
  packages: number;
  amount: number;
  cogsAmount: number;
  commissionUvPack?: number; // comisión UV x paquete
  // fecha y hora de registro (ISO o formato legible)
  registeredAt?: string | null;
  uNetaPorPaquete?: number;
  // Ganancia total del vendedor (si viene en la venta)
  vendorGain?: number;
};

type Expense = {
  id: string;
  date?: string;
  description?: string;
  amount?: number;
};

type Adjustment = {
  id: string;
  description: string;
  type: "DEBITO" | "CREDITO";
  amount: number;
};

function pickSellerEmail(data: any): string | null {
  return (
    data.sellerEmail ||
    data.vendorEmail ||
    data.email ||
    data.createdByEmail ||
    null
  );
}

function extractCandyTransactionsFromDoc(
  docId: string,
  data: any,
): CandyTransaction[] {
  const baseDate =
    normalizeDate(data.date) ||
    normalizeDate(data.processedDate) ||
    normalizeDate(data.closureDate) ||
    normalizeDate(data.createdAt);

  function extractRegisteredAt(obj: any): string {
    const cand =
      obj?.registeredAt || obj?.createdAt || obj?.timestamp || obj?.processedAt;
    if (!cand) return format(new Date(), "yyyy-MM-dd HH:mm");
    try {
      let d: any = cand;
      if (typeof d === "object" && typeof d.toDate === "function")
        d = d.toDate();
      if (typeof d === "number") d = new Date(d);
      if (typeof d === "string") {
        const parsed = new Date(d);
        if (!isNaN(parsed.getTime())) return format(parsed, "yyyy-MM-dd HH:mm");
        return d;
      }
      if (d instanceof Date && !isNaN(d.getTime()))
        return format(d, "yyyy-MM-dd HH:mm");
    } catch (e) {
      return format(new Date(), "yyyy-MM-dd HH:mm");
    }
    return format(new Date(), "yyyy-MM-dd HH:mm");
  }

  // Caso 1: documento ya representa una sola venta
  const hasDirectProduct =
    data.productName ||
    data.productId ||
    data.packages != null ||
    data.amount != null;

  if (hasDirectProduct) {
    const packages =
      safeNum(data.packages) ||
      safeNum(data.quantity) ||
      safeNum(data.totalPackages) ||
      0;

    const amount =
      safeNum(data.amount) ||
      safeNum(data.total) ||
      safeNum(data.itemsTotal) ||
      safeNum(data.totalSale) ||
      0;

    const cogsAmount =
      safeNum(data.cogsAmount) ||
      safeNum(data.totalProvider) ||
      safeNum(data.providerTotal) ||
      safeNum(data.subtotal) ||
      0;

    const explicitCommissionUvPack =
      safeNum(data.commissionUvPack) ||
      safeNum(data.uvXpaq) ||
      safeNum(data.unitPriceVendor);

    let derivedCommissionUvPack = explicitCommissionUvPack;
    if (!derivedCommissionUvPack) {
      const vendorCommissionAmount = safeNum(data.vendorCommissionAmount);
      if (vendorCommissionAmount > 0 && packages > 0) {
        derivedCommissionUvPack = vendorCommissionAmount / packages;
      }
    }

    return [
      {
        id: docId,
        date: baseDate,
        registeredAt: extractRegisteredAt(data),
        productId: data.productId || null,
        productName: data.productName || data.name || "—",
        vendorName: pickVendorName(data),
        sellerEmail: pickSellerEmail(data),
        packages,
        amount,
        cogsAmount,
        commissionUvPack: Number(derivedCommissionUvPack.toFixed(4)),
        vendorGain:
          safeNum(data.vendorGain) ||
          safeNum(data.vendorCommissionAmount) ||
          safeNum((derivedCommissionUvPack || 0) * packages),
        uNetaPorPaquete:
          safeNum(data.uNetaPorPaquete) ||
          safeNum(data.unitNetPerPack) ||
          safeNum(data.netPerPack) ||
          0,
      },
    ];
  }

  // Caso 2: documento tipo cierre o venta compuesta con items[]
  if (Array.isArray(data.items) && data.items.length > 0) {
    return data.items.map((it: any, idx: number) => {
      const packages =
        safeNum(it.packages) ||
        safeNum(it.quantity) ||
        safeNum(it.totalPackages) ||
        0;

      const amount =
        safeNum(it.amount) ||
        safeNum(it.total) ||
        safeNum(it.totalSale) ||
        safeNum(it.itemsTotal) ||
        safeNum(it.totalVendor) ||
        0;

      const cogsAmount =
        safeNum(it.cogsAmount) ||
        safeNum(it.totalProvider) ||
        safeNum(it.providerTotal) ||
        safeNum(it.subtotal) ||
        0;

      const explicitCommissionUvPack =
        safeNum(it.commissionUvPack) ||
        safeNum(it.uvXpaq) ||
        safeNum(it.unitPriceVendor);

      let derivedCommissionUvPack = explicitCommissionUvPack;
      if (!derivedCommissionUvPack) {
        const vendorCommissionAmount = safeNum(it.vendorCommissionAmount);
        if (vendorCommissionAmount > 0 && packages > 0) {
          derivedCommissionUvPack = vendorCommissionAmount / packages;
        }
      }

      return {
        id: `${docId}_${it.productId || it.id || idx}`,
        date: normalizeDate(it.date) || normalizeDate(it.saleDate) || baseDate,
        registeredAt: extractRegisteredAt(it) || extractRegisteredAt(data),
        productId: it.productId || it.id || null,
        productName: it.productName || it.name || "—",
        vendorName:
          it.vendorName ||
          it.sellerName ||
          data.vendorName ||
          data.sellerName ||
          "—",
        sellerEmail:
          it.sellerEmail ||
          it.vendorEmail ||
          data.sellerEmail ||
          data.vendorEmail ||
          null,
        packages,
        amount,
        cogsAmount,
        commissionUvPack: Number(derivedCommissionUvPack.toFixed(4)),
        vendorGain:
          safeNum(it.vendorGain) ||
          safeNum(it.vendorCommissionAmount) ||
          safeNum((derivedCommissionUvPack || 0) * packages),
        uNetaPorPaquete:
          safeNum(it.uNetaPorPaquete) ||
          safeNum(it.unitNetPerPack) ||
          safeNum(it.netPerPack) ||
          0,
      };
    });
  }

  return [];
}

export default function InvoiceCandiesModal({
  transactions = [],
  onClose,
  onCreated,
}: {
  transactions?: CandyTransaction[];
  onClose: () => void;
  onCreated: () => void;
}) {
  // ========= Catálogo de vendedores =========
  const [sellers, setSellers] = useState<SellerCandy[]>([]);
  const sellersByEmail = useMemo(() => {
    const m: Record<string, SellerCandy> = {};
    sellers.forEach((s) => {
      if (s.email) {
        m[s.email.trim().toLowerCase()] = s;
      }
    });
    return m;
  }, [sellers]);

  useEffect(() => {
    (async () => {
      try {
        const qy = query(
          collection(db, "sellers_candies"),
          orderBy("name", "asc"),
        );
        const snap = await getDocs(qy);
        const rows: SellerCandy[] = [];
        snap.forEach((d) => {
          const it = d.data() as any;
          rows.push({
            id: d.id,
            name: it.name || "",
            email: it.email || "",
            commissionPercent: Number(it.commissionPercent || 0),
          });
        });
        setSellers(rows);
      } catch (e) {
        console.error(e);
      }
    })();
  }, []);

  // ========= Filtros de transacciones =========
  const [txFrom, setTxFrom] = useState<string>(firstDayOfMonth());
  const [txTo, setTxTo] = useState<string>(todayStr());
  const [productFilter, setProductFilter] = useState<string>("");
  const [sellerFilter, setSellerFilter] = useState<string>("");

  // ========= Carga de ventas desde Firestore =========
  const [dbTransactions, setDbTransactions] = useState<CandyTransaction[]>([]);
  const [loadingTx, setLoadingTx] = useState<boolean>(false);
  const lastTxSignature = useRef<string>("");

  useEffect(() => {
    // compute signature of incoming prop to avoid reacting to reference-only changes
    const signature = Array.isArray(transactions)
      ? transactions
          .map(
            (t: any) =>
              `${t.id || ""}:${normalizeDate(t.date || t.createdAt || t)}`,
          )
          .sort()
          .join("|") + `::${txFrom}::${txTo}`
      : `::${txFrom}::${txTo}`;
    if (signature === lastTxSignature.current) {
      return; // nothing meaningful changed
    }
    lastTxSignature.current = signature;
    (async () => {
      try {
        setLoadingTx(true);

        const candidateCollections = [
          "sales_candies",
          "salesCandies",
          "candy_sales",
          "closures_candies",
          "candy_closures",
        ];

        const allRows: CandyTransaction[] = [];

        for (const colName of candidateCollections) {
          try {
            let snap;
            if (txFrom && txTo) {
              const qy = query(
                collection(db, colName),
                where("date", ">=", txFrom),
                where("date", "<=", txTo),
                orderBy("date", "desc"),
              );
              snap = await getDocs(qy);
            } else {
              const qy = query(
                collection(db, colName),
                orderBy("date", "desc"),
              );
              snap = await getDocs(qy);
            }

            snap.forEach((d) => {
              const data = d.data() as any;
              const rows = extractCandyTransactionsFromDoc(d.id, data);
              rows.forEach((r) => {
                if (!r.date) return;
                if (txFrom && r.date < txFrom) return;
                if (txTo && r.date > txTo) return;
                allRows.push(r);
              });
            });
          } catch (e) {
            console.warn(`No se pudo leer ${colName}`, e);
          }
        }

        // Mezclar con transactions recibidas por prop
        const propRows: CandyTransaction[] = Array.isArray(transactions)
          ? transactions.map((t) => ({
              ...t,
              commissionUvPack: Number(
                safeNum(
                  t.commissionUvPack ||
                    (safeNum((t as any).vendorCommissionAmount) > 0 &&
                    safeNum(t.packages) > 0
                      ? safeNum((t as any).vendorCommissionAmount) /
                        safeNum(t.packages)
                      : 0),
                ).toFixed(4),
              ),
              vendorGain:
                safeNum(t.vendorGain) ||
                safeNum((t as any).vendorCommissionAmount) ||
                safeNum((t.commissionUvPack || 0) * (t.packages || 0)),
              registeredAt:
                t.registeredAt ||
                (t.createdAt
                  ? typeof (t as any).createdAt.toDate === "function"
                    ? format((t as any).createdAt.toDate(), "yyyy-MM-dd HH:mm")
                    : format(new Date((t as any).createdAt), "yyyy-MM-dd HH:mm")
                  : null),
            }))
          : [];

        const map = new Map<string, CandyTransaction>();

        [...allRows, ...propRows].forEach((r) => {
          if (!r?.id) return;
          map.set(r.id, {
            ...r,
            date: normalizeDate(r.date),
            productName: r.productName || "—",
            vendorName: r.vendorName || "—",
            packages: safeNum(r.packages),
            amount: safeNum(r.amount),
            cogsAmount: safeNum(r.cogsAmount),
            commissionUvPack: Number(safeNum(r.commissionUvPack).toFixed(4)),
            uNetaPorPaquete: Number(safeNum(r.uNetaPorPaquete).toFixed(4)),
            vendorGain: Number(safeNum(r.vendorGain).toFixed(2)),
          });
        });

        const normalized = Array.from(map.values())
          .filter((r): r is CandyTransaction & { date: string } => {
            if (!r.date) return false;
            if (txFrom && r.date < txFrom) return false;
            if (txTo && r.date > txTo) return false;
            return true;
          })
          .sort((a, b) => {
            if (a.date === b.date)
              return a.productName.localeCompare(b.productName);
            return a.date < b.date ? 1 : -1;
          });

        // debug: log sample of normalized rows and their uNetaPorPaquete
        try {
          console.debug(
            "InvoiceCandiesModal: normalized sample (uNetaPorPaquete, vendorGain)=",
            normalized.slice(0, 6).map((x) => ({
              id: x.id,
              date: x.date,
              uNetaPorPaquete: x.uNetaPorPaquete,
              vendorGain: x.vendorGain,
            })),
          );
        } catch (e) {
          console.debug(e);
        }

        setDbTransactions((prev) => {
          const next = normalized;
          if (
            prev.length === next.length &&
            prev.every((p, i) => p.id === next[i].id && p.date === next[i].date)
          ) {
            return prev;
          }
          return next;
        });
      } catch (e) {
        console.error(e);
        setDbTransactions([]);
      } finally {
        setLoadingTx(false);
      }
    })();
  }, [transactions, txFrom, txTo]);

  const safeTx = useMemo(() => dbTransactions, [dbTransactions]);

  const productOptions = useMemo(() => {
    const m = new Map<string, { key: string; name: string }>();
    safeTx.forEach((t) => {
      const key = String(t.productId ?? t.productName ?? "");
      const name = t.productName || (t.productId ? String(t.productId) : "—");
      if (!m.has(key)) m.set(key, { key, name });
    });
    return Array.from(m.values())
      .filter((x) => x.name && x.name !== "")
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [safeTx]);

  const sellerOptions = useMemo(() => {
    const m = new Map<string, { value: string; label: string }>();
    safeTx.forEach((t) => {
      const email = (t.sellerEmail || "").trim().toLowerCase();
      if (email) {
        const seller = sellersByEmail[email];
        const label = seller?.name || t.vendorName || email;
        m.set(email, { value: email, label });
      } else {
        const vendor = (t.vendorName || "").trim();
        if (vendor) m.set(`vendor:${vendor}`, { value: vendor, label: vendor });
      }
    });
    return Array.from(m.values()).sort((a, b) =>
      a.label.localeCompare(b.label),
    );
  }, [safeTx, sellersByEmail]);

  const filteredTx = useMemo(() => {
    return safeTx.filter((t) => {
      if (!t.date) return false;
      if (txFrom && t.date < txFrom) return false;
      if (txTo && t.date > txTo) return false;

      if (productFilter) {
        const prodName = (t.productName || "").trim();
        const prodId = String(t.productId || "");
        if (prodName !== productFilter && prodId !== productFilter)
          return false;
      }

      if (sellerFilter) {
        const email = (t.sellerEmail || "").trim().toLowerCase();
        const vendor = (t.vendorName || "").trim();
        if (email !== sellerFilter && vendor !== sellerFilter) return false;
      }

      return true;
    });
  }, [safeTx, txFrom, txTo, productFilter, sellerFilter]);

  // ========= Datos de factura =========
  const [invoiceDate, setInvoiceDate] = useState<string>(todayStr());
  const [invoiceNumber, setInvoiceNumber] = useState<string>(
    () => `FAC-CANDY-${Date.now().toString().slice(-6)}`,
  );
  const [description, setDescription] = useState<string>("");

  const [branchFactorPercent, setBranchFactorPercent] = useState<string>("0");

  // ========= Selección de ventas =========
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => {
    setSelectedIds([]);
  }, [txFrom, txTo, productFilter, sellerFilter]);

  // ========= Gastos =========
  const [expenses, setExpenses] = useState<Expense[]>([]);
  const [selectedExpenseIds, setSelectedExpenseIds] = useState<string[]>([]);
  const [loadingExpenses, setLoadingExpenses] = useState<boolean>(false);
  const [expFrom, setExpFrom] = useState<string>(firstDayOfMonth());
  const [expTo, setExpTo] = useState<string>(todayStr());

  useEffect(() => {
    (async () => {
      try {
        setLoadingExpenses(true);
        const qy = query(
          collection(db, "expensesCandies"),
          orderBy("date", "desc"),
        );
        const snap = await getDocs(qy);
        const rows: Expense[] = [];
        snap.forEach((d) => {
          const it = d.data() as any;
          rows.push({
            id: d.id,
            date: it.date,
            description: it.description,
            amount: Number(it.amount || 0),
          });
        });
        setExpenses(rows);
      } catch (e) {
        console.error(e);
      } finally {
        setLoadingExpenses(false);
      }
    })();
  }, []);

  const filteredExpenses = useMemo(() => {
    return expenses.filter((g) => {
      if (!g.date) return false;
      if (expFrom && g.date < expFrom) return false;
      if (expTo && g.date > expTo) return false;
      return true;
    });
  }, [expenses, expFrom, expTo]);

  // ========= Ajustes =========
  const [adjustments, setAdjustments] = useState<Adjustment[]>([]);
  const [openAdjModal, setOpenAdjModal] = useState<boolean>(false);
  const [adjDesc, setAdjDesc] = useState<string>("");
  const [adjType, setAdjType] = useState<"DEBITO" | "CREDITO">("DEBITO");
  const [adjAmount, setAdjAmount] = useState<string>("");

  const addAdjustment = () => {
    const amt = Number(adjAmount);
    if (!adjDesc.trim() || !isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) => [
      ...prev,
      {
        id: `${Date.now()}_${prev.length + 1}`,
        description: adjDesc.trim(),
        type: adjType,
        amount: Number(amt.toFixed(2)),
      },
    ]);
    setAdjDesc("");
    setAdjAmount("");
    setOpenAdjModal(false);
  };

  const [editingAdjId, setEditingAdjId] = useState<string | null>(null);
  const [editAdjDesc, setEditAdjDesc] = useState<string>("");
  const [editAdjType, setEditAdjType] = useState<"DEBITO" | "CREDITO">(
    "DEBITO",
  );
  const [editAdjAmount, setEditAdjAmount] = useState<string>("");

  const beginEditAdjustment = (a: Adjustment) => {
    setEditingAdjId(a.id);
    setEditAdjDesc(a.description);
    setEditAdjType(a.type);
    setEditAdjAmount(a.amount.toFixed(2));
  };
  const cancelEditAdjustment = () => {
    setEditingAdjId(null);
    setEditAdjDesc("");
    setEditAdjType("DEBITO");
    setEditAdjAmount("");
  };
  const saveEditAdjustment = () => {
    if (!editingAdjId) return;
    const amt = Number(editAdjAmount);
    if (!isFinite(amt) || amt <= 0) return;
    setAdjustments((prev) =>
      prev.map((x) =>
        x.id === editingAdjId
          ? {
              ...x,
              description: editAdjDesc.trim(),
              type: editAdjType,
              amount: Number(amt.toFixed(2)),
            }
          : x,
      ),
    );
    cancelEditAdjustment();
  };
  const removeAdjustment = (id: string) => {
    setAdjustments((prev) => prev.filter((x) => x.id !== id));
    if (editingAdjId === id) cancelEditAdjustment();
  };

  // ========= Selección =========
  const toggleTx = (id: string, checked: boolean) => {
    setSelectedIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  };

  const selectAllTx = (checked: boolean) => {
    setSelectedIds(checked ? filteredTx.map((t) => t.id) : []);
  };

  const toggleExpense = (id: string, checked: boolean) => {
    setSelectedExpenseIds((prev) =>
      checked ? [...new Set([...prev, id])] : prev.filter((x) => x !== id),
    );
  };

  // ========= Cálculos =========
  const selectedTx = useMemo(
    () => filteredTx.filter((t) => selectedIds.includes(t.id)),
    [filteredTx, selectedIds],
  );

  const debitsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "DEBITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments],
  );

  const creditsSum = useMemo(
    () =>
      adjustments
        .filter((a) => a.type === "CREDITO")
        .reduce((s, a) => s + a.amount, 0),
    [adjustments],
  );

  const totals = useMemo(() => {
    let totalPackages = 0;
    let totalProvider = 0;
    let totalSale = 0;
    let totalCommissionVendors = 0;
    let totalCommissionUvPack = 0;
    let totalSelectedSales = 0;

    for (const t of selectedTx) {
      const packs = safeNum(t.packages);
      const providerTotal = safeNum(t.cogsAmount);
      const saleTotal = safeNum(t.amount);

      totalPackages += packs;
      totalProvider += providerTotal;
      totalSale += saleTotal;
      totalSelectedSales += 1;

      const email = (t.sellerEmail || "").trim().toLowerCase();
      const seller = sellersByEmail[email];
      const commissionPercent = Number(seller?.commissionPercent || 0);
      const lineCommission = (saleTotal * commissionPercent) / 100;
      totalCommissionVendors += lineCommission;

      totalCommissionUvPack += safeNum(t.commissionUvPack) * packs;
    }

    // total net computed from the U. Neta/paq column (sum of the column values)
    let totalNetFromUNeta = 0;
    for (const t of selectedTx) {
      totalNetFromUNeta += safeNum(t.uNetaPorPaquete);
    }

    const totalGastos = filteredExpenses
      .filter((g) => selectedExpenseIds.includes(g.id))
      .reduce((a, g) => a + Number(g.amount || 0), 0);

    const grossProfit = totalSale - totalProvider;
    const finalAmount =
      totalSale -
      totalGastos -
      debitsSum +
      creditsSum -
      totalCommissionVendors -
      totalCommissionUvPack;

    const branchFactor = Number(branchFactorPercent || 0);
    // Branch profit = sum(uNetaPorPaquete * packages) * factor%
    const branchProfit = (totalNetFromUNeta * branchFactor) / 100;

    return {
      totalSelectedSales,
      totalPackages: Number(qty3(totalPackages)),
      totalProvider: Number(totalProvider.toFixed(2)),
      totalSale: Number(totalSale.toFixed(2)),
      totalGastos: Number(totalGastos.toFixed(2)),
      debits: Number(debitsSum.toFixed(2)),
      credits: Number(creditsSum.toFixed(2)),
      grossProfit: Number(grossProfit.toFixed(2)),
      finalAmount: Number(finalAmount.toFixed(2)),
      totalCommissionVendors: Number(totalCommissionVendors.toFixed(2)),
      totalCommissionUvPack: Number(totalCommissionUvPack.toFixed(2)),
      totalNetFromUNeta: Number(totalNetFromUNeta.toFixed(2)),
      branchProfit: Number(branchProfit.toFixed(2)),
      branchFactor,
    };
  }, [
    selectedTx,
    filteredExpenses,
    selectedExpenseIds,
    debitsSum,
    creditsSum,
    sellersByEmail,
    branchFactorPercent,
  ]);

  // ========= Guardar =========
  const [creating, setCreating] = useState<boolean>(false);
  const [msg, setMsg] = useState<string>("");

  const createInvoice = async () => {
    setMsg("");

    if (selectedTx.length === 0) {
      setMsg("Selecciona al menos 1 venta de dulces.");
      return;
    }

    try {
      setCreating(true);

      const invoicePayload = {
        number: invoiceNumber.trim(),
        date: invoiceDate,
        description: description.trim(),
        status: "PENDIENTE" as const,
        createdAt: Timestamp.now(),

        totalSalesCount: totals.totalSelectedSales,
        totalPackages: totals.totalPackages,
        totalProvider: totals.totalProvider,
        totalSale: totals.totalSale,
        totalExpenses: totals.totalGastos,
        totalDebits: totals.debits,
        totalCredits: totals.credits,
        grossProfit: totals.grossProfit,
        totalCommissionVendors: totals.totalCommissionVendors,
        totalCommissionUvPack: totals.totalCommissionUvPack,
        // suma directa de la columna U. Neta (por fila)
        totalNetFromUNeta: totals.totalNetFromUNeta,
        // final antes de restar comisión UV (para trazabilidad)
        finalAmountBeforeUvCommission: Number(
          (totals.finalAmount + totals.totalCommissionUvPack).toFixed(2),
        ),
        branchFactorPercent: totals.branchFactor,
        branchProfit: totals.branchProfit,
        finalAmount: totals.finalAmount,

        transactions: selectedTx.map((t) => {
          const packs = Number(t.packages || 0) || 1;
          const providerTotal = Number(t.cogsAmount || 0);
          const saleTotal = Number(t.amount || 0);

          const providerPricePack = providerTotal / packs;
          const salePricePack = saleTotal / packs;

          const email = (t.sellerEmail || "").trim().toLowerCase();
          const seller = sellersByEmail[email];
          const commissionPercent = Number(seller?.commissionPercent || 0);
          const commissionAmount = (saleTotal * commissionPercent) / 100;

          return {
            id: t.id,
            date: t.date,
            productId: t.productId || null,
            productName: t.productName,
            vendorName: t.vendorName,
            sellerEmail: t.sellerEmail || null,
            packages: Number(qty3(t.packages)),
            providerPricePack: Number(providerPricePack.toFixed(4)),
            salePricePack: Number(salePricePack.toFixed(4)),
            totalProvider: Number(providerTotal.toFixed(2)),
            totalSale: Number(saleTotal.toFixed(2)),
            commissionPercent,
            commissionAmount: Number(commissionAmount.toFixed(2)),
            commissionUvPack: Number(safeNum(t.commissionUvPack).toFixed(4)),
          };
        }),

        expenses: filteredExpenses
          .filter((g) => selectedExpenseIds.includes(g.id))
          .map((g) => ({
            id: g.id,
            date: g.date || null,
            description: g.description || "",
            amount: Number(Number(g.amount || 0).toFixed(2)),
          })),

        adjustments: adjustments.map((a) => ({
          id: a.id,
          description: a.description,
          type: a.type,
          amount: Number(a.amount.toFixed(2)),
        })),
      };

      await addDoc(collection(db, "invoicesCandies"), invoicePayload);

      setMsg("✅ Factura de dulces creada.");
      onCreated();
    } catch (e: any) {
      console.error(e);
      setMsg(`❌ Error al crear factura: ${e?.message || "desconocido"}`);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[9999] bg-black/40 flex items-center justify-center p-3">
      <div className="bg-white w-[96vw] max-w-[96vw] rounded-xl shadow-xl p-4 md:p-6 max-h-[90vh] overflow-auto relative">
        <div className="flex items-center gap-3 mb-4">
          <h3 className="text-lg font-semibold">Crear factura CandyShop</h3>
          <button
            onClick={onClose}
            className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
          >
            Cerrar
          </button>
        </div>

        {/* Datos de factura */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mb-4">
          <div>
            <label className="block text-sm font-medium">Fecha</label>
            <input
              type="date"
              className="w-full border rounded px-2 py-1"
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Número</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={invoiceNumber}
              onChange={(e) => setInvoiceNumber(e.target.value)}
              placeholder="FAC-CANDY-001"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">
              Factor sucursal (%)
            </label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={branchFactorPercent}
              onChange={(e) => setBranchFactorPercent(e.target.value)}
              placeholder="Ej: 30"
            />
          </div>
          <div>
            <label className="block text-sm font-medium">Descripción</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Comentarios de la factura"
            />
          </div>
        </div>

        {/* Filtros */}
        <div className="bg-gray-50 border rounded p-3 mb-3">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-sm font-medium">Desde (venta)</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={txFrom}
                onChange={(e) => setTxFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm font-medium">Hasta (venta)</label>
              <input
                type="date"
                className="border rounded px-2 py-1"
                value={txTo}
                onChange={(e) => setTxTo(e.target.value)}
              />
            </div>
            <div className="min-w-[220px]">
              <label className="block text-sm font-medium">Producto</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  list="products-list"
                  className="border rounded px-2 py-1 w-full"
                  placeholder="Buscar producto..."
                  value={productFilter}
                  onChange={(e) => setProductFilter(e.target.value)}
                />
                <button
                  type="button"
                  title="Limpiar"
                  className="px-2 py-1 border rounded"
                  onClick={() => setProductFilter("")}
                >
                  ✕
                </button>
                <datalist id="products-list">
                  {productOptions.map((p) => (
                    <option key={p.key} value={p.name} />
                  ))}
                </datalist>
              </div>
            </div>
            <div className="min-w-[180px]">
              <label className="block text-sm font-medium">Vendedor</label>
              <select
                className="border rounded px-2 py-1 w-full"
                value={sellerFilter}
                onChange={(e) => setSellerFilter(e.target.value)}
              >
                <option value="">Todos</option>
                {sellerOptions.map((s) => (
                  <option key={s.value} value={s.value}>
                    {s.label}
                  </option>
                ))}
              </select>
            </div>

            <button
              className="ml-auto px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
              onClick={() => {
                setTxFrom(firstDayOfMonth());
                setTxTo(todayStr());
                setProductFilter("");
                setSellerFilter("");
              }}
            >
              Quitar filtro
            </button>
          </div>
        </div>

        {/* Ventas */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Ventas de dulces</h4>

            {loadingTx && (
              <span className="text-xs text-gray-500">Cargando ventas…</span>
            )}

            <label className="text-sm flex items-center gap-2 ml-auto">
              <input
                type="checkbox"
                checked={
                  filteredTx.length > 0 &&
                  selectedIds.length === filteredTx.length
                }
                onChange={(e) => selectAllTx(e.target.checked)}
              />
              Seleccionar todas
            </label>
          </div>

          {filteredTx.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay ventas de dulces en el rango seleccionado.
            </p>
          ) : (
            <div className="border rounded max-h-80 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 sticky top-0">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha venta</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">UnPaquete</th>
                    <th className="p-2 border">UvPaquete</th>
                    <th className="p-2 border">Comision</th>
                    <th className="p-2 border">Vendedor</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredTx.map((t) => {
                    const checked = selectedIds.includes(t.id);
                    const email = (t.sellerEmail || "").trim().toLowerCase();
                    const seller = sellersByEmail[email];

                    return (
                      <tr key={t.id} className="text-center">
                        <td className="p-2 border">
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => toggleTx(t.id, e.target.checked)}
                          />
                        </td>
                        <td className="p-2 border">{t.date || "—"}</td>
                        <td className="p-2 border">{t.productName || "—"}</td>
                        <td className="p-2 border">{qty3(t.packages)}</td>
                        <td className="p-2 border">{money(t.amount)}</td>
                        <td className="p-2 border">
                          {safeNum(t.uNetaPorPaquete) !== 0
                            ? Number(safeNum(t.uNetaPorPaquete)).toFixed(4)
                            : "—"}
                        </td>
                        <td className="p-2 border">
                          {safeNum(t.commissionUvPack) > 0
                            ? Number(safeNum(t.commissionUvPack)).toFixed(4)
                            : "—"}
                        </td>
                        <td className="p-2 border">
                          {(() => {
                            const vg = safeNum(t.vendorGain);
                            const fallback =
                              safeNum(t.commissionUvPack) *
                                safeNum(t.packages) ||
                              safeNum((t as any).vendorCommissionAmount);
                            const val = vg || fallback;
                            return val && val !== 0
                              ? `C$${Number(val).toFixed(2)}`
                              : "—";
                          })()}
                        </td>
                        <td className="p-2 border">
                          {seller?.name || t.vendorName || "—"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Gastos */}
        <div className="mb-4">
          <div className="flex items-center gap-3 mb-2">
            <h4 className="font-semibold">Gastos a incluir (opcional)</h4>
            {loadingExpenses && (
              <span className="text-xs text-gray-500">Cargando…</span>
            )}
            <div className="ml-auto flex items-end gap-3">
              <div>
                <label className="block text-xs text-gray-600">
                  Desde (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expFrom}
                  onChange={(e) => setExpFrom(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs text-gray-600">
                  Hasta (gasto)
                </label>
                <input
                  type="date"
                  className="border rounded px-2 py-1"
                  value={expTo}
                  onChange={(e) => setExpTo(e.target.value)}
                />
              </div>
            </div>
          </div>

          {filteredExpenses.length === 0 ? (
            <p className="text-sm text-gray-500">
              No hay gastos en el rango seleccionado.
            </p>
          ) : (
            <div className="border rounded max-h-48 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100 sticky top-0">
                  <tr>
                    <th className="p-2 border">Sel</th>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Monto</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredExpenses.map((g) => (
                    <tr key={g.id} className="text-center">
                      <td className="p-2 border">
                        <input
                          type="checkbox"
                          checked={selectedExpenseIds.includes(g.id)}
                          onChange={(e) =>
                            toggleExpense(g.id, e.target.checked)
                          }
                        />
                      </td>
                      <td className="p-2 border">{g.date || "—"}</td>
                      <td className="p-2 border text-left">
                        {g.description || "—"}
                      </td>
                      <td className="p-2 border">{money(g.amount)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center gap-2 mb-2">
            <h4 className="font-semibold">Ajustes</h4>
            <button
              type="button"
              className="ml-auto px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
              onClick={() => setOpenAdjModal(true)}
            >
              Agregar cargo
            </button>
          </div>
          {adjustments.length === 0 ? (
            <p className="text-sm text-gray-500">Sin cargos agregados.</p>
          ) : (
            <div className="border rounded max-h-40 overflow-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Descripción</th>
                    <th className="p-2 border">Tipo</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Acciones</th>
                  </tr>
                </thead>
                <tbody>
                  {adjustments.map((a) => {
                    const isEditing = editingAdjId === a.id;
                    return (
                      <tr key={a.id} className="text-center">
                        <td className="p-2 border">
                          {isEditing ? (
                            <textarea
                              className="w-full border rounded px-2 py-1 min-h-[70px]"
                              value={editAdjDesc}
                              onChange={(e) => setEditAdjDesc(e.target.value)}
                            />
                          ) : (
                            <span title={a.description}>
                              {a.description.length > 60
                                ? `${a.description.slice(0, 60)}…`
                                : a.description}
                            </span>
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <select
                              className="w-full border rounded px-2 py-1"
                              value={editAdjType}
                              onChange={(e) =>
                                setEditAdjType(
                                  e.target.value as "DEBITO" | "CREDITO",
                                )
                              }
                            >
                              <option value="DEBITO">Débito</option>
                              <option value="CREDITO">Crédito</option>
                            </select>
                          ) : (
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${
                                a.type === "DEBITO"
                                  ? "bg-red-100 text-red-700"
                                  : "bg-green-100 text-green-700"
                              }`}
                            >
                              {a.type}
                            </span>
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              className="w-full border rounded px-2 py-1 text-right"
                              value={editAdjAmount}
                              onChange={(e) => setEditAdjAmount(e.target.value)}
                            />
                          ) : (
                            money(a.amount)
                          )}
                        </td>
                        <td className="p-2 border">
                          {isEditing ? (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-green-600 text-white hover:bg-green-700 text-xs"
                                onClick={saveEditAdjustment}
                              >
                                Guardar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                                onClick={cancelEditAdjustment}
                              >
                                Cancelar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          ) : (
                            <div className="flex gap-2 justify-center">
                              <button
                                className="px-2 py-1 rounded bg-indigo-600 text-white hover:bg-indigo-700 text-xs"
                                onClick={() => beginEditAdjustment(a)}
                              >
                                Editar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeAdjustment(a.id)}
                              >
                                Eliminar
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Resumen */}
        <div className="grid grid-cols-1 md:grid-cols-3 text-sm mb-4 justify-between gap-3">
          {/* KPI cards */}
          <div className="md:col-span-3">
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-6 gap-3 mb-3">
              <div className="p-3 bg-green-50 border border-green-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Ventas</div>
                <div className="text-lg font-bold">
                  {totals.totalSelectedSales}
                </div>
              </div>

              <div className="p-3 bg-yellow-50 border border-yellow-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Paquetes</div>
                <div className="text-lg font-bold">
                  {qty3(totals.totalPackages)}
                </div>
              </div>

              <div className="p-3 bg-blue-50 border border-blue-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Total venta</div>
                <div className="text-lg font-bold">
                  ${money(totals.totalSale)}
                </div>
              </div>

              <div className="p-3 bg-indigo-50 border border-indigo-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Total U. Neta</div>
                <div className="text-lg font-bold">
                  ${money(totals.totalNetFromUNeta)}
                </div>
              </div>

              <div className="p-3 bg-red-50 border border-red-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Comisión UV</div>
                <div className="text-lg font-bold">
                  ${money(totals.totalCommissionUvPack)}
                </div>
              </div>

              <div className="p-3 bg-blue-100 border border-blue-300 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Monto final</div>
                <div className="text-lg font-bold text-blue-800">
                  ${money(totals.finalAmount)}
                </div>
              </div>
            </div>

            <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="p-3 bg-gray-50 border border-gray-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Gastos</div>
                <div className="text-lg font-bold">
                  ${money(totals.totalGastos)}
                </div>
              </div>

              <div className="p-3 bg-gray-50 border border-gray-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Débitos</div>
                <div className="text-lg font-bold">${money(totals.debits)}</div>
              </div>

              <div className="p-3 bg-gray-50 border border-gray-200 rounded flex flex-col items-start">
                <div className="text-xs text-gray-600">Créditos</div>
                <div className="text-lg font-bold">
                  ${money(totals.credits)}
                </div>
              </div>
            </div>
          </div>
          {/* Estos campos están cubiertos por los KPI arriba; ocultados */}
          <div className="space-y-1" aria-hidden>
            {/* Ventas seleccionadas: <strong>{totals.totalSelectedSales}</strong> */}
            {/* Total paquetes: <strong>{qty3(totals.totalPackages)}</strong> */}
          </div>

          {/*
          <div className="space-y-1 text-center">
            <div>
              Total proveedor (costo):{" "}
              <strong>{money(totals.totalProvider)}</strong>
            </div>
            <div>
              Total venta: <strong>{money(totals.totalSale)}</strong>
            </div>
            <div>
              Ganancia bruta (venta − costo):{" "}
              <strong>{money(totals.grossProfit)}</strong>
            </div>
          </div>
          */}

          {/* Ocultamos los totales individuales porque los KPI los muestran arriba */}
          <div className="space-y-1 text-right" aria-hidden>
            {/* Gastos: <strong>{money(totals.totalGastos)}</strong> */}
            {/* Débitos: <strong>{money(totals.debits)}</strong> */}
            {/* Créditos: <strong>{money(totals.credits)}</strong> */}
            {/* Comisión total UV x paquete: <strong>{money(totals.totalCommissionUvPack)}</strong> */}
            {/* Total U. Neta (suma filas): <strong>{money(totals.totalNetFromUNeta || 0)}</strong> */}
          </div>

          {/* Tarjeta 'Monto final' eliminada; KPI ya muestra este valor arriba */}
        </div>

        {/* Acciones */}
        <div className="flex items-center gap-2">
          <button
            disabled={creating}
            onClick={createInvoice}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700 disabled:opacity-60"
          >
            {creating ? "Creando…" : "Crear factura"}
          </button>

          <button onClick={onClose} className="px-4 py-2 border rounded">
            Cancelar
          </button>

          {msg && <span className="text-sm ml-2">{msg}</span>}
        </div>

        {creating && (
          <div className="absolute inset-0 z-[11000] bg-white/80 backdrop-blur-sm flex flex-col items-center justify-center gap-3">
            <svg
              className="animate-spin h-8 w-8 text-blue-600"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
                fill="none"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8v4a4 4 0 00-4 4H4z"
              />
            </svg>
            <div className="text-sm font-medium text-blue-700">
              Creando factura…
            </div>
          </div>
        )}
      </div>

      {openAdjModal && (
        <div className="fixed inset-0 z-[10000] bg-black/50 flex items-center justify-center p-3">
          <div className="bg-white w-full max-w-lg rounded-xl shadow-xl p-4">
            <div className="flex items-center mb-3">
              <h4 className="font-semibold">Nuevo cargo</h4>
              <button
                className="ml-auto px-2 py-1 border rounded hover:bg-gray-50"
                onClick={() => setOpenAdjModal(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="space-y-3">
              <div>
                <label className="block text-sm font-medium mb-1">
                  Descripción
                </label>
                <textarea
                  className="w-full border rounded px-2 py-1 min-h-[90px]"
                  value={adjDesc}
                  onChange={(e) => setAdjDesc(e.target.value)}
                  placeholder="Detalle del cargo"
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="block text-sm font-medium">
                    Tipo de cargo
                  </label>
                  <select
                    className="w-full border rounded px-2 py-1"
                    value={adjType}
                    onChange={(e) =>
                      setAdjType(e.target.value as "DEBITO" | "CREDITO")
                    }
                  >
                    <option value="DEBITO">Débito</option>
                    <option value="CREDITO">Crédito</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium">Monto</label>
                  <input
                    type="number"
                    step="0.01"
                    className="w-full border rounded px-2 py-1"
                    value={adjAmount}
                    onChange={(e) => setAdjAmount(e.target.value)}
                    placeholder="0.00"
                  />
                </div>
              </div>

              <div className="flex justify-end">
                <button
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  onClick={addAdjustment}
                >
                  Agregar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
