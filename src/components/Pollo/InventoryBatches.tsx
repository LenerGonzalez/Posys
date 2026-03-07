// src/components/InventoryBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  collection,
  getDocs,
  orderBy,
  query,
  where,
  updateDoc,
  deleteDoc,
  doc,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { newBatch, markBatchAsPaid } from "../../Services/inventory";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { roundQty } from "../../Services/decimal";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import jsPDF from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// ===== Types =====
interface Product {
  id: string;
  name: string;
  category: string;
  measurement: string; // lb / unidad / etc.
  price: number;
  providerPrice?: number;
}

interface Batch {
  id: string;
  productId: string;
  productName: string;
  category: string;
  unit: string;
  quantity: number;
  remaining: number;
  purchasePrice: number;
  salePrice: number;
  invoiceTotal?: number;
  expectedTotal?: number;
  date: string; // yyyy-MM-dd
  createdAt: Timestamp;
  status: "PENDIENTE" | "PAGADO";
  notes?: string;
  paidAmount?: number;
  paidAt?: Timestamp;

  // ✅ metadata grupo/pedido
  batchGroupId?: string;
  orderName?: string;
}

type GroupRow = {
  groupId: string;
  orderName: string;
  date: string;
  typeLabel: string;
  status: "PENDIENTE" | "PAGADO";

  lbsIn: number;
  lbsRem: number;
  udsIn: number;
  udsRem: number;
  cajillasIn: number;
  cajillasRem: number;

  totalFacturado: number;
  totalEsperado: number;
  utilidadBruta: number;

  items: Batch[];
};

// ===== helpers =====
function uid(prefix = "LOT") {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// ===== Props =====
type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface InventoryBatchesProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function InventoryBatches({
  role = "",
  roles,
  sellerCandyId = "",
  currentUserEmail,
}: InventoryBatchesProps & { roles?: RoleProp[] | string[] }) {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const { refreshKey, refresh } = useManualRefresh();

  const subject = (roles && (roles as any).length ? roles : role) as any;
  const isAdmin = hasRole(subject, "admin");
  const canCreateBatch = isAdmin || hasRole(subject, "contador");

  // 🔎 Filtro por fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd"),
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd"),
  );

  // 🔵 Filtro por producto
  const [productFilterId, setProductFilterId] = useState<string>("");

  // 👉 Modal Crear Pedido/Lote
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ===== Form header del pedido =====
  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );

  // ===== Filtro unidad ANTES de seleccionar producto =====
  const [unitFilter, setUnitFilter] = useState<string>("lb");

  // ===== Inputs para agregar producto al pedido =====
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(NaN);
  const [salePrice, setSalePrice] = useState<number>(0);

  // items agregados al pedido
  type OrderItem = {
    tempId: string;
    productId: string;
    productName: string;
    category: string;
    unit: string;

    quantity: number;
    remaining: number;

    purchasePrice: number;
    salePrice: number;

    invoiceTotal: number;
    expectedTotal: number;
    utilidadBruta: number;
  };

  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null);
  const [editingGroupItems, setEditingGroupItems] = useState<Batch[]>([]);

  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailGroup, setDetailGroup] = useState<GroupRow | null>(null);

  // confirmar pago
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupRow | null>(null);
  // acordeón móvil: id del grupo expandido (null = ninguno)
  const [expandedGroupId, setExpandedGroupId] = useState<string | null>(null);
  const toggleGroupExpand = (groupId: string) =>
    setExpandedGroupId((prev) => (prev === groupId ? null : groupId));

  // estado para KPIs colapsable
  const [kpisExpanded, setKpisExpanded] = useState<boolean>(false);
  const toggleKpis = () => setKpisExpanded((v) => !v);

  type AvailabilityFilter = "all" | "with" | "without";
  const [availabilityFilter, setAvailabilityFilter] =
    useState<AvailabilityFilter>("all");
  const [mobileTypeOpen, setMobileTypeOpen] = useState<Record<string, boolean>>(
    {},
  );
  const toggleMobileType = (type: string) =>
    setMobileTypeOpen((prev) => ({
      ...prev,
      [type]: !(prev[type] ?? false),
    }));

  const formatQtyLabel = (lbs: number, uds: number) => {
    const parts: string[] = [];
    if (lbs > 0) parts.push(`${lbs.toFixed(3)} lb`);
    if (uds > 0) parts.push(`${uds.toFixed(3)} un`);
    if (parts.length === 0) return "0";
    return parts.join(" • ");
  };

  const isPounds = (u: string) => {
    const s = (u || "").toLowerCase();
    return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
  };

  // ===== Load =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");

      // products
      const psnap = await getDocs(collection(db, "products"));
      const prods: Product[] = [];
      psnap.forEach((d) => {
        const it = d.data() as any;
        if (it.active !== true) return;
        prods.push({
          id: d.id,
          name: it.name ?? it.productName ?? "(sin nombre)",
          category: it.category ?? "(sin categoría)",
          measurement: it.measurement ?? "lb",
          price: Number(it.price ?? 0),
          providerPrice: Object.prototype.hasOwnProperty.call(
            it,
            "providerPrice",
          )
            ? Number(it.providerPrice)
            : undefined,
        });
      });
      setProducts(prods);

      // batches
      const qB = query(
        collection(db, "inventory_batches"),
        orderBy("date", "desc"),
      );
      const bsnap = await getDocs(qB);

      const rows: Batch[] = [];
      bsnap.forEach((d) => {
        const b = d.data() as any;
        const qty = roundQty(Number(b.quantity || 0));
        const pBuy = Number(b.purchasePrice || 0);
        const pSell = Number(b.salePrice || 0);

        const derivedInvoice = Number((qty * pBuy).toFixed(2));
        const derivedExpected = Number((qty * pSell).toFixed(2));

        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          unit: b.unit,
          quantity: qty,
          remaining: roundQty(Number(b.remaining || 0)),
          purchasePrice: pBuy,
          salePrice: pSell,
          invoiceTotal:
            b.invoiceTotal != null ? Number(b.invoiceTotal) : derivedInvoice,
          expectedTotal:
            b.expectedTotal != null ? Number(b.expectedTotal) : derivedExpected,
          date: b.date,
          createdAt: b.createdAt,
          status: b.status,
          notes: b.notes,
          paidAmount: Number(b.paidAmount || 0),
          paidAt: b.paidAt,

          batchGroupId: b.batchGroupId,
          orderName: b.orderName,
        });
      });

      setBatches(rows);
      setLoading(false);
    })();
  }, [refreshKey]);

  // ===== Filtro en memoria =====
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  const productFilterLabel = useMemo(() => {
    if (!productFilterId) return "Todos";
    const prod = products.find((p) => p.id === productFilterId);
    if (!prod) return "Filtro activo";
    return `${prod.name} — ${prod.category}`;
  }, [productFilterId, products]);

  // ===== Totales arriba =====
  const totals = useMemo(() => {
    const totalFacturado = filteredBatches.reduce(
      (a, b) => a + Number(b.invoiceTotal || 0),
      0,
    );
    const totalEsperado = filteredBatches.reduce(
      (a, b) => a + Number(b.expectedTotal || 0),
      0,
    );

    const totalExistenciasMonetarias = Number(
      filteredBatches
        .reduce(
          (acc, b) => acc + Number(b.remaining || 0) * Number(b.salePrice || 0),
          0,
        )
        .toFixed(2),
    );

    let lbsIng = 0,
      lbsRem = 0,
      udsIng = 0,
      udsRem = 0;

    for (const b of filteredBatches) {
      if (isPounds(b.unit)) {
        lbsIng += b.quantity;
        lbsRem += b.remaining;
      } else {
        udsIng += b.quantity;
        udsRem += b.remaining;
      }
    }

    const qty = filteredBatches.reduce((a, b) => a + b.quantity, 0);
    const rem = filteredBatches.reduce((a, b) => a + b.remaining, 0);

    return {
      lbsIng,
      lbsRem,
      udsIng,
      udsRem,
      qty,
      rem,
      totalFacturado,
      totalEsperado,
      totalExistenciasMonetarias,
    };
  }, [filteredBatches]);

  const [ventasRealizadas, setVentasRealizadas] = useState<number>(0);
  const [ventasCount, setVentasCount] = useState<number>(0);
  const [abonosFecha, setAbonosFecha] = useState<number>(0);
  const [cuentasPorCobrar, setCuentasPorCobrar] = useState<number>(0);

  useEffect(() => {
    let mounted = true;
    (async () => {
      try {
        setVentasRealizadas(0);
        setAbonosFecha(0);

        if (!fromDate || !toDate) return;

        // 1) Ventas (salesV2) en rango — expand items into rows like FinancialDashboard
        const qs = query(
          collection(db, "salesV2"),
          // date is stored as yyyy-MM-dd
          // eslint-disable-next-line @typescript-eslint/ban-ts-comment
          // @ts-ignore
          where("date", ">=", fromDate),
          // @ts-ignore
          where("date", "<=", toDate),
        );
        const sSnap = await getDocs(qs);
        const sRows: Array<any> = [];
        sSnap.forEach((d) => {
          const x = d.data() as any;
          const baseDate = x.date ?? "";

          // If sale has items[], create ONE row per item
          if (Array.isArray(x.items) && x.items.length > 0) {
            x.items.forEach((it: any, idx: number) => {
              const prod = String(it.productName ?? "(sin nombre)");
              const qty = Number(it.qty ?? 0);
              const lineFinal =
                Number(it.lineFinal ?? 0) ||
                Math.max(
                  0,
                  Number(it.unitPrice || 0) * qty - Number(it.discount || 0),
                );
              sRows.push({
                id: `${d.id}#${idx}`,
                date: baseDate,
                productName: prod,
                quantity: qty,
                amount: lineFinal,
                allocations: Array.isArray(it.allocations)
                  ? it.allocations
                  : x.allocations,
                avgUnitCost: Number(it.avgUnitCost ?? x.avgUnitCost ?? 0),
                measurement: it.measurement ?? x.measurement ?? "",
                type: x.type ?? "CONTADO",
              });
            });
            return;
          }

          // Fallback to old shape
          sRows.push({
            id: d.id,
            date: baseDate,
            productName: x.productName ?? "(sin nombre)",
            quantity: Number(x.quantity ?? 0),
            amount: Number(x.amount ?? x.amountCharged ?? 0),
            allocations: Array.isArray(x.allocations) ? x.allocations : [],
            avgUnitCost: Number(x.avgUnitCost ?? 0),
            measurement: x.measurement ?? "",
            type: x.type ?? "CONTADO",
          });
        });

        // Sum only cash rows to match FinancialDashboard (type === 'CONTADO')
        let ventasSum = 0;
        let ventasDocsCount = 0;
        sRows.forEach((r) => {
          if (String(r.type ?? "").toUpperCase() === "CONTADO") {
            ventasSum += Number(r.amount || 0);
            // count unique sale ids (by splitting id before #)
            const saleId = String(r.id || "").split("#")[0];
            ventasDocsCount = ventasDocsCount || 0; // keep as number
          }
        });
        // For ventasDocsCount, count unique sale ids among cash rows
        const cashSaleIds = new Set<string>();
        sRows.forEach((r) => {
          if (String(r.type ?? "").toUpperCase() === "CONTADO") {
            const saleId = String(r.id || "").split("#")[0];
            if (saleId) cashSaleIds.add(saleId);
          }
        });
        ventasDocsCount = cashSaleIds.size;

        // 2) Abonos (ar_movements_pollo) - fetch all and resolve date (like FinancialDashboard)
        const aSnap = await getDocs(collection(db, "ar_movements_pollo"));
        let abonosSum = 0;
        const resolveMovementDate = (m: any) => {
          if (m?.date) return String(m.date);
          if (m?.createdAt?.toDate)
            return format(m.createdAt.toDate(), "yyyy-MM-dd");
          return "";
        };

        // accumulate balances and last movement date per customer
        const balanceByCustomer: Record<string, number> = {};
        const lastMoveByCustomer: Record<string, string> = {};

        aSnap.forEach((d) => {
          const m = d.data() as any;
          const amount = Number(m.amount || 0);
          const customerId = String(m.customerId ?? "").trim();
          if (customerId) {
            balanceByCustomer[customerId] =
              (balanceByCustomer[customerId] || 0) + amount;
            const md = resolveMovementDate(m);
            if (md) {
              const prev = lastMoveByCustomer[customerId] || "";
              if (!prev || md > prev) lastMoveByCustomer[customerId] = md;
            }
          }

          const type = String(m.type ?? "").toUpperCase();
          if (type !== "ABONO") return;
          const moveDate = resolveMovementDate(m);
          if (!moveDate) return;
          if (moveDate >= fromDate && moveDate <= toDate) {
            abonosSum += Math.abs(amount);
          }
        });

        // cuentas por cobrar: sum positive balances whose last movement falls in the period
        let cuentasSum = 0;
        Object.keys(balanceByCustomer).forEach((cid) => {
          const bal = Number(balanceByCustomer[cid] || 0);
          const last = lastMoveByCustomer[cid] || "";
          if (bal > 0 && last && last >= fromDate && last <= toDate) {
            cuentasSum += bal;
          }
        });

        if (!mounted) return;
        setVentasRealizadas(Number(ventasSum.toFixed(2)));
        setVentasCount(ventasDocsCount);
        setAbonosFecha(Number(abonosSum.toFixed(2)));
        setCuentasPorCobrar(Number(cuentasSum.toFixed(2)));
      } catch (e) {
        console.error("Error cargando ventas/abonos para KPIs:", e);
        if (mounted) {
          setVentasRealizadas(0);
          setAbonosFecha(0);
          setCuentasPorCobrar(0);
        }
      }
    })();
    return () => {
      mounted = false;
    };
  }, [fromDate, toDate, refreshKey]);

  // ===== Agrupar en pedidos/lotes =====
  const groupedRows = useMemo<GroupRow[]>(() => {
    const map = new Map<string, Batch[]>();

    for (const b of filteredBatches) {
      const gid = (b.batchGroupId && String(b.batchGroupId).trim()) || b.id;
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid)!.push(b);
    }

    const rows: GroupRow[] = [];
    for (const [groupId, items] of map.entries()) {
      const ordered = [...items].sort((a, b) => {
        const sa = a.createdAt?.seconds ?? 0;
        const sb = b.createdAt?.seconds ?? 0;
        return sb - sa;
      });

      const date = ordered[0]?.date || "";

      const orderNameLocal =
        String(ordered[0]?.orderName || "").trim() ||
        `Pedido ${date || ""}`.trim() ||
        "Pedido";

      const cats = new Set(
        ordered.map((x) => String(x.category || "").trim()).filter(Boolean),
      );
      const typeLabel =
        cats.size === 1 ? Array.from(cats)[0].toUpperCase() : "MIXTO";

      const status: "PENDIENTE" | "PAGADO" = ordered.some(
        (x) => x.status === "PENDIENTE",
      )
        ? "PENDIENTE"
        : "PAGADO";

      const isCajilla = (u: string) =>
        String(u || "")
          .toLowerCase()
          .trim() === "cajilla";

      const lbsIn = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.quantity || 0) : 0),
          0,
        ),
      );
      const lbsRem = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.remaining || 0) : 0),
          0,
        ),
      );

      const cajillasIn = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isCajilla(x.unit) ? Number(x.quantity || 0) : 0),
          0,
        ),
      );
      const cajillasRem = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isCajilla(x.unit) ? Number(x.remaining || 0) : 0),
          0,
        ),
      );

      const udsIn = roundQty(
        ordered.reduce(
          (acc, x) =>
            acc +
            (!isPounds(x.unit) && !isCajilla(x.unit)
              ? Number(x.quantity || 0)
              : 0),
          0,
        ),
      );
      const udsRem = roundQty(
        ordered.reduce(
          (acc, x) =>
            acc +
            (!isPounds(x.unit) && !isCajilla(x.unit)
              ? Number(x.remaining || 0)
              : 0),
          0,
        ),
      );

      const totalFacturado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.invoiceTotal || 0), 0)
          .toFixed(2),
      );
      const totalEsperado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.expectedTotal || 0), 0)
          .toFixed(2),
      );
      const utilidadBruta = Number((totalEsperado - totalFacturado).toFixed(2));

      rows.push({
        groupId,
        orderName: orderNameLocal,
        date,
        typeLabel,
        status,
        lbsIn,
        lbsRem,
        udsIn,
        udsRem,
        cajillasIn,
        cajillasRem,
        totalFacturado,
        totalEsperado,
        utilidadBruta,
        items: ordered,
      });
    }

    rows.sort((a, b) =>
      a.date === b.date
        ? a.groupId < b.groupId
          ? 1
          : -1
        : a.date < b.date
          ? 1
          : -1,
    );

    return rows;
  }, [filteredBatches]);

  const groupedRowsMobile = useMemo(() => {
    if (availabilityFilter === "all") return groupedRows;
    return groupedRows.filter((g) => {
      const available = g.lbsRem > 0 || g.udsRem > 0;
      return availabilityFilter === "with" ? available : !available;
    });
  }, [groupedRows, availabilityFilter]);

  const groupedRowsMobileByType = useMemo(() => {
    const map = new Map<string, GroupRow[]>();
    groupedRowsMobile.forEach((g) => {
      const key = g.typeLabel || "MIXTO";
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(g);
    });
    return Array.from(map.entries()).map(([type, items]) => ({ type, items }));
  }, [groupedRowsMobile]);

  // ===== productos filtrados por unidad =====
  const productsByUnit = useMemo(() => {
    const u = String(unitFilter || "")
      .toLowerCase()
      .trim();
    const list = products.filter(
      (p) =>
        String(p.measurement || "")
          .toLowerCase()
          .trim() === u,
    );
    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [products, unitFilter]);

  // autocompletar precio proveedor si el producto tiene `providerPrice`
  useEffect(() => {
    const existing = orderItems.find((it) => it.productId === productId);
    if (existing) {
      setQuantity(Number(existing.quantity || 0));
      setPurchasePrice(Number(existing.purchasePrice || 0));
      setSalePrice(Number(existing.salePrice || 0));
      return;
    }

    const p = products.find((x) => x.id === productId);
    if (p) {
      setQuantity(0);
      setSalePrice(Number(p.price || 0));
      if (p.providerPrice != null && Number.isFinite(Number(p.providerPrice))) {
        setPurchasePrice(Number(p.providerPrice));
      } else {
        setPurchasePrice(NaN);
      }
    } else {
      setQuantity(0);
      setSalePrice(0);
      setPurchasePrice(NaN);
    }
  }, [productId, products, refreshKey, orderItems]);

  // ===== Crear pedido: agregar item =====
  const addItemToOrder = () => {
    setMsg("");

    const p = products.find((x) => x.id === productId);
    if (!p) return setMsg("Selecciona un producto.");
    if (quantity <= 0 || !Number.isFinite(purchasePrice) || purchasePrice <= 0)
      return setMsg("Completa libras a ingresar y precio proveedor.");

    const qtyR = roundQty(quantity);
    const unit = p.measurement;

    const inv = Number((qtyR * Number(purchasePrice || 0)).toFixed(2));
    const exp = Number((qtyR * Number(salePrice || 0)).toFixed(2));
    const util = Number((exp - inv).toFixed(2));

    const existingIndex = orderItems.findIndex((it) => it.productId === p.id);
    if (existingIndex >= 0) {
      setOrderItems((prev) =>
        prev.map((it, idx) =>
          idx !== existingIndex
            ? it
            : {
                ...it,
                quantity: qtyR,
                remaining: qtyR,
                purchasePrice: Number(purchasePrice || 0),
                salePrice: Number(salePrice || 0),
                invoiceTotal: inv,
                expectedTotal: exp,
                utilidadBruta: util,
              },
        ),
      );
    } else {
      setOrderItems((prev) => [
        ...prev,
        {
          tempId: uid("IT"),
          productId: p.id,
          productName: p.name,
          category: p.category,
          unit,
          quantity: qtyR,
          remaining: qtyR,
          purchasePrice: Number(purchasePrice || 0),
          salePrice: Number(salePrice || 0),
          invoiceTotal: inv,
          expectedTotal: exp,
          utilidadBruta: util,
        },
      ]);
    }

    setProductId("");
    setQuantity(NaN);
    setPurchasePrice(NaN);
    setSalePrice(0);
  };

  const removeOrderItem = (tempId: string) => {
    setOrderItems((prev) => prev.filter((x) => x.tempId !== tempId));
  };

  const updateOrderItemField = (
    tempId: string,
    field: "quantity" | "purchasePrice" | "salePrice",
    value: number,
  ) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.tempId !== tempId) return it;

        const updated = { ...it } as OrderItem;

        if (field === "quantity") {
          updated.quantity = roundQty(Math.max(0, value));
          // en creación = iguales
          if (!editingGroupId) updated.remaining = updated.quantity;
        }
        if (field === "purchasePrice")
          updated.purchasePrice = Math.max(0, Number(value || 0));
        if (field === "salePrice")
          updated.salePrice = Math.max(0, Number(value || 0));

        updated.invoiceTotal = Number(
          (updated.quantity * updated.purchasePrice).toFixed(2),
        );
        updated.expectedTotal = Number(
          (updated.quantity * updated.salePrice).toFixed(2),
        );
        updated.utilidadBruta = Number(
          (updated.expectedTotal - updated.invoiceTotal).toFixed(2),
        );

        return updated;
      }),
    );
  };

  const orderKpis = useMemo(() => {
    const lbsIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const lbsRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );
    const isCajilla = (u: string) =>
      String(u || "")
        .toLowerCase()
        .trim() === "cajilla";
    const isUnit = (u: string) => !isPounds(u) && !isCajilla(u);

    const unitsIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isUnit(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const unitsRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isUnit(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );

    const cajillasIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isCajilla(it.unit) ? Number(it.quantity || 0) : 0),
        0,
      ),
    );
    const cajillasRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isCajilla(it.unit) ? Number(it.remaining || 0) : 0),
        0,
      ),
    );

    const totalFacturado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.invoiceTotal || 0), 0)
        .toFixed(2),
    );
    const totalEsperado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.expectedTotal || 0), 0)
        .toFixed(2),
    );
    const utilidadBruta = Number((totalEsperado - totalFacturado).toFixed(2));

    return {
      lbsIn,
      lbsRem,
      unitsIn,
      unitsRem,
      cajillasIn,
      cajillasRem,
      totalFacturado,
      totalEsperado,
      utilidadBruta,
    };
  }, [orderItems]);

  const resetOrderModal = () => {
    setEditingGroupId(null);
    setEditingGroupItems([]);
    setOrderName("");
    setOrderDate(format(new Date(), "yyyy-MM-dd"));
    setUnitFilter("lb");
    setProductId("");
    setQuantity(0);
    setPurchasePrice(NaN);
    setSalePrice(0);
    setOrderItems([]);
  };

  // ===== Guardar pedido =====
  const saveOrder = async () => {
    setMsg("");
    if (!orderItems.length)
      return setMsg("Agrega al menos un producto al pedido.");

    const dateStr = orderDate || format(new Date(), "yyyy-MM-dd");
    const name = String(orderName || "").trim() || `Pedido ${dateStr}`;
    const groupId = editingGroupId || uid("BATCH");

    try {
      // crear
      if (!editingGroupId) {
        for (const it of orderItems) {
          await newBatch({
            productId: it.productId,
            productName: it.productName,
            category: it.category,
            unit: it.unit,
            quantity: roundQty(it.quantity),
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            date: dateStr,
            notes: "",
            batchGroupId: groupId,
            orderName: name,
          });
        }

        setMsg("✅ Pedido creado");
        setShowCreateModal(false);
        resetOrderModal();
        refresh();
        return;
      }

      // editar (upsert + deletes)
      const existing = editingGroupItems;
      const existingByProduct = new Map<string, Batch>();
      for (const b of existing) existingByProduct.set(b.productId, b);

      const productIdsNew = new Set(orderItems.map((x) => x.productId));

      // update/create
      for (const it of orderItems) {
        const oldDoc = existingByProduct.get(it.productId);
        const qtyR = roundQty(it.quantity);

        if (oldDoc) {
          const consumido = roundQty(oldDoc.quantity - oldDoc.remaining);
          const newRemaining = Math.max(0, roundQty(qtyR - consumido));

          await updateDoc(doc(db, "inventory_batches", oldDoc.id), {
            date: dateStr,
            orderName: name,
            batchGroupId: groupId,
            quantity: qtyR,
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            remaining: newRemaining,
          });
        } else {
          await newBatch({
            productId: it.productId,
            productName: it.productName,
            category: it.category,
            unit: it.unit,
            quantity: qtyR,
            purchasePrice: Number(it.purchasePrice || 0),
            salePrice: Number(it.salePrice || 0),
            invoiceTotal: Number(it.invoiceTotal || 0),
            expectedTotal: Number(it.expectedTotal || 0),
            date: dateStr,
            notes: "",
            batchGroupId: groupId,
            orderName: name,
          });
        }
      }

      // delete removed
      for (const b of existing) {
        if (!productIdsNew.has(b.productId)) {
          await deleteDoc(doc(db, "inventory_batches", b.id));
        }
      }

      setMsg("✅ Pedido actualizado");
      setShowCreateModal(false);
      resetOrderModal();
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al guardar pedido");
    }
  };

  // ===== Acciones de grupo =====
  const openDetail = (g: GroupRow) => {
    setDetailGroup(g);
    setShowDetailModal(true);
  };

  const openForEdit = (g: GroupRow) => {
    setEditingGroupId(g.groupId);
    setEditingGroupItems(g.items);

    setOrderName(g.orderName);
    setOrderDate(g.date || format(new Date(), "yyyy-MM-dd"));

    const items: OrderItem[] = g.items.map((b) => {
      const inv = Number(b.invoiceTotal || 0);
      const exp = Number(b.expectedTotal || 0);
      return {
        tempId: uid("IT"),
        productId: b.productId,
        productName: b.productName,
        category: b.category,
        unit: b.unit,
        quantity: roundQty(b.quantity),
        remaining: roundQty(b.remaining),
        purchasePrice: Number(b.purchasePrice || 0),
        salePrice: Number(b.salePrice || 0),
        invoiceTotal: inv,
        expectedTotal: exp,
        utilidadBruta: Number((exp - inv).toFixed(2)),
      };
    });

    setOrderItems(items);
    setShowCreateModal(true);
  };

  const deleteGroup = async (g: GroupRow) => {
    const ok = confirm(`¿Eliminar el pedido "${g.orderName}" del ${g.date}?`);
    if (!ok) return;

    try {
      for (const b of g.items) {
        await deleteDoc(doc(db, "inventory_batches", b.id));
      }
      setMsg("🗑️ Pedido eliminado");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar pedido");
    }
  };

  const payGroup = (g: GroupRow) => {
    setSelectedGroup(g);
    setShowPayDialog(true);
  };

  const confirmPayGroupNow = async () => {
    if (!selectedGroup) return;

    try {
      for (const b of selectedGroup.items) {
        if (b.status !== "PENDIENTE") continue;

        await markBatchAsPaid(b.id);
        await updateDoc(doc(db, "inventory_batches", b.id), { remaining: 0 });

        /* Disabled: do not auto-create a sale when paying a batch.
           Previously this block created a salesV2 document for the paid batch.
           We keep marking the batch as paid and setting remaining: 0 only.

        // const saleDoc = {
        //   date: b.date,
        //   productName: b.productName,
        //   quantity: b.quantity,
        //   amount: Number(
        //     (b.expectedTotal ?? b.salePrice * b.quantity).toFixed(2),
        //   ),
        //   allocations: [
        //     {
        //       batchId: b.id,
        //       qty: b.quantity,
        //       unitCost: b.purchasePrice,
        //       lineCost: Number((b.purchasePrice * b.quantity).toFixed(2)),
        //     },
        //   ],
        //   avgUnitCost: b.purchasePrice,
        //   measurement: b.unit,
        //   createdAt: Timestamp.now(),
        //   autoGeneratedFromInventory: true,
        // };
        // await addDoc(collection(db, "salesV2"), saleDoc);
        */
      }

      setMsg("✅ Pedido pagado y reflejado como venta");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al pagar pedido");
    } finally {
      setShowPayDialog(false);
      setSelectedGroup(null);
    }
  };

  const cancelPayDialog = () => {
    setShowPayDialog(false);
    setSelectedGroup(null);
  };

  const handleExportInventoryPdf = () => {
    const doc = new jsPDF({
      unit: "pt",
      format: "a4",
      orientation: "landscape",
    });
    const title = "Inventario de Pollo";
    const subtitle = `Rango: ${fromDate || "(sin inicio)"} a ${
      toDate || "(sin fin)"
    }`;
    const productLine = `Producto: ${productFilterLabel}`;
    const qtyFmt = (n: number) => Number(n || 0).toFixed(3);

    let cursorY = 40;

    doc.setFontSize(16);
    doc.text(title, 40, cursorY);
    cursorY += 16;

    doc.setFontSize(10);
    doc.text(subtitle, 40, cursorY);
    cursorY += 12;
    doc.text(productLine, 40, cursorY);
    cursorY += 14;

    const bumpCursor = () => {
      cursorY = (doc as any).lastAutoTable?.finalY
        ? (doc as any).lastAutoTable.finalY + 18
        : cursorY + 18;
    };

    autoTable(doc, {
      startY: cursorY,
      head: [["KPI", "Valor"]],
      body: [
        ["Libras ingresadas", qtyFmt(totals.lbsIng)],
        ["Libras restantes", qtyFmt(totals.lbsRem)],
        ["Unidades ingresadas", qtyFmt(totals.udsIng)],
        ["Unidades restantes", qtyFmt(totals.udsRem)],
        ["Total esperado", money(totals.totalEsperado)],
        ["Total facturado", money(totals.totalFacturado)],
        [
          "Ganancia sin gastos",
          money(totals.totalEsperado - totals.totalFacturado),
        ],
        ["Existencias monetarias", money(totals.totalExistenciasMonetarias)],
        ["Cantidad de lotes", filteredBatches.length.toString()],
      ],
      styles: { fontSize: 9 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    bumpCursor();

    autoTable(doc, {
      startY: cursorY,
      head: [
        [
          "Fecha",
          "Pedido",
          "Tipo",
          "Lb In",
          "Lb Rem",
          "Ud In",
          "Ud Rem",
          "Facturado",
          "Esperado",
          "Utilidad",
          "Estado",
        ],
      ],
      body: groupedRows.map((g) => [
        g.date,
        g.orderName,
        g.typeLabel,
        qtyFmt(g.lbsIn),
        qtyFmt(g.lbsRem),
        qtyFmt(g.udsIn),
        qtyFmt(g.udsRem),
        money(g.totalFacturado),
        money(g.totalEsperado),
        money(g.utilidadBruta),
        g.status,
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [245, 245, 245], textColor: [0, 0, 0] },
    });

    bumpCursor();

    groupedRows.forEach((group) => {
      doc.setFontSize(11);
      doc.text(
        `Pedido: ${group.orderName} (${group.date}) — ${group.typeLabel}`,
        40,
        cursorY,
      );
      cursorY += 12;

      autoTable(doc, {
        startY: cursorY,
        head: [
          [
            "Producto",
            "Unidad",
            "Ingresado",
            "Restante",
            "Precio compra",
            "Precio venta",
            "Total facturado",
            "Total esperado",
            "Utilidad",
            "Estado",
          ],
        ],
        body: group.items.map((item) => [
          item.productName,
          (item.unit || "").toUpperCase(),
          qtyFmt(item.quantity),
          qtyFmt(item.remaining),
          money(item.purchasePrice),
          money(item.salePrice),
          money(item.invoiceTotal || item.purchasePrice * item.quantity),
          money(item.expectedTotal || item.salePrice * item.quantity),
          money(
            (item.expectedTotal || item.salePrice * item.quantity) -
              (item.invoiceTotal || item.purchasePrice * item.quantity),
          ),
          item.status,
        ]),
        styles: { fontSize: 8 },
        headStyles: { fillColor: [230, 230, 230], textColor: [0, 0, 0] },
      });

      bumpCursor();
    });

    doc.save(
      `inventario_pollo_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.pdf`,
    );
  };

  const handleExportInventoryCsv = () => {
    try {
      const headers = [
        "batchId",
        "batchGroupId",
        "orderName",
        "date",
        "productId",
        "productName",
        "category",
        "unit",
        "quantity",
        "remaining",
        "purchasePrice",
        "salePrice",
        "invoiceTotal",
        "expectedTotal",
        "utilidadBruta",
        "status",
        "notes",
        "paidAmount",
        "paidAt",
      ];

      const csvEscape = (v: any) => {
        if (v == null) return "";
        const s = String(v);
        return `"${s.replace(/"/g, '""')}"`;
      };

      const rows = filteredBatches.map((b) => {
        const paidAtStr = (b as any).paidAt
          ? typeof (b as any).paidAt?.toDate === "function"
            ? (b as any).paidAt.toDate().toISOString()
            : String((b as any).paidAt)
          : "";

        const utilidad = Number(
          (Number(b.expectedTotal || 0) - Number(b.invoiceTotal || 0)).toFixed(
            2,
          ),
        );

        return [
          b.id,
          b.batchGroupId || "",
          b.orderName || "",
          b.date || "",
          b.productId || "",
          b.productName || "",
          b.category || "",
          b.unit || "",
          b.quantity ?? "",
          b.remaining ?? "",
          b.purchasePrice ?? "",
          b.salePrice ?? "",
          b.invoiceTotal ?? "",
          b.expectedTotal ?? "",
          utilidad,
          b.status || "",
          b.notes || "",
          b.paidAmount ?? "",
          paidAtStr,
        ]
          .map(csvEscape)
          .join(",");
      });

      const csvContent = `\uFEFF${headers.map(csvEscape).join(",")}\r\n${rows.join("\r\n")}`;

      const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const filename = `inventario_pollo_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.csv`;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setMsg(`✅ CSV exportado: ${filename}`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al exportar CSV");
    }
  };

  const handleExportInventoryXlsx = () => {
    try {
      const rows: any[] = [];

      // Flatten groupedRows -> each item inside a group becomes one row
      groupedRows.forEach((g) => {
        for (const b of g.items) {
          const utilidad = Number(
            (
              Number(b.expectedTotal || 0) - Number(b.invoiceTotal || 0)
            ).toFixed(2),
          );

          const paidAtStr = (b as any).paidAt
            ? typeof (b as any).paidAt?.toDate === "function"
              ? (b as any).paidAt.toDate().toISOString()
              : String((b as any).paidAt)
            : "";

          rows.push({
            groupId: g.groupId,
            orderName: g.orderName,
            groupDate: g.date,
            productId: b.productId,
            productName: b.productName,
            category: b.category,
            unit: b.unit,
            quantity: b.quantity,
            remaining: b.remaining,
            purchasePrice: b.purchasePrice,
            salePrice: b.salePrice,
            invoiceTotal: b.invoiceTotal,
            expectedTotal: b.expectedTotal,
            utilidadBruta: utilidad,
            status: b.status,
            notes: b.notes || "",
            paidAmount: b.paidAmount || "",
            paidAt: paidAtStr,
          });
        }
      });

      if (!rows.length) {
        setMsg("Sin datos para exportar XLSX.");
        return;
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Inventario");

      const filename = `inventario_pollo_sabana_${fromDate || "sin_desde"}_a_${toDate || "sin_hasta"}.xlsx`;
      XLSX.writeFile(wb, filename);
      setMsg(`✅ XLSX exportado: ${filename}`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al exportar XLSX");
    }
  };

  // ===== UI =====
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-wrap items-center justify-between gap-2 mb-3">
        <h2 className="text-2xl font-bold">Inventario</h2>

        <div className="flex items-center gap-2">
          {/* Exportar PDF hidden per request */}

          <button
            className="px-2 py-1 rounded-xl text-sm md:px-3 md:py-2 md:rounded-2xl md:text-base bg-green-600 text-white hover:bg-green-700"
            type="button"
            onClick={handleExportInventoryCsv}
            disabled={loading}
          >
            Exportar Productos
          </button>
          <button
            className="px-2 py-1 rounded-xl text-sm md:px-3 md:py-2 md:rounded-2xl md:text-base bg-amber-600 text-white hover:bg-amber-700"
            type="button"
            onClick={handleExportInventoryXlsx}
            disabled={loading}
          >
            Exportar Lotes
          </button>

          {canCreateBatch && (
            <button
              className="px-2 py-1 rounded-xl text-sm md:px-3 md:py-2 md:rounded-2xl md:text-base bg-blue-600 text-white hover:bg-blue-700"
              type="button"
              onClick={() => {
                resetOrderModal();
                setShowCreateModal(true);
              }}
            >
              Crear Lote
            </button>
          )}
        </div>
      </div>

      {/* 🔎 Filtros */}
      <div className="bg-white p-3 rounded shadow-2xl border mb-4 flex flex-wrap items-end gap-3 text-sm">
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

        <div className="flex flex-col min-w-[240px]">
          <label className="font-semibold">Producto</label>
          <select
            className="border rounded px-2 py-1"
            value={productFilterId}
            onChange={(e) => setProductFilterId(e.target.value)}
          >
            <option value="">Todos</option>
            {products.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name} — {p.category}
              </option>
            ))}
          </select>
        </div>

        <button
          className="px-3 rounded-2xl shadow-2xl py-1 bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProductFilterId("");
          }}
        >
          Quitar filtro
        </button>

        <div className="ml-auto">
          <RefreshButton onClick={() => refresh()} loading={loading} />
        </div>
      </div>

      {/* KPIs: 3 tarjetas */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mb-4">
        <div className="bg-gradient-to-r from-blue-500 to-blue-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M21 16V8a2 2 0 0 0-2-2h-3V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v2H5a2 2 0 0 0-2 2v8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <rect
                x="3"
                y="12"
                width="18"
                height="8"
                rx="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="text-xl font-semibold opacity-90">
              Resumen cantidades
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex justify-between">
              <span>Libras ingresadas</span>
              <span className="font-semibold">{totals.lbsIng.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Libras restantes</span>
              <span className="font-semibold">{totals.lbsRem.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Unidades ingresadas</span>
              <span className="font-semibold">{totals.udsIng.toFixed(3)}</span>
            </div>
            <div className="flex justify-between">
              <span>Unidades restantes</span>
              <span className="font-semibold">{totals.udsRem.toFixed(3)}</span>
            </div>
            <div className="flex justify-between pt-2 border-t border-white/30">
              <span>Cantidad de lotes (filtro)</span>
              <span className="font-semibold">
                {filteredBatches.length.toLocaleString()}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M12 1v4M17 7H7a4 4 0 0 0 0 8h10a4 4 0 0 0 0-8z"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path d="M12 11v6" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <div className="text-xl font-semibold opacity-90">Finanzas</div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex justify-between">
              <span>Total esperado (ventas)</span>
              <span className="font-semibold">
                {money(totals.totalEsperado)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Total facturado</span>
              <span className="font-semibold">
                {money(totals.totalFacturado)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Utilidad bruta</span>
              <span className="font-semibold">
                {money(totals.totalEsperado - totals.totalFacturado)}
              </span>
            </div>
            <div className="flex justify-between">
              <span>Existencias monetarias</span>
              <span className="font-semibold">
                {money(totals.totalExistenciasMonetarias)}
              </span>
            </div>
          </div>
        </div>

        <div className="bg-gradient-to-r from-amber-500 to-amber-600 text-white rounded-2xl p-4 shadow-md">
          <div className="flex items-center gap-3">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              className="w-6 h-6"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <path
                d="M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-6"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M7 12V8a5 5 0 0 1 10 0v4"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
              <path
                d="M12 17v.01"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            <div className="text-xl font-semibold opacity-90">
              Cobros y Abonos
            </div>
          </div>
          <div className="mt-3 grid grid-cols-1 gap-2 text-[16px]">
            <div className="flex flex-col">
              <div className="flex justify-between items-baseline">
                <span>Ventas realizadas</span>
                <span className="font-semibold">{money(ventasRealizadas)}</span>
              </div>
              <div className="text-xs opacity-90 mt-1">
                Ventas (cash): {ventasCount}
              </div>
            </div>
            <div className="flex justify-between">
              <span>Abonos a la fecha</span>
              <span className="font-semibold">{money(abonosFecha)}</span>
            </div>
            <div className="flex justify-between">
              <span>Cuentas por cobrar</span>
              <span className="font-semibold">{money(cuentasPorCobrar)}</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== */}
      {/* ✅ MOBILE FIRST: CARDS */}
      {/* ===================== */}
      <div className="md:hidden space-y-3">
        <div className="flex gap-2">
          {(
            [
              { key: "all", label: "Todos" },
              { key: "with", label: "Con disponibilidad" },
              { key: "without", label: "Sin disponibilidad" },
            ] as const
          ).map((opt) => {
            const active = availabilityFilter === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => setAvailabilityFilter(opt.key)}
                className={`flex-1 px-3 py-2 rounded-xl text-sm font-semibold shadow ${
                  active
                    ? "bg-blue-600 text-white"
                    : "bg-gray-100 text-gray-700"
                }`}
              >
                {opt.label}
              </button>
            );
          })}
        </div>

        {loading ? (
          <div className="bg-white border rounded-2xl p-4 shadow">
            Cargando…
          </div>
        ) : groupedRowsMobile.length === 0 ? (
          <div className="bg-white border rounded-2xl p-4 shadow text-center">
            {availabilityFilter === "with"
              ? "Sin lotes con disponibilidad."
              : availabilityFilter === "without"
                ? "Sin lotes sin disponibilidad."
                : "Sin lotes"}
          </div>
        ) : (
          groupedRowsMobileByType.map(({ type, items }) => {
            const openType = mobileTypeOpen[type] ?? false;
            return (
              <div key={type} className="bg-white border rounded-2xl">
                <button
                  type="button"
                  onClick={() => toggleMobileType(type)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left"
                >
                  <div>
                    <div className="font-semibold">{type}</div>
                    <div className="text-xs text-gray-500">
                      {items.length} {items.length === 1 ? "lote" : "lotes"}
                    </div>
                  </div>
                  <span className="text-xs text-gray-500">
                    {openType ? "Cerrar" : "Ver"}
                  </span>
                </button>

                {openType && (
                  <div className="space-y-3 px-2 pb-4">
                    {items.map((g) => {
                      const expanded = expandedGroupId === g.groupId;
                      const hasRemaining = g.lbsRem > 0 || g.udsRem > 0;
                      return (
                        <div
                          key={g.groupId}
                          className="bg-gray-50 border rounded-2xl"
                        >
                          <div
                            className="p-4 flex items-start justify-between gap-3 cursor-pointer"
                            onClick={() => toggleGroupExpand(g.groupId)}
                          >
                            <div className="min-w-0">
                              <div className="font-semibold text-lg">
                                {g.date}
                                <div className="text-sm text-gray-500">
                                  Producto: {g.typeLabel}
                                </div>
                              </div>
                              <div className="text-sm text-gray-400 mt-1 truncate">
                                <span className="text-sm text-gray-500 mr-1">
                                  {g.orderName}
                                </span>
                                <span className="text-sm text-gray-500">
                                  {Array.from(
                                    new Set(
                                      g.items.map((it) =>
                                        String(it.productName || "").trim(),
                                      ),
                                    ),
                                  )
                                    .filter(Boolean)
                                    .slice(0, 6)
                                    .join(", ")}
                                  {g.items.length > 6 ? "…" : ""}
                                </span>
                              </div>
                            </div>

                            <div className="flex items-center gap-3">
                              <span
                                className={`px-2 py-1 rounded text-xs shrink-0 ${
                                  g.status === "PAGADO"
                                    ? "bg-green-100 text-green-700"
                                    : "bg-yellow-100 text-yellow-700"
                                }`}
                              >
                                {g.status}
                              </span>
                            </div>
                          </div>
                          <div className="pb-4 p-4 flex items-start justify-between gap-1 cursor-pointer">
                            <div className="px-2 py-1 rounded text-xs shrink-0 bg-green-100 font-semibold text-gray-700">
                              Ingresado: {formatQtyLabel(g.lbsIn, g.udsIn)}
                            </div>
                            <span
                              className={`px-2 py-1 rounded text-xs shrink-0 ${
                                hasRemaining
                                  ? "bg-green-100 font-semibold text-gray-700"
                                  : "bg-red-100 font-semibold text-red-700"
                              }`}
                            >
                              Disponible: {formatQtyLabel(g.lbsRem, g.udsRem)}
                            </span>
                          </div>

                          {expanded && (
                            <div className="p-4 pt-0">
                              <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Tipo
                                  </div>
                                  <div className="font-semibold">
                                    {g.typeLabel}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Utilidad bruta
                                  </div>
                                  <div className="font-semibold">
                                    {money(g.utilidadBruta)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Lbs ingresadas
                                  </div>
                                  <div className="font-semibold">
                                    {g.lbsIn.toFixed(3)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2">
                                  <div className="text-[11px] text-gray-500">
                                    Lbs restantes
                                  </div>
                                  <div className="font-semibold">
                                    {g.lbsRem.toFixed(3)}
                                  </div>
                                </div>

                                <div className="bg-white rounded-xl p-2 col-span-2">
                                  <div className="flex justify-between text-[11px] text-gray-500">
                                    <span>Total facturado</span>
                                    <span>Total esperado</span>
                                  </div>
                                  <div className="flex justify-between font-semibold">
                                    <span>{money(g.totalFacturado)}</span>
                                    <span>{money(g.totalEsperado)}</span>
                                  </div>
                                </div>

                                {g.items.length > 0 && (
                                  <div className="bg-gray-50 rounded-xl p-2 col-span-2 border border-gray-100">
                                    <div className="text-[11px] text-gray-500 mb-2">
                                      Productos asociados
                                    </div>
                                    <div className="space-y-1">
                                      {g.items.map((item) => (
                                        <div
                                          key={item.id}
                                          className="flex items-center text-xs justify-between gap-2"
                                        >
                                          <div className="font-semibold text-gray-800 truncate">
                                            {item.productName}
                                          </div>
                                          <div className="text-gray-600 text-right">
                                            <div>
                                              Ingresado:{" "}
                                              {item.quantity.toFixed(3)}
                                            </div>
                                            <div>
                                              Restante:{" "}
                                              {item.remaining.toFixed(3)}
                                            </div>
                                          </div>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                )}
                              </div>

                              <div className="mt-3 flex gap-2">
                                <button
                                  className="flex-1 px-3 py-2 rounded-xl bg-gray-100 hover:bg-gray-200 text-sm"
                                  onClick={() => openDetail(g)}
                                >
                                  Ver detalle
                                </button>

                                {isAdmin ? (
                                  <>
                                    {g.status === "PENDIENTE" && (
                                      <button
                                        className="px-3 py-2 rounded-xl bg-green-600 hover:bg-green-700 text-white text-sm"
                                        onClick={() => payGroup(g)}
                                      >
                                        Pagar
                                      </button>
                                    )}

                                    <button
                                      className="px-3 py-2 rounded-xl bg-yellow-600 hover:bg-yellow-700 text-white text-sm"
                                      onClick={() => openForEdit(g)}
                                    >
                                      Editar
                                    </button>

                                    <button
                                      className="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-700 text-white text-sm"
                                      onClick={() => deleteGroup(g)}
                                    >
                                      Borrar
                                    </button>
                                  </>
                                ) : null}
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>

      {/* ===================== */}
      {/* DESKTOP (md+): TU TABLA */}
      {/* ===================== */}
      <div className="hidden md:block bg-white p-4 rounded-lg shadow-lg border w-full overflow-x-auto">
        <table className="min-w-[1100px] w-full text-sm bg-white divide-y divide-gray-200">
          <thead>
            <tr className="whitespace-nowrap">
              <th className="p-3 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50 min-w-[320px]">
                Fecha
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Lb Ing.
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Lb Rest
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Un. Ing
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Un. Rest
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Caj In
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Caj Rest
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Facturado
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Esperado
              </th>
              <th className="p-3 text-right text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Utilidad
              </th>
              <th className="p-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Estado
              </th>
              <th className="p-3 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider bg-gray-50">
                Acciones
              </th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : groupedRows.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin lotes
                </td>
              </tr>
            ) : (
              groupedRows.map((g) => (
                <tr key={g.groupId} className="group hover:bg-gray-50">
                  <td className="p-3 align-middle text-left min-w-0">
                    <button
                      className="underline text-blue-700 hover:text-blue-900"
                      onClick={() => openDetail(g)}
                      title={g.orderName}
                    >
                      {g.date}
                    </button>
                    <div className="text-sm text-gray-400 mt-1 truncate">
                      <span className="text-gray-600 font-medium mr-1 text-sm">
                        {g.orderName}
                      </span>
                      <span className="text-gray-500 text-sm">
                        {Array.from(
                          new Set(
                            g.items.map((it) =>
                              String(it.productName || "").trim(),
                            ),
                          ),
                        )
                          .filter(Boolean)
                          .slice(0, 6)
                          .join(", ")}
                        {g.items.length > 6 ? "…" : ""}
                      </span>
                    </div>
                  </td>
                  {/* Tipo column hidden for now - removed to give Fecha more space */}
                  <td className="p-3 align-middle text-right">
                    {g.lbsIn.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {g.lbsRem.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {g.udsIn.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {g.udsRem.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {g.cajillasIn.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {g.cajillasRem.toFixed(3)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {money(g.totalFacturado)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {money(g.totalEsperado)}
                  </td>
                  <td className="p-3 align-middle text-right">
                    {money(g.utilidadBruta)}
                  </td>
                  <td className="p-3 align-middle text-center">
                    <span
                      className={`px-2 py-0.5 rounded text-xs ${
                        g.status === "PAGADO"
                          ? "bg-green-100 text-green-700"
                          : "bg-yellow-100 text-yellow-700"
                      }`}
                    >
                      {g.status}
                    </span>
                  </td>
                  <td className="p-3 align-middle text-center">
                    {isAdmin ? (
                      <div className="flex gap-2 justify-center">
                        {g.status === "PENDIENTE" && (
                          <button
                            onClick={() => payGroup(g)}
                            className="px-2 py-1 rounded text-white bg-green-600 hover:bg-green-700"
                          >
                            Pagar
                          </button>
                        )}
                        <button
                          className="px-2 py-1 rounded text-white bg-yellow-600 hover:bg-yellow-700"
                          onClick={() => openForEdit(g)}
                        >
                          Editar
                        </button>
                        <button
                          className="px-2 py-1 rounded text-white bg-red-600 hover:bg-red-700"
                          onClick={() => deleteGroup(g)}
                        >
                          Borrar
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs text-gray-500">Solo vista</span>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* ======================= */}
      {/* MODAL CREAR/EDITAR */}
      {/* ======================= */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-6xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">
                  {editingGroupId ? "Editar pedido" : "Crear pedido"}
                </h3>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cancelar
                  </button>

                  <button
                    type="button"
                    className="bg-blue-600 text-white px-3 py-1 rounded hover:bg-blue-700"
                    onClick={saveOrder}
                    disabled={orderItems.length === 0}
                  >
                    {editingGroupId ? "Editar pedido" : "Crear pedido"}
                  </button>

                  <button
                    className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => setShowCreateModal(false)}
                    type="button"
                  >
                    Cerrar
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Nombre de pedido
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    value={orderName}
                    onChange={(e) => setOrderName(e.target.value)}
                    placeholder="Ej: Pedido Pollo - Semana 1"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Fecha de lote
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </div>
              </div>

              <div className="border rounded p-3 bg-gray-50 mb-4">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                  <div>
                    <label className="block text-sm font-semibold">
                      Unidad
                    </label>
                    <select
                      className="w-full border p-2 rounded"
                      value={unitFilter}
                      onChange={(e) => {
                        setUnitFilter(e.target.value);
                        setProductId("");
                        setQuantity(0);
                        setPurchasePrice(NaN);
                        setSalePrice(0);
                      }}
                    >
                      <option value="lb">Libras</option>
                      <option value="unidad">Unidad</option>
                      <option value="cajilla">Cajilla</option>
                      <option value="kg">Kilogramo</option>
                    </select>
                  </div>

                  <div className="md:col-span-2">
                    <label className="block text-sm font-semibold">
                      Producto (solo activos)
                    </label>
                    <select
                      className="w-full border p-2 rounded"
                      value={productId}
                      onChange={(e) => setProductId(e.target.value)}
                    >
                      <option value="">Selecciona un producto</option>
                      {productsByUnit.map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name} — {p.category} — {p.measurement}
                        </option>
                      ))}
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Ingrese cantidad
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={Number.isNaN(quantity) ? "" : quantity}
                      onFocus={() => {
                        if (quantity === 0) setQuantity(NaN);
                      }}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(3))
                          : 0;
                        setQuantity(Math.max(0, safe));
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing) {
                          updateOrderItemField(
                            existing.tempId,
                            "quantity",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Precio proveedor
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={Number.isNaN(purchasePrice) ? "" : purchasePrice}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        if (raw === "") return setPurchasePrice(NaN);
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(2))
                          : NaN;
                        setPurchasePrice(
                          Number.isFinite(safe) ? Math.max(0, safe) : NaN,
                        );
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing && Number.isFinite(safe)) {
                          updateOrderItemField(
                            existing.tempId,
                            "purchasePrice",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>

                  <div>
                    <label className="block text-sm font-semibold">
                      Precio venta (editable)
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={salePrice === 0 ? "" : salePrice}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(2))
                          : 0;
                        setSalePrice(Math.max(0, safe));
                        const existing = orderItems.find(
                          (it) => it.productId === productId,
                        );
                        if (existing) {
                          updateOrderItemField(
                            existing.tempId,
                            "salePrice",
                            safe,
                          );
                        }
                      }}
                      disabled={!productId}
                    />
                  </div>
                </div>

                <div className="flex justify-end mt-3">
                  <button
                    type="button"
                    onClick={addItemToOrder}
                    disabled={
                      !(
                        productId &&
                        Number(quantity) > 0 &&
                        Number.isFinite(Number(purchasePrice)) &&
                        Number(purchasePrice) > 0
                      )
                    }
                    className={`px-3 py-2 rounded ${
                      productId &&
                      Number(quantity) > 0 &&
                      Number.isFinite(Number(purchasePrice)) &&
                      Number(purchasePrice) > 0
                        ? "bg-blue-600 text-white hover:bg-blue-700"
                        : "bg-gray-300 text-gray-600 cursor-not-allowed"
                    }`}
                  >
                    Agregar producto al pedido
                  </button>
                </div>
              </div>

              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1200px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Ingresado</th>
                      <th className="p-2 border">Existencias</th>
                      <th className="p-2 border">Precio proveedor</th>
                      <th className="p-2 border">Precio venta</th>
                      <th className="p-2 border">Total facturado</th>
                      <th className="p-2 border">Total esperado</th>
                      <th className="p-2 border">Utilidad bruta</th>
                      <th className="p-2 border">Acciones</th>
                    </tr>
                  </thead>

                  <tbody>
                    {orderItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={9}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay productos agregados.
                        </td>
                      </tr>
                    ) : (
                      orderItems.map((it) => (
                        <tr
                          key={it.tempId}
                          className="text-center whitespace-nowrap"
                        >
                          <td className="p-2 border text-left">
                            {it.productName}
                            <div className="text-[11px] text-gray-500">
                              {it.category} — {it.unit}
                            </div>
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.quantity}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(3))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "quantity",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            {Number(it.remaining || 0).toFixed(3)}
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.purchasePrice}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(2))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "purchasePrice",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-28 border p-1 rounded text-right"
                              value={it.salePrice}
                              onChange={(e) => {
                                const raw = e.target.value.replace(",", ".");
                                const num = parseFloat(raw);
                                const safe = Number.isFinite(num)
                                  ? parseFloat(num.toFixed(2))
                                  : 0;
                                updateOrderItemField(
                                  it.tempId,
                                  "salePrice",
                                  safe,
                                );
                              }}
                            />
                          </td>

                          <td className="p-2 border">
                            {money(it.invoiceTotal)}
                          </td>
                          <td className="p-2 border">
                            {money(it.expectedTotal)}
                          </td>
                          <td className="p-2 border">
                            {money(it.utilidadBruta)}
                          </td>

                          <td className="p-2 border">
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                              onClick={() => removeOrderItem(it.tempId)}
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

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="mt-0 grid grid-cols-2 gap-x-4 gap-y-2 text-sm">
                    <div className="text-xs text-gray-600">
                      Libras ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.lbsIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Libras restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.lbsRem.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Unidades ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.unitsIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Unidades restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.unitsRem.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Cajillas ingresadas
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.cajillasIn.toFixed(3)}
                    </div>

                    <div className="text-xs text-gray-600">
                      Cajillas restantes
                    </div>
                    <div className="text-lg font-semibold text-right">
                      {orderKpis.cajillasRem.toFixed(3)}
                    </div>
                  </div>
                </div>

                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Total facturado</div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.totalFacturado)}
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Total esperado
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.totalEsperado)}
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Utilidad bruta
                  </div>
                  <div className="text-lg font-semibold">
                    {money(orderKpis.utilidadBruta)}
                  </div>
                </div>
              </div>

              {/* Footer buttons moved to header for quicker access */}
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL DETALLE */}
      {/* ======================= */}
      {showDetailModal &&
        detailGroup &&
        createPortal(
          <div className="fixed inset-0 z-[75] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => {
                setShowDetailModal(false);
                setDetailGroup(null);
              }}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-6xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <h3 className="text-lg font-bold">Detalle del pedido</h3>
                  <div className="text-sm text-gray-600">
                    <strong>{detailGroup.orderName}</strong> —{" "}
                    {detailGroup.date}
                  </div>
                </div>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => {
                    setShowDetailModal(false);
                    setDetailGroup(null);
                  }}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1100px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Unidad</th>
                      <th className="p-2 border">Ingresado</th>
                      <th className="p-2 border">Restantes</th>
                      <th className="p-2 border">Precio Compra</th>
                      <th className="p-2 border">Precio Venta</th>
                      <th className="p-2 border">Total factura</th>
                      <th className="p-2 border">Total esperado</th>
                      <th className="p-2 border">Utilidad</th>
                      <th className="p-2 border">Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detailGroup.items.map((b) => {
                      const inv = Number(b.invoiceTotal || 0);
                      const exp = Number(b.expectedTotal || 0);
                      return (
                        <tr
                          key={b.id}
                          className="text-center whitespace-nowrap"
                        >
                          <td className="p-2 border text-left">
                            {b.productName}
                          </td>
                          <td className="p-2 border">
                            {(b.unit || "").toUpperCase()}
                          </td>
                          <td className="p-2 border">
                            {b.quantity.toFixed(3)}
                          </td>
                          <td className="p-2 border">
                            {b.remaining.toFixed(3)}
                          </td>
                          <td className="p-2 border">
                            {money(b.purchasePrice)}
                          </td>
                          <td className="p-2 border">{money(b.salePrice)}</td>
                          <td className="p-2 border">{money(inv)}</td>
                          <td className="p-2 border">{money(exp)}</td>
                          <td className="p-2 border">{money(exp - inv)}</td>
                          <td className="p-2 border">{b.status}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mt-4">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Libras ingresadas</div>
                  <div className="text-lg font-semibold">
                    {detailGroup.lbsIn.toFixed(3)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Libras restantes</div>
                  <div className="text-lg font-semibold">
                    {detailGroup.lbsRem.toFixed(3)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Utilidad bruta</div>
                  <div className="text-lg font-semibold">
                    {money(detailGroup.utilidadBruta)}
                  </div>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* ======================= */}
      {/* MODAL CONFIRMAR PAGO */}
      {/* ======================= */}
      {showPayDialog &&
        selectedGroup &&
        createPortal(
          <div className="fixed inset-0 z-[80] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/50"
              onClick={cancelPayDialog}
            />
            <div className="relative bg-white rounded-xl shadow-2xl border w-[90%] max-w-md p-6">
              <h3 className="text-lg font-bold mb-3 text-center">
                Confirmar pago de inventario
              </h3>
              <p className="text-sm text-gray-700 mb-5 text-center">
                ¿Seguro que quieres pagar este pedido?
                <br />
                <strong>{selectedGroup.orderName}</strong> —{" "}
                {selectedGroup.date}
                <br />
                Ya no habrán libras disponibles al pagar este inventario.
              </p>
              <div className="flex justify-center gap-4">
                <button
                  onClick={confirmPayGroupNow}
                  className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700"
                >
                  Confirmar
                </button>
                <button
                  onClick={cancelPayDialog}
                  className="px-4 py-2 rounded-lg bg-gray-300 hover:bg-gray-400"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
