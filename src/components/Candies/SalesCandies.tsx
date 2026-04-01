// src/components/Candies/SalesCandiesPOS.tsx
// IMPORTANTE: ahora la venta descuenta del pedido del vendedor (inventory_candies_sellers)

import React, { useEffect, useMemo, useState, useRef } from "react";
import BottomSheet from "../common/BottomSheet";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  onSnapshot,
  orderBy,
  query,
  Timestamp,
  where,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { syncAbonoCommissionsForCustomer } from "../../Services/commissionAbonoCandies";
import { hasRole } from "../../utils/roles";
import LoadingOverlay from "../common/LoadingOverlay";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Button from "../common/Button";
import jsPDF from "jspdf";
import { set } from "date-fns";

type ClientType = "CONTADO" | "CREDITO";
type Status = "ACTIVO" | "BLOQUEADO";
type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

// Sucursal guardada en sellers_candies
type SellerBranchLabel = "Rivas" | "Isla Ometepe" | "San Jorge";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// helper: round 2 decimals
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

const PLACES = [
  "Altagracia",
  "Taguizapa",
  "El paso",
  "Calaysa",
  "Urbaite",
  "Las Pilas",
  "Pull",
  "Tilgue",
  "Balgüe",
  "Santa Cruz",
  "Moyogalpa",
  "Santo Domingo",
  "San José del Sur",
  "San Fernando",
  "Merida",
  "La Paloma",
  "San Lorenzo",
  "San Carlos",
  "San Miguel",
] as const;
type Place = (typeof PLACES)[number];

interface Customer {
  id: string;
  name: string;
  phone: string;
  place: Place | "";
  status: Status;
  creditLimit?: number;
  balance?: number;
  sellerId?: string;
  vendorId?: string;
}

interface Product {
  id: string;
  name: string;
  sku?: string;
  unitsPerPackage: number;
  priceRivas: number;
  priceSanJorge: number;
  priceIsla: number;
  barcode?: string;
  providerPrice?: number; // precio costo por paquete (catálogo)
  providerPricePerUnit?: number; // precio costo por unidad (catálogo)
}

// Catálogo de vendedores
interface Vendor {
  id: string;
  name: string;
  branch: Branch; // sucursal normalizada
  branchLabel: string; // label como se guarda en sellers_candies
  commissionPercent: number; // % comisión sobre la venta
  status?: Status;
}

/**
 * Item seleccionado en la venta (todo en PAQUETES a nivel visual).
 * - qtyPackages → cantidad vendida en paquetes
 * - availableUnits → stock real en unidades (del PEDIDO DEL VENDEDOR)
 * - unitsPerPackage → unidades por paquete
 * - pricePerPackage → precio POR PAQUETE según sucursal
 */
interface SelectedItem {
  productId: string;
  productName: string;
  sku?: string;
  unitsPerPackage: number;
  pricePerPackage: number; // precio por paquete
  availableUnits: number; // stock real (unidades)
  qtyPackages: number; // cantidad vendida (paquetes)
  discount: number; // entero (C$) aplicado a este ítem
  providerPricePerPackage?: number; // precio proveedor por paquete (referencia)
  margenVendedor?: number; // comisión calculada sobre la ganancia bruta
  uBruta?: number; // utilidad bruta por ítem
  uvXpaq?: number; // utilidad por paquete desde orden de vendedor (si existe)
  uNetaPorPaquete?: number; // utilidad neta por paquete (desde orden de vendedor)
  uNeta?: number; // utilidad neta total por línea (opcional)
}

interface VoucherItem {
  productName: string;
  qty: number; // paquetes
  unitPrice: number; // precio por paquete
  total: number;
}

function branchLabel(branch: Branch): string {
  switch (branch) {
    case "RIVAS":
      return "Rivas";
    case "SAN_JORGE":
      return "San Jorge";
    case "ISLA":
      return "Isla de Ometepe";
    default:
      return "";
  }
}

function sellerBranchLabelToBranch(label: string | undefined): Branch {
  switch (label) {
    case "Rivas":
      return "RIVAS";
    case "San Jorge":
      return "SAN_JORGE";
    case "Isla Ometepe":
      return "ISLA";
    default:
      return "RIVAS";
  }
}

/** Precio por paquete según sucursal desde catálogo products_candies (respaldo). */
function pricePerPackageForBranch(p: Product, b: Branch): number {
  const n =
    b === "RIVAS"
      ? p.priceRivas
      : b === "SAN_JORGE"
        ? p.priceSanJorge
        : p.priceIsla;
  return Number(n) || 0;
}

/** Misma lógica que PreciosVenta / OrdenMaestra: packagePrice* o unitPrice* × und/paq. */
function pkgPricesFromCurrentPricesDoc(
  doc: Record<string, any> | undefined | null,
  unitsPerPackage: number,
): { rivas: number; isla: number } {
  const u = Math.max(1, Number(unitsPerPackage) || 1);
  let pkgIsla = Number(doc?.packagePriceIsla ?? NaN);
  let pkgRivas = Number(doc?.packagePriceRivas ?? NaN);
  if (!Number.isFinite(pkgIsla)) {
    const x = Number(doc?.unitPriceIsla ?? NaN);
    pkgIsla = Number.isFinite(x) ? x * u : 0;
  }
  if (!Number.isFinite(pkgRivas)) {
    const x = Number(doc?.unitPriceRivas ?? NaN);
    pkgRivas = Number.isFinite(x) ? x * u : 0;
  }
  return { rivas: pkgRivas, isla: pkgIsla };
}

function unitsForPriceFromDoc(
  priceDoc: Record<string, any> | undefined,
  prod: Product,
): number {
  const n = Number(
    priceDoc?.unitsPerPackage ??
      priceDoc?.unitsPerPack ??
      prod.unitsPerPackage ??
      1,
  );
  return Math.max(1, Number.isFinite(n) && n > 0 ? n : 1);
}

/**
 * Precio de venta por paquete: fuente principal current_prices (Precios venta),
 * luego catálogo products_candies. San Jorge no va en current_prices → solo catálogo.
 */
function salePricePerPackage(
  prod: Product,
  branch: Branch,
  priceDoc: Record<string, any> | undefined,
): number {
  const u = unitsForPriceFromDoc(priceDoc, prod);
  const { rivas, isla } = pkgPricesFromCurrentPricesDoc(priceDoc, u);
  if (branch === "RIVAS") {
    const n = Number(rivas) || 0;
    if (n > 0) return n;
    return pricePerPackageForBranch(prod, "RIVAS");
  }
  if (branch === "ISLA") {
    const n = Number(isla) || 0;
    if (n > 0) return n;
    return pricePerPackageForBranch(prod, "ISLA");
  }
  return pricePerPackageForBranch(prod, "SAN_JORGE");
}

/** Genera el PDF tipo voucher para la venta de dulces (sin autotable) */
function generateCandyVoucherPDF(args: {
  saleId: string;
  date: string;
  customerName: string;
  branch: Branch;
  items: VoucherItem[];
  total: number;
  vendorName?: string;
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number;
  abonos?: { customerName?: string; amount: number }[];
  abonosTotal?: number;
  totalFinal?: number;
}) {
  const {
    saleId,
    date,
    customerName,
    branch,
    items,
    total,
    vendorName,
    vendorCommissionPercent,
    vendorCommissionAmount,
    abonos,
    abonosTotal,
    totalFinal,
  } = args;

  const doc = new jsPDF();
  let y = 12;

  // Encabezado
  doc.setFontSize(16);
  doc.text("Multiservicios Ortiz", 10, y);
  y += 6;

  doc.setFontSize(12);
  doc.text("Recibo de venta certificada", 10, y);
  y += 8;

  doc.setFontSize(12);
  doc.text(`Fecha: ${date}`, 10, y);
  y += 5;
  doc.text(`Cliente: ${customerName || "Cliente Mostrador"}`, 10, y);
  y += 5;
  doc.text(`Sucursal: ${branchLabel(branch)}`, 10, y);
  y += 5;
  doc.text(`Autorizado: ${saleId}`, 10, y);
  y += 5;

  if (vendorName) {
    doc.text(`Vendedor: ${vendorName}`, 10, y);
    y += 5;
  }
  if (typeof vendorCommissionPercent === "number") {
    const amt = Number(vendorCommissionAmount || 0).toFixed(2);
    const pct = vendorCommissionPercent.toFixed(2);
    doc.text(`Comisión vendedor: ${pct}% — C$ ${amt}`, 10, y);
    y += 8;
  } else {
    y += 3;
  }

  // Encabezado de tabla simple
  doc.setFontSize(12);
  doc.text("Producto", 10, y);
  doc.text("Paquetes", 110, y, { align: "right" as any });
  doc.text("Precio.", 150, y, { align: "right" as any });
  doc.text("Subtotal", 200 - 10, y, { align: "right" as any });
  y += 4;
  doc.line(10, y, 200 - 10, y);
  y += 4;

  // Filas
  items.forEach((it) => {
    if (y > 270) {
      doc.addPage();
      y = 12;
    }

    const name =
      (it.productName || "").length > 50
        ? it.productName.slice(0, 47) + "..."
        : it.productName;

    doc.text(name, 10, y);
    doc.text(String(it.qty), 110, y, { align: "right" as any });
    doc.text(`C$ ${Number(it.unitPrice || 0).toFixed(2)}`, 150, y, {
      align: "right" as any,
    });
    doc.text(`C$ ${Number(it.total || 0).toFixed(2)}`, 200 - 10, y, {
      align: "right" as any,
    });
    y += 5;
  });

  y += 4;
  doc.line(10, y, 200 - 10, y);
  y += 6;

  // Total
  doc.setFontSize(13);
  doc.text(`Total: C$ ${Number(total || 0).toFixed(2)}`, 200 - 10, y, {
    align: "right" as any,
  });
  y += 6;

  if (Array.isArray(abonos) && abonos.length > 0) {
    doc.setFontSize(11);
    doc.text("Abonos:", 10, y);
    y += 5;

    abonos.forEach((a) => {
      if (y > 270) {
        doc.addPage();
        y = 12;
      }
      const name = String(a.customerName || "Cliente");
      const amount = Number(a.amount || 0).toFixed(2);
      const line = `${name} — C$ ${amount}`;
      doc.text(line, 10, y);
      y += 4;
    });

    if (typeof abonosTotal === "number") {
      y += 2;
      doc.setFontSize(12);
      doc.text(
        `Total abonos: C$ ${Number(abonosTotal || 0).toFixed(2)}`,
        10,
        y,
      );
      y += 5;
    }

    if (typeof totalFinal === "number") {
      doc.setFontSize(12);
      doc.text(`Total final: C$ ${Number(totalFinal || 0).toFixed(2)}`, 10, y);
      y += 6;
    }
  }

  doc.setFontSize(9);
  doc.text("Gracias por su compra.", 10, y);

  doc.save(`venta_dulces_${saleId}.pdf`);
}

// Helpers: AHORA lee stock desde el PEDIDO DEL VENDEDOR de forma más tolerante
async function getAvailableUnitsForCandyFromVendor(
  productId: string,
  vendorId: string,
): Promise<number> {
  if (!productId || !vendorId) return 0;

  const qRef = query(
    collection(db, "inventory_candies_sellers"),
    where("sellerId", "==", vendorId),
    where("productId", "==", productId),
    // OJO: ya no filtramos aquí por remainingUnits > 0 para evitar problemas de índices
  );

  const snap = await getDocs(qRef);
  let available = 0;

  snap.forEach((d) => {
    const x = d.data() as any;
    // Tomamos el campo correcto según exista
    const rem = Number(x.remainingUnits ?? x.remaining ?? x.totalUnits ?? 0);
    if (rem > 0) {
      available += rem;
    }
  });

  return available;
}
const todayLocalISO = () => {
  const d = new Date();
  // convierte a "fecha local" pero en formato ISO yyyy-mm-dd
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
};

// Descuenta unidades desde inventory_candies_sellers (pedido del vendedor) en FIFO
async function allocateSaleFIFOCandyFromVendor(args: {
  productId: string;
  vendorId: string;
  quantityUnits: number;
  saleDate: string;
  saleId: string;
}): Promise<{
  allocations: {
    inventorySellerId: string;
    productId: string;
    units: number;
    saleDate: string;
    saleId: string;
  }[];
}> {
  const { productId, vendorId, quantityUnits, saleDate, saleId } = args;
  let remaining = Math.max(0, Math.floor(Number(quantityUnits || 0)));
  const allocations: {
    inventorySellerId: string;
    productId: string;
    units: number;
    saleDate: string;
    saleId: string;
  }[] = [];

  if (!productId || !vendorId || remaining <= 0) {
    return { allocations: [] };
  }

  const qRef = query(
    collection(db, "inventory_candies_sellers"),
    where("sellerId", "==", vendorId),
    where("productId", "==", productId),
    where("remainingUnits", ">", 0),
    orderBy("date", "asc"),
    orderBy("createdAt", "asc"),
  );

  const snap = await getDocs(qRef);

  for (const d of snap.docs) {
    if (remaining <= 0) break;
    const data = d.data() as any;
    const remUnits = Number(data.remainingUnits || 0);
    if (remUnits <= 0) continue;

    const take = Math.min(remUnits, remaining);
    const newRemUnits = remUnits - take;
    const unitsPerPackage = Math.max(
      1,
      Math.floor(Number(data.unitsPerPackage || 1)),
    );
    const newRemPacks = Math.floor(newRemUnits / unitsPerPackage);

    await updateDoc(d.ref, {
      remainingUnits: newRemUnits,
      remainingPackages: newRemPacks,
    });

    allocations.push({
      inventorySellerId: d.id,
      productId,
      units: take,
      saleDate,
      saleId,
    });

    remaining -= take;
  }

  if (remaining > 0) {
    console.warn(
      "[allocateSaleFIFOCandyFromVendor] No alcanzó el inventario del vendedor, faltaron unidades.",
      { productId, vendorId, remaining },
    );
  }

  return { allocations };
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

// ===== NUEVO: Props opcionales para amarrar el vendedor al usuario logueado =====

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface SalesCandiesPOSProps {
  role?: RoleProp;
  sellerCandyId?: string; // id del vendedor de dulces asociado al usuario
  currentUserEmail?: string; // opcional, por si después lo usamos para algo más
  roles?: RoleProp[] | string[];
}

interface PendingAbono {
  id: string;
  date: string;
  amount: number;
  customerId: string;
  customerName: string;
}

export default function SalesCandiesPOS({
  role = "",
  roles,
  sellerCandyId = "",
  currentUserEmail,
}: SalesCandiesPOSProps & { roles?: string[] }) {
  const subject = roles && roles.length ? roles : role;
  const isAdmin = hasRole(subject, "admin");
  const isVendDulces = hasRole(subject, "vendedor_dulces");
  const isContador = hasRole(subject, "contador");
  // Catálogos
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [products, setProducts] = useState<Product[]>([]);
  const [vendors, setVendors] = useState<Vendor[]>([]);
  /** Precios de venta (Precios venta) — misma colección que PreciosVenta.tsx */
  const [priceDocsById, setPriceDocsById] = useState<Record<string, any>>({});

  // stockByProduct → stock en UNIDADES por productId DEL PEDIDO DEL VENDEDOR
  const [stockByProduct, setStockByProduct] = useState<Record<string, number>>(
    {},
  );
  // detalles completos por productId desde inventory_candies_sellers (uvXpaq, uNetaPorPaquete, etc.)
  const [stockDetailsByProduct, setStockDetailsByProduct] = useState<
    Record<string, any>
  >({});

  // Generales
  const [clientType, setClientType] = useState<ClientType>("CONTADO");
  const [branch, setBranch] = useState<Branch>("RIVAS");
  const [customerId, setCustomerId] = useState<string>("");
  const [customerNameCash, setCustomerNameCash] = useState<string>("");
  const [saleDate, setSaleDate] = useState(todayLocalISO());

  // Vendedor seleccionado
  const [vendorId, setVendorId] = useState<string>("");
  const [lockVendor, setLockVendor] = useState<boolean>(false);

  const activeVendors = useMemo(
    () => vendors.filter((v) => (v.status ?? "ACTIVO") === "ACTIVO"),
    [vendors],
  );

  // Selección de productos (múltiple)
  const [productId, setProductId] = useState<string>("");
  const [items, setItems] = useState<SelectedItem[]>([]);

  // ===== MOBILE UI (colapsables) =====
  const [openSaleInfo, setOpenSaleInfo] = useState(true);
  const [openItems, setOpenItems] = useState(false);
  const [openAbonos, setOpenAbonos] = useState(false);

  // Totales
  const totalPackages = useMemo(
    () => items.reduce((acc, it) => acc + (it.qtyPackages || 0), 0),
    [items],
  );
  const totalUnitsSold = useMemo(
    () =>
      items.reduce(
        (acc, it) => acc + (it.qtyPackages || 0) * (it.unitsPerPackage || 1),
        0,
      ),
    [items],
  );
  const totalAmount = useMemo(() => {
    const sum = items.reduce((acc, it) => {
      const lineGross =
        (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
      const disc = Number(it.discount) || 0;
      const lineNet = Math.max(0, lineGross - disc);
      return acc + lineNet;
    }, 0);
    return Math.floor(sum * 100) / 100;
  }, [items]);

  const [downPayment, setDownPayment] = useState<number>(0);
  const [msg, setMsg] = useState<string>("");
  const [saving, setSaving] = useState(false);

  // ===== Abonos (pendientes hasta guardar venta) =====
  const [abonoDate, setAbonoDate] = useState<string>(todayLocalISO());
  const [abonoAmount, setAbonoAmount] = useState<number>(0);
  const [abonoCustomerId, setAbonoCustomerId] = useState<string>("");
  const [pendingAbonos, setPendingAbonos] = useState<PendingAbono[]>([]);

  // Modal cliente
  const [showModal, setShowModal] = useState(false);
  // Modal para campos faltantes al guardar
  const [missingFieldsModalOpen, setMissingFieldsModalOpen] = useState(false);
  const [missingFieldsList, setMissingFieldsList] = useState<string[]>([]);
  const [mName, setMName] = useState("");
  const [mPhone, setMPhone] = useState("+505 ");
  const [mPlace, setMPlace] = useState<Place | "">("");
  const [mNotes, setMNotes] = useState("");
  const [mStatus, setMStatus] = useState<Status>("ACTIVO");
  const [mCreditLimit, setMCreditLimit] = useState<number>(0);
  const [mSellerId, setMSellerId] = useState<string>("");
  const resetModal = () => {
    setMName("");
    setMPhone("+505 ");
    setMPlace("");
    setMNotes("");
    setMStatus("ACTIVO");
    setMCreditLimit(0);
  };

  // scanner state & handler
  const [scanOpen, setScanOpen] = useState(false);
  const onDetectedFromScanner = async (code: string) => {
    const c = String(code || "").trim();
    if (!c) return;
    // buscar en productos disponibles para el picker
    const byBarcode = productsForVendorPicker.find(
      (p: Product) => String((p as any).barcode || "") === c,
    );
    const bySku = productsForVendorPicker.find(
      (p: Product) => String(p.sku || "") === c,
    );
    const byId = productsForVendorPicker.find(
      (p: Product) => String(p.id || "") === c,
    );
    const found = byBarcode || bySku || byId || null;
    if (found) {
      await addProductToList(found.id);
      setMsg("✅ Producto agregado desde escáner.");
      setTimeout(() => setMsg(""), 2500);
    } else {
      setMsg("⚠️ Código no corresponde a ningún producto disponible.");
      setTimeout(() => setMsg(""), 2500);
    }
  };

  function BarcodeScanModal({
    open,
    onClose,
    onDetected,
  }: {
    open: boolean;
    onClose: () => void;
    onDetected: (code: string) => void;
  }) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const controlsRef = useRef<IScannerControls | null>(null);
    const [err, setErr] = useState<string>("");
    const lastRef = useRef<string>("");

    useEffect(() => {
      if (!open) return;
      let cancelled = false;
      const reader = new BrowserMultiFormatReader();

      const stopAll = () => {
        try {
          controlsRef.current?.stop();
        } catch {}
        controlsRef.current = null;
        try {
          const stream = videoRef.current?.srcObject as MediaStream | null;
          try {
            stream?.getTracks?.().forEach((t: MediaStreamTrack) => t.stop());
          } catch {}
        } catch {}
        try {
          if (videoRef.current) videoRef.current.srcObject = null;
        } catch {}
      };

      const start = async () => {
        setErr("");
        try {
          if (!videoRef.current) return;
          try {
            const warm = await navigator.mediaDevices.getUserMedia({
              video: { facingMode: { ideal: "environment" } },
              audio: false,
            });
            warm.getTracks().forEach((t) => t.stop());
          } catch (e: any) {}

          const controls = await reader.decodeFromConstraints(
            {
              video: {
                facingMode: { ideal: "environment" },
                width: { ideal: 1280 },
                height: { ideal: 720 },
              },
              audio: false,
            } as any,
            videoRef.current,
            (result) => {
              if (cancelled) return;
              if (result) {
                const code = String(result.getText() || "")
                  .trim()
                  .replace(/\s+/g, "");
                if (!code) return;
                if (code === lastRef.current) return;
                lastRef.current = code;
                stopAll();
                onDetected(code);
                onClose();
              }
            },
          );
          controlsRef.current = controls;
        } catch (e: any) {
          const msg = String(e?.message || "");
          const name = String(e?.name || "");
          if (
            msg.toLowerCase().includes("permission") ||
            name === "NotAllowedError"
          ) {
            setErr("Permiso de cámara denegado.");
          } else if (
            name === "NotFoundError" ||
            msg.toLowerCase().includes("notfound")
          ) {
            setErr("No se encontró cámara en este dispositivo.");
          } else if (
            msg.toLowerCase().includes("secure") ||
            msg.toLowerCase().includes("https")
          ) {
            setErr("La cámara requiere HTTPS (sitio seguro).");
          } else {
            setErr(msg || "No se pudo iniciar el escáner.");
          }
        }
      };

      start();
      return () => {
        cancelled = true;
        try {
          controlsRef.current?.stop();
        } catch {}
        controlsRef.current = null;
      };
    }, [open, onClose, onDetected]);

    if (!open) return null;
    return (
      <div className="fixed inset-0 bg-black/70 z-50 p-3 flex items-center justify-center">
        <div className="bg-white w-full max-w-md rounded-2xl shadow-lg border overflow-hidden">
          <div className="flex items-center justify-between p-3 border-b">
            <div className="font-bold">Escanear código</div>
            <Button
              variant="secondary"
              className="rounded-lg"
              onClick={onClose}
              type="button"
            >
              Cerrar
            </Button>
          </div>
          <div className="p-3">
            <div className="relative w-full aspect-[3/4] bg-black rounded-xl overflow-hidden">
              <video
                ref={videoRef}
                className="w-full h-full object-cover"
                muted
                playsInline
                autoPlay
              />
              <div className="absolute inset-0 pointer-events-none">
                <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-[85%] h-40 border-2 border-white/70 rounded-xl" />
              </div>
            </div>
            {err && (
              <div className="mt-3 text-sm text-red-600 bg-red-50 border border-red-200 rounded p-2">
                {err}
              </div>
            )}
            <div className="mt-2 text-xs text-gray-600">
              Apuntá al código de barras y mantenelo estable.
            </div>
          </div>
        </div>
      </div>
    );
  }

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );
  const customersForCredit = useMemo(() => {
    if (lockVendor && vendorId) {
      return customers.filter(
        (c) => ((c as any).vendorId ?? c.sellerId ?? "") === vendorId,
      );
    }
    return customers;
  }, [customers, lockVendor, vendorId]);

  const customersWithBalance = useMemo(() => {
    const effectiveVendorId = lockVendor ? vendorId || sellerCandyId : vendorId;
    return customersForCredit.filter((c) => {
      if (Number(c.balance || 0) <= 0) return false;
      if (!effectiveVendorId) return false;
      const cVendorId = (c as any).vendorId ?? c.sellerId ?? "";
      return cVendorId === effectiveVendorId;
    });
  }, [customersForCredit, lockVendor, vendorId, sellerCandyId]);

  const selectedAbonoCustomer = useMemo(
    () => customers.find((c) => c.id === abonoCustomerId) || null,
    [customers, abonoCustomerId],
  );

  const customerBalanceById = useMemo(() => {
    const map: Record<string, number> = {};
    customers.forEach((c) => {
      map[c.id] = Number(c.balance || 0) || 0;
    });
    return map;
  }, [customers]);

  const abonoTotalPending = useMemo(() => {
    return round2(
      pendingAbonos.reduce((acc, a) => acc + Number(a.amount || 0), 0),
    );
  }, [pendingAbonos]);

  const abonoCustomerBalance = useMemo(() => {
    return Math.max(0, Number(selectedAbonoCustomer?.balance || 0));
  }, [selectedAbonoCustomer]);

  const abonoPreviewAmount = useMemo(() => {
    return Math.max(0, Number(abonoAmount || 0));
  }, [abonoAmount]);

  const abonoSaldoFinal = useMemo(() => {
    return round2(Math.max(0, abonoCustomerBalance - abonoPreviewAmount));
  }, [abonoCustomerBalance, abonoPreviewAmount]);

  const abonoDisabled = !abonoCustomerId || !(Number(abonoAmount || 0) > 0);

  const totalFinalWithAbonos = useMemo(() => {
    return round2(Math.max(0, Number(totalAmount || 0)) + abonoTotalPending);
  }, [totalAmount, abonoTotalPending]);

  const maxAbonoForCustomer = useMemo(() => {
    if (!abonoCustomerId) return 0;
    const balance = abonoCustomerBalance;
    return Math.max(0, balance || 0);
  }, [abonoCustomerId, abonoCustomerBalance]);

  const clampAbonoAmount = (raw: any) => {
    const n = Math.max(0, Number(raw || 0));
    if (!Number.isFinite(n)) return 0;
    return Math.min(n, maxAbonoForCustomer);
  };

  const currentBalance = selectedCustomer?.balance || 0;
  const projectedBalance =
    clientType === "CREDITO"
      ? currentBalance +
        Math.max(0, Number(totalAmount || 0)) -
        Math.max(0, Number(downPayment || 0))
      : 0;

  // ✅ Tope real del abono: no puede exceder la deuda total (saldo actual + venta)
  const maxDownPaymentAllowed = useMemo(() => {
    if (clientType !== "CREDITO") return 0;
    const debtBeforePayment =
      Math.max(0, Number(currentBalance || 0)) +
      Math.max(0, Number(totalAmount || 0));
    return Math.floor(debtBeforePayment * 100) / 100; // 2 decimales, sin redondeos raros
  }, [clientType, currentBalance, totalAmount]);

  const clampDownPayment = (raw: any) => {
    const n = Math.max(0, Number(raw || 0));
    return Math.min(n, maxDownPaymentAllowed);
  };

  const selectedVendor = useMemo(
    () => vendors.find((v) => v.id === vendorId) || null,
    [vendors, vendorId],
  );

  const vendorCommissionPercent = useMemo(() => {
    const pct = Number(selectedVendor?.commissionPercent ?? 0);
    return Number.isFinite(pct) ? pct : 0;
  }, [selectedVendor]);

  const vendorCommissionAmount = useMemo(() => {
    const sum = items.reduce(
      (acc, it) => acc + Number(it.margenVendedor || 0),
      0,
    );
    return round2(sum);
  }, [items]);

  // Cargar catálogos
  useEffect(() => {
    (async () => {
      // clientes (dulces)
      const qC = query(
        collection(db, "customers_candies"),
        orderBy("createdAt", "desc"),
      );
      const cSnap = await getDocs(qC);
      const listC: Customer[] = [];
      cSnap.forEach((d) => {
        const x = d.data() as any;
        listC.push({
          id: d.id,
          name: x.name ?? "",
          phone: x.phone ?? "+505 ",
          place: x.place ?? "",
          status: (x.status as Status) ?? "ACTIVO",
          creditLimit: Number(x.creditLimit ?? 0),
          balance: 0,
          sellerId: x.sellerId ?? x.vendorId ?? "",
          vendorId: x.vendorId ?? x.sellerId ?? "",
        });
      });
      // saldos
      for (const c of listC) {
        try {
          const qMov = query(
            collection(db, "ar_movements"),
            where("customerId", "==", c.id),
          );
          const mSnap = await getDocs(qMov);
          let sum = 0;
          mSnap.forEach((m) => (sum += Number((m.data() as any).amount || 0)));
          const initialDebt = Number((c as any).initialDebt || 0);
          c.balance = sum + initialDebt;
        } catch {
          c.balance = 0;
        }
      }
      setCustomers(listC);

      // productos (dulces)
      const qP = query(
        collection(db, "products_candies"),
        orderBy("createdAt", "desc"),
      );
      const pSnap = await getDocs(qP);
      const listP: Product[] = [];
      pSnap.forEach((d) => {
        const x = d.data() as any;
        listP.push({
          id: d.id,
          name: x.name ?? "(sin nombre)",
          sku: x.sku ?? "",
          unitsPerPackage: Number(x.unitsPerPackage ?? 1),
          barcode: String(x.barcode || ""),
          priceRivas: Number(x.unitPriceRivas ?? 0),
          priceSanJorge: Number(x.unitPriceSanJorge ?? 0),
          priceIsla: Number(x.unitPriceIsla ?? 0),
          providerPrice: Number(x.providerPrice ?? 0),
          providerPricePerUnit: Number(x.providerPricePerUnit ?? 0),
        });
      });
      setProducts(listP);

      // catálogo de vendedores (sellers_candies)
      try {
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const listV: Vendor[] = [];
        vSnap.forEach((d) => {
          const x = d.data() as any;
          const rawBranch: string = x.branch || "Rivas";
          const normalizedBranch = sellerBranchLabelToBranch(rawBranch);
          listV.push({
            id: d.id,
            name: x.name ?? "(sin nombre)",
            branch: normalizedBranch,
            branchLabel: rawBranch,
            commissionPercent: Number(x.commissionPercent ?? 0),
          });
        });
        setVendors(listV);
      } catch (e) {
        console.error("Error cargando vendedores:", e);
      }

      // OJO: stockByProduct se cargará por vendedor, no desde inventario general
      setStockByProduct({});
    })();
  }, []);

  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "current_prices"),
      (snap) => {
        const pm: Record<string, any> = {};
        snap.forEach((d) => {
          pm[d.id] = d.data();
        });
        setPriceDocsById(pm);
      },
      (err) => console.error("[SalesCandies] current_prices", err),
    );
    return () => unsub();
  }, []);

  // leer usuario logueado / vendedor asociado para autoseleccionar vendedor
  useEffect(() => {
    const subject = roles && roles.length ? roles : role;
    // 1) Si viene atado desde App (usuario vendedor de dulces)
    if (
      subject &&
      (subject as any).includes?.("vendedor_dulces") &&
      sellerCandyId
    ) {
      setVendorId(sellerCandyId);
      setLockVendor(true);

      // Opcional: mantener compat con lógica anterior de localStorage
      try {
        localStorage.setItem("pos_vendorId", sellerCandyId);
        localStorage.setItem("pos_role", "VENDEDOR");
      } catch {
        // ignorar errores de storage
      }
      return;
    }
    if (subject && ((subject as any).includes?.("admin") || isContador)) {
      setLockVendor(false);
      return;
    }

    // 2) Comportamiento legacy: leer de localStorage
    try {
      const storedVendorId = localStorage.getItem("pos_vendorId") || "";
      const storedRole = localStorage.getItem("pos_role") || ""; // "ADMIN" | "VENDEDOR" | ...
      if (storedVendorId) {
        setVendorId(storedVendorId);
      }
      if (storedRole.toUpperCase() === "VENDEDOR") {
        setLockVendor(true); // el vendedor no puede cambiarse
      }
    } catch {
      // ignorar
    }
  }, [role, sellerCandyId]);

  // Cargar stock del pedido del vendedor seleccionado
  const reloadVendorStock = async (sellerId: string) => {
    if (!sellerId) {
      setStockByProduct({});
      return;
    }

    const qStockVendor = query(
      collection(db, "inventory_candies_sellers"),
      where("sellerId", "==", sellerId),
      // Igual que arriba: sin filtro de remainingUnits para evitar problemas de índice
    );

    const sSnap = await getDocs(qStockVendor);
    const map: Record<string, number> = {};
    const details: Record<string, any> = {};

    sSnap.forEach((d) => {
      const b = d.data() as any;
      const pid = b.productId || "";
      if (!pid) return;

      const rem = Number(b.remainingUnits ?? b.remaining ?? b.totalUnits ?? 0);
      if (rem <= 0) return; // ✅ mejora: no guardamos ceros

      map[pid] = (map[pid] || 0) + rem;
      // keep last doc data for this product (may be merged from multiple rows)
      details[pid] = { ...(details[pid] || {}), ...b };
    });

    setStockByProduct(map);
    setStockDetailsByProduct(details);

    // ✅ mejora: si algún producto ya no tiene stock, lo sacamos de la lista seleccionada
    setItems((prev) => {
      const kept: SelectedItem[] = [];
      for (const it of prev) {
        const units = map[it.productId] ?? 0;
        if (units > 0) {
          kept.push({
            ...it,
            availableUnits: units, // sincroniza stock en UI
          });
        }
      }
      return kept;
    });
  };

  // Cuando cambia el vendedor → setear sucursal y cargar sub-inventario
  useEffect(() => {
    if (!vendorId) {
      setStockByProduct({});
      return;
    }
    const v = vendors.find((vv) => vv.id === vendorId);
    if (v) {
      setBranch(v.branch); // sucursal viene del vendedor
    }
    reloadVendorStock(vendorId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [vendorId, vendors]);

  // Cuando cambia la sucursal o los precios de venta (current_prices), actualizar precio por paquete
  useEffect(() => {
    setItems((prev) =>
      prev.map((it) => {
        const prod = products.find((p) => p.id === it.productId);
        if (!prod) return it;
        return {
          ...it,
          pricePerPackage: salePricePerPackage(
            prod,
            branch,
            priceDocsById[it.productId],
          ),
        };
      }),
    );
  }, [branch, products, priceDocsById]);

  const pickBestVendorOrderData = async (
    productId: string,
    vendorId: string,
  ) => {
    if (!productId || !vendorId) return null;
    const qRef = query(
      collection(db, "inventory_candies_sellers"),
      where("sellerId", "==", vendorId),
      where("productId", "==", productId),
    );
    const snap = await getDocs(qRef);
    if (snap.empty) return null;

    let best: any = null;
    let bestKey = "";
    snap.forEach((d) => {
      const data = d.data() as any;
      const dateStr = String(data.date || "");
      const updatedAtSec = Number(
        data.updatedAt?.seconds ?? data.createdAt?.seconds ?? 0,
      );
      const remainingUnits = Number(
        data.remainingUnits ?? data.remaining ?? data.totalUnits ?? 0,
      );
      const remainingPacks = Number(data.remainingPackages ?? 0);
      const hasStock = remainingUnits > 0 || remainingPacks > 0 ? "1" : "0";
      const key = `${hasStock}#${dateStr}#${String(updatedAtSec).padStart(
        10,
        "0",
      )}`;
      if (!best || key > bestKey) {
        best = data;
        bestKey = key;
      }
    });

    return best || (snap.docs[0]?.data() as any) || null;
  };

  const calcVendorMarginFromUBruta = (uBruta: number) => {
    const percent = Number(vendorCommissionPercent || 0);
    const result = (Number(uBruta || 0) * percent) / 100;
    return Math.max(0, Number(result.toFixed(2)));
  };

  // Añadir producto (bloquea duplicados, usa stock del PEDIDO DEL VENDEDOR)
  const addProductToList = async (pid: string) => {
    if (!pid) return;
    if (!vendorId) {
      setMsg("Selecciona primero el vendedor para usar su inventario.");
      setProductId("");
      return;
    }
    if (items.some((it) => it.productId === pid)) {
      setProductId("");
      return;
    }

    const prod = products.find((p) => p.id === pid);
    if (!prod) {
      setProductId("");
      return;
    }

    // Stock del pedido del vendedor en UNIDADES
    const availableUnits = await getAvailableUnitsForCandyFromVendor(
      pid,
      vendorId,
    );

    // 🔒 FIX BLINDADO: tomar sucursal REAL del vendedor, no del state todavía
    const effectiveBranch =
      vendors.find((v) => v.id === vendorId)?.branch ?? branch;

    const orderData = await pickBestVendorOrderData(pid, vendorId);
    const priceFromOrder = (() => {
      if (!orderData) return 0;
      const pVendor = Number(orderData.unitPriceVendor ?? 0);
      if (pVendor > 0) return pVendor;
      if (effectiveBranch === "RIVAS")
        return Number(orderData.unitPriceRivas ?? 0);
      if (effectiveBranch === "SAN_JORGE")
        return Number(orderData.unitPriceSanJorge ?? 0);
      return Number(orderData.unitPriceIsla ?? 0);
    })();
    const priceFromPreciosVenta = salePricePerPackage(
      prod,
      effectiveBranch,
      priceDocsById[pid],
    );
    const price =
      Number(priceFromPreciosVenta) > 0
        ? Number(priceFromPreciosVenta)
        : Number(priceFromOrder) > 0
          ? Number(priceFromOrder)
          : Number(priceFromPreciosVenta);

    const providerPriceFromOrder = Number(orderData?.providerPrice ?? 0);

    const providerPriceFromCatalog = (() => {
      const perPackage = Number(prod.providerPrice || 0);
      if (perPackage > 0) return perPackage;
      const perUnit = Number(prod.providerPricePerUnit || 0);
      if (perUnit > 0) return perUnit * Number(prod.unitsPerPackage || 1);
      return 0;
    })();

    const providerPricePerPackage =
      Number(providerPriceFromOrder || 0) > 0
        ? Number(providerPriceFromOrder || 0)
        : Number(providerPriceFromCatalog || 0);

    const uvXpaqFromOrder = (() => {
      if (!orderData) return null;
      const candidates = [
        orderData.uvXpaq,
        orderData.uv_x_paq,
        orderData["UV x PAQ"],
        orderData["UV x Paq"],
        orderData["UV x paq"],
      ];
      for (const c of candidates) {
        if (c === undefined || c === null) continue;
        const num = Number(c);
        if (!Number.isNaN(num) && Number.isFinite(num)) return round2(num);
      }
      const packs = Math.max(1, Number(orderData.packages ?? 0));
      const uVendor = Number(
        orderData.uVendor ??
          orderData.vendorProfit ??
          orderData.gainVendor ??
          0,
      );
      if (Number.isFinite(uVendor) && packs > 0) {
        return round2(uVendor / packs);
      }
      return null;
    })();

    const newItem: SelectedItem = {
      productId: pid,
      productName: prod.name || "",
      sku: prod.sku || "",
      unitsPerPackage: prod.unitsPerPackage || 1,
      pricePerPackage: Number(price) || 0,
      availableUnits: Number(availableUnits) || 0,
      qtyPackages: 0,
      discount: 0,
      providerPricePerPackage: Number(providerPricePerPackage) || 0,
      margenVendedor: 0,
      uBruta: 0,
      uvXpaq: uvXpaqFromOrder ?? undefined,
    };
    setItems((prev) => [...prev, newItem]);
    setProductId("");
  };

  const setItemQty = (pid: string, qtyRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (qtyRaw === "") return { ...it, qtyPackages: 0 };
        const n = Math.max(0, Math.floor(Number(qtyRaw)));

        // calcular paquetes disponibles según stock del vendedor
        const availableUnits = stockByProduct[pid] ?? it.availableUnits ?? 0;
        const upp = Math.max(1, Number(it.unitsPerPackage || 1));
        const availablePackages = Math.floor(availableUnits / upp);

        let finalQty = n;
        if (n > availablePackages) {
          finalQty = availablePackages;
          setMsg(`⚠️ Solo hay ${availablePackages} paquetes disponibles.`);
          setTimeout(() => setMsg(""), 2500);
        }

        const monto = Number(it.pricePerPackage || 0) * finalQty;
        const facturadoCosto =
          Number(it.providerPricePerPackage || 0) * finalQty;
        const uBruta = monto - facturadoCosto;

        // If we have uvXpaq from the vendor order, compute margen as qtyPackages * uvXpaq
        const margenVendedor =
          Number.isFinite(Number(it.uvXpaq)) && it.uvXpaq !== undefined
            ? round2(finalQty * Number(it.uvXpaq || 0))
            : calcVendorMarginFromUBruta(uBruta);

        return {
          ...it,
          qtyPackages: finalQty,
          margenVendedor,
          uBruta,
        };
      }),
    );
  };

  // Actualizar descuento (entero)
  const setItemDiscount = (pid: string, discRaw: string) => {
    setItems((prev) =>
      prev.map((it) => {
        if (it.productId !== pid) return it;
        if (discRaw === "") return { ...it, discount: 0 };
        const n = Math.max(0, Math.floor(Number(discRaw)));
        const qty = it.qtyPackages || 0;
        const monto = Number(it.pricePerPackage || 0) * qty;
        const facturadoCosto = Number(it.providerPricePerPackage || 0) * qty;
        const uBruta = monto - facturadoCosto;
        const margenVendedor = calcVendorMarginFromUBruta(uBruta);

        return {
          ...it,
          discount: n,
          margenVendedor,
          uBruta,
        };
      }),
    );
  };

  const removeItem = (pid: string) =>
    setItems((prev) => prev.filter((it) => it.productId !== pid));

  // Validaciones
  const validate = async (): Promise<string | null> => {
    if (!saleDate) return "Selecciona la fecha.";
    if (!vendorId) return "Selecciona el vendedor para esta venta.";
    if (items.length === 0) return "Agrega al menos un producto.";
    const itemsWithQty = items.filter((it) => (it.qtyPackages || 0) > 0);
    if (itemsWithQty.length === 0)
      return "Debes ingresar cantidades (> 0) en al menos un producto.";
    if (!(totalAmount > 0)) return "El total debe ser mayor a cero.";

    if (clientType === "CONTADO") {
      if (!customerNameCash.trim())
        return "Ingresa el nombre del cliente (contado).";
    } else {
      if (!customerId) return "Selecciona un cliente (crédito).";
      if (downPayment < 0) return "El pago inicial no puede ser negativo.";
      if (downPayment > maxDownPaymentAllowed)
        return "El pago inicial no puede superar el saldo a deber (saldo actual + venta).";

      if (selectedCustomer?.status === "BLOQUEADO")
        return "El cliente está BLOQUEADO. No se puede facturar a crédito.";
    }

    // Stock y descuentos por ítem (contra PEDIDO DEL VENDEDOR)
    for (const it of itemsWithQty) {
      const unitsPerPackage = it.unitsPerPackage || 1;
      const qtyUnits = (it.qtyPackages || 0) * unitsPerPackage;

      const availableUnits = await getAvailableUnitsForCandyFromVendor(
        it.productId,
        vendorId,
      );
      const availablePackages = Math.floor(availableUnits / unitsPerPackage);

      if (qtyUnits > availableUnits)
        return `Inventario insuficiente en el pedido del vendedor para "${it.productName}". Disponible: ${availablePackages} paquetes.`;

      const lineGross =
        (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
      const disc = Number(it.discount) || 0;
      if (!Number.isInteger(disc) || disc < 0)
        return `El descuento en "${it.productName}" debe ser entero y ≥ 0.`;
      if (disc > lineGross)
        return `El descuento en "${
          it.productName
        }" no puede exceder C$ ${lineGross.toFixed(2)}.`;
    }
    return null;
  };

  // Guardar
  const saveSale = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");
    const err = await validate();
    if (err) {
      setMsg("❌ " + err);
      return;
    }

    try {
      setSaving(true);

      // First compute chosen values (prefer vendor detail), validate required fields,
      // then build the final items array to save. This enforces that uvxpaq and
      // uNetaPorPaquete exist (fail with clear message otherwise).
      const processed = items
        .filter((it) => (it.qtyPackages || 0) > 0)
        .map((it) => {
          const unitsPerPackage = it.unitsPerPackage || 1;
          const qtyPaq = it.qtyPackages || 0;
          const qtyUnits = qtyPaq * unitsPerPackage;

          const lineGross = (Number(it.pricePerPackage) || 0) * (qtyPaq || 0);
          const disc = Math.max(0, Math.floor(Number(it.discount) || 0));
          const lineNet = Math.max(0, lineGross - disc);
          const providerPricePerPackage = Number(
            it.providerPricePerPackage || 0,
          );
          const facturadoCosto = providerPricePerPackage * qtyPaq;
          const uBruta = lineGross - facturadoCosto;

          const vendorDetail = stockDetailsByProduct[it.productId] || {};

          const detailUv = Number(
            vendorDetail?.uvXpaq ??
              vendorDetail?.uvxpaq ??
              vendorDetail?.uVxPaq ??
              vendorDetail?.u_vxpaq ??
              vendorDetail?.upaquete ??
              NaN,
          );

          const uvxpaqFinal = Number.isFinite(Number(it.uvXpaq ?? NaN))
            ? Number(it.uvXpaq)
            : Number.isFinite(detailUv)
              ? Number(detailUv)
              : undefined;

          const detailUNeta = Number(
            vendorDetail?.uNetaPorPaquete ??
              vendorDetail?.uNeta ??
              vendorDetail?.u_neta ??
              NaN,
          );

          const uNetaPorPaquete = Number.isFinite(
            Number(it.uNetaPorPaquete ?? NaN),
          )
            ? Number(it.uNetaPorPaquete)
            : Number.isFinite(detailUNeta)
              ? Number(detailUNeta)
              : Number.isFinite(Number(it.uNeta ?? NaN)) &&
                  (it.qtyPackages || 0) > 0
                ? round2(Number(it.uNeta) / (it.qtyPackages || 1))
                : undefined;

          const margenVendedor = Number.isFinite(Number(uvxpaqFinal ?? NaN))
            ? round2((it.qtyPackages || 0) * Number(uvxpaqFinal || 0))
            : calcVendorMarginFromUBruta(uBruta);

          const vendorGain = round2((uvxpaqFinal || 0) * (it.qtyPackages || 0));
          const inversorGain = round2(
            (uNetaPorPaquete || 0) * (it.qtyPackages || 0),
          );

          return {
            _raw: it,
            productId: it.productId,
            productName: it.productName,
            sku: it.sku || "",
            qty: qtyUnits,
            packages: qtyPaq,
            unitsPerPackage,
            branch,
            unitPricePackage: Number(it.pricePerPackage) || 0,
            discount: disc,
            total: Math.floor(lineNet * 100) / 100,
            providerPricePerPackage,
            margenVendedor,
            uvxpaqFinal,
            uBruta,
            uNetaPorPaquete,
            vendorGain,
            inversorGain,
          };
        });

      // Validate required invariants: vendorId present and fields from vendor order exist
      const missing: string[] = [];
      if (!vendorId) missing.push("vendorId");
      for (const p of processed) {
        if (p.uvxpaqFinal === undefined || p.uvxpaqFinal === null)
          missing.push(`${p.productName}: uvXpaq`);
        if (p.uNetaPorPaquete === undefined || p.uNetaPorPaquete === null)
          missing.push(`${p.productName}: uNetaPorPaquete`);
      }
      if (missing.length > 0) {
        setSaving(false);
        setMissingFieldsList(missing);
        setMissingFieldsModalOpen(true);
        return;
      }

      const itemsToSave = processed.map((p) => ({
        productId: p.productId,
        productName: p.productName,
        sku: p.sku || "",
        qty: p.qty,
        packages: p.packages,
        unitsPerPackage: p.unitsPerPackage,
        branch: p.branch,
        unitPricePackage: p.unitPricePackage,
        discount: p.discount,
        total: p.total,
        providerPricePerPackage: p.providerPricePerPackage,
        margenVendedor: p.margenVendedor,
        uvXpaq: Number(p.uvxpaqFinal),
        uBruta: Number(p.uBruta || 0),
        uNetaPorPaquete: Number(p.uNetaPorPaquete),
        vendorGain: Number(p.vendorGain || 0),
        inversorGain: Number(p.inversorGain || 0),
      }));

      const payload: any = {
        type: clientType,
        branch,
        date: saleDate,
        createdAt: Timestamp.now(),
        itemsTotal: Number(totalAmount) || 0,
        total: Number(totalAmount) || 0,
        quantity: Number(totalUnitsSold) || 0, // UNIDADES totales
        packagesTotal: Number(totalPackages) || 0,
        items: itemsToSave,
        vendorId: vendorId ?? null,
      };

      const vendorObj = vendors.find((v) => v.id === vendorId);
      if (vendorObj) {
        payload.vendorName = vendorObj.name;
        payload.vendorBranch = vendorObj.branch;
        payload.vendorBranchLabel = vendorObj.branchLabel;
        payload.vendorCommissionPercent = vendorObj.commissionPercent || 0;
        payload.vendorCommissionAmount = vendorCommissionAmount || 0;
      }

      if (clientType === "CONTADO") {
        payload.customerName = customerNameCash.trim();
      } else {
        payload.customerId = customerId;
        payload.downPayment = Number(downPayment) || 0;
      }

      // 1) Crear venta (dulces)
      const saleRef = await addDoc(collection(db, "sales_candies"), payload);

      // ✅ Guardar cliente CONTADO en cash_customers
      if (clientType === "CONTADO") {
        const nameCash = (customerNameCash || "").trim();
        if (nameCash) {
          try {
            await addDoc(collection(db, "cash_customers"), {
              name: nameCash,
              date: saleDate,
              branch,
              vendorId,
              createdAt: Timestamp.now(),
            });
          } catch (e) {
            console.warn("No se pudo guardar cash_customer:", e);
          }
        }
      }

      // 2) CxC crédito
      if (clientType === "CREDITO" && customerId) {
        const base = {
          customerId,
          date: saleDate,
          createdAt: Timestamp.now(),
          ref: { saleId: saleRef.id },
        };
        await addDoc(collection(db, "ar_movements"), {
          ...base,
          type: "CARGO",
          amount: Number(totalAmount) || 0,
        });
        if (Number(downPayment) > 0) {
          await addDoc(collection(db, "ar_movements"), {
            ...base,
            type: "ABONO",
            amount: -Number(downPayment),
            vendorId,
            vendorName: vendorObj?.name || "",
          });
        }
        // Nota: no seteamos initialDebt aquí para evitar doble conteo con movimientos.
      }

      // 2.1) Abonos pendientes (se registran despues de crear la venta)
      const abonosToSave = pendingAbonos.filter(
        (a) => a.customerId && Number(a.amount || 0) > 0,
      );
      if (abonosToSave.length > 0) {
        const abonosEntries: any[] = [];
        for (const a of abonosToSave) {
          const entry: any = {
            amount: Number(a.amount || 0),
            date: a.date,
            customerId: a.customerId,
            customerName: a.customerName,
            createdAt: Timestamp.now(),
          };

          if (a.customerId) {
            const movRef = await addDoc(collection(db, "ar_movements"), {
              customerId: a.customerId,
              type: "ABONO",
              amount: -Number(a.amount || 0),
              date: a.date,
              createdAt: Timestamp.now(),
              ref: { saleId: saleRef.id },
              vendorId,
              vendorName: vendorObj?.name || "",
            });
            entry.movementId = movRef.id;
          }

          abonosEntries.push(entry);
        }

        const abonosTotal = round2(
          abonosEntries.reduce((acc, a) => acc + Number(a.amount || 0), 0),
        );
        const lastAbono = abonosEntries[abonosEntries.length - 1];

        await updateDoc(doc(db, "sales_candies", saleRef.id), {
          abonos: abonosEntries,
          abonosTotal,
          lastAbonoDate: lastAbono?.date || "",
          lastAbonoAmount: Number(lastAbono?.amount || 0),
          lastAbonoAt: Timestamp.now(),
        });
      }

      if (clientType === "CREDITO") {
        const customerIdsToSync = new Set<string>();
        if (customerId) customerIdsToSync.add(String(customerId));
        for (const a of abonosToSave) {
          if (a.customerId) customerIdsToSync.add(String(a.customerId));
        }
        for (const cid of customerIdsToSync) {
          try {
            await syncAbonoCommissionsForCustomer(cid);
          } catch (e) {
            console.warn("syncAbonoCommissionsForCustomer:", cid, e);
          }
        }
      }

      // 3) FIFO por producto, PERO AHORA SOBRE EL PEDIDO DEL VENDEDOR
      const allocationsByItem: Record<
        string,
        {
          productId: string;
          vendorId: string;
          allocations: {
            inventorySellerId: string;
            productId: string;
            units: number;
            saleDate: string;
            saleId: string;
          }[];
        }
      > = {};

      for (const it of itemsToSave) {
        if (it.qty > 0) {
          const { allocations } = await allocateSaleFIFOCandyFromVendor({
            productId: it.productId,
            vendorId,
            quantityUnits: it.qty,
            saleDate,
            saleId: saleRef.id,
          });
          allocationsByItem[it.productId] = {
            productId: it.productId,
            vendorId,
            allocations,
          };
        }
      }

      // 4) Guardar allocations en la venta de dulces
      await updateDoc(doc(db, "sales_candies", saleRef.id), {
        allocationsByItem,
      });

      // 5) Generar voucher PDF
      try {
        const customerLabel =
          clientType === "CONTADO"
            ? customerNameCash.trim() || "Cliente Mostrador"
            : selectedCustomer?.name || "Cliente crédito";

        generateCandyVoucherPDF({
          saleId: saleRef.id,
          date: saleDate,
          customerName: customerLabel,
          branch,
          items: itemsToSave.map((it) => ({
            productName: it.productName,
            qty: it.packages,
            unitPrice: it.unitPricePackage,
            total: it.total,
          })),
          total: Number(totalAmount) || 0,
          vendorName: vendorObj?.name,
          vendorCommissionPercent: vendorObj?.commissionPercent || 0,
          vendorCommissionAmount,
          abonos: pendingAbonos.map((a) => ({
            customerName: a.customerName,
            amount: Number(a.amount || 0),
          })),
          abonosTotal: abonoTotalPending,
          totalFinal: totalFinalWithAbonos,
        });
      } catch (e) {
        console.error("Error generando voucher PDF:", e);
      }

      // Reset
      setClientType("CONTADO");
      // branch se mantiene según el vendedor (no lo tocamos)
      setCustomerId("");
      setCustomerNameCash("");
      setSaleDate(todayLocalISO());
      setItems([]);
      setDownPayment(0);
      setPendingAbonos([]);
      setAbonoAmount(0);
      setAbonoDate(todayLocalISO());
      // mantenemos vendorId (útil cuando es vendedor logueado)

      const abonosByCustomer: Record<string, number> = {};
      for (const a of pendingAbonos) {
        if (!a.customerId) continue;
        abonosByCustomer[a.customerId] = round2(
          (abonosByCustomer[a.customerId] || 0) + Number(a.amount || 0),
        );
      }

      setCustomers((prev) =>
        prev.map((c) => {
          let delta = 0;
          if (clientType === "CREDITO" && customerId && c.id === customerId) {
            delta += (Number(totalAmount) || 0) - (Number(downPayment) || 0);
          }
          const abonoDelta = abonosByCustomer[c.id] || 0;
          delta -= abonoDelta;
          if (delta === 0) return c;
          return { ...c, balance: (c.balance || 0) + delta };
        }),
      );

      setMsg("✅ Venta de dulces registrada");

      // Actualizar mapa de stock tras la venta (inventario del vendedor)
      if (vendorId) {
        await reloadVendorStock(vendorId);
      } else {
        setStockByProduct({});
      }
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar la venta de dulces");
    } finally {
      setSaving(false);
    }
  };

  const addPendingAbono = () => {
    setMsg("");
    const amt = Number(abonoAmount || 0);
    if (!abonoCustomerId) {
      setMsg("Selecciona el cliente del abono.");
      return;
    }
    if (!(amt > 0)) {
      setMsg("Ingresa un monto de abono mayor a 0.");
      return;
    }
    if (amt > maxAbonoForCustomer) {
      setMsg("El abono no puede superar el saldo actual del cliente.");
      return;
    }
    if (!abonoDate) {
      setMsg("Selecciona la fecha del abono.");
      return;
    }

    const safeAmt = parseFloat(amt.toFixed(2));
    const newRow: PendingAbono = {
      id: String(Date.now()),
      date: abonoDate,
      amount: safeAmt,
      customerId: abonoCustomerId,
      customerName: selectedAbonoCustomer?.name || "",
    };

    setPendingAbonos((prev) => [...prev, newRow]);
    setAbonoCustomerId("");
    setAbonoAmount(0);
    setAbonoDate(todayLocalISO());
  };

  const removePendingAbono = (id: string) => {
    setPendingAbonos((prev) => prev.filter((a) => a.id !== id));
  };

  // ✅ AJUSTE: lista de productos MOSTRABLES en el selector:
  // - SOLO los que existan en stockByProduct (pedido del vendedor)
  // - SOLO los que tengan stock > 0
  const productsForVendorPicker = useMemo(() => {
    return products
      .filter((p) => {
        const units = stockByProduct[p.id] || 0;
        const upp = Math.max(1, Number(p.unitsPerPackage || 1));
        const packs = Math.floor(units / upp);
        return packs > 0;
      })
      .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  }, [products, stockByProduct]);

  const [productQuery, setProductQuery] = useState("");
  const filteredProductsForPicker = useMemo(() => {
    const q = String(productQuery || "")
      .trim()
      .toLowerCase();
    if (!q) return productsForVendorPicker;
    return productsForVendorPicker.filter((p) => {
      const hay = `${p.name || ""} ${p.sku || ""}`.toLowerCase();
      return hay.includes(q) || String(p.id || "").includes(q);
    });
  }, [productQuery, productsForVendorPicker]);

  /** Panel móvil tipo SalesV2: búsqueda + lista en sheet */
  const [mobileSheet, setMobileSheet] = useState<
    null | "vendor" | "product" | "creditCustomer" | "abonoClient"
  >(null);
  const [customerQuery, setCustomerQuery] = useState("");
  const [vendorQuery, setVendorQuery] = useState("");
  const [abonoCustomerQuery, setAbonoCustomerQuery] = useState("");

  const filteredVendorsMobile = useMemo(() => {
    const q = String(vendorQuery || "").trim().toLowerCase();
    if (!q) return activeVendors;
    return activeVendors.filter((v) =>
      `${v.name || ""} ${v.branchLabel || ""}`.toLowerCase().includes(q),
    );
  }, [activeVendors, vendorQuery]);

  const filteredCustomersCreditMobile = useMemo(() => {
    const q = String(customerQuery || "").trim().toLowerCase();
    if (!q) return customersForCredit;
    return customersForCredit.filter((c) =>
      `${c.name || ""}`.toLowerCase().includes(q),
    );
  }, [customersForCredit, customerQuery]);

  const filteredAbonoCustomersMobile = useMemo(() => {
    const q = String(abonoCustomerQuery || "").trim().toLowerCase();
    if (!q) return customersWithBalance;
    return customersWithBalance.filter((c) =>
      `${c.name || ""}`.toLowerCase().includes(q),
    );
  }, [customersWithBalance, abonoCustomerQuery]);

  const inpBase =
    "w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500 transition-colors";

  const selectButtonClass =
    "w-full border border-slate-200 rounded-lg px-3 py-2.5 text-sm text-left flex items-center justify-between gap-2 bg-white focus:outline-none focus:ring-2 focus:ring-blue-500/25 focus:border-blue-500";

  const clientTypeOptions = useMemo(
    () => [
      { value: "CONTADO", label: "Contado" },
      { value: "CREDITO", label: "Crédito" },
    ],
    [],
  );

  const creditCustomerSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un cliente" },
      ...customersForCredit.map((c) => ({
        value: c.id,
        label: `${c.name} | ${c.phone} | Saldo: ${money(c.balance || 0)}`,
        disabled: c.status === "BLOQUEADO",
      })),
    ],
    [customersForCredit],
  );

  const vendorSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un vendedor" },
      ...activeVendors.map((v) => ({
        value: v.id,
        label: `${v.name} — ${v.branchLabel} — ${v.commissionPercent.toFixed(2)}% comisión`,
      })),
    ],
    [activeVendors],
  );

  const productHtmlSelectOptions = useMemo(() => {
    const emptyLabel = vendorId
      ? "Selecciona un producto"
      : "Selecciona un vendedor primero";
    const opts: {
      value: string;
      label: string;
      disabled?: boolean;
    }[] = [{ value: "", label: emptyLabel }];
    for (const p of filteredProductsForPicker) {
      const already = items.some((it) => it.productId === p.id);
      const units = stockByProduct[p.id] || 0;
      const upp = Math.max(1, Number(p.unitsPerPackage || 1));
      const stockPackages = Math.floor(units / upp);
      if (stockPackages <= 0) continue;
      opts.push({
        value: p.id,
        label: `${p.name} ${p.sku ? `— ${p.sku}` : ""} (disp: ${stockPackages} paq.)${already ? " ✓" : ""}`,
        disabled: already,
      });
    }
    return opts;
  }, [filteredProductsForPicker, items, stockByProduct, vendorId]);

  const abonoCustomerSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un cliente" },
      ...customersWithBalance.map((c) => ({
        value: c.id,
        label: `${c.name} | Saldo: ${money(c.balance || 0)}`,
      })),
    ],
    [customersWithBalance],
  );

  const placeModalOptions = useMemo(
    () => [
      { value: "", label: "—" },
      ...PLACES.map((p) => ({ value: p, label: p })),
    ],
    [],
  );

  const statusModalOptions = useMemo(
    () => [
      { value: "ACTIVO", label: "ACTIVO" },
      { value: "BLOQUEADO", label: "BLOQUEADO" },
    ],
    [],
  );

  const modalVendorSelectOptions = useMemo(
    () => [
      { value: "", label: "Selecciona un vendedor" },
      ...vendors
        .filter((v) => (v.status ?? "ACTIVO") === "ACTIVO")
        .map((v) => ({
          value: v.id,
          label: `${v.name} — ${v.branchLabel}`,
        })),
    ],
    [vendors],
  );

  /** Sucursal del vendedor actual (precio por paquete en listas / líneas). */
  const vendorBranchForPrice =
    vendors.find((v) => v.id === vendorId)?.branch ?? branch;

  const mobileSheetTitle =
    mobileSheet === "vendor"
      ? "Vendedor"
      : mobileSheet === "product"
        ? "Productos"
        : mobileSheet === "creditCustomer"
          ? "Cliente (crédito)"
          : mobileSheet === "abonoClient"
            ? "Cliente para abono"
            : "";

  const mobilePickerSheet = (
    <BottomSheet
      open={!!mobileSheet}
      onClose={() => setMobileSheet(null)}
      title={mobileSheetTitle}
      ariaLabel={mobileSheetTitle || "Lista"}
      centerOnDesktop
    >
            {mobileSheet === "vendor" &&
              filteredVendorsMobile.map((v) => (
                <Button
                  key={v.id}
                  type="button"
                  variant="ghost"
                  className="w-full text-left px-3 py-3 border-b border-slate-100 active:bg-blue-50 rounded-none justify-start font-normal h-auto min-h-0"
                  onClick={() => {
                    setVendorId(v.id);
                    setItems([]);
                    setMobileSheet(null);
                  }}
                >
                  <div className="font-medium text-sm break-words">{v.name}</div>
                  <div className="text-xs text-slate-600 mt-1">
                    {v.branchLabel} · Comisión {v.commissionPercent.toFixed(2)}%
                  </div>
                </Button>
              ))}
            {mobileSheet === "vendor" && filteredVendorsMobile.length === 0 && (
              <div className="text-center text-gray-500 text-sm py-8 px-4">
                No hay vendedores con ese criterio.
              </div>
            )}
            {mobileSheet === "product" &&
              (filteredProductsForPicker.filter((p) => {
                const units = stockByProduct[p.id] || 0;
                const upp = Math.max(1, Number(p.unitsPerPackage || 1));
                return Math.floor(units / upp) > 0;
              }).length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8 px-4">
                  No hay productos con ese criterio o sin stock.
                </div>
              ) : (
                filteredProductsForPicker
                  .filter((p) => {
                    const units = stockByProduct[p.id] || 0;
                    const upp = Math.max(1, Number(p.unitsPerPackage || 1));
                    return Math.floor(units / upp) > 0;
                  })
                  .map((p) => {
                    const already = items.some((it) => it.productId === p.id);
                    const units = stockByProduct[p.id] || 0;
                    const upp = Math.max(1, Number(p.unitsPerPackage || 1));
                    const stockPackages = Math.floor(units / upp);
                    return (
                      <Button
                        key={p.id}
                        type="button"
                        variant="ghost"
                        disabled={already}
                        className="w-full text-left px-3 py-3 border-b border-slate-100 active:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed rounded-none justify-start font-normal h-auto min-h-0"
                        onClick={async () => {
                          if (already) return;
                          setProductId(p.id);
                          await addProductToList(p.id);
                          setMobileSheet(null);
                        }}
                      >
                        <div className="font-medium text-sm text-slate-900 break-words">
                          {p.name} {p.sku ? `— ${p.sku}` : ""}
                        </div>
                        <div className="text-xs text-slate-600 mt-1">
                          Existencias: {stockPackages} paquetes
                        </div>
                        <div className="text-xs text-slate-600 mt-1">
                          Precio:{" "}
                          {money(
                            salePricePerPackage(
                              p,
                              vendorBranchForPrice,
                              priceDocsById[p.id],
                            ),
                          )}{" "}
                          por paquete ({branchLabel(vendorBranchForPrice)})
                          {already ? " · Ya en lista" : ""}
                        </div>
                      </Button>
                    );
                  })
              ))}
            {mobileSheet === "creditCustomer" &&
              (filteredCustomersCreditMobile.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8 px-4">
                  No hay clientes con ese criterio.
                </div>
              ) : (
                filteredCustomersCreditMobile.map((c) => {
                  const blocked = c.status === "BLOQUEADO";
                  return (
                    <Button
                      key={c.id}
                      type="button"
                      variant="ghost"
                      disabled={blocked}
                      className="w-full text-left px-3 py-3 border-b border-slate-100 active:bg-blue-50 disabled:opacity-40 disabled:cursor-not-allowed rounded-none justify-start font-normal h-auto min-h-0"
                      onClick={() => {
                        if (blocked) return;
                        setCustomerId(c.id);
                        setMobileSheet(null);
                      }}
                    >
                      <div className="font-medium text-sm break-words">
                        {c.name}
                      </div>
                      <div className="text-xs text-slate-600 mt-1">
                        Saldo: {money(c.balance || 0)}
                        {blocked ? " · Bloqueado" : ""}
                      </div>
                    </Button>
                  );
                })
              ))}
            {mobileSheet === "abonoClient" &&
              (filteredAbonoCustomersMobile.length === 0 ? (
                <div className="text-center text-gray-500 text-sm py-8 px-4">
                  No hay clientes con saldo y ese criterio.
                </div>
              ) : (
                filteredAbonoCustomersMobile.map((c) => (
                  <Button
                    key={c.id}
                    type="button"
                    variant="ghost"
                    className="w-full text-left px-3 py-3 border-b border-slate-100 active:bg-blue-50 rounded-none justify-start font-normal h-auto min-h-0"
                    onClick={() => {
                      setAbonoCustomerId(c.id);
                      setMobileSheet(null);
                    }}
                  >
                    <div className="font-medium text-sm break-words">
                      {c.name}
                    </div>
                    <div className="text-xs text-slate-600 mt-1">
                      Saldo: {money(c.balance || 0)}
                    </div>
                  </Button>
                ))
              ))}
    </BottomSheet>
  );

  // UI
  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 mb-4 pb-4 border-b border-slate-100">
        <div>
          <h2 className="text-xl sm:text-2xl font-semibold text-slate-900 tracking-tight">
            Ventas
          </h2>
          <p className="text-sm text-slate-500 mt-1">
            Candies — registro de venta
          </p>
        </div>
        <Button
          type="button"
          variant="primary"
          className="hidden md:inline-flex rounded-lg !bg-green-600 hover:!bg-green-700 active:!bg-green-800 shadow-md shadow-green-600/15"
          onClick={() => setShowModal(true)}
        >
          Crear Cliente
        </Button>
      </div>

      <form
        onSubmit={saveSale}
        className="mb-6 w-full bg-white rounded-xl border border-slate-200/90 shadow-sm p-4 sm:p-6 md:p-8"
      >
        {/* ===================== WEB (NO CAMBIAR) ===================== */}
        <div className="hidden md:grid grid-cols-1 md:grid-cols-2 gap-4">
          {/* Tipo de cliente */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Tipo de cliente
            </label>
            <MobileHtmlSelect
              value={clientType}
              onChange={(v) => {
                const ct = v as ClientType;
                setClientType(ct);
                if (ct === "CONTADO") {
                  setCustomerId("");
                  setCustomerQuery("");
                }
              }}
              options={clientTypeOptions}
              selectClassName={`${inpBase} py-2.5 mt-1`}
              buttonClassName={`${selectButtonClass} mt-1`}
              sheetTitle="Tipo de cliente"
            />
          </div>

          {/* Cliente contado o crédito */}
          {clientType === "CONTADO" ? (
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Nombre del cliente (contado)
              </label>
              <input
                className={`${inpBase} mt-1`}
                placeholder="Ej: Cliente Mostrador"
                value={customerNameCash}
                onChange={(e) => setCustomerNameCash(e.target.value)}
              />
            </div>
          ) : (
            <div className="md:col-span-2">
              <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                Cliente (crédito)
              </label>

              <div className="flex flex-col sm:flex-row gap-2 mt-1">
                <div className="w-full sm:flex-1 min-w-0">
                  <MobileHtmlSelect
                    value={customerId}
                    onChange={setCustomerId}
                    options={creditCustomerSelectOptions}
                    selectClassName={`${inpBase} py-2.5`}
                    buttonClassName={selectButtonClass}
                    sheetTitle="Cliente (crédito)"
                  />
                </div>

                <Button
                  type="button"
                  variant="primary"
                  className="w-full sm:w-auto shrink-0 rounded-lg !bg-green-600 hover:!bg-green-700 active:!bg-green-800"
                  onClick={() => setShowModal(true)}
                >
                  Crear Cliente
                </Button>
              </div>

              <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-3">
                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo actual
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(currentBalance)}
                  </div>
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Pago inicial (opcional)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    max={maxDownPaymentAllowed}
                    className={`${inpBase} mt-1`}
                    value={downPayment === 0 ? "" : downPayment}
                    onChange={(e) => {
                      const v = clampDownPayment(e.target.value);
                      setDownPayment(v);
                    }}
                    placeholder="0.00"
                  />
                </div>

                <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                  <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                    Saldo proyectado
                  </div>
                  <div className="text-lg font-semibold tabular-nums text-slate-900 mt-0.5">
                    {money(projectedBalance)}
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Fecha */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Fecha de venta
            </label>
            <input
              type="date"
              className={`${inpBase} mt-1`}
              value={saleDate}
              onChange={(e) => setSaleDate(e.target.value)}
            />
          </div>

          {/* Vendedor */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Vendedor
            </label>
            <MobileHtmlSelect
              value={vendorId}
              onChange={(id) => {
                setVendorId(id);
                setItems([]);
              }}
              options={vendorSelectOptions}
              disabled={lockVendor}
              selectClassName={`${inpBase} py-2.5 mt-1`}
              buttonClassName={`${selectButtonClass} mt-1`}
              sheetTitle="Vendedor"
            />
            {lockVendor && (
              <p className="text-xs text-slate-500 mt-1">
                Vendedor fijado por el usuario logueado.
              </p>
            )}
          </div>

          {/* Lista de precios / sucursal */}
          <div className="md:col-span-1">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500 mb-1">
              Lista de precios / Sucursal
            </label>
            <div className="flex flex-wrap gap-4 text-sm">
              <label className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  className="accent-blue-600"
                  value="RIVAS"
                  checked={branch === "RIVAS"}
                  readOnly
                  disabled
                />
                <span>Rivas</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  className="accent-blue-600"
                  value="SAN_JORGE"
                  checked={branch === "SAN_JORGE"}
                  readOnly
                  disabled
                />
                <span>San Jorge</span>
              </label>
              <label className="inline-flex items-center gap-1">
                <input
                  type="radio"
                  className="accent-blue-600"
                  value="ISLA"
                  checked={branch === "ISLA"}
                  readOnly
                  disabled
                />
                <span>Isla de Ometepe</span>
              </label>
            </div>
            <div className="text-xs text-gray-500 mt-1">
              La sucursal se toma automáticamente del vendedor seleccionado.
            </div>
          </div>

          {/* Selector de producto */}
          <div className="md:col-span-2">
            <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
              Producto
            </label>
            <div className="mt-1 mb-2 flex gap-2">
              <input
                className={`${inpBase} flex-1 min-w-0 py-2`}
                placeholder={
                  vendorId
                    ? "Buscar producto por nombre o SKU"
                    : "Selecciona un vendedor primero"
                }
                value={productQuery}
                onChange={(e) => setProductQuery(e.target.value)}
                onClick={() => {
                  if (productQuery) setProductQuery("");
                }}
                disabled={!vendorId}
              />
              <Button
                type="button"
                variant="primary"
                className="shrink-0 rounded-lg !bg-slate-800 hover:!bg-slate-900 active:!bg-slate-950"
                onClick={() => setScanOpen(true)}
                disabled={!vendorId}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                >
                  <rect x="3" y="3" width="6" height="6" rx="1" />
                  <rect x="15" y="3" width="6" height="6" rx="1" />
                  <rect x="3" y="15" width="6" height="6" rx="1" />
                  <rect x="15" y="15" width="6" height="6" rx="1" />
                </svg>
              </Button>
            </div>
            <MobileHtmlSelect
              value={productId}
              onChange={async (pid) => {
                setProductId(pid);
                if (pid) await addProductToList(pid);
              }}
              options={productHtmlSelectOptions}
              disabled={!vendorId}
              selectClassName={`${inpBase} py-2.5`}
              buttonClassName={selectButtonClass}
              sheetTitle="Producto"
            />

            <div className="text-xs text-slate-500 mt-1">
              El selector solo muestra productos disponibles del pedido del
              vendedor seleccionado (sin ceros).
            </div>
          </div>

          {/* Lista de productos seleccionados */}
          <div className="md:col-span-2">
            <div className="w-full overflow-x-auto">
              <div className="border rounded overflow-hidden min-w-[860px]">
                <div className="grid grid-cols-12 bg-gray-50 px-3 py-2 text-xs font-semibold border-b">
                  <div className="col-span-4">Producto</div>
                  <div className="col-span-2 text-right">Precio (paq.)</div>
                  <div className="col-span-2 text-right">
                    Existencias (paq.)
                  </div>
                  <div className="col-span-1 text-right">Cantidad (paq.)</div>
                  <div className="col-span-1 text-right">Descuento</div>
                  <div className="col-span-1 text-right">Monto</div>
                  <div className="col-span-1 text-center">Quitar</div>
                </div>

                {items.length === 0 ? (
                  <div className="px-3 py-4 text-sm text-gray-500">
                    No hay productos agregados.
                  </div>
                ) : (
                  items.map((it) => {
                    const currentUnits =
                      stockByProduct[it.productId] ?? it.availableUnits ?? 0;
                    const packagesAvailable = it.unitsPerPackage
                      ? Math.floor(currentUnits / it.unitsPerPackage)
                      : 0;

                    const visualStock = Math.max(
                      0,
                      packagesAvailable - (it.qtyPackages || 0),
                    );

                    const lineGross =
                      (Number(it.pricePerPackage) || 0) * (it.qtyPackages || 0);
                    const lineNet = Math.max(
                      0,
                      lineGross - (Number(it.discount) || 0),
                    );

                    return (
                      <div
                        key={it.productId}
                        className="grid grid-cols-12 items-center px-3 py-2 border-b text-sm gap-x-2"
                      >
                        <div className="col-span-4">
                          <div className="font-medium">
                            {it.productName}
                            {it.sku ? ` — ${it.sku}` : ""}
                          </div>
                        </div>

                        <div className="col-span-2 text-right">
                          {money(it.pricePerPackage)}
                        </div>
                        <div className="col-span-2 text-right">
                          {visualStock} paq.
                        </div>

                        <div className="col-span-1">
                          <input
                            type="number"
                            step="0"
                            min={0}
                            className="w-full border p-1 rounded text-right"
                            value={
                              Number.isNaN(it.qtyPackages) ||
                              it.qtyPackages === 0
                                ? ""
                                : it.qtyPackages
                            }
                            onChange={(e) =>
                              setItemQty(it.productId, e.target.value)
                            }
                            inputMode="numeric"
                            placeholder="0"
                          />
                        </div>

                        <div className="col-span-1">
                          <input
                            type="number"
                            step="1"
                            min={0}
                            className="w-full border p-1 rounded text-right"
                            value={
                              Number.isNaN(it.discount) || it.discount === 0
                                ? ""
                                : it.discount
                            }
                            onChange={(e) =>
                              setItemDiscount(it.productId, e.target.value)
                            }
                            inputMode="numeric"
                            placeholder="0"
                          />
                        </div>

                        <div className="col-span-1 text-right">
                          {money(lineNet)}
                        </div>

                        <div className="col-span-1 text-center">
                          <Button
                            type="button"
                            variant="danger"
                            size="sm"
                            className="rounded-md !bg-red-100 !text-red-800 hover:!bg-red-200 active:!bg-red-300 shadow-none"
                            onClick={() => removeItem(it.productId)}
                            title="Quitar producto"
                          >
                            ✕
                          </Button>
                        </div>
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            {items.length > 0 && (
              <div className="grid grid-cols-2 md:grid-cols-5 gap-2 mt-3 text-sm">
                <div className="p-2 rounded bg-blue-50 border border-blue-200">
                  <div className="text-xs text-gray-600">Paquetes totales</div>
                  <div className="font-semibold">{totalPackages}</div>
                </div>
                <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                  <div className="text-xs text-gray-600">Total venta</div>
                  <div className="font-semibold">{money(totalAmount)}</div>
                </div>
                <div className="p-2 rounded bg-amber-50 border border-amber-200">
                  <div className="text-xs text-gray-600">Comisión vendedor</div>
                  <div className="font-semibold">
                    {money(vendorCommissionAmount)}{" "}
                    {vendorCommissionPercent
                      ? `(${vendorCommissionPercent.toFixed(2)}%)`
                      : ""}
                  </div>
                </div>
                <div className="p-2 rounded bg-indigo-50 border border-indigo-200">
                  <div className="text-xs text-gray-600">Total abonos</div>
                  <div className="font-semibold">
                    {money(abonoTotalPending)}
                  </div>
                </div>
                <div className="p-2 rounded bg-teal-50 border border-teal-200">
                  <div className="text-xs text-gray-600">Total final</div>
                  <div className="font-semibold">
                    {money(totalFinalWithAbonos)}
                  </div>
                </div>
              </div>
            )}

            <div className="mt-4 border rounded-lg p-3 bg-gray-50">
              <Button
                type="button"
                variant="ghost"
                onClick={() => setOpenAbonos((v) => !v)}
                className="w-full flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 text-left rounded-lg h-auto min-h-0 py-3 font-normal"
              >
                <div className="font-semibold">
                  Abonos (se registran al guardar)
                </div>
                <div className="text-xs text-gray-600">
                  Agregado: {money(abonoTotalPending)}
                  <span className="ml-2 text-sm">{openAbonos ? "−" : "+"}</span>
                </div>
              </Button>

              {openAbonos && (
                <>
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-2 mt-3">
                    <div className="md:col-span-2">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Cliente
                      </label>
                      <MobileHtmlSelect
                        value={abonoCustomerId}
                        onChange={setAbonoCustomerId}
                        options={abonoCustomerSelectOptions}
                        selectClassName={`${inpBase} py-2.5 mt-1`}
                        buttonClassName={`${selectButtonClass} mt-1`}
                        sheetTitle="Cliente para abono"
                      />
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Abono
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        max={maxAbonoForCustomer}
                        className={`${inpBase} mt-1`}
                        value={abonoAmount === 0 ? "" : abonoAmount}
                        onChange={(e) =>
                          setAbonoAmount(clampAbonoAmount(e.target.value))
                        }
                        placeholder="0.00"
                        disabled={!abonoCustomerId}
                      />
                    </div>
                  </div>

                  <div className="mt-2 grid grid-cols-1 md:grid-cols-3 gap-2 text-sm">
                    <div className="p-2 rounded bg-white border">
                      <div className="text-xs text-gray-600">Saldo actual</div>
                      <div className="font-semibold">
                        {money(abonoCustomerBalance)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-white border">
                      <div className="text-xs text-gray-600">Abono</div>
                      <div className="font-semibold">
                        {money(abonoPreviewAmount)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-white border">
                      <div className="text-xs text-gray-600">Saldo final</div>
                      <div className="font-semibold">
                        {money(abonoSaldoFinal)}
                      </div>
                    </div>
                  </div>

                  <div className="mt-3 flex justify-end">
                    <Button
                      type="button"
                      variant="primary"
                      className={`rounded-lg ${
                        abonoDisabled
                          ? "!bg-gray-300 !text-gray-600"
                          : "!bg-amber-600 hover:!bg-amber-700 active:!bg-amber-800"
                      }`}
                      onClick={addPendingAbono}
                      disabled={abonoDisabled}
                    >
                      Agregar abono
                    </Button>
                  </div>

                  <div className="mt-3">
                    <div className="w-full overflow-x-auto">
                      <div className="border rounded overflow-hidden min-w-[560px] bg-white">
                        <div className="grid grid-cols-12 bg-gray-100 px-3 py-2 text-xs font-semibold border-b">
                          <div className="col-span-3">Cliente</div>
                          <div className="col-span-1">Fecha</div>
                          <div className="col-span-2 text-right">Saldo</div>
                          <div className="col-span-2 text-right">Abono</div>
                          <div className="col-span-3 text-right">
                            Saldo Pendiente
                          </div>
                          <div className="col-span-1 text-center">Quitar</div>
                        </div>
                        {pendingAbonos.length === 0 ? (
                          <div className="px-3 py-4 text-sm text-gray-500">
                            Sin abonos agregados.
                          </div>
                        ) : (
                          (() => {
                            const running: Record<string, number> = {};
                            return pendingAbonos.map((a) => {
                              const base =
                                customerBalanceById[a.customerId] || 0;
                              const next =
                                (running[a.customerId] || 0) +
                                Number(a.amount || 0);
                              running[a.customerId] = next;
                              const saldoPend = round2(
                                Math.max(0, base - next),
                              );
                              return (
                                <div
                                  key={a.id}
                                  className="grid grid-cols-12 items-center px-3 py-2 border-b text-sm gap-x-2"
                                >
                                  <div className="col-span-3">
                                    {a.customerName || "—"}
                                  </div>
                                  <div className="col-span-1">{a.date}</div>
                                  <div className="col-span-2 text-right">
                                    {money(base)}
                                  </div>
                                  <div className="col-span-2 text-right">
                                    {money(a.amount)}
                                  </div>
                                  <div className="col-span-3 text-right">
                                    {money(saldoPend)}
                                  </div>
                                  <div className="col-span-1 text-center">
                                    <Button
                                      type="button"
                                      variant="danger"
                                      size="sm"
                                      className="rounded-md !bg-red-100 !text-red-800 hover:!bg-red-200 active:!bg-red-300 shadow-none"
                                      onClick={() => removePendingAbono(a.id)}
                                      title="Quitar abono"
                                    >
                                      ✕
                                    </Button>
                                  </div>
                                </div>
                              );
                            });
                          })()
                        )}
                      </div>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Guardar WEB */}
          <div className="md:col-span-2">
            <Button
              type="submit"
              variant="primary"
              className="w-full sm:w-auto rounded-lg"
              disabled={saving}
            >
              {saving ? "Guardando..." : "Registrar venta"}
            </Button>
          </div>
        </div>

        {/* ===================== MOBILE (SOLO MOBILE) ===================== */}
        <div className="md:hidden space-y-3">
          {/* CARD 1: Datos de venta */}
          <div className="bg-white rounded-xl border shadow">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpenSaleInfo((v) => !v)}
              className="w-full flex justify-between items-center p-3 font-semibold rounded-none rounded-t-xl h-auto min-h-0"
            >
              Datos de venta
              <span className="text-lg">{openSaleInfo ? "−" : "+"}</span>
            </Button>

            {openSaleInfo && (
              <div className="p-3 space-y-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Fecha de venta
                  </label>
                  <input
                    type="date"
                    className={`${inpBase} mt-1`}
                    value={saleDate}
                    onChange={(e) => setSaleDate(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Tipo de cliente
                  </label>
                  <MobileHtmlSelect
                    value={clientType}
                    onChange={(v) => {
                      const ct = v as ClientType;
                      setClientType(ct);
                      if (ct === "CONTADO") {
                        setCustomerId("");
                        setCustomerQuery("");
                      }
                    }}
                    options={clientTypeOptions}
                    selectClassName={`${inpBase} py-2.5 mt-1`}
                    buttonClassName={`${selectButtonClass} mt-1`}
                    sheetTitle="Tipo de cliente"
                  />
                </div>

                {clientType === "CONTADO" ? (
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Cliente (contado)
                    </label>
                    <input
                      className={`${inpBase} mt-1`}
                      placeholder="Ej: Mario Bergoglio"
                      value={customerNameCash}
                      onChange={(e) => setCustomerNameCash(e.target.value)}
                    />
                  </div>
                ) : (
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                      Cliente (crédito)
                    </label>

                    <div className="flex flex-col gap-2 mt-1">
                      <div className="flex gap-1 items-center min-w-0">
                        <input
                          className={`${inpBase} flex-1 min-w-0 py-2`}
                          placeholder="Buscar cliente..."
                          value={customerQuery}
                          onChange={(e) =>
                            setCustomerQuery(e.target.value)
                          }
                          onClick={() => {
                            if (customerQuery) setCustomerQuery("");
                          }}
                        />
                        {customerQuery ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="shrink-0 px-2 py-2 text-sm font-medium text-blue-600 rounded-lg h-auto min-h-0 shadow-none"
                            onClick={() => setCustomerQuery("")}
                          >
                            Limpiar
                          </Button>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={`${selectButtonClass} border-slate-200 rounded-xl justify-between font-normal h-auto min-h-0 py-2.5`}
                        onClick={() => setMobileSheet("creditCustomer")}
                      >
                        <span className="truncate text-sm">
                          {customerId
                            ? selectedCustomer?.name ||
                              "Cliente seleccionado"
                            : "Elegir cliente"}
                        </span>
                        <span className="text-slate-400 shrink-0">▼</span>
                      </Button>

                      <Button
                        type="button"
                        variant="primary"
                        className="w-full rounded-lg !bg-green-600 hover:!bg-green-700 active:!bg-green-800"
                        onClick={() => setShowModal(true)}
                      >
                        Crear Cliente
                      </Button>
                    </div>

                    <div className="mt-2 grid grid-cols-2 gap-2">
                      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                        <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                          Saldo actual
                        </div>
                        <div className="text-base font-semibold tabular-nums text-slate-900 mt-0.5">
                          {money(currentBalance)}
                        </div>
                      </div>
                      <div className="p-3 rounded-lg border border-slate-200 bg-slate-50/60">
                        <div className="text-[11px] font-medium text-slate-500 uppercase tracking-wide">
                          Saldo proyectado
                        </div>
                        <div className="text-base font-semibold tabular-nums text-slate-900 mt-0.5">
                          {money(projectedBalance)}
                        </div>
                      </div>
                    </div>

                    <div className="mt-2">
                      <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                        Pago inicial (opcional)
                      </label>
                      <input
                        type="number"
                        step="0.01"
                        inputMode="decimal"
                        max={maxDownPaymentAllowed}
                        className={`${inpBase} mt-1`}
                        value={downPayment === 0 ? "" : downPayment}
                        onChange={(e) => {
                          const v = clampDownPayment(e.target.value);
                          setDownPayment(v);
                        }}
                        placeholder="0.00"
                      />
                    </div>
                  </div>
                )}

                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Vendedor
                  </label>
                  {lockVendor ? (
                    <>
                      <div className={`${inpBase} mt-1 bg-slate-50 text-slate-800`}>
                        {(() => {
                          const v = activeVendors.find(
                            (x) => x.id === vendorId,
                          );
                          return v
                            ? `${v.name} — ${v.commissionPercent.toFixed(2)}%`
                            : "—";
                        })()}
                      </div>
                      <p className="text-xs text-slate-500 mt-1">
                        Vendedor Logueado en esta app.
                      </p>
                    </>
                  ) : (
                    <>
                      <div className="mt-1 flex gap-1 items-center min-w-0">
                        <input
                          className={`${inpBase} flex-1 min-w-0 py-2`}
                          placeholder="Buscar vendedor..."
                          value={vendorQuery}
                          onChange={(e) =>
                            setVendorQuery(e.target.value)
                          }
                          onClick={() => {
                            if (vendorQuery) setVendorQuery("");
                          }}
                        />
                        {vendorQuery ? (
                          <Button
                            type="button"
                            variant="ghost"
                            className="shrink-0 px-2 py-2 text-sm font-medium text-blue-600 rounded-lg h-auto min-h-0 shadow-none"
                            onClick={() => setVendorQuery("")}
                          >
                            Limpiar
                          </Button>
                        ) : null}
                      </div>
                      <Button
                        type="button"
                        variant="outline"
                        className={`${selectButtonClass} mt-2 border-slate-200 rounded-xl justify-between font-normal h-auto min-h-0 py-2.5`}
                        onClick={() => setMobileSheet("vendor")}
                      >
                        <span className="truncate text-sm">
                          {vendorId
                            ? (() => {
                                const v = activeVendors.find(
                                  (x) => x.id === vendorId,
                                );
                                return v
                                  ? `${v.name} — ${v.commissionPercent.toFixed(2)}%`
                                  : "Vendedor";
                              })()
                            : "Elegir vendedor"}
                        </span>
                        <span className="text-slate-400 shrink-0">▼</span>
                      </Button>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* CARD 2: Productos */}
          <div className="bg-white rounded-xl border shadow">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpenItems((v) => !v)}
              className="w-full flex justify-between items-center p-3 font-semibold rounded-none rounded-t-xl h-auto min-h-0"
            >
              Agrega Productos
              <span className="text-lg">{openItems ? "−" : "+"}</span>
            </Button>

            {openItems && (
              <div className="p-3 space-y-3">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Productos
                  </label>
                  <div className="mt-1 mb-2 flex gap-2 items-center min-w-0">
                    <input
                      className={`${inpBase} flex-1 min-w-0 py-2`}
                      placeholder={
                        vendorId
                          ? "Buscar producto por nombre o SKU"
                          : "Selecciona un vendedor primero"
                      }
                      value={productQuery}
                      onChange={(e) => setProductQuery(e.target.value)}
                      onClick={() => {
                        if (productQuery) setProductQuery("");
                      }}
                      disabled={!vendorId}
                    />
                    {productQuery ? (
                      <Button
                        type="button"
                        variant="ghost"
                        className="shrink-0 px-2 py-2 text-sm font-medium text-blue-600 rounded-lg h-auto min-h-0 shadow-none"
                        onClick={() => setProductQuery("")}
                      >
                        Limpiar
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="primary"
                      className="shrink-0 rounded-lg !bg-slate-800 hover:!bg-slate-900 active:!bg-slate-950"
                      onClick={() => setScanOpen(true)}
                      disabled={!vendorId}
                    >
                      <svg
                        xmlns="http://www.w3.org/2000/svg"
                        className="h-5 w-5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                      >
                        <rect x="3" y="3" width="6" height="6" rx="1" />
                        <rect x="15" y="3" width="6" height="6" rx="1" />
                        <rect x="3" y="15" width="6" height="6" rx="1" />
                        <rect x="15" y="15" width="6" height="6" rx="1" />
                      </svg>
                    </Button>
                  </div>
                  <Button
                    type="button"
                    variant="outline"
                    className={`${selectButtonClass} border-slate-200 rounded-xl justify-between font-normal h-auto min-h-0 py-2.5`}
                    disabled={!vendorId}
                    onClick={() => setMobileSheet("product")}
                  >
                    <span className="truncate text-sm text-slate-600">
                      {vendorId
                        ? "Elegir producto (lista)"
                        : "Selecciona un vendedor primero"}
                    </span>
                    <span className="text-slate-400 shrink-0">▼</span>
                  </Button>
                </div>

                {items.length === 0 ? (
                  <div className="text-sm text-gray-500">
                    No hay productos agregados.
                  </div>
                ) : (
                  <div className="space-y-2">
                    {items.map((it) => {
                      const currentUnits =
                        stockByProduct[it.productId] ?? it.availableUnits ?? 0;

                      const packagesAvailable = it.unitsPerPackage
                        ? Math.floor(currentUnits / it.unitsPerPackage)
                        : 0;

                      const visualStock = Math.max(
                        0,
                        packagesAvailable - (it.qtyPackages || 0),
                      );

                      const lineGross =
                        (Number(it.pricePerPackage) || 0) *
                        (it.qtyPackages || 0);

                      const lineNet = Math.max(
                        0,
                        lineGross - (Number(it.discount) || 0),
                      );

                      return (
                        <div
                          key={it.productId}
                          className="border rounded-xl p-3 bg-gray-50 space-y-2"
                        >
                          <div className="font-semibold leading-tight">
                            {it.productName}
                            {it.sku ? ` — ${it.sku}` : ""}
                          </div>

                          <div className="grid grid-cols-2 gap-2 text-sm">
                            <div className="p-2 rounded border bg-white">
                              <div className="text-xs text-gray-600">
                                Precio x Paquete
                              </div>
                              <div className="font-bold">
                                {money(it.pricePerPackage)}
                              </div>
                            </div>
                            <div className="p-2 rounded border bg-white">
                              <div className="text-xs text-gray-600">
                                Existencias
                              </div>
                              <div className="font-bold">
                                {visualStock} paq.
                              </div>
                            </div>
                          </div>

                          <div className="grid grid-cols-2 gap-2">
                            <div>
                              <label className="block text-xs text-gray-600">
                                Cantidad Paquetes
                              </label>
                              <input
                                type="number"
                                step="0"
                                min={0}
                                className="w-full border p-2 rounded text-right"
                                value={
                                  Number.isNaN(it.qtyPackages) ||
                                  it.qtyPackages === 0
                                    ? ""
                                    : it.qtyPackages
                                }
                                onChange={(e) =>
                                  setItemQty(it.productId, e.target.value)
                                }
                                inputMode="numeric"
                                placeholder="0"
                              />
                            </div>

                            <div>
                              <label className="block text-xs text-gray-600">
                                Descuento
                              </label>
                              <input
                                type="number"
                                step="1"
                                min={0}
                                className="w-full border p-2 rounded text-right"
                                value={
                                  Number.isNaN(it.discount) || it.discount === 0
                                    ? ""
                                    : it.discount
                                }
                                onChange={(e) =>
                                  setItemDiscount(it.productId, e.target.value)
                                }
                                inputMode="numeric"
                                placeholder="0"
                              />
                            </div>
                          </div>

                          <div className="flex items-center justify-end">
                            <Button
                              type="button"
                              variant="danger"
                              className="rounded-lg !bg-red-100 !text-red-800 hover:!bg-red-200 active:!bg-red-300 shadow-none"
                              onClick={() => removeItem(it.productId)}
                            >
                              Quitar
                            </Button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {items.length > 0 && (
                  <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                    <div className="p-2 rounded bg-blue-50 border border-blue-200">
                      <div className="text-xs text-gray-600">Paquetes</div>
                      <div className="font-semibold">{totalPackages}</div>
                    </div>
                    <div className="p-2 rounded bg-emerald-50 border border-emerald-200">
                      <div className="text-xs text-gray-600">Monto</div>
                      <div className="font-semibold">{money(totalAmount)}</div>
                    </div>
                    <div className="p-2 rounded bg-amber-50 border border-amber-200">
                      <div className="text-xs text-gray-600">Comisión</div>
                      <div className="font-semibold">
                        {money(vendorCommissionAmount)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-indigo-50 border border-indigo-200">
                      <div className="text-xs text-gray-600">Abonos</div>
                      <div className="font-semibold">
                        {money(abonoTotalPending)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-teal-50 border border-teal-200">
                      <div className="text-xs text-gray-600">
                        Total Ventas + Abonos
                      </div>
                      <div className="font-semibold">
                        {money(totalFinalWithAbonos)}
                      </div>
                    </div>
                  </div>
                )}

                <div className="mt-3 border rounded-xl p-3 bg-white">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setOpenAbonos((v) => !v)}
                    className="w-full flex items-center justify-between font-semibold rounded-lg h-auto min-h-0 py-2"
                  >
                    <span>Abonos</span>
                    <span className="text-lg">{openAbonos ? "−" : "+"}</span>
                  </Button>

                  {openAbonos && (
                    <>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-sm">
                        <div className="col-span-2">
                          <label className="block text-xs text-gray-600">
                            Cliente
                          </label>
                          <div className="mt-1 flex gap-1 items-center min-w-0">
                            <input
                              className="flex-1 border p-2 rounded min-w-0 text-sm"
                              placeholder="Buscar cliente..."
                              value={abonoCustomerQuery}
                              onChange={(e) =>
                                setAbonoCustomerQuery(e.target.value)
                              }
                              onClick={() => {
                                if (abonoCustomerQuery)
                                  setAbonoCustomerQuery("");
                              }}
                            />
                            {abonoCustomerQuery ? (
                              <Button
                                type="button"
                                variant="ghost"
                                className="shrink-0 px-2 py-2 text-sm text-blue-600 rounded-lg h-auto min-h-0 shadow-none"
                                onClick={() => setAbonoCustomerQuery("")}
                              >
                                Limpiar
                              </Button>
                            ) : null}
                          </div>
                          <Button
                            type="button"
                            variant="outline"
                            className="mt-2 w-full border p-2 rounded-xl text-left bg-white flex justify-between items-center gap-2 min-w-0 font-normal h-auto min-h-0"
                            onClick={() => setMobileSheet("abonoClient")}
                          >
                            <span className="truncate text-sm">
                              {abonoCustomerId
                                ? selectedAbonoCustomer?.name ||
                                  "Cliente"
                                : "Elegir cliente"}
                            </span>
                            <span className="text-slate-400 shrink-0">▼</span>
                          </Button>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-600">
                            Abono
                          </label>
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            max={maxAbonoForCustomer}
                            className="w-full border p-2 rounded"
                            value={abonoAmount === 0 ? "" : abonoAmount}
                            onChange={(e) =>
                              setAbonoAmount(clampAbonoAmount(e.target.value))
                            }
                            placeholder="0.00"
                            disabled={!abonoCustomerId}
                          />
                        </div>
                      </div>

                      <div className="mt-2 grid grid-cols-1 sm:grid-cols-3 gap-2 text-sm">
                        <div className="p-2 rounded bg-gray-50 border">
                          <div className="text-xs text-gray-600">
                            Saldo actual
                          </div>
                          <div className="font-semibold">
                            {money(abonoCustomerBalance)}
                          </div>
                        </div>
                        <div className="p-2 rounded bg-gray-50 border">
                          <div className="text-xs text-gray-600">Abono</div>
                          <div className="font-semibold">
                            {money(abonoPreviewAmount)}
                          </div>
                        </div>
                        <div className="p-2 rounded bg-gray-50 border">
                          <div className="text-xs text-gray-600">
                            Saldo final
                          </div>
                          <div className="font-semibold">
                            {money(abonoSaldoFinal)}
                          </div>
                        </div>
                      </div>

                      <div className="mt-2 flex justify-end">
                        <Button
                          type="button"
                          variant="primary"
                          className={`rounded-lg ${
                            abonoDisabled
                              ? "!bg-gray-300 !text-gray-600"
                              : "!bg-amber-600 hover:!bg-amber-700 active:!bg-amber-800"
                          }`}
                          onClick={addPendingAbono}
                          disabled={abonoDisabled}
                        >
                          Agregar abono
                        </Button>
                      </div>

                      <div className="mt-3 space-y-2">
                        {pendingAbonos.length === 0 ? (
                          <div className="text-xs text-gray-500">
                            Sin abonos agregados.
                          </div>
                        ) : (
                          (() => {
                            const running: Record<string, number> = {};
                            return pendingAbonos.map((a) => {
                              const base =
                                customerBalanceById[a.customerId] || 0;
                              const next =
                                (running[a.customerId] || 0) +
                                Number(a.amount || 0);
                              running[a.customerId] = next;
                              const saldoPend = round2(
                                Math.max(0, base - next),
                              );
                              return (
                                <div
                                  key={a.id}
                                  className="border rounded-lg p-2 bg-gray-50 text-sm"
                                >
                                  <div className="space-y-1">
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">
                                        Cliente
                                      </span>
                                      <strong className="text-right">
                                        {a.customerName || "—"}
                                      </strong>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">
                                        Fecha
                                      </span>
                                      <strong className="text-right">
                                        {a.date}
                                      </strong>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">
                                        Saldo
                                      </span>
                                      <strong className="text-right">
                                        {money(base)}
                                      </strong>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">
                                        Abono
                                      </span>
                                      <strong className="text-right">
                                        {money(a.amount)}
                                      </strong>
                                    </div>
                                    <div className="flex justify-between">
                                      <span className="text-slate-600">
                                        Saldo Pendiente
                                      </span>
                                      <strong className="text-right">
                                        {money(saldoPend)}
                                      </strong>
                                    </div>
                                  </div>
                                  <div className="mt-2 text-right">
                                    <Button
                                      type="button"
                                      variant="danger"
                                      size="sm"
                                      className="rounded-md !bg-red-100 !text-red-800 hover:!bg-red-200 shadow-none"
                                      onClick={() => removePendingAbono(a.id)}
                                    >
                                      Quitar
                                    </Button>
                                  </div>
                                </div>
                              );
                            });
                          })()
                        )}
                      </div>
                    </>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* Guardar MOBILE */}
          <Button
            type="submit"
            variant="primary"
            className="w-full rounded-xl py-3"
            disabled={saving}
          >
            {saving ? "Guardando..." : "Registrar venta"}
          </Button>
        </div>
      </form>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal: Crear cliente rápido */}
      {showModal && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-lg shadow-xl border w-[98%] sm:w-[95%] max-w-xl p-3 sm:p-4 max-h-[92vh] overflow-auto">
            <h3 className="text-lg font-bold mb-3">Nuevo cliente</h3>

            {/* (tu modal sigue EXACTO como lo tenías, no lo toqué) */}

            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Nombre
                </label>
                <input
                  className={`${inpBase} mt-1`}
                  value={mName}
                  onChange={(e) => setMName(e.target.value)}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Teléfono
                </label>
                <input
                  className={`${inpBase} mt-1`}
                  value={mPhone}
                  onChange={(e) => setMPhone(normalizePhone(e.target.value))}
                  placeholder="+505 88888888"
                  inputMode="numeric"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Lugar
                </label>
                <MobileHtmlSelect
                  value={mPlace}
                  onChange={(v) => setMPlace(v as Place | "")}
                  options={placeModalOptions}
                  selectClassName={`${inpBase} py-2.5 mt-1`}
                  buttonClassName={`${selectButtonClass} mt-1`}
                  sheetTitle="Lugar"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Estado
                </label>
                <MobileHtmlSelect
                  value={mStatus}
                  onChange={(v) => setMStatus(v as Status)}
                  options={statusModalOptions}
                  selectClassName={`${inpBase} py-2.5 mt-1`}
                  buttonClassName={`${selectButtonClass} mt-1`}
                  sheetTitle="Estado"
                />
              </div>
              {!lockVendor && (
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                    Vendedor
                  </label>
                  <MobileHtmlSelect
                    value={mSellerId}
                    onChange={setMSellerId}
                    options={modalVendorSelectOptions}
                    selectClassName={`${inpBase} py-2.5 mt-1`}
                    buttonClassName={`${selectButtonClass} mt-1`}
                    sheetTitle="Vendedor"
                  />
                </div>
              )}

              {/* <div>
                <label className="block text-sm font-semibold">
                  Límite de crédito (opcional)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border p-2 rounded"
                  value={mCreditLimit === 0 ? "" : mCreditLimit}
                  onChange={(e) =>
                    setMCreditLimit(Math.max(0, Number(e.target.value || 0)))
                  }
                  placeholder="Ej: 2000"
                />
              </div> */}
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold uppercase tracking-wide text-slate-500">
                  Comentario
                </label>
                <textarea
                  className={`${inpBase} mt-1 resize-y min-h-20`}
                  value={mNotes}
                  onChange={(e) => setMNotes(e.target.value)}
                  maxLength={500}
                />
              </div>
            </div>

            <div className="mt-4 flex flex-col sm:flex-row justify-end gap-2">
              <Button
                variant="secondary"
                className="w-full sm:w-auto rounded-lg"
                onClick={() => {
                  resetModal();
                  setShowModal(false);
                }}
              >
                Cancelar
              </Button>
              <Button
                variant="primary"
                className="w-full sm:w-auto rounded-lg !bg-green-600 hover:!bg-green-700 active:!bg-green-800"
                onClick={async () => {
                  const sellerIdToSave = lockVendor
                    ? vendorId || sellerCandyId
                    : mSellerId;

                  if (!sellerIdToSave) {
                    setMsg("Selecciona el vendedor para asociar este cliente.");
                    return;
                  }

                  setMsg("");
                  if (!mName.trim()) {
                    setMsg("Ingresa el nombre del nuevo cliente.");
                    return;
                  }

                  const cleanPhone = normalizePhone(mPhone);

                  try {
                    const ref = await addDoc(
                      collection(db, "customers_candies"),
                      {
                        name: mName.trim(),
                        phone: cleanPhone,
                        place: mPlace || "",
                        notes: mNotes || "",
                        status: mStatus,
                        creditLimit: Number(mCreditLimit || 0),
                        createdAt: Timestamp.now(),
                        sellerId: sellerIdToSave,
                        vendorId: sellerIdToSave,
                        vendorName:
                          vendors.find((v) => v.id === sellerIdToSave)?.name ||
                          "",
                      },
                    );
                    const newC: Customer = {
                      id: ref.id,
                      name: mName.trim(),
                      phone: cleanPhone,
                      place: mPlace || "",
                      status: mStatus,
                      creditLimit: Number(mCreditLimit || 0),
                      balance: 0,
                      sellerId: sellerIdToSave,
                    };
                    setCustomers((prev) => [newC, ...prev]);
                    setCustomerId(ref.id);
                    resetModal();
                    setShowModal(false);
                    setMsg("✅ Cliente creado");
                  } catch (e) {
                    console.error(e);
                    setMsg("❌ Error al crear cliente");
                  }
                }}
              >
                Guardar cliente
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Scanner modal */}
      <BarcodeScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onDetected={onDetectedFromScanner}
      />

      {/* Modal: Campos faltantes (errores de validación de vendor fields) */}
      {missingFieldsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-2 sm:p-4">
          <div className="bg-white rounded-lg shadow-xl border w-[90%] max-w-md p-4">
            <h3 className="text-lg font-bold mb-2">Campos faltantes</h3>
            <p className="text-sm text-gray-700 mb-3">
              No se puede guardar la venta porque faltan campos requeridos en la
              orden del vendedor:
            </p>
            <ul className="list-disc list-inside text-sm text-red-600 mb-4">
              {missingFieldsList.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
            <div className="flex justify-end gap-2">
              <Button
                variant="secondary"
                className="rounded-lg"
                onClick={() => {
                  setMissingFieldsModalOpen(false);
                }}
              >
                Cerrar
              </Button>
            </div>
          </div>
        </div>
      )}

      {/* Overlay de guardado (reutiliza LoadingOverlay global) */}
      {saving && <LoadingOverlay message={"Guardando venta..."} />}

      {mobilePickerSheet}
    </div>
  );
}
