// src/components/Candies/InventoryCandyOrders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";

// Helpers
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

type Branch = "RIVAS" | "SAN_JORGE" | "ISLA";

interface CandyOrderSummaryRow {
  id: string; // id del doc en candy_main_orders
  name: string;
  date: string;
  totalPackages: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;

  // márgenes “del pedido”
  marginRivas: number;
  marginSanJorge: number;
  marginIsla: number;

  createdAt: Timestamp;
}

interface CandyOrderItem {
  id: string; // id del doc del item del pedido en products_candies
  name: string;
  category: string;

  providerPrice: number; // precio proveedor por paquete
  packages: number;
  unitsPerPackage: number;

  // ✅ márgenes POR PRODUCTO (estos son los editables en la tabla)
  marginRivas: number;
  marginSanJorge: number;
  marginIsla: number;

  subtotal: number;
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;

  // ✅ ganancias en dinero (tu schema actual)
  gainRivas: number;
  gainSanJorge: number;
  gainIsla: number;

  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;

  remainingPackages?: number;
}

interface OrderInventoryAgg {
  orderId: string;
  totalPackages: number;
  remainingPackages: number;
}

// ===== Helpers de recálculo =====
function recalcItemWithMargins(item: CandyOrderItem): CandyOrderItem {
  const packages = Number(item.packages || 0);
  const providerPrice = Number(item.providerPrice || 0);
  const unitsPerPackage = Number(item.unitsPerPackage || 0);

  const subtotal = providerPrice * packages;
  const totalUnits =
    packages > 0 && unitsPerPackage > 0 ? packages * unitsPerPackage : 1;

  const mR = Number(item.marginRivas || 0);
  const mSJ = Number(item.marginSanJorge || 0);
  const mI = Number(item.marginIsla || 0);

  const totalRivas = subtotal * (1 + mR / 100);
  const totalSanJorge = subtotal * (1 + mSJ / 100);
  const totalIsla = subtotal * (1 + mI / 100);

  const gainRivas = totalRivas - subtotal;
  const gainSanJorge = totalSanJorge - subtotal;
  const gainIsla = totalIsla - subtotal;

  const unitPriceRivas = totalRivas / totalUnits;
  const unitPriceSanJorge = totalSanJorge / totalUnits;
  const unitPriceIsla = totalIsla / totalUnits;

  return {
    ...item,
    subtotal: Number(subtotal.toFixed(2)),
    totalRivas: Number(totalRivas.toFixed(2)),
    totalSanJorge: Number(totalSanJorge.toFixed(2)),
    totalIsla: Number(totalIsla.toFixed(2)),
    gainRivas: Number(gainRivas.toFixed(2)),
    gainSanJorge: Number(gainSanJorge.toFixed(2)),
    gainIsla: Number(gainIsla.toFixed(2)),
    unitPriceRivas: Number(unitPriceRivas.toFixed(2)),
    unitPriceSanJorge: Number(unitPriceSanJorge.toFixed(2)),
    unitPriceIsla: Number(unitPriceIsla.toFixed(2)),
  };
}

function recalcOrderTotalsFromItems(items: CandyOrderItem[]) {
  return items.reduce(
    (acc, it) => {
      acc.totalPackages += Number(it.packages || 0);
      acc.subtotal += Number(it.subtotal || 0);
      acc.totalRivas += Number(it.totalRivas || 0);
      acc.totalSanJorge += Number(it.totalSanJorge || 0);
      acc.totalIsla += Number(it.totalIsla || 0);
      return acc;
    },
    {
      totalPackages: 0,
      subtotal: 0,
      totalRivas: 0,
      totalSanJorge: 0,
      totalIsla: 0,
    }
  );
}

// ===== Helpers para fallback de márgenes =====
function safeNumber(v: any, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function marginFromDocOrFallback(params: {
  // valores del doc
  margin?: any;
  gain?: any;
  subtotal?: any;
  // fallback (margen del pedido)
  orderMargin: number;
}) {
  const { margin, gain, subtotal, orderMargin } = params;

  if (
    margin !== undefined &&
    margin !== null &&
    Number.isFinite(Number(margin))
  )
    return Number(margin);

  const sub = Number(subtotal || 0);
  const g = Number(gain);

  // si no hay margin pero sí hay gain, calculamos % = gain/subtotal*100
  if (Number.isFinite(g) && sub > 0) return (g / sub) * 100;

  // si no hay nada, usa margen del pedido
  return Number(orderMargin || 0);
}

export default function InventoryCandyOrders() {
  const [orders, setOrders] = useState<CandyOrderSummaryRow[]>([]);
  const [orderInventoryAgg, setOrderInventoryAgg] = useState<
    Record<string, OrderInventoryAgg>
  >({});
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros de fecha
  const [fromDate, setFromDate] = useState<string>(
    format(startOfMonth(new Date()), "yyyy-MM-dd")
  );
  const [toDate, setToDate] = useState<string>(
    format(endOfMonth(new Date()), "yyyy-MM-dd")
  );

  // Modal de detalle / edición del pedido
  const [openDetailsModal, setOpenDetailsModal] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] =
    useState<CandyOrderSummaryRow | null>(null);
  const [selectedOrderItems, setSelectedOrderItems] = useState<
    CandyOrderItem[]
  >([]);

  // ====== INPUTS DE “AGREGAR PRODUCTO” ======
  // estos 3 son los márgenes que vos ya tenés arriba y querés que se copien al producto
  const [addMarginRivas, setAddMarginRivas] = useState<number>(0);
  const [addMarginSJ, setAddMarginSJ] = useState<number>(0);
  const [addMarginIsla, setAddMarginIsla] = useState<number>(0);

  // Datos del producto a agregar
  const [addName, setAddName] = useState("");
  const [addCategory, setAddCategory] = useState("");
  const [addProviderPrice, setAddProviderPrice] = useState<number>(0);
  const [addPackages, setAddPackages] = useState<number>(0);
  const [addUnitsPerPackage, setAddUnitsPerPackage] = useState<number>(1);

  // ===== Carga inicial de pedidos + agregados de inventario =====
  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setMsg("");

        // Pedidos generales
        const qO = query(
          collection(db, "candy_main_orders"),
          orderBy("createdAt", "desc")
        );
        const snapO = await getDocs(qO);
        const ordersList: CandyOrderSummaryRow[] = [];
        snapO.forEach((d) => {
          const x = d.data() as any;
          ordersList.push({
            id: d.id,
            name: x.name ?? "",
            date: x.date ?? "",
            totalPackages: Number(x.totalPackages ?? 0),
            subtotal: Number(x.subtotal ?? 0),
            totalRivas: Number(x.totalRivas ?? 0),
            totalSanJorge: Number(x.totalSanJorge ?? 0),
            totalIsla: Number(x.totalIsla ?? 0),

            marginRivas: Number(x.marginRivas ?? 0),
            marginSanJorge: Number(x.marginSanJorge ?? 0),
            marginIsla: Number(x.marginIsla ?? 0),

            createdAt: x.createdAt ?? Timestamp.now(),
          });
        });
        setOrders(ordersList);

        // Inventario de dulces (para agregados por pedido)
        const snapInv = await getDocs(
          query(collection(db, "inventory_candies"))
        );

        const agg: Record<string, OrderInventoryAgg> = {};
        snapInv.forEach((d) => {
          const x = d.data() as any;
          const orderId = x.orderId as string | undefined;
          if (!orderId) return;

          const unitsPerPackage = Number(x.unitsPerPackage || 1) || 1;

          const totalUnits = Number(
            x.totalUnits ?? (x.packages || 0) * unitsPerPackage
          );
          const totalPackages = Math.round(totalUnits / unitsPerPackage);

          const remainingUnits = Number(
            x.remaining ?? x.totalUnits ?? totalUnits
          );
          const remainingPackagesField = Number(x.remainingPackages ?? NaN);
          const remainingPackages = Number.isFinite(remainingPackagesField)
            ? Math.round(remainingPackagesField)
            : Math.round(remainingUnits / unitsPerPackage);

          if (!agg[orderId]) {
            agg[orderId] = { orderId, totalPackages: 0, remainingPackages: 0 };
          }
          agg[orderId].totalPackages += totalPackages;
          agg[orderId].remainingPackages += remainingPackages;
        });

        setOrderInventoryAgg(agg);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando inventario de pedidos.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  // ===== Filtro de pedidos por fecha =====
  const filteredOrders = useMemo(() => {
    return orders.filter((o) => {
      const dateStr =
        o.date ||
        (o.createdAt?.toDate
          ? o.createdAt.toDate().toISOString().slice(0, 10)
          : "");
      if (!dateStr) return false;
      if (fromDate && dateStr < fromDate) return false;
      if (toDate && dateStr > toDate) return false;
      return true;
    });
  }, [orders, fromDate, toDate]);

  // ===== Totales del filtro =====
  const totals = useMemo(() => {
    let totalPaquetes = 0;
    let totalSubtotal = 0;
    let totalRivas = 0;
    let totalSJ = 0;
    let totalIsla = 0;
    let totalPaquetesRestantes = 0;

    for (const o of filteredOrders) {
      totalPaquetes += o.totalPackages;
      totalSubtotal += o.subtotal;
      totalRivas += o.totalRivas;
      totalSJ += o.totalSanJorge;
      totalIsla += o.totalIsla;

      const agg = orderInventoryAgg[o.id];
      if (agg) totalPaquetesRestantes += agg.remainingPackages;
    }

    return {
      totalPaquetes,
      totalSubtotal,
      totalRivas,
      totalSJ,
      totalIsla,
      totalPaquetesRestantes,
      totalPedidos: filteredOrders.length,
    };
  }, [filteredOrders, orderInventoryAgg]);

  // ===== Editar márgenes POR PRODUCTO desde la tabla =====
  const handleItemMarginChange = async (
    productId: string,
    field: "marginRivas" | "marginSanJorge" | "marginIsla",
    value: string
  ) => {
    if (!selectedOrder) return;

    const margin = Number(value || 0);

    // 1) local + recalculo
    const updatedItems = selectedOrderItems.map((it) => {
      if (it.id !== productId) return it;
      return recalcItemWithMargins({
        ...it,
        [field]: margin,
      } as CandyOrderItem);
    });
    setSelectedOrderItems(updatedItems);

    const updatedItem = updatedItems.find((it) => it.id === productId);
    if (!updatedItem) return;

    const newTotals = recalcOrderTotalsFromItems(updatedItems);

    try {
      // ✅ Guardar márgenes + cálculos + gains en el item del pedido
      await updateDoc(doc(db, "products_candies", productId), {
        // % márgenes
        marginRivas: updatedItem.marginRivas,
        marginSanJorge: updatedItem.marginSanJorge,
        marginIsla: updatedItem.marginIsla,

        // cálculos
        subtotal: updatedItem.subtotal,
        totalRivas: updatedItem.totalRivas,
        totalSanJorge: updatedItem.totalSanJorge,
        totalIsla: updatedItem.totalIsla,
        unitPriceRivas: updatedItem.unitPriceRivas,
        unitPriceSanJorge: updatedItem.unitPriceSanJorge,
        unitPriceIsla: updatedItem.unitPriceIsla,

        // 💰 gains (tu schema)
        gainRivas: updatedItem.gainRivas,
        gainSanJorge: updatedItem.gainSanJorge,
        gainIsla: updatedItem.gainIsla,
      });

      // Totales del pedido
      await updateDoc(doc(db, "candy_main_orders", selectedOrder.id), {
        totalPackages: newTotals.totalPackages,
        subtotal: Number(newTotals.subtotal.toFixed(2)),
        totalRivas: Number(newTotals.totalRivas.toFixed(2)),
        totalSanJorge: Number(newTotals.totalSanJorge.toFixed(2)),
        totalIsla: Number(newTotals.totalIsla.toFixed(2)),
      });

      // refrescar selectedOrder en memoria
      setSelectedOrder((prev) =>
        prev
          ? {
              ...prev,
              totalPackages: newTotals.totalPackages,
              subtotal: Number(newTotals.subtotal.toFixed(2)),
              totalRivas: Number(newTotals.totalRivas.toFixed(2)),
              totalSanJorge: Number(newTotals.totalSanJorge.toFixed(2)),
              totalIsla: Number(newTotals.totalIsla.toFixed(2)),
            }
          : prev
      );

      setMsg("✅ Márgenes del producto actualizados.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error actualizando márgenes del producto.");
    }
  };

  // ===== Agregar producto al pedido usando LOS 3 INPUTS DE ARRIBA =====
  const handleAddProductToOrder = async () => {
    if (!selectedOrder) return;

    try {
      setMsg("");

      // si el usuario no tocó los márgenes, usa los del pedido como default
      const mr =
        Number.isFinite(addMarginRivas) && addMarginRivas !== 0
          ? addMarginRivas
          : selectedOrder.marginRivas || 0;

      const msj =
        Number.isFinite(addMarginSJ) && addMarginSJ !== 0
          ? addMarginSJ
          : selectedOrder.marginSanJorge || 0;

      const mi =
        Number.isFinite(addMarginIsla) && addMarginIsla !== 0
          ? addMarginIsla
          : selectedOrder.marginIsla || 0;

      const baseItem: CandyOrderItem = recalcItemWithMargins({
        id: "tmp",
        name: addName.trim(),
        category: addCategory.trim(),
        providerPrice: Number(addProviderPrice || 0),
        packages: Number(addPackages || 0),
        unitsPerPackage: Number(addUnitsPerPackage || 1),

        // ✅ se copian márgenes % al producto
        marginRivas: Number(mr || 0),
        marginSanJorge: Number(msj || 0),
        marginIsla: Number(mi || 0),

        subtotal: 0,
        totalRivas: 0,
        totalSanJorge: 0,
        totalIsla: 0,

        gainRivas: 0,
        gainSanJorge: 0,
        gainIsla: 0,

        unitPriceRivas: 0,
        unitPriceSanJorge: 0,
        unitPriceIsla: 0,

        remainingPackages: Number(addPackages || 0),
      });

      // Guardar producto (item del pedido)
      const docRef = await addDoc(collection(db, "products_candies"), {
        orderId: selectedOrder.id,
        inventoryDate: selectedOrder.date || "",

        name: baseItem.name,
        category: baseItem.category,

        providerPrice: baseItem.providerPrice,
        packages: baseItem.packages,
        unitsPerPackage: baseItem.unitsPerPackage,

        // ✅ márgenes % por producto
        marginRivas: baseItem.marginRivas,
        marginSanJorge: baseItem.marginSanJorge,
        marginIsla: baseItem.marginIsla,

        // ✅ gains en dinero (tu schema)
        gainRivas: baseItem.gainRivas,
        gainSanJorge: baseItem.gainSanJorge,
        gainIsla: baseItem.gainIsla,

        // cálculos
        subtotal: baseItem.subtotal,
        totalRivas: baseItem.totalRivas,
        totalSanJorge: baseItem.totalSanJorge,
        totalIsla: baseItem.totalIsla,
        unitPriceRivas: baseItem.unitPriceRivas,
        unitPriceSanJorge: baseItem.unitPriceSanJorge,
        unitPriceIsla: baseItem.unitPriceIsla,

        createdAt: Timestamp.now(),
      });

      const newItem: CandyOrderItem = { ...baseItem, id: docRef.id };

      const updatedItems = [newItem, ...selectedOrderItems];
      setSelectedOrderItems(updatedItems);

      const newTotals = recalcOrderTotalsFromItems(updatedItems);

      // actualizar totales del pedido
      await updateDoc(doc(db, "candy_main_orders", selectedOrder.id), {
        totalPackages: newTotals.totalPackages,
        subtotal: Number(newTotals.subtotal.toFixed(2)),
        totalRivas: Number(newTotals.totalRivas.toFixed(2)),
        totalSanJorge: Number(newTotals.totalSanJorge.toFixed(2)),
        totalIsla: Number(newTotals.totalIsla.toFixed(2)),
      });

      setSelectedOrder((prev) =>
        prev
          ? {
              ...prev,
              totalPackages: newTotals.totalPackages,
              subtotal: Number(newTotals.subtotal.toFixed(2)),
              totalRivas: Number(newTotals.totalRivas.toFixed(2)),
              totalSanJorge: Number(newTotals.totalSanJorge.toFixed(2)),
              totalIsla: Number(newTotals.totalIsla.toFixed(2)),
            }
          : prev
      );

      // limpiar inputs (como pediste)
      setAddMarginRivas(0);
      setAddMarginSJ(0);
      setAddMarginIsla(0);

      setAddName("");
      setAddCategory("");
      setAddProviderPrice(0);
      setAddPackages(0);
      setAddUnitsPerPackage(1);

      setMsg("✅ Producto agregado con márgenes por sucursal.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error agregando producto al pedido.");
    }
  };

  // ===== Abrir modal de detalle / edición =====
  const openOrderDetails = async (order: CandyOrderSummaryRow) => {
    try {
      setSelectedOrder(order);
      setSelectedOrderItems([]);
      setOpenDetailsModal(true);
      setDetailsLoading(true);
      setMsg("");

      // inventario para remaining packages por producto
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id)
        )
      );

      const remainingByProduct: Record<string, number> = {};
      invSnap.forEach((d) => {
        const x = d.data() as any;
        const productId = x.productId as string | undefined;
        if (!productId) return;

        const unitsPerPackage = Number(x.unitsPerPackage || 1) || 1;
        const remainingUnits = Number(x.remaining ?? x.totalUnits ?? 0);
        const remainingPackagesField = Number(x.remainingPackages ?? NaN);
        const remainingPackages = Number.isFinite(remainingPackagesField)
          ? Math.round(remainingPackagesField)
          : Math.round(remainingUnits / unitsPerPackage);

        remainingByProduct[productId] =
          (remainingByProduct[productId] || 0) + remainingPackages;
      });

      // productos del pedido (items)
      const snap = await getDocs(
        query(
          collection(db, "products_candies"),
          where("orderId", "==", order.id)
        )
      );

      const items: CandyOrderItem[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;

        const providerPrice = safeNumber(x.providerPrice, 0);
        const packages = safeNumber(x.packages, 0);
        const subtotalFromFields = x.subtotal ?? providerPrice * packages;

        // ✅ márgenes: si no existen en doc, fallback (gain->% o margen del pedido)
        const mR = marginFromDocOrFallback({
          margin: x.marginRivas,
          gain: x.gainRivas,
          subtotal: subtotalFromFields,
          orderMargin: order.marginRivas || 0,
        });

        const mSJ = marginFromDocOrFallback({
          margin: x.marginSanJorge,
          gain: x.gainSanJorge,
          subtotal: subtotalFromFields,
          orderMargin: order.marginSanJorge || 0,
        });

        const mI = marginFromDocOrFallback({
          margin: x.marginIsla,
          gain: x.gainIsla,
          subtotal: subtotalFromFields,
          orderMargin: order.marginIsla || 0,
        });

        const it: CandyOrderItem = recalcItemWithMargins({
          id: d.id,
          name: x.name ?? "",
          category: x.category ?? "",
          providerPrice,
          packages,
          unitsPerPackage: safeNumber(x.unitsPerPackage, 1),

          marginRivas: Number(mR || 0),
          marginSanJorge: Number(mSJ || 0),
          marginIsla: Number(mI || 0),

          subtotal: safeNumber(x.subtotal, 0),
          totalRivas: safeNumber(x.totalRivas, 0),
          totalSanJorge: safeNumber(x.totalSanJorge, 0),
          totalIsla: safeNumber(x.totalIsla, 0),

          gainRivas: safeNumber(x.gainRivas, 0),
          gainSanJorge: safeNumber(x.gainSanJorge, 0),
          gainIsla: safeNumber(x.gainIsla, 0),

          unitPriceRivas: safeNumber(x.unitPriceRivas, 0),
          unitPriceSanJorge: safeNumber(x.unitPriceSanJorge, 0),
          unitPriceIsla: safeNumber(x.unitPriceIsla, 0),

          remainingPackages:
            remainingByProduct[d.id] ?? safeNumber(x.packages, 0),
        });

        items.push(it);
      });

      setSelectedOrderItems(items);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error cargando productos del pedido.");
    } finally {
      setDetailsLoading(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Inventario Ordenes Maestras</h2>
      </div>

      {/* Filtros */}
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

        <button
          className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
          onClick={() => {
            setFromDate("");
            setToDate("");
          }}
        >
          Quitar filtro
        </button>

        <div className="ml-auto text-xs md:text-sm text-gray-600">
          Cantidad de pedidos:{" "}
          <span className="font-semibold">{totals.totalPedidos}</span>
        </div>
      </div>

      {/* Totales */}
      <div className="bg-gray-50 p-3 rounded shadow border mb-3 text-sm md:text-base">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-y-2 gap-x-8">
          <div>
            <span className="font-semibold">Paquetes totales:</span>{" "}
            {totals.totalPaquetes}
          </div>
          <div>
            <span className="font-semibold">Paquetes restantes:</span>{" "}
            {totals.totalPaquetesRestantes}
          </div>
          <div>
            <span className="font-semibold">Subtotal total:</span>{" "}
            {money(totals.totalSubtotal)}
          </div>
          <div>
            <span className="font-semibold">Total Rivas (todo):</span>{" "}
            {money(totals.totalRivas)}
          </div>
          <div>
            <span className="font-semibold">Total San Jorge (todo):</span>{" "}
            {money(totals.totalSJ)}
          </div>
          <div>
            <span className="font-semibold">Total Isla (todo):</span>{" "}
            {money(totals.totalIsla)}
          </div>
        </div>
      </div>

      {/* Tabla de pedidos */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto mt-2">
        <table className="min-w-[900px] text-xs md:text-sm">
          <thead className="bg-gray-100">
            <tr className="whitespace-nowrap">
              <th className="p-2 border">Fecha</th>
              <th className="p-2 border">Nombre</th>
              <th className="p-2 border">Paquetes totales</th>
              <th className="p-2 border">Paquetes restantes</th>
              <th className="p-2 border">Subtotal</th>
              <th className="p-2 border">Total Rivas</th>
              <th className="p-2 border">Total San Jorge</th>
              <th className="p-2 border">Total Isla</th>
              <th className="p-2 border">P. prom. Rivas</th>
              <th className="p-2 border">P. prom. San Jorge</th>
              <th className="p-2 border">P. prom. Isla</th>
              <th className="p-2 border">Acciones</th>
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Cargando…
                </td>
              </tr>
            ) : filteredOrders.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin pedidos generales en este rango.
                </td>
              </tr>
            ) : (
              filteredOrders.map((o) => {
                const avgRivas =
                  o.totalPackages > 0
                    ? Math.round(o.totalRivas / o.totalPackages)
                    : 0;
                const avgSJ =
                  o.totalPackages > 0
                    ? Math.round(o.totalSanJorge / o.totalPackages)
                    : 0;
                const avgIsla =
                  o.totalPackages > 0
                    ? Math.round(o.totalIsla / o.totalPackages)
                    : 0;

                const dateStr =
                  o.date ||
                  (o.createdAt?.toDate
                    ? o.createdAt.toDate().toISOString().slice(0, 10)
                    : "—");

                const agg = orderInventoryAgg[o.id];

                return (
                  <tr key={o.id} className="text-center whitespace-nowrap">
                    <td className="p-2 border">{dateStr}</td>
                    <td className="p-2 border">{o.name}</td>
                    <td className="p-2 border">{o.totalPackages}</td>
                    <td className="p-2 border">
                      {agg ? agg.remainingPackages : 0}
                    </td>
                    <td className="p-2 border">{o.subtotal.toFixed(2)}</td>
                    <td className="p-2 border">{o.totalRivas.toFixed(2)}</td>
                    <td className="p-2 border">{o.totalSanJorge.toFixed(2)}</td>
                    <td className="p-2 border">{o.totalIsla.toFixed(2)}</td>
                    <td className="p-2 border">{avgRivas}</td>
                    <td className="p-2 border">{avgSJ}</td>
                    <td className="p-2 border">{avgIsla}</td>
                    <td className="p-2 border">
                      <button
                        className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                        onClick={() => openOrderDetails(o)}
                      >
                        Ver pedido
                      </button>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Modal detalle / edición */}
      {openDetailsModal && selectedOrder && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-5xl max-h-[90vh] overflow-y-auto text-sm">
            <div className="flex justify-between items-center mb-3">
              <h3 className="text-xl font-bold">
                Detalle: {selectedOrder.name}
              </h3>
              <button
                className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300 text-xs"
                onClick={() => {
                  setOpenDetailsModal(false);
                  setSelectedOrder(null);
                  setSelectedOrderItems([]);
                  setMsg("");
                }}
              >
                Cerrar
              </button>
            </div>

            {/* Tarjetas resumen */}
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3 mb-4 text-xs md:text-sm">
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Fecha del pedido</div>
                <div className="font-semibold">
                  {selectedOrder.date ||
                    (selectedOrder.createdAt?.toDate
                      ? selectedOrder
                          .createdAt!.toDate()
                          .toISOString()
                          .slice(0, 10)
                      : "—")}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Paquetes totales</div>
                <div className="font-semibold">
                  {orderInventoryAgg[selectedOrder.id]?.totalPackages ??
                    selectedOrder.totalPackages}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Paquetes restantes</div>
                <div className="font-semibold">
                  {orderInventoryAgg[selectedOrder.id]?.remainingPackages ?? 0}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Subtotal (proveedor)</div>
                <div className="font-semibold">
                  {money(selectedOrder.subtotal)}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Total Rivas</div>
                <div className="font-semibold">
                  {money(selectedOrder.totalRivas)}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Total San Jorge</div>
                <div className="font-semibold">
                  {money(selectedOrder.totalSanJorge)}
                </div>
              </div>
              <div className="p-2 border rounded bg-gray-50">
                <div className="text-gray-600">Total Isla</div>
                <div className="font-semibold">
                  {money(selectedOrder.totalIsla)}
                </div>
              </div>
            </div>

            {/* Bloque agregar producto */}
            <div className="bg-white border rounded p-3 mb-4">
              <div className="font-semibold mb-2">Agregar producto</div>

              <div className="flex flex-wrap gap-2 items-end text-xs">
                <div className="flex flex-col">
                  <label className="text-gray-600">Margen Rivas</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-28 text-right"
                    value={addMarginRivas}
                    onChange={(e) =>
                      setAddMarginRivas(Number(e.target.value || 0))
                    }
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Margen SJ</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-28 text-right"
                    value={addMarginSJ}
                    onChange={(e) =>
                      setAddMarginSJ(Number(e.target.value || 0))
                    }
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Margen Isla</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-28 text-right"
                    value={addMarginIsla}
                    onChange={(e) =>
                      setAddMarginIsla(Number(e.target.value || 0))
                    }
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Producto</label>
                  <input
                    className="border rounded px-2 py-1 w-56"
                    value={addName}
                    onChange={(e) => setAddName(e.target.value)}
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Categoría</label>
                  <input
                    className="border rounded px-2 py-1 w-40"
                    value={addCategory}
                    onChange={(e) => setAddCategory(e.target.value)}
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">P. proveedor (paq)</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-32 text-right"
                    value={addProviderPrice}
                    onChange={(e) =>
                      setAddProviderPrice(Number(e.target.value || 0))
                    }
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Paquetes</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-24 text-right"
                    value={addPackages}
                    onChange={(e) =>
                      setAddPackages(Number(e.target.value || 0))
                    }
                  />
                </div>

                <div className="flex flex-col">
                  <label className="text-gray-600">Und x Paq</label>
                  <input
                    type="number"
                    className="border rounded px-2 py-1 w-24 text-right"
                    value={addUnitsPerPackage}
                    onChange={(e) =>
                      setAddUnitsPerPackage(Number(e.target.value || 1))
                    }
                  />
                </div>

                <button
                  className="px-3 py-2 rounded bg-green-600 text-white hover:bg-green-700"
                  onClick={handleAddProductToOrder}
                >
                  Agregar producto
                </button>
              </div>
            </div>

            <h4 className="font-semibold mb-2">Productos del pedido</h4>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-[1200px] text-xs md:text-sm">
                <thead className="bg-gray-100">
                  <tr className="whitespace-nowrap">
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Categoría</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">Paquetes restantes</th>
                    <th className="p-2 border">Und x Paq</th>
                    <th className="p-2 border">P. proveedor (paq)</th>

                    {/* ✅ 3 columnas de margen (editables) */}
                    <th className="p-2 border">Margen Rivas (%)</th>
                    <th className="p-2 border">Margen San Jorge (%)</th>
                    <th className="p-2 border">Margen Isla (%)</th>

                    <th className="p-2 border">Subtotal</th>
                    <th className="p-2 border">Total Rivas</th>
                    <th className="p-2 border">Total San Jorge</th>
                    <th className="p-2 border">Total Isla</th>
                    <th className="p-2 border">P. unidad Rivas</th>
                    <th className="p-2 border">P. unidad San Jorge</th>
                    <th className="p-2 border">P. unidad Isla</th>
                  </tr>
                </thead>
                <tbody>
                  {detailsLoading ? (
                    <tr>
                      <td colSpan={16} className="p-4 text-center">
                        Cargando productos…
                      </td>
                    </tr>
                  ) : selectedOrderItems.length === 0 ? (
                    <tr>
                      <td colSpan={16} className="p-4 text-center">
                        Este pedido no tiene productos registrados.
                      </td>
                    </tr>
                  ) : (
                    selectedOrderItems.map((it) => (
                      <tr key={it.id} className="text-center whitespace-nowrap">
                        <td className="p-2 border">{it.name}</td>
                        <td className="p-2 border">{it.category}</td>
                        <td className="p-2 border">{it.packages}</td>
                        <td className="p-2 border">
                          {it.remainingPackages ?? it.packages}
                        </td>
                        <td className="p-2 border">{it.unitsPerPackage}</td>
                        <td className="p-2 border">
                          {it.providerPrice.toFixed(2)}
                        </td>

                        {/* ✅ Inputs de margen */}
                        <td className="p-2 border">
                          <input
                            type="number"
                            className="w-20 border rounded px-1 py-0.5 text-right text-xs"
                            value={it.marginRivas ?? 0}
                            onChange={(e) =>
                              handleItemMarginChange(
                                it.id,
                                "marginRivas",
                                e.target.value
                              )
                            }
                          />
                        </td>
                        <td className="p-2 border">
                          <input
                            type="number"
                            className="w-20 border rounded px-1 py-0.5 text-right text-xs"
                            value={it.marginSanJorge ?? 0}
                            onChange={(e) =>
                              handleItemMarginChange(
                                it.id,
                                "marginSanJorge",
                                e.target.value
                              )
                            }
                          />
                        </td>
                        <td className="p-2 border">
                          <input
                            type="number"
                            className="w-20 border rounded px-1 py-0.5 text-right text-xs"
                            value={it.marginIsla ?? 0}
                            onChange={(e) =>
                              handleItemMarginChange(
                                it.id,
                                "marginIsla",
                                e.target.value
                              )
                            }
                          />
                        </td>

                        <td className="p-2 border">{it.subtotal.toFixed(2)}</td>
                        <td className="p-2 border">
                          {it.totalRivas.toFixed(2)}
                        </td>
                        <td className="p-2 border">
                          {it.totalSanJorge.toFixed(2)}
                        </td>
                        <td className="p-2 border">
                          {it.totalIsla.toFixed(2)}
                        </td>
                        <td className="p-2 border">{it.unitPriceRivas}</td>
                        <td className="p-2 border">{it.unitPriceSanJorge}</td>
                        <td className="p-2 border">{it.unitPriceIsla}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>

            {msg && <p className="mt-3 text-sm">{msg}</p>}
          </div>
        </div>
      )}

      {msg && !openDetailsModal && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
