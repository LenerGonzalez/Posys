// src/components/InventoryBatches.tsx
import React, { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  collection,
  getDocs,
  orderBy,
  query,
  updateDoc,
  deleteDoc,
  doc,
  addDoc,
  Timestamp,
} from "firebase/firestore";
import { db } from "../../firebase";
import { newBatch, markBatchAsPaid } from "../../Services/inventory";
import { format, startOfMonth, endOfMonth } from "date-fns";
import { roundQty } from "../../Services/decimal";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

// ===== Types =====
interface Product {
  id: string;
  name: string;
  category: string;
  measurement: string; // lb / unidad / etc.
  price: number;
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

  // ✅ NUEVO (solo metadata para UI agrupada)
  batchGroupId?: string;
  orderName?: string;
}

type GroupRow = {
  groupId: string; // batchGroupId o fallback = batch.id
  orderName: string;
  date: string;
  typeLabel: string; // Tipo (category o MIXTO)
  status: "PENDIENTE" | "PAGADO";

  lbsIn: number;
  lbsRem: number;

  totalFacturado: number;
  totalEsperado: number;
  utilidadBruta: number;

  items: Batch[];
};

// ===== helpers =====
function uid(prefix = "LOT") {
  // sin dependencias, lo suficientemente único para Firestore
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export default function InventoryBatches() {
  const [products, setProducts] = useState<Product[]>([]);
  const [batches, setBatches] = useState<Batch[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");
  const { refreshKey, refresh } = useManualRefresh();

  // 🔎 Filtro por fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );

  // 🔵 Filtro por producto
  const [productFilterId, setProductFilterId] = useState<string>("");

  // 👉 Modal Crear Pedido/Lote (nuevo)
  const [showCreateModal, setShowCreateModal] = useState(false);

  // ===== Form header del pedido =====
  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>(
    format(new Date(), "yyyy-MM-dd")
  );

  // ===== Filtro unidad ANTES de seleccionar producto =====
  const [unitFilter, setUnitFilter] = useState<string>("lb");

  // ===== Inputs para agregar producto al pedido =====
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState<number>(0);
  const [purchasePrice, setPurchasePrice] = useState<number>(0);
  const [salePrice, setSalePrice] = useState<number>(0);

  // items agregados al pedido
  type OrderItem = {
    tempId: string; // para UI
    productId: string;
    productName: string;
    category: string;
    unit: string;

    quantity: number; // lbs ingresadas
    remaining: number; // lbs restantes (inicialmente = quantity)

    purchasePrice: number;
    salePrice: number;

    invoiceTotal: number;
    expectedTotal: number;
    utilidadBruta: number;
  };

  const [orderItems, setOrderItems] = useState<OrderItem[]>([]);
  const [editingGroupId, setEditingGroupId] = useState<string | null>(null); // si editas pedido existente
  const [editingGroupItems, setEditingGroupItems] = useState<Batch[]>([]); // docs reales del grupo (para edición/guardado)
  const [showDetailModal, setShowDetailModal] = useState(false);
  const [detailGroup, setDetailGroup] = useState<GroupRow | null>(null);

  // === NUEVO: estado para diálogo de "Pagar" (grupo) ===
  const [showPayDialog, setShowPayDialog] = useState(false);
  const [selectedGroup, setSelectedGroup] = useState<GroupRow | null>(null);

  const isPounds = (u: string) => {
    const s = (u || "").toLowerCase();
    return /(^|\s)(lb|lbs|libra|libras)(\s|$)/.test(s) || s === "lb";
  };

  // ===== Load =====
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");

      // cargar products
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
        });
      });
      setProducts(prods);

      // cargar batches
      const qB = query(
        collection(db, "inventory_batches"),
        orderBy("date", "desc")
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

  // ===== Filtro en memoria (fecha + producto) =====
  const filteredBatches = useMemo(() => {
    return batches.filter((b) => {
      if (fromDate && b.date < fromDate) return false;
      if (toDate && b.date > toDate) return false;
      if (productFilterId && b.productId !== productFilterId) return false;
      return true;
    });
  }, [batches, fromDate, toDate, productFilterId]);

  // ===== Totales arriba (NO TOCAR UI) =====
  const totals = useMemo(() => {
    const totalFacturado = filteredBatches.reduce(
      (a, b) => a + Number(b.invoiceTotal || 0),
      0
    );
    const totalEsperado = filteredBatches.reduce(
      (a, b) => a + Number(b.expectedTotal || 0),
      0
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
    };
  }, [filteredBatches]);

  // ===== NUEVO: Agrupar en pedidos/lotes =====
  const groupedRows = useMemo<GroupRow[]>(() => {
    const map = new Map<string, Batch[]>();

    for (const b of filteredBatches) {
      const gid = (b.batchGroupId && String(b.batchGroupId).trim()) || b.id; // fallback: doc solo
      if (!map.has(gid)) map.set(gid, []);
      map.get(gid)!.push(b);
    }

    const rows: GroupRow[] = [];
    for (const [groupId, items] of map.entries()) {
      // ordenar items por createdAt (si quieres consistencia visual)
      const ordered = [...items].sort((a, b) => {
        const sa = a.createdAt?.seconds ?? 0;
        const sb = b.createdAt?.seconds ?? 0;
        return sb - sa;
      });

      // fecha de grupo: la del primer item (son iguales por tu modal)
      const date = ordered[0]?.date || "";

      // nombre pedido
      const orderNameLocal =
        String(ordered[0]?.orderName || "").trim() ||
        `Pedido ${date || ""}`.trim() ||
        "Pedido";

      // tipo (category)
      const cats = new Set(
        ordered.map((x) => String(x.category || "").trim()).filter(Boolean)
      );
      const typeLabel =
        cats.size === 1 ? Array.from(cats)[0].toUpperCase() : "MIXTO";

      // status: si alguno está pendiente => PENDIENTE, si todos pagados => PAGADO
      const status: "PENDIENTE" | "PAGADO" = ordered.some(
        (x) => x.status === "PENDIENTE"
      )
        ? "PENDIENTE"
        : "PAGADO";

      // sums lbs ingresadas/restantes (tú pediste libras del lote)
      const lbsIn = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.quantity || 0) : 0),
          0
        )
      );
      const lbsRem = roundQty(
        ordered.reduce(
          (acc, x) => acc + (isPounds(x.unit) ? Number(x.remaining || 0) : 0),
          0
        )
      );

      const totalFacturado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.invoiceTotal || 0), 0)
          .toFixed(2)
      );
      const totalEsperado = Number(
        ordered
          .reduce((acc, x) => acc + Number(x.expectedTotal || 0), 0)
          .toFixed(2)
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
        totalFacturado,
        totalEsperado,
        utilidadBruta,
        items: ordered,
      });
    }

    // orden por fecha desc (como tu tabla actual)
    rows.sort((a, b) =>
      a.date === b.date
        ? a.groupId < b.groupId
          ? 1
          : -1
        : a.date < b.date
        ? 1
        : -1
    );
    return rows;
  }, [filteredBatches]);

  // ===== PRODUCTOS filtrados por unidad (filtro antes de agregar) =====
  const productsByUnit = useMemo(() => {
    const u = String(unitFilter || "")
      .toLowerCase()
      .trim();
    const list = products.filter(
      (p) =>
        String(p.measurement || "")
          .toLowerCase()
          .trim() === u
    );
    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [products, unitFilter]);

  // sugerir salePrice del producto elegido
  useEffect(() => {
    const p = products.find((x) => x.id === productId);
    if (p) setSalePrice(Number(p.price || 0));
  }, [productId, products, refreshKey]);

  // ===== Crear pedido: agregar item =====
  const addItemToOrder = () => {
    setMsg("");

    const p = products.find((x) => x.id === productId);
    if (!p) {
      setMsg("Selecciona un producto.");
      return;
    }
    if (quantity <= 0 || purchasePrice <= 0) {
      setMsg("Completa libras a ingresar y precio proveedor.");
      return;
    }

    const qtyR = roundQty(quantity);
    const unit = p.measurement;

    const inv = Number((qtyR * Number(purchasePrice || 0)).toFixed(2));
    const exp = Number((qtyR * Number(salePrice || 0)).toFixed(2));
    const util = Number((exp - inv).toFixed(2));

    // si ya existe el producto en el pedido, lo reemplazamos/actualizamos (para no duplicar filas)
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
              }
        )
      );
    } else {
      const item: OrderItem = {
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
      };
      setOrderItems((prev) => [...prev, item]);
    }

    // limpiar inputs de agregar
    setProductId("");
    setQuantity(0);
    setPurchasePrice(0);
    setSalePrice(0);
  };

  const removeOrderItem = (tempId: string) => {
    setOrderItems((prev) => prev.filter((x) => x.tempId !== tempId));
  };

  // editar inline en tabla de items del pedido (crear o editar)
  const updateOrderItemField = (
    tempId: string,
    field: "quantity" | "purchasePrice" | "salePrice",
    value: number
  ) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.tempId !== tempId) return it;

        const updated = { ...it } as OrderItem;

        if (field === "quantity") {
          updated.quantity = roundQty(Math.max(0, value));
          updated.remaining = updated.quantity; // en creación = iguales
        }
        if (field === "purchasePrice")
          updated.purchasePrice = Math.max(0, Number(value || 0));
        if (field === "salePrice")
          updated.salePrice = Math.max(0, Number(value || 0));

        updated.invoiceTotal = Number(
          (updated.quantity * updated.purchasePrice).toFixed(2)
        );
        updated.expectedTotal = Number(
          (updated.quantity * updated.salePrice).toFixed(2)
        );
        updated.utilidadBruta = Number(
          (updated.expectedTotal - updated.invoiceTotal).toFixed(2)
        );

        return updated;
      })
    );
  };

  // KPIs del modal (sumas)
  const orderKpis = useMemo(() => {
    const lbsIn = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.quantity || 0) : 0),
        0
      )
    );
    const lbsRem = roundQty(
      orderItems.reduce(
        (acc, it) => acc + (isPounds(it.unit) ? Number(it.remaining || 0) : 0),
        0
      )
    );

    const totalFacturado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.invoiceTotal || 0), 0)
        .toFixed(2)
    );
    const totalEsperado = Number(
      orderItems
        .reduce((acc, it) => acc + Number(it.expectedTotal || 0), 0)
        .toFixed(2)
    );
    const utilidadBruta = Number((totalEsperado - totalFacturado).toFixed(2));

    return { lbsIn, lbsRem, totalFacturado, totalEsperado, utilidadBruta };
  }, [orderItems]);

  const resetOrderModal = () => {
    setEditingGroupId(null);
    setEditingGroupItems([]);
    setOrderName("");
    setOrderDate(format(new Date(), "yyyy-MM-dd"));
    setUnitFilter("lb");
    setProductId("");
    setQuantity(0);
    setPurchasePrice(0);
    setSalePrice(0);
    setOrderItems([]);
  };

  // ===== GUARDAR PEDIDO (crear o editar) =====
  const saveOrder = async () => {
    setMsg("");

    if (!orderItems.length) {
      setMsg("Agrega al menos un producto al pedido.");
      return;
    }

    const dateStr = orderDate || format(new Date(), "yyyy-MM-dd");
    const name = String(orderName || "").trim() || `Pedido ${dateStr}`;
    const groupId = editingGroupId || uid("BATCH");

    try {
      // ✅ CREAR
      if (!editingGroupId) {
        // crear N docs en inventory_batches (mismo comportamiento que antes, solo en batch)
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

      // ✅ EDITAR: actualizar docs existentes del grupo y upsert según items actuales
      // - No inventamos lógica: solo hacemos updateDoc (misma idea de tu saveEdit) y deleteDoc si quitaste uno.
      const existing = editingGroupItems;

      // map por productId de docs existentes (1 doc por producto en tu UI)
      const existingByProduct = new Map<string, Batch>();
      for (const b of existing) existingByProduct.set(b.productId, b);

      const productIdsNew = new Set(orderItems.map((x) => x.productId));

      // 1) actualizar o crear
      for (const it of orderItems) {
        const oldDoc = existingByProduct.get(it.productId);
        const qtyR = roundQty(it.quantity);

        if (oldDoc) {
          // mantener consumido (si ya hubo ventas)
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
          // nuevo producto agregado al pedido
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

      // 2) eliminar docs de productos quitados del pedido (mismo patrón que tus órdenes maestras)
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

  // ===== Acciones de GRUPO =====
  const openDetail = (g: GroupRow) => {
    setDetailGroup(g);
    setShowDetailModal(true);
  };

  const openForEdit = (g: GroupRow) => {
    // cargar items reales del grupo para editar y respetar consumido
    setEditingGroupId(g.groupId);
    setEditingGroupItems(g.items);

    setOrderName(g.orderName);
    setOrderDate(g.date || format(new Date(), "yyyy-MM-dd"));

    // construir orderItems desde docs (editable)
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
        remaining: roundQty(b.remaining), // en edición mostramos la real
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

  // pagar grupo (abre confirm)
  const payGroup = (g: GroupRow) => {
    setSelectedGroup(g);
    setShowPayDialog(true);
  };

  // confirmar pagar grupo: mantiene tu misma lógica por doc (markBatchAsPaid + remaining=0 + saleV2)
  const confirmPayGroupNow = async () => {
    if (!selectedGroup) return;

    try {
      for (const b of selectedGroup.items) {
        if (b.status !== "PENDIENTE") continue;

        // 1) Marcar pagado
        await markBatchAsPaid(b.id);

        // 2) Debitar stock (remaining -> 0)
        await updateDoc(doc(db, "inventory_batches", b.id), { remaining: 0 });

        // 3) Crear venta en salesV2 (misma lógica que tenías)
        const saleDoc = {
          date: b.date,
          productName: b.productName,
          quantity: b.quantity,
          amount: Number(
            (b.expectedTotal ?? b.salePrice * b.quantity).toFixed(2)
          ),
          allocations: [
            {
              batchId: b.id,
              qty: b.quantity,
              unitCost: b.purchasePrice,
              lineCost: Number((b.purchasePrice * b.quantity).toFixed(2)),
            },
          ],
          avgUnitCost: b.purchasePrice,
          measurement: b.unit,
          createdAt: Timestamp.now(),
          autoGeneratedFromInventory: true,
        };
        await addDoc(collection(db, "salesV2"), saleDoc);
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

  // ===== UI =====
  return (
    <div className="max-w-6xl mx-auto shadows-2xl">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Inventario (Pollo)</h2>
        <button
          className="px-3 py-2 rounded-2xl bg-blue-600 text-white hover:bg-blue-700"
          type="button"
          onClick={() => {
            resetOrderModal();
            setShowCreateModal(true);
          }}
        >
          Crear Lote
        </button>
      </div>

      {/* 🔎 Barra de filtro por fecha (NO TOCAR) */}
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

        {/* Filtro por producto (NO TOCAR) */}
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

        {/* 🔄 Refresh manual (NO TOCAR) */}
        <div className="ml-auto">
          <RefreshButton onClick={() => refresh()} loading={loading} />
        </div>
      </div>

      {/* KPIs (NO TOCAR) */}
      <div className="bg-gray-50 p-3 rounded-2xl shadow-2xl border mb-3 text-base">
        <div className="grid grid-cols-3 gap-y-2 gap-x-8">
          <div>
            <span className="font-semibold">Libras ingresadas:</span>{" "}
            {totals.lbsIng.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Unidades ingresadas:</span>{" "}
            {totals.udsIng.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Total esperado en ventas:</span> C${" "}
            {totals.totalEsperado.toFixed(2)}
          </div>

          <div>
            <span className="font-semibold">Libras restantes:</span>{" "}
            {totals.lbsRem.toFixed(3)}
          </div>

          <div>
            <span className="font-semibold">Unidades restantes:</span>{" "}
            {totals.udsRem.toFixed(3)}
          </div>
          <div>
            <span className="font-semibold">Total facturado:</span> C${" "}
            {totals.totalFacturado.toFixed(2)}
          </div>
          <div>
            <span className="font-semibold">Ganancia sin gastos:</span> C${" "}
            {(totals.totalEsperado - totals.totalFacturado).toFixed(2)}
          </div>
          <div>
            <span className="font-semibold">
              Cantidad de Lotes (por filtro):
            </span>{" "}
            {filteredBatches.length.toLocaleString()}
          </div>
        </div>
      </div>

      {/* ===== TABLA NUEVA (por pedido/grupo) ===== */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto">
        <table className="min-w-[1100px] w-full text-sm shadow-2xl">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Tipo</th>
              <th className="p-2 border">Libras ingresadas</th>
              <th className="p-2 border">Libras restantes</th>
              <th className="p-2 border">Total Facturado</th>
              <th className="p-2 border">Total esperado</th>
              <th className="p-2 border">Utilidad bruta</th>
              <th className="p-2 border">Estado</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>

          <tbody>
            {loading ? (
              <tr>
                <td colSpan={9} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : groupedRows.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-4 text-center">
                  Sin lotes
                </td>
              </tr>
            ) : (
              groupedRows.map((g) => (
                <tr key={g.groupId} className="text-center whitespace-nowrap">
                  <td className="p-2 border">
                    <button
                      className="underline text-blue-700 hover:text-blue-900"
                      onClick={() => openDetail(g)}
                      title={g.orderName}
                    >
                      {g.date}
                    </button>
                    <div className="text-[11px] text-gray-500">
                      {g.orderName}
                    </div>
                  </td>
                  <td className="p-2 border">{g.typeLabel}</td>
                  <td className="p-2 border">{g.lbsIn.toFixed(3)}</td>
                  <td className="p-2 border">{g.lbsRem.toFixed(3)}</td>
                  <td className="p-2 border">{money(g.totalFacturado)}</td>
                  <td className="p-2 border">{money(g.totalEsperado)}</td>
                  <td className="p-2 border">{money(g.utilidadBruta)}</td>
                  <td className="p-2 border">
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
                  <td className="p-2 border">
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
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* ===== MODAL CREAR/EDITAR PEDIDO ===== */}
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
                <button
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                  type="button"
                >
                  Cerrar
                </button>
              </div>

              {/* Header */}
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

              {/* Bloque agregar producto (solo UI, como pediste) */}
              <div className="border rounded p-3 bg-gray-50 mb-4">
                <div className="grid grid-cols-1 md:grid-cols-6 gap-3 items-end">
                  {/* ✅ FILTRO DE UNIDAD ANTES DEL PRODUCTO */}
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
                        setPurchasePrice(0);
                        setSalePrice(0);
                      }}
                    >
                      <option value="lb">lb</option>
                      <option value="unidad">unidad</option>
                      <option value="kg">kg</option>
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
                      Libras a ingresar
                    </label>
                    <input
                      type="number"
                      step="0.01"
                      inputMode="decimal"
                      className="w-full border p-2 rounded"
                      value={quantity === 0 ? "" : quantity}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(3))
                          : 0;
                        setQuantity(Math.max(0, safe));
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
                      value={purchasePrice === 0 ? "" : purchasePrice}
                      onChange={(e) => {
                        const raw = e.target.value.replace(",", ".");
                        const num = parseFloat(raw);
                        const safe = Number.isFinite(num)
                          ? parseFloat(num.toFixed(2))
                          : 0;
                        setPurchasePrice(Math.max(0, safe));
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
                      }}
                      disabled={!productId}
                    />
                  </div>
                </div>

                <div className="flex justify-end mt-3">
                  <button
                    type="button"
                    onClick={addItemToOrder}
                    className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700"
                  >
                    Agregar producto al pedido
                  </button>
                </div>
              </div>

              {/* Tabla productos agregados */}
              <div className="bg-white rounded border overflow-x-auto">
                <table className="min-w-[1200px] text-xs md:text-sm">
                  <thead className="bg-gray-100">
                    <tr className="whitespace-nowrap">
                      <th className="p-2 border">Producto</th>
                      <th className="p-2 border">Libras ingresadas</th>
                      <th className="p-2 border">Libras restantes</th>
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

                          {/* ✅ Editables: libras ingresadas, precio proveedor, precio venta */}
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
                                  safe
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
                                  safe
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
                                  safe
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

              {/* KPIs abajo (como ordenes maestras) */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 mt-4">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">Libras ingresadas</div>
                  <div className="text-lg font-semibold">
                    {orderKpis.lbsIn.toFixed(3)}
                  </div>
                  <div className="text-xs text-gray-600 mt-2">
                    Libras restantes
                  </div>
                  <div className="text-lg font-semibold">
                    {orderKpis.lbsRem.toFixed(3)}
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

              {/* Botones */}
              <div className="flex justify-end gap-2 mt-4">
                <button
                  type="button"
                  className="px-4 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  onClick={() => setShowCreateModal(false)}
                >
                  Cancelar
                </button>

                <button
                  type="button"
                  className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
                  onClick={saveOrder}
                  disabled={orderItems.length === 0}
                >
                  {editingGroupId ? "Editar pedido" : "Crear pedido"}
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* ===== MODAL DETALLE PEDIDO ===== */}
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
          document.body
        )}

      {/* ===== MODAL CONFIRMAR PAGO (grupo) ===== */}
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
          document.body
        )}
    </div>
  );
}
