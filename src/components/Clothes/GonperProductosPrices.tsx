// src/components/Stationery/ProductsStationery.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  query,
  updateDoc,
  Timestamp,
  writeBatch,
} from "firebase/firestore";
import * as XLSX from "xlsx";
import { db } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import { BrowserMultiFormatReader } from "@zxing/browser";

/* =========================
   TYPES
========================= */
type Gender = "Hombre" | "Mujer" | "Variado" | "NA";

type StationeryProduct = {
  id: string;
  category: string;
  name: string;
  brand: string;

  providerPrice: number;
  quantity: number;

  facturado: number; // providerPrice * quantity
  margin: number; // providerPrice / salePrice (efectivo)
  salePrice: number; // editable (si cambia, recalcula margin)
  gain: number; // (salePrice - providerPrice) * quantity
  totalEsperado: number; // ✅ salePrice * quantity

  gender: Gender;
  typeProduct: string;

  code?: string | null;

  createdAt?: any;
  updatedAt?: any;
};

type ImportRow = {
  id?: string; // opcional para update exacto
  category: string;
  name: string;
  providerPrice: number;
  quantity: number;
  margin: number;
  salePrice?: number; // opcional, si viene, manda (y recalcula margin)
  gender: Gender;
  typeProduct: string;
  code?: string;
  _raw?: Record<string, any>;
};

const CATEGORY_OPTIONS = [
  "Cuaderno",
  "Block",
  "Lapicero",
  "Lápiz",
  "Tajador",
  "Borrador",
  "Corrector",
  "Cartucheras",
];

const BRAND_OPTIONS = [
  "Lider",
  "Scribe",
  "Smarty",
  "Pointer",
  "Paper Mate",
  "Otro",
];

const GENDER_OPTIONS: Gender[] = ["Hombre", "Mujer", "Variado", "NA"];

const TYPE_OPTIONS = [
  "Universitario Cocido",
  "5 Materia",
  "2 Materia",
  "Doble Raya",
  "Rayado",
  "Cuadriculado",
  "Subrayado",
  "Sublineado",
  "Liso",
];

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

function roundInt(v: any, fallback = 1) {
  const n = Math.floor(toNum(v, fallback));
  return n > 0 ? n : fallback;
}

function clampMargin(m: number) {
  // tu margen típico: 0.70 / 0.80 etc.
  // No lo fuerzo a un rango duro, pero evito 0 o negativos
  if (!Number.isFinite(m) || m <= 0) return 0;
  return m;
}

function cleanCode(v: any) {
  const s = String(v ?? "").trim();
  return s ? s : "";
}

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

function isEmptyRow(obj: Record<string, any>) {
  const vals = Object.values(obj || {});
  return vals.every((v) => norm(v) === "");
}

/* =========================
   CALC
========================= */
function calcAll(params: {
  providerPrice: number;
  quantity: number;
  margin: number;
  salePrice?: number; // si viene >0, manda
}) {
  const providerPrice = Math.max(0, toNum(params.providerPrice, 0));
  const quantity = Math.max(1, roundInt(params.quantity, 1));
  const marginIn = clampMargin(toNum(params.margin, 0));

  // Si salePrice viene, manda (y margin se recalcula)
  const salePriceInput = Math.max(0, toNum(params.salePrice, 0));

  const salePriceComputed =
    marginIn > 0 ? providerPrice / marginIn : providerPrice;

  const finalSalePrice =
    salePriceInput > 0 ? salePriceInput : salePriceComputed;

  const finalMargin =
    finalSalePrice > 0 ? providerPrice / finalSalePrice : marginIn;

  const facturado = providerPrice * quantity;
  const gain = (finalSalePrice - providerPrice) * quantity;
  const totalEsperado = finalSalePrice * quantity;

  return {
    providerPrice,
    quantity,
    margin: finalMargin,
    salePrice: finalSalePrice,
    facturado,
    gain,
    totalEsperado,
  };
}

/* =========================
   COMPONENT
========================= */
export default function ProductsStationery() {
  const { refreshKey, refresh } = useManualRefresh();

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  const [products, setProducts] = useState<StationeryProduct[]>([]);

  /* ===== filters (expandible web + mobile) ===== */
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [searchProduct, setSearchProduct] = useState("");
  const [searchCode, setSearchCode] = useState("");
  const [minPrice, setMinPrice] = useState<string>("");
  const [maxPrice, setMaxPrice] = useState<string>("");

  /* ===== create/edit modal ===== */
  const [openForm, setOpenForm] = useState(false);
  const [editing, setEditing] = useState<StationeryProduct | null>(null);

  /* ===== scan modal (buscar producto existente) ===== */
  const [scanInfoOpen, setScanInfoOpen] = useState(false);
  const [scanInfoProduct, setScanInfoProduct] =
    useState<StationeryProduct | null>(null);

  /* ===== form state ===== */
  const [category, setCategory] = useState(CATEGORY_OPTIONS[0]);
  const [brand, setBrand] = useState(BRAND_OPTIONS[0]);

  const [name, setName] = useState("");
  const [providerPrice, setProviderPrice] = useState(0);
  const [quantity, setQuantity] = useState(1);

  const [margin, setMargin] = useState(0.7);
  const [salePrice, setSalePrice] = useState(0); // editable

  const [gender, setGender] = useState<Gender>("NA");
  const [typeProduct, setTypeProduct] = useState("");
  const [code, setCode] = useState("");

  /* ===== import/export ===== */
  const [importOpen, setImportOpen] = useState(false);
  const [importFileName, setImportFileName] = useState("");
  const [importRows, setImportRows] = useState<ImportRow[]>([]);
  const [importErrors, setImportErrors] = useState<string[]>([]);
  const [importLoading, setImportLoading] = useState(false);

  /* =========================
     LOAD
  ========================= */
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        const snap = await getDocs(
          query(collection(db, "products_stationery")),
        );
        const list: StationeryProduct[] = [];
        snap.forEach((d) => {
          const x = d.data() as any;
          list.push({
            id: d.id,
            category: x.category || "",
            brand: x.brand || "",
            name: x.name || "",
            providerPrice: Number(x.providerPrice || 0),
            quantity: Number(x.quantity || 1),
            facturado: Number(x.facturado || 0),
            margin: Number(x.margin || 0),
            salePrice: Number(x.salePrice || 0),
            gain: Number(x.gain || 0),
            gender: (x.gender || "NA") as Gender,
            typeProduct: x.typeProduct || "",
            code: x.code ?? "",
            createdAt: x.createdAt,
            updatedAt: x.updatedAt,
            totalEsperado: Number(
              x.totalEsperado ||
                Number(x.salePrice || 0) * Number(x.quantity || 1),
            ),
          });
        });
        setProducts(list);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando productos (papelería).");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  /* =========================
     FILTERED
  ========================= */
  const filtered = useMemo(() => {
    const q = norm(searchProduct);
    const c = norm(searchCode);

    const min = minPrice.trim() === "" ? null : toNum(minPrice, NaN);
    const max = maxPrice.trim() === "" ? null : toNum(maxPrice, NaN);

    return products.filter((p) => {
      if (q) {
        const hay = `${p.category} ${p.name}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (c) {
        const codeHay = String(p.code || "").toLowerCase();
        if (!codeHay.includes(c)) return false;
      }
      if (min != null && Number.isFinite(min)) {
        if (p.salePrice < (min as number)) return false;
      }
      if (max != null && Number.isFinite(max)) {
        if (p.salePrice > (max as number)) return false;
      }
      return true;
    });
  }, [products, searchProduct, searchCode, minPrice, maxPrice]);

  const hasActiveFilters = useMemo(() => {
    return (
      searchProduct.trim() !== "" ||
      searchCode.trim() !== "" ||
      minPrice.trim() !== "" ||
      maxPrice.trim() !== ""
    );
  }, [searchProduct, searchCode, minPrice, maxPrice]);

  /* =========================
     KPIS (sobre TODO el catálogo)
  ========================= */
  const kpis = useMemo(() => {
    const count = products.length;
    const sumFact = products.reduce((a, p) => a + (p.facturado || 0), 0);
    const sumEsperado = products.reduce(
      (a, p) =>
        a +
        Number(
          p.totalEsperado || Number(p.salePrice || 0) * Number(p.quantity || 1),
        ),
      0,
    );

    const sumGain = products.reduce((a, p) => a + (p.gain || 0), 0);

    return { count, sumFact, sumEsperado, sumGain };
  }, [products]);

  /* =========================
     FORM HELPERS
  ========================= */
  const resetForm = () => {
    setCategory(CATEGORY_OPTIONS[0]);
    setName("");
    setProviderPrice(0);
    setQuantity(1);
    setMargin(0.7);
    setSalePrice(0);
    setGender("NA");
    setTypeProduct("");
    setCode("");
    setEditing(null);
  };

  const openCreate = () => {
    resetForm();
    setOpenForm(true);
  };

  const openEdit = (p: StationeryProduct) => {
    setEditing(p);
    setCategory(p.category || CATEGORY_OPTIONS[0]);
    setBrand(p.brand || BRAND_OPTIONS[0]);

    setName(p.name || "");
    setProviderPrice(Number(p.providerPrice || 0));
    setQuantity(Number(p.quantity || 1));
    setMargin(Number(p.margin || 0.7));
    setSalePrice(Number(p.salePrice || 0));
    setGender((p.gender || "NA") as Gender);
    setTypeProduct(p.typeProduct || "");
    setCode(String(p.code || ""));
    setOpenForm(true);
  };

  /* =========================
     SAVE PRODUCT (create/update)
  ========================= */
  const saveProduct = async () => {
    setMsg("");

    const c = String(category || "").trim();
    const b = String(brand || "").trim();

    const n = String(name || "").trim();

    const {
      providerPrice: pp,
      quantity: qty,
      margin: m,
      salePrice: sp,
      facturado: fac,
      totalEsperado: te,
      gain: g,
    } = calcAll({ providerPrice, quantity, margin, salePrice });

    if (!c) return setMsg("⚠️ Categoría requerida.");
    if (!n) return setMsg("⚠️ Producto requerido.");
    if (pp <= 0) return setMsg("⚠️ Precio proveedor debe ser > 0.");
    if (qty <= 0) return setMsg("⚠️ Cantidad debe ser > 0.");
    if (sp <= 0) return setMsg("⚠️ Precio venta inválido.");
    if (m <= 0) return setMsg("⚠️ Margen inválido.");

    const payload = {
      category: c,
      brand: b,
      name: n,
      providerPrice: pp,
      quantity: qty,
      facturado: fac,
      margin: m,
      salePrice: sp,
      gain: g,
      gender: gender || "NA",
      typeProduct: String(typeProduct || "").trim(),
      code: cleanCode(code) || null,
      updatedAt: Timestamp.now(),
      totalEsperado: te,
    };

    try {
      setLoading(true);

      if (editing) {
        await updateDoc(doc(db, "products_stationery", editing.id), payload);
        setMsg("✅ Producto actualizado.");
      } else {
        await addDoc(collection(db, "products_stationery"), {
          ...payload,
          createdAt: Timestamp.now(),
        });
        setMsg("✅ Producto creado.");
      }

      setOpenForm(false);
      setEditing(null);
      resetForm();
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error guardando producto.");
    } finally {
      setLoading(false);
    }
  };

  /* =========================
     SCAN (camera) - reuse
  ========================= */
  const scanBarcodeOnce = async (): Promise<string | null> => {
    try {
      const reader = new BrowserMultiFormatReader();
      const devices = await BrowserMultiFormatReader.listVideoInputDevices();
      const deviceId = devices[devices.length - 1]?.deviceId;
      if (!deviceId) return null;

      const overlay = document.createElement("div");
      overlay.className =
        "fixed inset-0 z-[9999] bg-black/70 flex items-center justify-center p-3";
      const box = document.createElement("div");
      box.className =
        "bg-white w-full max-w-md rounded-xl overflow-hidden shadow-xl";
      const header = document.createElement("div");
      header.className = "p-3 flex items-center justify-between border-b";
      header.innerHTML = "<div style='font-weight:700'>Escanear código</div>";
      const btn = document.createElement("button");
      btn.textContent = "Cerrar";
      btn.className = "px-3 py-1 rounded bg-gray-200";
      const videoWrap = document.createElement("div");
      videoWrap.className = "p-3";
      const video = document.createElement("video");
      video.style.width = "100%";
      video.style.borderRadius = "12px";
      videoWrap.appendChild(video);

      header.appendChild(btn);
      box.appendChild(header);
      box.appendChild(videoWrap);
      overlay.appendChild(box);
      document.body.appendChild(overlay);

      return await new Promise<string | null>(async (resolve) => {
        const close = () => {
          overlay.remove();
          resolve(null);
        };
        btn.onclick = close;

        const controls = await reader.decodeFromVideoDevice(
          deviceId,
          video,
          (res) => {
            if (res) {
              const text = res.getText();
              try {
                controls.stop();
              } catch {}

              overlay.remove();
              resolve(text);
            }
          },
        );
      });
    } catch (e) {
      console.error(e);
      return null;
    }
  };

  // Escanear para llenar el input "code" del formulario
  const handleScanToForm = async () => {
    const c = await scanBarcodeOnce();
    if (c) setCode(c);
  };

  // Escanear para buscar un producto existente y mostrar modal pequeño
  const handleScanLookup = async () => {
    const c = await scanBarcodeOnce();
    if (!c) return;

    const found = products.find((p) => String(p.code || "") === String(c));
    if (found) {
      setScanInfoProduct(found);
      setScanInfoOpen(true);
      setMsg("");
    } else {
      setScanInfoProduct(null);
      setScanInfoOpen(true);
      setMsg("");
    }
  };

  /* =========================
     EXPORT XLSX (todo / filtrado)
  ========================= */
  const exportExcel = (rows: StationeryProduct[], filename: string) => {
    const data = rows.map((p) => ({
      Id: p.id,
      Categoria: p.category,
      brand: p.brand,
      Producto: p.name,
      PrecioProveedor: p.providerPrice,
      Cantidad: p.quantity,
      Facturado: p.facturado,
      TotalEsperado: p.totalEsperado || p.salePrice * p.quantity,
      Margen: p.margin,
      PrecioVenta: p.salePrice,
      Ganancia: p.gain,
      Genero: p.gender,
      TipoProducto: p.typeProduct,
      Codigo: p.code || "",
    }));

    const ws = XLSX.utils.json_to_sheet(data);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Productos");
    XLSX.writeFile(wb, filename);
  };

  /* =========================
     IMPORT XLSX/CSV (igual que candies)
  ========================= */
  const downloadTemplateXlsx = () => {
    const data = [
      {
        Id: "",
        Categoria: "Cuaderno",
        brand: "Lider",
        Producto: "Cuaderno Norma 100 hojas",
        PrecioProveedor: 120,
        Cantidad: 12,
        Margen: 0.7,
        PrecioVenta: "", // opcional
        Genero: "NA",
        TipoProducto: "Universitario Cocido",
        Codigo: "1234567890123",
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
    a.download = "template_products_stationery.xlsx";
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

      const rowNumber = idx + 2;

      const id = String(
        pickCol(r, ["Id", "ID", "docId", "DocId"]) ?? "",
      ).trim();

      const cat = String(
        pickCol(r, ["Categoria", "Categoría", "Category", "category"]) ?? "",
      ).trim();

      const br = String(
        pickCol(r, ["Brand", "Marca", "brand", "marca"]) ?? "",
      ).trim();

      const prod = String(
        pickCol(r, ["Producto", "Product", "Nombre", "Name", "name"]) ?? "",
      ).trim();

      const ppRaw = pickCol(r, [
        "PrecioProveedor",
        "Precio Prov",
        "Precio Prov.",
        "ProviderPrice",
        "Costo",
        "providerPrice",
      ]);

      const qtyRaw = pickCol(r, ["Cantidad", "Qty", "quantity", "cantidad"]);

      const marginRaw = pickCol(r, ["Margen", "Margin", "margen", "margin"]);

      const salePriceRaw = pickCol(r, [
        "PrecioVenta",
        "Precio Venta",
        "SalePrice",
        "salePrice",
      ]);

      const genderRaw = String(
        pickCol(r, ["Genero", "Género", "Gender", "gender"]) ?? "NA",
      ).trim() as Gender;

      const typeRaw = String(
        pickCol(r, [
          "TipoProducto",
          "Tipo",
          "TypeProduct",
          "typeProduct",
          "Tipo producto",
        ]) ?? "",
      ).trim();

      const codeRaw = pickCol(r, [
        "Codigo",
        "Código",
        "Code",
        "Barcode",
        "code",
      ]);
      const code = cleanCode(codeRaw);

      const providerPrice = Math.max(0, toNum(ppRaw, 0));
      const quantity = Math.max(1, roundInt(qtyRaw, 1));
      const margin = clampMargin(toNum(marginRaw, 0));

      const salePrice = Math.max(0, toNum(salePriceRaw, 0));

      if (!cat) errors.push(`Fila ${rowNumber}: falta Categoria.`);
      if (!prod) errors.push(`Fila ${rowNumber}: falta Producto.`);
      if (providerPrice <= 0)
        errors.push(`Fila ${rowNumber}: PrecioProveedor debe ser > 0.`);
      if (quantity <= 0)
        errors.push(`Fila ${rowNumber}: Cantidad debe ser > 0.`);
      if (margin <= 0 && salePrice <= 0)
        errors.push(
          `Fila ${rowNumber}: Margen debe ser > 0 (o enviar PrecioVenta).`,
        );

      const genderOk = GENDER_OPTIONS.includes(genderRaw || "NA");
      const genderFinal: Gender = genderOk ? (genderRaw as Gender) : "NA";

      if (
        cat &&
        prod &&
        providerPrice > 0 &&
        quantity > 0 &&
        (margin > 0 || salePrice > 0)
      ) {
        rows.push({
          id: id || undefined,
          category: cat,
          brand: br,
          name: prod,
          providerPrice,
          quantity,
          margin: margin > 0 ? margin : 0.7, // fallback si solo vino PrecioVenta
          salePrice: salePrice > 0 ? salePrice : undefined,
          gender: genderFinal,
          typeProduct: typeRaw,
          code: code || "",
          _raw: r,
        });
      }
    });

    // dedup dentro del archivo (id o category+name)
    const map = new Map<string, ImportRow>();
    for (const r of rows) {
      const k = r.id ? `id::${r.id}` : `${norm(r.category)}::${norm(r.name)}`;
      map.set(k, r);
    }

    return { rows: Array.from(map.values()), errors };
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
      const curr = copy[index];
      if (!curr) return prev;
      copy[index] = { ...curr, ...patch };
      return copy;
    });
  };

  const importStats = useMemo(() => {
    const existingById = new Set(products.map((p) => p.id));
    const existingKeys = new Set(
      products.map((p) => `${norm(p.category)}::${norm(p.name)}`),
    );

    let willUpdate = 0;
    let willCreate = 0;

    for (const r of importRows) {
      if (r.id && existingById.has(r.id)) {
        willUpdate += 1;
        continue;
      }
      const k = `${norm(r.category)}::${norm(r.name)}`;
      if (existingKeys.has(k)) willUpdate += 1;
      else willCreate += 1;
    }

    return { total: importRows.length, willCreate, willUpdate };
  }, [importRows, products]);

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

      // index existentes por id y por key (cat+name)
      const existingById: Record<string, StationeryProduct> = {};
      const existingByKey: Record<string, StationeryProduct> = {};
      products.forEach((p) => {
        existingById[p.id] = p;
        existingByKey[`${norm(p.category)}::${norm(p.name)}`] = p;
      });

      const batch = writeBatch(db);

      let toCreate = 0;
      let toUpdate = 0;

      for (const r of importRows) {
        const c = String(r.category || "").trim();
        const n = String(r.name || "").trim();

        const {
          providerPrice: pp,
          quantity: qty,
          margin: m,
          salePrice: sp,
          facturado: fac,
          totalEsperado: te,
          gain: g,
        } = calcAll({
          providerPrice: r.providerPrice,
          quantity: r.quantity,
          margin: r.margin,
          salePrice: r.salePrice,
        });

        if (!c || !n || pp <= 0 || qty <= 0 || sp <= 0 || m <= 0) continue;

        const payload = {
          category: c,
          name: n,
          providerPrice: pp,
          quantity: qty,
          facturado: fac,
          totalEsperado: te,

          margin: m,
          salePrice: sp,
          gain: g,
          gender: (r.gender || "NA") as Gender,
          typeProduct: String(r.typeProduct || "").trim(),
          code: cleanCode(r.code) || null,
          updatedAt: Timestamp.now(),
        };

        // match
        let existing: StationeryProduct | undefined;
        if (r.id && existingById[r.id]) {
          existing = existingById[r.id];
        } else {
          const key = `${norm(c)}::${norm(n)}`;
          existing = existingByKey[key];
        }

        if (existing) {
          batch.update(doc(db, "products_stationery", existing.id), payload);
          toUpdate += 1;
        } else {
          const ref = doc(collection(db, "products_stationery"));
          batch.set(ref, { ...payload, createdAt: Timestamp.now() });
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

  /* =========================
     UI
  ========================= */
  const clearFilters = () => {
    setSearchProduct("");
    setSearchCode("");
    setMinPrice("");
    setMaxPrice("");
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* HEADER */}
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Papelería</h2>
        <div className="flex gap-2 flex-wrap justify-end">
          <button
            className="px-3 py-2 rounded bg-gray-900 text-white hover:bg-black"
            onClick={handleScanLookup}
            type="button"
          >
            Escanear
          </button>

          <button
            className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
            onClick={openCreate}
            type="button"
          >
            + Nuevo
          </button>

          <button
            className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
            onClick={() => {
              setImportOpen(true);
              setImportRows([]);
              setImportErrors([]);
              setImportFileName("");
            }}
            type="button"
          >
            Importar (.xlsx)
          </button>

          <button
            className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
            onClick={() =>
              exportExcel(products, "products_stationery_todo.xlsx")
            }
            type="button"
          >
            Exportar (todo)
          </button>

          <button
            className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
            onClick={() =>
              exportExcel(filtered, "products_stationery_filtrado.xlsx")
            }
            type="button"
          >
            Exportar (filtrado)
          </button>

          <RefreshButton onClick={refresh} loading={loading || importLoading} />
        </div>
      </div>

      {/* KPI */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
        <Kpi label="Productos" value={kpis.count} />
        <Kpi label="Facturado" value={money(kpis.sumFact)} />
        <Kpi label="Esperado" value={money(kpis.sumEsperado)} />
        <Kpi label="Ganancia" value={money(kpis.sumGain)} />
      </div>

      {/* FILTERS (expandible web + mobile) */}
      <div className="mb-3">
        <button
          className={`w-full md:w-auto px-3 py-2 rounded border bg-white hover:bg-gray-50 ${
            hasActiveFilters ? "border-yellow-300 bg-yellow-50" : ""
          }`}
          type="button"
          onClick={() => setFiltersOpen((v) => !v)}
        >
          {filtersOpen ? "Cerrar filtros" : "Abrir filtros"}{" "}
          {hasActiveFilters ? "(activos)" : ""}
        </button>

        {filtersOpen && (
          <div className="mt-2 bg-white border rounded-xl shadow-sm p-3 text-sm">
            <div className="grid grid-cols-1 md:grid-cols-4 gap-3 items-end">
              <div>
                <label className="block font-semibold">Producto</label>
                <input
                  className="w-full border rounded px-2 py-2"
                  value={searchProduct}
                  onChange={(e) => setSearchProduct(e.target.value)}
                  placeholder="Ej: Cuaderno Norma…"
                />
              </div>

              <div>
                <label className="block font-semibold">Código</label>
                <input
                  className="w-full border rounded px-2 py-2"
                  value={searchCode}
                  onChange={(e) => setSearchCode(e.target.value)}
                  placeholder="Barcode…"
                />
              </div>

              <div>
                <label className="block font-semibold">Precio venta mín</label>
                <input
                  className="w-full border rounded px-2 py-2 text-right"
                  inputMode="decimal"
                  value={minPrice}
                  onChange={(e) => setMinPrice(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div>
                <label className="block font-semibold">Precio venta máx</label>
                <input
                  className="w-full border rounded px-2 py-2 text-right"
                  inputMode="decimal"
                  value={maxPrice}
                  onChange={(e) => setMaxPrice(e.target.value)}
                  placeholder="0"
                />
              </div>

              <div className="md:col-span-4 flex gap-2 justify-end">
                <button
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  type="button"
                  onClick={clearFilters}
                >
                  Limpiar
                </button>
                <button
                  className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
                  type="button"
                  onClick={() => setFiltersOpen(false)}
                >
                  Aplicar
                </button>
              </div>
            </div>

            <div className="mt-2 flex items-center justify-between text-xs text-gray-600">
              <div>
                Mostrando: <b>{filtered.length}</b>
              </div>
              <div>
                Colección: <b>products_stationery</b>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* MOBILE LIST */}
      <div className="md:hidden space-y-2">
        {loading ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Cargando…
          </div>
        ) : filtered.length === 0 ? (
          <div className="bg-white rounded-xl border shadow p-4 text-center">
            Sin resultados.
          </div>
        ) : (
          filtered.map((p) => (
            <div
              key={p.id}
              className="bg-white border rounded-xl p-3 shadow-sm"
            >
              <div className="text-xs text-gray-600">{p.category}</div>
              <div className="text-base font-bold leading-tight">{p.name}</div>

              <div className="mt-2 grid grid-cols-2 gap-2">
                <div className="rounded-lg border bg-gray-50 p-2">
                  <div className="text-[11px] text-gray-600">Venta</div>
                  <div className="text-lg font-extrabold tabular-nums">
                    {money(p.salePrice)}
                  </div>
                </div>
                <div className="rounded-lg border bg-gray-50 p-2">
                  <div className="text-[11px] text-gray-600">Ganancia</div>
                  <div className="mt-2 text-xs text-gray-600">
                    Esperado:{" "}
                    <b>{money(p.totalEsperado || p.salePrice * p.quantity)}</b>
                  </div>

                  <div className="text-lg font-extrabold tabular-nums">
                    {money(p.gain)}
                  </div>
                </div>
              </div>

              <div className="mt-2 text-xs text-gray-600">
                Código: <b>{p.code || "—"}</b>
              </div>

              <div className="mt-2 flex gap-2">
                <button
                  className="flex-1 px-3 py-2 rounded bg-yellow-400 hover:bg-yellow-500"
                  type="button"
                  onClick={() => openEdit(p)}
                >
                  Editar
                </button>
              </div>
            </div>
          ))
        )}
      </div>

      {/* WEB TABLE */}
      <div className="hidden md:block bg-white border rounded overflow-x-auto">
        <table className="min-w-[1200px] w-full text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border text-left">Categoría</th>
              <th className="p-2 border text-left">Producto</th>
              <th className="p-2 border text-right">Proveedor</th>
              <th className="p-2 border text-right">Cantidad</th>
              <th className="p-2 border text-right">Facturado</th>
              <th className="p-2 border text-right">Esperado</th>
              <th className="p-2 border text-right">Margen</th>
              <th className="p-2 border text-right">Venta</th>
              <th className="p-2 border text-right">Ganancia</th>
              <th className="p-2 border text-left">Género</th>
              <th className="p-2 border text-left">Tipo</th>
              <th className="p-2 border text-left">Código</th>
              <th className="p-2 border text-center">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={12}>
                  Cargando…
                </td>
              </tr>
            ) : filtered.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={12}>
                  Sin resultados.
                </td>
              </tr>
            ) : (
              filtered.map((p) => (
                <tr key={p.id} className="align-top">
                  <td className="p-2 border">{p.category}</td>
                  <td className="p-2 border">{p.name}</td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(p.providerPrice)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {p.quantity}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(p.facturado)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(p.totalEsperado || p.salePrice * p.quantity)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {Number(p.margin || 0).toFixed(2)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(p.salePrice)}
                  </td>
                  <td className="p-2 border text-right tabular-nums">
                    {money(p.gain)}
                  </td>
                  <td className="p-2 border">{p.gender}</td>
                  <td className="p-2 border">{p.typeProduct}</td>
                  <td className="p-2 border">{p.code || "—"}</td>
                  <td className="p-2 border text-center">
                    <button
                      className="px-2 py-1 rounded bg-yellow-400 hover:bg-yellow-500"
                      type="button"
                      onClick={() => openEdit(p)}
                    >
                      Editar
                    </button>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* FORM MODAL */}
      {openForm && (
        <Modal
          onClose={() => setOpenForm(false)}
          title={editing ? "Editar producto" : "Nuevo producto"}
        >
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
            <div>
              <label className="block font-semibold">Categoría</label>
              <select
                className="w-full border rounded px-2 py-2"
                value={category}
                onChange={(e) => setCategory(e.target.value)}
              >
                {CATEGORY_OPTIONS.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold">Producto</label>
              <input
                className="w-full border rounded px-2 py-2"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Ej: Cuaderno Norma..."
              />
            </div>

            <div>
              <label className="block font-semibold">Precio proveedor</label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border rounded px-2 py-2 text-right"
                value={Number.isNaN(providerPrice) ? "" : providerPrice}
                onChange={(e) =>
                  setProviderPrice(Math.max(0, toNum(e.target.value, 0)))
                }
              />
            </div>

            <div>
              <label className="block font-semibold">Cantidad</label>
              <input
                type="number"
                min={1}
                className="w-full border rounded px-2 py-2 text-right"
                value={quantity}
                onChange={(e) => setQuantity(roundInt(e.target.value, 1))}
              />
            </div>

            {/* Facturado (auto) */}
            <div>
              <label className="block font-semibold">Facturado (auto)</label>
              <div className="w-full border rounded px-2 py-2 text-right bg-gray-50 tabular-nums">
                {money(
                  calcAll({ providerPrice, quantity, margin, salePrice })
                    .facturado,
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold">Margen</label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border rounded px-2 py-2 text-right"
                value={Number.isNaN(margin) ? "" : margin}
                onChange={(e) =>
                  setMargin(Math.max(0, toNum(e.target.value, 0)))
                }
              />
              <div className="text-[11px] text-gray-600 mt-1">
                Ej: 0.70 / 0.80
              </div>
            </div>

            <div>
              <label className="block font-semibold">
                Precio venta (editable)
              </label>
              <input
                type="number"
                step="0.01"
                inputMode="decimal"
                className="w-full border rounded px-2 py-2 text-right"
                value={
                  Number.isNaN(
                    calcAll({ providerPrice, quantity, margin, salePrice })
                      .salePrice,
                  )
                    ? ""
                    : calcAll({ providerPrice, quantity, margin, salePrice })
                        .salePrice
                }
                onChange={(e) => {
                  // si lo editás manual, manda y margin se recalcula al guardar
                  setSalePrice(Math.max(0, toNum(e.target.value, 0)));
                }}
              />
            </div>

            {/* Ganancia (auto) */}
            <div>
              <label className="block font-semibold">Ganancia (auto)</label>
              <div className="w-full border rounded px-2 py-2 text-right bg-gray-50 tabular-nums">
                {money(
                  calcAll({ providerPrice, quantity, margin, salePrice }).gain,
                )}
              </div>
            </div>

            <div>
              <label className="block font-semibold">Género</label>
              <select
                className="w-full border rounded px-2 py-2"
                value={gender}
                onChange={(e) => setGender(e.target.value as Gender)}
              >
                {GENDER_OPTIONS.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block font-semibold">Tipo producto</label>
              <select
                className="w-full border rounded px-2 py-2"
                value={typeProduct}
                onChange={(e) => setTypeProduct(e.target.value)}
              >
                <option value="">—</option>
                {TYPE_OPTIONS.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>

            <div className="md:col-span-2">
              <label className="block font-semibold">Código</label>
              <div className="flex gap-2">
                <input
                  className="flex-1 border rounded px-2 py-2"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                  placeholder="Escaneá o pegá el código"
                />
                <button
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  type="button"
                  onClick={handleScanToForm}
                >
                  Escanear
                </button>
              </div>
            </div>
          </div>

          <div className="mt-4 flex justify-end gap-2">
            <button
              className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
              type="button"
              onClick={() => {
                setOpenForm(false);
                setEditing(null);
              }}
            >
              Cancelar
            </button>
            <button
              className="px-4 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700"
              type="button"
              onClick={saveProduct}
              disabled={loading}
            >
              Guardar
            </button>
          </div>
        </Modal>
      )}

      {/* SCAN LOOKUP MODAL */}
      {scanInfoOpen && (
        <Modal
          onClose={() => setScanInfoOpen(false)}
          title="Resultado de escaneo"
        >
          {scanInfoProduct ? (
            <div className="text-sm">
              <div className="text-xs text-gray-600">
                {scanInfoProduct.category}
              </div>
              <div className="text-lg font-bold">{scanInfoProduct.name}</div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg border bg-gray-50 p-2">
                  <div className="text-[11px] text-gray-600">Precio venta</div>
                  <div className="text-lg font-extrabold tabular-nums">
                    {money(scanInfoProduct.salePrice)}
                  </div>
                </div>
                <div className="rounded-lg border bg-gray-50 p-2">
                  <div className="text-[11px] text-gray-600">Ganancia</div>
                  <div className="text-lg font-extrabold tabular-nums">
                    {money(scanInfoProduct.gain)}
                  </div>
                </div>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-2">
                <div className="rounded-lg border p-2">
                  <div className="text-[11px] text-gray-600">Proveedor</div>
                  <div className="font-semibold tabular-nums">
                    {money(scanInfoProduct.providerPrice)}
                  </div>
                </div>
                <div className="rounded-lg border p-2">
                  <div className="text-[11px] text-gray-600">Cantidad</div>
                  <div className="font-semibold tabular-nums">
                    {scanInfoProduct.quantity}
                  </div>
                </div>
                <div className="rounded-lg border p-2 col-span-2">
                  <div className="text-[11px] text-gray-600">Código</div>
                  <div className="font-semibold tabular-nums">
                    {scanInfoProduct.code || "—"}
                  </div>
                </div>
              </div>

              <div className="mt-4 flex justify-end">
                <button
                  className="px-4 py-2 rounded bg-yellow-400 hover:bg-yellow-500"
                  type="button"
                  onClick={() => {
                    setScanInfoOpen(false);
                    openEdit(scanInfoProduct);
                  }}
                >
                  Editar
                </button>
              </div>
            </div>
          ) : (
            <div className="text-sm">
              <div className="font-semibold">No encontrado</div>
              <div className="text-gray-600 mt-1">
                Ese código no existe en <b>products_stationery</b>.
              </div>
            </div>
          )}
        </Modal>
      )}

      {/* IMPORT MODAL */}
      {importOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-3">
          <div className="bg-white w-full max-w-6xl max-h-[90vh] overflow-y-auto rounded shadow-lg p-5 text-sm">
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-xl font-bold">
                Importar papelería (.xlsx / .csv)
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                onClick={() => setImportOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-gray-50 border rounded p-3 mb-3">
              <div className="flex flex-col md:flex-row gap-3 md:items-end md:justify-between">
                <div>
                  <div className="font-semibold">1) Subí tu archivo</div>
                  <div className="text-xs text-gray-600">
                    Columnas esperadas: Id (opcional), Categoria, Producto,
                    PrecioProveedor, Cantidad, Margen (o PrecioVenta), Genero,
                    TipoProducto, Codigo.
                  </div>
                </div>
                <button
                  className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={downloadTemplateXlsx}
                  type="button"
                >
                  Descargar template .xlsx
                </button>
              </div>

              <div className="mt-3 flex flex-col md:flex-row gap-3 md:items-center">
                <input
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={(e) => onPickFile(e.target.files?.[0] || null)}
                />
                {importFileName && (
                  <span className="text-xs text-gray-600">
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
                  {importErrors.slice(0, 60).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}

            <div className="bg-white border rounded p-3">
              <div className="flex flex-wrap gap-4 items-center justify-between mb-2">
                <div>
                  <div className="font-semibold">
                    2) Previsualización (editable)
                  </div>
                  <div className="text-xs text-gray-600">
                    Se importarán {importStats.total} filas (Crear:{" "}
                    {importStats.willCreate} / Actualizar:{" "}
                    {importStats.willUpdate})
                  </div>
                </div>

                <button
                  className="px-3 py-2 rounded bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                  onClick={importToFirestore}
                  disabled={
                    importLoading ||
                    importRows.length === 0 ||
                    importErrors.length > 0
                  }
                  type="button"
                >
                  Importar a Firestore
                </button>
              </div>

              <div className="overflow-x-auto border rounded">
                <table className="min-w-[1500px] w-full text-xs">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border text-left">Id (opcional)</th>
                      <th className="p-2 border text-left">Categoría</th>
                      <th className="p-2 border text-left">Producto</th>
                      <th className="p-2 border text-right">Proveedor</th>
                      <th className="p-2 border text-right">Cantidad</th>
                      <th className="p-2 border text-right">Margen</th>
                      <th className="p-2 border text-right">PrecioVenta</th>
                      <th className="p-2 border text-left">Género</th>
                      <th className="p-2 border text-left">Tipo</th>
                      <th className="p-2 border text-left">Código</th>
                      <th className="p-2 border text-center">Acción</th>
                    </tr>
                  </thead>
                  <tbody>
                    {importRows.length === 0 ? (
                      <tr>
                        <td
                          colSpan={11}
                          className="p-4 text-center text-gray-500"
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
                        const exists = byId || byKey;

                        return (
                          <tr
                            key={`${r.id || ""}-${i}`}
                            className="whitespace-nowrap"
                          >
                            <td className="p-2 border">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.id || ""}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    id: e.target.value.trim() || undefined,
                                  })
                                }
                                placeholder="docId (update exacto)"
                              />
                            </td>

                            <td className="p-2 border">
                              <input
                                className="w-44 border rounded px-2 py-1"
                                value={r.category}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    category: e.target.value,
                                  })
                                }
                              />
                            </td>

                            <td className="p-2 border">
                              <input
                                className="w-72 border rounded px-2 py-1"
                                value={r.name}
                                onChange={(e) =>
                                  updateImportRow(i, { name: e.target.value })
                                }
                              />
                            </td>

                            <td className="p-2 border text-right tabular-nums">
                              <input
                                type="number"
                                step="0.01"
                                className="w-28 border rounded px-2 py-1 text-right"
                                value={r.providerPrice}
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

                            <td className="p-2 border text-right tabular-nums">
                              <input
                                type="number"
                                min={1}
                                className="w-24 border rounded px-2 py-1 text-right"
                                value={r.quantity}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    quantity: roundInt(e.target.value, 1),
                                  })
                                }
                              />
                            </td>

                            <td className="p-2 border text-right tabular-nums">
                              <input
                                type="number"
                                step="0.01"
                                className="w-24 border rounded px-2 py-1 text-right"
                                value={r.margin}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    margin: Math.max(
                                      0,
                                      toNum(e.target.value, 0),
                                    ),
                                  })
                                }
                              />
                            </td>

                            <td className="p-2 border text-right tabular-nums">
                              <input
                                type="number"
                                step="0.01"
                                className="w-28 border rounded px-2 py-1 text-right"
                                value={r.salePrice ?? ""}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    salePrice:
                                      Math.max(0, toNum(e.target.value, 0)) ||
                                      undefined,
                                  })
                                }
                                placeholder="Opcional"
                              />
                            </td>

                            <td className="p-2 border">
                              <select
                                className="w-28 border rounded px-2 py-1"
                                value={r.gender}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    gender: e.target.value as Gender,
                                  })
                                }
                              >
                                {GENDER_OPTIONS.map((g) => (
                                  <option key={g} value={g}>
                                    {g}
                                  </option>
                                ))}
                              </select>
                            </td>

                            <td className="p-2 border">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.typeProduct}
                                onChange={(e) =>
                                  updateImportRow(i, {
                                    typeProduct: e.target.value,
                                  })
                                }
                              />
                            </td>

                            <td className="p-2 border">
                              <input
                                className="w-56 border rounded px-2 py-1"
                                value={r.code || ""}
                                onChange={(e) =>
                                  updateImportRow(i, { code: e.target.value })
                                }
                              />
                            </td>

                            <td className="p-2 border text-center">
                              <span
                                className={`px-2 py-0.5 rounded text-[10px] ${
                                  exists
                                    ? "bg-yellow-100 text-yellow-700"
                                    : "bg-green-100 text-green-700"
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

                {importRows.length > 300 && (
                  <div className="text-xs text-gray-600 mt-2">
                    Mostrando 300 de {importRows.length} filas (importa todas).
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* =========================
   UI HELPERS
========================= */
function Kpi({ label, value }: { label: string; value: any }) {
  return (
    <div className="bg-white border rounded p-3 shadow-sm">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="text-lg font-extrabold">{value}</div>
    </div>
  );
}

function Modal({
  title,
  children,
  onClose,
}: {
  title: string;
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3">
      <div className="bg-white rounded-xl shadow-lg w-full max-w-3xl p-4 relative">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-xl font-bold">{title}</h3>
          <button
            className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
            onClick={onClose}
            type="button"
          >
            Cerrar
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
