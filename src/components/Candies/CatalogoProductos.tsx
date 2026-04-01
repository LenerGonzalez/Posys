import React, { useEffect, useMemo, useRef, useState } from "react";
import { BrowserMultiFormatReader, IScannerControls } from "@zxing/browser";
import * as XLSX from "xlsx";
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  limit,
  orderBy,
  query,
  updateDoc,
  writeBatch,
  Timestamp,
  onSnapshot,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { syncCatalogProductDependents } from "../../Services/syncCatalogProductDependents";
import RefreshButton from "../common/RefreshButton";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import Button from "../common/Button";
import Toast from "../common/Toast";
import ActionMenu, { ActionMenuTrigger } from "../common/ActionMenu";
import useManualRefresh from "../../hooks/useManualRefresh";

type CandyProduct = {
  id: string;
  name: string;
  category: string;
  providerPrice: number; // por paquete
  unitsPerPackage: number; // und por paquete
  barcode?: string; // ✅ NUEVO (opcional)
  packaging?: string; // Empaque: Tarro, Bolsa, Ristra, Caja, Vaso, Pana
  boxesCount?: number; // Cantidad Cajas (opcional)
  createdAt?: any;
};

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

const PACKAGING_OPTIONS: { value: string; label: string }[] = [
  { value: "Tarro", label: "Tarro" },
  { value: "Bolsa", label: "Bolsa" },
  { value: "Ristra", label: "Ristra" },
  { value: "Caja", label: "Caja" },
  { value: "Vaso", label: "Vaso" },
  { value: "Pana", label: "Pana" },
];

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

function roundInt(v: any, fallback = 1) {
  const n = Math.floor(toNum(v, fallback));
  return n > 0 ? n : fallback;
}

function isEmptyRow(obj: Record<string, any>) {
  const vals = Object.values(obj || {});
  return vals.every((v) => norm(v) === "");
}

/**
 * Detecta columna por múltiples nombres posibles (case-insensitive).
 */
function pickCol(row: Record<string, any>, candidates: string[]) {
  const keys = Object.keys(row || {});
  const map = new Map<string, string>();
  keys.forEach((k) => map.set(norm(k), k));

  for (const c of candidates) {
    const realKey = map.get(norm(c));
    if (realKey != null) return row[realKey];
  }
  return undefined;
}

type ImportRow = {
  id?: string; // ✅ opcional: si viene, actualiza directo por docId
  category: string;
  name: string;
  providerPrice: number;
  unitsPerPackage: number;
  barcode?: string; // ✅ opcional
  packaging?: string; // Empaque (opcional)
  _raw?: Record<string, any>;
};

// ============================
//  MODAL: Mostrar código
// ============================
function CodeModal({
  open,
  code,
  onClose,
}: {
  open: boolean;
  code: string;
  onClose: () => void;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3">
      <div className="bg-white w-full max-w-sm rounded-2xl shadow-lg border p-4">
        <div className="flex items-center justify-between mb-2">
          <div className="font-bold text-lg">Código de barras</div>
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
        <div className="bg-gray-50 border rounded-xl p-3">
          <div className="text-xs text-gray-600 mb-1">Valor</div>
          <div className="text-xl font-mono font-semibold break-all">
            {code}
          </div>
        </div>
        <div className="mt-3 flex gap-2 justify-end">
          <Button
            type="button"
            variant="primary"
            size="md"
            className="!rounded-lg px-3 py-2 !bg-indigo-600 hover:!bg-indigo-700 active:!bg-indigo-800 shadow-indigo-600/15"
            onClick={() => {
              try {
                navigator.clipboard?.writeText(code);
              } catch {}
            }}
          >
            Copiar
          </Button>
        </div>
      </div>
    </div>
  );
}

// ============================
//  MODAL: Escáner (ZXing)
//  ✅ FIX PERMISOS:
//  - NO enumeramos cámaras antes (en Android/iOS puede devolver vacío si no hay permiso)
//  - Primero forzamos getUserMedia para disparar el prompt de permisos
//  - Luego iniciamos decodeFromConstraints
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
        stream?.getTracks?.().forEach((t) => t.stop());
      } catch {}

      try {
        if (videoRef.current) videoRef.current.srcObject = null;
      } catch {}
    };

    const start = async () => {
      setErr("");

      try {
        if (!videoRef.current) return;

        // ✅ 1) Forzar prompt de permiso (warm-up)
        // Esto hace que Android/iOS muestren el permiso "Cámara" para el sitio.
        try {
          const warm = await navigator.mediaDevices.getUserMedia({
            video: { facingMode: { ideal: "environment" } },
            audio: false,
          });
          warm.getTracks().forEach((t) => t.stop());
        } catch (e: any) {
          // Si aquí falla por permiso, lo capturamos abajo igualmente.
        }

        // ✅ 2) Iniciar ZXing (esto también usa getUserMedia)
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

export default function ProductsCandies() {
  const { refreshKey, refresh } = useManualRefresh();

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // catálogo
  const [products, setProducts] = useState<CandyProduct[]>([]);

  // form manual
  const [category, setCategory] = useState("");
  const [categoryPickedNew, setCategoryPickedNew] = useState(false);
  const [name, setName] = useState("");
  const [providerPrice, setProviderPrice] = useState<number>(0);
  const [unitsPerPackage, setUnitsPerPackage] = useState<number>(1);
  const [barcode, setBarcode] = useState(""); // ✅ NUEVO
  const [packaging, setPackaging] = useState<string>(""); // Empaque (create)
  const [boxesCount, setBoxesCount] = useState<number>(1); // Cantidad Cajas

  // edición inline
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editCategory, setEditCategory] = useState("");
  const [editCategoryPickedNew, setEditCategoryPickedNew] = useState(false);
  const [editName, setEditName] = useState("");
  const [editProviderPrice, setEditProviderPrice] = useState<number>(0);
  const [editUnitsPerPackage, setEditUnitsPerPackage] = useState<number>(1);
  const [editBarcode, setEditBarcode] = useState(""); // ✅ NUEVO
  const [editPackaging, setEditPackaging] = useState<string>("");
  const [editBoxesCount, setEditBoxesCount] = useState<number>(0);
  const [editModalOpen, setEditModalOpen] = useState(false);

  // filtros
  const [search, setSearch] = useState("");
  const [searchCode, setSearchCode] = useState(""); // ✅ NUEVO
  const [packagingFilter, setPackagingFilter] = useState(""); // filtro Empaque

  // modal código
  const [codeModalOpen, setCodeModalOpen] = useState(false);
  const [codeModalValue, setCodeModalValue] = useState("");

  // escáner
  const [scanOpen, setScanOpen] = useState(false);
  const [scanTarget, setScanTarget] = useState<"create" | "edit" | "search">(
    "create",
  );

  // importación
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  // ✅ responsive simple
  const [isMobile, setIsMobile] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(max-width: 900px)");
    const update = () => setIsMobile(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, []);

  // ✅ colapsables (solo móvil nacen colapsados)
  const [createOpen, setCreateOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(true);
  useEffect(() => {
    if (isMobile) {
      setFiltersOpen(false);
    } else {
      setFiltersOpen(true);
    }
  }, [isMobile]);

  // ✅ cards colapsables en móvil
  const [openCardId, setOpenCardId] = useState<string | null>(null);
  const [categoryOpenMap, setCategoryOpenMap] = useState<
    Record<string, boolean>
  >({});
  const [catalogRowMenu, setCatalogRowMenu] = useState<{
    id: string;
    rect: DOMRect;
  } | null>(null);
  /** Móvil: menú ⋮ del encabezado (crear / importar / filtros) */
  const [mobileToolbarMenuRect, setMobileToolbarMenuRect] =
    useState<DOMRect | null>(null);

  const packagingFilterOptions = useMemo(
    () => [{ value: "", label: "Todos" }, ...PACKAGING_OPTIONS],
    [],
  );

  const packagingCreateOptions = useMemo(
    () => [{ value: "", label: "Seleccionar" }, ...PACKAGING_OPTIONS],
    [],
  );

  const packagingEditDashOptions = useMemo(
    () => [{ value: "", label: "—" }, ...PACKAGING_OPTIONS],
    [],
  );

  const packagingEditSelectOptions = useMemo(
    () => [{ value: "", label: "Seleccionar" }, ...PACKAGING_OPTIONS],
    [],
  );

  const creatingRef = useRef(false);
  const lastCreateKeyRef = useRef<{ key: string; ts: number } | null>(null);

  // ============================
  //  LOAD CATALOG
  // ============================
  useEffect(() => {
    setLoading(true);
    setMsg("");
    const col = collection(db, "products_candies");
    const q = query(col, orderBy("name", "asc"));
    const unsub = onSnapshot(
      q,
      (snap) => {
        const list: CandyProduct[] = [];
        const bcMap: Record<string, string> = {};
        snap.forEach((d) => {
          const x = d.data() as any;
          const bc = String(x.barcode || "").trim() || undefined;
          if (bc) bcMap[d.id] = bc;
          list.push({
            id: d.id,
            name: x.name || "",
            category: x.category || "",
            providerPrice: Number(x.providerPrice || 0),
            unitsPerPackage: Number(x.unitsPerPackage || 1),
            barcode: bc,
            boxesCount: Number(x.boxesCount || 0),
            packaging:
              String(x.packaging || x.empaque || "").trim() || undefined,
            createdAt: x.createdAt,
          });
        });

        // detect changes vs previous barcode map and notify (skip initial)
        const prev = productsBarcodeRef.current || {};
        let changed = false;
        for (const id of Object.keys(bcMap)) {
          if ((bcMap[id] || "") !== (prev[id] || "")) {
            changed = true;
            break;
          }
        }

        setProducts(list);
        productsBarcodeRef.current = bcMap;
        setLoading(false);

        if (!initialCatalogSnapshot.current && changed) {
          setMsg("✅ Catálogo actualizado.");
        }
        initialCatalogSnapshot.current = false;
      },
      (err) => {
        console.error(err);
        setMsg("❌ Error sincronizando catálogo de dulces.");
        setLoading(false);
      },
    );

    return () => unsub();
  }, [refreshKey]);

  const productsBarcodeRef = useRef<Record<string, string>>({});
  const initialCatalogSnapshot = useRef(true);

  const filtered = useMemo(() => {
    const q = norm(search);
    const qc = String(searchCode || "").trim();
    const pf = String(packagingFilter || "")
      .trim()
      .toLowerCase();

    // If packaging filter is selected, show only products matching that
    // packaging and ignore the other filters (behaves like the search input).
    if (pf) {
      return products.filter((p) => {
        const pk = String(p.packaging || "")
          .trim()
          .toLowerCase();
        return pk === pf;
      });
    }

    if (!q && !qc) return products;

    return products.filter((p) => {
      const hay = `${p.category} ${p.name}`.toLowerCase();
      const okText = !q ? true : hay.includes(q);

      const code = String(p.barcode || "");
      const okCode = !qc ? true : code.includes(qc);

      return okText && okCode;
    });
  }, [products, search, searchCode, packagingFilter]);

  // paginación
  const PAGE_SIZE = 7;
  const [page, setPage] = useState(1);
  const groupedByCategory = useMemo(() => {
    const map: Record<string, CandyProduct[]> = {};
    filtered.forEach((p) => {
      const cat =
        String(p.category || "(sin categoría)").trim() || "(sin categoría)";
      if (!map[cat]) map[cat] = [];
      map[cat].push(p);
    });
    return Object.entries(map)
      .map(([category, rows]) => ({
        category,
        rows: rows.sort((a, b) => a.name.localeCompare(b.name, "es")),
      }))
      .sort((a, b) => a.category.localeCompare(b.category, "es"));
  }, [filtered]);

  const totalPages = Math.max(
    1,
    Math.ceil(
      (isMobile ? groupedByCategory.length : filtered.length) / PAGE_SIZE,
    ),
  );
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filtered.slice(start, start + PAGE_SIZE);
  }, [filtered, page]);

  const pagedByCategory = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return groupedByCategory.slice(start, start + PAGE_SIZE);
  }, [groupedByCategory, page]);

  useEffect(() => {
    setPage(1);
  }, [search, searchCode, packagingFilter]);

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
          className="!rounded-lg px-2 py-1"
          onClick={goFirst}
          disabled={page === 1}
        >
          « Primero
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="!rounded-lg px-2 py-1"
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
          className="!rounded-lg px-2 py-1"
          onClick={goNext}
          disabled={page === totalPages}
        >
          Siguiente ›
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="!rounded-lg px-2 py-1"
          onClick={goLast}
          disabled={page === totalPages}
        >
          Último »
        </Button>
      </div>
      <div className="text-sm text-gray-600">{filtered.length} producto(s)</div>
    </div>
  );

  const toggleCategory = (cat: string) => {
    setCategoryOpenMap((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
  };

  const categoryOptions = useMemo(() => {
    const set = new Set<string>();
    products.forEach((p) => {
      const c = String(p.category || "").trim();
      if (c) set.add(c);
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
  }, [products]);

  const categorySelectFieldOptions = useMemo(
    () => [
      { value: "", label: "— Seleccionar —" },
      ...categoryOptions.map((c) => ({ value: c, label: c })),
      { value: "__new__", label: "+ Nueva categoría" },
    ],
    [categoryOptions],
  );

  // ============================
  //  CRUD MANUAL
  // ============================
  const resetForm = () => {
    setCategory("");
    setCategoryPickedNew(false);
    setName("");
    setProviderPrice(0);
    setUnitsPerPackage(1);
    setBarcode("");
    setPackaging("");
    setBoxesCount(1);
  };

  const createProduct = async (e: React.FormEvent) => {
    e.preventDefault();
    if (creatingRef.current || loading) return;
    setMsg("");

    const c = String(category || "").trim();
    const n = String(name || "").trim();
    const pp = Math.max(0, toNum(providerPrice, 0));
    const upp = roundInt(unitsPerPackage, 1);
    const boxes = Math.max(0, roundInt(boxesCount, 0));
    const bc = String(barcode || "").trim();

    if (!c) return setMsg("⚠️ La categoría es requerida.");
    if (!n) return setMsg("⚠️ El nombre del producto es requerido.");
    if (pp <= 0) return setMsg("⚠️ El precio proveedor debe ser > 0.");
    if (upp <= 0) return setMsg("⚠️ Und x paquete debe ser > 0.");

    const key = `${norm(c)}::${norm(n)}`;
    const now = Date.now();
    if (
      lastCreateKeyRef.current &&
      lastCreateKeyRef.current.key === key &&
      now - lastCreateKeyRef.current.ts < 4000
    ) {
      setMsg("⚠️ Ya se está creando este producto.");
      return;
    }

    const exists = products.some(
      (p) => norm(p.category) === norm(c) && norm(p.name) === norm(n),
    );
    if (exists) {
      return setMsg("⚠️ Ya existe un producto con esa categoría y nombre.");
    }

    if (bc) {
      const dupCode = products.some((p) => String(p.barcode || "") === bc);
      if (dupCode) {
        return setMsg("⚠️ Ya existe un producto con ese código de barras.");
      }
    }

    creatingRef.current = true;
    lastCreateKeyRef.current = { key, ts: now };

    try {
      setLoading(true);

      const nameDupSnap = await getDocs(
        query(
          collection(db, "products_candies"),
          where("category", "==", c),
          where("name", "==", n),
          limit(1),
        ),
      );
      if (!nameDupSnap.empty) {
        setMsg("⚠️ Ya existe un producto con esa categoría y nombre.");
        return;
      }

      if (bc) {
        const codeDupSnap = await getDocs(
          query(
            collection(db, "products_candies"),
            where("barcode", "==", bc),
            limit(1),
          ),
        );
        if (!codeDupSnap.empty) {
          setMsg("⚠️ Ya existe un producto con ese código de barras.");
          return;
        }
      }

      const payload: any = {
        category: c,
        name: n,
        providerPrice: pp,
        unitsPerPackage: upp,
        createdAt: Timestamp.now(),
      };
      if (boxes > 0) payload.boxesCount = boxes;
      if (bc) payload.barcode = bc;
      const pk = String(packaging || "").trim();
      if (pk) payload.packaging = pk;

      await addDoc(collection(db, "products_candies"), payload);
      setMsg("✅ Producto creado.");
      resetForm();
      setCreateOpen(false);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error creando producto.");
    } finally {
      setLoading(false);
      creatingRef.current = false;
    }
  };

  const startEdit = (p: CandyProduct) => {
    setEditingId(p.id);
    const ec = String(p.category || "").trim();
    setEditCategory(p.category);
    setEditCategoryPickedNew(ec.length > 0 && !categoryOptions.includes(ec));
    setEditName(p.name);
    setEditProviderPrice(p.providerPrice);
    setEditUnitsPerPackage(p.unitsPerPackage || 1);
    setEditBarcode(String(p.barcode || ""));
    setEditPackaging(String(p.packaging || ""));
    setEditBoxesCount(Number(p.boxesCount || 0));
    setMsg("");
    setEditModalOpen(true);
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditCategory("");
    setEditCategoryPickedNew(false);
    setEditName("");
    setEditProviderPrice(0);
    setEditUnitsPerPackage(1);
    setEditBarcode("");
    setEditPackaging("");
    setEditBoxesCount(0);
    setEditModalOpen(false);
  };

  const saveEdit = async () => {
    if (!editingId) return;
    setMsg("");

    const c = String(editCategory || "").trim();
    const n = String(editName || "").trim();
    const pp = Math.max(0, toNum(editProviderPrice, 0));
    const upp = roundInt(editUnitsPerPackage, 1);
    const bc = String(editBarcode || "").trim();
    const pk = String(editPackaging || "").trim();
    const boxes = Math.max(0, roundInt(editBoxesCount, 0));

    if (!c) return setMsg("⚠️ La categoría es requerida.");
    if (!n) return setMsg("⚠️ El nombre del producto es requerido.");
    if (pp <= 0) return setMsg("⚠️ El precio proveedor debe ser > 0.");
    if (upp <= 0) return setMsg("⚠️ Und x paquete debe ser > 0.");

    const dup = products.some(
      (p) =>
        p.id !== editingId &&
        norm(p.category) === norm(c) &&
        norm(p.name) === norm(n),
    );
    if (dup)
      return setMsg("⚠️ Ya existe otro producto con esa categoría y nombre.");

    if (bc) {
      const dupCode = products.some(
        (p) => p.id !== editingId && String(p.barcode || "") === bc,
      );
      if (dupCode) {
        return setMsg("⚠️ Ya existe otro producto con ese código de barras.");
      }
    }

    try {
      setLoading(true);

      const payload: any = {
        category: c,
        name: n,
        providerPrice: pp,
        unitsPerPackage: upp,
        updatedAt: Timestamp.now(),
      };

      payload.boxesCount = boxes;
      payload.barcode = bc || "";
      payload.packaging = pk || "";

      await updateDoc(doc(db, "products_candies", editingId), payload);

      try {
        await syncCatalogProductDependents(editingId, {
          name: n,
          category: c,
          providerPrice: pp,
          unitsPerPackage: upp,
        });
      } catch (syncErr) {
        console.error(syncErr);
      }

      setProducts((prev) =>
        prev
          .map((p) =>
            p.id === editingId
              ? {
                  ...p,
                  category: c,
                  name: n,
                  providerPrice: pp,
                  unitsPerPackage: upp,
                  barcode: bc || undefined,
                  packaging: pk || undefined,
                  boxesCount: boxes || undefined,
                }
              : p,
          )
          .sort((a, b) => a.name.localeCompare(b.name, "es")),
      );

      if (isMobile) setMsg("✅ Producto guardado.");
      cancelEdit();
      setEditModalOpen(false);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error actualizando producto.");
    } finally {
      setLoading(false);
    }
  };

  const removeProduct = async (p: CandyProduct) => {
    const ok = confirm(`¿Eliminar "${p.name}" (${p.category}) del catálogo?`);
    if (!ok) return;

    try {
      setLoading(true);
      await deleteDoc(doc(db, "products_candies", p.id));
      setProducts((prev) => prev.filter((x) => x.id !== p.id));
      setMsg("🗑️ Producto eliminado.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error eliminando producto.");
    } finally {
      setLoading(false);
    }
  };

  // ============================
  //  IMPORT XLSX/CSV
  // ============================
  const downloadTemplateXlsx = () => {
    const data = [
      {
        Id: "",
        Categoria: "Gomitas",
        Producto: "Gomita Fresa",
        PrecioProveedor: 120,
        UnidadesPorPaquete: 24,
        Empaque: "Tarro",
        Codigo: "7445074183182",
      },
    ];

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Productos");

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = "template_productos_dulces.xlsx";
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const parseRowsFromSheetJson = (json: any[]) => {
    const rows: ImportRow[] = [];
    const errors: string[] = [];

    json.forEach((r: any, idx: number) => {
      if (!r || typeof r !== "object") return;
      if (isEmptyRow(r)) return;

      const id = String(
        pickCol(r, ["Id", "ID", "productId", "docId"]) ?? "",
      ).trim();

      const cat = String(
        pickCol(r, ["Categoria", "Categoría", "Category", "cat", "category"]) ??
          "",
      ).trim();

      const prod = String(
        pickCol(r, [
          "Producto",
          "Product",
          "Nombre",
          "Name",
          "producto",
          "name",
        ]) ?? "",
      ).trim();

      const ppRaw = pickCol(r, [
        "PrecioProveedor",
        "Precio Prov",
        "Precio Prov.",
        "ProviderPrice",
        "Precio",
        "Costo",
        "providerPrice",
      ]);

      const uppRaw = pickCol(r, [
        "UnidadesPorPaquete",
        "Und x Paquete",
        "UnitsPerPackage",
        "UPP",
        "unitsPerPackage",
      ]);

      const bcRaw = pickCol(r, [
        "Codigo",
        "Código",
        "Barcode",
        "barcode",
        "EAN",
        "UPC",
        "Code",
      ]);
      const bc = String(bcRaw ?? "").trim();

      const packagingRaw = pickCol(r, [
        "Empaque",
        "Packaging",
        "PackagingType",
        "Pack",
        "Formato",
      ]);
      const packaging = String(packagingRaw ?? "").trim();

      const providerPrice = Math.max(0, toNum(ppRaw, 0));
      const unitsPerPackage = roundInt(uppRaw, 1);

      const rowNumber = idx + 2;

      if (!cat) errors.push(`Fila ${rowNumber}: falta Categoria.`);
      if (!prod) errors.push(`Fila ${rowNumber}: falta Producto/Nombre.`);
      if (providerPrice <= 0)
        errors.push(`Fila ${rowNumber}: PrecioProveedor debe ser > 0.`);
      if (unitsPerPackage <= 0)
        errors.push(`Fila ${rowNumber}: UnidadesPorPaquete debe ser > 0.`);

      if (cat && prod && providerPrice > 0 && unitsPerPackage > 0) {
        rows.push({
          id: id || undefined,
          category: cat,
          name: prod,
          providerPrice,
          unitsPerPackage,
          barcode: bc || undefined,
          packaging: packaging || undefined,
          _raw: r,
        });
      }
    });

    const map = new Map<string, ImportRow>();
    for (const r of rows) {
      const k = r.id ? `id::${r.id}` : `${norm(r.category)}::${norm(r.name)}`;
      map.set(k, r);
    }

    return {
      rows: Array.from(map.values()),
      errors,
    };
  };

  const onPickFile = async (file: File | null) => {
    setMsg("");
    setImportErrors([]);
    setImportRows([]);
    setImportFileName(file?.name || "");

    if (!file) return;

    const ext = file.name.toLowerCase();
    const isXlsx = ext.endsWith(".xlsx") || ext.endsWith(".xls");
    const isCsv = ext.endsWith(".csv");

    if (!isXlsx && !isCsv) {
      setImportErrors(["Solo se permiten archivos .xlsx, .xls o .csv"]);
      return;
    }

    try {
      setImportLoading(true);

      const reader = new FileReader();
      const data: ArrayBuffer = await new Promise((resolve, reject) => {
        reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
        reader.onload = () => resolve(reader.result as ArrayBuffer);
        reader.readAsArrayBuffer(file);
      });

      const wb = XLSX.read(new Uint8Array(data), { type: "array" });

      const firstSheetName = wb.SheetNames[0];
      const sheet = wb.Sheets[firstSheetName];
      const json = XLSX.utils.sheet_to_json(sheet, { defval: "" });

      const { rows, errors } = parseRowsFromSheetJson(json as any[]);
      setImportRows(rows);
      setImportErrors(errors);

      if (rows.length === 0 && errors.length === 0) {
        setImportErrors(["No se encontraron filas válidas para importar."]);
      }
    } catch (e) {
      console.error(e);
      setImportErrors([
        "Error leyendo el archivo. Revisá que no esté corrupto.",
      ]);
    } finally {
      setImportLoading(false);
    }
  };

  const updateImportRow = (index: number, patch: Partial<ImportRow>) => {
    setImportRows((prev) => {
      const copy = [...prev];
      const current = copy[index];
      if (!current) return prev;
      copy[index] = { ...current, ...patch };
      return copy;
    });
  };

  const importToFirestore = async () => {
    setMsg("");
    if (importErrors.length > 0) {
      setMsg("⚠️ Corregí los errores antes de importar.");
      return;
    }
    if (importRows.length === 0) {
      setMsg("⚠️ No hay filas para importar.");
      return;
    }

    try {
      setImportLoading(true);

      const existingById: Record<string, CandyProduct> = {};
      const existingByKey: Record<string, CandyProduct> = {};
      const existingByBarcode: Record<string, CandyProduct> = {};
      products.forEach((p) => {
        existingById[p.id] = p;
        existingByKey[`${norm(p.category)}::${norm(p.name)}`] = p;
        const bc = String(p.barcode || "").trim();
        if (bc) existingByBarcode[bc] = p;
      });

      const batch = writeBatch(db);

      let toCreate = 0;
      let toUpdate = 0;

      for (const r of importRows) {
        const c = String(r.category || "").trim();
        const n = String(r.name || "").trim();
        const pp = Math.max(0, toNum(r.providerPrice, 0));
        const upp = roundInt(r.unitsPerPackage, 1);
        const bc = String(r.barcode || "").trim();

        if (!c || !n || pp <= 0 || upp <= 0) continue;

        let existing: CandyProduct | undefined = undefined;
        if (r.id && existingById[r.id]) {
          existing = existingById[r.id];
        } else {
          const key = `${norm(c)}::${norm(n)}`;
          existing = existingByKey[key];
        }

        if (!existing && bc && existingByBarcode[bc]) {
          existing = existingByBarcode[bc];
        }

        if (existing) {
          const payload: any = {
            category: c,
            name: n,
            providerPrice: pp,
            unitsPerPackage: upp,
            updatedAt: Timestamp.now(),
          };

          if (r.barcode != null) payload.barcode = bc || "";
          if (r.packaging != null)
            payload.packaging = String(r.packaging || "") || "";

          batch.update(doc(db, "products_candies", existing.id), payload);
          toUpdate += 1;
        } else {
          const ref = doc(collection(db, "products_candies"));
          const payload: any = {
            category: c,
            name: n,
            providerPrice: pp,
            unitsPerPackage: upp,
            createdAt: Timestamp.now(),
          };
          if (bc) payload.barcode = bc;
          if (r.packaging) payload.packaging = r.packaging;

          batch.set(ref, payload);
          toCreate += 1;
        }
      }

      await batch.commit();

      setMsg(
        `✅ Importación lista. Creados: ${toCreate}, Actualizados: ${toUpdate}`,
      );
      setImportOpen(false);
      setImportRows([]);
      setImportErrors([]);
      setImportFileName("");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error importando productos a Firestore.");
    } finally {
      setImportLoading(false);
    }
  };

  const importStats = useMemo(() => {
    const existingById = new Set(products.map((p) => p.id));
    const existingKeys = new Set(
      products.map((p) => `${norm(p.category)}::${norm(p.name)}`),
    );
    const existingCodes = new Set(
      products.map((p) => String(p.barcode || "").trim()).filter(Boolean),
    );

    let willUpdate = 0;
    let willCreate = 0;

    for (const r of importRows) {
      if (r.id && existingById.has(r.id)) {
        willUpdate += 1;
        continue;
      }
      const k = `${norm(r.category)}::${norm(r.name)}`;
      if (existingKeys.has(k)) {
        willUpdate += 1;
        continue;
      }
      const bc = String(r.barcode || "").trim();
      if (bc && existingCodes.has(bc)) {
        willUpdate += 1;
        continue;
      }
      willCreate += 1;
    }

    return { willCreate, willUpdate, total: importRows.length };
  }, [importRows, products]);

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-2xl font-bold shrink-0">Catalogo</h2>
        <div className="flex items-center gap-2 shrink-0">
          <RefreshButton
            onClick={refresh}
            loading={loading || importLoading}
          />
          {isMobile ? (
            <ActionMenuTrigger
              className="touch-manipulation"
              aria-label="Más acciones: crear, importar, filtros"
              onClick={(e) => {
                setCatalogRowMenu(null);
                setMobileToolbarMenuRect(
                  (e.currentTarget as HTMLElement).getBoundingClientRect(),
                );
              }}
            />
          ) : (
            <>
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="!rounded-md px-3 py-2 text-xs !bg-slate-900 hover:!bg-black active:!bg-black shadow-none"
                onClick={() => {
                  setMsg("");
                  setCreateOpen(true);
                }}
              >
                Crear Producto
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="!rounded-md px-3 py-2 text-xs shadow-sm"
                onClick={() => {
                  setImportOpen(true);
                  setImportRows([]);
                  setImportErrors([]);
                  setImportFileName("");
                }}
              >
                Importar
              </Button>
            </>
          )}
        </div>
      </div>

      {/* MODAL CREAR PRODUCTO */}
      {createOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setCreateOpen(false)}
          />
          <div className="relative z-10 w-full max-w-5xl bg-white rounded-2xl shadow-lg border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-slate-900">
                Crear producto
              </h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="!rounded-md px-3 py-1 text-xs"
                onClick={() => setCreateOpen(false)}
              >
                Cerrar
              </Button>
            </div>

            <form
              onSubmit={createProduct}
              className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end text-sm"
            >
              <div className="md:col-span-2">
                <MobileHtmlSelect
                  label="Categoría"
                  value={
                    categoryPickedNew ||
                    (category.trim() &&
                      !categoryOptions.includes(category.trim()))
                      ? "__new__"
                      : category
                  }
                  onChange={(v) => {
                    if (v === "__new__") {
                      setCategoryPickedNew(true);
                      setCategory("");
                    } else {
                      setCategoryPickedNew(false);
                      setCategory(v);
                    }
                  }}
                  options={categorySelectFieldOptions}
                  sheetTitle="Categoría"
                  selectClassName="w-full border rounded-md px-3 py-2"
                  buttonClassName="w-full border rounded-md px-3 py-2 text-left flex items-center justify-between gap-2 bg-white"
                />
                {(categoryPickedNew ||
                  (category.trim() &&
                    !categoryOptions.includes(category.trim()))) && (
                  <input
                    className="w-full border rounded-md px-3 py-2 mt-2"
                    value={category}
                    onChange={(e) => setCategory(e.target.value)}
                    placeholder="Escribe la categoría (ej. Gomitas)"
                  />
                )}
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Producto
                </label>
                <input
                  className="w-full border rounded-md px-3 py-2"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Ej: Gomita Fresa"
                />
              </div>

              <div>
                <MobileHtmlSelect
                  label="Empaque"
                  value={packaging}
                  onChange={setPackaging}
                  options={packagingCreateOptions}
                  sheetTitle="Empaque"
                  selectClassName="w-full border rounded-md px-3 py-2"
                  buttonClassName="w-full border rounded-md px-3 py-2 text-left flex items-center justify-between gap-2 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Precio proveedor (paq)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={Number.isNaN(providerPrice) ? "" : providerPrice}
                  onChange={(e) =>
                    setProviderPrice(Math.max(0, toNum(e.target.value, 0)))
                  }
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Und x paquete
                </label>
                <input
                  type="number"
                  min={1}
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={unitsPerPackage}
                  onChange={(e) =>
                    setUnitsPerPackage(roundInt(e.target.value, 1))
                  }
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Cantidad Cajas
                </label>
                <input
                  type="number"
                  min={0}
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={boxesCount}
                  onChange={(e) => setBoxesCount(roundInt(e.target.value, 0))}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Código (opcional)
                </label>
                <div className="flex gap-2 md:col-span-2">
                  <input
                    className="flex-1 min-w-[220px] border rounded-md px-3 py-2"
                    value={barcode}
                    onChange={(e) => setBarcode(e.target.value)}
                    placeholder="EAN/UPC"
                  />
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="!rounded-md px-3 py-2 text-xs whitespace-nowrap !bg-slate-900 hover:!bg-black shadow-none"
                    onClick={() => {
                      setScanTarget("create");
                      setScanOpen(true);
                    }}
                  >
                    Escanear
                  </Button>
                </div>
              </div>

              <div className="md:col-span-6 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs"
                  onClick={resetForm}
                >
                  Limpiar
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs !bg-emerald-600 hover:!bg-emerald-700 active:!bg-emerald-800 shadow-emerald-600/15"
                  disabled={loading}
                >
                  Crear producto
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* FILTROS (colapsable en móvil) */}
      {filtersOpen && (
        <div className="bg-white p-4 rounded-xl shadow-sm border border-slate-200 mb-3 flex flex-col md:flex-row gap-3 items-center text-sm">
          <div className="w-full md:w-1/2">
            <label className="block text-xs font-semibold text-slate-700">
              Buscar
            </label>
            <input
              className="w-full border rounded-md px-3 py-2"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Buscar por categoría o producto…"
            />
            <div className="mt-2">
              <MobileHtmlSelect
                label="Empaque"
                value={packagingFilter}
                onChange={setPackagingFilter}
                options={packagingFilterOptions}
                sheetTitle="Empaque"
                selectClassName="w-full border rounded-md px-3 py-2"
                buttonClassName="w-full border rounded-md px-3 py-2 text-left flex items-center justify-between gap-2 bg-white"
              />
            </div>
          </div>

          <div className="w-full md:w-1/2">
            <label className="block text-xs font-semibold text-slate-700">
              Buscar por código
            </label>
            <input
              className="w-full border rounded-md px-3 py-2"
              value={searchCode}
              onChange={(e) => setSearchCode(e.target.value)}
              placeholder="Ej: 7445074183182"
            />
            <div className="mt-2 md:mt-0">
              <Button
                type="button"
                variant="primary"
                size="sm"
                className="w-full md:w-auto !rounded-md px-3 py-2 text-xs !bg-slate-900 shadow-none"
                onClick={() => {
                  setScanTarget("search");
                  setScanOpen(true);
                  setFiltersOpen(true);
                }}
              >
                Escanear producto
              </Button>
            </div>
            <div className="mt-2 md:ml-2">
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="w-full md:w-auto !rounded-md px-3 py-2 text-xs"
                onClick={() => {
                  setSearch("");
                  setSearchCode("");
                }}
              >
                Limpiar filtros
              </Button>
            </div>
          </div>

          <div className="w-full md:w-auto text-right">
            <div className="text-xs text-slate-600">Productos en catálogo</div>
            <div className="text-lg font-semibold">{filtered.length}</div>
          </div>
        </div>
      )}

      {/* ✅ MOBILE: CARDS (sin scroll horizontal) */}
      {isMobile ? (
        <div className="space-y-2">
          {loading ? (
            <div className="bg-white border rounded p-4 text-center">
              Cargando…
            </div>
          ) : filtered.length === 0 ? (
            <div className="bg-white border rounded p-4 text-center">
              Sin productos.
            </div>
          ) : (
            <div className="space-y-3">
              {/* <p className="text-xs text-slate-500 px-1">
                Arriba, junto a Actualizar, el menú (⋮) ofrece Crear producto,
                Importar y filtros. Abrí una categoría para listar productos; en
                cada fila, el menú a la derecha es Editar / Borrar.
              </p> */}
              {pagedByCategory.map((group) => {
                const isOpen = !!categoryOpenMap[group.category];
                return (
                  <div
                    key={group.category}
                    className="bg-white border rounded-2xl shadow-sm overflow-hidden"
                  >
                    <Button
                      type="button"
                      variant="ghost"
                      size="md"
                      className="w-full !justify-between !rounded-none px-3 py-3 text-left !font-normal shadow-none border-0"
                      onClick={() => toggleCategory(group.category)}
                      aria-expanded={isOpen}
                    >
                      <div className="min-w-0">
                        <div className="font-bold truncate">
                          {group.category}
                        </div>
                        <div className="text-xs text-gray-600">
                          {group.rows.length} producto(s)
                        </div>
                      </div>
                      <span
                        className={`transition-transform ${isOpen ? "rotate-180" : ""}`}
                      >
                        ▼
                      </span>
                    </Button>

                    {isOpen && (
                      <div className="border-t p-2 space-y-2">
                        {group.rows.map((p) => {
                          const isEd = editingId === p.id;
                          const expanded = openCardId === p.id;
                          const hasCode = !!String(p.barcode || "").trim();

                          return (
                            <div
                              key={p.id}
                              className="bg-white border rounded-2xl shadow-sm overflow-hidden"
                            >
                              {/* header card (colapsada): nombre + precio + menú acciones (mismo ActionMenu que web) */}
                              <div className="flex items-stretch border-b border-transparent">
                                <Button
                                  type="button"
                                  variant="ghost"
                                  size="md"
                                  className="flex-1 min-w-0 !justify-between !rounded-none px-3 py-3 text-left !font-normal shadow-none border-0"
                                  onClick={() =>
                                    setOpenCardId((cur) =>
                                      cur === p.id ? null : p.id,
                                    )
                                  }
                                >
                                  <div className="min-w-0 pr-2">
                                    <div className="font-bold truncate">
                                      {p.name}
                                    </div>
                                    <div className="text-xs text-gray-600 truncate">
                                      {p.category}
                                    </div>
                                  </div>
                                  <div className="text-right shrink-0">
                                    <div className="text-xs text-gray-600">
                                      Precio proveedor
                                    </div>
                                    <div className="font-bold tabular-nums">
                                      {money(p.providerPrice)}
                                    </div>
                                  </div>
                                </Button>
                                <ActionMenuTrigger
                                  className="shrink-0 touch-manipulation"
                                  aria-label="Acciones del producto"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    setMobileToolbarMenuRect(null);
                                    setCatalogRowMenu({
                                      id: p.id,
                                      rect: (
                                        e.currentTarget as HTMLElement
                                      ).getBoundingClientRect(),
                                    });
                                  }}
                                />
                              </div>

                              {expanded && (
                                <div className="px-3 pb-3 border-t">
                                  <div className="pt-3 space-y-2 text-sm">
                                    {/* si está en edición, mostramos inputs; si no, texto */}
                                    <div className="grid grid-cols-2 gap-2">
                                      <div>
                                        <div className="text-xs text-gray-600">
                                          Categoría
                                        </div>
                                        {isEd ? (
                                          <div className="space-y-1">
                                            <MobileHtmlSelect
                                              label=""
                                              value={
                                                editCategoryPickedNew ||
                                                (editCategory.trim() &&
                                                  !categoryOptions.includes(
                                                    editCategory.trim(),
                                                  ))
                                                  ? "__new__"
                                                  : editCategory
                                              }
                                              onChange={(v) => {
                                                if (v === "__new__") {
                                                  setEditCategoryPickedNew(
                                                    true,
                                                  );
                                                  setEditCategory("");
                                                } else {
                                                  setEditCategoryPickedNew(
                                                    false,
                                                  );
                                                  setEditCategory(v);
                                                }
                                              }}
                                              options={
                                                categorySelectFieldOptions
                                              }
                                              sheetTitle="Categoría"
                                              selectClassName="w-full border rounded px-2 py-1 text-sm"
                                              buttonClassName="w-full border rounded px-2 py-1 text-sm text-left flex items-center justify-between gap-2 bg-white"
                                            />
                                            {(editCategoryPickedNew ||
                                              (editCategory.trim() &&
                                                !categoryOptions.includes(
                                                  editCategory.trim(),
                                                ))) && (
                                              <input
                                                className="w-full border rounded px-2 py-1 text-sm"
                                                value={editCategory}
                                                onChange={(e) =>
                                                  setEditCategory(
                                                    e.target.value,
                                                  )
                                                }
                                                placeholder="Nueva categoría"
                                              />
                                            )}
                                          </div>
                                        ) : (
                                          <div className="font-semibold">
                                            {p.category}
                                          </div>
                                        )}
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600">
                                          Und x paquete
                                        </div>
                                        {isEd ? (
                                          <input
                                            type="number"
                                            min={1}
                                            className="w-full border rounded px-2 py-1 text-right"
                                            value={editUnitsPerPackage}
                                            onChange={(e) =>
                                              setEditUnitsPerPackage(
                                                roundInt(e.target.value, 1),
                                              )
                                            }
                                          />
                                        ) : (
                                          <div className="font-semibold text-right tabular-nums">
                                            {p.unitsPerPackage}
                                          </div>
                                        )}
                                      </div>

                                      <div className="col-span-2">
                                        <div className="text-xs text-gray-600">
                                          Empaque
                                        </div>
                                        {isEd ? (
                                          <MobileHtmlSelect
                                            value={editPackaging}
                                            onChange={setEditPackaging}
                                            options={packagingEditSelectOptions}
                                            sheetTitle="Empaque"
                                            selectClassName="w-full border rounded px-2 py-1 text-sm"
                                            buttonClassName="w-full border rounded px-2 py-1 text-sm text-left flex items-center justify-between gap-2 bg-white"
                                          />
                                        ) : (
                                          <div className="font-semibold">
                                            {p.packaging || "—"}
                                          </div>
                                        )}
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600">
                                          Precio proveedor
                                        </div>
                                        {isEd ? (
                                          <input
                                            type="number"
                                            step="0.01"
                                            inputMode="decimal"
                                            className="w-full border rounded px-2 py-1 text-right"
                                            value={
                                              Number.isNaN(editProviderPrice)
                                                ? ""
                                                : editProviderPrice
                                            }
                                            onChange={(e) =>
                                              setEditProviderPrice(
                                                Math.max(
                                                  0,
                                                  toNum(e.target.value, 0),
                                                ),
                                              )
                                            }
                                          />
                                        ) : (
                                          <div className="font-semibold tabular-nums">
                                            {money(p.providerPrice)}
                                          </div>
                                        )}
                                      </div>

                                      <div>
                                        <div className="text-xs text-gray-600">
                                          Código
                                        </div>
                                        {isEd ? (
                                          <div className="flex gap-2">
                                            <input
                                              className="flex-1 border rounded px-2 py-1"
                                              value={editBarcode}
                                              onChange={(e) =>
                                                setEditBarcode(e.target.value)
                                              }
                                              placeholder="EAN/UPC"
                                            />
                                            <Button
                                              type="button"
                                              variant="primary"
                                              size="sm"
                                              className="!rounded-lg px-3 py-2 !bg-gray-800 hover:!bg-gray-900 shadow-none"
                                              onClick={() => {
                                                setScanTarget("edit");
                                                setScanOpen(true);
                                              }}
                                            >
                                              Escanear
                                            </Button>
                                          </div>
                                        ) : hasCode ? (
                                          <Button
                                            type="button"
                                            variant="outline"
                                            size="sm"
                                            className="!rounded-lg px-2 py-1 !bg-green-100 !text-green-700 border-green-200/80 hover:!bg-green-200"
                                            onClick={() => {
                                              setCodeModalValue(
                                                String(p.barcode || "").trim(),
                                              );
                                              setCodeModalOpen(true);
                                            }}
                                          >
                                            Ver código
                                          </Button>
                                        ) : (
                                          <div className="text-gray-600">
                                            No
                                          </div>
                                        )}
                                      </div>
                                    </div>

                                    {/* acciones inline solo en modo edición; Editar/Borrar vía ⋮ en el header */}
                                    {isEd && (
                                      <div className="pt-2 flex flex-wrap gap-2 items-center">
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          className="flex-1 min-w-[6rem] !rounded-lg px-3 py-2"
                                          onClick={saveEdit}
                                        >
                                          Guardar
                                        </Button>
                                        <Button
                                          type="button"
                                          variant="primary"
                                          size="sm"
                                          className="flex-1 min-w-[6rem] !rounded-lg px-3 py-2 !bg-gray-800 hover:!bg-gray-900 shadow-none"
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
                                          className="flex-1 min-w-[6rem] !rounded-lg px-3 py-2"
                                          onClick={cancelEdit}
                                        >
                                          Cancelar
                                        </Button>
                                      </div>
                                    )}
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
          {!loading && filtered.length > 0 && renderPager()}
        </div>
      ) : (
        /* ✅ WEB: TABLA igual */
        <div className="bg-white rounded-xl shadow-sm border border-slate-200 w-full overflow-x-auto">
          <table className="min-w-[1050px] w-full text-xs md:text-sm">
            <thead className="bg-slate-100 sticky top-0 z-10">
              <tr className="whitespace-nowrap text-[11px] uppercase tracking-wider text-slate-600">
                <th className="p-3 border-b text-left">Categoría</th>
                <th className="p-3 border-b text-left">Producto</th>
                <th className="p-3 border-b text-left">Empaque</th>
                <th className="p-3 border-b text-right">Precio proveedor</th>
                <th className="p-3 border-b text-right">Und x paquete</th>
                <th className="p-3 border-b text-center">Código</th>
                <th className="p-3 border-b text-center">Acciones</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td className="p-4 text-center" colSpan={7}>
                    Cargando…
                  </td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td className="p-4 text-center" colSpan={7}>
                    Sin productos.
                  </td>
                </tr>
              ) : (
                paged.map((p) => {
                  const isEditingThis = editingId === p.id;
                  const isEd = isEditingThis && !editModalOpen;
                  const hasCode = !!String(p.barcode || "").trim();

                  return (
                    <tr
                      key={p.id}
                      className="align-top odd:bg-white even:bg-slate-50"
                    >
                      <td className="p-3 border-b">
                        {isEd ? (
                          <div className="space-y-1 min-w-[140px]">
                            <MobileHtmlSelect
                              label=""
                              value={
                                editCategoryPickedNew ||
                                (editCategory.trim() &&
                                  !categoryOptions.includes(
                                    editCategory.trim(),
                                  ))
                                  ? "__new__"
                                  : editCategory
                              }
                              onChange={(v) => {
                                if (v === "__new__") {
                                  setEditCategoryPickedNew(true);
                                  setEditCategory("");
                                } else {
                                  setEditCategoryPickedNew(false);
                                  setEditCategory(v);
                                }
                              }}
                              options={categorySelectFieldOptions}
                              sheetTitle="Categoría"
                              selectClassName="w-full border rounded px-2 py-1 text-sm"
                              buttonClassName="w-full border rounded px-2 py-1 text-sm text-left flex items-center justify-between gap-2 bg-white"
                            />
                            {(editCategoryPickedNew ||
                              (editCategory.trim() &&
                                !categoryOptions.includes(
                                  editCategory.trim(),
                                ))) && (
                              <input
                                className="w-full border rounded px-2 py-1 text-sm"
                                value={editCategory}
                                onChange={(e) =>
                                  setEditCategory(e.target.value)
                                }
                                placeholder="Nueva categoría"
                              />
                            )}
                          </div>
                        ) : (
                          p.category
                        )}
                      </td>

                      <td className="p-3 border-b">
                        {isEd ? (
                          <input
                            className="w-full border rounded px-2 py-1"
                            value={editName}
                            onChange={(e) => setEditName(e.target.value)}
                          />
                        ) : (
                          p.name
                        )}
                      </td>

                      <td className="p-3 border-b">
                        {isEd ? (
                          <MobileHtmlSelect
                            value={editPackaging}
                            onChange={setEditPackaging}
                            options={packagingEditDashOptions}
                            sheetTitle="Empaque"
                            selectClassName="w-full border rounded px-2 py-1 text-sm"
                            buttonClassName="w-full border rounded px-2 py-1 text-sm text-left flex items-center justify-between gap-2 bg-white"
                          />
                        ) : (
                          p.packaging || "—"
                        )}
                      </td>

                      <td className="p-3 border-b text-right tabular-nums">
                        {isEd ? (
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="w-28 border rounded px-2 py-1 text-right"
                            value={
                              Number.isNaN(editProviderPrice)
                                ? ""
                                : editProviderPrice
                            }
                            onChange={(e) =>
                              setEditProviderPrice(
                                Math.max(0, toNum(e.target.value, 0)),
                              )
                            }
                          />
                        ) : (
                          money(p.providerPrice)
                        )}
                      </td>

                      <td className="p-3 border-b text-right tabular-nums">
                        {isEd ? (
                          <input
                            type="number"
                            min={1}
                            className="w-24 border rounded px-2 py-1 text-right"
                            value={editUnitsPerPackage}
                            onChange={(e) =>
                              setEditUnitsPerPackage(
                                roundInt(e.target.value, 1),
                              )
                            }
                          />
                        ) : (
                          p.unitsPerPackage
                        )}
                      </td>

                      <td className="p-3 border-b text-center">
                        {isEd ? (
                          <div className="flex gap-2 justify-center">
                            <input
                              className="w-44 border rounded px-2 py-1"
                              value={editBarcode}
                              onChange={(e) => setEditBarcode(e.target.value)}
                              placeholder="EAN/UPC"
                            />
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="!rounded-md px-3 py-1.5 text-xs !bg-slate-900 hover:!bg-black shadow-none"
                              onClick={() => {
                                setScanTarget("edit");
                                setScanOpen(true);
                              }}
                            >
                              Escanear
                            </Button>
                          </div>
                        ) : hasCode ? (
                          <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="!rounded-md px-3 py-1.5 text-xs !bg-emerald-100 !text-emerald-700 border-emerald-200/80 hover:!bg-emerald-200"
                            onClick={() => {
                              setCodeModalValue(String(p.barcode || "").trim());
                              setCodeModalOpen(true);
                            }}
                          >
                            Sí
                          </Button>
                        ) : (
                          <span className="px-3 py-1.5 rounded-md text-xs font-semibold bg-slate-100 text-slate-600">
                            No
                          </span>
                        )}
                      </td>

                      <td className="p-3 border-b">
                        {isEd ? (
                          <div className="flex gap-2 justify-center">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="!rounded-md px-3 py-1.5 text-xs"
                              onClick={saveEdit}
                            >
                              Guardar
                            </Button>
                            <Button
                              type="button"
                              variant="secondary"
                              size="sm"
                              className="!rounded-md px-3 py-1.5 text-xs"
                              onClick={cancelEdit}
                            >
                              Cancelar
                            </Button>
                          </div>
                        ) : (
                          <div className="flex gap-2 justify-center flex-wrap">
                            <Button
                              type="button"
                              variant="primary"
                              size="sm"
                              className="!rounded-md px-3 py-1.5 text-xs !bg-amber-500 hover:!bg-amber-600 active:!bg-amber-700 shadow-amber-500/15"
                              onClick={() => startEdit(p)}
                            >
                              Editar
                            </Button>
                            <Button
                              type="button"
                              variant="danger"
                              size="sm"
                              className="!rounded-md px-3 py-1.5 text-xs"
                              onClick={() => removeProduct(p)}
                            >
                              Borrar
                            </Button>
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
          {!loading && filtered.length > 0 && renderPager()}
        </div>
      )}

      <ActionMenu
        anchorRect={catalogRowMenu?.rect ?? null}
        isOpen={!!catalogRowMenu}
        onClose={() => setCatalogRowMenu(null)}
        width={200}
      >
        {catalogRowMenu &&
          (() => {
            const p = products.find((x) => x.id === catalogRowMenu.id);
            if (!p) {
              return (
                <div className="px-3 py-2 text-sm text-gray-500">Sin datos</div>
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
                    setCatalogRowMenu(null);
                    startEdit(p);
                  }}
                >
                  Editar
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal !text-red-700"
                  onClick={() => {
                    setCatalogRowMenu(null);
                    void removeProduct(p);
                  }}
                >
                  Borrar
                </Button>
              </div>
            );
          })()}
      </ActionMenu>

      <ActionMenu
        anchorRect={mobileToolbarMenuRect}
        isOpen={!!mobileToolbarMenuRect}
        onClose={() => setMobileToolbarMenuRect(null)}
        width={220}
      >
        <div className="py-1">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-semibold"
            onClick={() => {
              setMobileToolbarMenuRect(null);
              setMsg("");
              setCreateOpen(true);
            }}
          >
            Crear producto
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal"
            onClick={() => {
              setMobileToolbarMenuRect(null);
              setImportOpen(true);
              setImportRows([]);
              setImportErrors([]);
              setImportFileName("");
            }}
          >
            Importar
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full !justify-start !rounded-lg px-3 py-2 text-sm !font-normal border-t border-slate-100 !rounded-t-none"
            onClick={() => {
              setMobileToolbarMenuRect(null);
              setFiltersOpen((v) => !v);
            }}
          >
            {filtersOpen ? "Ocultar filtros" : "Mostrar filtros"}
          </Button>
        </div>
      </ActionMenu>

      {msg ? (
        isMobile && msg === "✅ Producto guardado." ? (
          <>
            <Toast message={msg} onClose={() => setMsg("")} />
            <div className="mt-2 md:hidden">
              <Button
                type="button"
                variant="primary"
                size="md"
                className="w-full !rounded-lg px-3 py-2 text-sm"
                onClick={() => {
                  setMsg("");
                  cancelEdit();
                  setScanOpen(false);
                }}
              >
                Aceptar y cerrar edición
              </Button>
            </div>
          </>
        ) : (
          <Toast message={msg} onClose={() => setMsg("")} />
        )
      ) : null}

      {/* MODAL CÓDIGO */}
      <CodeModal
        open={codeModalOpen}
        code={codeModalValue}
        onClose={() => setCodeModalOpen(false)}
      />

      {/* MODAL EDICIÓN */}
      {editModalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-3">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => setEditModalOpen(false)}
          />
          <div className="relative z-10 w-full max-w-3xl bg-white rounded-2xl shadow-lg border border-slate-200 p-5">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-lg font-bold text-slate-900">
                Editar producto
              </h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="!rounded-md px-3 py-1 text-xs"
                onClick={() => setEditModalOpen(false)}
              >
                Cerrar
              </Button>
            </div>

            <form
              onSubmit={(e) => {
                e.preventDefault();
                saveEdit();
              }}
              className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end text-sm"
            >
              <div className="md:col-span-2">
                <MobileHtmlSelect
                  label="Categoría"
                  value={
                    editCategoryPickedNew ||
                    (editCategory.trim() &&
                      !categoryOptions.includes(editCategory.trim()))
                      ? "__new__"
                      : editCategory
                  }
                  onChange={(v) => {
                    if (v === "__new__") {
                      setEditCategoryPickedNew(true);
                      setEditCategory("");
                    } else {
                      setEditCategoryPickedNew(false);
                      setEditCategory(v);
                    }
                  }}
                  options={categorySelectFieldOptions}
                  sheetTitle="Categoría"
                  selectClassName="w-full border rounded-md px-3 py-2"
                  buttonClassName="w-full border rounded-md px-3 py-2 text-left flex items-center justify-between gap-2 bg-white"
                />
                {(editCategoryPickedNew ||
                  (editCategory.trim() &&
                    !categoryOptions.includes(editCategory.trim()))) && (
                  <input
                    className="w-full border rounded-md px-3 py-2 mt-2"
                    value={editCategory}
                    onChange={(e) => setEditCategory(e.target.value)}
                    placeholder="Escribe la categoría"
                  />
                )}
              </div>

              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Producto
                </label>
                <input
                  className="w-full border rounded-md px-3 py-2"
                  value={editName}
                  onChange={(e) => setEditName(e.target.value)}
                />
              </div>

              <div>
                <MobileHtmlSelect
                  label="Empaque"
                  value={editPackaging}
                  onChange={setEditPackaging}
                  options={packagingEditSelectOptions}
                  sheetTitle="Empaque"
                  selectClassName="w-full border rounded-md px-3 py-2"
                  buttonClassName="w-full border rounded-md px-3 py-2 text-left flex items-center justify-between gap-2 bg-white"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Precio proveedor (paq)
                </label>
                <input
                  type="number"
                  step="0.01"
                  inputMode="decimal"
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={
                    Number.isNaN(editProviderPrice) ? "" : editProviderPrice
                  }
                  onChange={(e) =>
                    setEditProviderPrice(Math.max(0, toNum(e.target.value, 0)))
                  }
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Und x paquete
                </label>
                <input
                  type="number"
                  min={1}
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={editUnitsPerPackage}
                  onChange={(e) =>
                    setEditUnitsPerPackage(roundInt(e.target.value, 1))
                  }
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Cantidad Cajas
                </label>
                <input
                  type="number"
                  min={0}
                  className="w-full border rounded-md px-3 py-2 text-right"
                  value={editBoxesCount}
                  onChange={(e) =>
                    setEditBoxesCount(roundInt(e.target.value, 0))
                  }
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Código (opcional)
                </label>
                <div className="flex gap-2">
                  <input
                    className="flex-1 min-w-[220px] border rounded-md px-3 py-2"
                    value={editBarcode}
                    onChange={(e) => setEditBarcode(e.target.value)}
                    placeholder="EAN/UPC"
                  />
                  <Button
                    type="button"
                    variant="primary"
                    size="sm"
                    className="!rounded-md px-3 py-2 text-xs whitespace-nowrap !bg-slate-900 hover:!bg-black shadow-none"
                    onClick={() => {
                      setScanTarget("edit");
                      setScanOpen(true);
                    }}
                  >
                    Escanear
                  </Button>
                </div>
              </div>

              <div className="md:col-span-6 flex justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs"
                  onClick={cancelEdit}
                >
                  Cancelar
                </Button>
                <Button
                  type="submit"
                  variant="primary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs !bg-emerald-600 hover:!bg-emerald-700 active:!bg-emerald-800 shadow-emerald-600/15"
                >
                  Guardar
                </Button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL ESCÁNER */}
      <BarcodeScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onDetected={async (code) => {
          const bc = String(code || "").trim();
          if (!bc) return;

          // Si viene de edición y hay un producto en edición, guardar directamente
          if (scanTarget === "edit" && editingId) {
            // verificar duplicados
            const dup = products.some(
              (p) => p.id !== editingId && String(p.barcode || "") === bc,
            );
            if (dup) {
              setMsg("⚠️ Ya existe otro producto con ese código de barras.");
              setEditBarcode(bc);
              setScanOpen(false);
              return;
            }

            try {
              await updateDoc(doc(db, "products_candies", editingId), {
                barcode: bc,
              });
              setProducts((prev) =>
                prev.map((p) =>
                  p.id === editingId ? { ...p, barcode: bc } : p,
                ),
              );
              setEditBarcode(bc);
              if (isMobile) setMsg("✅ Producto guardado.");
            } catch (e) {
              console.error(e);
              setMsg("❌ Error guardando código de barras.");
            } finally {
              setScanOpen(false);
            }
            return;
          }

          // Si viene en modo búsqueda, llenar el campo searchCode para filtrar
          if (scanTarget === "search") {
            setSearchCode(bc);
            setScanOpen(false);
            return;
          }

          if (scanTarget === "create") setBarcode(code);
          else setEditBarcode(code);
        }}
      />

      {/* MODAL IMPORTACIÓN (igual) */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50">
          <div className="bg-white w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded-2xl shadow-lg border border-slate-200 p-5 text-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xl font-bold">
                Importar productos (.xlsx / .csv)
              </h3>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="!rounded-md px-3 py-1 text-xs"
                onClick={() => setImportOpen(false)}
              >
                Cerrar
              </Button>
            </div>

            <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 mb-3">
              <div className="flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
                <div>
                  <div className="font-semibold">1) Subí tu archivo</div>
                  <div className="text-xs text-slate-600">
                    Columnas esperadas (flexible): Id (opcional), Categoria,
                    Producto/Nombre, PrecioProveedor, UnidadesPorPaquete,
                    Empaque (opcional), Codigo (opcional).
                  </div>
                </div>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs"
                  onClick={downloadTemplateXlsx}
                >
                  Descargar template .xlsx
                </Button>
              </div>

              <div className="mt-3 flex flex-col md:flex-row gap-3 md:items-center">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                />
                {importFileName && (
                  <span className="text-xs text-slate-600">
                    Archivo: <b>{importFileName}</b>
                  </span>
                )}
                {importLoading && <span className="text-xs">Procesando…</span>}
              </div>
            </div>

            {importErrors.length > 0 && (
              <div className="bg-red-50 border border-red-200 rounded p-3 mb-3">
                <div className="font-semibold text-red-700 mb-2">
                  Errores encontrados
                </div>
                <ul className="list-disc pl-5 text-red-700 text-xs space-y-1">
                  {importErrors.slice(0, 50).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-white border border-slate-200 rounded-xl p-3">
              <div className="flex flex-wrap gap-4 items-center justify-between mb-2">
                <div>
                  <div className="font-semibold">
                    2) Previsualización (editable)
                  </div>
                  <div className="text-xs text-slate-600">
                    Se importarán {importStats.total} filas (Crear:{" "}
                    {importStats.willCreate} / Actualizar:{" "}
                    {importStats.willUpdate})
                  </div>
                </div>

                <Button
                  type="button"
                  variant="primary"
                  size="sm"
                  className="!rounded-md px-3 py-2 text-xs !bg-indigo-600 hover:!bg-indigo-700 active:!bg-indigo-800 shadow-indigo-600/15"
                  onClick={importToFirestore}
                  disabled={
                    importLoading ||
                    importRows.length === 0 ||
                    importErrors.length > 0
                  }
                >
                  Importar a Firestore
                </Button>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="min-w-[1250px] w-full text-xs">
                  <thead className="bg-slate-100 sticky top-0 z-10">
                    <tr className="whitespace-nowrap text-[11px] uppercase tracking-wider text-slate-600">
                      <th className="p-3 border-b text-left">Id (opcional)</th>
                      <th className="p-3 border-b text-left">Categoría</th>
                      <th className="p-3 border-b text-left">Producto</th>
                      <th className="p-3 border-b text-right">
                        Precio proveedor
                      </th>
                      <th className="p-3 border-b text-right">Und x paquete</th>
                      <th className="p-3 border-b text-left">
                        Empaque (opcional)
                      </th>
                      <th className="p-3 border-b text-left">
                        Codigo (opcional)
                      </th>
                      <th className="p-3 border-b text-center">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={8}
                          className="p-4 text-center text-slate-500"
                        >
                          Subí un archivo para ver la previsualización.
                        </td>
                      </tr>
                    ) : (
                      importRows.slice(0, 300).map((r, i) => {
                        const byId = r.id
                          ? products.some((p) => p.id === r.id)
                          : false;
                        const byKey = products.some(
                          (p) =>
                            `${norm(p.category)}::${norm(p.name)}` ===
                            `${norm(r.category)}::${norm(r.name)}`,
                        );
                        const byCode = r.barcode
                          ? products.some(
                              (p) => String(p.barcode || "") === r.barcode,
                            )
                          : false;
                        const exists = byId || byKey || byCode;

                        return (
                          <tr
                            key={`${r.id || ""}-${i}`}
                            className="whitespace-nowrap odd:bg-white even:bg-slate-50"
                          >
                            <td className="p-3 border-b">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.id || ""}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    id: e.target.value.trim() || undefined,
                                  })
                                }
                                placeholder="docId (si querés update exacto)"
                              />
                            </td>

                            <td className="p-3 border-b">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.category}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    category: e.target.value,
                                  })
                                }
                                list="categories-list"
                              />
                            </td>

                            <td className="p-3 border-b">
                              <input
                                className="w-72 border rounded px-2 py-1"
                                value={r.name}
                                onChange={(e) =>
                                  updateImportRow(i, { name: e.target.value })
                                }
                              />
                            </td>

                            <td className="p-3 border-b text-right tabular-nums">
                              <input
                                type="number"
                                step="0.01"
                                inputMode="decimal"
                                className="w-28 border rounded px-2 py-1 text-right"
                                value={
                                  Number.isNaN(r.providerPrice)
                                    ? ""
                                    : r.providerPrice
                                }
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    providerPrice: Math.max(
                                      0,
                                      toNum(e.target.value, 0),
                                    ),
                                  })
                                }
                              />
                            </td>

                            <td className="p-3 border-b text-right tabular-nums">
                              <input
                                type="number"
                                min={1}
                                className="w-24 border rounded px-2 py-1 text-right"
                                value={r.unitsPerPackage}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    unitsPerPackage: roundInt(
                                      e.target.value,
                                      1,
                                    ),
                                  })
                                }
                              />
                            </td>

                            <td className="p-3 border-b">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.packaging || ""}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    packaging:
                                      e.target.value.trim() || undefined,
                                  })
                                }
                                placeholder="Tarro, Bolsa..."
                              />
                            </td>

                            <td className="p-3 border-b">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.barcode || ""}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    barcode: e.target.value.trim() || undefined,
                                  })
                                }
                                placeholder="EAN/UPC (opcional)"
                              />
                            </td>

                            <td className="p-3 border-b text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] ${
                                  exists
                                    ? "bg-amber-100 text-amber-700"
                                    : "bg-emerald-100 text-emerald-700"
                                }`}
                              >
                                {exists ? "ACTUALIZA" : "CREA"}
                              </span>
                            </td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>

                <datalist id="categories-list">
                  {categoryOptions.map((c) => (
                    <option key={c} value={c} />
                  ))}
                </datalist>
              </div>

              {importRows.length > 300 && (
                <div className="text-xs text-gray-600 mt-2">
                  Mostrando 300 de {importRows.length} filas (el import importa
                  todas).
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
