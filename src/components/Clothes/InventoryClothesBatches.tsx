// src/components/InventoryClothesBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";

import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";

// ===== Helpers =====
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const GENDERS = ["", "HOMBRE", "MUJER", "NINO", "NINA", "UNISEX"] as const;

// Normaliza tokens para SKU
function norm(token?: string) {
  return (token || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "-")
    .replace(/[^A-Z0-9-]/g, "");
}
function abrevGenero(g?: string) {
  switch ((g || "").toUpperCase()) {
    case "HOMBRE":
      return "HOM";
    case "MUJER":
      return "MUJ";
    case "NINO":
      return "NIN";
    case "NINA":
      return "NIA";
    case "UNISEX":
      return "UNI";
    default:
      return "GEN";
  }
}
function generarSKU(parts: {
  subcat?: string;
  gender?: string;
  color?: string;
  size?: string;
  brand?: string;
}) {
  const prefix = "ROP";
  const sub = norm(parts.subcat).slice(0, 3) || "GEN";
  const gen = abrevGenero(parts.gender);
  const col = norm(parts.color).slice(0, 3) || "COL";
  const siz = norm(parts.size) || "TLL";
  const brd = norm(parts.brand).slice(0, 4) || "BRD";
  const seq = Date.now().toString(36).toUpperCase().slice(-4); // ← solo fallback
  return `${prefix}-${sub}-${gen}-${col}-${siz}-${brd}-${seq}`;
}

// validar código de cliente opcional (alfanumérico + . _ -)
const CLIENT_CODE_RE = /^[A-Za-z0-9._-]{0,32}$/;

interface Product {
  id: string;
  name: string; // Nombre visible
  category: string; // Subcategoría
  measurement: string; // "unidad" para ropa
  price: number; // Precio sugerido de venta
  // Opcionales (si registras productos por variante)
  sku?: string;
  size?: string;
  color?: string;
  gender?: string; // HOMBRE | MUJER | NINO | NINA | UNISEX
  brand?: string; // Shein | Usado | Otro
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
  // Campos ROPA opcionales
  notes?: string;
  sku?: string;
  size?: string;
  color?: string;
  gender?: string;
  brand?: string;
  // Nuevo
  clientCode?: string;
}

export default function InventoryClothesBatches() {
  // Productos (Ropa)
  const [products, setProducts] = useState<Product[]>([]);
  // Lotes (Ropa)
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // 🔎 Filtro por fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd"),
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd"),
  );

  // 🔵 Filtro por producto
  const [productFilterId, setProductFilterId] = useState<string>("");

  // ===== Form crear lote (Ropa) =====
  const [productId, setProductId] = useState("");
  const [dateStr, setDateStr] = useState<string>(
    format(new Date(), "yyyy-MM-dd"),
  );
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(0);
  const [salePrice, setSalePrice] = useState<number>(0);
  const [invoiceTotal, setInvoiceTotal] = useState<number>(0);
  const [expectedTotal, setExpectedTotal] = useState<number>(0);
  const [notes, setNotes] = useState<string>("");

  // Info opcional por variante en el lote
  const [sku, setSku] = useState<string>("");
  const [size, setSize] = useState<string>("");
  const [color, setColor] = useState<string>("");
  const [gender, setGender] = useState<string>("");
  const [brand, setBrand] = useState<string>("");

  // Código del cliente (opcional)
  const [clientCode, setClientCode] = useState<string>("");

  // Alta directa (si no quieres usar catálogo) – UI está comentada, pero lo mantenemos
  const [createDirect, setCreateDirect] = useState<boolean>(false);
  const [manualName, setManualName] = useState<string>("");
  const [manualSubcat, setManualSubcat] = useState<string>("Camisa");

  // ===== Edición en tabla =====
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editDate, setEditDate] = useState<string>("");
  const [editQty, setEditQty] = useState<number>(0);
  const [editPurchase, setEditPurchase] = useState<number>(0);
  const [editSale, setEditSale] = useState<number>(0);
  const [editInvoiceTotal, setEditInvoiceTotal] = useState<number>(0);
  const [editExpectedTotal, setEditExpectedTotal] = useState<number>(0);
  const [editNotes, setEditNotes] = useState<string>("");
  const [editSKU, setEditSKU] = useState<string>("");
  const [editSize, setEditSize] = useState<string>("");
  const [editColor, setEditColor] = useState<string>("");
  const [editGender, setEditGender] = useState<Batch["gender"]>("");
  const [editBrand, setEditBrand] = useState<string>("");
  const [editClientCode, setEditClientCode] = useState<string>("");

  // justo con los demás useState:

  const [menuRowId, setMenuRowId] = useState<string | null>(null);
  const [menuPos, setMenuPos] = useState<{ x: number; y: number }>({
    x: 0,
    y: 0,
  });

  // 👉 Modal Crear Inventario
  const [showCreateModal, setShowCreateModal] = useState(false);

  // cerrar con click fuera y con ESC
  useEffect(() => {
    const onDocClick = () => setMenuRowId(null);
    const onEsc = (e: KeyboardEvent) =>
      e.key === "Escape" && setMenuRowId(null);
    document.addEventListener("click", onDocClick);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("click", onDocClick);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  // helper para ajustar la posición dentro del viewport
  const clampToViewport = (x: number, y: number, w = 192, h = 160) => {
    const m = 8; // margen
    // si abrir a la derecha se sale, abre hacia la izquierda
    let X = x;
    if (x + w + m > window.innerWidth) X = x - w;
    // clamp horizontal
    X = Math.max(m, Math.min(X, window.innerWidth - w - m));

    // clamp vertical
    let Y = y;
    if (y + h + m > window.innerHeight) Y = window.innerHeight - h - m;
    Y = Math.max(m, Math.min(Y, window.innerHeight - h - m));
    return { x: X, y: Y };
  };

  const openActionsMenu = (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    // ancla en la esquina inferior-derecha del botón
    const rawX = r.right;
    const rawY = r.bottom;
    const pos = clampToViewport(rawX, rawY); // ← evita que se vaya al fondo
    setMenuPos(pos);
    setMenuRowId((cur) => (cur === id ? null : id));
  };

  // cerrar al hacer click fuera o con Escape
  useEffect(() => {
    const handleDocClick = () => setMenuRowId(null);
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuRowId(null);
    };
    document.addEventListener("click", handleDocClick);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("click", handleDocClick);
      document.removeEventListener("keydown", handleEsc);
    };
  }, []);

  useEffect(() => {
    if (!menuRowId) return;
    const close = () => setMenuRowId(null);
    // true = captura scroll en contenedores con overflow
    window.addEventListener("scroll", close, true);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    };
  }, [menuRowId]);

  // ===== Carga inicial =====
  useEffect(() => {
    (async () => {
      // Productos de ropa
      const psnap = await getDocs(collection(db, "products_clothes"));
      const prods: Product[] = [];
      psnap.forEach((d) => {
        const it = d.data() as any;
        prods.push({
          id: d.id,
          name: it.name ?? "(sin nombre)",
          category: it.category ?? "(sin categoría)",
          measurement: it.measurement ?? "unidad",
          price: Number(it.price ?? 0),
          sku: it.sku || "",
          size: it.size || "",
          color: it.color || "",
          gender: it.gender || "",
          brand: it.brand || "",
        });
      });
      setProducts(prods);

      // Lotes de ropa
      const qB = query(
        collection(db, "inventory_clothes_batches"),
        orderBy("date", "desc"),
      );
      const bsnap = await getDocs(qB);
      const rows: Batch[] = [];
      bsnap.forEach((d) => {
        const b = d.data() as any;
        rows.push({
          id: d.id,
          productId: b.productId,
          productName: b.productName,
          category: b.category,
          unit: b.unit,
          quantity: Number(b.quantity || 0),
          remaining: Number(b.remaining ?? b.quantity ?? 0),
          purchasePrice: Number(b.purchasePrice || 0),
          salePrice: Number(b.salePrice || 0),
          invoiceTotal: Number(
            b.invoiceTotal ??
              Number(b.quantity || 0) * Number(b.purchasePrice || 0),
          ),
          expectedTotal: Number(
            b.expectedTotal ??
              Number(b.quantity || 0) * Number(b.salePrice || 0),
          ),
          date: b.date,
          createdAt: b.createdAt,
          status: b.status,
          notes: b.notes || "",
          sku: b.sku || "",
          size: b.size || "",
          color: b.color || "",
          gender: b.gender || "",
          brand: b.brand || "",
          clientCode: b.clientCode || "",
        });
      });
      setBatches(rows);
      setLoading(false);
    })();
  }, []);

  // Producto seleccionado → sugerir precio y CARGAR el SKU EXACTO del producto (sin autogenerar)
  useEffect(() => {
    const p = products.find((x) => x.id === productId);
    if (p) {
      setSalePrice(Number(p.price || 0));
      if (p.sku) setSku(p.sku); // ← aquí imponemos el SKU del producto
      if (p.size) setSize((s) => s || p.size!);
      if (p.color) setColor((c) => c || p.color!);
      if (p.gender) setGender((g) => (g ? g : (p.gender as any)));
      if (p.brand) setBrand((b) => b || p.brand!);
    }
  }, [productId, products]);

  // Cálculos automáticos (crear)
  useEffect(() => {
    setInvoiceTotal(Math.floor(quantity * purchasePrice * 100) / 100);
  }, [quantity, purchasePrice]);
  useEffect(() => {
    setExpectedTotal(Math.floor(quantity * salePrice * 100) / 100);
  }, [quantity, salePrice]);

  // 🔁 Autogenerar SKU SOLO si NO hay SKU en el producto seleccionado
  useEffect(() => {
    const p = products.find((x) => x.id === productId);

    // Si el producto del catálogo ya tiene SKU, respetarlo y NO generar nada
    if (p?.sku) {
      setSku(p.sku);
      return;
    }

    // Si no hay producto (o no tiene sku), usamos tu generador como fallback
    const subcat =
      createDirect && manualSubcat ? manualSubcat : p?.category || "";

    // Si no hay datos para generar, dejar vacío
    if (!subcat && !gender && !color && !size && !brand) {
      setSku("");
      return;
    }

    const next = generarSKU({
      subcat,
      gender: gender || "",
      color: color || "",
      size: size || "",
      brand: brand || "",
    });
    setSku(next);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    createDirect,
    manualSubcat,
    productId,
    gender,
    color,
    size,
    brand,
    products,
  ]);

  // Filtro en memoria (fecha + producto)
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  // Totales sobre el filtro
  const totals = useMemo(() => {
    const totalFacturado = filteredBatches.reduce(
      (a, b) => a + (b.invoiceTotal || 0),
      0,
    );
    const totalEsperado = filteredBatches.reduce(
      (a, b) => a + (b.expectedTotal || 0),
      0,
    );
    const udsIng = filteredBatches.reduce((a, b) => a + b.quantity, 0);
    const udsRem = filteredBatches.reduce((a, b) => a + b.remaining, 0);
    return {
      udsIng,
      udsRem,
      totalFacturado,
      totalEsperado,
    };
  }, [filteredBatches]);

  // ===== Crear lote (Ropa) =====
  const saveBatch = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    const useCatalog = !!productId && !createDirect;
    const p = products.find((x) => x.id === productId);

    const finalName = useCatalog ? p?.name || "" : manualName || "";
    const finalCategory = useCatalog
      ? p?.category || ""
      : manualSubcat || "General";
    const finalUnit = useCatalog ? p?.measurement || "unidad" : "unidad";

    if (!finalName || quantity <= 0 || purchasePrice <= 0) {
      setMsg("Completa nombre/cantidad/costo.");
      return;
    }
    if (clientCode && !CLIENT_CODE_RE.test(clientCode)) {
      setMsg("Código del cliente inválido (solo A-Z, 0-9, . _ - , máx 32).");
      return;
    }

    try {
      const ref = await addDoc(collection(db, "inventory_clothes_batches"), {
        productId: useCatalog ? p!.id : "",
        productName: finalName,
        category: finalCategory,
        unit: finalUnit,
        quantity,
        remaining: quantity,
        purchasePrice,
        salePrice,
        invoiceTotal,
        expectedTotal,
        date: dateStr,
        createdAt: Timestamp.now(),
        status: "PENDIENTE",
        // extras de ropa
        notes: notes || "",
        sku: sku || "", // ← guarda lo que se ve (del producto si existe)
        size: size || "",
        color: color || "",
        gender: gender || "",
        brand: brand || "",
        // nuevo
        clientCode: clientCode || "",
      });

      setBatches((prev) => [
        {
          id: ref.id,
          productId: useCatalog ? p!.id : "",
          productName: finalName,
          category: finalCategory,
          unit: finalUnit,
          quantity,
          remaining: quantity,
          purchasePrice,
          salePrice,
          invoiceTotal,
          expectedTotal,
          date: dateStr,
          createdAt: Timestamp.now(),
          status: "PENDIENTE",
          notes: notes || "",
          sku: sku || "",
          size: size || "",
          color: color || "",
          gender: gender || "",
          brand: brand || "",
          clientCode: clientCode || "",
        },
        ...prev,
      ]);

      // limpiar form
      setMsg("✅ Lote de ropa creado");
      setProductId("");
      setDateStr(format(new Date(), "yyyy-MM-dd"));
      setQuantity(0);
      setPurchasePrice(0);
      setSalePrice(0);
      setInvoiceTotal(0);
      setExpectedTotal(0);
      setNotes("");
      setSku("");
      setSize("");
      setColor("");
      setGender("");
      setBrand("");
      setClientCode("");
      setCreateDirect(false);
      setManualName("");
      setManualSubcat("Camisa");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al crear lote");
    }
  };

  // ===== Pagar lote =====
  const payBatch = async (b: Batch) => {
    const ok = confirm(
      `Marcar PAGADO el lote del ${b.date} (${b.productName})?`,
    );
    if (!ok) return;
    await updateDoc(doc(db, "inventory_clothes_batches", b.id), {
      status: "PAGADO",
    });
    setBatches((prev) =>
      prev.map((x) => (x.id === b.id ? { ...x, status: "PAGADO" } : x)),
    );
  };

  // ===== Editar / Eliminar lote =====
  const startEdit = (b: Batch) => {
    setEditingId(b.id);
    setEditDate(b.date);
    setEditQty(b.quantity);
    setEditPurchase(b.purchasePrice);
    setEditSale(b.salePrice);
    setEditInvoiceTotal(Number((b.quantity * b.purchasePrice).toFixed(2)));
    setEditExpectedTotal(Number((b.quantity * b.salePrice).toFixed(2)));
    setEditNotes(b.notes || "");
    setEditSKU(b.sku || "");
    setEditSize(b.size || "");
    setEditColor(b.color || "");
    setEditGender(b.gender || "");
    setEditBrand(b.brand || "");
    setEditClientCode(b.clientCode || "");
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDate("");
    setEditQty(0);
    setEditPurchase(0);
    setEditSale(0);
    setEditInvoiceTotal(0);
    setEditExpectedTotal(0);
    setEditNotes("");
    setEditSKU("");
    setEditSize("");
    setEditColor("");
    setEditGender("");
    setEditBrand("");
    setEditClientCode("");
  };

  useEffect(() => {
    if (!editingId) return;
    setEditInvoiceTotal(Math.floor(editQty * editPurchase * 100) / 100);
  }, [editingId, editQty, editPurchase]);
  useEffect(() => {
    if (!editingId) return;
    setEditExpectedTotal(Math.floor(editQty * editSale * 100) / 100);
  }, [editingId, editQty, editSale]);

  const saveEdit = async () => {
    if (!editingId) return;

    const old = batches.find((x) => x.id === editingId);
    if (!old) return;

    const consumido = Math.max(0, old.quantity - old.remaining);
    const newRemaining = Math.max(0, editQty - consumido);

    if (editClientCode && !CLIENT_CODE_RE.test(editClientCode)) {
      setMsg("Código del cliente inválido (solo A-Z, 0-9, . _ - , máx 32).");
      return;
    }

    const ref = doc(db, "inventory_clothes_batches", editingId);
    await updateDoc(ref, {
      date: editDate,
      quantity: editQty,
      purchasePrice: editPurchase,
      salePrice: editSale,
      invoiceTotal: editInvoiceTotal,
      expectedTotal: editExpectedTotal,
      notes: editNotes,
      remaining: newRemaining,
      sku: editSKU,
      size: editSize,
      color: editColor,
      gender: editGender || "",
      brand: editBrand || "",
      clientCode: editClientCode || "",
    });

    setBatches((prev) =>
      prev.map((x) =>
        x.id === editingId
          ? {
              ...x,
              date: editDate,
              quantity: editQty,
              purchasePrice: editPurchase,
              salePrice: editSale,
              invoiceTotal: editInvoiceTotal,
              expectedTotal: editExpectedTotal,
              notes: editNotes,
              remaining: newRemaining,
              sku: editSKU,
              size: editSize,
              color: editColor,
              gender: editGender || "",
              brand: editBrand || "",
              clientCode: editClientCode || "",
            }
          : x,
      ),
    );
    cancelEdit();
    setMsg("✅ Lote actualizado");
  };

  const deleteBatch = async (b: Batch) => {
    const ok = confirm(`¿Eliminar el lote del ${b.date} (${b.productName})?`);
    if (!ok) return;
    await deleteDoc(doc(db, "inventory_clothes_batches", b.id));
    setBatches((prev) => prev.filter((x) => x.id !== b.id));
    setMsg("🗑️ Lote eliminado");
  };

  // ====== Exportar/Imprimir PDF ======
  const handlePrintPDF = () => {
    const titleRange =
      (fromDate ? `Desde ${fromDate}` : "Desde inicio") +
      " — " +
      (toDate ? `Hasta ${toDate}` : "Hasta hoy");

    const esc = (s: string) =>
      (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const rowsHtml = filteredBatches
      .map(
        (b) => `
      <tr>
        <td>${b.date}</td>
        <td>${(b.category || "").toUpperCase()}</td>
        <td>${esc(b.productName)}</td>
        <td>${esc(b.sku || "")}</td>
        <td>${esc(b.size || "")}</td>
        <td>${esc(b.color || "")}</td>
        <td>${esc(b.clientCode || "")}</td>
        <td>${esc(b.gender || "")}</td>
        <td>${(b.unit || "").toUpperCase()}</td>
        <td style="text-align:right">${b.quantity.toFixed(0)}</td>
        <td style="text-align:right">${b.remaining.toFixed(0)}</td>
        <td style="text-align:right">${money(b.purchasePrice)}</td>
        <td style="text-align:right">${money(b.salePrice)}</td>
        <td style="text-align:right">${money(b.invoiceTotal || 0)}</td>
        <td style="text-align:right">${money(b.expectedTotal || 0)}</td>
        <td>${esc((b.notes || "").slice(0, 120))}</td>
        <td>${b.status}</td>
      </tr>`,
      )
      .join("");

    const html = `
<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <title>Inventario de Ropa por Lotes</title>
  <style>
    * { font-family: Arial, sans-serif; }
    h1 { margin: 0 0 4px; }
    .muted { color: #555; font-size: 12px; margin-bottom: 12px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th, td { border: 1px solid #ddd; padding: 6px; }
    th { background: #f5f5f5; text-align: left; }
    .totals { margin: 10px 0 16px; font-size: 12px; display: grid; grid-template-columns: repeat(2, max-content); column-gap: 32px; row-gap: 6px; align-items: center; }
    @media print { @page { size: A4 landscape; margin: 12mm; } button { display: none; } }
  </style>
</head>
<body>
  <button onclick="window.print()">Imprimir</button>
  <h1>Inventario de Ropa por Lotes</h1>
  <div class="muted">${titleRange}</div>
  <div class="totals">
    <span><strong>Unidades ingresadas:</strong> ${totals.udsIng.toFixed(
      0,
    )}</span>
    <span><strong>Unidades restantes:</strong> ${totals.udsRem.toFixed(
      0,
    )}</span>
    <span><strong>Total esperado a ganar:</strong> ${money(
      totals.totalEsperado,
    )}</span>
    <span><strong>Total facturado:</strong> ${money(
      totals.totalFacturado,
    )}</span>
    <span><strong>Ganancia sin gastos:</strong> ${money(
      Number((totals.totalEsperado - totals.totalFacturado).toFixed(2)),
    )}</span>
  </div>
  <table>
    <thead>
      <tr>
        <th>Fecha</th>
        <th>Subcat.</th>
        <th>Producto</th>
        <th>SKU</th>
        <th>Talla</th>
        <th>Color</th>
        <th>Código Cliente</th>
        <th>Género</th>
        <th>Unidad</th>
        <th>Ingresado</th>
        <th>Restantes</th>
        <th>Precio Compra</th>
        <th>Precio Venta</th>
        <th>Total factura</th>
        <th>Total esperado</th>
        <th>Comentario</th>
        <th>Estado</th>
      </tr>
    </thead>
    <tbody>${
      rowsHtml ||
      `<tr><td colspan="17" style="text-align:center">Sin lotes</td></tr>`
    }</tbody>
  </table>
</body>
</html>`;
    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  return (
    <div className="max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Inventario de Ropa</h2>
        <button
          className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
          onClick={() => setShowCreateModal(true)}
          type="button"
        >
          Crear Inventario
        </button>
      </div>

      {/* 🔎 Barra de filtro por fecha */}
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
          className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
            setProductFilterId("");
          }}
        >
          Quitar filtro
        </button>

        {/* 🖨️ Imprimir/Exportar PDF */}
        <button
          className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
          onClick={handlePrintPDF}
        >
          Imprimir PDF
        </button>
      </div>

      {/* Totales (sobre el filtro) */}
      <div className="bg-gray-50 p-3 rounded shadow border mb-3 text-base">
        <div className="grid grid-cols-3 gap-y-2 gap-x-8">
          <div>
            <span className="font-semibold">Unidades ingresadas:</span>{" "}
            {totals.udsIng.toFixed(0)}
          </div>
          <div>
            <span className="font-semibold">Unidades restantes:</span>{" "}
            {totals.udsRem.toFixed(0)}
          </div>
          <div>
            <span className="font-semibold">Total esperado en ventas:</span>{" "}
            {money(totals.totalEsperado)}
          </div>
          <div>
            <span className="font-semibold">Total facturado:</span>{" "}
            {money(totals.totalFacturado)}
          </div>
          <div>
            <span className="font-semibold">Ganancia sin gastos:</span>{" "}
            {money(
              Number((totals.totalEsperado - totals.totalFacturado).toFixed(2)),
            )}
          </div>
        </div>
      </div>

      {/* Tabla de lotes (filtrada) */}
      <div className="bg-white rounded shadow border">
        <div className="w-full overflow-x-auto">
          <table className="min-w-full text-xs md:text-sm">
            <thead className="bg-gray-100 sticky top-0 z-10">
              <tr>
                <th className="p-2 md:p-3 border text-left">Fecha</th>
                <th className="p-2 md:p-3 border text-left hidden sm:table-cell">
                  Subcat.
                </th>
                <th className="p-2 md:p-3 border text-left">Producto</th>
                <th className="p-2 md:p-3 border text-left hidden lg:table-cell">
                  SKU
                </th>
                <th className="p-2 md:p-3 border text-left hidden md:table-cell">
                  Talla
                </th>
                <th className="p-2 md:p-3 border text-left hidden md:table-cell">
                  Color
                </th>
                <th className="p-2 md:p-3 border text-left hidden xl:table-cell">
                  Código Cliente
                </th>
                <th className="p-2 md:p-3 border text-left hidden lg:table-cell">
                  Género
                </th>
                <th className="p-2 md:p-3 border text-left hidden lg:table-cell">
                  Unidad
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums">
                  Ingresado
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums">
                  Restantes
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums hidden md:table-cell">
                  Precio Compra
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums hidden md:table-cell">
                  Precio Venta
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums hidden lg:table-cell">
                  Total factura
                </th>
                <th className="p-2 md:p-3 border text-right tabular-nums hidden lg:table-cell">
                  Total esperado
                </th>
                <th className="p-2 md:p-3 border text-left hidden xl:table-cell">
                  Comentario
                </th>
                <th className="p-2 md:p-3 border text-left">Estado</th>
                <th className="p-2 md:p-3 border text-center">Acciones</th>
              </tr>
            </thead>

            <tbody className="whitespace-nowrap">
              {loading ? (
                <tr>
                  <td colSpan={17} className="p-4 text-center">
                    Cargando…
                  </td>
                </tr>
              ) : filteredBatches.length === 0 ? (
                <tr>
                  <td colSpan={17} className="p-4 text-center">
                    Sin lotes
                  </td>
                </tr>
              ) : (
                filteredBatches.map((b) => {
                  const isEditing = editingId === b.id;
                  return (
                    <tr key={b.id} className="text-left">
                      {/* Fecha */}
                      <td className="p-2 md:p-3 border align-top">
                        {isEditing ? (
                          <input
                            type="date"
                            className="w-full border p-1 rounded"
                            value={editDate}
                            onChange={(e) => setEditDate(e.target.value)}
                          />
                        ) : (
                          b.date
                        )}
                      </td>

                      {/* Subcat */}
                      <td className="p-2 md:p-3 border align-top hidden sm:table-cell">
                        {(b.category || "").toUpperCase()}
                      </td>

                      {/* Producto */}
                      <td className="p-2 md:p-3 border align-top max-w-[220px] md:max-w-[320px]">
                        <span className="block truncate" title={b.productName}>
                          {b.productName}
                        </span>
                      </td>

                      {/* SKU */}
                      <td className="p-2 md:p-3 border align-top hidden lg:table-cell max-w-[220px]">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={editSKU}
                            onChange={(e) => setEditSKU(e.target.value)}
                          />
                        ) : (
                          <span className="block truncate" title={b.sku || ""}>
                            {b.sku || "—"}
                          </span>
                        )}
                      </td>

                      {/* Talla */}
                      <td className="p-2 md:p-3 border align-top hidden md:table-cell">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={editSize}
                            onChange={(e) => setEditSize(e.target.value)}
                          />
                        ) : (
                          b.size || "—"
                        )}
                      </td>

                      {/* Color */}
                      <td className="p-2 md:p-3 border align-top hidden md:table-cell">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={editColor}
                            onChange={(e) => setEditColor(e.target.value)}
                          />
                        ) : (
                          b.color || "—"
                        )}
                      </td>

                      {/* Código cliente */}
                      <td className="p-2 md:p-3 border align-top hidden xl:table-cell max-w-[200px]">
                        {isEditing ? (
                          <input
                            className="w-full border p-1 rounded"
                            value={editClientCode}
                            onChange={(e) => {
                              const v = e.target.value;
                              if (CLIENT_CODE_RE.test(v)) setEditClientCode(v);
                            }}
                            placeholder="Ej: LOTE-SHEIN-SEP-01"
                            title="A–Z 0–9 . _ - (máx 32)"
                          />
                        ) : (
                          <span
                            className="block truncate"
                            title={b.clientCode || ""}
                          >
                            {b.clientCode || "—"}
                          </span>
                        )}
                      </td>

                      {/* Género */}
                      <td className="p-2 md:p-3 border align-top hidden lg:table-cell">
                        {isEditing ? (
                          <select
                            className="w-full border p-1 rounded"
                            value={editGender}
                            onChange={(e) =>
                              setEditGender(e.target.value as any)
                            }
                          >
                            {GENDERS.map((g) => (
                              <option key={g} value={g}>
                                {g || "—"}
                              </option>
                            ))}
                          </select>
                        ) : (
                          b.gender || "—"
                        )}
                      </td>

                      {/* Unidad */}
                      <td className="p-2 md:p-3 border align-top hidden lg:table-cell">
                        {(b.unit || "").toUpperCase()}
                      </td>

                      {/* Ingresado */}
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums">
                        {isEditing ? (
                          <input
                            type="number"
                            step="1"
                            inputMode="numeric"
                            className="w-20 border p-1 rounded text-right"
                            value={Number.isNaN(editQty) ? "" : editQty}
                            onChange={(e) =>
                              setEditQty(
                                Math.max(
                                  0,
                                  parseInt(e.target.value || "0", 10),
                                ),
                              )
                            }
                          />
                        ) : (
                          b.quantity.toFixed(0)
                        )}
                      </td>

                      {/* Restantes */}
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums">
                        {isEditing ? b.remaining : b.remaining.toFixed(0)}
                      </td>

                      {/* Precio compra */}
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums hidden md:table-cell">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="w-24 border p-1 rounded text-right"
                            value={
                              Number.isNaN(editPurchase) ? "" : editPurchase
                            }
                            onChange={(e) =>
                              setEditPurchase(
                                Math.max(0, parseFloat(e.target.value || "0")),
                              )
                            }
                          />
                        ) : (
                          money(b.purchasePrice)
                        )}
                      </td>

                      {/* Precio venta */}
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums hidden md:table-cell">
                        {isEditing ? (
                          <input
                            type="number"
                            step="0.01"
                            inputMode="decimal"
                            className="w-24 border p-1 rounded text-right"
                            value={Number.isNaN(editSale) ? "" : editSale}
                            onChange={(e) =>
                              setEditSale(
                                Math.max(0, parseFloat(e.target.value || "0")),
                              )
                            }
                          />
                        ) : (
                          money(b.salePrice)
                        )}
                      </td>

                      {/* Totales */}
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums hidden lg:table-cell">
                        {isEditing
                          ? money(editInvoiceTotal)
                          : money(b.invoiceTotal || 0)}
                      </td>
                      <td className="p-2 md:p-3 border align-top text-right tabular-nums hidden lg:table-cell">
                        {isEditing
                          ? money(editExpectedTotal)
                          : money(b.expectedTotal || 0)}
                      </td>

                      {/* Comentario */}
                      <td className="p-2 md:p-3 border align-top hidden xl:table-cell max-w-[280px]">
                        {isEditing ? (
                          <textarea
                            className="w-full border p-1 rounded resize-y min-h-12"
                            value={editNotes}
                            onChange={(e) => setEditNotes(e.target.value)}
                            maxLength={500}
                          />
                        ) : (
                          <span
                            className="block truncate"
                            title={b.notes || ""}
                          >
                            {b.notes || "—"}
                          </span>
                        )}
                      </td>

                      {/* Estado */}
                      <td className="p-2 md:p-3 border align-top">
                        <span
                          className={`px-2 py-0.5 rounded text-[10px] md:text-xs ${
                            b.status === "PAGADO"
                              ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700"
                          }`}
                        >
                          {b.status}
                        </span>
                      </td>

                      {/* Acciones */}
                      <td className="p-2 md:p-3 border align-top">
                        {isEditing ? (
                          <div className="flex gap-2 justify-center">
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
                            className="inline-flex items-center justify-center w-8 h-8 rounded border border-gray-200 hover:bg-gray-100"
                            title="Acciones"
                            onClick={(e) => openActionsMenu(e, b.id)}
                          >
                            {/* ícono 3 puntos vertical */}
                            <svg
                              xmlns="http://www.w3.org/2000/svg"
                              className="h-4 w-4"
                              viewBox="0 0 24 24"
                              fill="currentColor"
                            >
                              <circle cx="12" cy="5" r="1.6" />
                              <circle cx="12" cy="12" r="1.6" />
                              <circle cx="12" cy="19" r="1.6" />
                            </svg>
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

      {/* Menú acciones fila */}
      {menuRowId &&
        createPortal(
          <>
            {/* Backdrop para capturar clics fuera */}
            <div
              onClick={() => setMenuRowId(null)}
              className="fixed inset-0 z-[60]"
            />
            {/* Menú flotante */}
            <div
              className="fixed z-[61] w-44 rounded-md border border-gray-200 bg-white shadow-xl"
              style={{ left: menuPos.x, top: menuPos.y }}
              onClick={(e) => e.stopPropagation()}
              role="menu"
              aria-orientation="vertical"
            >
              <div className="py-1 text-sm">
                {/* Pagar (si está pendiente) */}
                {(() => {
                  const row = filteredBatches.find((x) => x.id === menuRowId);
                  if (row?.status === "PENDIENTE") {
                    return (
                      <button
                        className="w-full text-left px-3 py-2 hover:bg-green-50"
                        onClick={() => {
                          setMenuRowId(null);
                          payBatch(row);
                        }}
                      >
                        ✅ Pagar
                      </button>
                    );
                  }
                  return null;
                })()}
                <button
                  className="w-full text-left px-3 py-2 hover:bg-yellow-50"
                  onClick={() => {
                    const row = filteredBatches.find((x) => x.id === menuRowId);
                    if (!row) return;
                    setMenuRowId(null);
                    startEdit(row);
                  }}
                >
                  ✏️ Editar
                </button>
                <button
                  className="w-full text-left px-3 py-2 hover:bg-red-50 text-red-600"
                  onClick={() => {
                    const row = filteredBatches.find((x) => x.id === menuRowId);
                    if (!row) return;
                    setMenuRowId(null);
                    deleteBatch(row);
                  }}
                >
                  🗑️ Borrar
                </button>
              </div>
            </div>
          </>,
          document.body,
        )}

      {/* Modal Crear Inventario (form original movido aquí) */}
      {showCreateModal &&
        createPortal(
          <div className="fixed inset-0 z-[70] flex items-center justify-center">
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setShowCreateModal(false)}
            />
            <div className="relative bg-white rounded-lg shadow-2xl border w-[96%] max-w-4xl max-h-[92vh] overflow-auto p-4">
              <div className="flex items-center justify-between mb-2">
                <h3 className="text-lg font-bold">Crear Inventario (Lote)</h3>
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              {/* Form nuevo lote (ROPA) – SIN CAMBIOS DE LÓGICA */}
              <form
                onSubmit={saveBatch}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                {/* Producto de catálogo (opcional) */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Producto de ropa
                  </label>
                  <select
                    className="w-full border p-2 rounded"
                    value={productId}
                    onChange={(e) => setProductId(e.target.value)}
                  >
                    <option value="">(Opcional) Selecciona un producto</option>
                    {products.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name} — {p.category} — {p.sku ? `SKU: ${p.sku}` : ""}
                      </option>
                    ))}
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Fecha del lote
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={dateStr}
                    onChange={(e) => setDateStr(e.target.value)}
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Cantidad (pzas)
                  </label>
                  <input
                    type="number"
                    step="1"
                    inputMode="numeric"
                    className="w-full border p-2 rounded"
                    value={quantity === 0 ? "" : quantity}
                    onChange={(e) =>
                      setQuantity(
                        Math.max(0, parseInt(e.target.value || "0", 10)),
                      )
                    }
                    placeholder=""
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Precio de compra (pza)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={purchasePrice === 0 ? "" : purchasePrice}
                    onChange={(e) =>
                      setPurchasePrice(
                        Math.max(0, parseFloat(e.target.value || "0")),
                      )
                    }
                  />
                </div>

                <div>
                  <label className="block text-sm font-semibold">
                    Precio de venta (pza)
                  </label>
                  <input
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    className="w-full border p-2 rounded"
                    value={salePrice === 0 ? "" : salePrice}
                    onChange={(e) =>
                      setSalePrice(
                        Math.max(0, parseFloat(e.target.value || "0")),
                      )
                    }
                  />
                </div>

                {/* Campos opcionales de ropa (por lote) */}
                <div>
                  <label className="block text-sm font-semibold">
                    SKU (auto)
                  </label>
                  <input
                    className="w-full border p-2 rounded bg-gray-100"
                    value={sku}
                    readOnly
                    placeholder="Se genera automáticamente o se carga del producto"
                    title="Si el producto tiene SKU, se usa tal cual; si no, se genera por subcat/género/talla/color/marca."
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">Talla</label>
                  <input
                    className="w-full border p-2 rounded bg-gray-100"
                    value={size}
                    readOnly
                    onChange={(e) => setSize(e.target.value)}
                    placeholder="XS/S/M/L/XL/10/12…"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">Color</label>
                  <input
                    className="w-full border p-2 rounded bg-gray-100"
                    value={color}
                    readOnly
                    onChange={(e) => setColor(e.target.value)}
                    placeholder="Negro, Azul, Rojo…"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">Color</label>
                  <input
                    className="w-full border p-2 rounded bg-gray-100"
                    value={gender}
                    readOnly
                    onChange={(e) => setGender(e.target.value)}
                    placeholder="Masculino, Femenino, Otro…"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Marca / Origen (opcional)
                  </label>
                  <input
                    className="w-full border p-2 rounded bg-gray-100"
                    value={brand}
                    onChange={(e) => setBrand(e.target.value)}
                    placeholder="Shein, Usado, Otro…"
                  />
                </div>

                {/* Código del cliente (opcional) */}
                <div>
                  <label className="block text-sm font-semibold">
                    Código del cliente (opcional)
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    placeholder="Ej: LOTE-SHEIN-SEP-01"
                    value={clientCode}
                    onChange={(e) => {
                      const v = e.target.value;
                      if (CLIENT_CODE_RE.test(v)) setClientCode(v);
                    }}
                    title="Solo letras, números, punto, guion y guion_bajo (máx 32)"
                  />
                  {!CLIENT_CODE_RE.test(clientCode) &&
                    clientCode.length > 0 && (
                      <div className="text-xs text-red-600 mt-1">
                        Formato inválido
                      </div>
                    )}
                </div>

                {/* Comentario extendido */}
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Comentario
                  </label>
                  <textarea
                    className="w-full border p-2 rounded resize-y min-h-24"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    maxLength={500}
                    placeholder="Ej: Camisita veranera, tela delgada, tirantes…"
                  />
                  <div className="text-xs text-gray-500 text-right">
                    {notes.length}/500
                  </div>
                </div>

                {/* campos calculados */}
                <div>
                  <label className="block text-sm font-semibold">
                    Total factura (auto)
                  </label>
                  <input
                    type="text"
                    className="w-full border p-2 rounded bg-gray-100"
                    value={money(invoiceTotal)}
                    readOnly
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Total esperado (auto)
                  </label>
                  <input
                    type="text"
                    className="w-full border p-2 rounded bg-gray-100"
                    value={money(expectedTotal)}
                    readOnly
                  />
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
                    Guardar lote
                  </button>
                </div>
              </form>
            </div>
          </div>,
          document.body,
        )}

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
