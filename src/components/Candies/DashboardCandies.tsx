// src/components/Candies/FinancialDashboardCandies.tsx
import React, { useEffect, useMemo, useState, useCallback } from "react";
import {
  collection,
  getDocs,
  deleteDoc,
  doc,
  query,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

type SaleType = "CONTADO" | "CREDITO";

interface SaleItem {
  productId: string;
  productName: string;
  sku?: string;
  qty: number; // paquetes
  unitPrice: number; // precio por paquete
  discount?: number;
  vendorCommissionAmount?: number; // comisión por ítem (C$)
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;
  items: SaleItem[];
  customerId?: string;
  customerName?: string;
  vendorId?: string;
  vendorName?: string;
}

interface BatchRow {
  id: string;
  productId: string;
  productName: string;
  date: string; // yyyy-MM-dd
  quantity: number; // PAQUETES (para FIFO)
  remaining: number; // PAQUETES (informativo)
  purchasePrice: number; // costo por PAQUETE (providerPrice)
  unitsPerPackage: number; // informativo
}

interface Movement {
  id: string;
  customerId: string;
  type: "CARGO" | "ABONO";
  amount: number; // CARGO > 0, ABONO < 0
  date: string; // yyyy-MM-dd
}

interface Customer {
  id: string;
  name: string;
  balance?: number; // suma de movements (CARGO-ABONO)
}

interface ExpenseRow {
  id: string;
  date: string;
  category: string;
  description: string;
  amount: number;
  status?: string;
}

interface CreditPiece {
  saleId: string;
  date: string;
  productName: string;
  sku?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number; // bruto
  discount: number; // descuento por ítem (C$)
  lineFinal: number; // neto (con descuento)
}

type VendorPieceType = "CASH" | "CREDIT" | "ASSOCIATED" | "REMAINING";

interface VendorPiece {
  saleId: string;
  date: string;
  productName: string;
  sku?: string;
  qty: number;
  unitPrice: number;
  lineTotal: number;
  discount: number;
  lineFinal: number;
  vendorCommissionAmount: number;
  type: VendorPieceType;
}

interface SellerCandy {
  id: string;
  name: string;
  commissionPercent: number;
}

/** Devuelve yyyy-MM-dd del createdAt si no hay date string */
function ensureDate(x: any): string {
  const d: string | undefined = x?.date;
  if (d) return d;
  if (x?.createdAt?.toDate) {
    return format(x.createdAt.toDate(), "yyyy-MM-dd");
  }
  return "";
}

/** Normaliza ítems de venta: lee items[] o cae a item {} */
function normalizeSaleItems(x: any): SaleItem[] {
  // ✅ nuevo POS: items[] con packages + unitPricePackage
  if (Array.isArray(x?.items)) {
    return x.items.map((it: any) => {
      const qty = Number(it?.packages ?? it?.qty ?? it?.quantity ?? 0) || 0;

      const unitPrice =
        Number(it?.unitPricePackage ?? it?.unitPrice ?? 0) ||
        (qty > 0 ? Number(it?.total ?? it?.lineFinal ?? 0) / qty : 0) ||
        0;

      return {
        productId: String(it?.productId || ""),
        productName: String(it?.productName || ""),
        sku: it?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(it?.discount || 0),
        vendorCommissionAmount: Number(
          it?.vendorCommissionAmount ?? it?.commissionAmount ?? 0
        ),
      };
    });
  }

  // legacy item
  if (x?.item) {
    const it = x.item;
    const qty =
      Number(it?.packages ?? it?.qty ?? it?.quantity ?? 0) ||
      Number(x?.packagesTotal ?? x?.quantity ?? 0) ||
      0;

    const unitPrice =
      Number(it?.unitPricePackage ?? it?.unitPrice ?? 0) ||
      (qty > 0 ? Number(it?.total ?? x?.total ?? 0) / qty : 0) ||
      0;

    return [
      {
        productId: String(it?.productId || ""),
        productName: String(it?.productName || ""),
        sku: it?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(it?.discount || 0),
        vendorCommissionAmount: Number(
          it?.vendorCommissionAmount ?? it?.commissionAmount ?? 0
        ),
      },
    ];
  }

  // ultra legacy
  const qty = Number(x?.packagesTotal ?? x?.quantity ?? 0) || 0;
  const unitPrice = qty > 0 ? Number(x?.total || 0) / qty : 0;
  if (qty > 0) {
    return [
      {
        productId: String(x?.productId || ""),
        productName: String(x?.productName || ""),
        sku: x?.sku || "",
        qty,
        unitPrice: Number(unitPrice || 0),
        discount: Number(x?.discount || 0),
        vendorCommissionAmount: Number(
          x?.vendorCommissionAmount ?? x?.commissionAmount ?? 0
        ),
      },
    ];
  }
  return [];
}

// ===== Normalización completa de cada doc de venta =====
function normalizeSale(raw: any, id: string): SaleDoc | null {
  const date = ensureDate(raw);
  if (!date) return null;

  const vendorId = raw.vendorId || raw.sellerId || undefined;
  const vendorName = raw.vendorName || raw.sellerName || undefined;

  const items = normalizeSaleItems(raw);

  // ✅ total confiable:
  // 1) raw.total
  // 2) raw.itemsTotal
  // 3) suma de ítems (total/lineFinal o qty*unitPrice - discount)
  let total =
    Number(raw.total ?? raw.itemsTotal ?? 0) ||
    items.reduce((acc, it) => {
      const lineTotal =
        (Number(it.qty || 0) || 0) * (Number(it.unitPrice || 0) || 0);
      const disc = Math.max(0, Number(it.discount || 0));
      const lineFinal = Math.max(0, lineTotal - disc);
      return acc + lineFinal;
    }, 0);

  total = Number(total || 0);

  return {
    id,
    date,
    type: (raw.type || "CONTADO") as SaleType,
    total,
    items,
    customerId: raw.customerId || undefined,
    customerName: raw.customerName || undefined,
    vendorId,
    vendorName,
  };
}

/** COGS por FIFO (EN PAQUETES) */
function computeFifoCogs(
  batches: BatchRow[],
  salesUpToToDate: SaleDoc[],
  fromDate: string,
  toDate: string
) {
  const byProd: Record<
    string,
    {
      productName: string;
      lots: { date: string; qtyLeft: number; cost: number }[];
    }
  > = {};

  for (const b of batches) {
    if (!byProd[b.productId]) {
      byProd[b.productId] = { productName: b.productName, lots: [] };
    }
    byProd[b.productId].lots.push({
      date: b.date,
      qtyLeft: Number(b.quantity || 0), // PAQUETES disponibles al inicio
      cost: Number(b.purchasePrice || 0), // costo por PAQUETE
    });
  }

  for (const k of Object.keys(byProd)) {
    byProd[k].lots.sort((a, b) => a.date.localeCompare(b.date));
  }

  const orderedSales = [...salesUpToToDate].sort((a, b) =>
    a.date.localeCompare(b.date)
  );

  let cogsPeriod = 0;

  for (const s of orderedSales) {
    for (const it of s.items || []) {
      const map = byProd[it.productId];
      if (!map) continue;

      let need = Number(it.qty || 0); // PAQUETES vendidos
      if (need <= 0) continue;

      for (const lot of map.lots) {
        if (need <= 0) break;
        if (lot.qtyLeft <= 0) continue;

        const take = Math.min(lot.qtyLeft, need);
        if (s.date >= fromDate && s.date <= toDate) {
          cogsPeriod += take * lot.cost;
        }
        lot.qtyLeft -= take;
        need -= take;
      }
    }
  }

  return cogsPeriod;
}

async function deleteARMovesBySaleId(saleId: string) {
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId)
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id)))
  );
}

export default function FinancialDashboardCandies() {
  const { refreshKey, refresh } = useManualRefresh();

  const [fromDate, setFromDate] = useState(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );

  const [salesRange, setSalesRange] = useState<SaleDoc[]>([]);
  const [salesUpToToDate, setSalesUpToToDate] = useState<SaleDoc[]>([]);
  const [batchesUpToToDate, setBatchesUpToToDate] = useState<BatchRow[]>([]);
  const [expenses, setExpenses] = useState<ExpenseRow[]>([]);
  const [abonos, setAbonos] = useState<Movement[]>([]);
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Sellers (para comisión)
  const [sellers, setSellers] = useState<SellerCandy[]>([]);

  // Pedidos por vendedor (ordenes vendedor)
  const [vendorOrderDetails, setVendorOrderDetails] = useState<
    Record<string, { associated: VendorPiece[]; remaining: VendorPiece[] }>
  >({});
  const [vendorAssociatedPacks, setVendorAssociatedPacks] = useState<
    Record<string, number>
  >({});

  // Modal detalle cliente
  const [modalOpen, setModalOpen] = useState(false);
  const [modalCustomer, setModalCustomer] = useState<Customer | null>(null);
  const [modalPieces, setModalPieces] = useState<CreditPiece[]>([]);
  const [modalLoading, setModalLoading] = useState(false);
  const [modalKpis, setModalKpis] = useState({
    totalBruto: 0,
    totalDescuento: 0,
    totalFiado: 0,
    saldoActual: 0,
    abonadoPeriodo: 0,
  });

  // Modal detalle vendedor
  const [vendorModalOpen, setVendorModalOpen] = useState(false);
  const [vendorModalTitle, setVendorModalTitle] = useState("");
  const [vendorModalPieces, setVendorModalPieces] = useState<VendorPiece[]>([]);
  const [vendorModalLoading, setVendorModalLoading] = useState(false);

  // Modal detalle venta (transacciones)
  const [saleModalOpen, setSaleModalOpen] = useState(false);
  const [saleModalSale, setSaleModalSale] = useState<SaleDoc | null>(null);

  // ===== Cargar sellers (dulces) una sola vez =====
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, "sellers_candies"));
        const list: SellerCandy[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name || "",
            commissionPercent: Number(x.commissionPercent || 0),
          });
        });
        setSellers(list);
      } catch (e) {
        console.error("Error cargando sellers_candies", e);
      }
    })();
  }, []);

  const sellersById = useMemo(() => {
    const m: Record<string, SellerCandy> = {};
    sellers.forEach((s) => {
      m[s.id] = s;
    });
    return m;
  }, [sellers]);

  // ===== Carga de datos =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // Ventas (dulces)
        const sSnap = await getDocs(collection(db, "sales_candies"));
        const allSales: SaleDoc[] = [];
        const rangeSales: SaleDoc[] = [];

        sSnap.forEach((d) => {
          const x = d.data() as any;
          const docN = normalizeSale(x, d.id);
          if (!docN) return;

          if (docN.date <= toDate) allSales.push(docN);
          if (docN.date >= fromDate && docN.date <= toDate)
            rangeSales.push(docN);
        });
        setSalesUpToToDate(allSales);
        setSalesRange(rangeSales);

        // Lotes (dulces) => FIFO EN PAQUETES, costo por paquete = providerPrice
        const bSnap = await getDocs(collection(db, "inventory_candies"));
        const allBatches: BatchRow[] = [];
        bSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date || date > toDate) return;

          const unitsPerPackage = Math.max(
            1,
            Math.floor(Number(x.unitsPerPackage || 1))
          );
          const totalUnits = Number(x.totalUnits ?? x.quantity ?? 0);
          const packagesField = Number(x.packages ?? 0);
          const remainingUnits = Number(x.remaining ?? 0);
          const remainingPackagesField = Number(x.remainingPackages ?? 0);

          const packagesTotal =
            packagesField > 0
              ? packagesField
              : totalUnits > 0
              ? Math.floor(totalUnits / unitsPerPackage)
              : 0;

          const remainingPacks =
            remainingPackagesField > 0
              ? remainingPackagesField
              : remainingUnits > 0
              ? Math.floor(remainingUnits / unitsPerPackage)
              : 0;

          allBatches.push({
            id: d.id,
            productId: x.productId,
            productName: x.productName || "",
            date,
            quantity: Number(packagesTotal || 0), // PAQUETES
            remaining: Number(remainingPacks || 0), // PAQUETES
            purchasePrice: Number(x.providerPrice || x.purchasePrice || 0), // costo por paquete
            unitsPerPackage,
          });
        });
        setBatchesUpToToDate(allBatches);

        // Gastos (dulces)
        const eSnap = await getDocs(collection(db, "expenses_candies"));
        const eList: ExpenseRow[] = [];
        eSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date) return;
          if (date >= fromDate && date <= toDate) {
            eList.push({
              id: d.id,
              date,
              category: x.category || "",
              description: x.description || "",
              amount: Number(x.amount || 0),
              status: x.status || "",
            });
          }
        });
        setExpenses(eList);

        // Movimientos (CxC global)
        const mSnap = await getDocs(collection(db, "ar_movements"));
        const abonosRange: Movement[] = [];
        const balanceByCust: Record<string, number> = {};
        mSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date) return;
          const cid = x.customerId;
          const amt = Number(x.amount || 0);
          if (cid) balanceByCust[cid] = (balanceByCust[cid] || 0) + amt;
          if (x.type === "ABONO" && date >= fromDate && date <= toDate) {
            abonosRange.push({
              id: d.id,
              customerId: cid,
              type: "ABONO",
              amount: amt,
              date,
            });
          }
        });
        setAbonos(abonosRange);

        // Clientes (dulces)
        const cSnap = await getDocs(collection(db, "customers_candies"));
        const cList: Customer[] = [];
        cSnap.forEach((d) => {
          const x = d.data() as any;
          cList.push({
            id: d.id,
            name: x.name || "",
            balance: balanceByCust[d.id] || 0,
          });
        });
        setCustomers(cList);

        // Pedidos por vendedor (inventory_candies_sellers)
        const ivSnap = await getDocs(
          collection(db, "inventory_candies_sellers")
        );
        const orderDetailsTmp: Record<
          string,
          { associated: VendorPiece[]; remaining: VendorPiece[] }
        > = {};
        const assocPacksByVendor: Record<string, number> = {};

        ivSnap.forEach((d) => {
          const x = d.data() as any;
          const date = ensureDate(x);
          if (!date) return;
          if (date < fromDate || date > toDate) return;

          const vendorId = x.sellerId || x.vendorId || "NO_VENDOR";
          const productName = x.productName || "";
          const sku = x.sku || "";

          const unitsPerPackage = Math.max(
            1,
            Math.floor(Number(x.unitsPerPackage || 1))
          );
          const totalUnits = Number(x.totalUnits ?? 0);
          const packagesField = Number(x.packages ?? 0);
          const remainingUnits = Number(x.remainingUnits ?? x.remaining ?? 0);
          const remainingPackagesField = Number(x.remainingPackages ?? 0);

          const packagesOrdered =
            packagesField > 0
              ? packagesField
              : totalUnits > 0
              ? Math.floor(totalUnits / unitsPerPackage)
              : 0;

          const remainingPacks =
            remainingPackagesField > 0
              ? remainingPackagesField
              : remainingUnits > 0
              ? Math.floor(remainingUnits / unitsPerPackage)
              : 0;

          const totalVendorDoc = Number(x.totalVendor ?? 0);
          const gainVendorDoc = Number(x.gainVendor ?? 0);

          const originalPackages = packagesOrdered;

          const moneyPerPackage =
            originalPackages > 0 ? totalVendorDoc / originalPackages : 0;
          const commissionPerPackage =
            originalPackages > 0 ? gainVendorDoc / originalPackages : 0;

          if (!orderDetailsTmp[vendorId]) {
            orderDetailsTmp[vendorId] = { associated: [], remaining: [] };
          }

          if (packagesOrdered > 0) {
            const qty = packagesOrdered;
            const lineTotal = qty * moneyPerPackage;
            const lineFinal = lineTotal;
            const commission = qty * commissionPerPackage;

            orderDetailsTmp[vendorId].associated.push({
              saleId: d.id,
              date,
              productName,
              sku,
              qty,
              unitPrice: moneyPerPackage,
              lineTotal,
              discount: 0,
              lineFinal,
              vendorCommissionAmount: commission,
              type: "ASSOCIATED",
            });

            assocPacksByVendor[vendorId] =
              (assocPacksByVendor[vendorId] || 0) + qty;
          }

          if (remainingPacks > 0) {
            const qty = remainingPacks;
            const lineTotal = qty * moneyPerPackage;
            const lineFinal = lineTotal;
            const commission = qty * commissionPerPackage;

            orderDetailsTmp[vendorId].remaining.push({
              saleId: d.id,
              date,
              productName,
              sku,
              qty,
              unitPrice: moneyPerPackage,
              lineTotal,
              discount: 0,
              lineFinal,
              vendorCommissionAmount: commission,
              type: "REMAINING",
            });
          }
        });

        setVendorOrderDetails(orderDetailsTmp);
        setVendorAssociatedPacks(assocPacksByVendor);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando datos del dashboard.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate, refreshKey]);

  // ===== helpers de comisión =====
  const getSellerForSale = useCallback(
    (s: SaleDoc): SellerCandy | undefined => {
      if (s.vendorId && sellersById[s.vendorId]) {
        return sellersById[s.vendorId];
      }
      const nameNorm = (s.vendorName || "").trim().toLowerCase();
      if (!nameNorm) return undefined;
      return sellers.find(
        (v) => (v.name || "").trim().toLowerCase() === nameNorm
      );
    },
    [sellersById, sellers]
  );

  const getItemCommission = useCallback(
    (s: SaleDoc, it: SaleItem): number => {
      // ✅ regla del sistema: crédito NO paga comisión
      //if (s.type === "CREDITO") return 0;

      const stored = Number(it.vendorCommissionAmount || 0);
      if (stored) return stored;

      const seller = getSellerForSale(s);
      if (!seller || !seller.commissionPercent) return 0;

      const qty = Number(it.qty || 0);
      const unitPrice = Number(it.unitPrice || 0);
      const lineTotal = qty * unitPrice;
      const discount = Math.max(0, Number(it.discount || 0));
      const lineFinal = Math.max(0, lineTotal - discount);
      if (!lineFinal) return 0;

      const percent = Number(seller.commissionPercent) || 0;
      return (lineFinal * percent) / 100;
    },
    [getSellerForSale]
  );

  // ====== COGS por FIFO ======
  const cogsFIFO = useMemo(() => {
    try {
      return computeFifoCogs(
        batchesUpToToDate,
        salesUpToToDate,
        fromDate,
        toDate
      );
    } catch (e) {
      console.error(e);
      return 0;
    }
  }, [batchesUpToToDate, salesUpToToDate, fromDate, toDate]);

  // ====== KPIs generales ======
  const kpis = useMemo(() => {
    const ventasTotales = salesRange.reduce((a, s) => a + (s.total || 0), 0);
    const gastosPeriodo = expenses.reduce((a, e) => a + (e.amount || 0), 0);
    const gananciaAntes = ventasTotales - cogsFIFO;
    const gananciaDespues = gananciaAntes - gastosPeriodo;

    const abonosRecibidos = abonos.reduce(
      (a, m) => a + Math.abs(m.amount || 0),
      0
    );

    const clientesConSaldo = customers.filter((c) => (c.balance || 0) > 0);
    const saldosPendientes = clientesConSaldo.reduce(
      (a, c) => a + (c.balance || 0),
      0
    );

    let paquetesCash = 0;
    let paquetesCredito = 0;
    let comisionCash = 0;
    let comisionCredito = 0;

    for (const s of salesRange) {
      const saleQty = (s.items || []).reduce(
        (a, it) => a + (Number(it.qty) || 0),
        0
      );

      const saleCommission = (s.items || []).reduce(
        (a, it) => a + getItemCommission(s, it),
        0
      );

      if (s.type === "CONTADO") {
        paquetesCash += saleQty;
        comisionCash += saleCommission;
      } else {
        paquetesCredito += saleQty;
        // aquí por regla queda 0 (getItemCommission devuelve 0)
        comisionCredito += saleCommission;
      }
    }

    return {
      ventasTotales,
      costoMercaderia: cogsFIFO,
      gastosPeriodo,
      gananciaAntes,
      gananciaDespues,
      abonosRecibidos,
      saldosPendientes,
      clientesConSaldo: clientesConSaldo.length,
      paquetesCash,
      paquetesCredito,
      comisionCash,
      comisionCredito,
    };
  }, [salesRange, expenses, abonos, customers, cogsFIFO, getItemCommission]);

  // ===== Consolidado por cliente con saldo ======
  const creditCustomersRows = useMemo(() => {
    const qtyByCust: Record<string, number> = {};
    const fiadoByCust: Record<string, number> = {};

    for (const s of salesRange) {
      if (s.type !== "CREDITO" || !s.customerId) continue;
      for (const it of s.items || []) {
        const qty = Number(it.qty || 0);
        const unitPrice = Number(it.unitPrice || 0);
        const lineTotal = qty * unitPrice;
        const discount = Math.max(0, Number(it.discount || 0));
        const lineFinal = Math.max(0, lineTotal - discount);

        qtyByCust[s.customerId] = (qtyByCust[s.customerId] || 0) + qty;
        fiadoByCust[s.customerId] =
          (fiadoByCust[s.customerId] || 0) + lineFinal;
      }
    }

    return customers
      .filter((c) => (c.balance || 0) > 0)
      .map((c) => ({
        customerId: c.id,
        name: c.name,
        paquetesAsociados: qtyByCust[c.id] || 0,
        saldoTotal: fiadoByCust[c.id] || 0,
        saldoPendiente: c.balance || 0,
      }))
      .sort((a, b) => b.saldoPendiente - a.saldoPendiente);
  }, [customers, salesRange]);

  // === Mapa clienteId -> nombre (para mostrar en tabla) ===
  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  // === Ventas del periodo como filas para tabla (orden desc) ===
  const salesRows = useMemo(() => {
    return [...salesRange]
      .sort((a, b) => b.date.localeCompare(a.date))
      .map((s) => {
        const paquetes = (s.items || []).reduce(
          (acc, it) => acc + (Number(it.qty) || 0),
          0
        );

        let cliente = "Cash";
        if (s.type === "CREDITO" && s.customerId) {
          cliente = customersById[s.customerId] || "—";
        } else if (s.type === "CONTADO") {
          cliente = s.customerName?.trim() || "Cash";
        }

        const avgPrice = paquetes > 0 ? s.total / paquetes : 0;

        return {
          id: s.id,
          date: s.date,
          type: s.type === "CREDITO" ? "Crédito" : "Cash",
          customer: cliente,
          paquetes,
          total: Number(s.total || 0),
          avgPrice,
        };
      });
  }, [salesRange, customersById]);

  // ===== Consolidado de vendedores =====
  const vendorRows = useMemo(() => {
    type Row = {
      vendorId: string;
      vendorName: string;
      paquetesAsociados: number;
      paquetesVendidos: number;
      paquetesFiados: number;
      totalVendido: number;
      totalFiado: number;
      comisionCash: number;
      comisionCredito: number;
      paquetesRestantes: number;
    };

    const map = new Map<string, Row>();

    // consolidar ventas
    for (const s of salesRange) {
      const vId = s.vendorId || "NO_VENDOR";
      const vName =
        s.vendorName ||
        sellersById[vId]?.name ||
        (vId === "NO_VENDOR" ? "Sin vendedor" : "Sin vendedor");

      if (!map.has(vId)) {
        map.set(vId, {
          vendorId: vId,
          vendorName: vName,
          paquetesAsociados: 0,
          paquetesVendidos: 0,
          paquetesFiados: 0,
          totalVendido: 0,
          totalFiado: 0,
          comisionCash: 0,
          comisionCredito: 0,
          paquetesRestantes: 0,
        });
      }

      const row = map.get(vId)!;

      for (const it of s.items || []) {
        const qty = Number(it.qty || 0);
        const unitPrice = Number(it.unitPrice || 0);
        const lineTotal = qty * unitPrice;
        const discount = Math.max(0, Number(it.discount || 0));
        const lineFinal = Math.max(0, lineTotal - discount);
        const commission = getItemCommission(s, it);

        if (s.type === "CONTADO") {
          row.paquetesVendidos += qty;
          row.totalVendido += lineFinal;
          row.comisionCash += commission;
        } else {
          row.paquetesFiados += qty;
          row.totalFiado += lineFinal;
          row.comisionCredito += commission; // por regla = 0
        }
      }
    }

    // inyectar asociados
    for (const [vId, assocPacks] of Object.entries(vendorAssociatedPacks)) {
      const existing = map.get(vId);
      const vName =
        existing?.vendorName ||
        sellersById[vId]?.name ||
        (vId === "NO_VENDOR" ? "Sin vendedor" : "Sin vendedor");

      const row: Row = existing || {
        vendorId: vId,
        vendorName: vName,
        paquetesAsociados: 0,
        paquetesVendidos: 0,
        paquetesFiados: 0,
        totalVendido: 0,
        totalFiado: 0,
        comisionCash: 0,
        comisionCredito: 0,
        paquetesRestantes: 0,
      };

      row.paquetesAsociados = assocPacks;
      row.paquetesRestantes = Math.max(
        assocPacks - row.paquetesVendidos - row.paquetesFiados,
        0
      );

      map.set(vId, row);
    }

    return Array.from(map.values()).sort(
      (a, b) => b.totalVendido + b.totalFiado - (a.totalVendido + a.totalFiado)
    );
  }, [salesRange, vendorAssociatedPacks, sellersById, getItemCommission]);

  // ===== Modal detalle cliente (fiados) =====
  const openCustomerModal = async (row: {
    customerId: string;
    name: string;
  }) => {
    setModalOpen(true);
    setModalCustomer({ id: row.customerId, name: row.name });
    setModalPieces([]);
    setModalLoading(true);
    setModalKpis({
      totalBruto: 0,
      totalDescuento: 0,
      totalFiado: 0,
      saldoActual: 0,
      abonadoPeriodo: 0,
    });

    try {
      const list: CreditPiece[] = [];
      let totalBruto = 0;
      let totalDescuento = 0;
      let totalFiado = 0;

      for (const s of salesRange) {
        if (s.type !== "CREDITO" || s.customerId !== row.customerId) continue;
        for (const it of s.items || []) {
          const qty = Number(it.qty || 0);
          const unitPrice = Number(it.unitPrice || 0);
          const lineTotal = qty * unitPrice;
          const discount = Math.max(0, Number(it.discount || 0));
          const lineFinal = Math.max(0, lineTotal - discount);

          list.push({
            saleId: s.id,
            date: s.date,
            productName: it.productName,
            sku: it.sku || "",
            qty,
            unitPrice,
            lineTotal,
            discount,
            lineFinal,
          });

          totalBruto += lineTotal;
          totalDescuento += discount;
          totalFiado += lineFinal;
        }
      }

      let abonadoPeriodo = 0;
      for (const a of abonos) {
        if (a.customerId === row.customerId) {
          abonadoPeriodo += Math.abs(a.amount || 0);
        }
      }

      const cust = customers.find((c) => c.id === row.customerId);
      const saldoActual = cust?.balance || 0;

      setModalPieces(list);
      setModalKpis({
        totalBruto,
        totalDescuento,
        totalFiado,
        saldoActual,
        abonadoPeriodo,
      });
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el detalle del cliente.");
    } finally {
      setModalLoading(false);
    }
  };

  // ===== Modal detalle vendedor =====
  const openVendorModal = (
    vendorId: string,
    vendorName: string,
    mode: VendorPieceType
  ) => {
    setVendorModalOpen(true);
    let title = "";

    if (mode === "ASSOCIATED") title = `Paquetes asociados — ${vendorName}`;
    else if (mode === "REMAINING") title = `Paquetes restantes — ${vendorName}`;
    else if (mode === "CASH")
      title = `Paquetes vendidos (Cash) — ${vendorName}`;
    else title = `Paquetes fiados (Crédito) — ${vendorName}`;

    setVendorModalTitle(title);
    setVendorModalPieces([]);
    setVendorModalLoading(true);

    try {
      if (mode === "ASSOCIATED" || mode === "REMAINING") {
        const details = vendorOrderDetails[vendorId];
        const pieces =
          mode === "ASSOCIATED"
            ? details?.associated || []
            : details?.remaining || [];
        setVendorModalPieces(
          [...pieces].sort((a, b) => a.date.localeCompare(b.date))
        );
        setVendorModalLoading(false);
        return;
      }

      const list: VendorPiece[] = [];

      for (const s of salesRange) {
        const sameVendor =
          (s.vendorId || "NO_VENDOR") === vendorId ||
          (!s.vendorId && vendorId === "NO_VENDOR");
        if (!sameVendor) continue;

        if (mode === "CASH" && s.type !== "CONTADO") continue;
        if (mode === "CREDIT" && s.type !== "CREDITO") continue;

        for (const it of s.items || []) {
          const qty = Number(it.qty || 0);
          const unitPrice = Number(it.unitPrice || 0);
          const lineTotal = qty * unitPrice;
          const discount = Math.max(0, Number(it.discount || 0));
          const lineFinal = Math.max(0, lineTotal - discount);
          const vendorCommissionAmount = getItemCommission(s, it);

          list.push({
            saleId: s.id,
            date: s.date,
            productName: it.productName,
            sku: it.sku || "",
            qty,
            unitPrice,
            lineTotal,
            discount,
            lineFinal,
            vendorCommissionAmount,
            type: mode,
          });
        }
      }

      setVendorModalPieces(list.sort((a, b) => a.date.localeCompare(b.date)));
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el detalle del vendedor.");
    } finally {
      setVendorModalLoading(false);
    }
  };

  // ===== Modal detalle venta (transacciones) =====
  const openSaleModal = (saleId: string) => {
    const sale = salesRange.find((s) => s.id === saleId) || null;
    setSaleModalSale(sale);
    setSaleModalOpen(true);
  };

  const handleDeleteSale = async (saleId: string) => {
    if (
      !window.confirm("¿Eliminar esta venta? Esta acción no se puede deshacer.")
    )
      return;

    try {
      // ✅ elimina correctamente y restaura inventario (y borra CxC si aplica)
      await restoreSaleAndDeleteCandy(saleId);
      await deleteARMovesBySaleId(saleId);

      setSalesRange((prev) => prev.filter((s) => s.id !== saleId));
      setSalesUpToToDate((prev) => prev.filter((s) => s.id !== saleId));
      setSaleModalOpen(false);
      setSaleModalSale(null);
    } catch (e) {
      console.error(e);
      alert(
        "No se pudo eliminar la venta. Revisa la consola para más detalles."
      );
    }
  };

  return (
    <div className="max-w-6xl mx-auto">
      {/* Filtro */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Finanzas (Dulces)</h2>
        <RefreshButton onClick={refresh} loading={loading} />
      </div>
      <div className="bg-white p-3 rounded shadow border mb-4 flex flex-wrap items-end gap-3 text-sm">
        <div className="flex flex-col">
          <label className="font-semibold">Desde</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={fromDate}
            onChange={(e) => setFromDate(e.target.value)}
          />
        </div>
        <div className="flex flex-col">
          <label className="font-semibold">Hasta</label>
          <input
            type="date"
            className="border rounded px-2 py-1"
            value={toDate}
            onChange={(e) => setToDate(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs */}
      <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-4">
        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Ventas Totales</div>
          <div className="text-xl font-semibold">
            {money(kpis.ventasTotales)}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">
            Contado + Crédito del periodo.
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Costo de Mercadería (FIFO)
          </div>
          <div className="text-xl font-semibold">
            {money(kpis.costoMercaderia)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Ganancia antes de Gastos</div>
          <div className="text-xl font-semibold text-green-600">
            {money(kpis.gananciaAntes)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Gastos del Negocio</div>
          <div className="text-xl font-semibold">
            {money(kpis.gastosPeriodo)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Ganancia después de Gastos
          </div>
          <div className="text-xl font-semibold text-green-600">
            {money(kpis.gananciaDespues)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Abonos Recibidos</div>
          <div className="text-xl font-semibold">
            {money(kpis.abonosRecibidos)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Saldos Pendientes</div>
          <div className="text-xl font-semibold">
            {money(kpis.saldosPendientes)}
          </div>
          <div className="text-[11px] text-gray-500 mt-1">A la fecha.</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Clientes con Saldo</div>
          <div className="text-xl font-semibold">{kpis.clientesConSaldo}</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Paquetes Cash</div>
          <div className="text-xl font-semibold">{kpis.paquetesCash}</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">
            Paquetes Crédito (vendidos)
          </div>
          <div className="text-xl font-semibold">{kpis.paquetesCredito}</div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Comisión Cash</div>
          <div className="text-xl font-semibold">
            {money(kpis.comisionCash)}
          </div>
        </div>

        <div className="p-3 border rounded bg-gray-50">
          <div className="text-xs text-gray-600">Comisión Crédito</div>
          <div className="text-xl font-semibold">
            {money(kpis.comisionCredito)}
          </div>
        </div>
      </div>

      {/* Consolidado por cliente */}
      <h3 className="text-lg font-semibold mb-2">
        Consolidado por cliente (Crédito)
      </h3>
      <div className="bg-white p-2 rounded shadow border w-full mb-6">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Cliente</th>
              <th className="p-2 border">Paquetes asociados (periodo)</th>
              <th className="p-2 border">Saldo total (periodo)</th>
              <th className="p-2 border">Saldo pendiente</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Cargando…
                </td>
              </tr>
            ) : creditCustomersRows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={4}>
                  Sin clientes con saldo
                </td>
              </tr>
            ) : (
              creditCustomersRows.map((r) => (
                <tr key={r.customerId} className="text-center">
                  <td className="p-2 border">{r.name}</td>
                  <td className="p-2 border">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openCustomerModal({
                          customerId: r.customerId,
                          name: r.name,
                        })
                      }
                      title="Ver paquetes fiados del periodo"
                    >
                      {r.paquetesAsociados}
                    </button>
                  </td>
                  <td className="p-2 border">{money(r.saldoTotal)}</td>
                  <td className="p-2 border font-semibold">
                    {money(r.saldoPendiente)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Consolidado de vendedores */}
      <h3 className="text-lg font-semibold mb-2">Consolidado vendedores</h3>
      <div className="bg-white p-2 rounded shadow border w-full mb-6 overflow-x-auto">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border whitespace-nowrap">Vendedor</th>
              <th className="p-2 border whitespace-nowrap">
                Paquetes asociados
              </th>
              <th className="p-2 border whitespace-nowrap">
                Paquetes restantes
              </th>
              <th className="p-2 border whitespace-nowrap">
                Paquetes vendidos (Cash)
              </th>
              <th className="p-2 border whitespace-nowrap">
                Total vendido (Cash)
              </th>
              <th className="p-2 border whitespace-nowrap">Comisión Cash</th>
              <th className="p-2 border whitespace-nowrap">
                Paquetes fiados (Crédito)
              </th>
              <th className="p-2 border whitespace-nowrap">
                Total fiado (Crédito)
              </th>
              <th className="p-2 border whitespace-nowrap">Comisión Crédito</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={9}>
                  Cargando…
                </td>
              </tr>
            ) : vendorRows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={9}>
                  Sin datos de vendedores en el rango seleccionado.
                </td>
              </tr>
            ) : (
              vendorRows.map((v) => (
                <tr key={v.vendorId} className="text-center">
                  <td className="p-2 border whitespace-nowrap">
                    {v.vendorName}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openVendorModal(v.vendorId, v.vendorName, "ASSOCIATED")
                      }
                    >
                      {v.paquetesAsociados}
                    </button>
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openVendorModal(v.vendorId, v.vendorName, "REMAINING")
                      }
                    >
                      {v.paquetesRestantes}
                    </button>
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openVendorModal(v.vendorId, v.vendorName, "CASH")
                      }
                    >
                      {v.paquetesVendidos}
                    </button>
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(v.totalVendido)}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(v.comisionCash)}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() =>
                        openVendorModal(v.vendorId, v.vendorName, "CREDIT")
                      }
                    >
                      {v.paquetesFiados}
                    </button>
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(v.totalFiado)}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(v.comisionCredito)}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Transacciones del periodo */}
      <h3 className="text-lg font-semibold mb-2">Transacciones del periodo</h3>
      <div className="bg-white p-2 rounded shadow border w-full mb-6 overflow-x-auto">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border whitespace-nowrap">Fecha</th>
              <th className="p-2 border whitespace-nowrap">Cliente</th>
              <th className="p-2 border whitespace-nowrap">Tipo</th>
              <th className="p-2 border whitespace-nowrap">Paquetes</th>
              <th className="p-2 border whitespace-nowrap">
                Precio venta (prom.)
              </th>
              <th className="p-2 border whitespace-nowrap">Total</th>
              <th className="p-2 border whitespace-nowrap">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={7}>
                  Cargando…
                </td>
              </tr>
            ) : salesRows.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={7}>
                  Sin transacciones en el rango seleccionado.
                </td>
              </tr>
            ) : (
              salesRows.map((r) => (
                <tr key={r.id} className="text-center">
                  <td className="p-2 border whitespace-nowrap">{r.date}</td>
                  <td className="p-2 border whitespace-nowrap">{r.customer}</td>
                  <td className="p-2 border whitespace-nowrap">{r.type}</td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="underline text-blue-600 hover:text-blue-800"
                      onClick={() => openSaleModal(r.id)}
                    >
                      {r.paquetes}
                    </button>
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(r.avgPrice)}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    {money(r.total)}
                  </td>
                  <td className="p-2 border whitespace-nowrap">
                    <button
                      className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                      onClick={() => handleDeleteSale(r.id)}
                    >
                      Eliminar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Gastos */}
      <h3 className="text-lg font-semibold mb-2">Gastos del periodo</h3>
      <div className="bg-white p-2 rounded shadow border w-full">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Categoría</th>
              <th className="p-2 border">Descripción</th>
              <th className="p-2 border">Monto</th>
              <th className="p-2 border">Estado</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Cargando…
                </td>
              </tr>
            ) : expenses.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={5}>
                  Sin gastos en el rango seleccionado.
                </td>
              </tr>
            ) : (
              expenses
                .sort((a, b) => a.date.localeCompare(b.date))
                .map((g) => (
                  <tr key={g.id} className="text-center">
                    <td className="p-2 border">{g.date}</td>
                    <td className="p-2 border">{g.category || "—"}</td>
                    <td className="p-2 border">
                      {g.description ? (
                        <span title={g.description}>
                          {g.description.length > 40
                            ? g.description.slice(0, 40) + "…"
                            : g.description}
                        </span>
                      ) : (
                        "—"
                      )}
                    </td>
                    <td className="p-2 border">{money(g.amount)}</td>
                    <td className="p-2 border">{g.status || "—"}</td>
                  </tr>
                ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal detalle cliente */}
      {modalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-5xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Detalle cliente — {modalCustomer?.name || ""}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 xl:grid-cols-5 gap-3 mb-3">
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">
                  Total bruto (periodo)
                </div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalBruto)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Descuento (periodo)</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalDescuento)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">
                  Monto total fiado (periodo)
                </div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.totalFiado)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Saldo actual</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.saldoActual)}
                </div>
              </div>
              <div className="p-3 border rounded bg-gray-50">
                <div className="text-xs text-gray-600">Abonado (periodo)</div>
                <div className="text-xl font-semibold">
                  {money(modalKpis.abonadoPeriodo)}
                </div>
              </div>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Fecha compra</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">SKU</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">P. Unit</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Descuento</th>
                    <th className="p-2 border">Monto final</th>
                  </tr>
                </thead>
                <tbody>
                  {modalLoading ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : modalPieces.length === 0 ? (
                    <tr>
                      <td colSpan={8} className="p-4 text-center">
                        Sin paquetes fiados en el periodo.
                      </td>
                    </tr>
                  ) : (
                    modalPieces
                      .sort((a, b) => a.date.localeCompare(b.date))
                      .map((p, i) => (
                        <tr key={`${p.saleId}-${i}`} className="text-center">
                          <td className="p-2 border">{p.date}</td>
                          <td className="p-2 border">{p.productName}</td>
                          <td className="p-2 border">{p.sku || "—"}</td>
                          <td className="p-2 border">{p.qty}</td>
                          <td className="p-2 border">{money(p.unitPrice)}</td>
                          <td className="p-2 border">{money(p.lineTotal)}</td>
                          <td className="p-2 border">{money(p.discount)}</td>
                          <td className="p-2 border">{money(p.lineFinal)}</td>
                        </tr>
                      ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal detalle vendedor */}
      {vendorModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-5xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">{vendorModalTitle}</h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setVendorModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Fecha</th>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">SKU</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">P. Unit</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Descuento</th>
                    <th className="p-2 border">Monto final</th>
                    <th className="p-2 border">Comisión</th>
                  </tr>
                </thead>
                <tbody>
                  {vendorModalLoading ? (
                    <tr>
                      <td colSpan={9} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : vendorModalPieces.length === 0 ? (
                    <tr>
                      <td colSpan={9} className="p-4 text-center">
                        Sin paquetes para este vendedor en el periodo.
                      </td>
                    </tr>
                  ) : (
                    vendorModalPieces.map((p, i) => (
                      <tr key={`${p.saleId}-${i}`} className="text-center">
                        <td className="p-2 border">{p.date}</td>
                        <td className="p-2 border">{p.productName}</td>
                        <td className="p-2 border">{p.sku || "—"}</td>
                        <td className="p-2 border">{p.qty}</td>
                        <td className="p-2 border">{money(p.unitPrice)}</td>
                        <td className="p-2 border">{money(p.lineTotal)}</td>
                        <td className="p-2 border">{money(p.discount)}</td>
                        <td className="p-2 border">{money(p.lineFinal)}</td>
                        <td className="p-2 border">
                          {money(p.vendorCommissionAmount)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Modal detalle venta (transacciones) */}
      {saleModalOpen && saleModalSale && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-4xl p-4">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Detalle de venta — {saleModalSale.date}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setSaleModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded border overflow-x-auto mb-3">
              <table className="min-w-full text-sm">
                <thead className="bg-gray-100">
                  <tr>
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">SKU</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">P. Unit</th>
                    <th className="p-2 border">Monto</th>
                    <th className="p-2 border">Comisión</th>
                  </tr>
                </thead>
                <tbody>
                  {(saleModalSale.items || []).map((it, i) => {
                    const qty = Number(it.qty || 0);
                    const unitPrice = Number(it.unitPrice || 0);
                    const lineTotal = qty * unitPrice;
                    const commission = getItemCommission(saleModalSale, it);

                    return (
                      <tr key={i} className="text-center">
                        <td className="p-2 border">{it.productName}</td>
                        <td className="p-2 border">{it.sku || "—"}</td>
                        <td className="p-2 border">{qty}</td>
                        <td className="p-2 border">{money(unitPrice)}</td>
                        <td className="p-2 border">{money(lineTotal)}</td>
                        <td className="p-2 border">{money(commission)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div className="flex justify-between items-center">
              <div className="text-sm">
                <span className="font-semibold">Total venta:&nbsp;</span>
                {money(saleModalSale.total)}
              </div>
              <button
                className="text-xs bg-red-600 text-white px-3 py-1 rounded hover:bg-red-700"
                onClick={() => handleDeleteSale(saleModalSale.id)}
              >
                Eliminar venta
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
