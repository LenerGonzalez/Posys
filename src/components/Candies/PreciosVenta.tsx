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
} from "firebase/firestore";
import { onAuthStateChanged } from "firebase/auth";
import { auth, db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

type PriceRow = {
  productId: string;
  category: string;
  productName: string;
  priceIsla: number;
  priceRivas: number;
  unitsPerPackage?: number;
  _sortKey: number;
};

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

function parseDateKey(dateStr: any) {
  const s = String(dateStr || "").trim();
  if (!s) return 0;
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : 0;
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
          <button
            className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
            onClick={onClose}
            type="button"
          >
            Cerrar
          </button>
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

export default function PrecioVentas() {
  const { refreshKey, refresh } = useManualRefresh();

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [rows, setRows] = useState<PriceRow[]>([]);

  // filtros
  const [searchProduct, setSearchProduct] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");
  const [priceField, setPriceField] = useState<"ANY" | "ISLA" | "RIVAS">("ANY");

  // UI móvil
  const [filtersOpenMobile, setFiltersOpenMobile] = useState(false);
  const [openCategoryMap, setOpenCategoryMap] = useState<
    Record<string, boolean>
  >({});

  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const snap = await getDocs(query(collection(db, "candy_main_orders")));

        const map = new Map<string, PriceRow>();

        snap.forEach((d) => {
          const x = d.data() as any;

          const dateKey = parseDateKey(x.date);
          const createdAtMs =
            x?.createdAt?.toMillis?.() ||
            (x?.createdAt?.seconds ? x.createdAt.seconds * 1000 : 0) ||
            0;

          const sortKey = Math.max(dateKey, createdAtMs);

          const items: any[] = Array.isArray(x.items) ? x.items : [];
          for (const it of items) {
            const productId = String(it?.id || it?.productId || "").trim();
            if (!productId) continue;

            const productName = String(
              it?.name || it?.productName || "",
            ).trim();
            const category = String(it?.category || "").trim();

            const priceIsla = Number(it?.unitPriceIsla || 0);
            const priceRivas = Number(it?.unitPriceRivas || 0);
            const unitsPerPackage = Number(
              it?.unitsPerPackage || it?.unitsPerPack || 1,
            );

            const current = map.get(productId);
            if (!current || sortKey >= current._sortKey) {
              map.set(productId, {
                productId,
                category,
                productName,
                priceIsla,
                priceRivas,
                unitsPerPackage,
                _sortKey: sortKey,
              });
            }
          }
        });

        const list = Array.from(map.values()).sort((a, b) =>
          a.productName.localeCompare(b.productName, "es"),
        );

        setRows(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando precios desde órdenes maestras.");
        setRows([]);
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  // cargar/sincronizar precios proveedor y barcodes (products_candies) en tiempo real
  useEffect(() => {
    const col = collection(db, "products_candies");
    const q = query(col);
    const unsub = onSnapshot(
      q,
      (snap) => {
        const map: Record<string, number> = {};
        const bcMap: Record<string, string> = {};
        const unitsMap: Record<string, number> = {};
        const pkMap: Record<string, string> = {};
        snap.forEach((d) => {
          const x: any = d.data();
          map[d.id] = Number(x?.providerPrice || x?.providerPricePerUnit || 0);
          unitsMap[d.id] =
            Number(x?.unitsPerPackage || x?.unitsPerPack || 1) || 1;
          const bc = String(x?.barcode || "").trim();
          if (bc) bcMap[d.id] = bc;
          const pk = String(x?.packaging || x?.empaque || "").trim();
          if (pk) pkMap[d.id] = pk;
        });
        // detect changes vs previous barcodeMap and units map (avoid notifying on initial load)
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

          setProviderPriceMap(map);
          setUnitsPerPackageMap(unitsMap);
          const merged = { ...bcMap, ...prev };
          setBarcodeMap(merged);
          barcodeMapRef.current = merged;
          unitsPerPackageRef.current = { ...unitsMap };
          setPackagingMap(pkMap);
          // update rows unitsPerPackage from catalog when available
          setRows((prev) =>
            prev.map((r) => ({
              ...r,
              unitsPerPackage: unitsMap[r.productId] ?? r.unitsPerPackage,
            })),
          );
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
          setProviderPriceMap(map);
          setUnitsPerPackageMap(unitsMap);
          setBarcodeMap((prev) => ({ ...bcMap, ...prev }));
          unitsPerPackageRef.current = { ...unitsMap };
          setPackagingMap(pkMap);
          setRows((prev) =>
            prev.map((r) => ({
              ...r,
              unitsPerPackage: unitsMap[r.productId] ?? r.unitsPerPackage,
            })),
          );
        }
      },
      (err) => console.error(err),
    );

    return () => unsub();
  }, []);

  const [barcodeMap, setBarcodeMap] = useState<Record<string, string>>({});
  const barcodeMapRef = useRef<Record<string, string>>({});
  const initialProductsSnapshot = useRef(true);
  const unitsPerPackageRef = useRef<Record<string, number>>({});
  const inventoryUnitsMapRef = useRef<Record<string, number>>({});
  const initialInventorySnapshot = useRef(true);
  const [providerPriceMap, setProviderPriceMap] = useState<
    Record<string, number>
  >({});
  const [unitsPerPackageMap, setUnitsPerPackageMap] = useState<
    Record<string, number>
  >({});
  const [inventoryUnitsMap, setInventoryUnitsMap] = useState<
    Record<string, number>
  >({});

  // Empaque map + filtro
  const [packagingMap, setPackagingMap] = useState<Record<string, string>>({});
  const [packagingFilter, setPackagingFilter] = useState<string>("");

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
          // update rows to reflect inventory units when present
          setRows((prev) =>
            prev.map((r) => ({
              ...r,
              unitsPerPackage:
                out[r.productId] ??
                unitsPerPackageMap[r.productId] ??
                r.unitsPerPackage,
            })),
          );
        } catch (e) {
          console.error("inventory_candies snapshot error:", e);
        }
      },
      (err) => console.error(err),
    );

    return () => unsubInv();
  }, [unitsPerPackageMap]);

  // Ensure rows pick up changes to unitsPerPackage coming from products_candies
  // or inventory_candies snapshots even when those snapshots fire after rows
  // were initially loaded.
  useEffect(() => {
    setRows((prev) =>
      prev.map((r) => ({
        ...r,
        unitsPerPackage:
          inventoryUnitsMap[r.productId] ??
          unitsPerPackageMap[r.productId] ??
          r.unitsPerPackage,
      })),
    );
  }, [unitsPerPackageMap, inventoryUnitsMap]);

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

  const toggleCategory = (cat: string) => {
    setOpenCategoryMap((prev) => ({
      ...prev,
      [cat]: !prev[cat],
    }));
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
  useEffect(() => {
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
        setIsAdmin(hasRole(subject, "admin"));
      } catch (e) {
        console.error(e);
        setIsAdmin(false);
      }
    });
    return () => unsub();
  }, []);

  const onDetected = async (code: string) => {
    if (scanTarget === "search") {
      setSearchCode(code);
      // try to open the matching product card immediately
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
      }
      setScanOpen(false);
      return;
    }
    if (scanTarget === "edit" && editingId) {
      try {
        // same collection used by CatalogoProductos
        const col = collection(db, "products_candies");
        const docRef = doc(col, editingId);
        await updateDoc(docRef, { barcode: code });
        setBarcodeMap((prev) => ({ ...prev, [editingId]: code }));
        setEditBarcode(code);
        setScanOpen(false);
        setScanTarget("search");
        setMsg("✅ Producto guardado.");
      } catch (err) {
        console.error(err);
        setMsg("❌ Error guardando el código.");
      }
    }
  };

  // Simple local save for edited prices (UI-only)
  const saveEditedPrices = async (id: string) => {
    // update local rows
    setRows((prev) =>
      prev.map((r) =>
        r.productId === id
          ? {
              ...r,
              priceIsla: Number(editPriceIsla || 0),
              priceRivas: Number(editPriceRivas || 0),
            }
          : r,
      ),
    );

    // persist packaging to products_candies if editing
    try {
      const pk = String(editPackaging || "").trim();
      await updateDoc(doc(collection(db, "products_candies"), id), {
        packaging: pk || "",
      });
      setPackagingMap((prev) => ({ ...prev, [id]: pk || "" }));
    } catch (e) {
      console.error("Error updating packaging:", e);
      setMsg("❌ Error guardando empaque.");
    }

    setEditingId(null);
    setMsg(isMobile ? "✅ Producto guardado." : "");
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Precio Ventas</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
        </div>
      </div>

      {/* ===== MOBILE: filtros colapsables ===== */}
      <div className="md:hidden mb-3">
        <button
          type="button"
          onClick={() => setFiltersOpenMobile((v) => !v)}
          className={`w-full px-3 py-3 rounded-xl border shadow-sm flex items-center justify-between ${
            hasActiveFilters ? "bg-yellow-50 border-yellow-200" : "bg-white"
          }`}
        >
          <div className="text-left">
            <div className="font-semibold">Filtros</div>
            <div className="text-xs text-gray-600">
              {hasActiveFilters ? "Activos" : "Ninguno"}
              {" • "}
              Mostrando <b>{filtered.length}</b>
            </div>
          </div>
          <div className="text-sm font-semibold">
            {filtersOpenMobile ? "Cerrar" : "Abrir"}
          </div>
        </button>

        {filtersOpenMobile && (
          <div className="mt-2 bg-white border rounded-xl shadow-sm p-3 text-sm">
            <div className="grid grid-cols-1 gap-3">
              <div>
                <label className="block font-semibold">Producto</label>
                <input
                  className="w-full border rounded px-2 py-2"
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(e.target.value)}
                  placeholder="Ej: Conitos, Gomitas…"
                />
              </div>

              <div>
                <label className="block font-semibold">Tipo empaque</label>
                <select
                  className="w-full border rounded px-2 py-2"
                  value={packagingFilter}
                  onChange={(e) => setPackagingFilter(e.target.value)}
                >
                  <option value="">Todos</option>
                  <option value="Tarro">Tarro</option>
                  <option value="Bolsa">Bolsa</option>
                  <option value="Ristra">Ristra</option>
                  <option value="Caja">Caja</option>
                  <option value="Vaso">Vaso</option>
                  <option value="Pana">Pana</option>
                </select>
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
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => {
                      setScanTarget("search");
                      setScanOpen(true);
                    }}
                  >
                    Escanear
                  </button>
                </div>
              </div>

              <div className="flex gap-2">
                <button
                  type="button"
                  className="flex-1 px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => {
                    clearFilters();
                    setSearchCode("");
                  }}
                >
                  Limpiar filtros
                </button>
                <button
                  type="button"
                  className="flex-1 px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                  onClick={() => setFiltersOpenMobile(false)}
                >
                  Aplicar
                </button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== WEB: filtros siempre visibles (igual idea de antes) ===== */}
      <div className="hidden md:block bg-white p-3 rounded shadow border mb-3 text-sm">
        <div className="grid grid-cols-6 gap-3 items-end">
          <div className="col-span-2">
            <label className="block font-semibold">Filtrar por producto</label>
            <input
              className="w-full border rounded px-2 py-1"
              value={searchProduct}
              onChange={(e) => setSearchProduct(e.target.value)}
              placeholder="Ej: Conitos, Gomitas…"
            />
          </div>

          <div>
            <label className="block font-semibold">Tipo empaque</label>
            <select
              className="w-full border rounded px-2 py-1"
              value={packagingFilter}
              onChange={(e) => setPackagingFilter(e.target.value)}
            >
              <option value="">Todos</option>
              <option value="Tarro">Tarro</option>
              <option value="Bolsa">Bolsa</option>
              <option value="Ristra">Ristra</option>
              <option value="Caja">Caja</option>
              <option value="Vaso">Vaso</option>
              <option value="Pana">Pana</option>
            </select>
          </div>

          <div>
            <label className="block font-semibold">Precio mín</label>
            <input
              className="w-full border rounded px-2 py-1 text-right"
              inputMode="decimal"
              value={minPrice}
              onChange={(e) => setMinPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div>
            <label className="block font-semibold">Precio máx</label>
            <input
              className="w-full border rounded px-2 py-1 text-right"
              inputMode="decimal"
              value={maxPrice}
              onChange={(e) => setMaxPrice(e.target.value)}
              placeholder="0"
            />
          </div>

          <div className="text-right">
            <button
              className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
              type="button"
              onClick={clearFilters}
            >
              Limpiar
            </button>
          </div>
        </div>

        <div className="mt-2 flex items-center justify-between">
          <div className="text-xs text-gray-600">
            Fuente: <b>candy_main_orders.items[]</b> • Muestra el{" "}
            <b>último precio</b> registrado por producto.
          </div>
          <div className="text-sm">
            <span className="text-gray-600">Mostrando:</span>{" "}
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
            {filteredByCategory.map(([cat, items]) => {
              const expandedCategory = !!openCategoryMap[cat];
              return (
                <div
                  key={cat}
                  className="bg-white border rounded-2xl shadow-sm overflow-hidden"
                >
                  <button
                    type="button"
                    className="w-full px-3 py-3 flex items-center justify-between text-left"
                    onClick={() => toggleCategory(cat)}
                  >
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold truncate">
                        {cat}
                      </div>
                      <div className="text-[10px] text-gray-600 truncate">
                        {items.length}{" "}
                        {items.length === 1 ? "producto" : "productos"}
                      </div>
                    </div>
                    <div className="text-sm font-semibold">
                      {expandedCategory ? "−" : "+"}
                    </div>
                  </button>

                  {expandedCategory && (
                    <div className="px-3 pb-3 border-t space-y-2">
                      {items.map((r) => {
                        const expanded = openCardId === r.productId;
                        const isEditing = editingId === r.productId;
                        const providerPrice =
                          providerPriceMap[r.productId] || 0;
                        const utilidad = r.priceIsla - providerPrice;
                        const comision = utilidad * 0.25;
                        return (
                          <div
                            key={r.productId}
                            className="bg-white border rounded-xl overflow-hidden"
                          >
                            <button
                              type="button"
                              className="w-full px-3 py-3 flex items-center justify-between text-left"
                              onClick={() =>
                                setOpenCardId((cur) =>
                                  cur === r.productId ? null : r.productId,
                                )
                              }
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
                                <div className="text-[10px] text-gray-600">
                                  P. Paquete
                                </div>
                                <div className="text-sm font-semibold tabular-nums">
                                  {money(r.priceIsla)}
                                </div>
                              </div>
                            </button>

                            {expanded && (
                              <div className="px-3 pb-3 border-t">
                                <div className="pt-3 space-y-2 text-sm">
                                  <div className="grid grid-cols-2 gap-2">
                                    <div>
                                      <div className="text-[10px] text-gray-600">
                                        Categoría
                                      </div>
                                      <div className="text-sm">
                                        {r.category}
                                      </div>

                                      <div className="mt-2">
                                        <div className="text-[10px] text-gray-600">
                                          Unidades x paquete
                                        </div>
                                        <div className="text-sm">
                                          {String(r.unitsPerPackage || 1)}
                                        </div>
                                      </div>

                                      <div className="mt-2">
                                        <div className="text-[10px] text-gray-600">
                                          Precio Unidad
                                        </div>
                                        <div className="text-sm tabular-nums">
                                          {money(
                                            r.priceIsla /
                                              (r.unitsPerPackage || 1),
                                          )}
                                        </div>
                                      </div>

                                      <div className="mt-2">
                                        <div className="text-[10px] text-gray-600">
                                          Precio Paquete
                                        </div>
                                        {isEditing ? (
                                          <input
                                            className="w-full border rounded px-2 py-2 text-right"
                                            inputMode="decimal"
                                            value={String(editPriceIsla)}
                                            onChange={(e) =>
                                              setEditPriceIsla(
                                                Number(e.target.value || 0),
                                              )
                                            }
                                          />
                                        ) : (
                                          <div className="text-sm font-semibold tabular-nums">
                                            {money(r.priceIsla)}
                                          </div>
                                        )}
                                      </div>
                                    </div>

                                    <div>
                                      <div>
                                        <div className="text-[10px] text-gray-600">
                                          Utilidad Bruta
                                        </div>
                                        <div className="text-sm tabular-nums">
                                          {money(utilidad)}
                                        </div>
                                      </div>

                                      <div className="mt-1">
                                        <div className="text-[10px] text-gray-600">
                                          Comisión
                                        </div>
                                        <div className="text-sm tabular-nums">
                                          {money(comision)}
                                        </div>
                                      </div>

                                      <div className="mt-2">
                                        <div className="text-[10px] text-gray-600">
                                          Código EAN
                                        </div>
                                        {isEditing ? (
                                          <div className="flex gap-2">
                                            <input
                                              className="flex-1 border rounded px-2 py-2"
                                              value={editBarcode}
                                              readOnly
                                            />
                                            <button
                                              className="px-3 py-2 rounded bg-blue-600 text-white"
                                              onClick={() => {
                                                setScanTarget("edit");
                                                setScanOpen(true);
                                              }}
                                              type="button"
                                            >
                                              Escanear
                                            </button>
                                          </div>
                                        ) : (
                                          <div>
                                            {barcodeMap[r.productId] || "—"}
                                          </div>
                                        )}
                                      </div>

                                      <div className="mt-2">
                                        <div className="text-[10px] text-gray-600">
                                          Tipo Empaque
                                        </div>
                                        {isEditing ? (
                                          <select
                                            className="w-full border rounded px-2 py-2"
                                            value={editPackaging}
                                            onChange={(e) =>
                                              setEditPackaging(e.target.value)
                                            }
                                          >
                                            <option value="">—</option>
                                            <option value="Tarro">Tarro</option>
                                            <option value="Bolsa">Bolsa</option>
                                            <option value="Ristra">
                                              Ristra
                                            </option>
                                            <option value="Caja">Caja</option>
                                            <option value="Vaso">Vaso</option>
                                            <option value="Pana">Pana</option>
                                          </select>
                                        ) : (
                                          <div className="text-sm">
                                            {packagingMap[r.productId] || "—"}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  </div>

                                  {/* actions */}
                                  <div className="flex gap-2">
                                    {isEditing ? (
                                      <>
                                        <button
                                          className="px-3 py-2 rounded bg-green-600 text-white"
                                          onClick={() => {
                                            saveEditedPrices(r.productId);
                                            setOpenCardId(null);
                                          }}
                                          type="button"
                                        >
                                          Guardar
                                        </button>
                                        <button
                                          className="px-3 py-2 rounded bg-gray-800 text-white"
                                          onClick={() => {
                                            setScanTarget("edit");
                                            setScanOpen(true);
                                          }}
                                          type="button"
                                        >
                                          Escanear
                                        </button>
                                        <button
                                          className="px-3 py-2 rounded bg-gray-200"
                                          onClick={() => setEditingId(null)}
                                          type="button"
                                        >
                                          Cancelar
                                        </button>
                                      </>
                                    ) : (
                                      isAdmin && (
                                        <>
                                          <button
                                            className="px-3 py-2 rounded bg-yellow-400"
                                            onClick={() => {
                                              setEditingId(r.productId);
                                              setEditPriceIsla(
                                                r.priceIsla || 0,
                                              );
                                              setEditPriceRivas(
                                                r.priceRivas || 0,
                                              );
                                              setEditBarcode(
                                                barcodeMap[r.productId] || "",
                                              );
                                              setEditPackaging(
                                                packagingMap[r.productId] || "",
                                              );
                                            }}
                                            type="button"
                                          >
                                            Editar
                                          </button>
                                          <button
                                            className="px-3 py-2 rounded bg-red-600 text-white"
                                            onClick={() =>
                                              setRows((prev) =>
                                                prev.filter(
                                                  (x) =>
                                                    x.productId !== r.productId,
                                                ),
                                              )
                                            }
                                            type="button"
                                          >
                                            Borrar
                                          </button>
                                        </>
                                      )
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

        {msg && <p className="mt-2 text-sm">{msg}</p>}
      </div>

      <BarcodeScanModal
        open={scanOpen}
        onClose={() => setScanOpen(false)}
        onDetected={onDetected}
      />

      {/* ===== WEB: tabla ===== */}
      <div className="hidden md:block bg-white rounded shadow border w-full overflow-x-auto">
        <table className="min-w-[900px] w-full text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border text-left">Categoría</th>
              <th className="p-2 border text-left">Producto</th>
              <th className="p-2 border text-left">Empaque</th>
              <th className="p-2 border text-right">Precio Isla</th>
              <th className="p-2 border text-right">Precio Rivas</th>
              <th className="p-2 border text-right">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={6}>
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={6}>
                  Sin resultados.
                </td>
              </tr>
            ) : (
              filtered.map((r) => (
                <tr key={r.productId}>
                  <td className="p-2 border">{r.category}</td>
                  <td className="p-2 border">{r.productName}</td>
                  <td className="p-2 border">
                    {editingId === r.productId ? (
                      <select
                        className="w-full border rounded px-2 py-1"
                        value={editPackaging}
                        onChange={(e) => setEditPackaging(e.target.value)}
                      >
                        <option value="">—</option>
                        <option value="Tarro">Tarro</option>
                        <option value="Bolsa">Bolsa</option>
                        <option value="Ristra">Ristra</option>
                        <option value="Caja">Caja</option>
                        <option value="Vaso">Vaso</option>
                        <option value="Pana">Pana</option>
                      </select>
                    ) : (
                      packagingMap[r.productId] || "—"
                    )}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {editingId === r.productId ? (
                      <input
                        className="w-24 border rounded px-2 py-1 text-right"
                        inputMode="decimal"
                        value={String(editPriceIsla)}
                        onChange={(e) =>
                          setEditPriceIsla(Number(e.target.value || 0))
                        }
                      />
                    ) : (
                      money(r.priceIsla)
                    )}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {editingId === r.productId ? (
                      <input
                        className="w-24 border rounded px-2 py-1 text-right"
                        inputMode="decimal"
                        value={String(editPriceRivas)}
                        onChange={(e) =>
                          setEditPriceRivas(Number(e.target.value || 0))
                        }
                      />
                    ) : (
                      money(r.priceRivas)
                    )}
                  </td>
                  <td className="p-2 border text-right">
                    {editingId === r.productId ? (
                      <div className="flex items-center justify-end gap-2">
                        <button
                          className="px-2 py-1 rounded bg-green-600 text-white text-sm"
                          onClick={() => saveEditedPrices(r.productId)}
                          type="button"
                        >
                          Guardar
                        </button>
                        <button
                          className="px-2 py-1 rounded bg-gray-200 text-sm"
                          onClick={() => setEditingId(null)}
                          type="button"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      isAdmin && (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            className="px-2 py-1 rounded bg-yellow-400 text-sm"
                            onClick={() => {
                              setEditingId(r.productId);
                              setEditPriceIsla(r.priceIsla || 0);
                              setEditPriceRivas(r.priceRivas || 0);
                              setEditBarcode(barcodeMap[r.productId] || "");
                            }}
                            type="button"
                          >
                            Editar
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-blue-600 text-white text-sm"
                            onClick={() => {
                              setEditingId(r.productId);
                              setScanTarget("edit");
                              setScanOpen(true);
                            }}
                            type="button"
                          >
                            Escanear
                          </button>
                          <button
                            className="px-2 py-1 rounded bg-red-600 text-white text-sm"
                            onClick={() =>
                              setRows((prev) =>
                                prev.filter((x) => x.productId !== r.productId),
                              )
                            }
                            type="button"
                          >
                            Borrar
                          </button>
                        </div>
                      )
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* msg para web (móvil ya lo muestra arriba) */}
      {msg && <p className="hidden md:block mt-2 text-sm">{msg}</p>}
    </div>
  );
}
