// src/components/Pollo/CustomersPollo.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  limit,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import {
  FiClock,
  FiShoppingCart,
  FiMoreVertical,
} from "react-icons/fi";
import ActionMenu from "../common/ActionMenu";

const PLACES = [
  "Altagracia",
  "Taguizapa",
  "El paso",
  "Calaysa",
  "Urbaite",
  "Las Pilas",
] as const;

type Place = (typeof PLACES)[number];
type Status = "ACTIVO" | "BLOQUEADO";

interface CustomerRow {
  id: string;
  name: string;
  phone: string; // formato +505 88888888
  place: Place | "";
  notes?: string;
  status: Status;
  creditLimit?: number;
  createdAt: Timestamp;
  balance?: number; // calculado (incluye initialDebt)

  vendorId?: string;
  vendorName?: string;
  initialDebt?: number;

  // para mobile (último abono)
  lastAbonoDate?: string; // yyyy-MM-dd
  lastAbonoAmount?: number; // positivo (monto del abono)
  lastSaleDate?: string;
}

interface MovementRow {
  id: string;
  date: string; // yyyy-MM-dd
  type: "CARGO" | "ABONO";
  amount: number; // CARGO > 0, ABONO < 0
  ref?: { saleId?: string };
  comment?: string;
  createdAt?: Timestamp;
  debtStatus?: "PENDIENTE" | "PAGADA";
}

interface SellerRow {
  id: string;
  name: string;
  status?: string;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

const roundCurrency = (value: number) =>
  Math.round((Number(value) || 0) * 100) / 100;

// Formatea un Timestamp/Date/string a YYYY-MM-DD en hora local (evita desfasajes UTC)
const formatLocalDate = (v: any) => {
  if (!v && v !== 0) return "";
  if (typeof v === "string") {
    // si ya viene en formato yyyy-MM-dd
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    // intentar parsear cadenas legibles (ej: "20 mar 2026, 6:35:52.973 p.m.")
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      const d = parsed;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
        d.getDate(),
      ).padStart(2, "0")}`;
    }
    return String(v).slice(0, 10);
  }
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }
  // Firestore Timestamp-like
  if (v?.toDate && typeof v.toDate === "function") {
    const d = v.toDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate(),
    ).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

const PAID_DEBT_FLAGS = new Set([
  "PAGADA",
  "PAGADO",
  "CERRADA",
  "CERRADO",
  "LIQUIDADA",
  "LIQUIDADO",
]);

const normalizeDebtStatus = (value?: string): "PENDIENTE" | "PAGADA" => {
  const upper = String(value || "")
    .trim()
    .toUpperCase();
  if (PAID_DEBT_FLAGS.has(upper)) return "PAGADA";
  return "PENDIENTE";
};

/** Saldo pendiente de una venta (CARGO − abonos con ref.saleId). */
function getPendingForSale(rows: MovementRow[], saleId: string): number {
  const cargo = rows.find(
    (m) =>
      m.type === "CARGO" &&
      m.ref?.saleId === saleId &&
      Number(m.amount) > 0,
  );
  if (!cargo) return 0;
  const cargoAmt = Number(cargo.amount);
  const paid = rows
    .filter(
      (m) =>
        m.type === "ABONO" &&
        m.ref?.saleId === saleId &&
        Number(m.amount) < 0,
    )
    .reduce((acc, m) => acc + Math.abs(Number(m.amount) || 0), 0);
  return roundCurrency(Math.max(0, cargoAmt - paid));
}

/** Fecha del cargo (venta) yyyy-MM-dd para validar abonos. */
function getCargoSaleDate(rows: MovementRow[], saleId: string): string {
  const c = rows.find(
    (m) =>
      m.type === "CARGO" &&
      m.ref?.saleId === saleId &&
      Number(m.amount) > 0,
  );
  return (c?.date || "").slice(0, 10);
}

/** Total abonado a una venta (suma de montos absolutos de ABONO con ref). */
function getTotalAbonadoForSale(rows: MovementRow[], saleId: string): number {
  return roundCurrency(
    rows
      .filter(
        (m) =>
          m.type === "ABONO" &&
          m.ref?.saleId === saleId &&
          Number(m.amount) < 0,
      )
      .reduce((acc, m) => acc + Math.abs(Number(m.amount) || 0), 0),
  );
}

function buildSaleAbonoLedger(
  rows: MovementRow[],
  saleId: string,
): Array<
  MovementRow & {
    saldoInicial: number;
    saldoFinal: number;
    montoAbs: number;
  }
> {
  const cargo = rows.find(
    (m) =>
      m.type === "CARGO" &&
      m.ref?.saleId === saleId &&
      Number(m.amount) > 0,
  );
  if (!cargo) return [];
  let running = Number(cargo.amount);
  const abonos = rows
    .filter(
      (m) =>
        m.type === "ABONO" &&
        m.ref?.saleId === saleId &&
        Number(m.amount) < 0,
    )
    .slice()
    .sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const as = a.createdAt?.seconds || 0;
      const bs = b.createdAt?.seconds || 0;
      return as - bs;
    });

  const chronological = abonos.map((ab) => {
    const inicial = roundCurrency(running);
    const monto = Math.abs(Number(ab.amount) || 0);
    running = roundCurrency(running - monto);
    return {
      ...ab,
      saldoInicial: inicial,
      saldoFinal: running,
      montoAbs: monto,
    };
  });
  /** Vista: del más reciente al más antiguo (saldos siguen siendo los de cada movimiento). */
  return chronological.slice().reverse();
}

/** Abonos creados con el botón "Pagar" (reversibles). */
const FULL_PAYMENT_COMMENT_PREFIX = "Pago total factura";

function isFullPaymentAbonoComment(comment?: string): boolean {
  return String(comment || "").startsWith(FULL_PAYMENT_COMMENT_PREFIX);
}

/** Pendiente ≤ 0 ⇒ factura pagada; si no, pendiente. */
function computeDebtStatusFromPendingForSale(
  list: MovementRow[],
  saleId: string,
): "PENDIENTE" | "PAGADA" {
  return getPendingForSale(list, saleId) <= 0.005 ? "PAGADA" : "PENDIENTE";
}

async function syncCargoDebtStatusForSaleId(
  list: MovementRow[],
  saleId: string,
): Promise<MovementRow[]> {
  const cargo = list.find(
    (m) =>
      m.type === "CARGO" &&
      m.ref?.saleId === saleId &&
      Number(m.amount) > 0,
  );
  if (!cargo) return list;
  const next = computeDebtStatusFromPendingForSale(list, saleId);
  const normalized = normalizeDebtStatus(cargo.debtStatus);
  if (normalized !== next) {
    await updateDoc(doc(db, "ar_movements_pollo", cargo.id), {
      debtStatus: next,
    });
  }
  return list.map((row) =>
    row.id === cargo.id ? { ...row, debtStatus: next } : row,
  );
}

function normalizePhone(input: string): string {
  const prefix = "+505 ";
  if (!input.startsWith(prefix)) {
    const digits = input.replace(/\D/g, "");
    return prefix + digits.slice(0, 8);
  }
  const rest = input.slice(prefix.length).replace(/\D/g, "");
  return prefix + rest.slice(0, 8);
}

// Eliminar movimientos de CxC ligados a una venta específica
async function deleteARMovesBySaleId(saleId: string) {
  const qMov = query(
    collection(db, "ar_movements_pollo"),
    where("ref.saleId", "==", saleId),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements_pollo", d.id))),
  );
}

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface CustomersPolloProps {
  role?: RoleProp;
  sellerPolloId?: string;
  currentUserEmail?: string;
}

export default function CustomersPollo({
  role = "",
  roles,
  sellerPolloId = "",
  currentUserEmail,
}: CustomersPolloProps & { roles?: RoleProp[] | string[] }) {
  const subject = (roles && (roles as any).length ? roles : role) as any;
  const sellerIdSafe = String(sellerPolloId || "").trim();

  const isVendor = hasRole(subject, "vendedor_pollo");
  const isAdmin = hasRole(subject, "admin");

  const [sellers, setSellers] = useState<SellerRow[]>([]);

  // filtros
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fClient, setFClient] = useState("");
  const [fStatus, setFStatus] = useState<"" | Status>("");
  const [fMin, setFMin] = useState<string>("");
  const [fMax, setFMax] = useState<string>("");

  // modal detalle ítems
  const [itemsModalOpen, setItemsModalOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number;
      unitPrice: number;
      discount?: number;
      total: number;
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);

    try {
      const byId = await getDoc(doc(db, "salesV2", saleId));
      let data: any = null;

      if (byId.exists()) {
        data = byId.data();
      } else {
        const snap = await getDocs(
          query(collection(db, "salesV2"), where("name", "==", saleId)),
        );
        data = snap.docs[0]?.data();
      }

      if (!data) {
        setItemsModalRows([]);
        return;
      }

      // Extraer items intentando varias formas que aparecen en distintos documentos
      let arr: any[] = [];

      if (Array.isArray(data.items) && data.items.length > 0) {
        arr = data.items;
      } else if (data.items && typeof data.items === "object") {
        try {
          arr = Object.values(data.items);
        } catch {
          arr = [];
        }
      } else if (data.item) {
        arr = [data.item];
      } else if (Array.isArray(data.products) && data.products.length > 0) {
        arr = data.products;
      } else if (Array.isArray(data.lines) && data.lines.length > 0) {
        arr = data.lines;
      } else if (Array.isArray(data.detalles) && data.detalles.length > 0) {
        arr = data.detalles;
      } else if (data.productName || data.product) {
        arr = [
          {
            productName: data.productName || data.product || "",
            qty: data.qty ?? data.quantity ?? data.lbs ?? 0,
            unitPrice: data.unitPrice ?? data.price ?? 0,
            discount: data.discount ?? 0,
            total: data.total ?? data.amount ?? 0,
          },
        ];
      }

      // Helper: parse numbers tolerantly
      const parseNum = (v: any) => {
        if (v === undefined || v === null) return NaN;
        if (typeof v === "number") return v;
        let s = String(v).trim();
        if (!s) return NaN;
        s = s.replace(/[^0-9.,-]/g, "");
        if (!s) return NaN;
        if (s.indexOf(".") > -1 && s.indexOf(",") > -1) {
          s = s.replace(/,/g, "");
        } else if (s.indexOf(",") > -1 && s.indexOf(".") === -1) {
          s = s.replace(/,/g, ".");
        }
        const n = Number(s);
        return Number.isNaN(n) ? NaN : n;
      };

      // Si hay allocations por lote, traer precios desde inventory_batches
      const batchIds = new Set<string>();
      for (const it of arr) {
        if (Array.isArray(it?.allocations)) {
          for (const a of it.allocations) {
            const id = String(a?.batchId || "").trim();
            if (id) batchIds.add(id);
          }
        } else if (it?.allocations && typeof it.allocations === "object") {
          try {
            for (const a of Object.values(it.allocations)) {
              const id = String((a as any)?.batchId || "").trim();
              if (id) batchIds.add(id);
            }
          } catch {}
        }
      }

      if (Array.isArray(data?.allocations)) {
        for (const a of data.allocations) {
          const id = String(a?.batchId || "").trim();
          if (id) batchIds.add(id);
        }
      }

      const batchPriceMap: Record<string, number> = {};
      if (batchIds.size > 0) {
        await Promise.all(
          Array.from(batchIds).map(async (bid) => {
            try {
              const bSnap = await getDoc(doc(db, "inventory_batches", bid));
              if (bSnap.exists()) {
                const b = bSnap.data() as any;
                batchPriceMap[bid] = Number(
                  b.salePrice ?? b.sale_price ?? b.price ?? 0,
                );
              }
            } catch {
              /* ignore */
            }
          }),
        );
      }

      // fallback: precio por producto en collection `products`
      const productIds = new Set<string>();
      for (const it of arr) {
        const pid = String(it.productId || "").trim();
        if (pid) productIds.add(pid);
      }
      const productPriceMap: Record<string, number> = {};
      if (productIds.size > 0) {
        await Promise.all(
          Array.from(productIds).map(async (pid) => {
            try {
              const pSnap = await getDoc(doc(db, "products", pid));
              if (pSnap.exists()) {
                const p = pSnap.data() as any;
                productPriceMap[pid] = Number(p.salePrice ?? p.price ?? 0);
              }
            } catch {
              /* ignore */
            }
          }),
        );
      }

      const rows = arr.map((it: any) => {
        const productName = String(
          it.productName || it.product || it.name || "(sin nombre)",
        );

        const qty =
          Number(it.qty ?? it.quantity ?? it.lbs ?? it.weight ?? 0) || 0;

        const totalCandidate =
          parseNum(
            it.total ?? it.lineFinal ?? it.amount ?? it.monto ?? it.line_total,
          ) || 0;

        let unitPrice = 0;
        const priceCandidates = [
          it.unitPrice,
          it.unitPricePackage,
          it.salePrice,
          it.sale_price,
          it.price,
          it.unit_price,
          it.pricePerUnit,
          it.price_per_unit,
        ];
        for (const p of priceCandidates) {
          const n = parseNum(p);
          if (!Number.isNaN(n) && n !== 0) {
            unitPrice = n;
            break;
          }
        }

        if (!unitPrice) {
          const saleLevelRaw =
            data?.salePrice ??
            data?.sale_price ??
            data?.unitPrice ??
            data?.unit_price ??
            data?.price ??
            data?.pricePerUnit;
          const saleLevel = parseNum(saleLevelRaw);
          if (!Number.isNaN(saleLevel) && saleLevel !== 0)
            unitPrice = saleLevel;
        }

        if (!unitPrice) {
          const firstAlloc = Array.isArray(it.allocations)
            ? it.allocations[0]
            : it.allocations && typeof it.allocations === "object"
              ? Object.values(it.allocations)[0]
              : null;
          const bid = firstAlloc
            ? String((firstAlloc as any).batchId || "").trim()
            : "";
          if (bid && batchPriceMap[bid]) unitPrice = batchPriceMap[bid] || 0;
        }

        if (!unitPrice && it.productId) {
          unitPrice = productPriceMap[String(it.productId)] || 0;
        }

        if ((!unitPrice || unitPrice === 0) && totalCandidate > 0 && qty > 0) {
          unitPrice = totalCandidate / qty;
        }

        const discount = parseNum(it.discount ?? it.desc ?? 0) || 0;

        let total = totalCandidate;
        if (!total || total === 0) {
          total = Number(unitPrice * qty || 0);
        }
        total = Number(total) || 0;

        return { productName, qty, unitPrice, discount, total };
      });

      setItemsModalRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // formulario crear
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+505 ");
  const [place, setPlace] = useState<Place | "">("");
  const [notes, setNotes] = useState("");
  const [status, setStatus] = useState<Status>("ACTIVO");
  const [creditLimit, setCreditLimit] = useState<number>(0);

  const [vendorId, setVendorId] = useState<string>("");
  const [initialDebt, setInitialDebt] = useState<number>(0);

  const [rows, setRows] = useState<CustomerRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [ePhone, setEPhone] = useState("+505 ");
  const [ePlace, setEPlace] = useState<Place | "">("");
  const [eNotes, setENotes] = useState("");
  const [eStatus, setEStatus] = useState<Status>("ACTIVO");
  const [eCreditLimit, setECreditLimit] = useState<number>(0);
  const [eVendorId, setEVendorId] = useState<string>("");

  // estado de cuenta
  const [showStatement, setShowStatement] = useState(false);
  const [stCustomer, setStCustomer] = useState<CustomerRow | null>(null);
  const [stLoading, setStLoading] = useState(false);
  const [stRows, setStRows] = useState<MovementRow[]>([]);
  const [stKpis, setStKpis] = useState({
    saldoActual: 0,
    totalAbonado: 0,
    totalCargos: 0,
    saldoRestante: 0,
  });

  // abonos
  const [showAbono, setShowAbono] = useState(false);
  const [abonoAmount, setAbonoAmount] = useState<number>(0);
  const [abonoDate, setAbonoDate] = useState<string>(
    formatLocalDate(new Date()),
  );
  const [abonoComment, setAbonoComment] = useState<string>("");
  const [savingAbono, setSavingAbono] = useState(false);
  /** Abono asociado a una venta (ref.saleId en Firestore). */
  const [abonoTargetSaleId, setAbonoTargetSaleId] = useState<string | null>(
    null,
  );
  const [saleMenuAnchor, setSaleMenuAnchor] = useState<{
    saleId: string;
    rect: DOMRect;
  } | null>(null);
  const [saleLedgerSaleId, setSaleLedgerSaleId] = useState<string | null>(null);

  // editar/eliminar mov
  const [editMovId, setEditMovId] = useState<string | null>(null);
  const [eMovDate, setEMovDate] = useState<string>("");
  const [eMovComment, setEMovComment] = useState<string>("");
  const [customerRowMenu, setCustomerRowMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [expandedCustomerId, setExpandedCustomerId] = useState<string | null>(
    null,
  );
  const [stOpenAccount, setStOpenAccount] = useState(false);
  const [stOpenMovements, setStOpenMovements] = useState(false);
  const [expandedMovementId, setExpandedMovementId] = useState<string | null>(
    null,
  );

  // sort mode for customer list: '' | 'lastAbono' | 'lastSale'
  const [sortMode, setSortMode] = useState<"" | "lastAbono" | "lastSale">("");

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);

        if (isVendor && !sellerIdSafe) {
          setRows([]);
          setMsg(
            "❌ Este usuario no tiene vendedor asociado (sellerPolloId vacío).",
          );
          return;
        }

        // vendedores activos
        // porque los vendedores reciben múltiples roles y esa pantalla
        // es la fuente de verdad para los vendedores.
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const vList: SellerRow[] = [];
        vSnap.forEach((d) => {
          const x = d.data() as any;
          // Ignoramos commission/branch: en Pollo solo usamos id y name
          vList.push({ id: d.id, name: String(x.name || "") });
        });
        setSellers(vList);

        // clientes
        const qC = isVendor
          ? query(
              collection(db, "customers_pollo"),
              where("vendorId", "==", sellerIdSafe),
              orderBy("createdAt", "desc"),
            )
          : query(
              collection(db, "customers_pollo"),
              orderBy("createdAt", "desc"),
            );

        const snap = await getDocs(qC);
        const list: CustomerRow[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            name: x.name ?? "",
            phone: x.phone ?? "+505 ",
            place: (x.place as Place) ?? "",
            notes: x.notes ?? "",
            status: (x.status as Status) ?? "ACTIVO",
            creditLimit: Number(x.creditLimit ?? 0),
            createdAt: x.createdAt ?? Timestamp.now(),
            balance: 0,

            vendorId: x.vendorId || "",
            vendorName: x.vendorName || "",
            initialDebt: Number(x.initialDebt || 0),

            lastAbonoDate: "",
            lastAbonoAmount: 0,
          });
        });

        // saldos + último abono
        for (const c of list) {
          try {
            const qMov = query(
              collection(db, "ar_movements_pollo"),
              where("customerId", "==", c.id),
            );
            const mSnap = await getDocs(qMov);

            let sumMov = 0;
            let lastAbono: any = null;
            let hasPendingCargo = false;

            mSnap.forEach((m) => {
              const x = m.data() as any;
              const amt = Number(x.amount || 0);
              sumMov += amt;

              if (amt > 0) {
                const status = normalizeDebtStatus(
                  x.debtStatus ?? x.creditStatus ?? x.cycleStatus ?? x.status,
                );
                if (status === "PENDIENTE") hasPendingCargo = true;
              }

              if (amt < 0) {
                const d = x.date ?? formatLocalDate(x.createdAt);
                const ts = x.createdAt?.seconds
                  ? Number(x.createdAt.seconds)
                  : 0;

                if (!lastAbono || ts >= lastAbono.ts) {
                  lastAbono = { date: d, amount: Math.abs(amt), ts };
                }
              }
            });

            const init = Number(c.initialDebt || 0);
            const currentBalance = roundCurrency(init + sumMov);
            c.balance = currentBalance;
            const hasOutstanding = hasPendingCargo || currentBalance > 0;

            if (hasOutstanding && lastAbono) {
              c.lastAbonoDate = lastAbono.date;
              c.lastAbonoAmount = lastAbono.amount;
            } else {
              c.lastAbonoDate = "";
              c.lastAbonoAmount = 0;
            }
            // último venta (salesV2)
            try {
              const qS = query(
                collection(db, "salesV2"),
                where("customerId", "==", c.id),
                orderBy("date", "desc"),
                limit(1),
              );
              let sSnap = await getDocs(qS);
              let sDoc = sSnap.docs[0];
              // if no result, try ordering by timestamp or createdAt, then fallback to scanning
              if (!sDoc) {
                try {
                  const q2 = query(
                    collection(db, "salesV2"),
                    where("customerId", "==", c.id),
                    orderBy("timestamp", "desc"),
                    limit(1),
                  );
                  sSnap = await getDocs(q2);
                  sDoc = sSnap.docs[0];
                } catch (e) {
                  // ignore
                }
              }
              if (!sDoc) {
                try {
                  const q3 = query(
                    collection(db, "salesV2"),
                    where("customerId", "==", c.id),
                    orderBy("createdAt", "desc"),
                    limit(1),
                  );
                  sSnap = await getDocs(q3);
                  sDoc = sSnap.docs[0];
                } catch (e) {
                  // ignore
                }
              }
              if (!sDoc) {
                // last resort: fetch all for this customer and pick newest by known timestamp fields
                try {
                  const sAll = await getDocs(
                    query(
                      collection(db, "salesV2"),
                      where("customerId", "==", c.id),
                    ),
                  );
                  let best: any = null;
                  let bestTs = 0;
                  sAll.docs.forEach((dd) => {
                    const sd = dd.data() as any;
                    let candidateMs = 0;
                    if (sd?.date) {
                      if (typeof sd.date === "string") {
                        const p = Date.parse(sd.date);
                        if (!Number.isNaN(p)) candidateMs = p;
                      } else if (sd.date?.toDate) {
                        candidateMs = sd.date.toDate().getTime();
                      }
                    }
                    if (!candidateMs && sd?.timestamp?.seconds) {
                      candidateMs = Number(sd.timestamp.seconds) * 1000;
                    }
                    if (!candidateMs && sd?.createdAt?.seconds) {
                      candidateMs = Number(sd.createdAt.seconds) * 1000;
                    }
                    if (candidateMs > bestTs) {
                      bestTs = candidateMs;
                      best = dd;
                    }
                  });
                  sDoc = best;
                } catch (e) {
                  // ignore
                }
              }
              if (sDoc) {
                const sData: any = sDoc.data();
                // prefer string date, otherwise try Timestamp fields
                if (sData?.date) {
                  c.lastSaleDate =
                    typeof sData.date === "string"
                      ? sData.date.slice(0, 10)
                      : formatLocalDate(sData.date);
                } else if (sData?.timestamp) {
                  c.lastSaleDate = formatLocalDate(sData.timestamp);
                } else if (sData?.createdAt) {
                  c.lastSaleDate = formatLocalDate(sData.createdAt);
                } else {
                  c.lastSaleDate = "";
                }
              } else {
                c.lastSaleDate = "";
              }
              // Debugging: log when we couldn't find a sale or when data looks unexpected
              if (!sDoc) {
                try {
                  console.debug(
                    "CustomersPollo: no sales found for customer",
                    c.id,
                  );
                } catch (e) {
                  /* ignore */
                }
              } else {
                try {
                  const sd = sDoc.data() as any;
                  if (!sd) {
                    console.debug(
                      "CustomersPollo: sale doc has no data",
                      sDoc.id,
                      c.id,
                    );
                  } else if (!sd.date && !sd.timestamp && !sd.createdAt) {
                    console.debug(
                      "CustomersPollo: sale doc has no date fields",
                      sDoc.id,
                      c.id,
                      sd,
                    );
                  }
                } catch (e) {
                  /* ignore */
                }
              }
            } catch (e) {
              c.lastSaleDate = "";
            }
          } catch {
            c.balance = Number(c.initialDebt || 0);
            c.lastAbonoDate = "";
            c.lastAbonoAmount = 0;
            c.lastSaleDate = "";
          }
        }

        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando clientes.");
      } finally {
        setLoading(false);
      }
    })();
  }, [isVendor, sellerIdSafe]);

  const resetForm = () => {
    setName("");
    setPhone("+505 ");
    setPlace("");
    setNotes("");
    setStatus("ACTIVO");
    setCreditLimit(0);
    setVendorId("");
    setInitialDebt(0);
  };

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!name.trim()) {
      setMsg("Ingresa el nombre.");
      return;
    }
    const cleanPhone = normalizePhone(phone);
    if (cleanPhone.length < 6) {
      setMsg("Teléfono incompleto.");
      return;
    }

    const finalVendorId = isVendor ? sellerIdSafe : String(vendorId || "");
    const finalVendorName = finalVendorId
      ? sellers.find((s) => s.id === finalVendorId)?.name || ""
      : "";

    try {
      const init = Number(initialDebt || 0);

      const ref = await addDoc(collection(db, "customers_pollo"), {
        name: name.trim(),
        phone: cleanPhone,
        place: place || "",
        notes: notes || "",
        status,
        creditLimit: Number(creditLimit || 0),

        vendorId: finalVendorId,
        vendorName: finalVendorName,
        initialDebt: init,

        createdAt: Timestamp.now(),
      });

      setRows((prev) => [
        {
          id: ref.id,
          name: name.trim(),
          phone: cleanPhone,
          place: place || "",
          notes: notes || "",
          status,
          creditLimit: Number(creditLimit || 0),

          vendorId: finalVendorId,
          vendorName: finalVendorName,
          initialDebt: init,

          createdAt: Timestamp.now(),
          balance: init,
          lastAbonoDate: "",
          lastAbonoAmount: 0,
        },
        ...prev,
      ]);

      resetForm();
      setShowCreateModal(false);
      setMsg("✅ Cliente creado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al crear cliente");
    }
  };

  const startEdit = (c: CustomerRow) => {
    if (isVendor) {
      setMsg(
        "❌ No permitido: vendedores no editan clientes desde el listado.",
      );
      return;
    }
    setEditingId(c.id);
    setEName(c.name);
    setEPhone(c.phone || "+505 ");
    setEPlace(c.place || "");
    setENotes(c.notes || "");
    setEStatus(c.status || "ACTIVO");
    setECreditLimit(Number(c.creditLimit || 0));
    setEVendorId(String(c.vendorId || ""));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEName("");
    setEPhone("+505 ");
    setEPlace("");
    setENotes("");
    setEStatus("ACTIVO");
    setECreditLimit(0);
    setEVendorId("");
  };

  const saveEdit = async () => {
    if (isVendor) {
      setMsg("❌ No permitido.");
      return;
    }
    if (!editingId) return;

    const cleanPhone = normalizePhone(ePhone);
    if (!eName.trim()) {
      setMsg("Ingresa el nombre.");
      return;
    }

    const current = rows.find((x) => x.id === editingId);
    const currentVendor = String(current?.vendorId || "");
    const nextVendor = isVendor ? sellerIdSafe : String(eVendorId || "");

    if (isVendor && currentVendor && currentVendor !== sellerIdSafe) {
      setMsg("❌ Este cliente pertenece a otro vendedor.");
      return;
    }

    if (
      isAdmin &&
      currentVendor &&
      nextVendor &&
      currentVendor !== nextVendor
    ) {
      setMsg(
        "❌ Este cliente ya está asociado a otro vendedor. Primero desasocia (deja vendedor en —) y guarda; luego lo puedes asignar.",
      );
      return;
    }

    const finalVendorId = isVendor ? sellerIdSafe : String(eVendorId || "");
    const finalVendorName = finalVendorId
      ? sellers.find((s) => s.id === finalVendorId)?.name || ""
      : "";

    try {
      await updateDoc(doc(db, "customers_pollo", editingId), {
        name: eName.trim(),
        phone: cleanPhone,
        place: ePlace || "",
        notes: eNotes || "",
        status: eStatus,
        creditLimit: Number(eCreditLimit || 0),

        vendorId: finalVendorId,
        vendorName: finalVendorName,
      });

      setRows((prev) =>
        prev.map((x) =>
          x.id === editingId
            ? {
                ...x,
                name: eName.trim(),
                phone: cleanPhone,
                place: ePlace || "",
                notes: eNotes || "",
                status: eStatus,
                creditLimit: Number(eCreditLimit || 0),
                vendorId: finalVendorId,
                vendorName: finalVendorName,
              }
            : x,
        ),
      );

      cancelEdit();
      setMsg("✅ Cliente actualizado");
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al actualizar");
    }
  };

  // Eliminar cliente (quita ventas y movimientos)
  const handleDelete = async (row: CustomerRow) => {
    const ok = confirm(
      `¿Eliminar al cliente "${row.name}"?\nSe borrarán todas sus ventas y movimientos.`,
    );
    if (!ok) return;

    try {
      setLoading(true);

      const qSales = query(
        collection(db, "salesV2"),
        where("customerId", "==", row.id),
      );
      const sSnap = await getDocs(qSales);

      for (const d of sSnap.docs) {
        const saleId = d.id;
        try {
          await deleteDoc(doc(db, "salesV2", saleId));
        } catch (e) {
          console.warn("delete sale error", e);
        }
        await deleteARMovesBySaleId(saleId);
      }

      const qMov = query(
        collection(db, "ar_movements_pollo"),
        where("customerId", "==", row.id),
      );
      const mSnap = await getDocs(qMov);
      await Promise.all(
        mSnap.docs.map((d) => deleteDoc(doc(db, "ar_movements_pollo", d.id))),
      );

      await deleteDoc(doc(db, "customers_pollo", row.id));

      setRows((prev) => prev.filter((x) => x.id !== row.id));
      setMsg("🗑️ Cliente eliminado y registros borrados");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar el cliente.");
    } finally {
      setLoading(false);
    }
  };

  const recomputeKpis = (list: MovementRow[], initialDebtValue: number) => {
    const sumMov = list.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    const totalAbonos = list
      .filter((x) => Number(x.amount) < 0)
      .reduce((acc, it) => acc + Math.abs(Number(it.amount) || 0), 0);

    const totalCargosMov = list
      .filter((x) => Number(x.amount) > 0)
      .reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    const saldoActual = Number(initialDebtValue || 0) + sumMov;

    setStKpis({
      saldoActual,
      totalAbonado: totalAbonos,
      totalCargos: Number(initialDebtValue || 0) + totalCargosMov,
      saldoRestante: saldoActual,
    });
  };

  const closeStatement = () => {
    setShowStatement(false);
    setSaleMenuAnchor(null);
    setSaleLedgerSaleId(null);
    setAbonoTargetSaleId(null);
    setShowAbono(false);
    setItemsModalOpen(false);
  };

  const openStatement = async (customer: CustomerRow) => {
    setStCustomer(customer);
    setStRows([]);
    setStKpis({
      saldoActual: 0,
      totalAbonado: 0,
      totalCargos: 0,
      saldoRestante: 0,
    });
    setShowStatement(true);

    setStOpenAccount(false);
    setStOpenMovements(false);
    setExpandedMovementId(null);

    setShowAbono(false);
    setAbonoAmount(0);
    setAbonoDate(formatLocalDate(new Date()));
    setAbonoComment("");
    setAbonoTargetSaleId(null);
    setSaleMenuAnchor(null);
    setSaleLedgerSaleId(null);
    setEditMovId(null);

    setStLoading(true);
    try {
      const qMov = query(
        collection(db, "ar_movements_pollo"),
        where("customerId", "==", customer.id),
      );
      const snap = await getDocs(qMov);
      const list: MovementRow[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        const date =
          x.date ??
          (x.createdAt?.toDate?.() ? formatLocalDate(x.createdAt) : "");
        const amount = Number(x.amount || 0);
        list.push({
          id: d.id,
          date,
          type:
            (x.type as "CARGO" | "ABONO") ?? (amount < 0 ? "ABONO" : "CARGO"),
          amount,
          ref: x.ref || {},
          comment: x.comment || "",
          createdAt: x.createdAt,
          debtStatus: normalizeDebtStatus(
            x.debtStatus ?? x.creditStatus ?? x.cycleStatus ?? x.status,
          ),
        });
      });

      list.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });

      setStRows(list);
      recomputeKpis(list, Number(customer.initialDebt || 0));
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el estado de cuenta");
    } finally {
      setStLoading(false);
    }
  };

  const hasOpenDebt = (
    list: MovementRow[],
    outstandingBalance: number,
  ): boolean => {
    if (roundCurrency(outstandingBalance || 0) > 0) return true;
    return list.some(
      (row) =>
        row.type === "CARGO" &&
        normalizeDebtStatus(row.debtStatus) === "PENDIENTE",
    );
  };

  const getLastAbonoFromList = (list: MovementRow[]) => {
    const abonos = list
      .filter((x) => Number(x.amount) < 0)
      .map((x) => ({
        date: x.date,
        amount: Math.abs(Number(x.amount || 0)),
        ts: x.createdAt?.seconds || 0,
      }))
      .sort((a, b) => (a.ts || 0) - (b.ts || 0));
    return abonos.length ? abonos[abonos.length - 1] : null;
  };

  /** Ventas a crédito (CARGO con venta) mostradas en el estado de cuenta. */
  const saleVentasRows = useMemo(() => {
    return stRows
      .filter(
        (m) =>
          m.type === "CARGO" &&
          Boolean(m.ref?.saleId) &&
          Number(m.amount) > 0,
      )
      .slice()
      .sort((a, b) => {
        if (a.date !== b.date) return b.date.localeCompare(a.date);
        return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
      });
  }, [stRows]);

  const saleLedgerComputed = useMemo(() => {
    if (!saleLedgerSaleId) return [];
    return buildSaleAbonoLedger(stRows, saleLedgerSaleId);
  }, [stRows, saleLedgerSaleId]);

  const saveAbono = async () => {
    if (!stCustomer) return;
    setMsg("");

    const amt = Number(abonoAmount || 0);
    if (!(amt > 0)) {
      setMsg("Ingresa un monto de abono mayor a 0.");
      return;
    }
    const safeAmt = parseFloat(amt.toFixed(2));
    if (!abonoDate) {
      setMsg("Selecciona la fecha del abono.");
      return;
    }

    if (abonoTargetSaleId) {
      const pend = getPendingForSale(stRows, abonoTargetSaleId);
      if (safeAmt > pend + 0.005) {
        setMsg(
          `El abono no puede superar el saldo pendiente (${money(pend)}) de esta venta.`,
        );
        return;
      }
      const saleD = getCargoSaleDate(stRows, abonoTargetSaleId);
      if (saleD && abonoDate < saleD) {
        setMsg(
          `La fecha del abono no puede ser anterior a la fecha de la venta (${saleD}).`,
        );
        return;
      }
    }

    try {
      setSavingAbono(true);
      const payload: Record<string, unknown> = {
        customerId: stCustomer.id,
        type: "ABONO",
        amount: -safeAmt,
        date: abonoDate,
        comment: abonoComment || "",
        createdAt: Timestamp.now(),
      };
      if (abonoTargetSaleId) {
        payload.ref = { saleId: abonoTargetSaleId };
      }
      const ref = await addDoc(collection(db, "ar_movements_pollo"), payload);

      const newRow: MovementRow = {
        id: ref.id,
        date: abonoDate,
        type: "ABONO",
        amount: -safeAmt,
        comment: abonoComment || "",
        createdAt: Timestamp.now(),
        ref: abonoTargetSaleId
          ? { saleId: abonoTargetSaleId }
          : undefined,
      };

      let newList = [...stRows, newRow].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });
      if (abonoTargetSaleId) {
        newList = await syncCargoDebtStatusForSaleId(
          newList,
          abonoTargetSaleId,
        );
      }

      setStRows(newList);
      recomputeKpis(newList, Number(stCustomer.initialDebt || 0));
      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const nuevoSaldo = roundCurrency(
        Number(stCustomer.initialDebt || 0) + sumMov,
      );
      const openDebt = hasOpenDebt(newList, nuevoSaldo);

      setRows((prev) =>
        prev.map((c) => {
          if (c.id !== stCustomer.id) return c;
          const nextBal = roundCurrency((c.balance || 0) - safeAmt);
          return {
            ...c,
            balance: nextBal,
            lastAbonoDate: openDebt ? abonoDate : "",
            lastAbonoAmount: openDebt ? safeAmt : 0,
          };
        }),
      );

      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: roundCurrency((prev.balance || 0) - safeAmt),
              lastAbonoDate: openDebt ? abonoDate : "",
              lastAbonoAmount: openDebt ? safeAmt : 0,
            }
          : prev,
      );

      setAbonoAmount(0);
      setAbonoComment("");
      setAbonoDate(formatLocalDate(new Date()));
      setAbonoTargetSaleId(null);
      setShowAbono(false);
      setMsg("✅ Abono registrado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al registrar el abono");
    } finally {
      setSavingAbono(false);
    }
  };

  const payFullSale = async (saleId: string) => {
    if (!stCustomer) return;
    setMsg("");
    const pending = getPendingForSale(stRows, saleId);
    if (!(pending > 0.005)) {
      setMsg("No hay saldo pendiente para esta venta.");
      return;
    }
    const cargo = stRows.find(
      (m) =>
        m.type === "CARGO" &&
        m.ref?.saleId === saleId &&
        Number(m.amount) > 0,
    );
    if (!cargo) {
      setMsg("No se encontró el cargo de esta venta.");
      return;
    }
    const payAmt = roundCurrency(pending);
    const payDate = formatLocalDate(new Date());
    const saleD = (cargo.date || "").slice(0, 10);
    if (saleD && payDate < saleD) {
      setMsg(
        `La fecha de pago no puede ser anterior a la fecha de la venta (${saleD}).`,
      );
      return;
    }

    const okPay = confirm(
      `¿Confirmar el pago total de esta factura por ${money(payAmt)}?`,
    );
    if (!okPay) return;

    try {
      setSavingAbono(true);
      const payload = {
        customerId: stCustomer.id,
        type: "ABONO",
        amount: -payAmt,
        date: payDate,
        comment: `${FULL_PAYMENT_COMMENT_PREFIX} (${saleId.slice(0, 8)}…)`,
        createdAt: Timestamp.now(),
        ref: { saleId },
      };
      const refDoc = await addDoc(
        collection(db, "ar_movements_pollo"),
        payload,
      );

      const newRow: MovementRow = {
        id: refDoc.id,
        date: payDate,
        type: "ABONO",
        amount: -payAmt,
        comment: payload.comment,
        createdAt: Timestamp.now(),
        ref: { saleId },
      };

      let newList = [...stRows, newRow].sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });
      newList = await syncCargoDebtStatusForSaleId(newList, saleId);

      setStRows(newList);
      recomputeKpis(newList, Number(stCustomer.initialDebt || 0));
      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const nuevoSaldo = roundCurrency(
        Number(stCustomer.initialDebt || 0) + sumMov,
      );
      const openDebt = hasOpenDebt(newList, nuevoSaldo);
      const last = openDebt ? getLastAbonoFromList(newList) : null;

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: openDebt && last ? last.date : "",
                lastAbonoAmount: openDebt && last ? last.amount : 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: openDebt && last ? last.date : "",
              lastAbonoAmount: openDebt && last ? last.amount : 0,
            }
          : prev,
      );

      setMsg("✅ Factura pagada");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al registrar el pago");
    } finally {
      setSavingAbono(false);
    }
  };

  /** Elimina el abono de "Pago total factura" y sincroniza estado de la venta. */
  const revertFullPaymentSale = async (saleId: string) => {
    if (!stCustomer) return;
    const candidates = stRows
      .filter(
        (m) =>
          m.type === "ABONO" &&
          m.ref?.saleId === saleId &&
          isFullPaymentAbonoComment(m.comment),
      )
      .slice()
      .sort(
        (a, b) =>
          (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0),
      );
    const abono = candidates[0];
    if (!abono) {
      setMsg("No hay un pago total registrado para revertir.");
      return;
    }
    const revertAmt = Math.abs(Number(abono.amount) || 0);
    const ok = confirm(
      `¿Confirmar revertir el pago total?\n\nSe eliminará el abono de ${money(revertAmt)} y la factura volverá a Pendiente si queda saldo por cobrar.`,
    );
    if (!ok) return;

    try {
      setSavingAbono(true);
      await deleteDoc(doc(db, "ar_movements_pollo", abono.id));
      let newList = stRows.filter((x) => x.id !== abono.id);
      newList = await syncCargoDebtStatusForSaleId(newList, saleId);

      setStRows(newList);
      recomputeKpis(newList, Number(stCustomer.initialDebt || 0));

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const nuevoSaldo = roundCurrency(
        Number(stCustomer.initialDebt || 0) + sumMov,
      );
      const openDebt = hasOpenDebt(newList, nuevoSaldo);
      const last = openDebt ? getLastAbonoFromList(newList) : null;

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: openDebt && last ? last.date : "",
                lastAbonoAmount: openDebt && last ? last.amount : 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: openDebt && last ? last.date : "",
              lastAbonoAmount: openDebt && last ? last.amount : 0,
            }
          : prev,
      );

      setMsg("✅ Pago total revertido");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al revertir el pago");
    } finally {
      setSavingAbono(false);
    }
  };

  const startEditMovement = (m: MovementRow) => {
    setEditMovId(m.id);
    setEMovDate(m.date || formatLocalDate(new Date()));
    setEMovComment(m.comment || "");
  };

  const cancelEditMovement = () => {
    setEditMovId(null);
    setEMovDate("");
    setEMovComment("");
  };

  const saveEditMovement = async () => {
    if (!editMovId || !stCustomer) return;
    const idx = stRows.findIndex((x) => x.id === editMovId);
    if (idx === -1) return;
    const old = stRows[idx];

    if (!eMovDate) {
      setMsg("Selecciona la fecha.");
      return;
    }

    try {
      await updateDoc(doc(db, "ar_movements_pollo", editMovId), {
        date: eMovDate,
        comment: eMovComment || "",
      });

      const newList = [...stRows];
      newList[idx] = {
        ...old,
        date: eMovDate,
        comment: eMovComment || "",
      };
      newList.sort((a, b) => {
        if (a.date !== b.date) return a.date.localeCompare(b.date);
        const as = a.createdAt?.seconds || 0;
        const bs = b.createdAt?.seconds || 0;
        return as - bs;
      });

      setStRows(newList);
      recomputeKpis(newList, Number(stCustomer.initialDebt || 0));

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const nuevoSaldo = roundCurrency(
        Number(stCustomer.initialDebt || 0) + sumMov,
      );

      const openDebt = hasOpenDebt(newList, nuevoSaldo);
      const last = openDebt ? getLastAbonoFromList(newList) : null;

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: openDebt && last ? last.date : "",
                lastAbonoAmount: openDebt && last ? last.amount : 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: openDebt && last ? last.date : "",
              lastAbonoAmount: openDebt && last ? last.amount : 0,
            }
          : prev,
      );

      cancelEditMovement();
      setMsg("✅ Movimiento actualizado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al actualizar movimiento");
    }
  };

  const deleteMovement = async (m: MovementRow) => {
    const ok = confirm(
      `¿Eliminar este movimiento (${m.type === "ABONO" ? "Abono" : "Compra"}) del ${m.date}?${
        m.type === "CARGO" && m.ref?.saleId
          ? "\nSe borrarán los registros de esa venta."
          : ""
      }`,
    );
    if (!ok) return;

    if (!stCustomer) return;

    try {
      setLoading(true);

      if (m.type === "CARGO" && m.ref?.saleId) {
        try {
          await deleteDoc(doc(db, "salesV2", m.ref.saleId));
        } catch (e) {
          console.warn("delete sale error", e);
          setLoading(false);
          setMsg("❌ No se pudo borrar la venta asociada.");
          return;
        }
        await deleteARMovesBySaleId(m.ref.saleId);
      } else {
        await deleteDoc(doc(db, "ar_movements_pollo", m.id));
      }

      let newList = stRows.filter((x) => {
        if (m.type === "CARGO" && m.ref?.saleId) {
          return x.ref?.saleId !== m.ref.saleId;
        }
        return x.id !== m.id;
      });

      if (m.type === "ABONO" && m.ref?.saleId) {
        newList = await syncCargoDebtStatusForSaleId(
          newList,
          m.ref.saleId,
        );
      }

      setStRows(newList);
      recomputeKpis(newList, Number(stCustomer.initialDebt || 0));

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const nuevoSaldo = roundCurrency(
        Number(stCustomer.initialDebt || 0) + sumMov,
      );

      const openDebt = hasOpenDebt(newList, nuevoSaldo);
      const last = openDebt ? getLastAbonoFromList(newList) : null;

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: openDebt && last ? last.date : "",
                lastAbonoAmount: openDebt && last ? last.amount : 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: openDebt && last ? last.date : "",
              lastAbonoAmount: openDebt && last ? last.amount : 0,
            }
          : prev,
      );

      setExpandedMovementId(null);
      setMsg("🗑️ Movimiento eliminado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar movimiento");
    } finally {
      setLoading(false);
    }
  };

  const orderedRows = useMemo(() => {
    return [...rows].sort((a, b) => {
      if (a.status !== b.status) return a.status === "BLOQUEADO" ? 1 : -1;
      return (b.createdAt?.seconds || 0) - (a.createdAt?.seconds || 0);
    });
  }, [rows]);

  const badgeStatus = (st: Status) =>
    st === "ACTIVO" ? "bg-green-100 text-green-700" : "bg-red-100 text-red-700";

  const filteredRows = useMemo(() => {
    const q = fClient.trim().toLowerCase();
    const min = fMin.trim() === "" ? null : Number(fMin);
    const max = fMax.trim() === "" ? null : Number(fMax);

    let out = orderedRows.filter((c) => {
      const nameOk =
        !q ||
        String(c.name || "")
          .toLowerCase()
          .includes(q);

      const statusOk = !fStatus || c.status === fStatus;

      const bal = Number(c.balance || 0);
      const minOk = min === null || (!Number.isNaN(min) && bal >= min);
      const maxOk = max === null || (!Number.isNaN(max) && bal <= max);

      return nameOk && statusOk && minOk && maxOk;
    });

    // Apply sorting by selected mode
    if (sortMode === "lastAbono") {
      out = out.slice().sort((a, b) => {
        const da = String(a.lastAbonoDate || "");
        const db = String(b.lastAbonoDate || "");
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      });
    } else if (sortMode === "lastSale") {
      out = out.slice().sort((a, b) => {
        const da = String(a.lastSaleDate || "");
        const db = String(b.lastSaleDate || "");
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        return db.localeCompare(da);
      });
    }

    return out;
  }, [orderedRows, fClient, fStatus, fMin, fMax, sortMode]);

  const totalPendingBalance = useMemo(() => {
    return filteredRows.reduce((acc, row) => acc + Number(row.balance || 0), 0);
  }, [filteredRows]);

  const activeCustomersCount = useMemo(() => {
    return filteredRows.filter((row) => row.status === "ACTIVO").length;
  }, [filteredRows]);

  const totalCustomersCount = filteredRows.length;

  const handleResetFilters = () => {
    setFClient("");
    setFStatus("");
    setFMin("");
    setFMax("");
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Clientes (Pollo)</h2>
        <button
          className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
          onClick={() => {
            setShowCreateModal(true);
            if (isVendor) setVendorId(sellerIdSafe);
          }}
          type="button"
        >
          Crear Cliente
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mb-4">
        <div className="p-4 border border-amber-200 rounded-xl bg-gradient-to-br from-amber-50 to-white shadow-sm">
          <div className="text-[11px] uppercase tracking-wider text-amber-700">
            Saldo pendiente
          </div>
          <div className="text-2xl font-semibold text-amber-900">
            {money(totalPendingBalance)}
          </div>
          <p className="text-[11px] text-amber-700/80 mt-1">
            Calculado sobre los clientes filtrados
          </p>
        </div>
        <div className="p-4 border border-emerald-200 rounded-xl bg-gradient-to-br from-emerald-50 to-white shadow-sm">
          <div className="text-[11px] uppercase tracking-wider text-emerald-700">
            Clientes activos
          </div>
          <div className="text-2xl font-semibold text-emerald-900">
            {activeCustomersCount}
          </div>
          <p className="text-[11px] text-emerald-700/80 mt-1">
            De un total de {totalCustomersCount}
          </p>
        </div>
      </div>

      <div className="bg-white border rounded shadow-sm p-4 mb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={`px-2 py-1 rounded border text-sm ${
                sortMode === "lastAbono" ? "bg-blue-600 text-white" : ""
              }`}
              onClick={() =>
                setSortMode((s) => (s === "lastAbono" ? "" : "lastAbono"))
              }
              title="Ordenar por último abono"
            >
              <span className="hidden sm:inline">Último abono</span>
              <FiClock className="inline sm:hidden" />
            </button>
            <button
              type="button"
              className={`px-2 py-1 rounded border text-sm ${
                sortMode === "lastSale" ? "bg-blue-600 text-white" : ""
              }`}
              onClick={() =>
                setSortMode((s) => (s === "lastSale" ? "" : "lastSale"))
              }
              title="Ordenar por última compra"
            >
              <span className="hidden sm:inline">Última compra</span>
              <FiShoppingCart className="inline sm:hidden" />
            </button>
          </div>
          <div className="flex-1">
            <label className="block text-sm font-semibold">
              Filtrar cliente
            </label>
            <input
              className="w-full border rounded px-3 py-2"
              placeholder="Nombre, teléfono o nota"
              value={fClient}
              onChange={(e) => setFClient(e.target.value)}
            />
          </div>
          <div className="flex gap-2">
            <button
              type="button"
              className="px-3 py-2 rounded border bg-gray-50 hover:bg-gray-100"
              onClick={() => setFiltersOpen((prev) => !prev)}
            >
              {filtersOpen ? "Ocultar filtros" : "Más filtros"}
            </button>
            <button
              type="button"
              className="px-3 py-2 rounded border bg-white hover:bg-gray-50"
              onClick={handleResetFilters}
            >
              Limpiar
            </button>
          </div>
        </div>

        {filtersOpen && (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-3 gap-3">
            <div>
              <label className="block text-sm font-semibold">Estado</label>
              <select
                className="w-full border rounded px-3 py-2"
                value={fStatus}
                onChange={(e) => setFStatus(e.target.value as Status | "")}
              >
                <option value="">Todos</option>
                <option value="ACTIVO">Activo</option>
                <option value="BLOQUEADO">Bloqueado</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-semibold">
                Saldo mínimo
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border rounded px-3 py-2"
                value={fMin}
                onChange={(e) => setFMin(e.target.value)}
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold">
                Saldo máximo
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border rounded px-3 py-2"
                value={fMax}
                onChange={(e) => setFMax(e.target.value)}
                placeholder="0.00"
              />
            </div>
          </div>
        )}
      </div>

      {/* el resto de la UI se mantiene muy similar al original, adaptada a Pollo */}
      {/* Para no duplicar aquí el archivo completo otra vez, el componente copia los mismos bloques de UI
          (listado, filtros, modales) pero usando las collections *_pollo y sin llamadas a lógica de Dulces. */}

      {/* Nota: implementé las áreas críticas: cargas, creación, edición, borrado y estado de cuenta.
          Si quieres que reemplace textos adicionales (antes mostraban "dulces") los adapto.
      */}
      <div className="bg-white p-2 rounded-xl shadow-sm border border-slate-200 w-full">
        {/* tabla simplificada: muestra nombres y saldo como placeholder */}
        <div className="hidden md:block">
          <div className="rounded-xl overflow-hidden border border-slate-200">
            <table className="min-w-full w-full text-sm">
              <thead className="bg-slate-100 sticky top-0 z-10">
                <tr className="text-[11px] uppercase tracking-wider text-slate-600">
                  <th className="p-3 border-b text-left">Estado</th>

                  <th className="p-3 border-b text-left">Creado</th>

                  <th className="p-3 border-b text-left">Ult. Compra</th>
                  <th className="p-3 border-b text-left">Ult. Abono</th>
                  <th className="p-3 border-b text-left">Nombre</th>
                  {/* <th className="p-3 border-b text-left">Teléfono</th> */}
                  <th className="p-3 border-b text-left">Vendedor</th>
                  {/* <th className="p-3 border-b text-left">Lugar</th> */}
                  {/* <th className="p-3 border-b text-right">Límite</th> */}
                  <th className="p-3 border-b text-right">Saldo</th>
                  <th className="p-3 border-b text-left">Comentario</th>
                  <th className="p-3 border-b text-right">Acciones</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td className="p-4 text-center" colSpan={12}>
                      Cargando…
                    </td>
                  </tr>
                ) : filteredRows.length === 0 ? (
                  <tr>
                    <td className="p-4 text-center" colSpan={12}>
                      Sin clientes
                    </td>
                  </tr>
                ) : (
                  filteredRows.map((c) => {
                    const isEditing = editingId === c.id;
                    return (
                      <tr
                        key={c.id}
                        className="text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition"
                      >
                        <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <select
                              className="w-full border p-1 rounded"
                              value={eStatus}
                              onChange={(e) =>
                                setEStatus(e.target.value as Status)
                              }
                            >
                              <option value="ACTIVO">ACTIVO</option>
                              <option value="BLOQUEADO">BLOQUEADO</option>
                            </select>
                          ) : (
                            <span
                              className={`px-2 py-0.5 rounded text-xs ${badgeStatus(c.status)}`}
                            >
                              {c.status}
                            </span>
                          )}
                        </td>
                        <td className="p-3 border-b text-left">
                          {c.createdAt
                            ? formatLocalDate(c.createdAt)
                            : "—"}
                        </td>
                        <td className="p-3 border-b text-left">
                          {c.lastSaleDate ? c.lastSaleDate : "—"}
                        </td>
                        <td className="p-3 border-b text-left">
                          {c.lastAbonoDate ? c.lastAbonoDate : "—"}
                        </td>
                        <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <input
                              className="w-full border p-1 rounded"
                              value={eName}
                              onChange={(e) => setEName(e.target.value)}
                            />
                          ) : (
                            <div className="font-medium text-slate-900">
                              {c.name}
                            </div>
                          )}
                        </td>
                        {/* <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <input
                              className="w-full border p-1 rounded"
                              value={ePhone}
                              onChange={(e) =>
                                setEPhone(normalizePhone(e.target.value))
                              }
                            />
                          ) : (
                            c.phone
                          )}
                        </td> */}
                        <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <select
                              className="w-full border p-1 rounded text-xs"
                              value={isVendor ? sellerIdSafe : eVendorId}
                              onChange={(e) => setEVendorId(e.target.value)}
                              disabled={isVendor}
                              title="Vendedor asociado"
                            >
                              <option value="">— Sin vendedor —</option>
                              {sellers.map((s) => (
                                <option key={s.id} value={s.id}>
                                  {s.name}
                                </option>
                              ))}
                            </select>
                          ) : (
                            c.vendorName || "—"
                          )}
                        </td>
                        {/* <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <select
                              className="w-full border p-1 rounded"
                              value={ePlace}
                              onChange={(e) =>
                                setEPlace(e.target.value as Place)
                              }
                            >
                              <option value="">—</option>
                              {PLACES.map((p) => (
                                <option key={p} value={p}>
                                  {p}
                                </option>
                              ))}
                            </select>
                          ) : (
                            c.place || "—"
                          )}
                        </td> */}

                        {/* <td className="p-3 border-b text-right">
                          {isEditing ? (
                            <input
                              type="number"
                              step="0.01"
                              inputMode="decimal"
                              className="w-full border p-1 rounded text-right"
                              value={
                                Number.isNaN(eCreditLimit) ? "" : eCreditLimit
                              }
                              onChange={(e) =>
                                setECreditLimit(
                                  Math.max(0, Number(e.target.value || 0)),
                                )
                              }
                            />
                          ) : (
                            money(c.creditLimit || 0)
                          )}
                        </td> */}
                        <td className="p-3 border-b text-right font-semibold">
                          {money(c.balance || 0)}
                        </td>
                        <td className="p-3 border-b text-left">
                          {isEditing ? (
                            <textarea
                              className="w-full border p-1 rounded resize-y min-h-12"
                              value={eNotes}
                              onChange={(e) => setENotes(e.target.value)}
                              maxLength={500}
                            />
                          ) : (
                            <span title={c.notes || ""}>
                              {(c.notes || "").length > 40
                                ? (c.notes || "").slice(0, 40) + "…"
                                : c.notes || "—"}
                            </span>
                          )}
                        </td>
                        <td className="p-3 border-b text-right">
                          {isEditing ? (
                            <div className="flex gap-2 justify-end">
                              <button
                                className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                                onClick={saveEdit}
                              >
                                Guardar
                              </button>
                              <button
                                className="px-2 py-1 rounded bg-gray-200 hover:bg-gray-300"
                                onClick={cancelEdit}
                              >
                                Cancelar
                              </button>
                            </div>
                          ) : (
                            <button
                              type="button"
                              className="p-2 rounded-lg border border-slate-200 hover:bg-slate-50 inline-flex"
                              aria-label="Acciones del cliente"
                              onClick={(e) => {
                                e.stopPropagation();
                                setCustomerRowMenu({
                                  id: c.id,
                                  rect: (
                                    e.currentTarget as HTMLElement
                                  ).getBoundingClientRect(),
                                });
                              }}
                            >
                              <FiMoreVertical className="w-5 h-5 text-slate-700" />
                            </button>
                          )}
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
        </div>
        {/* ===== MOBILE LIST (ANTES NO EXISTÍA, POR ESO EN CEL SE VE VACÍO) ===== */}
        <div className="md:hidden space-y-2">
          {loading ? (
            <div className="p-4 text-center text-sm text-gray-600">
              Cargando…
            </div>
          ) : filteredRows.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">
              Sin clientes
            </div>
          ) : (
            filteredRows.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border-2 border-slate-200 bg-gradient-to-br from-slate-50 via-white to-indigo-50/40 p-3 shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-semibold text-base">{c.name}</div>
                    <div className="text-xs text-gray-600">
                      {c.phone || "—"}
                    </div>
                    <div className="text-xs text-gray-600">
                      Vendedor:{" "}
                      <span className="font-medium">{c.vendorName || "—"}</span>
                    </div>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded text-xs ${badgeStatus(c.status)}`}
                  >
                    {c.status}
                  </span>
                </div>

                <div className="mt-2">
                  <div className="rounded-lg border border-indigo-200 bg-indigo-50/80 p-3 text-sm shadow-sm">
                    <div className="text-[11px] font-medium text-indigo-700">
                      Saldo
                    </div>
                    <div className="text-lg font-semibold text-indigo-950">
                      {money(c.balance || 0)}
                    </div>
                  </div>
                </div>

                <div className="mt-2 text-xs text-gray-600">
                  Último abono:{" "}
                  <span className="font-medium">
                    {c.lastAbonoDate
                      ? `${c.lastAbonoDate} (${money(c.lastAbonoAmount || 0)})`
                      : "—"}
                  </span>
                </div>

                {c.notes ? (
                  <div className="mt-2 text-xs text-gray-700">
                    <span className="font-semibold">Nota:</span>{" "}
                    {(c.notes || "").length > 80
                      ? (c.notes || "").slice(0, 80) + "…"
                      : c.notes}
                  </div>
                ) : null}

                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    className="p-2 rounded-lg border border-gray-200 hover:bg-gray-50"
                    aria-label="Acciones del cliente"
                    onClick={(e) =>
                      setCustomerRowMenu({
                        id: c.id,
                        rect: (
                          e.currentTarget as HTMLElement
                        ).getBoundingClientRect(),
                      })
                    }
                  >
                    <FiMoreVertical className="w-5 h-5 text-gray-700" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      </div>

      <ActionMenu
        anchorRect={customerRowMenu?.rect ?? null}
        isOpen={!!customerRowMenu}
        onClose={() => setCustomerRowMenu(null)}
        width={220}
      >
        {customerRowMenu &&
          (() => {
            const c = rows.find((x) => x.id === customerRowMenu.id);
            if (!c) {
              return (
                <div className="px-3 py-2 text-sm text-gray-500">
                  Sin datos
                </div>
              );
            }
            return (
              <div className="py-1">
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                  onClick={() => {
                    setCustomerRowMenu(null);
                    void openStatement(c);
                  }}
                >
                  Estado de cuenta
                </button>
                <button
                  type="button"
                  className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
                  disabled={isVendor}
                  onClick={() => {
                    setCustomerRowMenu(null);
                    startEdit(c);
                  }}
                >
                  Editar cliente
                </button>
                {isAdmin && (
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-700"
                    onClick={() => {
                      setCustomerRowMenu(null);
                      void handleDelete(c);
                    }}
                  >
                    Borrar cliente
                  </button>
                )}
              </div>
            );
          })()}
      </ActionMenu>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* modal crear — mantenido igual (usa customers_pollo) */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-3xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">Crear Cliente</h3>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              <form
                onSubmit={handleCreate}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                <div>
                  <label className="block text-sm font-semibold">Nombre</label>
                  <input
                    className="w-full border p-2 rounded"
                    placeholder="Ej: María López"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Teléfono
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    value={phone}
                    onChange={(e) => setPhone(normalizePhone(e.target.value))}
                    placeholder="+505 88888888"
                    inputMode="numeric"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">Lugar</label>
                  <select
                    className="w-full border p-2 rounded"
                    value={place}
                    onChange={(e) => setPlace(e.target.value as Place)}
                  >
                    <option value="">—</option>
                    {PLACES.map((p) => (
                      <option key={p} value={p}>
                        {p}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold">Estado</label>
                  <select
                    className="w-full border p-2 rounded"
                    value={status}
                    onChange={(e) => setStatus(e.target.value as Status)}
                  >
                    <option value="ACTIVO">ACTIVO</option>
                    <option value="BLOQUEADO">BLOQUEADO</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Vendedor asociado
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={isVendor ? sellerIdSafe : vendorId}
                    onChange={(e) => setVendorId(e.target.value)}
                    disabled={isVendor}
                  >
                    <option value="">— Sin vendedor —</option>
                    {sellers.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.name}
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Deuda inicial
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={initialDebt === 0 ? "" : initialDebt}
                    onChange={(e) =>
                      setInitialDebt(Math.max(0, Number(e.target.value || 0)))
                    }
                    placeholder="Ej: 1500"
                  />
                  <div className="text-xs text-gray-500 mt-1">
                    Este valor cuenta como saldo desde el inicio.
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Límite de crédito (opcional)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={creditLimit === 0 ? "" : creditLimit}
                    onChange={(e) =>
                      setCreditLimit(Math.max(0, Number(e.target.value || 0)))
                    }
                    placeholder="Ej: 2000"
                  />
                </div>
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Comentario
                  </label>
                  <textarea
                    className="w-full border p-2 rounded resize-y min-h-24"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={500}
                    placeholder="Notas del cliente…"
                  />
                  <div className="text-xs text-gray-500 text-right">
                    {notes.length}/500
                  </div>
                </div>
                <div className="md:col-span-2 flex justify-end gap-2">
                  <button
                    type="button"
                    className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => setShowCreateModal(false)}
                  >
                    Cancelar
                  </button>
                  <button className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700">
                    Guardar cliente
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {/* modal estado de cuenta y demás modales reutilizan la misma lógica que en Candies pero apuntando a las collections de Pollo */}
      {showStatement &&
        createPortal(
          <div className="fixed inset-0 z-[50]" style={{ zIndex: 50 }}>
            {/* overlay */}
            <div
              className="absolute inset-0 bg-black/40"
              onClick={closeStatement}
            />

            {/* modal */}
            <div className="absolute inset-0 flex items-center justify-center p-4">
              <div className="bg-white rounded-lg shadow-xl border w-full max-w-5xl max-h-[92vh] overflow-auto p-4">
                <div className="flex items-center justify-between mb-3 gap-3">
                  <h3 className="text-lg font-bold">
                    Estado de cuenta — {stCustomer?.name || ""}
                  </h3>

                  <div className="flex gap-2 shrink-0">
                    <button
                      type="button"
                      className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                      onClick={closeStatement}
                    >
                      Cerrar
                    </button>
                  </div>
                </div>

                {/* KPIs (VISIBLE SIEMPRE) */}
                <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                  <div className="p-3 border-2 rounded-xl border-indigo-200 bg-gradient-to-br from-indigo-50 to-white shadow-sm">
                    <div className="text-xs font-medium text-indigo-700">
                      Saldo actual
                    </div>
                    <div className="text-xl font-semibold text-indigo-900">
                      {money(stKpis.saldoActual)}
                    </div>
                  </div>
                  <div className="p-3 border-2 rounded-xl border-emerald-200 bg-gradient-to-br from-emerald-50 to-white shadow-sm">
                    <div className="text-xs font-medium text-emerald-700">
                      Total abonado
                    </div>
                    <div className="text-xl font-semibold text-emerald-900">
                      {money(stKpis.totalAbonado)}
                    </div>
                  </div>
                  <div className="p-3 border-2 rounded-xl border-amber-200 bg-gradient-to-br from-amber-50 to-white shadow-sm">
                    <div className="text-xs font-medium text-amber-800">
                      Saldo restante
                    </div>
                    <div className="text-xl font-semibold text-amber-950">
                      {money(stKpis.saldoRestante)}
                    </div>
                  </div>
                </div>

                <div className="mb-3 text-sm text-gray-600">
                  <button
                    type="button"
                    className="text-blue-600 underline hover:text-blue-800"
                    onClick={() => {
                      setAbonoTargetSaleId(null);
                      setAbonoAmount(0);
                      setAbonoDate(formatLocalDate(new Date()));
                      setAbonoComment("");
                      setShowAbono(true);
                    }}
                  >
                    Registrar abono general (no ligado a una venta)
                  </button>
                </div>

                {/* Tabla (desktop): solo ventas a crédito */}
                <div className="hidden md:block bg-white rounded border overflow-x-auto">
                  <table className="min-w-full text-sm">
                    <thead className="bg-gray-100">
                      <tr>
                        <th className="p-2 border">Fecha</th>
                        <th className="p-2 border">Total venta</th>
                        <th className="p-2 border">Pendiente</th>
                        <th className="p-2 border">Estado</th>
                        <th className="p-2 border">Detalle</th>
                        <th className="p-2 border w-12"> </th>
                      </tr>
                    </thead>

                    <tbody>
                      {stLoading ? (
                        <tr>
                          <td colSpan={6} className="p-4 text-center">
                            Cargando…
                          </td>
                        </tr>
                      ) : saleVentasRows.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-4 text-center">
                            Sin ventas a crédito registradas
                          </td>
                        </tr>
                      ) : (
                        saleVentasRows.map((m) => {
                          const saleId = m.ref!.saleId!;
                          const pending = getPendingForSale(stRows, saleId);
                          const normalizedDebt = normalizeDebtStatus(
                            m.debtStatus,
                          );
                          return (
                            <tr key={m.id} className="text-center">
                              <td className="p-2 border">{m.date || "—"}</td>
                              <td className="p-2 border font-semibold">
                                {money(m.amount)}
                              </td>
                              <td className="p-2 border font-medium text-orange-800">
                                {money(pending)}
                              </td>
                              <td className="p-2 border">
                                <span
                                  className={`px-2 py-0.5 rounded text-xs ${normalizedDebt === "PAGADA" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"}`}
                                >
                                  {normalizedDebt === "PAGADA"
                                    ? "Pagada"
                                    : "Pendiente"}
                                </span>
                              </td>
                              <td className="p-2 border">
                                <button
                                  type="button"
                                  className="px-2 py-0.5 rounded text-xs bg-yellow-100 text-yellow-700 underline"
                                  onClick={() => openItemsModal(saleId)}
                                >
                                  Ver detalle
                                </button>
                              </td>
                              <td className="p-2 border">
                                <button
                                  type="button"
                                  className="p-1.5 rounded hover:bg-gray-100 inline-flex"
                                  aria-label="Acciones de venta"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setSaleMenuAnchor({
                                      saleId,
                                      rect: (
                                        e.currentTarget as HTMLElement
                                      ).getBoundingClientRect(),
                                    });
                                  }}
                                >
                                  <FiMoreVertical className="w-5 h-5 text-gray-700" />
                                </button>
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Mobile: tarjetas por venta */}
                <div className="md:hidden space-y-3">
                  {stLoading ? (
                    <div className="p-4 text-center text-sm">Cargando…</div>
                  ) : saleVentasRows.length === 0 ? (
                    <div className="p-4 text-center text-sm">
                      Sin ventas a crédito registradas
                    </div>
                  ) : (
                    saleVentasRows.map((m) => {
                      const saleId = m.ref!.saleId!;
                      const pending = getPendingForSale(stRows, saleId);
                      const normalizedDebt = normalizeDebtStatus(m.debtStatus);
                      return (
                        <div
                          key={m.id}
                          className="rounded-xl border-2 border-sky-200 bg-gradient-to-br from-sky-50/90 via-white to-cyan-50/50 p-3 shadow-md"
                        >
                          <div className="flex items-start justify-between gap-2">
                            <div>
                              <div className="text-sm font-semibold text-slate-900">
                                {m.date || "—"}
                              </div>
                              <div className="text-xs text-gray-600 mt-1">
                                Total:{" "}
                                <span className="font-semibold text-gray-900">
                                  {money(m.amount)}
                                </span>
                              </div>
                              <div className="text-xs text-orange-800 mt-0.5">
                                Pendiente: {money(pending)}
                              </div>
                              <div className="mt-2">
                                <span
                                  className={`px-2 py-0.5 rounded text-xs ${normalizedDebt === "PAGADA" ? "bg-green-100 text-green-700" : "bg-orange-100 text-orange-700"}`}
                                >
                                  {normalizedDebt === "PAGADA"
                                    ? "Pagada"
                                    : "Pendiente"}
                                </span>
                              </div>
                              <button
                                type="button"
                                className="text-xs text-yellow-700 underline mt-2"
                                onClick={() => openItemsModal(saleId)}
                              >
                                Ver detalle de compra
                              </button>
                            </div>
                            <button
                              type="button"
                              className="p-2 rounded-lg border border-gray-200 shrink-0"
                              aria-label="Acciones de venta"
                              onClick={(e) => {
                                e.stopPropagation();
                                setSaleMenuAnchor({
                                  saleId,
                                  rect: (
                                    e.currentTarget as HTMLElement
                                  ).getBoundingClientRect(),
                                });
                              }}
                            >
                              <FiMoreVertical className="w-5 h-5 text-gray-700" />
                            </button>
                          </div>
                        </div>
                      );
                    })
                  )}
                </div>

                {editMovId &&
                  (() => {
                    const em = stRows.find((x) => x.id === editMovId);
                    if (!em) return null;
                    return (
                      <div className="mt-4 border rounded-lg p-4 bg-amber-50 border-amber-200">
                        <div className="font-semibold mb-2">
                          Editar movimiento (
                          {em.type === "ABONO" ? "Abono" : "Compra"})
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
                          <div>
                            <label className="block text-xs font-medium text-gray-600">
                              Fecha
                            </label>
                            <input
                              type="date"
                              className="w-full border p-2 rounded"
                              value={eMovDate}
                              onChange={(e) => setEMovDate(e.target.value)}
                            />
                          </div>
                          <div className="md:col-span-2">
                            <label className="block text-xs font-medium text-gray-600">
                              Comentario
                            </label>
                            <input
                              className="w-full border p-2 rounded"
                              value={eMovComment}
                              onChange={(e) => setEMovComment(e.target.value)}
                            />
                          </div>
                        </div>
                        <p className="text-xs text-gray-500 mt-2">
                          Solo se pueden editar fecha y comentario; el monto no
                          se modifica aquí.
                        </p>
                        <div className="mt-3 flex gap-2 justify-end">
                          <button
                            type="button"
                            className="px-3 py-1.5 rounded bg-gray-200 hover:bg-gray-300"
                            onClick={cancelEditMovement}
                          >
                            Cancelar
                          </button>
                          <button
                            type="button"
                            className="px-3 py-1.5 rounded bg-blue-600 text-white hover:bg-blue-700"
                            onClick={saveEditMovement}
                          >
                            Guardar
                          </button>
                        </div>
                      </div>
                    );
                  })()}
              </div>
            </div>

            <ActionMenu
              anchorRect={saleMenuAnchor?.rect ?? null}
              isOpen={!!saleMenuAnchor}
              onClose={() => setSaleMenuAnchor(null)}
              width={260}
            >
              {saleMenuAnchor &&
                (() => {
                  const sid = saleMenuAnchor.saleId;
                  const cargoM = stRows.find(
                    (x) =>
                      x.type === "CARGO" &&
                      x.ref?.saleId === sid &&
                      Number(x.amount) > 0,
                  );
                  if (!cargoM) {
                    return (
                      <div className="px-3 py-2 text-sm text-gray-500">
                        Sin datos
                      </div>
                    );
                  }
                  const pend = getPendingForSale(stRows, sid);
                  return (
                    <div className="py-1">
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
                        disabled={savingAbono || !(pend > 0.005)}
                        onClick={() => {
                          setSaleMenuAnchor(null);
                          void payFullSale(sid);
                        }}
                      >
                        Pagar
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 disabled:opacity-50"
                        disabled={savingAbono || !(pend > 0.005)}
                        onClick={() => {
                          setSaleMenuAnchor(null);
                          setAbonoTargetSaleId(sid);
                          setAbonoAmount(0);
                          setAbonoDate(formatLocalDate(new Date()));
                          setAbonoComment("");
                          setShowAbono(true);
                        }}
                      >
                        Abonar
                      </button>
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                        onClick={() => {
                          setSaleMenuAnchor(null);
                          setSaleLedgerSaleId(sid);
                        }}
                      >
                        Ver cuenta
                      </button>
                      {stRows.some(
                        (m) =>
                          m.type === "ABONO" &&
                          m.ref?.saleId === sid &&
                          isFullPaymentAbonoComment(m.comment),
                      ) && (
                        <button
                          type="button"
                          className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-amber-800 disabled:opacity-50"
                          disabled={savingAbono}
                          onClick={() => {
                            setSaleMenuAnchor(null);
                            void revertFullPaymentSale(sid);
                          }}
                        >
                          Revertir pago total
                        </button>
                      )}
                      {isAdmin && (
                        <>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                            onClick={() => {
                              setSaleMenuAnchor(null);
                              startEditMovement(cargoM);
                            }}
                          >
                            Editar movimiento
                          </button>
                          <button
                            type="button"
                            className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-700"
                            onClick={() => {
                              setSaleMenuAnchor(null);
                              void deleteMovement(cargoM);
                            }}
                          >
                            Eliminar venta
                          </button>
                        </>
                      )}
                    </div>
                  );
                })()}
            </ActionMenu>

            {saleLedgerSaleId && (
              <div className="fixed inset-0 z-[62] flex items-center justify-center p-4">
                <div
                  className="absolute inset-0 bg-black/40"
                  onClick={() => setSaleLedgerSaleId(null)}
                />
                <div
                  className="relative z-10 bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl max-h-[85vh] overflow-auto p-4"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-start justify-between gap-2 mb-3">
                    <div>
                      <h3 className="text-lg font-bold">
                        Cuenta de la venta
                      </h3>
                      <p className="text-sm text-gray-600">
                        Cliente: {stCustomer?.name || "—"}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 shrink-0"
                      onClick={() => setSaleLedgerSaleId(null)}
                    >
                      Cerrar
                    </button>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
                    <div className="p-3 border-2 rounded-xl border-violet-200 bg-gradient-to-br from-violet-50 to-white shadow-sm">
                      <div className="text-xs font-medium text-violet-700">
                        Saldo actual
                      </div>
                      <div className="text-lg font-semibold text-violet-950">
                        {money(
                          getPendingForSale(stRows, saleLedgerSaleId),
                        )}
                      </div>
                    </div>
                    <div className="p-3 border-2 rounded-xl border-teal-200 bg-gradient-to-br from-teal-50 to-white shadow-sm">
                      <div className="text-xs font-medium text-teal-800">
                        Abonos
                      </div>
                      <div className="text-lg font-semibold text-teal-950">
                        {money(
                          getTotalAbonadoForSale(stRows, saleLedgerSaleId),
                        )}
                      </div>
                    </div>
                  </div>

                  <div className="hidden md:block border rounded overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="p-2 border text-left">Fecha</th>
                          <th className="p-2 border text-right">Monto</th>
                          <th className="p-2 border text-right">
                            Saldo inicial
                          </th>
                          <th className="p-2 border text-right">
                            Saldo final
                          </th>
                          <th className="p-2 border text-left">Comentario</th>
                          {isAdmin && (
                            <th className="p-2 border text-center">Acciones</th>
                          )}
                        </tr>
                      </thead>
                      <tbody>
                        {saleLedgerComputed.length === 0 ? (
                          <tr>
                            <td
                              colSpan={isAdmin ? 6 : 5}
                              className="p-4 text-center text-gray-500"
                            >
                              No hay abonos con referencia a esta venta. Los
                              abonos generales del cliente siguen reflejados en
                              los KPI del estado de cuenta.
                            </td>
                          </tr>
                        ) : (
                          saleLedgerComputed.map((row) => (
                            <tr key={row.id} className="text-center">
                              <td className="p-2 border">{row.date || "—"}</td>
                              <td className="p-2 border text-right font-medium">
                                {money(-row.montoAbs)}
                              </td>
                              <td className="p-2 border text-right">
                                {money(row.saldoInicial)}
                              </td>
                              <td className="p-2 border text-right">
                                {money(row.saldoFinal)}
                              </td>
                              <td className="p-2 border text-left text-xs">
                                {row.comment || "—"}
                              </td>
                              {isAdmin && (
                                <td className="p-2 border">
                                  <div className="flex gap-1 justify-center flex-wrap">
                                    <button
                                      type="button"
                                      className="text-xs text-blue-600 underline"
                                      onClick={() => {
                                        setSaleLedgerSaleId(null);
                                        startEditMovement(row);
                                      }}
                                    >
                                      Editar
                                    </button>
                                    <button
                                      type="button"
                                      className="text-xs text-red-600 underline"
                                      onClick={() => {
                                        void deleteMovement(row);
                                      }}
                                    >
                                      Borrar
                                    </button>
                                  </div>
                                </td>
                              )}
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="md:hidden space-y-3 mt-3">
                    {saleLedgerComputed.length === 0 ? (
                      <div className="p-3 text-sm text-gray-500 border rounded">
                        No hay abonos con referencia a esta venta.
                      </div>
                    ) : (
                      saleLedgerComputed.map((row) => (
                        <div
                          key={row.id}
                          className="rounded-xl border-2 border-slate-200 bg-gradient-to-br from-slate-50 to-white p-3 shadow-md"
                        >
                          <div className="flex justify-between text-sm">
                            <span className="font-medium">{row.date}</span>
                            <span className="font-semibold">
                              {money(-row.montoAbs)}
                            </span>
                          </div>
                          <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                            <div>
                              <div className="text-[11px]">Saldo inicial</div>
                              <div className="font-medium text-gray-900">
                                {money(row.saldoInicial)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px]">Saldo final</div>
                              <div className="font-medium text-gray-900">
                                {money(row.saldoFinal)}
                              </div>
                            </div>
                          </div>
                          <div className="mt-2 text-sm text-gray-700">
                            {row.comment || "—"}
                          </div>
                          {isAdmin && (
                            <div className="mt-2 flex gap-3 justify-end text-sm">
                              <button
                                type="button"
                                className="text-blue-600"
                                onClick={() => {
                                  setSaleLedgerSaleId(null);
                                  startEditMovement(row);
                                }}
                              >
                                Editar
                              </button>
                              <button
                                type="button"
                                className="text-red-600"
                                onClick={() => {
                                  void deleteMovement(row);
                                }}
                              >
                                Borrar
                              </button>
                            </div>
                          )}
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* items modal (sobre el estado de cuenta) */}
            {itemsModalOpen && (
              <div
                className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]"
                style={{ zIndex: 60 }}
              >
                <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="text-lg font-bold">
                      Productos vendidos{" "}
                      {/* {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""} */}
                    </h3>
                    <button
                      className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                      onClick={() => setItemsModalOpen(false)}
                    >
                      Cerrar
                    </button>
                  </div>
                  {/* Desktop table */}
                  <div className="hidden md:block bg-white rounded border overflow-x-auto">
                    <table className="min-w-full text-sm">
                      <thead className="bg-gray-100">
                        <tr>
                          <th className="p-2 border">Producto</th>
                          <th className="p-2 border text-right">Cantidad</th>
                          <th className="p-2 border text-right">Precio</th>
                          <th className="p-2 border text-right">Descuento</th>
                          <th className="p-2 border text-right">Monto</th>
                        </tr>
                      </thead>
                      <tbody>
                        {itemsModalLoading ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-center">
                              Cargando…
                            </td>
                          </tr>
                        ) : itemsModalRows.length === 0 ? (
                          <tr>
                            <td colSpan={5} className="p-4 text-center">
                              Sin ítems en esta venta.
                            </td>
                          </tr>
                        ) : (
                          itemsModalRows.map((it, idx) => (
                            <tr key={idx} className="text-center">
                              <td className="p-2 border text-left">
                                {it.productName}
                              </td>
                              <td className="p-2 border text-right">
                                {it.qty}
                              </td>
                              <td className="p-2 border text-right">
                                {money(it.unitPrice)}
                              </td>
                              <td className="p-2 border text-right">
                                {money(it.discount || 0)}
                              </td>
                              <td className="p-2 border text-right font-semibold">
                                {money(it.total)}
                              </td>
                            </tr>
                          ))
                        )}
                      </tbody>
                    </table>
                  </div>

                  {/* Mobile: cards */}
                  <div className="md:hidden space-y-3">
                    {itemsModalLoading ? (
                      <div className="p-4 text-center text-sm">Cargando…</div>
                    ) : itemsModalRows.length === 0 ? (
                      <div className="p-4 text-center text-sm">
                        Sin ítems en esta venta.
                      </div>
                    ) : (
                      itemsModalRows.map((it, idx) => (
                        <div
                          key={idx}
                          className="bg-white border rounded-lg p-3 shadow-sm"
                        >
                          <div className="flex items-start justify-between">
                            <div className="text-sm font-medium">
                              {it.productName}
                            </div>
                            <div className="text-sm font-semibold">
                              {money(it.total)}
                            </div>
                          </div>
                          <div className="mt-2 grid grid-cols-3 gap-2 text-xs text-gray-600">
                            <div>
                              <div className="text-[11px]">Cantidad</div>
                              <div className="font-medium">{it.qty}</div>
                            </div>
                            <div>
                              <div className="text-[11px]">Precio</div>
                              <div className="font-medium">
                                {money(it.unitPrice)}
                              </div>
                            </div>
                            <div>
                              <div className="text-[11px]">Descuento</div>
                              <div className="font-medium">
                                {it.discount ? money(it.discount) : "—"}
                              </div>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>,
          document.body,
        )}

      {/* ===== Modal Abonar ===== */}
      {showAbono && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[90]">
          <div className="bg-white rounded-lg shadow-2xl border w-[95%] max-w-md p-4">
            <h3 className="text-lg font-bold">
              {abonoTargetSaleId
                ? `Abonar venta — ${stCustomer?.name || ""}`
                : `Registrar abono — ${stCustomer?.name || ""}`}
            </h3>
            {abonoTargetSaleId && (
              <p className="text-sm text-gray-600 mt-1">
                Máximo pendiente de esta venta:{" "}
                <span className="font-semibold">
                  {money(getPendingForSale(stRows, abonoTargetSaleId))}
                </span>
              </p>
            )}

            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block text-sm font-semibold">Fecha</label>
                <input
                  type="date"
                  className="w-full border p-2 rounded"
                  value={abonoDate}
                  min={
                    abonoTargetSaleId
                      ? getCargoSaleDate(stRows, abonoTargetSaleId) ||
                        undefined
                      : undefined
                  }
                  onChange={(e) => setAbonoDate(e.target.value)}
                />
                {abonoTargetSaleId &&
                  getCargoSaleDate(stRows, abonoTargetSaleId) && (
                    <p className="text-xs text-gray-500 mt-1">
                      No anterior a la venta (
                      {getCargoSaleDate(stRows, abonoTargetSaleId)})
                    </p>
                  )}
              </div>

              <div>
                <label className="block text-sm font-semibold">Monto</label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={abonoAmount === 0 ? "" : abonoAmount}
                  onChange={(e) => {
                    const num = Number(e.target.value || 0);
                    const safe = Number.isFinite(num)
                      ? Math.max(0, parseFloat(num.toFixed(2)))
                      : 0;
                    setAbonoAmount(safe);
                  }}
                  placeholder="0.00"
                />
                <div className="text-xs text-gray-500 mt-1">
                  Se registrará como ABONO (negativo) con 2 decimales.
                </div>
              </div>

              <div>
                <label className="block text-sm font-semibold">
                  Comentario (opcional)
                </label>
                <textarea
                  className="w-full border p-2 rounded resize-y min-h-20"
                  value={abonoComment}
                  onChange={(e) => setAbonoComment(e.target.value)}
                  maxLength={250}
                  placeholder="Ej: Abono en efectivo"
                />
                <div className="text-xs text-gray-500 text-right">
                  {abonoComment.length}/250
                </div>
              </div>
            </div>

            <div className="mt-4 flex justify-end gap-2">
              <button
                className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => {
                  setShowAbono(false);
                  setAbonoTargetSaleId(null);
                }}
                disabled={savingAbono}
              >
                Cancelar
              </button>
              <button
                className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                onClick={saveAbono}
                disabled={savingAbono}
              >
                {savingAbono ? "Guardando..." : "Guardar abono"}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
