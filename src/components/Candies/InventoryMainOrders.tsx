// src/components/Candies/InventoryCandyOrders.tsx
import React, { useEffect, useMemo, useState } from "react";
import {
  collection,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
} from "firebase/firestore";
import { db } from "../../firebase";
import { format, startOfMonth, endOfMonth } from "date-fns";

// Helpers
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;

interface CandyOrderSummaryRow {
  id: string; // id del doc en candy_main_orders
  name: string;
  date: string;
  totalPackages: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  marginRivas: number;
  marginSanJorge: number;
  marginIsla: number;
  createdAt: Timestamp;
}

interface CandyOrderItem {
  id: string; // id del doc en products_candies
  name: string;
  category: string;
  providerPrice: number;
  packages: number;
  unitsPerPackage: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;
  // NUEVO: paquetes restantes por producto dentro de este pedido
  remainingPackages?: number;
}

interface OrderInventoryAgg {
  orderId: string;
  totalPackages: number; // paquetes totales del pedido (según inventario)
  remainingPackages: number; // paquetes restantes (según ventas)
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

  // Modal de detalle de pedido
  const [openDetailsModal, setOpenDetailsModal] = useState(false);
  const [detailsLoading, setDetailsLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] =
    useState<CandyOrderSummaryRow | null>(null);
  const [selectedOrderItems, setSelectedOrderItems] = useState<
    CandyOrderItem[]
  >([]);

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
            marginRivas: Number(x.marginRivas ?? 20),
            marginSanJorge: Number(x.marginSanJorge ?? 15),
            marginIsla: Number(x.marginIsla ?? 30),
            createdAt: x.createdAt ?? Timestamp.now(),
          });
        });
        setOrders(ordersList);

        // Inventario de dulces para agregar por pedido (para paquetes totales / restantes)
        const qInv = query(collection(db, "inventory_candies"));
        const snapInv = await getDocs(qInv);

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
            agg[orderId] = {
              orderId,
              totalPackages: 0,
              remainingPackages: 0,
            };
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

  // ===== Totales del filtro (consolidado de pedidos) =====
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
      if (agg) {
        totalPaquetesRestantes += agg.remainingPackages;
      }
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

  // ===== Abrir modal de detalle de pedido =====
  const openOrderDetails = async (order: CandyOrderSummaryRow) => {
    try {
      setSelectedOrder(order);
      setSelectedOrderItems([]);
      setOpenDetailsModal(true);
      setDetailsLoading(true);
      setMsg("");

      // Primero, inventario de este pedido para saber paquetes restantes por producto
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

      // Luego, productos del pedido
      const snap = await getDocs(
        query(
          collection(db, "products_candies"),
          where("orderId", "==", order.id)
        )
      );

      const items: CandyOrderItem[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        items.push({
          id: d.id,
          name: x.name ?? "",
          category: x.category ?? "",
          providerPrice: Number(x.providerPrice ?? 0),
          packages: Number(x.packages ?? 0),
          unitsPerPackage: Number(x.unitsPerPackage ?? 0),
          subtotal: Number(x.subtotal ?? 0),
          totalRivas: Number(x.totalRivas ?? 0),
          totalSanJorge: Number(x.totalSanJorge ?? 0),
          totalIsla: Number(x.totalIsla ?? 0),
          unitPriceRivas: Number(x.unitPriceRivas ?? 0),
          unitPriceSanJorge: Number(x.unitPriceSanJorge ?? 0),
          unitPriceIsla: Number(x.unitPriceIsla ?? 0),
          remainingPackages: remainingByProduct[d.id] ?? x.packages ?? 0,
        });
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

      {/* Filtros (similar al inventario de dulces) */}
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

      {/* Totales tipo tarjeta (como inventario de dulces) */}
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

      {/* Tabla de pedidos (misma que CandyMainOrders) */}
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

      {/* Modal de detalle de pedido */}
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
                }}
              >
                Cerrar
              </button>
            </div>

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
                <div className="text-gray-600">
                  Paquetes restantes (según pedidos de vendedor)
                </div>
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

            <h4 className="font-semibold mb-2">Productos del pedido</h4>

            <div className="bg-white rounded border overflow-x-auto">
              <table className="min-w-[900px] text-xs md:text-sm">
                <thead className="bg-gray-100">
                  <tr className="whitespace-nowrap">
                    <th className="p-2 border">Producto</th>
                    <th className="p-2 border">Categoría</th>
                    <th className="p-2 border">Paquetes</th>
                    <th className="p-2 border">Paquetes restantes</th>
                    <th className="p-2 border">Und x Paq</th>
                    <th className="p-2 border">P. proveedor (paq)</th>
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
                      <td colSpan={13} className="p-4 text-center">
                        Cargando productos…
                      </td>
                    </tr>
                  ) : selectedOrderItems.length === 0 ? (
                    <tr>
                      <td colSpan={13} className="p-4 text-center">
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
          </div>
        </div>
      )}

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
