// src/components/Candies/CustomersCandy.tsx
import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  limit,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";
import {
  syncAbonoCommissionsForCustomer,
  buildSaleMetaMap,
  fetchSellersCandiesCommissionMap,
  commissionFromSaleDoc,
  saleTotalFromDoc,
} from "../../Services/commissionAbonoCandies";
import { FiMoreVertical } from "react-icons/fi";
import ActionMenu from "../common/ActionMenu";
import RefreshButton from "../common/RefreshButton";
import CommissionAbonoHelpButton from "../common/CommissionAbonoHelpModal";
import SlideOverDrawer from "../common/SlideOverDrawer";
import {
  DrawerDetailDlCard,
  DrawerMoneyStrip,
  DrawerSectionTitle,
} from "../common/DrawerContentCards";
import MobileKpiTwoColumn from "../common/MobileKpiTwoColumn";
import Toast from "../common/Toast";
import MobileHtmlSelect from "../common/MobileHtmlSelect";

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
  sellerId?: string;

  vendorId?: string;
  vendorName?: string;
  initialDebt?: number;
  initialDebtDate?: string;

  // ✅ NUEVO: para mobile (último abono)
  lastAbonoDate?: string; // yyyy-MM-dd
  lastAbonoAmount?: number; // positivo (monto del abono)

  lastSaleDate?: string;
  lastSaleDateTime?: string;
  lastSaleAmount?: number;
}

interface MovementRow {
  id: string;
  date: string; // yyyy-MM-dd
  type: "CARGO" | "ABONO";
  amount: number; // CARGO > 0, ABONO < 0
  ref?: { saleId?: string };
  comment?: string;
  createdAt?: Timestamp;
  /** Estado de cobro del CARGO (venta a crédito), sincronizado al abonar */
  debtStatus?: string;
  /** Comisión vendedor atribuible a este abono (proporcional al total de la venta ligada) */
  commissionOnPayment?: number;
  commissionBreakdown?: {
    saleId: string;
    appliedAmount: number;
    saleTotal: number;
    saleCommissionTotal: number;
    commissionPortion: number;
  }[];
}

interface SellerRow {
  id: string;
  name: string;
  status?: string;
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

const roundCurrency = (n: number) =>
  Math.round((Number(n) || 0) * 100) / 100;

const PAID_DEBT_FLAGS = new Set([
  "PAGADA",
  "PAGADO",
  "CERRADA",
  "CERRADO",
  "LIQUIDADA",
  "LIQUIDADO",
]);

function normalizeDebtStatus(value?: string): "PENDIENTE" | "PAGADA" {
  const upper = String(value || "")
    .trim()
    .toUpperCase();
  if (PAID_DEBT_FLAGS.has(upper)) return "PAGADA";
  return "PENDIENTE";
}

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

function getCargoSaleDate(rows: MovementRow[], saleId: string): string {
  const sid = String(saleId || "").trim();
  const c = rows.find(
    (m) =>
      m.type === "CARGO" &&
      String(m.ref?.saleId || "").trim() === sid &&
      Number(m.amount) > 0,
  );
  return (c?.date || "").trim().slice(0, 10);
}

async function resolveMinAbonoDateFromSaleCandies(
  rows: MovementRow[],
  saleId: string,
): Promise<string> {
  const fromCargo = getCargoSaleDate(rows, saleId);
  if (fromCargo) return fromCargo;
  const sid = String(saleId || "").trim();
  if (!sid) return "";
  try {
    const snap = await getDoc(doc(db, "sales_candies", sid));
    if (!snap.exists()) return "";
    const x = snap.data() as any;
    const raw =
      formatLocalDate(x.date ?? x.timestamp ?? x.createdAt ?? "") || "";
    return raw.slice(0, 10);
  } catch {
    return "";
  }
}

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
  return chronological.slice().reverse();
}

const FULL_PAYMENT_COMMENT_PREFIX = "Pago total factura";

function isFullPaymentAbonoComment(comment?: string): boolean {
  return String(comment || "").startsWith(FULL_PAYMENT_COMMENT_PREFIX);
}

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
    await updateDoc(doc(db, "ar_movements", cargo.id), {
      debtStatus: next,
    });
  }
  return list.map((row) =>
    row.id === cargo.id ? { ...row, debtStatus: next } : row,
  );
}

/** Fecha local YYYY-MM-DD (alineado con Clientes Pollo). */
const formatLocalDate = (v: any) => {
  if (!v && v !== 0) return "";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10);
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      const d = parsed;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    }
    return String(v).slice(0, 10);
  }
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  if (v?.toDate && typeof v.toDate === "function") {
    const d = v.toDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  return String(v).slice(0, 10);
};

const formatLocalDateTime = (v: any): string => {
  if (!v && v !== 0) return "";
  if (typeof v === "string") {
    if (/^\d{4}-\d{2}-\d{2}/.test(v)) {
      const s = v.slice(0, 19).replace("T", " ");
      return s.length >= 10 ? s : "";
    }
    const parsed = new Date(v);
    if (!Number.isNaN(parsed.getTime())) {
      const d = parsed;
      return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    }
    return "";
  }
  if (v instanceof Date) {
    const d = v;
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (v?.toDate && typeof v.toDate === "function") {
    const d = v.toDate();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  if (typeof v?.seconds === "number") {
    const d = new Date(v.seconds * 1000);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  }
  return "";
};

async function loadLastSaleForCustomer(c: CustomerRow): Promise<void> {
  c.lastSaleDate = "";
  c.lastSaleDateTime = "";
  c.lastSaleAmount = undefined;
  try {
    let sDoc: any = null;
    try {
      const qS = query(
        collection(db, "sales_candies"),
        where("customerId", "==", c.id),
        orderBy("createdAt", "desc"),
        limit(1),
      );
      const sSnap = await getDocs(qS);
      sDoc = sSnap.docs[0] ?? null;
    } catch {
      const sAll = await getDocs(
        query(
          collection(db, "sales_candies"),
          where("customerId", "==", c.id),
        ),
      );
      let bestTs = 0;
      let best: any = null;
      sAll.docs.forEach((dd) => {
        const sd = dd.data() as any;
        let ms = 0;
        if (sd?.createdAt?.seconds) ms = Number(sd.createdAt.seconds) * 1000;
        else if (sd?.date) {
          const p = Date.parse(String(sd.date));
          if (!Number.isNaN(p)) ms = p;
        }
        if (ms >= bestTs) {
          bestTs = ms;
          best = dd;
        }
      });
      sDoc = best;
    }
    if (!sDoc) return;
    const sData = sDoc.data() as any;
    if (sData?.date) {
      c.lastSaleDate =
        typeof sData.date === "string"
          ? sData.date.slice(0, 10)
          : formatLocalDate(sData.date);
    } else if (sData?.timestamp) {
      c.lastSaleDate = formatLocalDate(sData.timestamp);
    } else if (sData?.createdAt) {
      c.lastSaleDate = formatLocalDate(sData.createdAt);
    }
    c.lastSaleDateTime =
      formatLocalDateTime(sData.timestamp) ||
      formatLocalDateTime(sData.createdAt) ||
      (typeof sData.date === "string"
        ? sData.date.replace("T", " ").slice(0, 16)
        : "") ||
      c.lastSaleDate ||
      "";
    const directTot = Number(
      sData.total ?? sData.amount ?? sData.grandTotal ?? 0,
    );
    if (Number.isFinite(directTot) && directTot !== 0) {
      c.lastSaleAmount = Math.round(directTot * 100) / 100;
    } else if (Array.isArray(sData.items)) {
      c.lastSaleAmount =
        Math.round(
          sData.items.reduce(
            (acc: number, it: any) =>
              acc +
              (Number(
                it?.total ?? it?.amount ?? it?.lineFinal ?? 0,
              ) || 0),
            0,
          ) * 100,
        ) / 100;
    }
  } catch {
    /* ignore */
  }
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
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleId),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
  );
}

async function removeAbonoFromSaleByMovementId(
  saleId: string | undefined,
  movementId: string,
) {
  const safeSaleId = String(saleId || "").trim();
  const safeMovId = String(movementId || "").trim();
  if (!safeSaleId || !safeMovId) return;

  const saleRef = doc(db, "sales_candies", safeSaleId);
  const saleSnap = await getDoc(saleRef);
  if (!saleSnap.exists()) return;

  const data = saleSnap.data() as any;
  const abonosRaw = Array.isArray(data?.abonos) ? data.abonos : [];
  const abonos = abonosRaw.filter((a: any) => a?.movementId !== safeMovId);
  if (abonos.length === abonosRaw.length) return;

  const abonosTotal = abonos.reduce(
    (acc: number, a: any) => acc + Number(a?.amount || 0),
    0,
  );
  const last = abonos.length ? abonos[abonos.length - 1] : null;

  await updateDoc(saleRef, {
    abonos,
    abonosTotal: Math.round(abonosTotal * 100) / 100,
    lastAbonoDate: last?.date || "",
    lastAbonoAmount: Number(last?.amount || 0),
    lastAbonoAt: last ? Timestamp.now() : null,
  });
}

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface CustomersCandyProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function CustomersCandy({
  role = "",
  roles,
  sellerCandyId = "",
  currentUserEmail,
}: CustomersCandyProps & { roles?: RoleProp[] | string[] }) {
  const subject = (roles && (roles as any).length ? roles : role) as any;
  const sellerIdSafe = String(sellerCandyId || "").trim();

  const isVendor = hasRole(subject, "vendedor_dulces");
  const isAdmin = hasRole(subject, "admin");

  const [sellers, setSellers] = useState<SellerRow[]>([]);

  // ===== Filtros (colapsables) =====
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [fClient, setFClient] = useState("");
  const [fStatus, setFStatus] = useState<"" | Status>(""); // "" = todos
  const [fMin, setFMin] = useState<string>(""); // saldo mínimo
  const [fMax, setFMax] = useState<string>(""); // saldo máximo

  // ===== Drawer Detalle de Ítems (venta) =====
  const [itemsDrawerOpen, setItemsDrawerOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number;
      unitPrice: number;
      discount?: number;
      total: number;
      lineCommission: number;
      commissionPerPackage: number;
    }[]
  >([]);

  const [itemsDrawerMeta, setItemsDrawerMeta] = useState<{
    totalPackages: number;
    saleAmount: number;
    commissionTotal: number;
    saleDate?: string;
  } | null>(null);

  const [statementHeaderMenuRect, setStatementHeaderMenuRect] =
    useState<DOMRect | null>(null);

  const openItemsDrawer = async (saleId: string) => {
    setItemsDrawerOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);
    setItemsDrawerMeta(null);

    try {
      // ✅ más robusto: primero por ID del doc
      const byId = await getDoc(doc(db, "sales_candies", saleId));
      let data: any = null;

      if (byId.exists()) {
        data = byId.data();
      } else {
        // fallback por campo "name" (por si así lo guardaste)
        const snap = await getDocs(
          query(collection(db, "sales_candies"), where("name", "==", saleId)),
        );
        data = snap.docs[0]?.data();
      }

      let arr: any[] = [];
      if (Array.isArray(data?.items)) arr = data.items;
      else if (data?.items && typeof data.items === "object") {
        try {
          arr = Object.values(data.items);
        } catch (e) {
          arr = [];
        }
      } else if (data?.item) arr = [data.item];

      const sellers = await fetchSellersCandiesCommissionMap();
      const commissionTotal = data
        ? commissionFromSaleDoc(data, sellers)
        : 0;

      const rowsRaw = arr.map((it: any) => ({
        productName: String(it.productName || ""),
        qty: Number(it.packages ?? it.qty ?? it.quantity ?? 0),
        unitPrice: Number(it.unitPricePackage ?? it.unitPrice ?? it.price ?? 0),
        discount: Number(it.discount || 0),
        total: Number(it.total ?? it.lineFinal ?? it.amount ?? 0),
        marginRaw: Number(it.margenVendedor || 0),
      }));

      const sumMargin = rowsRaw.reduce((a, r) => a + r.marginRaw, 0);
      const sumLineTot = rowsRaw.reduce((a, r) => a + r.total, 0);

      const rows = rowsRaw.map((r) => {
        let lineComm = r.marginRaw;
        if (
          !(lineComm > 0.005) &&
          sumMargin < 0.005 &&
          sumLineTot > 0 &&
          commissionTotal > 0
        ) {
          lineComm = roundCurrency((r.total / sumLineTot) * commissionTotal);
        }
        const commPerPkg =
          r.qty > 0 ? roundCurrency(lineComm / r.qty) : 0;
        return {
          productName: r.productName,
          qty: r.qty,
          unitPrice: r.unitPrice,
          discount: r.discount,
          total: r.total,
          lineCommission: roundCurrency(lineComm),
          commissionPerPackage: commPerPkg,
        };
      });

      setItemsModalRows(rows);

      const totalPk = rows.reduce((a, r) => a + r.qty, 0);
      const saleAmount = data
        ? saleTotalFromDoc(data)
        : rows.reduce((a, r) => a + r.total, 0);

      const saleDate =
        data?.date != null
          ? String(data.date).slice(0, 10)
          : data?.createdAt?.toDate?.()
            ? data.createdAt.toDate().toISOString().slice(0, 10)
            : undefined;

      setItemsDrawerMeta({
        totalPackages: totalPk,
        saleAmount: roundCurrency(saleAmount),
        commissionTotal: roundCurrency(commissionTotal),
        saleDate,
      });
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // ===== Formulario (crear) =====
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

  // paginación
  const PAGE_SIZE = 10;
  const [page, setPage] = useState(1);

  // ===== Edición inline =====
  const [editingId, setEditingId] = useState<string | null>(null);
  const [eName, setEName] = useState("");
  const [ePhone, setEPhone] = useState("+505 ");
  const [ePlace, setEPlace] = useState<Place | "">("");
  const [eNotes, setENotes] = useState("");
  const [eStatus, setEStatus] = useState<Status>("ACTIVO");
  const [eCreditLimit, setECreditLimit] = useState<number>(0);
  const [eVendorId, setEVendorId] = useState<string>("");

  // ===== Estado de cuenta (modal) =====
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

  // ===== Modal Abonar =====
  const [showAbono, setShowAbono] = useState(false);
  const [abonoAmount, setAbonoAmount] = useState<number>(0);
  const [abonoDate, setAbonoDate] = useState<string>(
    new Date().toISOString().slice(0, 10),
  );
  const [abonoComment, setAbonoComment] = useState<string>("");
  const [savingAbono, setSavingAbono] = useState(false);
  const [abonoTargetSaleId, setAbonoTargetSaleId] = useState<string | null>(
    null,
  );
  const [saleMenuAnchor, setSaleMenuAnchor] = useState<{
    saleId: string;
    rect: DOMRect;
  } | null>(null);
  const [saleLedgerSaleId, setSaleLedgerSaleId] = useState<string | null>(null);
  const [movementRowMenu, setMovementRowMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  const [ledgerMovementMenu, setLedgerMovementMenu] = useState<{
    rowId: string;
    rect: DOMRect;
  } | null>(null);
  const [stComisionTotalCredito, setStComisionTotalCredito] = useState(0);
  const [abonoSalePreviewMeta, setAbonoSalePreviewMeta] = useState<{
    total: number;
    commission: number;
  } | null>(null);

  // ===== Editar / Eliminar movimiento =====
  const [editMovId, setEditMovId] = useState<string | null>(null);
  const [eMovDate, setEMovDate] = useState<string>("");
  const [eMovAmount, setEMovAmount] = useState<number>(0);
  const [eMovComment, setEMovComment] = useState<string>("");
  const [editMinSaleDate, setEditMinSaleDate] = useState<string>("");

  // 👉 Modal Crear Cliente
  const [showCreateModal, setShowCreateModal] = useState(false);

  const [customerRowMenu, setCustomerRowMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);

  // ✅ MOBILE: collapse/expand statement sections + movement cards
  const [stOpenAccount, setStOpenAccount] = useState(false);
  const [stOpenMovements, setStOpenMovements] = useState(false);
  const [expandedMovementId, setExpandedMovementId] = useState<string | null>(
    null,
  );

  const loadCustomers = useCallback(async () => {
    try {
      setLoading(true);

      if (isVendor && !sellerIdSafe) {
        setRows([]);
        setMsg(
          "❌ Este usuario no tiene vendedor asociado (sellerCandyId vacío).",
        );
        return;
      }

      // vendedores activos
      const vSnap = await getDocs(collection(db, "sellers_candies"));
      const vList: SellerRow[] = [];
      vSnap.forEach((d) => {
        const x = d.data() as any;
        const st = String(x.status || "ACTIVO");
        if (st !== "ACTIVO") return;
        vList.push({ id: d.id, name: String(x.name || ""), status: st });
      });
      setSellers(vList);

      // clientes
      const qC = isVendor
        ? query(
            collection(db, "customers_candies"),
            where("vendorId", "==", sellerIdSafe),
            orderBy("createdAt", "desc"),
          )
        : query(
            collection(db, "customers_candies"),
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
          sellerId: x.sellerId || "",

          vendorId: x.vendorId || "",
          vendorName: x.vendorName || "",
          initialDebt: Number(x.initialDebt || 0),
          initialDebtDate: String(x.initialDebtDate || "").trim(),

          lastAbonoDate: "",
          lastAbonoAmount: 0,
        });
      });

      // Saldos + último abono
      for (const c of list) {
        try {
          const qMov = query(
            collection(db, "ar_movements"),
            where("customerId", "==", c.id),
          );
          const mSnap = await getDocs(qMov);

          let sumMov = 0;
          let lastAbono: any = null;
          const movements: MovementRow[] = [];

          mSnap.forEach((m) => {
            const x = m.data() as any;
            const amt = Number(x.amount || 0);
            sumMov += amt;

            const d =
              x.date ??
              (x.createdAt?.toDate?.()
                ? x.createdAt.toDate().toISOString().slice(0, 10)
                : "");

            movements.push({
              id: m.id,
              date: d,
              type:
                (x.type as "CARGO" | "ABONO") ??
                (amt < 0 ? "ABONO" : "CARGO"),
              amount: amt,
              ref: x.ref || {},
              comment: x.comment || "",
              createdAt: x.createdAt,
            });

            // detectar abonos (negativos)
            if (amt < 0) {
              const ts = x.createdAt?.seconds
                ? Number(x.createdAt.seconds)
                : 0;

              if (!lastAbono || ts >= lastAbono.ts) {
                lastAbono = { date: d, amount: Math.abs(amt), ts };
              }
            }
          });

          const init = Number(c.initialDebt || 0);
          const effectiveInit = getEffectiveInitialDebt(
            init,
            String(c.initialDebtDate || ""),
            movements,
          );

          // ✅ balance incluye deuda inicial efectiva
          c.balance = effectiveInit + sumMov;

          if (lastAbono) {
            c.lastAbonoDate = lastAbono?.date;
            c.lastAbonoAmount = lastAbono?.amount;
          } else {
            c.lastAbonoDate = "";
            c.lastAbonoAmount = 0;
          }

          await loadLastSaleForCustomer(c);
        } catch {
          c.balance = Number(c.initialDebt || 0);
          c.lastAbonoDate = "";
          c.lastAbonoAmount = 0;
        }
      }

      setRows(list);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error cargando clientes.");
    } finally {
      setLoading(false);
    }
  }, [isVendor, sellerIdSafe]);

  useEffect(() => {
    void loadCustomers();
  }, [loadCustomers]);

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

    const finalVendorId = isVendor
      ? sellerIdSafe
      : String(vendorId || "").trim();
    const finalVendorName = finalVendorId
      ? sellers.find((s) => s.id === finalVendorId)?.name || ""
      : "";

    try {
      const init = Number(initialDebt || 0);

      const ref = await addDoc(collection(db, "customers_candies"), {
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

      // ✅ FIX: balance inicial = deuda inicial
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
      await updateDoc(doc(db, "customers_candies", editingId), {
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

  // ===== Eliminar cliente (+ devolver dulces de TODAS sus compras) =====
  const handleDelete = async (row: CustomerRow) => {
    const ok = confirm(
      `¿Eliminar al cliente "${row.name}"?\nSe devolverán al inventario todos los dulces de sus compras y se borrarán sus movimientos.`,
    );
    if (!ok) return;

    try {
      setLoading(true);

      const qSales = query(
        collection(db, "sales_candies"),
        where("customerId", "==", row.id),
      );
      const sSnap = await getDocs(qSales);

      for (const d of sSnap.docs) {
        const saleId = d.id;
        try {
          await restoreSaleAndDeleteCandy(saleId);
        } catch (e) {
          console.warn("restoreSaleAndDeleteCandy error", e);
          try {
            await deleteDoc(doc(db, "sales_candies", saleId));
          } catch {}
        }
        await deleteARMovesBySaleId(saleId);
      }

      const qMov = query(
        collection(db, "ar_movements"),
        where("customerId", "==", row.id),
      );
      const mSnap = await getDocs(qMov);
      await Promise.all(
        mSnap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
      );

      await deleteDoc(doc(db, "customers_candies", row.id));

      setRows((prev) => prev.filter((x) => x.id !== row.id));
      setMsg("🗑️ Cliente eliminado y dulces devueltos al inventario");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar el cliente.");
    } finally {
      setLoading(false);
    }
  };

  const getEffectiveInitialDebt = (
    initialDebtValue: number,
    initialDebtDate: string,
    movements: MovementRow[],
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

  const recomputeKpis = (
    list: MovementRow[],
    initialDebtValue: number,
    initialDebtDate: string,
  ) => {
    const sumMov = list.reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    const totalAbonos = list
      .filter((x) => Number(x.amount) < 0)
      .reduce((acc, it) => acc + Math.abs(Number(it.amount) || 0), 0);

    const totalCargosMov = list
      .filter((x) => Number(x.amount) > 0)
      .reduce((acc, it) => acc + (Number(it.amount) || 0), 0);

    const effectiveInit = getEffectiveInitialDebt(
      initialDebtValue,
      initialDebtDate,
      list,
    );
    const saldoActual = Number(effectiveInit || 0) + sumMov;

    setStKpis({
      saldoActual,
      totalAbonado: totalAbonos,
      totalCargos: Number(effectiveInit || 0) + totalCargosMov,
      saldoRestante: saldoActual,
    });
  };

  const fetchMovementRowsForCustomer = async (
    customerId: string,
  ): Promise<MovementRow[]> => {
    const qMov = query(
      collection(db, "ar_movements"),
      where("customerId", "==", customerId),
    );
    const snap = await getDocs(qMov);
    const list: MovementRow[] = [];
    snap.forEach((d) => {
      const x = d.data() as any;
      const date =
        x.date ??
        (x.createdAt?.toDate?.()
          ? x.createdAt.toDate().toISOString().slice(0, 10)
          : "");
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
        commissionOnPayment: Number(x.commissionOnPayment || 0),
        commissionBreakdown: Array.isArray(x.commissionBreakdown)
          ? x.commissionBreakdown
          : undefined,
      });
    });
    list.sort((a, b) => {
      if (a.date !== b.date) return a.date.localeCompare(b.date);
      const as = a.createdAt?.seconds || 0;
      const bs = b.createdAt?.seconds || 0;
      return as - bs;
    });
    return list;
  };

  // ===== Abrir estado de cuenta =====
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

    // ✅ MOBILE: todo colapsado al entrar
    setStOpenAccount(false);
    setStOpenMovements(false);
    setExpandedMovementId(null);

    setShowAbono(false);
    setAbonoAmount(0);
    setAbonoDate(new Date().toISOString().slice(0, 10));
    setAbonoComment("");
    setAbonoTargetSaleId(null);
    setSaleMenuAnchor(null);
    setSaleLedgerSaleId(null);
    setAbonoSalePreviewMeta(null);
    setEditMovId(null);
    setEditMinSaleDate("");
    setMovementRowMenu(null);
    setLedgerMovementMenu(null);
    setItemsDrawerOpen(false);
    setStatementHeaderMenuRect(null);

    setStLoading(true);
    try {
      await syncAbonoCommissionsForCustomer(customer.id);
      const list = await fetchMovementRowsForCustomer(customer.id);
      setStRows(list);
      recomputeKpis(
        list,
        Number(customer.initialDebt || 0),
        String(customer.initialDebtDate || ""),
      );
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo cargar el estado de cuenta");
    } finally {
      setStLoading(false);
    }
  };

  const refreshStatement = async () => {
    if (!stCustomer) return;
    setStLoading(true);
    try {
      await syncAbonoCommissionsForCustomer(stCustomer.id);
      const list = await fetchMovementRowsForCustomer(stCustomer.id);
      setStRows(list);
      recomputeKpis(
        list,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo actualizar el estado de cuenta");
    } finally {
      setStLoading(false);
    }
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

  const stCommissionDesdeAbonos = useMemo(() => {
    return stRows
      .filter((x) => Number(x.amount) < 0)
      .reduce((a, x) => a + Number(x.commissionOnPayment || 0), 0);
  }, [stRows]);

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

  const saleIdsForCommissionKey = useMemo(
    () =>
      saleVentasRows
        .map((m) => m.ref?.saleId)
        .filter((x): x is string => Boolean(x))
        .join(","),
    [saleVentasRows],
  );

  useEffect(() => {
    let cancelled = false;
    if (!showStatement || !stCustomer) {
      setStComisionTotalCredito(0);
      return;
    }
    const ids = saleIdsForCommissionKey
      ? saleIdsForCommissionKey.split(",").filter(Boolean)
      : [];
    if (ids.length === 0) {
      setStComisionTotalCredito(0);
      return;
    }
    (async () => {
      try {
        const sellers = await fetchSellersCandiesCommissionMap();
        const meta = await buildSaleMetaMap(ids, sellers);
        const sum = Object.values(meta).reduce(
          (a, b) => a + Number(b.commission || 0),
          0,
        );
        if (!cancelled) setStComisionTotalCredito(roundCurrency(sum));
      } catch {
        if (!cancelled) setStComisionTotalCredito(0);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showStatement, stCustomer?.id, saleIdsForCommissionKey]);

  const stComisionPendiente = useMemo(
    () =>
      Math.max(
        0,
        roundCurrency(stComisionTotalCredito - stCommissionDesdeAbonos),
      ),
    [stComisionTotalCredito, stCommissionDesdeAbonos],
  );

  const saleLedgerComputed = useMemo(() => {
    if (!saleLedgerSaleId) return [];
    return buildSaleAbonoLedger(stRows, saleLedgerSaleId);
  }, [stRows, saleLedgerSaleId]);

  /** Panel de edición (compra/abono de la venta): en modal principal o en «Cuenta de la venta». */
  const showLedgerStyleEditPanel =
    !!editMovId &&
    showStatement &&
    (() => {
      const em = stRows.find((x) => x.id === editMovId);
      if (!em) return false;
      if (em.type === "CARGO" && em.ref?.saleId && Number(em.amount) > 0) {
        if (saleLedgerSaleId) return em.ref.saleId === saleLedgerSaleId;
        return true;
      }
      if (
        em.type === "ABONO" &&
        em.ref?.saleId &&
        saleLedgerSaleId &&
        em.ref.saleId === saleLedgerSaleId
      ) {
        return true;
      }
      return false;
    })();

  useEffect(() => {
    let cancelled = false;
    if (!showAbono || !abonoTargetSaleId) {
      setAbonoSalePreviewMeta(null);
      return;
    }
    (async () => {
      try {
        const sellers = await fetchSellersCandiesCommissionMap();
        const meta = await buildSaleMetaMap([abonoTargetSaleId], sellers);
        const m = meta[abonoTargetSaleId];
        if (!cancelled) setAbonoSalePreviewMeta(m || null);
      } catch {
        if (!cancelled) setAbonoSalePreviewMeta(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [showAbono, abonoTargetSaleId]);

  const abonoPreviewCommission = useMemo(() => {
    const amt = Number(abonoAmount || 0);
    const m = abonoSalePreviewMeta;
    if (!m || !(amt > 0) || !(m.total > 0)) return null;
    return roundCurrency((m.commission * amt) / m.total);
  }, [abonoAmount, abonoSalePreviewMeta]);

  // ===== Registrar ABONO =====
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
        vendorId: stCustomer.vendorId || "",
        vendorName: stCustomer.vendorName || "",
      };
      if (abonoTargetSaleId) {
        payload.ref = { saleId: abonoTargetSaleId };
      }
      await addDoc(collection(db, "ar_movements"), payload);
      await syncAbonoCommissionsForCustomer(stCustomer.id);
      let newList = await fetchMovementRowsForCustomer(stCustomer.id);
      if (abonoTargetSaleId) {
        newList = await syncCargoDebtStatusForSaleId(
          newList,
          abonoTargetSaleId,
        );
      }

      setStRows(newList);
      recomputeKpis(
        newList,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const effectiveInit = getEffectiveInitialDebt(
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
        newList,
      );
      const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

      // ✅ update saldo en lista (balance incluye deuda inicial efectiva)
      setRows((prev) =>
        prev.map((c) => {
          if (c.id !== stCustomer.id) return c;
          return {
            ...c,
            balance: nuevoSaldo,
            lastAbonoDate: abonoDate,
            lastAbonoAmount: safeAmt,
          };
        }),
      );

      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: abonoDate,
              lastAbonoAmount: safeAmt,
            }
          : prev,
      );

      setAbonoAmount(0);
      setAbonoComment("");
      setAbonoDate(new Date().toISOString().slice(0, 10));
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
        vendorId: stCustomer.vendorId || "",
        vendorName: stCustomer.vendorName || "",
      };
      await addDoc(collection(db, "ar_movements"), payload);
      await syncAbonoCommissionsForCustomer(stCustomer.id);
      let newList = await fetchMovementRowsForCustomer(stCustomer.id);
      newList = await syncCargoDebtStatusForSaleId(newList, saleId);

      setStRows(newList);
      recomputeKpis(
        newList,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const effectiveInit = getEffectiveInitialDebt(
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
        newList,
      );
      const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: payDate,
                lastAbonoAmount: payAmt,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: payDate,
              lastAbonoAmount: payAmt,
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
      await deleteDoc(doc(db, "ar_movements", abono.id));
      await syncAbonoCommissionsForCustomer(stCustomer.id);
      let newList = await fetchMovementRowsForCustomer(stCustomer.id);
      newList = await syncCargoDebtStatusForSaleId(newList, saleId);

      setStRows(newList);
      recomputeKpis(
        newList,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const effectiveInit = getEffectiveInitialDebt(
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
        newList,
      );
      const nuevoSaldo = Number(effectiveInit || 0) + sumMov;
      const last = getLastAbonoFromList(newList);

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: last?.date || "",
                lastAbonoAmount: last?.amount || 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: last?.date || "",
              lastAbonoAmount: last?.amount || 0,
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

  const renderEditMovementPanelLedger = () => {
    if (!editMovId) return null;
    const em = stRows.find((x) => x.id === editMovId);
    if (!em) return null;

    const isAbonoVenta = em.type === "ABONO" && em.ref?.saleId;
    const isCargoVenta =
      em.type === "CARGO" &&
      em.ref?.saleId &&
      Number(em.amount) > 0;

    return (
      <div className="mt-4 border rounded-lg p-4 bg-amber-50 border-amber-200">
        <div className="font-semibold mb-2">
          Editar movimiento ({em.type === "ABONO" ? "Abono" : "Compra"})
        </div>
        {isAbonoVenta ? (
          <div className="max-w-xs">
            <label className="block text-xs font-medium text-gray-600">
              Fecha
            </label>
            <input
              type="date"
              className="w-full border p-2 rounded"
              value={eMovDate}
              min={editMinSaleDate || undefined}
              onChange={(e) => setEMovDate(e.target.value)}
            />
            <p className="text-[11px] text-gray-600 mt-2">
              Solo puedes cambiar la fecha; no debe ser anterior a la fecha de
              la venta.
            </p>
          </div>
        ) : isCargoVenta ? (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Fecha
              </label>
              <input
                type="date"
                className="w-full border p-2 rounded"
                value={eMovDate}
                min={editMinSaleDate || undefined}
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
            <p className="md:col-span-2 text-[11px] text-gray-600">
              El monto de la venta no se edita aquí (ni paquetes).
            </p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Fecha
              </label>
              <input
                type="date"
                className="w-full border p-2 rounded"
                value={eMovDate}
                min={
                  em.type === "ABONO" && em.ref?.saleId && editMinSaleDate
                    ? editMinSaleDate
                    : undefined
                }
                onChange={(e) => setEMovDate(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-600">
                Monto
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border p-2 rounded text-right"
                value={Number.isNaN(eMovAmount) ? "" : eMovAmount}
                onChange={(e) => {
                  const num = Number(e.target.value || 0);
                  const safe = Number.isFinite(num)
                    ? Math.max(0, parseFloat(num.toFixed(2)))
                    : 0;
                  setEMovAmount(safe);
                }}
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
        )}
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
            onClick={() => void saveEditMovement()}
          >
            Guardar
          </button>
        </div>
      </div>
    );
  };

  // ===== Editar movimiento =====
  const startEditMovement = (m: MovementRow) => {
    setEditMovId(m.id);
    setEMovDate(m.date || new Date().toISOString().slice(0, 10));
    setEMovAmount(Math.abs(Number(m.amount || 0)));
    setEMovComment(m.comment || "");
    setEditMinSaleDate("");
    if (m.ref?.saleId && (m.type === "ABONO" || m.type === "CARGO")) {
      void (async () => {
        const d = await resolveMinAbonoDateFromSaleCandies(
          stRows,
          m.ref!.saleId!,
        );
        setEditMinSaleDate(d ? d.slice(0, 10) : "");
      })();
    }
  };

  const cancelEditMovement = () => {
    setEditMovId(null);
    setEMovDate("");
    setEMovAmount(0);
    setEMovComment("");
    setEditMinSaleDate("");
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

    const ed = eMovDate.slice(0, 10);

    if (old.type === "CARGO") {
      if (old.ref?.saleId) {
        const saleD = await resolveMinAbonoDateFromSaleCandies(
          stRows,
          old.ref.saleId,
        );
        if (saleD && ed < saleD) {
          setMsg(
            `La fecha del movimiento no puede ser anterior a la fecha de la venta (${saleD}).`,
          );
          return;
        }
      }
      try {
        await updateDoc(doc(db, "ar_movements", editMovId), {
          date: eMovDate,
          comment: eMovComment || "",
        });

        await syncAbonoCommissionsForCustomer(stCustomer.id);
        let newList = await fetchMovementRowsForCustomer(stCustomer.id);
        if (old.ref?.saleId) {
          newList = await syncCargoDebtStatusForSaleId(newList, old.ref.saleId);
        }

        setStRows(newList);
        recomputeKpis(
          newList,
          Number(stCustomer.initialDebt || 0),
          String(stCustomer.initialDebtDate || ""),
        );

        const sumMov = newList.reduce(
          (acc, it) => acc + (Number(it.amount) || 0),
          0,
        );
        const effectiveInit = getEffectiveInitialDebt(
          Number(stCustomer.initialDebt || 0),
          String(stCustomer.initialDebtDate || ""),
          newList,
        );
        const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

        const last = getLastAbonoFromList(newList);

        setRows((prev) =>
          prev.map((c) =>
            c.id === stCustomer.id
              ? {
                  ...c,
                  balance: nuevoSaldo,
                  lastAbonoDate: last?.date || "",
                  lastAbonoAmount: last?.amount || 0,
                }
              : c,
          ),
        );
        setStCustomer((prev) =>
          prev
            ? {
                ...prev,
                balance: nuevoSaldo,
                lastAbonoDate: last?.date || "",
                lastAbonoAmount: last?.amount || 0,
              }
            : prev,
        );

        cancelEditMovement();
        setMsg("✅ Movimiento actualizado");
      } catch (e) {
        console.error(e);
        setMsg("❌ Error al actualizar movimiento");
      }
      return;
    }

    if (old.type === "ABONO" && old.ref?.saleId) {
      const saleD = await resolveMinAbonoDateFromSaleCandies(
        stRows,
        old.ref.saleId,
      );
      if (saleD && ed < saleD) {
        setMsg(
          `La fecha del abono no puede ser anterior a la fecha de la venta (${saleD}).`,
        );
        return;
      }

      try {
        await updateDoc(doc(db, "ar_movements", editMovId), {
          date: eMovDate,
        });

        await syncAbonoCommissionsForCustomer(stCustomer.id);
        let newList = await fetchMovementRowsForCustomer(stCustomer.id);
        newList = await syncCargoDebtStatusForSaleId(
          newList,
          old.ref.saleId,
        );

        setStRows(newList);
        recomputeKpis(
          newList,
          Number(stCustomer.initialDebt || 0),
          String(stCustomer.initialDebtDate || ""),
        );

        const sumMov = newList.reduce(
          (acc, it) => acc + (Number(it.amount) || 0),
          0,
        );
        const effectiveInit = getEffectiveInitialDebt(
          Number(stCustomer.initialDebt || 0),
          String(stCustomer.initialDebtDate || ""),
          newList,
        );
        const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

        const last = getLastAbonoFromList(newList);

        setRows((prev) =>
          prev.map((c) =>
            c.id === stCustomer.id
              ? {
                  ...c,
                  balance: nuevoSaldo,
                  lastAbonoDate: last?.date || "",
                  lastAbonoAmount: last?.amount || 0,
                }
              : c,
          ),
        );
        setStCustomer((prev) =>
          prev
            ? {
                ...prev,
                balance: nuevoSaldo,
                lastAbonoDate: last?.date || "",
                lastAbonoAmount: last?.amount || 0,
              }
            : prev,
        );

        cancelEditMovement();
        setMsg("✅ Movimiento actualizado");
      } catch (e) {
        console.error(e);
        setMsg("❌ Error al actualizar movimiento");
      }
      return;
    }

    const entered = Number(eMovAmount || 0);
    if (!(entered > 0)) {
      setMsg("El monto debe ser mayor a 0.");
      return;
    }
    const signed =
      old.type === "ABONO"
        ? -parseFloat(entered.toFixed(2))
        : +parseFloat(entered.toFixed(2));

    try {
      await updateDoc(doc(db, "ar_movements", editMovId), {
        date: eMovDate,
        amount: signed,
        comment: eMovComment || "",
      });

      await syncAbonoCommissionsForCustomer(stCustomer.id);
      const newList = await fetchMovementRowsForCustomer(stCustomer.id);

      setStRows(newList);
      recomputeKpis(
        newList,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );

      // recalcular balance total = deuda inicial efectiva + sumMov
      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const effectiveInit = getEffectiveInitialDebt(
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
        newList,
      );
      const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

      // actualizar último abono en lista (si cambió)
      const last = getLastAbonoFromList(newList);

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: last?.date || "",
                lastAbonoAmount: last?.amount || 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: last?.date || "",
              lastAbonoAmount: last?.amount || 0,
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

  // ===== Eliminar movimiento =====
  const deleteMovement = async (m: MovementRow) => {
    const ok = confirm(
      `¿Eliminar este movimiento (${
        m.type === "ABONO" ? "Abono" : "Compra"
      }) del ${m.date}?${
        m.type === "CARGO" && m.ref?.saleId
          ? "\nSe devolverán al inventario los dulces de esa venta."
          : ""
      }`,
    );
    if (!ok) return;

    if (!stCustomer) return;

    try {
      setLoading(true);

      if (m.type === "CARGO" && m.ref?.saleId) {
        if (saleLedgerSaleId === m.ref.saleId) {
          setSaleLedgerSaleId(null);
          cancelEditMovement();
        }
        try {
          await restoreSaleAndDeleteCandy(m.ref.saleId);
        } catch (e) {
          console.warn("restoreSaleAndDeleteCandy error", e);
          setLoading(false);
          setMsg("❌ No se pudo devolver inventario de la venta.");
          return;
        }
        await deleteARMovesBySaleId(m.ref.saleId);
      } else {
        await deleteDoc(doc(db, "ar_movements", m.id));
        if (m.type === "ABONO" && m.ref?.saleId) {
          await removeAbonoFromSaleByMovementId(m.ref.saleId, m.id);
        }
      }

      await syncAbonoCommissionsForCustomer(stCustomer.id);
      let newList = await fetchMovementRowsForCustomer(stCustomer.id);
      if (m.type === "ABONO" && m.ref?.saleId) {
        newList = await syncCargoDebtStatusForSaleId(
          newList,
          m.ref.saleId,
        );
      }

      setStRows(newList);
      recomputeKpis(
        newList,
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
      );

      const sumMov = newList.reduce(
        (acc, it) => acc + (Number(it.amount) || 0),
        0,
      );
      const effectiveInit = getEffectiveInitialDebt(
        Number(stCustomer.initialDebt || 0),
        String(stCustomer.initialDebtDate || ""),
        newList,
      );
      const nuevoSaldo = Number(effectiveInit || 0) + sumMov;

      const last = getLastAbonoFromList(newList);

      setRows((prev) =>
        prev.map((c) =>
          c.id === stCustomer.id
            ? {
                ...c,
                balance: nuevoSaldo,
                lastAbonoDate: last?.date || "",
                lastAbonoAmount: last?.amount || 0,
              }
            : c,
        ),
      );
      setStCustomer((prev) =>
        prev
          ? {
              ...prev,
              balance: nuevoSaldo,
              lastAbonoDate: last?.date || "",
              lastAbonoAmount: last?.amount || 0,
            }
          : prev,
      );

      setExpandedMovementId(null);
      if (m.ref?.saleId && saleLedgerSaleId === m.ref.saleId) {
        setSaleLedgerSaleId(null);
        cancelEditMovement();
      }
      setMsg("🗑️ Movimiento eliminado");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar movimiento");
    } finally {
      setLoading(false);
    }
  };

  // Orden: activos primero
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

    return orderedRows.filter((c) => {
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
  }, [orderedRows, fClient, fStatus, fMin, fMax]);

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

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
  const pagedRows = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredRows.slice(start, start + PAGE_SIZE);
  }, [filteredRows, page]);

  useEffect(() => {
    setPage(1);
  }, [fClient, fStatus, fMin, fMax]);

  const goFirst = () => setPage(1);
  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));
  const goLast = () => setPage(totalPages);

  const renderPager = () => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mt-3">
      <div className="flex items-center gap-1 flex-wrap">
        <button
          className="px-2 py-1 border rounded disabled:opacity-50"
          onClick={goFirst}
          disabled={page === 1}
        >
          « Primero
        </button>
        <button
          className="px-2 py-1 border rounded disabled:opacity-50"
          onClick={goPrev}
          disabled={page === 1}
        >
          ‹ Anterior
        </button>
        <span className="px-2 text-sm">
          Página {page} de {totalPages}
        </span>
        <button
          className="px-2 py-1 border rounded disabled:opacity-50"
          onClick={goNext}
          disabled={page === totalPages}
        >
          Siguiente ›
        </button>
        <button
          className="px-2 py-1 border rounded disabled:opacity-50"
          onClick={goLast}
          disabled={page === totalPages}
        >
          Último »
        </button>
      </div>
      <div className="text-sm text-gray-600">
        {filteredRows.length} cliente(s)
      </div>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3 gap-2 flex-wrap">
        <h2 className="text-xl font-bold">Clientes</h2>
        <div className="flex items-center gap-2 flex-wrap justify-end">
          <RefreshButton
            onClick={() => void loadCustomers()}
            loading={loading}
          />
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
      </div>

      <div className="md:hidden mb-4">
        <MobileKpiTwoColumn
          left={{
            badge: "Saldo pendiente",
            value: money(totalPendingBalance),
            subtitle: "Calculado sobre los clientes filtrados",
            variant: "emerald",
          }}
          right={{
            badge: "Clientes activos",
            value: activeCustomersCount,
            subtitle: `De un total de ${totalCustomersCount}`,
            variant: "indigo",
          }}
        />
      </div>

      <div className="hidden md:grid md:grid-cols-2 md:gap-3 mb-4">
        <div className="p-4 border rounded-lg bg-white shadow-sm">
          <div className="text-xs uppercase tracking-wide text-gray-600">
            Saldo pendiente
          </div>
          <div className="text-2xl font-semibold">
            {money(totalPendingBalance)}
          </div>
          <p className="text-[11px] text-gray-500 mt-1">
            Calculado sobre los clientes filtrados
          </p>
        </div>
        <div className="p-4 border rounded-lg bg-white shadow-sm">
          <div className="text-xs uppercase tracking-wide text-gray-600">
            Clientes activos
          </div>
          <div className="text-2xl font-semibold">{activeCustomersCount}</div>
          <p className="text-[11px] text-gray-500 mt-1">
            De un total de {totalCustomersCount}
          </p>
        </div>
      </div>

      <div className="bg-white border rounded shadow-sm p-4 mb-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <div className="flex-1">
            <label className="block text-sm font-semibold">
              Filtrar cliente
            </label>
            <input
              className="w-full border rounded px-3 py-2"
              placeholder="Nombre, telefono o nota"
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
              {filtersOpen ? "Ocultar filtros" : "Mas filtros"}
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
              <MobileHtmlSelect
                label="Estado"
                value={fStatus}
                onChange={(v) => setFStatus(v as Status | "")}
                options={[
                  { value: "", label: "Todos" },
                  { value: "ACTIVO", label: "Activo" },
                  { value: "BLOQUEADO", label: "Bloqueado" },
                ]}
                selectClassName="w-full border rounded px-3 py-2"
                sheetTitle="Estado"
              />
            </div>
            <div>
              <label className="block text-sm font-semibold">
                Saldo minimo
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
                Saldo maximo
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

      <div className="bg-white p-2 rounded-xl shadow-sm border border-slate-200 w-full">
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
                  <th className="p-3 border-b text-left">Vendedor</th>
                  <th className="p-3 border-b text-right">Saldo</th>
                  <th className="p-3 border-b text-left">Comentario</th>
                  <th className="p-3 border-b text-right">Acciones</th>
                </tr>
              </thead>

              <tbody>
                {loading ? (
                  <tr>
                    <td className="p-4 text-center" colSpan={9}>
                      Cargando…
                    </td>
                  </tr>
                ) : pagedRows.length === 0 ? (
                  <tr>
                    <td className="p-4 text-center" colSpan={9}>
                      Sin clientes
                    </td>
                  </tr>
                ) : (
                  pagedRows.map((c) => {
                    const isEditing = editingId === c.id;
                    return (
                      <React.Fragment key={c.id}>
                        <tr
                          className={`text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition ${isEditing ? "bg-amber-50/40" : ""}`}
                        >
                          <td className="p-3 border-b text-left">
                            {isEditing ? (
                              <MobileHtmlSelect
                                value={eStatus}
                                onChange={(v) =>
                                  setEStatus(v as Status)
                                }
                                options={[
                                  { value: "ACTIVO", label: "ACTIVO" },
                                  {
                                    value: "BLOQUEADO",
                                    label: "BLOQUEADO",
                                  },
                                ]}
                                selectClassName="w-full border p-1 rounded text-xs"
                                buttonClassName="w-full border p-1 rounded text-xs text-left flex items-center justify-between gap-1 bg-white"
                                sheetTitle="Estado"
                              />
                            ) : (
                              <span
                                className={`px-2 py-0.5 rounded text-xs ${badgeStatus(
                                  c.status,
                                )}`}
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
                          <td className="p-3 border-b text-left">
                            {isEditing ? (
                              <MobileHtmlSelect
                                value={isVendor ? sellerIdSafe : eVendorId}
                                onChange={setEVendorId}
                                disabled={isVendor}
                                options={[
                                  {
                                    value: "",
                                    label: "— Sin vendedor —",
                                  },
                                  ...sellers.map((s) => ({
                                    value: s.id,
                                    label: s.name,
                                  })),
                                ]}
                                selectClassName="w-full border p-1 rounded text-xs"
                                buttonClassName="w-full border p-1 rounded text-xs text-left flex items-center justify-between gap-1 bg-white"
                                sheetTitle="Vendedor"
                              />
                            ) : (
                              c.vendorName || "—"
                            )}
                          </td>
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
                                  type="button"
                                  className="px-2 py-1 rounded text-white bg-blue-600 hover:bg-blue-700"
                                  onClick={saveEdit}
                                >
                                  Guardar
                                </button>
                                <button
                                  type="button"
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
                        {isEditing ? (
                          <tr className="bg-amber-50/50">
                            <td
                              className="p-3 border-b text-left"
                              colSpan={9}
                            >
                              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 text-left">
                                <div>
                                  <div className="text-[11px] font-medium text-slate-500 mb-0.5">
                                    Teléfono
                                  </div>
                                  <input
                                    className="w-full border p-1.5 rounded"
                                    value={ePhone}
                                    onChange={(e) =>
                                      setEPhone(normalizePhone(e.target.value))
                                    }
                                  />
                                </div>
                                <div>
                                  <MobileHtmlSelect
                                    label="Lugar"
                                    value={ePlace}
                                    onChange={(v) =>
                                      setEPlace(v as Place)
                                    }
                                    options={[
                                      { value: "", label: "—" },
                                      ...PLACES.map((p) => ({
                                        value: p,
                                        label: p,
                                      })),
                                    ]}
                                    selectClassName="w-full border p-1.5 rounded text-sm"
                                    buttonClassName="w-full border p-1.5 rounded text-sm text-left flex items-center justify-between bg-white"
                                    sheetTitle="Lugar"
                                  />
                                </div>
                                <div>
                                  <div className="text-[11px] font-medium text-slate-500 mb-0.5">
                                    Límite crédito
                                  </div>
                                  <input
                                    type="number"
                                    step="0.01"
                                    inputMode="decimal"
                                    className="w-full border p-1.5 rounded text-right"
                                    value={
                                      Number.isNaN(eCreditLimit)
                                        ? ""
                                        : eCreditLimit
                                    }
                                    onChange={(e) =>
                                      setECreditLimit(
                                        Math.max(
                                          0,
                                          Number(e.target.value || 0),
                                        ),
                                      )
                                    }
                                  />
                                </div>
                              </div>
                            </td>
                          </tr>
                        ) : null}
                      </React.Fragment>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>
          {renderPager()}
        </div>

        {/* ===================== MOBILE (cards estilo Clientes Pollo) ===================== */}
        <div className="md:hidden space-y-2">
          {loading ? (
            <div className="p-4 text-center text-sm text-gray-600">
              Cargando…
            </div>
          ) : pagedRows.length === 0 ? (
            <div className="p-4 text-center text-sm text-gray-600">
              Sin clientes
            </div>
          ) : (
            pagedRows.map((c) => (
              <div
                key={c.id}
                className="rounded-xl border-2 border-slate-200 bg-gradient-to-br from-slate-50 via-white to-indigo-50/40 p-3 shadow-md"
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="font-semibold text-base">{c.name}</div>
                    <div className="text-xs text-gray-600">{c.phone || "—"}</div>
                    <div className="text-xs text-gray-600">
                      Vendedor:{" "}
                      <span className="font-medium">
                        {c.vendorName || "—"}
                      </span>
                    </div>
                  </div>

                  <span
                    className={`px-2 py-0.5 rounded text-xs shrink-0 ${badgeStatus(
                      c.status,
                    )}`}
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
                      ? `${c.lastAbonoDate}${
                          c.lastAbonoAmount
                            ? ` (${money(c.lastAbonoAmount)})`
                            : ""
                        }`
                      : "—"}
                  </span>
                </div>

                <div className="mt-1 text-xs text-gray-600">
                  Última compra:{" "}
                  <span className="font-medium">
                    {c.lastSaleDateTime || c.lastSaleDate || "—"}
                    {typeof c.lastSaleAmount === "number" &&
                    c.lastSaleAmount > 0
                      ? ` (${money(c.lastSaleAmount)})`
                      : ""}
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
          {renderPager()}
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

      {editingId && !isVendor && (
        <div className="md:hidden fixed inset-0 z-[86] flex flex-col justify-end">
          <button
            type="button"
            className="absolute inset-0 bg-black/50 border-0 cursor-default"
            aria-label="Cerrar"
            onClick={cancelEdit}
          />
          <div className="relative bg-white rounded-t-2xl shadow-2xl max-h-[92vh] overflow-auto w-full">
            <div className="sticky top-0 z-10 flex items-center justify-between gap-2 border-b bg-white px-4 py-3">
              <h3 className="font-bold text-lg">Editar cliente</h3>
              <button
                type="button"
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-sm"
                onClick={cancelEdit}
              >
                Cerrar
              </button>
            </div>
            <div className="p-4 space-y-3">
              <div className="grid grid-cols-2 gap-2 text-sm">
                <div className="col-span-2">
                  <div className="text-[11px] text-gray-500">Nombre</div>
                  <input
                    className="w-full border p-2 rounded-xl"
                    value={eName}
                    onChange={(e) => setEName(e.target.value)}
                  />
                </div>

                <div className="col-span-2">
                  <div className="text-[11px] text-gray-500">Teléfono</div>
                  <input
                    className="w-full border p-2 rounded-xl"
                    value={ePhone}
                    onChange={(e) =>
                      setEPhone(normalizePhone(e.target.value))
                    }
                  />
                </div>

                <div>
                  <MobileHtmlSelect
                    label="Estado"
                    value={eStatus}
                    onChange={(v) => setEStatus(v as Status)}
                    options={[
                      { value: "ACTIVO", label: "ACTIVO" },
                      { value: "BLOQUEADO", label: "BLOQUEADO" },
                    ]}
                    selectClassName="w-full border p-2 rounded-xl"
                    buttonClassName="w-full border p-2 rounded-xl text-left flex items-center justify-between gap-2 bg-white"
                    sheetTitle="Estado"
                  />
                </div>

                <div>
                  <MobileHtmlSelect
                    label="Lugar"
                    value={ePlace}
                    onChange={(v) => setEPlace(v as Place)}
                    options={[
                      { value: "", label: "—" },
                      ...PLACES.map((p) => ({ value: p, label: p })),
                    ]}
                    selectClassName="w-full border p-2 rounded-xl"
                    buttonClassName="w-full border p-2 rounded-xl text-left flex items-center justify-between gap-2 bg-white"
                    sheetTitle="Lugar"
                  />
                </div>

                <div className="col-span-2">
                  <MobileHtmlSelect
                    label="Vendedor"
                    value={isVendor ? sellerIdSafe : eVendorId}
                    onChange={setEVendorId}
                    disabled={isVendor}
                    options={[
                      { value: "", label: "— Sin vendedor —" },
                      ...sellers.map((s) => ({
                        value: s.id,
                        label: s.name,
                      })),
                    ]}
                    selectClassName="w-full border p-2 rounded-xl"
                    buttonClassName="w-full border p-2 rounded-xl text-left flex items-center justify-between gap-2 bg-white"
                    sheetTitle="Vendedor"
                  />
                </div>

                <div className="col-span-2">
                  <div className="text-[11px] text-gray-500">Límite</div>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded-xl text-right"
                    value={
                      Number.isNaN(eCreditLimit) ? "" : eCreditLimit
                    }
                    onChange={(e) =>
                      setECreditLimit(
                        Math.max(0, Number(e.target.value || 0)),
                      )
                    }
                  />
                </div>

                <div className="col-span-2">
                  <div className="text-[11px] text-gray-500">Comentario</div>
                  <textarea
                    className="w-full border p-2 rounded-xl min-h-24 resize-y"
                    value={eNotes}
                    onChange={(e) => setENotes(e.target.value)}
                    maxLength={500}
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2">
                <button
                  className="px-3 py-2 rounded-xl text-white bg-blue-600 hover:bg-blue-700"
                  onClick={saveEdit}
                  type="button"
                >
                  Guardar
                </button>
                <button
                  className="px-3 py-2 rounded-xl bg-gray-200 hover:bg-gray-300"
                  onClick={cancelEdit}
                  type="button"
                >
                  Cancelar
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {msg ? (
        <Toast message={msg} onClose={() => setMsg("")} />
      ) : null}

      {/* ===== Modal: Form Crear Cliente ===== */}
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
                  <MobileHtmlSelect
                    label="Lugar"
                    value={place}
                    onChange={(v) => setPlace(v as Place)}
                    options={[
                      { value: "", label: "—" },
                      ...PLACES.map((p) => ({ value: p, label: p })),
                    ]}
                    selectClassName="w-full border p-2 rounded"
                    sheetTitle="Lugar"
                  />
                </div>

                <div>
                  <MobileHtmlSelect
                    label="Estado"
                    value={status}
                    onChange={(v) => setStatus(v as Status)}
                    options={[
                      { value: "ACTIVO", label: "ACTIVO" },
                      { value: "BLOQUEADO", label: "BLOQUEADO" },
                    ]}
                    selectClassName="w-full border p-2 rounded"
                    sheetTitle="Estado"
                  />
                </div>

                <div>
                  <MobileHtmlSelect
                    label="Vendedor asociado"
                    value={isVendor ? sellerIdSafe : vendorId}
                    onChange={setVendorId}
                    disabled={isVendor}
                    options={[
                      { value: "", label: "— Sin vendedor —" },
                      ...sellers.map((s) => ({
                        value: s.id,
                        label: s.name,
                      })),
                    ]}
                    selectClassName="w-full border p-2 rounded"
                    sheetTitle="Vendedor"
                  />
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

      {/* ===== Modal: Estado de cuenta ===== */}
      {showStatement && (
        <>
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white rounded-lg shadow-xl border w-[95%] max-w-5xl p-4 max-h-[92vh] overflow-auto">
            <div className="flex items-center justify-between mb-2">
              <h3 className="text-lg font-bold">
                Estado de cuenta — {stCustomer?.name || ""}
              </h3>
              <div className="flex gap-2 flex-wrap justify-end items-center">
                <RefreshButton
                  onClick={() => void refreshStatement()}
                  loading={stLoading}
                  className="shrink-0"
                  title="Sincronizar comisiones y recargar movimientos"
                />
                <button
                  type="button"
                  className="p-2 rounded-lg border border-gray-200 bg-white hover:bg-gray-50 inline-flex shrink-0"
                  aria-label="Más acciones del estado de cuenta"
                  onClick={(e) =>
                    setStatementHeaderMenuRect(
                      (e.currentTarget as HTMLElement).getBoundingClientRect(),
                    )
                  }
                >
                  <FiMoreVertical className="w-5 h-5 text-gray-700" />
                </button>
              </div>
            </div>

            {/* ================= WEB KPI ================= */}
            <div className="hidden md:block">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-3">
                <div className="rounded-2xl border border-slate-200/90 bg-gradient-to-br from-slate-50 to-white p-4 shadow-sm">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                    Saldo y cobros
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-3">
                    <div>
                      <div className="text-xs text-slate-600">Saldo actual</div>
                      <div className="text-xl font-bold text-slate-900 tabular-nums">
                        {money(stKpis.saldoActual)}
                      </div>
                    </div>
                    <div>
                      <div className="text-xs text-slate-600">Total abonado</div>
                      <div className="text-xl font-bold text-slate-900 tabular-nums">
                        {money(stKpis.totalAbonado)}
                      </div>
                    </div>
                  </div>
                </div>

                <div className="relative overflow-hidden rounded-2xl p-4 shadow-lg ring-1 ring-white/20 bg-gradient-to-br from-violet-600 via-indigo-600 to-fuchsia-700 text-white">
                  <div
                    className="pointer-events-none absolute -right-6 -top-10 h-32 w-32 rounded-full bg-white/15 blur-2xl"
                    aria-hidden
                  />
                  <div className="relative">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-white/80">
                      Saldo restante
                    </div>
                    <div className="mt-2 text-3xl font-bold tabular-nums tracking-tight">
                      {money(stKpis.saldoRestante)}
                    </div>
                    <p className="mt-2 text-xs text-white/80 leading-snug">
                      Monto pendiente según el estado de cuenta del cliente.
                    </p>
                  </div>
                </div>

                <div className="rounded-2xl border border-emerald-200/80 bg-gradient-to-b from-emerald-50/90 to-white p-4 shadow-sm">
                  <div className="flex items-start justify-between gap-2">
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-emerald-900/80">
                      Comisiones (ventas crédito)
                    </div>
                    <CommissionAbonoHelpButton />
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-600">Comisión total</span>
                      <span className="font-bold tabular-nums text-slate-900">
                        {money(stComisionTotalCredito)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-slate-600">
                        Comisión parcial abonada
                      </span>
                      <span className="font-bold tabular-nums text-emerald-800">
                        {money(stCommissionDesdeAbonos)}
                      </span>
                    </div>
                    <div className="flex items-center justify-between gap-2 rounded-lg bg-emerald-100/70 px-2 py-1.5 text-sm border border-emerald-200/60">
                      <span className="text-emerald-900 font-medium">
                        Comisión pendiente
                      </span>
                      <span className="font-bold tabular-nums text-emerald-950">
                        {money(stComisionPendiente)}
                      </span>
                    </div>
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

              <div className="bg-white rounded border overflow-x-auto mb-3">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 border">Fecha</th>
                      <th className="p-2 border">Total venta</th>
                      <th className="p-2 border">Pendiente</th>
                      <th className="p-2 border">Estado</th>
                      <th className="p-2 border w-12"> </th>
                    </tr>
                  </thead>
                  <tbody>
                    {stLoading ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center">
                          Cargando…
                        </td>
                      </tr>
                    ) : saleVentasRows.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="p-4 text-center">
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
                          <tr
                            key={m.id}
                            className="text-center cursor-pointer hover:bg-slate-50/90 transition-colors"
                            onClick={() => void openItemsDrawer(saleId)}
                          >
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
            </div>

            {showLedgerStyleEditPanel && !saleLedgerSaleId && (
              <div className="mb-3">{renderEditMovementPanelLedger()}</div>
            )}

            {/* ================= MOBILE COLAPSABLE ================= */}
            <div className="md:hidden space-y-3">
              {/* Contenedor 1: Estado de cuenta */}
              <div className="border rounded-2xl overflow-hidden">
                <button
                  type="button"
                  className="w-full px-3 py-3 flex items-center justify-between text-left"
                  onClick={() => setStOpenAccount((v) => !v)}
                >
                  <div className="font-semibold">Estado de cuenta</div>
                  <div className="text-sm text-gray-500">
                    {stOpenAccount ? "Ocultar" : "Ver"}
                  </div>
                </button>

                {stOpenAccount && (
                  <div className="px-3 pb-3 space-y-2">
                    <div className="rounded-2xl border border-slate-200 bg-gradient-to-br from-slate-50 to-white p-3 shadow-sm">
                      <div className="text-[11px] font-semibold uppercase text-slate-500">
                        Saldo y cobros
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2">
                        <div>
                          <div className="text-[11px] text-slate-600">
                            Saldo actual
                          </div>
                          <div className="font-bold tabular-nums text-slate-900">
                            {money(stKpis.saldoActual)}
                          </div>
                        </div>
                        <div>
                          <div className="text-[11px] text-slate-600">
                            Total abonado
                          </div>
                          <div className="font-bold tabular-nums text-slate-900">
                            {money(stKpis.totalAbonado)}
                          </div>
                        </div>
                      </div>
                    </div>

                    <div className="relative overflow-hidden rounded-2xl p-4 shadow-lg bg-gradient-to-br from-violet-600 via-indigo-600 to-fuchsia-700 text-white">
                      <div
                        className="pointer-events-none absolute -right-4 -top-8 h-24 w-24 rounded-full bg-white/15 blur-2xl"
                        aria-hidden
                      />
                      <div className="relative">
                        <div className="text-[11px] font-semibold uppercase text-white/80">
                          Saldo restante
                        </div>
                        <div className="mt-1 text-2xl font-bold tabular-nums">
                          {money(stKpis.saldoRestante)}
                        </div>
                      </div>
                    </div>

                    <div className="rounded-2xl border border-emerald-200 bg-emerald-50/80 p-3">
                      <div className="flex items-start justify-between gap-1">
                        <div className="text-[11px] font-semibold uppercase text-emerald-900/90">
                          Comisiones (crédito)
                        </div>
                        <CommissionAbonoHelpButton />
                      </div>
                      <div className="mt-2 space-y-1.5 text-sm">
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-600">Comisión total</span>
                          <span className="font-bold tabular-nums">
                            {money(stComisionTotalCredito)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2">
                          <span className="text-slate-600">
                            Parcial abonada
                          </span>
                          <span className="font-bold tabular-nums text-emerald-800">
                            {money(stCommissionDesdeAbonos)}
                          </span>
                        </div>
                        <div className="flex justify-between gap-2 rounded-lg bg-white/70 px-2 py-1 border border-emerald-200/60">
                          <span className="font-medium text-emerald-900">
                            Pendiente
                          </span>
                          <span className="font-bold tabular-nums text-emerald-950">
                            {money(stComisionPendiente)}
                          </span>
                        </div>
                      </div>
                    </div>
                  </div>
                )}
              </div>

              <div className="border rounded-2xl overflow-hidden md:hidden">
                <div className="px-3 py-2 text-sm font-semibold border-b bg-slate-50">
                  Ventas a crédito
                </div>
                <div className="p-3 space-y-3">
                  {stLoading ? (
                    <div className="text-center text-sm">Cargando…</div>
                  ) : saleVentasRows.length === 0 ? (
                    <div className="text-center text-sm text-gray-500">
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
                          role="button"
                          tabIndex={0}
                          className="rounded-xl border-2 border-sky-200 bg-gradient-to-br from-sky-50/90 via-white to-cyan-50/50 p-3 shadow-md cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-sky-400"
                          onClick={() => void openItemsDrawer(saleId)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              void openItemsDrawer(saleId);
                            }
                          }}
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
                              <p className="text-[11px] text-sky-700/90 mt-2">
                                Toca la tarjeta para ver el detalle de compra
                              </p>
                            </div>
                            <button
                              type="button"
                              className="p-2 rounded-lg border border-gray-200 shrink-0 bg-white"
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
              </div>

              {/* Contenedor 2: Movimientos */}
              <div className="border rounded-2xl overflow-hidden">
                <button
                  type="button"
                  className="w-full px-3 py-3 flex items-center justify-between text-left"
                  onClick={() => setStOpenMovements((v) => !v)}
                >
                  <div className="font-semibold">Movimientos</div>
                  <div className="text-sm text-gray-500">
                    {stOpenMovements ? "Ocultar" : "Ver"}
                  </div>
                </button>

                {stOpenMovements && (
                  <div className="px-3 pb-3 space-y-2">
                    {stLoading ? (
                      <div className="text-center text-sm p-3">Cargando…</div>
                    ) : stRows.length === 0 ? (
                      <div className="text-center text-sm p-3">
                        Sin movimientos
                      </div>
                    ) : (
                      stRows.map((m) => {
                        const movOpen = expandedMovementId === m.id;
                        const isEditing =
                          editMovId === m.id && !showLedgerStyleEditPanel;
                        const tipoLabel = m.amount >= 0 ? "CARGO" : "ABONO";
                        const tipoClass =
                          m.amount >= 0
                            ? "bg-yellow-100 text-yellow-700"
                            : "bg-green-100 text-green-700";

                        return (
                          <div
                            key={m.id}
                            className="border rounded-2xl overflow-hidden bg-white"
                          >
                            {/* Card colapsada */}
                            <button
                              type="button"
                              className="w-full px-3 py-3 flex items-center justify-between gap-2 text-left"
                              onClick={() => {
                                // si está editando, no colapses
                                if (isEditing) return;
                                setExpandedMovementId((prev) =>
                                  prev === m.id ? null : m.id,
                                );
                              }}
                            >
                              <div className="min-w-0">
                                <div className="text-[11px] text-gray-500 leading-3">
                                  Fecha
                                </div>
                                <div className="font-semibold">
                                  {m.date || "—"}
                                </div>
                              </div>

                              <div className="flex items-center gap-2">
                                <span
                                  className={`px-2 py-0.5 rounded-full text-[11px] ${tipoClass}`}
                                >
                                  {tipoLabel}
                                </span>
                                <div className="text-right">
                                  <div className="text-[11px] text-gray-500 leading-3">
                                    Monto
                                  </div>
                                  <div className="font-semibold">
                                    {money(m.amount)}
                                  </div>
                                </div>
                              </div>
                            </button>

                            {/* Expandida */}
                            {movOpen && (
                              <div className="px-3 pb-3 space-y-2">
                                <div className="text-sm">
                                  <div className="text-[11px] text-gray-500">
                                    Referencia
                                  </div>
                                  <div className="font-medium">
                                    {m.ref?.saleId
                                      ? `Venta #${m.ref.saleId}`
                                      : "—"}
                                  </div>
                                  {m.ref?.saleId && (
                                    <button
                                      type="button"
                                      className="mt-2 text-xs underline text-blue-600"
                                      onClick={() =>
                                        void openItemsDrawer(m.ref!.saleId!)
                                      }
                                    >
                                      Ver productos de la venta
                                    </button>
                                  )}
                                </div>

                                <div className="text-sm">
                                  <div className="text-[11px] text-gray-500">
                                    Comentario
                                  </div>
                                  {isEditing &&
                                  m.type === "ABONO" &&
                                  m.ref?.saleId ? (
                                    <div className="font-medium text-gray-700">
                                      {(m.comment || "").trim() || "—"}
                                    </div>
                                  ) : isEditing ? (
                                    <input
                                      className="w-full border p-2 rounded-xl"
                                      value={eMovComment}
                                      onChange={(e) =>
                                        setEMovComment(e.target.value)
                                      }
                                      placeholder="Comentario"
                                    />
                                  ) : (
                                    <div className="font-medium">
                                      {(m.comment || "").trim() || "—"}
                                    </div>
                                  )}
                                </div>

                                {m.amount < 0 && !isEditing && (
                                  <div className="text-sm rounded-lg bg-emerald-50 border border-emerald-100 p-2">
                                    <div className="text-[11px] text-gray-600">
                                      Comisión por este abono (por venta)
                                    </div>
                                    <div className="font-bold text-emerald-800">
                                      {money(Number(m.commissionOnPayment || 0))}
                                    </div>
                                    {m.commissionBreakdown &&
                                      m.commissionBreakdown.length > 0 && (
                                        <ul className="text-[10px] text-gray-600 mt-1 space-y-0.5">
                                          {m.commissionBreakdown.map((b, i) => (
                                            <li key={i} className="break-all">
                                              …{String(b.saleId || "").slice(-8)}: cobro{" "}
                                              {money(Number(b.appliedAmount || 0))} → com.{" "}
                                              {money(Number(b.commissionPortion || 0))}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                  </div>
                                )}

                                {/* edición */}
                                {isEditing &&
                                  (m.type === "ABONO" && m.ref?.saleId ? (
                                    <div>
                                      <div className="text-[11px] text-gray-500">
                                        Fecha
                                      </div>
                                      <input
                                        type="date"
                                        className="w-full border p-2 rounded-xl"
                                        value={eMovDate}
                                        min={
                                          editMinSaleDate || undefined
                                        }
                                        onChange={(e) =>
                                          setEMovDate(e.target.value)
                                        }
                                      />
                                      <p className="text-[11px] text-gray-600 mt-1">
                                        Solo fecha; no anterior a la venta.
                                      </p>
                                    </div>
                                  ) : m.type === "CARGO" &&
                                    m.ref?.saleId &&
                                    Number(m.amount) > 0 ? (
                                    <div className="space-y-2">
                                      <div>
                                        <div className="text-[11px] text-gray-500">
                                          Fecha
                                        </div>
                                        <input
                                          type="date"
                                          className="w-full border p-2 rounded-xl"
                                          value={eMovDate}
                                          min={
                                            editMinSaleDate || undefined
                                          }
                                          onChange={(e) =>
                                            setEMovDate(e.target.value)
                                          }
                                        />
                                      </div>
                                      <div>
                                        <div className="text-[11px] text-gray-500">
                                          Comentario
                                        </div>
                                        <input
                                          className="w-full border p-2 rounded-xl"
                                          value={eMovComment}
                                          onChange={(e) =>
                                            setEMovComment(e.target.value)
                                          }
                                          placeholder="Comentario"
                                        />
                                      </div>
                                      <p className="text-[11px] text-gray-600">
                                        El monto de la venta no se edita aquí.
                                      </p>
                                    </div>
                                  ) : (
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <div className="text-[11px] text-gray-500">
                                          Fecha
                                        </div>
                                        <input
                                          type="date"
                                          className="w-full border p-2 rounded-xl"
                                          value={eMovDate}
                                          onChange={(e) =>
                                            setEMovDate(e.target.value)
                                          }
                                        />
                                      </div>
                                      <div>
                                        <div className="text-[11px] text-gray-500">
                                          Monto
                                        </div>
                                        <input
                                          type="number"
                                          step="0.01"
                                          inputMode="decimal"
                                          className="w-full border p-2 rounded-xl text-right"
                                          value={
                                            Number.isNaN(eMovAmount)
                                              ? ""
                                              : eMovAmount
                                          }
                                          onChange={(e) => {
                                            const num = Number(
                                              e.target.value || 0,
                                            );
                                            const safe = Number.isFinite(num)
                                              ? Math.max(
                                                  0,
                                                  parseFloat(num.toFixed(2)),
                                                )
                                              : 0;
                                            setEMovAmount(safe);
                                          }}
                                        />
                                      </div>
                                    </div>
                                  ))}

                                {/* acciones */}
                                {isEditing ? (
                                  <div className="grid grid-cols-2 gap-2 pt-1">
                                    <button
                                      className="px-3 py-2 rounded-xl text-white bg-blue-600 hover:bg-blue-700"
                                      onClick={saveEditMovement}
                                      type="button"
                                    >
                                      Guardar
                                    </button>
                                    <button
                                      className="px-3 py-2 rounded-xl bg-gray-200 hover:bg-gray-300"
                                      onClick={cancelEditMovement}
                                      type="button"
                                    >
                                      Cancelar
                                    </button>
                                  </div>
                                ) : (
                                  <div className="flex justify-end pt-1">
                                    <button
                                      type="button"
                                      className="p-2 rounded-xl border border-gray-200 bg-white inline-flex"
                                      aria-label="Acciones de movimiento"
                                      onClick={(e) => {
                                        e.stopPropagation();
                                        setMovementRowMenu({
                                          id: m.id,
                                          rect: (
                                            e.currentTarget as HTMLElement
                                          ).getBoundingClientRect(),
                                        });
                                      }}
                                    >
                                      <FiMoreVertical className="w-5 h-5 text-gray-700" />
                                    </button>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        );
                      })
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* ===== Modal Abonar ===== */}
            {showAbono && (
              <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[90]">
                <div className="bg-white rounded-lg shadow-2xl border w-[95%] max-w-md p-4">
                  <h3 className="text-lg font-bold">
                    {abonoTargetSaleId
                      ? `Abonar — ${stCustomer?.name || ""}`
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
                      <label className="block text-sm font-semibold">
                        Fecha
                      </label>
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
                      <label className="block text-sm font-semibold">
                        Monto
                      </label>
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
                      {abonoPreviewCommission != null &&
                        abonoPreviewCommission > 0 && (
                          <p className="text-xs text-emerald-800 mt-2 font-medium">
                            Comisión vendedor (aprox.):{" "}
                            {money(abonoPreviewCommission)}
                          </p>
                        )}
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
                      type="button"
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
                      type="button"
                      className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700 disabled:opacity-60"
                      onClick={() => void saveAbono()}
                      disabled={savingAbono}
                    >
                      {savingAbono ? "Guardando..." : "Guardar abono"}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        <ActionMenu
          anchorRect={statementHeaderMenuRect}
          isOpen={!!statementHeaderMenuRect}
          onClose={() => setStatementHeaderMenuRect(null)}
          width={220}
        >
          <div className="py-1">
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              onClick={() => {
                setStatementHeaderMenuRect(null);
                setAbonoTargetSaleId(null);
                setAbonoAmount(0);
                setAbonoDate(formatLocalDate(new Date()));
                setAbonoComment("");
                setShowAbono(true);
              }}
            >
              Abono general
            </button>
            <button
              type="button"
              className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
              onClick={() => {
                setStatementHeaderMenuRect(null);
                setShowStatement(false);
                setItemsDrawerOpen(false);
              }}
            >
              Cerrar
            </button>
          </div>
        </ActionMenu>

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
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                    onClick={() => {
                      setSaleMenuAnchor(null);
                      void openItemsDrawer(sid);
                    }}
                  >
                    Ver detalle de compra
                  </button>
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
                    Movimientos
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

        <ActionMenu
          anchorRect={movementRowMenu?.rect ?? null}
          isOpen={!!movementRowMenu}
          onClose={() => setMovementRowMenu(null)}
          width={260}
        >
          {movementRowMenu &&
            (() => {
              const m = stRows.find((x) => x.id === movementRowMenu.id);
              if (!m) {
                return (
                  <div className="px-3 py-2 text-sm text-gray-500">
                    Sin datos
                  </div>
                );
              }
              return (
                <div className="py-1">
                  {m.ref?.saleId &&
                    m.type === "CARGO" &&
                    Number(m.amount) > 0 && (
                      <button
                        type="button"
                        className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                        onClick={() => {
                          setMovementRowMenu(null);
                          void openItemsDrawer(m.ref!.saleId!);
                        }}
                      >
                        Ver detalle de compra
                      </button>
                    )}
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100"
                    onClick={() => {
                      setMovementRowMenu(null);
                      startEditMovement(m);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-700"
                    onClick={() => {
                      setMovementRowMenu(null);
                      void deleteMovement(m);
                    }}
                  >
                    Borrar
                  </button>
                </div>
              );
            })()}
        </ActionMenu>

        <ActionMenu
          anchorRect={ledgerMovementMenu?.rect ?? null}
          isOpen={!!ledgerMovementMenu && isAdmin}
          onClose={() => setLedgerMovementMenu(null)}
          width={220}
        >
          {ledgerMovementMenu &&
            isAdmin &&
            (() => {
              const row = stRows.find((x) => x.id === ledgerMovementMenu.rowId);
              if (!row) {
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
                      setLedgerMovementMenu(null);
                      startEditMovement(row);
                    }}
                  >
                    Editar
                  </button>
                  <button
                    type="button"
                    className="w-full text-left px-3 py-2 text-sm hover:bg-slate-100 text-red-700"
                    onClick={() => {
                      setLedgerMovementMenu(null);
                      void deleteMovement(row);
                    }}
                  >
                    Borrar
                  </button>
                </div>
              );
            })()}
        </ActionMenu>

        {saleLedgerSaleId && (
          <div className="fixed inset-0 z-[62] flex items-center justify-center p-4">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => {
                setSaleLedgerSaleId(null);
                cancelEditMovement();
              }}
            />
            <div
              className="relative z-10 bg-white rounded-lg shadow-xl border w-[95%] max-w-3xl max-h-[85vh] overflow-auto p-4"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-2 mb-3">
                <div>
                  <h3 className="text-lg font-bold">Cuenta de la venta</h3>
                  <p className="text-sm text-gray-600">
                    Cliente: {stCustomer?.name || "—"}
                  </p>
                </div>
                <button
                  type="button"
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 shrink-0"
                  onClick={() => {
                    setSaleLedgerSaleId(null);
                    cancelEditMovement();
                  }}
                >
                  Cerrar
                </button>
              </div>

              <div className="rounded-2xl border-2 border-slate-200/90 bg-gradient-to-br from-white via-slate-50/40 to-white p-4 shadow-md mb-4">
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex flex-col items-stretch justify-center rounded-xl bg-gradient-to-b from-emerald-50 to-emerald-100/70 border border-emerald-300/60 px-3 py-3 shadow-inner">
                    <span className="inline-flex self-center rounded-full bg-emerald-600/90 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                      Saldo
                    </span>
                    <span className="text-center text-lg font-bold text-emerald-950 mt-2 tabular-nums">
                      {money(getPendingForSale(stRows, saleLedgerSaleId))}
                    </span>
                    <span className="text-[10px] text-center text-emerald-800/80 mt-1">
                      Pendiente de esta venta
                    </span>
                  </div>
                  <div className="flex flex-col items-stretch justify-center rounded-xl bg-gradient-to-b from-rose-50 to-rose-100/70 border border-rose-300/60 px-3 py-3 shadow-inner">
                    <span className="inline-flex self-center rounded-full bg-rose-600/90 px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-wide text-white shadow-sm">
                      Abonos
                    </span>
                    <span className="text-center text-lg font-bold text-rose-950 mt-2 tabular-nums">
                      {money(
                        getTotalAbonadoForSale(stRows, saleLedgerSaleId),
                      )}
                    </span>
                    <span className="text-[10px] text-center text-rose-800/80 mt-1">
                      Total abonado a la venta
                    </span>
                  </div>
                </div>
              </div>

              {showLedgerStyleEditPanel && !!saleLedgerSaleId && (
                <div className="mb-3">{renderEditMovementPanelLedger()}</div>
              )}

              <div className="hidden md:block border rounded overflow-x-auto">
                <table className="min-w-full text-sm">
                  <thead className="bg-gray-100">
                    <tr>
                      <th className="p-2 border text-left">Fecha</th>
                      <th className="p-2 border text-right">Monto</th>
                      <th className="p-2 border text-right">Comisión</th>
                      <th className="p-2 border text-right">Saldo inicial</th>
                      <th className="p-2 border text-right">Saldo final</th>
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
                          colSpan={isAdmin ? 7 : 6}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay abonos con referencia a esta venta. Los abonos
                          generales del cliente siguen reflejados en los KPI del
                          estado de cuenta.
                        </td>
                      </tr>
                    ) : (
                      saleLedgerComputed.map((row) => (
                        <tr key={row.id} className="text-center">
                          <td className="p-2 border">{row.date || "—"}</td>
                          <td className="p-2 border text-right font-medium">
                            {money(-row.montoAbs)}
                          </td>
                          <td className="p-2 border text-right text-xs font-semibold text-emerald-800">
                            {money(Number(row.commissionOnPayment || 0))}
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
                              <div className="flex justify-center">
                                <button
                                  type="button"
                                  className="p-1.5 rounded hover:bg-gray-100 inline-flex"
                                  aria-label="Acciones de abono"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setLedgerMovementMenu({
                                      rowId: row.id,
                                      rect: (
                                        e.currentTarget as HTMLElement
                                      ).getBoundingClientRect(),
                                    });
                                  }}
                                >
                                  <FiMoreVertical className="w-5 h-5 text-gray-700" />
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
                      <div className="mt-2 text-xs text-emerald-800 font-semibold">
                        Comisión: {money(Number(row.commissionOnPayment || 0))}
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
                        <div className="mt-2 flex justify-end">
                          <button
                            type="button"
                            className="p-2 rounded-lg border border-gray-200 bg-white inline-flex"
                            aria-label="Acciones de abono"
                            onClick={(e) => {
                              e.stopPropagation();
                              setLedgerMovementMenu({
                                rowId: row.id,
                                rect: (
                                  e.currentTarget as HTMLElement
                                ).getBoundingClientRect(),
                              });
                            }}
                          >
                            <FiMoreVertical className="w-5 h-5 text-gray-700" />
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
        </>
      )}

      <SlideOverDrawer
        open={itemsDrawerOpen}
        onClose={() => {
          setItemsDrawerOpen(false);
          setItemsDrawerMeta(null);
        }}
        titleId="candies-items-drawer-title"
        title={
          <>
            Dulces vendidos
            {itemsModalSaleId ? (
              <span className="text-gray-500 font-normal">
                {" "}
                — #{itemsModalSaleId}
              </span>
            ) : null}
          </>
        }
        subtitle={
          itemsDrawerMeta?.saleDate
            ? `Fecha de compra: ${itemsDrawerMeta.saleDate}`
            : "Detalle de la compra"
        }
        zIndexClassName="z-[78]"
        panelMaxWidthClassName="max-w-2xl"
      >
        {itemsModalLoading ? (
          <p className="text-sm text-gray-600 px-1">Cargando…</p>
        ) : itemsModalRows.length === 0 ? (
          <p className="text-sm text-gray-600 px-1">Sin ítems en esta venta.</p>
        ) : (
          <>
            {itemsDrawerMeta && (
              <DrawerMoneyStrip
                items={[
                  {
                    label: "Paquetes",
                    value: String(itemsDrawerMeta.totalPackages),
                    tone: "blue",
                  },
                  {
                    label: "Monto",
                    value: money(itemsDrawerMeta.saleAmount),
                    tone: "slate",
                  },
                  {
                    label: "Comisión",
                    value: money(itemsDrawerMeta.commissionTotal),
                    tone: "emerald",
                  },
                ]}
              />
            )}
            <div className="space-y-3 px-1 pb-4">
              <DrawerSectionTitle
                className={itemsDrawerMeta ? "mt-4" : "mt-0"}
              >
                Líneas de venta
              </DrawerSectionTitle>
              {itemsModalRows.map((it, idx) => (
                <DrawerDetailDlCard
                  key={idx}
                  title={it.productName || `Producto ${idx + 1}`}
                  rows={[
                    { label: "Paquetes", value: String(it.qty) },
                    { label: "Precio unit.", value: money(it.unitPrice) },
                    {
                      label: "Descuento",
                      value: it.discount ? money(it.discount) : "—",
                    },
                    { label: "Monto", value: money(it.total) },
                    {
                      label: "Comisión línea",
                      value: money(it.lineCommission),
                    },
                    {
                      label: "Comisión / paquete",
                      value:
                        it.qty > 0
                          ? money(it.commissionPerPackage)
                          : "—",
                    },
                  ]}
                />
              ))}
            </div>
          </>
        )}
      </SlideOverDrawer>
    </div>
  );
}
