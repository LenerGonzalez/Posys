// src/components/Candies/PrecioVentas.tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import {
  collection,
  getDocs,
  query,
  updateDoc,
  doc,
  getDoc,
  onSnapshot,
  where,
  writeBatch,
  serverTimestamp,
  deleteDoc,
  setDoc,
  deleteField,
} from "firebase/firestore";
import { ref, uploadBytes, getDownloadURL } from "firebase/storage";
import { onAuthStateChanged } from "firebase/auth";
import { FiEdit2, FiImage, FiInfo, FiTrash2 } from "react-icons/fi";
import ActionMenu, { ActionMenuTrigger } from "../common/ActionMenu";
import { auth, db, storage } from "../../firebase";
import { hasRole } from "../../utils/roles";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import ImportModal from "../common/ImportModal";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Button from "../common/Button";
import * as XLSX from "xlsx";

const EMPAQUE_TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "Todos" },
  { value: "Tarro", label: "Tarro" },
  { value: "Bolsa", label: "Bolsa" },
  { value: "Ristra", label: "Ristra" },
  { value: "Caja", label: "Caja" },
  { value: "Vaso", label: "Vaso" },
  { value: "Pana", label: "Pana" },
];

const EMPAQUE_EDIT_OPTIONS: { value: string; label: string }[] = [
  { value: "", label: "—" },
  { value: "Tarro", label: "Tarro" },
  { value: "Bolsa", label: "Bolsa" },
  { value: "Ristra", label: "Ristra" },
  { value: "Caja", label: "Caja" },
  { value: "Vaso", label: "Vaso" },
  { value: "Pana", label: "Pana" },
];

type PriceRow = {
  productId: string;
  category: string;
  productName: string;
  priceIsla: number;
  priceRivas: number;
  unitsPerPackage?: number;
  providerPrice?: number;
  /** URL en Firebase Storage guardada en current_prices.imageUrl */
  imageUrl?: string;
  _sortKey: number;
};

type CatalogRow = {
  category: string;
  productName: string;
  unitsPerPackage: number;
  providerPrice?: number;
};

/** Precios de venta solo desde current_prices; metadatos de catálogo desde products_candies. */
function buildMergedPriceRows(
  catalogById: Record<string, CatalogRow>,
  priceDocsById: Record<string, any>,
  unitsPerPackageMap: Record<string, number>,
  inventoryUnitsMap: Record<string, number>,
  providerPriceMap: Record<string, number>,
): PriceRow[] {
  const ids = new Set<string>([
    ...Object.keys(catalogById),
    ...Object.keys(priceDocsById),
  ]);
  const list: PriceRow[] = [];
  for (const productId of ids) {
    const c = catalogById[productId];
    if (!c) continue;
    const p = priceDocsById[productId];
    const invU = inventoryUnitsMap[productId];
    const prodU = unitsPerPackageMap[productId];
    const priceU = p
      ? Number(p.unitsPerPackage ?? p.unitsPerPack ?? NaN)
      : NaN;
    const units =
      invU && invU > 0
        ? invU
        : prodU && prodU > 0
          ? prodU
          : priceU && priceU > 0
            ? priceU
            : c?.unitsPerPackage && c.unitsPerPackage > 0
              ? c.unitsPerPackage
              : 1;

    let pkgIsla = Number(p?.packagePriceIsla ?? NaN);
    let pkgRivas = Number(p?.packagePriceRivas ?? NaN);
    if (!Number.isFinite(pkgIsla)) {
      const u = Number(p?.unitPriceIsla ?? NaN);
      pkgIsla = Number.isFinite(u) ? u * units : 0;
    }
    if (!Number.isFinite(pkgRivas)) {
      const u = Number(p?.unitPriceRivas ?? NaN);
      pkgRivas = Number.isFinite(u) ? u * units : 0;
    }

    const img = String(p?.imageUrl || "").trim();
    list.push({
      productId,
      category: c?.category ?? "",
      productName: c?.productName ?? productId,
      priceIsla: pkgIsla,
      priceRivas: pkgRivas,
      unitsPerPackage: units,
      providerPrice: providerPriceMap[productId],
      imageUrl: img || undefined,
      _sortKey: 0,
    });
  }
  return list.sort((a, b) =>
    a.productName.localeCompare(b.productName, "es"),
  );
}

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

function norm(s: any) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function toNum(v: any, fallback = 0) {
  const n = Number(String(v ?? "").replace(",", "."));
  return Number.isFinite(n) ? n : fallback;
}

function parseMaybeEmptyNumber(v: any) {
  const s = String(v ?? "")
    .trim()
    .replace(/,/g, ".");
  if (s === "") return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

function parseDateKey(dateStr: any) {
  const s = String(dateStr || "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
}

function normKey(s: any) {
  return String(s ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** Paquetes restantes desde lotes de orden maestra (inventory_candies). Misma idea que OrdenVendedor. */
function remainingPacksFromInventoryCandiesDoc(x: any): number {
  const upp = Math.max(1, Math.floor(Number(x?.unitsPerPackage || 1)));
  const remainingUnits = Number(x?.remaining ?? 0);
  if (Number.isFinite(remainingUnits) && remainingUnits > 0) {
    return Math.floor(remainingUnits / upp);
  }
  const rp = Number(x?.remainingPackages ?? 0);
  if (Number.isFinite(rp) && rp > 0) return Math.floor(rp);
  return 0;
}

function remainingPacksFromVendorDoc(x: any): number {
  const rp = Number(x?.remainingPackages ?? 0);
  if (Number.isFinite(rp) && rp > 0) return Math.floor(rp);
  return 0;
}

function pkgPricesFromDoc(p: any, units: number): { isla: number; rivas: number } {
  const u = Math.max(1, Number(units) || 1);
  let pkgIsla = Number(p?.packagePriceIsla ?? NaN);
  let pkgRivas = Number(p?.packagePriceRivas ?? NaN);
  if (!Number.isFinite(pkgIsla)) {
    const x = Number(p?.unitPriceIsla ?? NaN);
    pkgIsla = Number.isFinite(x) ? x * u : 0;
  }
  if (!Number.isFinite(pkgRivas)) {
    const x = Number(p?.unitPriceRivas ?? NaN);
    pkgRivas = Number.isFinite(x) ? x * u : 0;
  }
  return { isla: pkgIsla, rivas: pkgRivas };
}

const MAX_MARGIN_PERCENT = 99.999;

/** Misma lógica que OrdenMaestra: margen % sobre precio de venta (paquete). */
function deriveMarginPercentFromSubtotalAndTotal(
  subtotal: number,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(
    Math.max((1 - subtotal / total) * 100, 0),
    MAX_MARGIN_PERCENT,
  );
}

function formatFirestoreTimestamp(ts: any): string {
  if (!ts) return "—";
  try {
    const d =
      typeof ts?.toDate === "function"
        ? ts.toDate()
        : ts?.seconds != null
          ? new Date(Number(ts.seconds) * 1000)
          : null;
    if (!d || !Number.isFinite(d.getTime())) return "—";
    return d.toLocaleString("es-NI", {
      dateStyle: "short",
      timeStyle: "short",
    });
  } catch {
    return "—";
  }
}

/** Arma el documento current_prices con nombre, auditoría y usuario. */
function buildCurrentPricePayloadFields(
  existing: Record<string, any> | null | undefined,
  productId: string,
  units: number,
  pkgPriceIsla: number,
  pkgPriceRivas: number,
  productName: string,
  category: string,
  providerPricePerPackage?: number,
): Record<string, any> {
  const exUnits = existing
    ? Math.max(
        1,
        Number(existing.unitsPerPackage || existing.unitsPerPack || units) || 1,
      )
    : Math.max(1, Number(units) || 1);
  const prev = existing
    ? pkgPricesFromDoc(existing, exUnits)
    : { isla: 0, rivas: 0 };
  const u = Math.max(1, Number(units) || 1);
  const unitIsla = u > 0 ? pkgPriceIsla / u : 0;
  const unitRivas = u > 0 ? pkgPriceRivas / u : 0;
  const user = auth.currentUser;
  const cost = Math.max(0, Number(providerPricePerPackage) || 0);
  const marginIsla =
    Number.isFinite(pkgPriceIsla) && pkgPriceIsla > 0
      ? deriveMarginPercentFromSubtotalAndTotal(cost, pkgPriceIsla)
      : 0;
  const marginRivas =
    Number.isFinite(pkgPriceRivas) && pkgPriceRivas > 0
      ? deriveMarginPercentFromSubtotalAndTotal(cost, pkgPriceRivas)
      : 0;
  const out: Record<string, any> = {
    productId,
    productName,
    category,
    unitsPerPackage: u,
    packagePriceIsla: pkgPriceIsla,
    packagePriceRivas: pkgPriceRivas,
    unitPriceIsla: unitIsla,
    unitPriceRivas: unitRivas,
    marginIsla,
    marginRivas,
    previousPackagePriceIsla: prev.isla,
    previousPackagePriceRivas: prev.rivas,
    updatedAt: serverTimestamp(),
    updatedByEmail: user?.email || "",
    updatedByDisplayName: user?.displayName || "",
  };
  const prevImg = String(existing?.imageUrl || "").trim();
  if (prevImg) out.imageUrl = prevImg;
  return out;
}

// ============================
//  MODAL: Escáner (ZXing)
//  ✅ FIX PERMISOS: see CatalogoProductos implementation
// ============================
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
        stream?.getTracks?.().forEach((t: MediaStreamTrack) => t.stop());
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
        } catch (e: any) {
          // ignore warm-up failures
        }

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
      stopAll();
    };
  }, [open, onClose, onDetected]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/70 z-50 p-3 flex items-center justify-center">
      <div className="bg-white w-full max-w-md rounded-2xl shadow-lg border overflow-hidden">
        <div className="flex items-center justify-between p-3 border-b">
          <div className="font-bold">Escanear código</div>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="!rounded-lg px-3 py-1"
            onClick={onClose}
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

export default function PrecioVentas({
  publicView,
}: {
  publicView?: boolean;
} = {}) {
  const { refreshKey, refresh } = useManualRefresh();
  const isPublicView = !!publicView;

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [uvxpaqMap, setUvxpaqMap] = useState<Record<string, number>>({});
  const [uvxpaqAvgMap, setUvxpaqAvgMap] = useState<Record<string, number>>({});
  const [sellerCandyId, setSellerCandyId] = useState<string>("");
  /** Paquetes disponibles en inventario de órdenes maestras (inventory_candies) por productId */
  const [masterStockByProductId, setMasterStockByProductId] = useState<
    Record<string, number>
  >({});
  /** Paquetes restantes en subinventario del vendedor logueado (inventory_candies_sellers) */
  const [myVendorPacksByProductId, setMyVendorPacksByProductId] = useState<
    Record<string, number>
  >({});
  /** Paquetes restantes de otros vendedores (misma colección, sellerId distinto) */
  const [otherVendorPacksByProductId, setOtherVendorPacksByProductId] =
    useState<Record<string, number>>({});

  // filtros
  const [searchProduct, setSearchProduct] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [priceField, setPriceField] = useState<"ANY" | "ISLA" | "RIVAS">("ANY");
  const [packagingFilter, setPackagingFilter] = useState<string>("");

  // UI móvil
  const [filtersOpenMobile, setFiltersOpenMobile] = useState(false);
  /** Solo una categoría expandida a la vez en móvil */
  const [openMobileCategory, setOpenMobileCategory] = useState<string | null>(
    null,
  );

  const [barcodeMap, setBarcodeMap] = useState<Record<string, string>>({});
  const barcodeMapRef = useRef<Record<string, string>>({});
  const initialProductsSnapshot = useRef(true);
  const unitsPerPackageRef = useRef<Record<string, number>>({});
  const [catalogById, setCatalogById] = useState<Record<string, CatalogRow>>(
    {},
  );
  const [priceDocsById, setPriceDocsById] = useState<Record<string, any>>({});
  const [providerPriceMap, setProviderPriceMap] = useState<
    Record<string, number>
  >({});
  const [unitsPerPackageMap, setUnitsPerPackageMap] = useState<
    Record<string, number>
  >({});
  const [packagingMap, setPackagingMap] = useState<Record<string, string>>({});
  const inventoryUnitsMapRef = useRef<Record<string, number>>({});
  const initialInventorySnapshot = useRef(true);
  const [inventoryUnitsMap, setInventoryUnitsMap] = useState<
    Record<string, number>
  >({});

  // Catálogo (products_candies) + precios de venta (current_prices) en tiempo real
  useEffect(() => {
    setLoading(true);
    let catalogReady = false;
    let pricesReady = false;
    const tryFinishLoading = () => {
      if (catalogReady && pricesReady) setLoading(false);
    };

    const col = collection(db, "products_candies");
    const unsubProducts = onSnapshot(
      query(col),
      (snap) => {
        const prov: Record<string, number> = {};
        const bcMap: Record<string, string> = {};
        const unitsMap: Record<string, number> = {};
        const pkMap: Record<string, string> = {};
        const cat: Record<string, CatalogRow> = {};
        snap.forEach((d) => {
          const x: any = d.data();
          prov[d.id] = Number(x?.providerPrice || x?.providerPricePerUnit || 0);
          const u =
            Number(x?.unitsPerPackage || x?.unitsPerPack || 1) || 1;
          unitsMap[d.id] = u;
          cat[d.id] = {
            category: String(x?.category || "").trim(),
            productName:
              String(x?.productName || x?.name || "").trim() || d.id,
            unitsPerPackage: u,
            providerPrice: Number(x?.providerPrice || x?.providerPricePerUnit || 0),
          };
          const bc = String(x?.barcode || "").trim();
          if (bc) bcMap[d.id] = bc;
          const pk = String(x?.packaging || x?.empaque || "").trim();
          if (pk) pkMap[d.id] = pk;
        });
        try {
          const prev = barcodeMapRef.current || {};
          let changed = false;
          for (const id of Object.keys(bcMap)) {
            if ((bcMap[id] || "") !== (prev[id] || "")) {
              changed = true;
              break;
            }
          }
          const prevUnits = unitsPerPackageRef.current || {};
          let unitsChanged = false;
          for (const id of Object.keys(unitsMap)) {
            if ((unitsMap[id] || 0) !== (prevUnits[id] || 0)) {
              unitsChanged = true;
              break;
            }
          }

          setCatalogById(cat);
          setProviderPriceMap(prov);
          setUnitsPerPackageMap(unitsMap);
          const merged = { ...bcMap, ...prev };
          setBarcodeMap(merged);
          barcodeMapRef.current = merged;
          unitsPerPackageRef.current = { ...unitsMap };
          setPackagingMap(pkMap);
          if (!initialProductsSnapshot.current && changed) {
            setMsg("✅ Código actualizado.");
            setTimeout(() => setMsg(""), 3000);
          }
          if (!initialProductsSnapshot.current && unitsChanged) {
            setMsg("✅ Unidades x paquete actualizadas.");
            setTimeout(() => setMsg(""), 3000);
          }
          initialProductsSnapshot.current = false;
        } catch (e) {
          setCatalogById(cat);
          setProviderPriceMap(prov);
          setUnitsPerPackageMap(unitsMap);
          setBarcodeMap((prev) => ({ ...bcMap, ...prev }));
          unitsPerPackageRef.current = { ...unitsMap };
          setPackagingMap(pkMap);
        }
        if (!catalogReady) {
          catalogReady = true;
          tryFinishLoading();
        }
      },
      (err) => {
        console.error(err);
        setMsg("❌ Error cargando catálogo de productos.");
        if (!catalogReady) {
          catalogReady = true;
          tryFinishLoading();
        }
      },
    );

    const unsubPrices = onSnapshot(
      collection(db, "current_prices"),
      (snap) => {
        const pm: Record<string, any> = {};
        snap.forEach((d) => {
          pm[d.id] = d.data();
        });
        setPriceDocsById(pm);
        if (!pricesReady) {
          pricesReady = true;
          tryFinishLoading();
        }
      },
      (err) => {
        console.error(err);
        setMsg("❌ Error cargando current_prices.");
        if (!pricesReady) {
          pricesReady = true;
          tryFinishLoading();
        }
      },
    );

    return () => {
      unsubProducts();
      unsubPrices();
    };
  }, [refreshKey]);

  const rows = useMemo(
    () =>
      buildMergedPriceRows(
        catalogById,
        priceDocsById,
        unitsPerPackageMap,
        inventoryUnitsMap,
        providerPriceMap,
      ),
    [
      catalogById,
      priceDocsById,
      unitsPerPackageMap,
      inventoryUnitsMap,
      providerPriceMap,
    ],
  );

  // import / template / bulk save (admin-only)
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState<string | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importing, setImporting] = useState(false);
  const [savingAll, setSavingAll] = useState(false);
  // new manual price modal
  const [newPriceOpen, setNewPriceOpen] = useState(false);
  const [newPriceCategory, setNewPriceCategory] = useState<string>("");
  const [newPriceProductId, setNewPriceProductId] = useState<string>("");
  const [newPriceIsla, setNewPriceIsla] = useState<string>("");
  const [newPriceRivas, setNewPriceRivas] = useState<string>("");
  /** Und x paquete (empaque numérico) en modal crear/editar */
  const [newPriceUnits, setNewPriceUnits] = useState<string>("");
  const [newPriceBarcode, setNewPriceBarcode] = useState<string>("");
  const [newPricePackaging, setNewPricePackaging] = useState<string>("");
  /** URL pública (Storage) guardada en current_prices.imageUrl */
  const [newPriceImageUrl, setNewPriceImageUrl] = useState<string>("");
  const [removePriceImage, setRemovePriceImage] = useState(false);
  const [priceImageUploading, setPriceImageUploading] = useState(false);
  /** Móvil: overlay para ver foto a tamaño cómodo */
  const [mobilePriceImagePreviewUrl, setMobilePriceImagePreviewUrl] = useState<
    string | null
  >(null);
  const [searchNewProduct, setSearchNewProduct] = useState<string>("");
  const [successPriceOverlay, setSuccessPriceOverlay] = useState<{
    category: string;
    productName: string;
    isla: number;
    rivas: number;
  } | null>(null);
  const [priceInfoProductId, setPriceInfoProductId] = useState<string | null>(
    null,
  );
  const [priceModalMode, setPriceModalMode] = useState<"create" | "edit">(
    "create",
  );
  const [rowActionMenu, setRowActionMenu] = useState<{
    productId: string;
    rect: DOMRect;
  } | null>(null);
  const [adminToolsMenuRect, setAdminToolsMenuRect] =
    useState<DOMRect | null>(null);
  const [scanBarcodeProductId, setScanBarcodeProductId] = useState<
    string | null
  >(null);

  useEffect(() => {
    if (!successPriceOverlay) return;
    const t = setTimeout(() => setSuccessPriceOverlay(null), 4500);
    return () => clearTimeout(t);
  }, [successPriceOverlay]);

  const modalCategories = useMemo(() => {
    const fromCat = Object.values(catalogById)
      .map((c) => String(c.category || "").trim())
      .filter(Boolean);
    const fromRows = rows
      .map((r) => String(r.category || "").trim())
      .filter(Boolean);
    return Array.from(new Set([...fromCat, ...fromRows])).sort((a, b) =>
      a.localeCompare(b, "es"),
    );
  }, [catalogById, rows]);

  const modalProductOptions = useMemo(() => {
    const base = rows.filter((r) =>
      newPriceCategory ? r.category === newPriceCategory : true,
    );
    const q = norm(searchNewProduct);
    if (!q) return base;
    return base.filter((r) =>
      `${r.productName} ${r.productId}`.toLowerCase().includes(q),
    );
  }, [rows, newPriceCategory, searchNewProduct]);

  const newPriceCostDisplay = useMemo(() => {
    if (!newPriceProductId) return null;
    const n = Number(providerPriceMap[newPriceProductId] ?? 0);
    return Number.isFinite(n) ? n : 0;
  }, [newPriceProductId, providerPriceMap]);

  useEffect(() => {
    if (!newPriceOpen || priceModalMode !== "create" || !newPriceProductId) {
      return;
    }
    const c = catalogById[newPriceProductId];
    const u = Math.max(1, Number(c?.unitsPerPackage || 1));
    setNewPriceUnits(String(u));
    setNewPriceBarcode(barcodeMap[newPriceProductId] || "");
    setNewPricePackaging(packagingMap[newPriceProductId] || "");
  }, [
    newPriceOpen,
    priceModalMode,
    newPriceProductId,
    catalogById,
    barcodeMap,
    packagingMap,
  ]);

  /** Sube a Firebase Storage y deja la URL lista para guardarla en current_prices.imageUrl */
  const handlePickPriceImage = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file || !newPriceProductId) return;
    if (!file.type.startsWith("image/")) {
      setMsg("Seleccioná un archivo de imagen.");
      return;
    }
    if (file.size > 4 * 1024 * 1024) {
      setMsg("La imagen debe pesar menos de 4 MB.");
      return;
    }
    setPriceImageUploading(true);
    setRemovePriceImage(false);
    try {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase();
      const safe = ["jpg", "jpeg", "png", "webp", "gif"].includes(ext)
        ? ext
        : "jpg";
      const path = `precios_venta/${newPriceProductId}/${Date.now()}.${safe}`;
      const storageRef = ref(storage, path);
      await uploadBytes(storageRef, file, {
        contentType: file.type || "image/jpeg",
      });
      const url = await getDownloadURL(storageRef);
      setNewPriceImageUrl(url);
      setMsg("✅ Imagen lista. Guardá los cambios para aplicarla al precio.");
      setTimeout(() => setMsg(""), 3000);
    } catch (err) {
      console.error(err);
      setMsg(
        "❌ No se pudo subir la imagen. Revisá Storage en Firebase (reglas para usuarios autenticados).",
      );
    } finally {
      setPriceImageUploading(false);
    }
  };

  const createManualPrice = async () => {
    const modeAtStart = priceModalMode;
    if (!isAdmin || isPublicView) {
      setMsg("Acción no permitida: solo administradores.");
      return;
    }
    if (!newPriceCategory) return setMsg("Seleccioná una categoría.");
    if (!newPriceProductId) return setMsg("Seleccioná un producto.");
    const pkgIsla = parseMaybeEmptyNumber(newPriceIsla);
    const pkgRivas = parseMaybeEmptyNumber(newPriceRivas);
    if (!Number.isFinite(pkgIsla) && !Number.isFinite(pkgRivas)) {
      return setMsg("Ingresá al menos un precio (Isla o Rivas).");
    }

    try {
      // try to read product metadata for nicer UI update
      const prodRef = doc(
        collection(db, "products_candies"),
        newPriceProductId,
      );
      const prodSnap = await getDoc(prodRef);
      const prodData: any = prodSnap.exists() ? prodSnap.data() : {};
      const prodUnitsFromCatalog =
        Number(prodData?.unitsPerPackage || prodData?.unitsPerPack || 0) || 0;
      const parsedUnits = Math.max(
        0,
        Math.floor(
          Number(String(newPriceUnits || "").replace(",", ".")) || 0,
        ),
      );
      const units = Math.max(
        1,
        parsedUnits ||
          catalogById[newPriceProductId]?.unitsPerPackage ||
          prodUnitsFromCatalog ||
          1,
      );

      const pkgPriceIsla = Number.isFinite(pkgIsla) ? pkgIsla : 0;
      const pkgPriceRivas = Number.isFinite(pkgRivas) ? pkgRivas : 0;

      const priceRef = doc(
        collection(db, "current_prices"),
        newPriceProductId,
      );
      const existingSnap = await getDoc(priceRef);
      const existing = existingSnap.exists() ? existingSnap.data() : null;

      const productName =
        String(prodData?.productName || prodData?.name || "").trim() ||
        catalogById[newPriceProductId]?.productName ||
        newPriceProductId;
      const category =
        String(
          newPriceCategory ||
            prodData?.category ||
            catalogById[newPriceProductId]?.category ||
            "",
        ).trim();

      const providerPrice = Math.max(
        0,
        Number(
          prodData?.providerPrice ??
            providerPriceMap[newPriceProductId] ??
            catalogById[newPriceProductId]?.providerPrice ??
            0,
        ),
      );

      const payload = buildCurrentPricePayloadFields(
        existing,
        newPriceProductId,
        units,
        pkgPriceIsla,
        pkgPriceRivas,
        productName,
        category,
        providerPrice,
      );
      if (removePriceImage) {
        payload.imageUrl = deleteField();
      } else if (String(newPriceImageUrl || "").trim()) {
        payload.imageUrl = String(newPriceImageUrl).trim();
      }

      await setDoc(priceRef, payload, { merge: true });

      await updateDoc(doc(collection(db, "products_candies"), newPriceProductId), {
        packaging: String(newPricePackaging || "").trim(),
        barcode: String(newPriceBarcode || "").trim(),
        unitsPerPackage: units,
      });
      setBarcodeMap((prev) => ({
        ...prev,
        [newPriceProductId]: String(newPriceBarcode || "").trim(),
      }));
      setPackagingMap((prev) => ({
        ...prev,
        [newPriceProductId]: String(newPricePackaging || "").trim(),
      }));
      setUnitsPerPackageMap((prev) => ({
        ...prev,
        [newPriceProductId]: units,
      }));

      setSuccessPriceOverlay({
        category: category || "—",
        productName,
        isla: pkgPriceIsla,
        rivas: pkgPriceRivas,
      });
      setNewPriceOpen(false);
      setNewPriceCategory("");
      setNewPriceProductId("");
      setNewPriceIsla("");
      setNewPriceRivas("");
      setNewPriceUnits("");
      setNewPriceBarcode("");
      setNewPricePackaging("");
      setNewPriceImageUrl("");
      setRemovePriceImage(false);
      setSearchNewProduct("");
      setPriceModalMode("create");
    } catch (e) {
      console.error("Error creando precio:", e);
      setMsg(
        modeAtStart === "edit"
          ? "❌ Error guardando precio."
          : "❌ Error creando precio.",
      );
    }
  };

  const openPriceModalCreate = () => {
    setEditingId(null);
    setPriceModalMode("create");
    setNewPriceCategory("");
    setNewPriceProductId("");
    setNewPriceIsla("");
    setNewPriceRivas("");
    setNewPriceUnits("");
    setNewPriceBarcode("");
    setNewPricePackaging("");
    setNewPriceImageUrl("");
    setRemovePriceImage(false);
    setSearchNewProduct("");
    setNewPriceOpen(true);
  };

  const openPriceModalEdit = (r: PriceRow) => {
    setEditingId(null);
    setPriceModalMode("edit");
    setNewPriceCategory(r.category || "");
    setNewPriceProductId(r.productId);
    setNewPriceIsla(String(r.priceIsla ?? ""));
    setNewPriceRivas(String(r.priceRivas ?? ""));
    setSearchNewProduct("");
    setRemovePriceImage(false);
    const pd = priceDocsById[r.productId];
    setNewPriceImageUrl(String(pd?.imageUrl || r.imageUrl || "").trim());
    const u =
      Number(pd?.unitsPerPackage ?? pd?.unitsPerPack) ||
      r.unitsPerPackage ||
      catalogById[r.productId]?.unitsPerPackage ||
      1;
    setNewPriceUnits(String(Math.max(1, Math.floor(Number(u) || 1))));
    setNewPriceBarcode(barcodeMap[r.productId] || "");
    setNewPricePackaging(packagingMap[r.productId] || "");
    setNewPriceOpen(true);
  };

  const downloadTemplate = async () => {
    try {
      const snap = await getDocs(query(collection(db, "products_candies")));
      const aoa: any[] = [];
      // header
      aoa.push([
        "productId",
        "category",
        "productName",
        "unitsPerPackage",
        "packagePriceIsla",
        "packagePriceRivas",
      ]);

      snap.forEach((d) => {
        const x: any = d.data();
        aoa.push([
          d.id,
          String(x?.category || ""),
          String(x?.productName || x?.name || ""),
          Number(x?.unitsPerPackage || x?.unitsPerPack || 1),
          "",
          "",
        ]);
      });

      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, "precios");
      XLSX.writeFile(wb, "precios_template.xlsx");
      setMsg("✅ Template descargado.");
    } catch (e) {
      console.error("Error descargando template:", e);
      setMsg("❌ Error descargando template.");
    }
  };

  const downloadPricesListXlsx = () => {
    try {
      const aoa: any[] = [
        [
          "productId",
          "categoria",
          "nombreProducto",
          "precioIslaActual",
          "precioRivasActual",
          "precioIslaAnterior",
          "precioRivasAnterior",
          "fechaUltimaActualizacion",
          "usuarioActualizo",
        ],
      ];
      for (const r of rows) {
        const p = priceDocsById[r.productId];
        const prevI =
          p?.previousPackagePriceIsla != null
            ? Number(p.previousPackagePriceIsla)
            : "";
        const prevR =
          p?.previousPackagePriceRivas != null
            ? Number(p.previousPackagePriceRivas)
            : "";
        const fecha = formatFirestoreTimestamp(p?.updatedAt);
        const usuario = [p?.updatedByDisplayName, p?.updatedByEmail]
          .filter(Boolean)
          .join(" — ");
        aoa.push([
          r.productId,
          r.category,
          r.productName,
          r.priceIsla,
          r.priceRivas,
          prevI,
          prevR,
          fecha,
          usuario || "",
        ]);
      }
      const wb = XLSX.utils.book_new();
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      XLSX.utils.book_append_sheet(wb, ws, "precios");
      XLSX.writeFile(wb, "listado_precios.xlsx");
      setMsg("✅ Listado de precios descargado.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error generando listado.");
    }
  };

  const handlePickFile = async (f: File | null) => {
    setImportErrors([]);
    if (!isAdmin || isPublicView) {
      setImportErrors(["Acción no permitida: solo administradores."]);
      return;
    }
    if (!f) return;
    setImportFileName(f.name);
    setImportLoading(true);
    setImporting(true);
    try {
      const data = await f.arrayBuffer();
      const wb = XLSX.read(data, { type: "array" });
      const sheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[sheetName];

      const aoa: any[] = XLSX.utils.sheet_to_json(sheet, {
        header: 1,
        defval: "",
      });
      if (!aoa || aoa.length === 0) {
        setImportErrors(["Archivo vacío o sin filas."]);
        return;
      }
      const headerRow: string[] = (aoa[0] || []).map((h: any) =>
        String(h || "")
          .trim()
          .toLowerCase(),
      );
      if (!headerRow.includes("productid")) {
        setImportErrors(["Plantilla inválida: falta columna 'productId'."]);
        return;
      }

      const rowsRaw: any[] = XLSX.utils.sheet_to_json(sheet, { defval: "" });
      if (!rowsRaw || rowsRaw.length === 0) {
        setImportErrors(["Archivo vacío o sin filas."]);
        return;
      }

      const known = new Set<string>(Object.keys(catalogById));

      const batch = writeBatch(db);
      let count = 0;
      const failed: string[] = [];

      for (let idx = 0; idx < rowsRaw.length; idx++) {
        const rr = rowsRaw[idx];
        const pid = String(rr.productId || rr.productID || rr.id || "").trim();
        if (!pid) {
          failed.push(`Fila ${idx + 2}: productId vacío`);
          continue;
        }
        if (!known.has(pid)) {
          failed.push(
            `Fila ${idx + 2}: productId '${pid}' no encontrado en catálogo`,
          );
          continue;
        }

        const pkgIsla = toNum(
          rr.packagePriceIsla ??
            rr.package_price_isla ??
            rr.packagePrice ??
            rr.package ??
            0,
          NaN,
        );
        const pkgRivas = toNum(
          rr.packagePriceRivas ??
            rr.package_price_rivas ??
            rr.packageRivas ??
            0,
          NaN,
        );
        if (!Number.isFinite(pkgIsla) && !Number.isFinite(pkgRivas)) {
          failed.push(
            `Fila ${idx + 2}: faltan precios de paquete (Isla/Rivas)`,
          );
          continue;
        }

        const unitsFromFile = toNum(
          rr.unitsPerPackage ?? rr.units ?? rr.unitsPerPack,
          NaN,
        );
        const units = Number.isFinite(unitsFromFile)
          ? Math.max(1, unitsFromFile)
          : catalogById[pid]?.unitsPerPackage ||
            unitsPerPackageMap[pid] ||
            1;

        const pkgPriceIsla = Number.isFinite(pkgIsla) ? pkgIsla : 0;
        const pkgPriceRivas = Number.isFinite(pkgRivas) ? pkgRivas : 0;

        const priceRef = doc(collection(db, "current_prices"), pid);
        const exSnap = await getDoc(priceRef);
        const existing = exSnap.exists() ? exSnap.data() : null;
        const catRow = catalogById[pid];
        const productName =
          String(catRow?.productName || "").trim() || String(pid);
        const category = String(catRow?.category || "").trim();

        const providerPrice = Math.max(
          0,
          Number(catRow?.providerPrice ?? 0),
        );

        const payload = buildCurrentPricePayloadFields(
          existing,
          pid,
          units,
          pkgPriceIsla,
          pkgPriceRivas,
          productName,
          category,
          providerPrice,
        );

        batch.set(priceRef, payload, {
          merge: true,
        });
        count++;
      }

      if (count > 0) await batch.commit();
      if (failed.length) setImportErrors(failed);
      setMsg(
        failed.length
          ? `✅ Importadas ${count}. ${failed.length} fila(s) con errores.`
          : `✅ Importadas ${count} fila(s) a current_prices.`,
      );
    } catch (err) {
      console.error("Error importing XLSX:", err);
      setImportErrors(["Error procesando el archivo."]);
    } finally {
      setImportLoading(false);
      setImporting(false);
    }
  };

  const saveAllCurrentPrices = async () => {
    if (!isAdmin || isPublicView) {
      setMsg("Acción no permitida: solo administradores.");
      return;
    }
    if (
      !confirm(
        "¿Guardar los precios mostrados en current_prices? Esto sobrescribirá precios por productId.",
      )
    )
      return;
    setSavingAll(true);
    try {
      let batch = writeBatch(db);
      let opsInBatch = 0;
      for (const r of rows) {
        const units = Number(r.unitsPerPackage || 1);
        const pkgPriceIsla = Number(r.priceIsla || 0);
        const pkgPriceRivas = Number(r.priceRivas || 0);
        const priceRef = doc(collection(db, "current_prices"), r.productId);
        const exSnap = await getDoc(priceRef);
        const existing = exSnap.exists() ? exSnap.data() : null;
        const productName =
          String(catalogById[r.productId]?.productName || r.productName || "").trim() ||
          r.productId;
        const category = String(
          catalogById[r.productId]?.category || r.category || "",
        ).trim();
        const providerPrice = Math.max(
          0,
          Number(providerPriceMap[r.productId] ?? 0) ||
            Number(catalogById[r.productId]?.providerPrice ?? 0),
        );

        const payload = buildCurrentPricePayloadFields(
          existing,
          r.productId,
          units,
          pkgPriceIsla,
          pkgPriceRivas,
          productName,
          category,
          providerPrice,
        );
        batch.set(priceRef, payload, {
          merge: true,
        });
        opsInBatch++;
        if (opsInBatch >= 400) {
          await batch.commit();
          batch = writeBatch(db);
          opsInBatch = 0;
        }
      }
      if (opsInBatch > 0) await batch.commit();
      setMsg(`✅ Guardados ${rows.length} precios en current_prices.`);
    } catch (e) {
      console.error("Error guardando current_prices:", e);
      setMsg("❌ Error guardando precios.");
    } finally {
      setSavingAll(false);
    }
  };

  // sincronizar unidades por paquete desde inventory_candies (si se editó allí)
  useEffect(() => {
    const colInv = collection(db, "inventory_candies");
    const qInv = query(colInv);
    const unsubInv = onSnapshot(
      qInv,
      (snap) => {
        try {
          const map: Record<string, { val: number; ts: number }> = {};
          snap.forEach((d) => {
            const x: any = d.data();
            const pid = String(x.productId || "").trim();
            if (!pid) return;
            const units = Number(x.unitsPerPackage || x.unitsPerPack || 0) || 0;
            const createdAtMs =
              x?.createdAt?.toMillis?.() ||
              (x?.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0) ||
              0;
            const prev = map[pid];
            if (!prev || createdAtMs >= prev.ts) {
              map[pid] = { val: units || 0, ts: createdAtMs };
            }
          });
          const out: Record<string, number> = {};
          for (const k of Object.keys(map)) out[k] = map[k].val || 0;
          setInventoryUnitsMap(out);
          // detect inventory-based changes vs previous inventoryUnitsMap
          try {
            const prevInv = inventoryUnitsMapRef.current || {};
            let invChanged = false;
            for (const id of Object.keys(out)) {
              if ((out[id] || 0) !== (prevInv[id] || 0)) {
                invChanged = true;
                break;
              }
            }
            inventoryUnitsMapRef.current = { ...out };
            if (!initialInventorySnapshot.current && invChanged) {
              setMsg("✅ Inventario: unidades por paquete actualizadas.");
              setTimeout(() => setMsg(""), 3000);
            }
            initialInventorySnapshot.current = false;
          } catch (e) {}
        } catch (e) {
          console.error("inventory_candies snapshot error:", e);
        }
      },
      (err) => console.error(err),
    );

    return () => unsubInv();
  }, [unitsPerPackageMap]);

  const filtered = useMemo(() => {
    const q = norm(searchProduct);
    const qc = String(searchCode || "").trim();
    const pf = String(packagingFilter || "")
      .trim()
      .toLowerCase();

    const min = minPrice.trim() === "" ? null : toNum(minPrice, NaN);
    const max = maxPrice.trim() === "" ? null : toNum(maxPrice, NaN);

    return rows.filter((r) => {
      const pk = String(packagingMap[r.productId] || "")
        .trim()
        .toLowerCase();

      // If a packaging filter is selected, show all products matching
      // that packaging and ignore the other filters.
      if (pf) {
        return pk === pf;
      }

      if (q) {
        const hay = `${r.category} ${r.productName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }

      if (qc) {
        const codeMatch = String(r.productId || "");
        const bc = String(barcodeMap[r.productId] || "");
        if (!codeMatch.includes(qc) && !bc.includes(qc)) return false;
      }

      const prices =
        priceField === "ISLA"
          ? [r.priceIsla]
          : priceField === "RIVAS"
            ? [r.priceRivas]
            : [r.priceIsla, r.priceRivas];

      const minOk =
        min == null || !Number.isFinite(min)
          ? true
          : prices.some((p) => p >= (min as number));

      const maxOk =
        max == null || !Number.isFinite(max)
          ? true
          : prices.some((p) => p <= (max as number));

      return minOk && maxOk;
    });
  }, [
    rows,
    searchProduct,
    minPrice,
    maxPrice,
    priceField,
    barcodeMap,
    packagingFilter,
    packagingMap,
  ]);

  const filteredByCategory = useMemo(() => {
    const map = new Map<string, PriceRow[]>();
    for (const r of filtered) {
      const key = (r.category || "Sin categoría").trim() || "Sin categoría";
      const list = map.get(key) || [];
      list.push(r);
      map.set(key, list);
    }
    return Array.from(map.entries()).sort(([a], [b]) =>
      a.localeCompare(b, "es"),
    );
  }, [filtered]);

  // paginación (móvil: 15 grupos por página)
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);
  const totalPages = Math.max(
    1,
    Math.ceil(filteredByCategory.length / PAGE_SIZE),
  );
  const pagedByCategory = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredByCategory.slice(start, start + PAGE_SIZE);
  }, [filteredByCategory, page]);

  useEffect(() => {
    setPage(1);
  }, [
    searchProduct,
    searchCode,
    minPrice,
    maxPrice,
    priceField,
    packagingFilter,
  ]);

  useEffect(() => {
    setPage((p) => Math.min(p, totalPages));
  }, [totalPages]);

  const goFirst = () => setPage(1);
  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));
  const goLast = () => setPage(totalPages);

  const renderPager = () => (
    <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mt-3">
      <div className="flex items-center gap-1 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={goFirst}
          disabled={page === 1}
        >
          « Primero
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={goPrev}
          disabled={page === 1}
        >
          ‹ Anterior
        </Button>
        <span className="px-2 text-sm">
          Página {page} de {totalPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={goNext}
          disabled={page === totalPages}
        >
          Siguiente ›
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={goLast}
          disabled={page === totalPages}
        >
          Último »
        </Button>
      </div>
      <div className="text-sm text-gray-600">
        {filteredByCategory.length} categoría(s)
      </div>
    </div>
  );

  // paginación (web: 15 productos por página)
  const WEB_PAGE_SIZE = 15;
  const [webPage, setWebPage] = useState(1);
  const totalWebPages = Math.max(1, Math.ceil(filtered.length / WEB_PAGE_SIZE));
  const pagedWebRows = useMemo(() => {
    const start = (webPage - 1) * WEB_PAGE_SIZE;
    return filtered.slice(start, start + WEB_PAGE_SIZE);
  }, [filtered, webPage]);

  useEffect(() => {
    setWebPage(1);
  }, [
    searchProduct,
    searchCode,
    minPrice,
    maxPrice,
    priceField,
    packagingFilter,
  ]);

  useEffect(() => {
    setWebPage((p) => Math.min(p, totalWebPages));
  }, [totalWebPages]);

  const webGoFirst = () => setWebPage(1);
  const webGoPrev = () => setWebPage((p) => Math.max(1, p - 1));
  const webGoNext = () => setWebPage((p) => Math.min(totalWebPages, p + 1));
  const webGoLast = () => setWebPage(totalWebPages);

  const renderWebPager = () => (
    <div className="flex items-center justify-between mt-3">
      <div className="flex items-center gap-1 flex-wrap">
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={webGoFirst}
          disabled={webPage === 1}
        >
          « Primero
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={webGoPrev}
          disabled={webPage === 1}
        >
          ‹ Anterior
        </Button>
        <span className="px-2 text-sm">
          Página {webPage} de {totalWebPages}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={webGoNext}
          disabled={webPage === totalWebPages}
        >
          Siguiente ›
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="px-1 py-0.5 text-sm !rounded-lg md:px-2 md:py-1 md:text-base"
          onClick={webGoLast}
          disabled={webPage === totalWebPages}
        >
          Último »
        </Button>
      </div>
      <div className="text-sm text-gray-600">{filtered.length} producto(s)</div>
    </div>
  );

  const toggleCategory = (cat: string) => {
    setOpenMobileCategory((cur) => {
      if (cur === cat) return null;
      setOpenCardId(null);
      return cat;
    });
  };

  const clearFilters = () => {
    setSearchProduct("");
    setMinPrice("");
    setMaxPrice("");
    setPriceField("ANY");
    setPackagingFilter("");
  };

  // escáner (modo search/edit)
  const [scanOpen, setScanOpen] = useState(false);
  const [scanTarget, setScanTarget] = useState<"search" | "edit">("search");

  // edición local (solo UI)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editPriceIsla, setEditPriceIsla] = useState<number>(0);
  const [editPriceRivas, setEditPriceRivas] = useState<number>(0);
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [editBarcode, setEditBarcode] = useState<string>("");
  const [editPackaging, setEditPackaging] = useState<string>("");

  const hasActiveFilters = useMemo(() => {
    return (
      searchProduct.trim() !== "" ||
      minPrice.trim() !== "" ||
      maxPrice.trim() !== "" ||
      priceField !== "ANY" ||
      packagingFilter.trim() !== ""
    );
  }, [searchProduct, minPrice, maxPrice, priceField, packagingFilter]);

  // responsive + role
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  const [isAdmin, setIsAdmin] = useState(false);
  const [isVendor, setIsVendor] = useState(false);
  useEffect(() => {
    if (isPublicView) {
      setIsAdmin(false);
      setIsVendor(false);
      setSellerCandyId("");
      return;
    }
    const unsub = onAuthStateChanged(auth, async (u) => {
      if (!u) return setIsAdmin(false);
      try {
        const snap = await getDoc(doc(db, "users", u.uid));
        const data = snap.exists() ? (snap.data() as any) : null;
        const subject = data
          ? Array.isArray(data.roles)
            ? data.roles
            : data.role
              ? [data.role]
              : []
          : [];
        setSellerCandyId(String(data?.sellerCandyId || "").trim());
        setIsAdmin(hasRole(subject, "admin"));
        setIsVendor(hasRole(subject, "vendedor_dulces"));
      } catch (e) {
        console.error(e);
        setIsAdmin(false);
        setIsVendor(false);
        setSellerCandyId("");
      }
    });
    return () => unsub();
  }, [isPublicView]);

  const isAdminEditable = isAdmin && !isPublicView;

  const canCreateManualPrice = useMemo(() => {
    const pkgIsla = parseMaybeEmptyNumber(newPriceIsla);
    const pkgRivas = parseMaybeEmptyNumber(newPriceRivas);
    return (
      isAdminEditable &&
      Boolean(newPriceCategory) &&
      Boolean(newPriceProductId) &&
      (Number.isFinite(pkgIsla) || Number.isFinite(pkgRivas))
    );
  }, [
    isAdminEditable,
    newPriceCategory,
    newPriceProductId,
    newPriceIsla,
    newPriceRivas,
  ]);

  // UV x paq del vendedor logueado (sellerCandyId), incl. admin con seller asignado
  useEffect(() => {
    if (!sellerCandyId) {
      setUvxpaqMap({});
      return;
    }

    const q = query(
      collection(db, "inventory_candies_sellers"),
      where("sellerId", "==", sellerCandyId),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const map: Record<string, { val: number; ts: number }> = {};

        snap.forEach((d) => {
          const x = d.data() as any;
          const pname = String(x.productName || "").trim();
          const key = pname ? normKey(pname) : String(x.productId || "");
          if (!key) return;

          const createdAtMs =
            x?.createdAt?.toMillis?.() ||
            (x?.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0) ||
            0;
          const updatedAtMs =
            x?.updatedAt?.toMillis?.() ||
            (x?.updatedAt?.seconds ? x.updatedAt.seconds * 1000 : 0) ||
            0;
          const dateKey = parseDateKey(x.date);
          const ts = Math.max(createdAtMs, updatedAtMs, dateKey);

          const explicitUv = Number(
            x.uvXpaq ?? x.uvxpaq ?? x.uVxPaq ?? x.u_vxpaq ?? NaN,
          );
          let valUv = NaN as number;
          if (Number.isFinite(explicitUv)) valUv = explicitUv;
          else {
            const uVend = Number(x.uVendor ?? x.vendorProfit ?? 0);
            const packs = Math.max(1, Number(x.packages ?? 0));
            valUv = packs > 0 ? uVend / packs : 0;
          }

          const current = map[key];
          if (!current || ts >= current.ts) {
            map[key] = { val: Number(valUv || 0), ts };
          }
        });

        const out: Record<string, number> = {};
        Object.keys(map).forEach((k) => {
          out[k] = map[k].val || 0;
        });
        setUvxpaqMap(out);
      },
      (err) => {
        console.error("inventory_candies_sellers snapshot error:", err);
        setUvxpaqMap({});
      },
    );

    return () => unsub();
  }, [sellerCandyId]);

  // Promedio UV x paq por producto (lectura para todos; antes solo admin)
  useEffect(() => {
    const q = query(collection(db, "inventory_candies_sellers"));

    const unsub = onSnapshot(
      q,
      (snap) => {
        const sumMap: Record<string, number> = {};
        const countMap: Record<string, number> = {};

        snap.forEach((d) => {
          const x = d.data() as any;
          const pname = String(x.productName || "").trim();
          const key = pname ? normKey(pname) : String(x.productId || "");
          if (!key) return;

          const explicitUv = Number(
            x.uvXpaq ?? x.uvxpaq ?? x.uVxPaq ?? x.u_vxpaq ?? NaN,
          );
          let valUv = NaN as number;
          if (Number.isFinite(explicitUv)) valUv = explicitUv;
          else {
            const uVend = Number(x.uVendor ?? x.vendorProfit ?? 0);
            const packs = Math.max(1, Number(x.packages ?? 0));
            valUv = packs > 0 ? uVend / packs : 0;
          }

          if (!Number.isFinite(valUv)) return;

          sumMap[key] = (sumMap[key] || 0) + Number(valUv || 0);
          countMap[key] = (countMap[key] || 0) + 1;
        });

        const out: Record<string, number> = {};
        Object.keys(sumMap).forEach((k) => {
          const cnt = countMap[k] || 0;
          out[k] = cnt > 0 ? sumMap[k] / cnt : 0;
        });
        setUvxpaqAvgMap(out);
      },
      (err) => {
        console.error("inventory_candies_sellers avg error:", err);
        setUvxpaqAvgMap({});
      },
    );

    return () => unsub();
  }, []);

  // Stock maestro (órdenes maestras): visible también en vista pública
  useEffect(() => {
    const unsub = onSnapshot(
      collection(db, "inventory_candies"),
      (snap) => {
        const acc: Record<string, number> = {};
        snap.forEach((d) => {
          const x = d.data() as any;
          const pid = String(x.productId || "").trim();
          if (!pid) return;
          const packs = remainingPacksFromInventoryCandiesDoc(x);
          if (packs <= 0) return;
          acc[pid] = (acc[pid] || 0) + packs;
        });
        setMasterStockByProductId(acc);
      },
      (err) => {
        console.error("inventory_candies snapshot (PreciosVenta):", err);
        setMasterStockByProductId({});
      },
    );
    return () => unsub();
  }, []);

  useEffect(() => {
    if (isPublicView) {
      setMyVendorPacksByProductId({});
      setOtherVendorPacksByProductId({});
      return;
    }
    const unsub = onSnapshot(
      collection(db, "inventory_candies_sellers"),
      (snap) => {
        const my: Record<string, number> = {};
        const other: Record<string, number> = {};
        const sid = String(sellerCandyId || "").trim();
        snap.forEach((d) => {
          const x = d.data() as any;
          const pid = String(x.productId || "").trim();
          if (!pid) return;
          const packs = remainingPacksFromVendorDoc(x);
          if (packs <= 0) return;
          const seller = String(x.sellerId || "").trim();
          if (sid && seller === sid) {
            my[pid] = (my[pid] || 0) + packs;
          } else if (sid && seller && seller !== sid) {
            other[pid] = (other[pid] || 0) + packs;
          }
        });
        setMyVendorPacksByProductId(my);
        setOtherVendorPacksByProductId(other);
      },
      (err) => {
        console.error("inventory_candies_sellers snapshot (PreciosVenta):", err);
        setMyVendorPacksByProductId({});
        setOtherVendorPacksByProductId({});
      },
    );
    return () => unsub();
  }, [isPublicView, sellerCandyId]);

  const onDetected = async (code: string) => {
    if (scanTarget === "search") {
      setSearchCode(code);
      // Buscar producto por código de barras o ID
      const byBarcode = Object.keys(barcodeMap).find(
        (id) => (barcodeMap[id] || "") === code,
      );
      const byProductId = rows.find((r) =>
        String(r.productId || "").includes(code),
      )?.productId;
      const matchId = byBarcode || byProductId || null;
      if (matchId) {
        setOpenCardId(matchId);
        setFiltersOpenMobile(false);
        setMsg("");
      } else {
        setMsg("No se encontró producto para el código escaneado.");
      }
      // Esperar un poco antes de cerrar el modal para evitar cortes de cámara prematuros
      setTimeout(() => setScanOpen(false), 300);
      return;
    }
    if (scanTarget === "edit") {
      const pid =
        editingId ||
        scanBarcodeProductId ||
        (newPriceOpen && newPriceProductId ? newPriceProductId : "") ||
        "";
      if (!pid) return;
      try {
        const col = collection(db, "products_candies");
        const docRef = doc(col, pid);
        await updateDoc(docRef, { barcode: code });
        setBarcodeMap((prev) => ({ ...prev, [pid]: code }));
        setEditBarcode(code);
        if (newPriceOpen && newPriceProductId === pid) {
          setNewPriceBarcode(code);
        }
        setScanBarcodeProductId(null);
        setScanOpen(false);
        setScanTarget("search");
        setMsg("✅ Producto guardado.");
      } catch (err) {
        console.error(err);
        setMsg("❌ Error guardando el código.");
      }
    }
  };

  const saveEditedPrices = async (id: string) => {
    const row = rows.find((r) => r.productId === id);
    const units = Math.max(
      1,
      Number(
        inventoryUnitsMap[id] ||
          unitsPerPackageMap[id] ||
          row?.unitsPerPackage ||
          catalogById[id]?.unitsPerPackage ||
          1,
      ),
    );
    const pkgPriceIsla = Number(editPriceIsla || 0);
    const pkgPriceRivas = Number(editPriceRivas || 0);

    if (isAdmin && !isPublicView) {
      try {
        const priceRef = doc(collection(db, "current_prices"), id);
        const exSnap = await getDoc(priceRef);
        const existing = exSnap.exists() ? exSnap.data() : null;
        const productName =
          String(catalogById[id]?.productName || row?.productName || "").trim() ||
          id;
        const category = String(
          catalogById[id]?.category || row?.category || "",
        ).trim();
        const providerPrice = Math.max(
          0,
          Number(providerPriceMap[id] ?? 0) ||
            Number(catalogById[id]?.providerPrice ?? 0) ||
            Number(row?.providerPrice ?? 0),
        );

        const payload = buildCurrentPricePayloadFields(
          existing,
          id,
          units,
          pkgPriceIsla,
          pkgPriceRivas,
          productName,
          category,
          providerPrice,
        );
        await setDoc(priceRef, payload, { merge: true });
      } catch (e) {
        console.error("Error guardando current_prices:", e);
        setMsg("❌ Error guardando precios.");
        return;
      }
    }

    try {
      const pk = String(editPackaging || "").trim();
      const bc = String(editBarcode || "").trim();
      await updateDoc(doc(collection(db, "products_candies"), id), {
        packaging: pk || "",
        barcode: bc,
      });
      setPackagingMap((prev) => ({ ...prev, [id]: pk || "" }));
      setBarcodeMap((prev) => ({ ...prev, [id]: bc }));
    } catch (e) {
      console.error("Error updating packaging:", e);
      setMsg("❌ Error guardando empaque.");
      return;
    }

    setEditingId(null);
    setMsg(
      isMobile
        ? "✅ Guardado."
        : isAdmin
          ? "✅ Precios (current_prices) y empaque guardados."
          : "",
    );
  };

  const deleteCurrentPrice = async (productId: string) => {
    if (!isAdmin || isPublicView) {
      setMsg("Acción no permitida: solo administradores.");
      return;
    }
    if (
      !confirm(
        "¿Eliminar el documento de precios en current_prices para este producto? El artículo seguirá en el catálogo.",
      )
    )
      return;
    try {
      await deleteDoc(doc(collection(db, "current_prices"), productId));
      setEditingId(null);
      setOpenCardId((cur) => (cur === productId ? null : cur));
      setMsg("✅ Precio eliminado de current_prices.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando precio.");
    }
  };

  const webColCount = isAdmin ? 14 : 13;

  const packsStockDisplay = (productId: string) =>
    String(Math.max(0, Math.floor(masterStockByProductId[productId] ?? 0)));
  const packsMiDisplay = (productId: string) =>
    sellerCandyId
      ? String(Math.max(0, Math.floor(myVendorPacksByProductId[productId] ?? 0)))
      : "—";
  const packsOtroDisplay = (productId: string) =>
    sellerCandyId
      ? String(
          Math.max(0, Math.floor(otherVendorPacksByProductId[productId] ?? 0)),
        )
      : "—";

  return (
    <div
      className={isPublicView ? "max-w-7xl mx-auto w-full pb-4" : "max-w-7xl mx-auto"}
    >
      {isPublicView && (
        <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
          Consulta pública: solo lectura de precios.
        </div>
      )}
      {/* Header */}
      <div className="flex flex-col gap-3 mb-3 md:flex-row md:items-center md:justify-between">
        <h2 className="text-xl font-bold">Precio Ventas</h2>
        <div className="flex flex-col gap-2 w-full md:w-auto md:flex-row md:flex-wrap md:justify-end md:gap-2">
          <div className="flex flex-row gap-2 w-full md:contents">
            {isAdminEditable && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="md:hidden flex-1 min-w-0 !rounded-md px-3 py-2 text-sm whitespace-nowrap"
                onClick={(e) =>
                  setAdminToolsMenuRect(e.currentTarget.getBoundingClientRect())
                }
              >
                Más acciones ▾
              </Button>
            )}
            <RefreshButton
              onClick={refresh}
              loading={loading}
              className="flex-1 min-w-0 justify-center rounded-md px-3 py-2 text-sm font-semibold md:flex-none md:w-auto md:min-h-0 md:rounded-full md:justify-start"
            />
          </div>
        </div>
      </div>

      {/* ===== MOBILE: filtros colapsables ===== */}
      <div className="md:hidden mb-3">
        <Button
          type="button"
          variant="outline"
          size="md"
          onClick={() => setFiltersOpenMobile((v) => !v)}
          className={`w-full !justify-between !rounded-xl px-3 py-3 shadow-sm ${
            hasActiveFilters
              ? "!bg-yellow-50 border-yellow-200"
              : "!bg-white border-slate-200"
          }`}
        >
          <div className="text-left">
            <div className="font-semibold">Filtros avanzados</div>
            <div className="text-xs text-gray-600">
              {hasActiveFilters ? "Activos" : "Ninguno"}
              {" • "}
              Mostrando <b>{filtered.length}</b>
            </div>
          </div>
          <div className="text-sm font-semibold">
            {filtersOpenMobile ? "Cerrar" : "Abrir"}
          </div>
        </Button>

        {filtersOpenMobile && (
          <div className="mt-2 bg-white border rounded-xl shadow-sm p-3 text-sm">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <MobileHtmlSelect
                  label="Tipo empaque"
                  value={packagingFilter}
                  onChange={setPackagingFilter}
                  options={EMPAQUE_TYPE_OPTIONS}
                  selectClassName="w-full border rounded px-2 py-2"
                  sheetTitle="Tipo empaque"
                />
              </div>

              <div>
                <label className="block font-semibold">Buscar por EAN</label>
                <div className="flex gap-2">
                  <input
                    className="flex-1 border rounded px-2 py-2"
                    value={searchCode}
                    onChange={(e) => setSearchCode(e.target.value)}
                    placeholder="Código EAN"
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    className="!rounded-lg px-3 py-2"
                    onClick={() => {
                      setScanTarget("search");
                      setScanOpen(true);
                    }}
                  >
                    Escanear
                  </Button>
                </div>
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="flex-1 !rounded-lg px-3 py-2"
                  onClick={() => {
                    clearFilters();
                    setSearchCode("");
                  }}
                >
                  Limpiar filtros
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="flex-1 !rounded-lg px-3 py-2 !bg-indigo-600 hover:!bg-indigo-700 shadow-indigo-600/15"
                  onClick={() => setFiltersOpenMobile(false)}
                >
                  Aplicar
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>
      <div className="md:hidden">
        <label className="block font-semibold">Buscar producto</label>
        <input
          className="w-full border rounded-2xl px-5 py-3 shadow-sm mb-5"
          value={searchProduct}
          onChange={(e) => setSearchProduct(e.target.value)}
          onClick={() => {
            setSearchProduct("");
            setSearchCode("");
            setPackagingFilter("");
            setMinPrice("");
            setMaxPrice("");
          }}
          onFocus={() => {
            setSearchProduct("");
            setSearchCode("");
            setPackagingFilter("");
            setMinPrice("");
            setMaxPrice("");
          }}
          placeholder="Ej: Conitos, Gomitas…"
        />
      </div>

      {/* ===== WEB: filtros siempre visibles (igual idea de antes) ===== */}
      <div className="hidden md:block bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-3 text-sm">
        <div className="flex flex-wrap gap-3 items-end justify-between">
        <div className="grid grid-cols-6 gap-3 items-end flex-1 min-w-0">
          <div className="col-span-2">
            <label className="block text-xs font-semibold text-slate-700">
              Filtrar por producto
            </label>
            <input
              className="w-full border rounded-md px-3 py-2"
              value={searchProduct}
              onChange={(e) => setSearchProduct(e.target.value)}
              onClick={() => {
                setSearchProduct("");
                setSearchCode("");
                setPackagingFilter("");
                setMinPrice("");
                setMaxPrice("");
              }}
              onFocus={() => {
                setSearchProduct("");
                setSearchCode("");
                setPackagingFilter("");
                setMinPrice("");
                setMaxPrice("");
              }}
              placeholder="Ej: Conitos, Gomitas…"
            />
          </div>

          <div>
            <MobileHtmlSelect
              label="Tipo empaque"
              value={packagingFilter}
              onChange={setPackagingFilter}
              options={EMPAQUE_TYPE_OPTIONS}
              selectClassName="w-full border rounded-md px-3 py-2"
              sheetTitle="Tipo empaque"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">
              Precio mín
            </label>
            <input
              className="w-full border rounded-md px-3 py-2 text-right"
              inputMode="decimal"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700">
              Precio máx
            </label>
            <input
              className="w-full border rounded-md px-3 py-2 text-right"
              inputMode="decimal"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="text-right">
            <Button
              type="button"
              variant="secondary"
              size="sm"
              className="!rounded-md px-3 py-2 text-xs"
              onClick={clearFilters}
            >
              Limpiar
            </Button>
          </div>
        </div>
        {isAdminEditable && (
          <div className="shrink-0">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="!rounded-md px-3 py-2 text-xs whitespace-nowrap"
              onClick={(e) =>
                setAdminToolsMenuRect(e.currentTarget.getBoundingClientRect())
              }
            >
              Más acciones ▾
            </Button>
          </div>
        )}
        </div>

        <div className="mt-3 flex items-center justify-between">
          <div className="text-xs text-slate-600">
            Precios de venta: <b>current_prices</b> • Catálogo y costos:{" "}
            <b>products_candies</b>.
          </div>
          <div className="text-sm">
            <span className="text-slate-600">Mostrando:</span>{" "}
            <b>{filtered.length}</b>
          </div>
        </div>
      </div>

      {/* ===== MOBILE: lista/cards (COMPACTO) ===== */}
      <div className="md:hidden">
        {loading ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Cargando…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Sin resultados.
          </div>
        ) : (
          <div className="space-y-2">
            {pagedByCategory.map(([cat, items], catIdx) => {
              const expandedCategory = openMobileCategory === cat;
              const categoryCardPalette = [
                "bg-gradient-to-br from-amber-50 via-orange-50/90 to-amber-100/80 border-amber-200/90",
                "bg-gradient-to-br from-sky-50 via-cyan-50/90 to-sky-100/80 border-sky-200/90",
                "bg-gradient-to-br from-violet-50 via-purple-50/90 to-violet-100/80 border-violet-200/90",
                "bg-gradient-to-br from-emerald-50 via-teal-50/90 to-emerald-100/80 border-emerald-200/90",
                "bg-gradient-to-br from-rose-50 via-pink-50/90 to-rose-100/80 border-rose-200/90",
                "bg-gradient-to-br from-indigo-50 via-blue-50/90 to-indigo-100/80 border-indigo-200/90",
              ];
              const catCardClass =
                categoryCardPalette[catIdx % categoryCardPalette.length];
              return (
                <div
                  key={cat}
                  className={`rounded-2xl border shadow-sm overflow-hidden ${catCardClass}`}
                >
                  <Button
                    type="button"
                    variant="ghost"
                    size="md"
                    className="w-full !justify-between !rounded-none px-3 py-3 text-left active:!bg-white/40 shadow-none border-0 !font-normal"
                    onClick={() => toggleCategory(cat)}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        {cat}
                      </div>
                      <div className="text-[12px] text-gray-600 truncate">
                        {items.length}{" "}
                        {items.length === 1 ? "Producto" : "Productos"}
                      </div>
                    </div>
                    <div className="text-sm font-semibold text-slate-800">
                      {expandedCategory ? "Cerrar" : "Ver"}
                    </div>
                  </Button>

                  {expandedCategory && (
                    <div className="px-3 pb-3 border-t border-white/50 bg-white/60 space-y-2">
                      {items.map((r) => {
                        const expanded = openCardId === r.productId;
                        const isEditingCatalog = editingId === r.productId;
                        const providerPrice = Number.isFinite(
                          Number(r.providerPrice),
                        )
                          ? (r.providerPrice as number)
                          : providerPriceMap[r.productId] || 0;
                        const utilidad = r.priceIsla - (providerPrice || 0);
                        const uvKey = normKey(r.productName || r.productId);
                        const uvKeyPid = normKey(String(r.productId || ""));
                        const uvXpaqVal =
                          uvxpaqMap[uvKey] ??
                          (uvKeyPid && uvKeyPid !== uvKey
                            ? uvxpaqMap[uvKeyPid]
                            : undefined);
                        const uvAvg = uvxpaqAvgMap[uvKey];
                        const uvLabel = (() => {
                          if (sellerCandyId) {
                            return Number.isFinite(Number(uvXpaqVal))
                              ? money(uvXpaqVal)
                              : "--";
                          }
                          if (isAdmin) {
                            return Number.isFinite(Number(uvAvg))
                              ? money(uvAvg)
                              : "--";
                          }
                          return Number.isFinite(Number(uvAvg))
                            ? money(uvAvg)
                            : "--";
                        })();
                        const priceImageUrl = String(
                          priceDocsById[r.productId]?.imageUrl ||
                            r.imageUrl ||
                            "",
                        ).trim();
                        return (
                          <div
                            key={r.productId}
                            className="bg-white border rounded-xl overflow-hidden mt-2"
                          >
                            <Button
                              type="button"
                              variant="ghost"
                              size="md"
                              className="w-full !justify-between !rounded-none px-3 py-3 text-left shadow-none border-0 !font-normal"
                              onClick={() => {
                                setOpenCardId((cur) =>
                                  cur === r.productId ? null : r.productId,
                                );
                              }}
                            >
                              <div className="min-w-0">
                                <div className="text-[13px] font-semibold truncate">
                                  {r.productName}
                                </div>
                                <div className="text-[10px] text-gray-600 truncate">
                                  {r.category}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-[12px] text-emerald-800/80">
                                  Precio Isla
                                </div>
                                <div className="text-sm font-bold tabular-nums text-emerald-600">
                                  {money(r.priceIsla)}
                                </div>
                              </div>
                            </Button>

                            {expanded && (
                              <div className="px-3 pb-3 border-t">
                                <div className="pt-3 space-y-2 text-sm">
                                  <div className="grid grid-cols-2 gap-x-3 gap-y-3 items-start">
                                    {/* fila 1 */}
                                    <div className="min-w-0">
                                      <div className="text-[12px] text-gray-600">
                                        Categoría
                                      </div>
                                      <div className="text-sm font-semibold">
                                        {r.category}
                                      </div>
                                    </div>
                                    <div className="min-w-0">
                                      {isAdminEditable ? (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Utilidad Bruta
                                          </div>
                                          <div className="text-sm tabular-nums">
                                            {money(utilidad)}
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Comision x Paquete Vendido
                                          </div>
                                          <div className="text-sm tabular-nums">
                                            {uvLabel}
                                          </div>
                                        </>
                                      )}
                                    </div>

                                    {/* fila 2 */}
                                    <div className="min-w-0">
                                      <div className="text-[12px] text-emerald-800/80">
                                        Precio Isla (paq)
                                      </div>
                                      <div className="text-sm font-bold tabular-nums text-emerald-600">
                                        {money(r.priceIsla)}
                                      </div>
                                    </div>
                                    <div className="min-w-0">
                                      {isAdminEditable ? (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Comision x Paquete Vendido
                                          </div>
                                          <div className="text-sm tabular-nums">
                                            {uvLabel}
                                          </div>
                                        </>
                                      ) : (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Código EAN
                                          </div>
                                          {isEditingCatalog ? (
                                            <div className="flex gap-2">
                                              <input
                                                className="flex-1 border rounded px-2 py-2 min-w-0"
                                                value={editBarcode}
                                                onChange={(e) =>
                                                  setEditBarcode(e.target.value)
                                                }
                                                placeholder="EAN"
                                              />
                                              <Button
                                                type="button"
                                                variant="primary"
                                                size="sm"
                                                className="!rounded-md px-3 py-2 text-sm shrink-0"
                                                onClick={() => {
                                                  setScanTarget("edit");
                                                  setScanBarcodeProductId(
                                                    r.productId,
                                                  );
                                                  setScanOpen(true);
                                                }}
                                              >
                                                Escanear
                                              </Button>
                                            </div>
                                          ) : (
                                            <div>
                                              {barcodeMap[r.productId] || "—"}
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>

                                    {/* fila 3 */}
                                    <div className="min-w-0">
                                      <div className="text-[12px] text-emerald-800/80">
                                        Precio x Unidad
                                      </div>
                                      <div className="text-sm font-bold tabular-nums text-emerald-600">
                                        {money(
                                          r.priceIsla /
                                            (r.unitsPerPackage || 1),
                                        )}
                                      </div>
                                    </div>
                                    <div className="min-w-0">
                                      {isAdminEditable ? (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Código EAN
                                          </div>
                                          {isEditingCatalog ? (
                                            <div className="flex gap-2">
                                              <input
                                                className="flex-1 border rounded px-2 py-2 min-w-0"
                                                value={editBarcode}
                                                onChange={(e) =>
                                                  setEditBarcode(e.target.value)
                                                }
                                                placeholder="EAN"
                                              />
                                              <Button
                                                type="button"
                                                variant="primary"
                                                size="sm"
                                                className="!rounded-md px-3 py-2 text-sm shrink-0"
                                                onClick={() => {
                                                  setScanTarget("edit");
                                                  setScanBarcodeProductId(
                                                    r.productId,
                                                  );
                                                  setScanOpen(true);
                                                }}
                                              >
                                                Escanear
                                              </Button>
                                            </div>
                                          ) : (
                                            <div>
                                              {barcodeMap[r.productId] || "—"}
                                            </div>
                                          )}
                                        </>
                                      ) : (
                                        <>
                                          <div className="text-[12px] text-gray-600">
                                            Tipo Empaque
                                          </div>
                                          {isEditingCatalog ? (
                                            <MobileHtmlSelect
                                              value={editPackaging}
                                              onChange={setEditPackaging}
                                              options={EMPAQUE_EDIT_OPTIONS}
                                              selectClassName="w-full border rounded px-2 py-2"
                                              sheetTitle="Tipo empaque"
                                            />
                                          ) : (
                                            <div className="text-sm">
                                              {packagingMap[r.productId] || "—"}
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>

                                    {isAdminEditable && (
                                      <>
                                        <div className="min-w-0">
                                          <div className="text-[12px] text-gray-600">
                                            Costo Paq
                                          </div>
                                          <div className="text-sm font-semibold tabular-nums">
                                            {money(providerPrice || 0)}
                                          </div>
                                        </div>
                                        <div className="min-w-0">
                                          <div className="text-[12px] text-gray-600">
                                            Tipo Empaque
                                          </div>
                                          {isEditingCatalog ? (
                                            <MobileHtmlSelect
                                              value={editPackaging}
                                              onChange={setEditPackaging}
                                              options={EMPAQUE_EDIT_OPTIONS}
                                              selectClassName="w-full border rounded px-2 py-2"
                                              sheetTitle="Tipo empaque"
                                            />
                                          ) : (
                                            <div className="text-sm">
                                              {packagingMap[r.productId] || "—"}
                                            </div>
                                          )}
                                        </div>
                                      </>
                                    )}

                                    {/* Unidades | Mi inventario */}
                                    <div className="min-w-0">
                                      <div className="text-[12px] text-gray-600">
                                        Unidades x paquete
                                      </div>
                                      <div className="text-sm font-semibold">
                                        {String(r.unitsPerPackage || 1)}
                                      </div>
                                    </div>
                                    <div className="min-w-0">
                                      <div className="text-[12px] text-gray-600">
                                        Mi inventario
                                      </div>
                                      <div className="text-sm font-semibold tabular-nums text-indigo-800">
                                        {packsMiDisplay(r.productId)}
                                      </div>
                                      <div className="text-[10px] text-gray-500">
                                        {sellerCandyId
                                          ? "Tu pedido vendedor"
                                          : "Asigná vendedor en tu usuario"}
                                      </div>
                                    </div>
                                  </div>

                                  <div className="rounded-lg border border-slate-200 bg-slate-50/90 px-2 py-2">
                                    <div className="text-[12px] text-slate-700/90">
                                      Stock
                                    </div>
                                    <div className="text-sm font-semibold tabular-nums text-slate-900">
                                      {packsStockDisplay(r.productId)}
                                    </div>
                                    <div className="text-[10px] text-slate-600/90">
                                      Paq. en órdenes maestras
                                    </div>
                                  </div>

                                  <div className="rounded-lg border border-amber-100 bg-amber-50/80 px-2 py-2">
                                    <div className="text-[12px] text-amber-900/80">
                                      Otro vendedor
                                    </div>
                                    <div className="text-sm font-semibold tabular-nums text-amber-900">
                                      {packsOtroDisplay(r.productId)}
                                    </div>
                                    <div className="text-[10px] text-amber-800/80">
                                      {sellerCandyId
                                        ? "Paquetes en otros vendedores"
                                        : "Iniciá sesión como vendedor para ver reparto"}
                                    </div>
                                  </div>

                                  {/* actions */}
                                  <div className="flex flex-wrap gap-2">
                                    {isEditingCatalog ? (
                                      <>
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          className="!rounded-md px-3 py-2 text-sm !bg-green-600 hover:!bg-green-700 shadow-green-600/15"
                                          onClick={() => {
                                            saveEditedPrices(r.productId);
                                            setOpenCardId(null);
                                          }}
                                        >
                                          Guardar
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          className="!rounded-md px-3 py-2 text-sm !bg-gray-800 hover:!bg-gray-900 shadow-none"
                                          onClick={() => {
                                            setScanTarget("edit");
                                            setScanOpen(true);
                                          }}
                                        >
                                          Escanear
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="secondary"
                                          size="sm"
                                          className="!rounded-md px-3 py-2 text-sm"
                                          onClick={() => setEditingId(null)}
                                        >
                                          Cancelar
                                        </Button>
                                      </>
                                    ) : (
                                      <>
                                        {isAdminEditable && (
                                          <>
                                            <Button
                                              type="button"
                                              variant="primary"
                                              size="sm"
                                              className="!rounded-md px-3 py-2 text-sm shrink-0 !bg-slate-600 hover:!bg-slate-700 shadow-none"
                                              aria-label="Información de precio"
                                              onClick={() =>
                                                setPriceInfoProductId(
                                                  r.productId,
                                                )
                                              }
                                            >
                                              <FiInfo className="w-4 h-4" />
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="primary"
                                              size="sm"
                                              className="inline-flex items-center justify-center w-10 h-10 !rounded-md !bg-green-600 hover:!bg-green-700 shrink-0 shadow-green-600/15 !p-0"
                                              aria-label="Editar precio y empaque"
                                              title="Editar precio, empaque y EAN"
                                              onClick={() =>
                                                openPriceModalEdit(r)
                                              }
                                            >
                                              <FiEdit2 className="w-5 h-5" />
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="primary"
                                              size="sm"
                                              disabled={!priceImageUrl}
                                              className="inline-flex items-center justify-center w-10 h-10 !rounded-md !bg-sky-600 hover:!bg-sky-700 shrink-0 !p-0 disabled:!bg-slate-300 disabled:hover:!bg-slate-300"
                                              aria-label={
                                                priceImageUrl
                                                  ? "Ver foto del producto"
                                                  : "Sin foto cargada"
                                              }
                                              title={
                                                priceImageUrl
                                                  ? "Ver foto"
                                                  : "Sin foto (solo administración puede subirla)"
                                              }
                                              onClick={() => {
                                                if (priceImageUrl)
                                                  setMobilePriceImagePreviewUrl(
                                                    priceImageUrl,
                                                  );
                                              }}
                                            >
                                              <FiImage className="w-5 h-5" />
                                            </Button>
                                            <Button
                                              type="button"
                                              variant="danger"
                                              size="sm"
                                              className="inline-flex items-center justify-center w-10 h-10 !rounded-md shrink-0 !p-0"
                                              aria-label="Eliminar precio"
                                              title="Eliminar precio"
                                              onClick={() =>
                                                deleteCurrentPrice(r.productId)
                                              }
                                            >
                                              <FiTrash2 className="w-5 h-5" />
                                            </Button>
                                          </>
                                        )}
                                        {!isAdminEditable && (
                                          <Button
                                            type="button"
                                            variant="primary"
                                            size="sm"
                                            disabled={!priceImageUrl}
                                            className="inline-flex items-center justify-center w-10 h-10 !rounded-md !bg-sky-600 hover:!bg-sky-700 shrink-0 !p-0 disabled:!bg-slate-300 disabled:hover:!bg-slate-300"
                                            aria-label={
                                              priceImageUrl
                                                ? "Ver foto del producto"
                                                : "Sin foto cargada"
                                            }
                                            title={
                                              priceImageUrl
                                                ? "Ver foto"
                                                : "Sin foto (solo administración puede subirla)"
                                            }
                                            onClick={() => {
                                              if (priceImageUrl)
                                                setMobilePriceImagePreviewUrl(
                                                  priceImageUrl,
                                                );
                                            }}
                                          >
                                            <FiImage className="w-5 h-5" />
                                          </Button>
                                        )}
                                      </>
                                    )}
                                  </div>
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
            })}
          </div>
        )}

        {!loading && filteredByCategory.length > 0 && renderPager()}
        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>

      {/* NEW PRICE MODAL */}
      {newPriceOpen && (
        <div
          className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4 md:p-6"
          role="dialog"
          aria-modal="true"
        >
          <div className="bg-white w-full max-w-md max-h-[90vh] overflow-y-auto rounded-2xl shadow-lg border p-4 mx-auto">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">
                {priceModalMode === "edit"
                  ? "Editar precio"
                  : "Nuevo precio manual"}
              </h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="!rounded-lg px-2 py-1"
                onClick={() => {
                  setNewPriceOpen(false);
                  setSearchNewProduct("");
                  setPriceModalMode("create");
                  setNewPriceUnits("");
                  setNewPriceBarcode("");
                  setNewPricePackaging("");
                  setNewPriceImageUrl("");
                  setRemovePriceImage(false);
                }}
              >
                Cerrar
              </Button>
            </div>

            <div className="space-y-3 text-sm">
              <div>
                <MobileHtmlSelect
                  label="Categoría"
                  value={newPriceCategory}
                  disabled={priceModalMode === "edit"}
                  onChange={(v) => {
                    setNewPriceCategory(v);
                    setNewPriceProductId("");
                  }}
                  options={[
                    { value: "", label: "— Seleccioná —" },
                    ...modalCategories.map((c) => ({
                      value: c,
                      label: c,
                    })),
                  ]}
                  selectClassName="w-full border rounded px-2 py-2 disabled:bg-slate-100 disabled:text-slate-600"
                  sheetTitle="Categoría"
                />
              </div>

              <div>
                <label className="block font-semibold">Buscar producto</label>
                <input
                  className="w-full border rounded px-2 py-2 disabled:bg-slate-100"
                  value={searchNewProduct}
                  onChange={(e) => setSearchNewProduct(e.target.value)}
                  placeholder="Nombre o ID"
                  type="search"
                  autoComplete="off"
                  disabled={priceModalMode === "edit"}
                />
              </div>

              <div>
                <MobileHtmlSelect
                  label="Producto"
                  value={newPriceProductId}
                  disabled={priceModalMode === "edit"}
                  onChange={setNewPriceProductId}
                  options={[
                    { value: "", label: "— Seleccioná —" },
                    ...modalProductOptions.map((r) => ({
                      value: r.productId,
                      label: `${r.productName} — ${r.productId}`,
                    })),
                  ]}
                  selectClassName="w-full border rounded px-2 py-2 disabled:bg-slate-100 disabled:text-slate-600"
                  sheetTitle="Producto"
                />
              </div>

              {newPriceProductId ? (
                <div className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-2 text-sm text-slate-700">
                  <div className="font-semibold text-slate-600 mb-1">
                    Precio costo (referencia)
                  </div>
                  <div>Por paquete: {money(newPriceCostDisplay ?? 0)}</div>
                  <p className="text-xs text-slate-500 mt-1">
                    Información del catálogo (products_candies); no se guarda en
                    current_prices.
                  </p>
                </div>
              ) : null}

              {/* <div>
                <label className="block font-semibold">
                  Unidades por paquete
                </label>
                <input
                  className="w-full border rounded px-2 py-2 text-right"
                  inputMode="numeric"
                  value={newPriceUnits}
                  onChange={(e) =>
                    setNewPriceUnits(String(e.target.value).replace(/[^0-9]/g, ""))
                  }
                  placeholder="1"
                  disabled={!newPriceProductId}
                />
              </div> */}

              <div>
                <label className="block font-semibold">Código EAN</label>
                <div className="flex gap-2">
                  <input
                    className="flex-1 border rounded px-2 py-2"
                    value={newPriceBarcode}
                    onChange={(e) => setNewPriceBarcode(e.target.value)}
                    placeholder="Escaneá o escribí el código"
                    autoComplete="off"
                    disabled={!newPriceProductId}
                  />
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="shrink-0 !rounded-md px-3 py-2 text-sm"
                    disabled={!newPriceProductId}
                    onClick={() => {
                      if (!newPriceProductId) return;
                      setScanTarget("edit");
                      setScanBarcodeProductId(newPriceProductId);
                      setScanOpen(true);
                    }}
                  >
                    Escanear
                  </Button>
                </div>
              </div>

              <div>
                <MobileHtmlSelect
                  label="Tipo empaque"
                  value={newPricePackaging}
                  onChange={setNewPricePackaging}
                  disabled={!newPriceProductId}
                  options={EMPAQUE_EDIT_OPTIONS}
                  selectClassName="w-full border rounded px-2 py-2"
                  sheetTitle="Tipo empaque"
                />
              </div>

              {isAdminEditable && !isPublicView && newPriceProductId ? (
                <div className="rounded-lg border border-slate-200 bg-slate-50/90 px-3 py-2">
                  <div className="font-semibold text-slate-800">
                    Foto del producto (opcional)
                  </div>
                  <p className="text-xs text-slate-500 mt-0.5 mb-2">
                    Archivo en{" "}
                    <span className="font-mono text-[11px]">
                      Firebase Storage
                    </span>
                    ; la URL pública queda en el documento{" "}
                    <span className="font-mono text-[11px]">
                      current_prices/{newPriceProductId}
                    </span>{" "}
                    campo <span className="font-mono text-[11px]">imageUrl</span>
                    .
                  </p>
                  {(() => {
                    const previewUrl = removePriceImage
                      ? ""
                      : String(
                          newPriceImageUrl ||
                            priceDocsById[newPriceProductId]?.imageUrl ||
                            "",
                        ).trim();
                    return (
                      <>
                        {previewUrl ? (
                          <img
                            src={previewUrl}
                            alt=""
                            className="mb-2 max-h-36 w-full rounded-lg border border-slate-200 bg-white object-contain"
                          />
                        ) : null}
                        <div className="flex flex-wrap items-center gap-2">
                          <input
                            type="file"
                            accept="image/*"
                            className="hidden"
                            id="precio-venta-modal-img"
                            onChange={handlePickPriceImage}
                            disabled={priceImageUploading}
                          />
                          <label
                            htmlFor="precio-venta-modal-img"
                            className={`inline-flex cursor-pointer items-center rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm shadow-sm ${
                              priceImageUploading
                                ? "pointer-events-none opacity-50"
                                : ""
                            }`}
                          >
                            {priceImageUploading
                              ? "Subiendo…"
                              : previewUrl
                                ? "Cambiar imagen"
                                : "Subir imagen"}
                          </label>
                          {!removePriceImage &&
                          (String(newPriceImageUrl).trim() ||
                            String(
                              priceDocsById[newPriceProductId]?.imageUrl || "",
                            ).trim()) ? (
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="!rounded-md"
                              disabled={priceImageUploading}
                              onClick={() => {
                                setRemovePriceImage(true);
                                setNewPriceImageUrl("");
                              }}
                            >
                              Quitar foto
                            </Button>
                          ) : null}
                        </div>
                      </>
                    );
                  })()}
                </div>
              ) : null}

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block font-semibold">
                    Precio Isla (paq)
                  </label>
                  <input
                    className="w-full border rounded px-2 py-2 text-right"
                    inputMode="decimal"
                    value={newPriceIsla}
                    onChange={(e) =>
                      setNewPriceIsla(
                        String(e.target.value).replace(/[^0-9.,]/g, ""),
                      )
                    }
                    placeholder="0"
                  />
                </div>
                <div>
                  <label className="block font-semibold">
                    Precio Rivas (paq)
                  </label>
                  <input
                    className="w-full border rounded px-2 py-2 text-right"
                    inputMode="decimal"
                    value={newPriceRivas}
                    onChange={(e) =>
                      setNewPriceRivas(
                        String(e.target.value).replace(/[^0-9.,]/g, ""),
                      )
                    }
                    placeholder="0"
                  />
                </div>
              </div>

              <div className="flex flex-col-reverse sm:flex-row items-stretch sm:items-center gap-2 sm:justify-end">
                <Button
                  type="button"
                  variant="secondary"
                  size="md"
                  className="!rounded-lg px-3 py-2 w-full sm:w-auto"
                  onClick={() => {
                    setNewPriceOpen(false);
                    setSearchNewProduct("");
                    setPriceModalMode("create");
                    setNewPriceUnits("");
                    setNewPriceBarcode("");
                    setNewPricePackaging("");
                    setNewPriceImageUrl("");
                    setRemovePriceImage(false);
                  }}
                >
                  Cancelar
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  size="md"
                  className={`!rounded-lg px-3 py-2 w-full sm:w-auto ${canCreateManualPrice ? "!bg-green-600 hover:!bg-green-700 shadow-green-600/15" : "!bg-gray-300 !opacity-60 cursor-not-allowed hover:!bg-gray-300"}`}
                  onClick={() => canCreateManualPrice && createManualPrice()}
                  disabled={!canCreateManualPrice}
                >
                  {priceModalMode === "edit" ? "Guardar cambios" : "Crear precio"}
                </Button>
              </div>
            </div>
          </div>
        </div>
      )}

      {successPriceOverlay && (
        <div
          className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4"
          role="alertdialog"
          aria-modal="true"
          onClick={() => setSuccessPriceOverlay(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border max-w-sm w-full p-5"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-lg font-bold text-green-700 mb-3">
              Precio cargado correctamente
            </div>
            <ul className="text-sm space-y-2 text-slate-800">
              <li>
                <span className="text-slate-500">Categoría: </span>
                {successPriceOverlay.category}
              </li>
              <li>
                <span className="text-slate-500">Producto: </span>
                {successPriceOverlay.productName}
              </li>
              <li>
                <span className="text-slate-500">Precio Isla (paq): </span>
                {money(successPriceOverlay.isla)}
              </li>
              <li>
                <span className="text-slate-500">Precio Rivas (paq): </span>
                {money(successPriceOverlay.rivas)}
              </li>
            </ul>
            <Button
              type="button"
              variant="primary"
              size="md"
              className="mt-4 w-full py-3 !rounded-xl md:py-2 md:!rounded-lg !bg-slate-800 hover:!bg-slate-900 shadow-none"
              onClick={() => setSuccessPriceOverlay(null)}
            >
              Aceptar
            </Button>
          </div>
        </div>
      )}

      {mobilePriceImagePreviewUrl && (
        <div
          className="fixed inset-0 z-[85] flex items-center justify-center bg-black/60 p-4"
          role="dialog"
          aria-modal="true"
          aria-label="Foto del producto"
          onClick={() => setMobilePriceImagePreviewUrl(null)}
        >
          <img
            src={mobilePriceImagePreviewUrl}
            alt=""
            className="max-h-[min(85vh,36rem)] w-auto max-w-[min(32rem,calc(100vw-2rem))] rounded-xl border border-white/20 object-contain shadow-2xl md:max-w-[min(40rem,calc(100vw-3rem))]"
            onClick={(e) => e.stopPropagation()}
          />
        </div>
      )}

      {priceInfoProductId && (
        <div
          className="fixed inset-0 z-[55] flex items-center justify-center bg-black/50 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => setPriceInfoProductId(null)}
        >
          <div
            className="bg-white rounded-2xl shadow-xl border max-w-md w-full p-4 max-h-[85vh] overflow-y-auto"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold">Información de precio</h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="!rounded-lg px-2 py-1 text-sm"
                onClick={() => setPriceInfoProductId(null)}
              >
                Cerrar
              </Button>
            </div>
            {(() => {
              const pid = priceInfoProductId;
              const r = rows.find((x) => x.productId === pid);
              const p = priceDocsById[pid];
              const name =
                p?.productName || r?.productName || pid;
              const cat = p?.category || r?.category || "—";
              const prevI = Number(p?.previousPackagePriceIsla ?? 0);
              const prevR = Number(p?.previousPackagePriceRivas ?? 0);
              const prov = Math.max(
                0,
                Number(
                  providerPriceMap[pid] ?? catalogById[pid]?.providerPrice ?? 0,
                ),
              );
              const pkgIsla = Number(r?.priceIsla ?? 0);
              const pkgRivas = Number(r?.priceRivas ?? 0);
              const marginIsla =
                p?.marginIsla != null && Number.isFinite(Number(p.marginIsla))
                  ? Number(p.marginIsla)
                  : deriveMarginPercentFromSubtotalAndTotal(prov, pkgIsla);
              const marginRivas =
                p?.marginRivas != null && Number.isFinite(Number(p.marginRivas))
                  ? Number(p.marginRivas)
                  : deriveMarginPercentFromSubtotalAndTotal(prov, pkgRivas);
              return (
                <div className="text-sm space-y-2 text-slate-800">
                  <div>
                    <span className="text-slate-500">Producto: </span>
                    {name}
                  </div>
                  <div>
                    <span className="text-slate-500">Categoría: </span>
                    {cat}
                  </div>
                  <div>
                    <span className="text-slate-500">
                      Último precio Isla (paq):{" "}
                    </span>
                    {money(r?.priceIsla ?? 0)}
                  </div>
                  <div>
                    <span className="text-slate-500">
                      Último precio Rivas (paq):{" "}
                    </span>
                    {money(r?.priceRivas ?? 0)}
                  </div>
                  <div>
                    <span className="text-slate-500">Margen Isla (%): </span>
                    {marginIsla.toFixed(2)}%
                  </div>
                  <div>
                    <span className="text-slate-500">Margen Rivas (%): </span>
                    {marginRivas.toFixed(2)}%
                  </div>
                  <div>
                    <span className="text-slate-500">
                      Precio anterior Isla (paq):{" "}
                    </span>
                    {money(prevI)}
                  </div>
                  <div>
                    <span className="text-slate-500">
                      Precio anterior Rivas (paq):{" "}
                    </span>
                    {money(prevR)}
                  </div>
                  <div>
                    <span className="text-slate-500">
                      Fecha últ. actualización:{" "}
                    </span>
                    {formatFirestoreTimestamp(p?.updatedAt)}
                  </div>
                  <div>
                    <span className="text-slate-500">Usuario: </span>
                    {[p?.updatedByDisplayName, p?.updatedByEmail]
                      .filter(Boolean)
                      .join(" — ") || "—"}
                  </div>
                </div>
              );
            })()}
          </div>
        </div>
      )}

      <ImportModal
        open={importOpen}
        onClose={() => setImportOpen(false)}
        onPickFile={handlePickFile}
        onDownloadTemplate={downloadTemplate}
        importFileName={importFileName}
        importLoading={importLoading}
        importErrors={importErrors}
      />

      <BarcodeScanModal
        open={scanOpen}
        onClose={() => {
          setScanOpen(false);
          setScanBarcodeProductId(null);
        }}
        onDetected={onDetected}
      />

      <ActionMenu
        anchorRect={adminToolsMenuRect}
        isOpen={!!adminToolsMenuRect}
        onClose={() => setAdminToolsMenuRect(null)}
        width={240}
      >
        <div className="py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={() => {
              setAdminToolsMenuRect(null);
              openPriceModalCreate();
            }}
          >
            Crear precio
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={async () => {
              setAdminToolsMenuRect(null);
              try {
                await downloadTemplate();
              } catch (e) {
                console.error(e);
                setMsg("❌ Error descargando template.");
              }
            }}
          >
            Descargar template
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={() => {
              setAdminToolsMenuRect(null);
              downloadPricesListXlsx();
            }}
          >
            Descargar listado
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={() => {
              setAdminToolsMenuRect(null);
              setImportOpen(true);
            }}
          >
            Importar
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={() => {
              setAdminToolsMenuRect(null);
              saveAllCurrentPrices();
            }}
          >
            Guardar precios actuales
          </Button>
        </div>
      </ActionMenu>

      <ActionMenu
        anchorRect={rowActionMenu?.rect ?? null}
        isOpen={!!rowActionMenu}
        onClose={() => setRowActionMenu(null)}
        width={240}
      >
        {rowActionMenu &&
          (() => {
            const r = rows.find((x) => x.productId === rowActionMenu.productId);
            if (!r) {
              return (
                <div className="px-3 py-2 text-sm text-slate-500">
                  Sin datos
                </div>
              );
            }
            return (
              <div className="py-1">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                  onClick={() => {
                    setRowActionMenu(null);
                    setPriceInfoProductId(r.productId);
                  }}
                >
                  Información
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                  onClick={() => {
                    setRowActionMenu(null);
                    openPriceModalEdit(r);
                  }}
                >
                  Editar precio
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
                  onClick={() => {
                    setRowActionMenu(null);
                    setScanBarcodeProductId(r.productId);
                    setScanTarget("edit");
                    setScanOpen(true);
                  }}
                >
                  Escanear código
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700"
                  onClick={() => {
                    setRowActionMenu(null);
                    void deleteCurrentPrice(r.productId);
                  }}
                >
                  Borrar precio
                </Button>
              </div>
            );
          })()}
      </ActionMenu>

      {/* ===== WEB: tabla ===== */}
      <div className="hidden md:block rounded-xl overflow-x-auto border border-slate-200 shadow-sm w-full">
        <table className="min-w-[940px] w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr className="whitespace-nowrap text-[11px] uppercase tracking-wider text-slate-600">
              <th className="p-3 border-b text-left">Categoría</th>
              <th className="p-3 border-b text-left">Producto</th>
              <th className="p-3 border-b text-center w-[3.25rem]">Foto</th>
              <th className="p-3 border-b text-left">Empaque</th>
              <th className="p-3 border-b text-right">Und x paquete</th>
              <th className="p-3 border-b text-right" title="Paquetes en órdenes maestras">
                Stock
              </th>
              <th className="p-3 border-b text-right" title="Tu subinventario (vendedor logueado)">
                Mi inventario
              </th>
              <th className="p-3 border-b text-right" title="Otros vendedores">
                Otro vendedor
              </th>
              <th className="p-3 border-b text-right">Precio x unidad</th>
              {isAdmin && <th className="p-3 border-b text-right">Costo</th>}
              <th className="p-3 border-b text-right">Precio Isla</th>
              <th className="p-3 border-b text-right">Precio Rivas</th>
              <th className="p-3 border-b text-right">UV x paquete</th>
              <th className="p-3 border-b text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={webColCount}>
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={webColCount}>
                  Sin resultados.
                </td>
              </tr>
            ) : (
              pagedWebRows.map((r) => {
                const rowImgUrl = String(
                  priceDocsById[r.productId]?.imageUrl || r.imageUrl || "",
                ).trim();
                return (
                <tr key={r.productId} className="odd:bg-white even:bg-slate-50">
                  <td className="p-3 border-b text-left">{r.category}</td>
                  <td className="p-3 border-b text-left">{r.productName}</td>
                  <td className="p-3 border-b text-center align-middle">
                    {rowImgUrl ? (
                      <button
                        type="button"
                        className="mx-auto flex h-10 w-10 items-center justify-center overflow-hidden rounded-lg border border-slate-200 bg-slate-50 shadow-sm transition hover:ring-2 hover:ring-sky-400 focus:outline-none focus:ring-2 focus:ring-sky-500"
                        title="Ver foto"
                        aria-label="Ver foto del producto"
                        onClick={() =>
                          setMobilePriceImagePreviewUrl(rowImgUrl)
                        }
                      >
                        <img
                          src={rowImgUrl}
                          alt=""
                          className="h-full w-full object-cover"
                          loading="lazy"
                        />
                      </button>
                    ) : (
                      <span className="text-slate-300 tabular-nums">—</span>
                    )}
                  </td>
                  <td className="p-3 border-b text-left">
                    {packagingMap[r.productId] || "—"}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums">
                    {String(r.unitsPerPackage || 1)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums text-slate-800">
                    {packsStockDisplay(r.productId)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums text-indigo-800">
                    {packsMiDisplay(r.productId)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums text-amber-700">
                    {packsOtroDisplay(r.productId)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums">
                    {money(r.priceIsla / (r.unitsPerPackage || 1))}
                  </td>
                  {isAdminEditable && (
                    <td className="p-3 border-b text-right tabular-nums">
                      {(() => {
                        const rowProvider = Number.isFinite(
                          Number(r.providerPrice),
                        )
                          ? (r.providerPrice as number)
                          : providerPriceMap[r.productId] || 0;
                        return money(rowProvider || 0);
                      })()}
                    </td>
                  )}
                  <td className="p-3 border-b text-right tabular-nums">
                    {money(r.priceIsla)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums">
                    {money(r.priceRivas)}
                  </td>
                  <td className="p-3 border-b text-right tabular-nums">
                    {(() => {
                      const uvKey = normKey(r.productName || r.productId);
                      const uvKeyPid = normKey(String(r.productId || ""));
                      const uvXpaqVal =
                        uvxpaqMap[uvKey] ??
                        (uvKeyPid && uvKeyPid !== uvKey
                          ? uvxpaqMap[uvKeyPid]
                          : undefined);
                      const uvAvg = uvxpaqAvgMap[uvKey];
                      if (sellerCandyId) {
                        return Number.isFinite(Number(uvXpaqVal))
                          ? money(uvXpaqVal)
                          : "--";
                      }
                      if (isAdmin) {
                        return Number.isFinite(Number(uvAvg))
                          ? money(uvAvg)
                          : "--";
                      }
                      return Number.isFinite(Number(uvAvg))
                        ? money(uvAvg)
                        : "--";
                    })()}
                  </td>
                  <td className="p-3 border-b text-right">
                    {isAdminEditable && (
                      <ActionMenuTrigger
                        className="!h-8 !w-8"
                        aria-label="Acciones"
                        iconClassName="h-4 w-4 text-gray-700"
                        onClick={(e) => {
                          e.stopPropagation();
                          setRowActionMenu({
                            productId: r.productId,
                            rect: e.currentTarget.getBoundingClientRect(),
                          });
                        }}
                      />
                    )}
                  </td>
                </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      <div className="hidden md:block">
        {!loading && filtered.length > 0 && renderWebPager()}
      </div>

      {/* msg para web (móvil ya lo muestra arriba) */}
      {msg && <p className="hidden md:block mt-2 text-sm">{msg}</p>}
    </div>
  );
}
