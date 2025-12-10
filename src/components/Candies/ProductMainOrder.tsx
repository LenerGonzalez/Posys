// src/components/Candies/CandyMainOrders.tsx
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
  deleteDoc,
} from "firebase/firestore";
import { db } from "../../firebase";
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

// Catálogo (solo para el select de categoría)
const CANDY_CATEGORIES = [
  "Caramelo",
  "Meneito",
  "Chicles",
  "Jalea",
  "Bombones",
  "Chocolate",
  "Galleta",
  "Bolsas Tematicas",
  "Bolsas Dulceras",
  "Mochilas",
  "Juguetes",
  "Platos y Vasos",
] as const;

type CandyCategory = (typeof CANDY_CATEGORIES)[number];

interface CandyOrderItem {
  id: string; // en modo edición, este es el id del doc en products_candies
  name: string;
  category: CandyCategory;
  providerPrice: number;
  packages: number;
  unitsPerPackage: number;
  subtotal: number;
  totalRivas: number;
  totalSanJorge: number;
  totalIsla: number;
  gainRivas: number;
  gainSanJorge: number;
  gainIsla: number;
  unitPriceRivas: number;
  unitPriceSanJorge: number;
  unitPriceIsla: number;
  // NUEVO: paquetes restantes por producto (según inventario)
  remainingPackages?: number;
}

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

interface OrderInventoryAgg {
  orderId: string;
  totalPackages: number;
  remainingPackages: number;
}

function roundToInt(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.round(value);
}

export default function CandyMainOrders() {
  const { refreshKey, refresh } = useManualRefresh();
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  // listado de pedidos
  const [orders, setOrders] = useState<CandyOrderSummaryRow[]>([]);
  // NUEVO: agregados de paquetes por pedido
  const [orderInventoryAgg, setOrderInventoryAgg] = useState<
    Record<string, OrderInventoryAgg>
  >({});

  // modal pedido
  const [openOrderModal, setOpenOrderModal] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);

  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>("");

  // % de ganancia por sucursal (para calcular precios)
  const [marginRivas, setMarginRivas] = useState<string>("20"); // 20% → /0.80
  const [marginSanJorge, setMarginSanJorge] = useState<string>("15"); // 15% → /0.85
  const [marginIsla, setMarginIsla] = useState<string>("30"); // 30% → /0.70

  // items del pedido
  const [orderItems, setOrderItems] = useState<CandyOrderItem[]>([]);

  // campos para agregar item (solo en nuevo pedido)
  const [orderCategory, setOrderCategory] = useState<CandyCategory>("Caramelo");
  const [orderProductName, setOrderProductName] = useState<string>("");
  const [orderProviderPrice, setOrderProviderPrice] = useState<string>("");
  const [orderPackages, setOrderPackages] = useState<string>("0");
  const [orderUnitsPerPackage, setOrderUnitsPerPackage] = useState<string>("1");

  // ==== cálculos de un item en base a los % actuales ====
  const calcOrderItemValues = (
    providerPriceNum: number,
    packagesNum: number,
    margins: { marginR: number; marginSJ: number; marginIsla: number }
  ) => {
    const subtotalCalc = providerPriceNum * packagesNum;

    const mR = Math.min(Math.max(margins.marginR, 0), 99.9) / 100;
    const mSJ = Math.min(Math.max(margins.marginSJ, 0), 99.9) / 100;
    const mIsla = Math.min(Math.max(margins.marginIsla, 0), 99.9) / 100;

    const totalR =
      packagesNum > 0 && mR < 1 ? subtotalCalc / (1 - mR) : subtotalCalc;
    const totalSJ =
      packagesNum > 0 && mSJ < 1 ? subtotalCalc / (1 - mSJ) : subtotalCalc;
    const totalIO =
      packagesNum > 0 && mIsla < 1 ? subtotalCalc / (1 - mIsla) : subtotalCalc;

    const gainR = totalR - subtotalCalc;
    const gainSJ = totalSJ - subtotalCalc;
    const gainIO = totalIO - subtotalCalc;

    const unitR = packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0;
    const unitSJ = packagesNum > 0 ? roundToInt(totalSJ / packagesNum) : 0;
    const unitIO = packagesNum > 0 ? roundToInt(totalIO / packagesNum) : 0;

    return {
      subtotal: subtotalCalc,
      totalRivas: totalR,
      totalSanJorge: totalSJ,
      totalIsla: totalIO,
      gainRivas: gainR,
      gainSanJorge: gainSJ,
      gainIsla: gainIO,
      unitPriceRivas: unitR,
      unitPriceSanJorge: unitSJ,
      unitPriceIsla: unitIO,
    };
  };

  const addItemToOrder = () => {
    setMsg("");

    if (!orderProductName.trim()) {
      setMsg("Ingresa el nombre del producto del pedido general.");
      return;
    }

    const providerPriceNum = Number(orderProviderPrice || 0);
    const packagesNum = Number(orderPackages || 0);
    const unitsNum = Number(orderUnitsPerPackage || 0);

    if (providerPriceNum < 0) {
      setMsg("El precio proveedor no puede ser negativo.");
      return;
    }
    if (packagesNum <= 0) {
      setMsg("Los paquetes del pedido general deben ser mayor que 0.");
      return;
    }
    if (unitsNum <= 0) {
      setMsg("Las unidades por paquete deben ser mayor que 0.");
      return;
    }

    const vals = calcOrderItemValues(providerPriceNum, packagesNum, {
      marginR: Number(marginRivas || 0),
      marginSJ: Number(marginSanJorge || 0),
      marginIsla: Number(marginIsla || 0),
    });

    const newItem: CandyOrderItem = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name: orderProductName.trim(),
      category: orderCategory,
      providerPrice: providerPriceNum,
      packages: packagesNum,
      unitsPerPackage: unitsNum,
      subtotal: vals.subtotal,
      totalRivas: vals.totalRivas,
      totalSanJorge: vals.totalSanJorge,
      totalIsla: vals.totalIsla,
      gainRivas: vals.gainRivas,
      gainSanJorge: vals.gainSanJorge,
      gainIsla: vals.gainIsla,
      unitPriceRivas: vals.unitPriceRivas,
      unitPriceSanJorge: vals.unitPriceSanJorge,
      unitPriceIsla: vals.unitPriceIsla,
      remainingPackages: packagesNum, // al crear, todo está disponible
    };

    setOrderItems((prev) => [...prev, newItem]);

    // limpiar campos de item
    setOrderProductName("");
    setOrderProviderPrice("");
    setOrderPackages("0");
    setOrderUnitsPerPackage("1");
  };

  const removeItemFromOrder = (id: string) => {
    setOrderItems((prev) => prev.filter((it) => it.id !== id));
  };

  const resetOrderForm = () => {
    setEditingOrderId(null);
    setOrderName("");
    setOrderDate("");
    setOrderItems([]);
    setOrderCategory("Caramelo");
    setOrderProductName("");
    setOrderProviderPrice("");
    setOrderPackages("0");
    setOrderUnitsPerPackage("1");
    setMarginRivas("20");
    setMarginSanJorge("15");
    setMarginIsla("30");
  };

  const orderSummary = useMemo(() => {
    const totalPackages = orderItems.reduce((acc, it) => acc + it.packages, 0);
    const subtotal = orderItems.reduce((acc, it) => acc + it.subtotal, 0);
    const totalRivas = orderItems.reduce((acc, it) => acc + it.totalRivas, 0);
    const totalSanJorge = orderItems.reduce(
      (acc, it) => acc + it.totalSanJorge,
      0
    );
    const totalIsla = orderItems.reduce((acc, it) => acc + it.totalIsla, 0);

    return {
      totalPackages,
      subtotal,
      totalRivas,
      totalSanJorge,
      totalIsla,
    };
  }, [orderItems]);

  // ====== CAMBIOS EN ITEMS (EDICIÓN DE PEDIDO) ======
  const handleItemFieldChange = (
    itemId: string,
    field: keyof CandyOrderItem,
    value: string
  ) => {
    setOrderItems((prev) =>
      prev.map((it) => {
        if (it.id !== itemId) return it;

        let updated: CandyOrderItem = { ...it };

        if (field === "name") {
          updated.name = value;
        } else if (field === "category") {
          updated.category = value as CandyCategory;
        } else if (field === "providerPrice") {
          updated.providerPrice = Number(value || 0);
        } else if (field === "packages") {
          updated.packages = Number(value || 0);
        } else if (field === "unitsPerPackage") {
          updated.unitsPerPackage = Number(value || 0);
        }

        // Si cambian precio proveedor o paquetes, recalculamos totales
        if (field === "providerPrice" || field === "packages") {
          const vals = calcOrderItemValues(
            updated.providerPrice,
            updated.packages,
            {
              marginR: Number(marginRivas || 0),
              marginSJ: Number(marginSanJorge || 0),
              marginIsla: Number(marginIsla || 0),
            }
          );
          updated = { ...updated, ...vals };
        }

        return updated;
      })
    );
  };

  // ====== LOAD LISTA DE PEDIDOS + agregados de paquetes ======
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
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

        // NUEVO: agregados de paquetes por pedido desde inventory_candies
        const invSnap = await getDocs(collection(db, "inventory_candies"));
        const agg: Record<string, OrderInventoryAgg> = {};

        invSnap.forEach((d) => {
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
        setMsg("❌ Error cargando pedidos generales.");
      } finally {
        setLoading(false);
      }
    })();
  }, [refreshKey]);

  // ====== GUARDAR PEDIDO GENERAL ======
  const handleSaveOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    setMsg("");

    if (!orderItems.length) {
      setMsg("Agrega al menos un producto al pedido general.");
      return;
    }

    try {
      const todayStr = new Date().toISOString().slice(0, 10);
      const dateStr = orderDate || todayStr;

      const summary = orderSummary;

      const marginR = Number(marginRivas || 0);
      const marginSJ = Number(marginSanJorge || 0);
      const marginI = Number(marginIsla || 0);

      if (editingOrderId) {
        // Validar items antes de guardar
        for (const it of orderItems) {
          if (!it.name.trim()) {
            setMsg("Hay un producto sin nombre en el pedido.");
            return;
          }
          if (it.providerPrice < 0) {
            setMsg(
              `El precio proveedor no puede ser negativo (producto: ${it.name}).`
            );
            return;
          }
          if (it.packages <= 0) {
            setMsg(
              `Los paquetes deben ser mayor que 0 (producto: ${it.name}).`
            );
            return;
          }
          if (it.unitsPerPackage <= 0) {
            setMsg(
              `Las unidades por paquete deben ser mayor que 0 (producto: ${it.name}).`
            );
            return;
          }
        }

        // Actualizar cabecera
        await updateDoc(doc(db, "candy_main_orders", editingOrderId), {
          name: orderName || `Pedido ${editingOrderId}`,
          date: dateStr,
          totalPackages: summary.totalPackages,
          subtotal: summary.subtotal,
          totalRivas: summary.totalRivas,
          totalSanJorge: summary.totalSanJorge,
          totalIsla: summary.totalIsla,
          marginRivas: marginR,
          marginSanJorge: marginSJ,
          marginIsla: marginI,
        });

        // Actualizar productos e inventarios de este pedido
        for (const it of orderItems) {
          const productUpdate = {
            name: it.name.trim(),
            category: it.category,
            providerPrice: it.providerPrice,
            packages: it.packages,
            unitsPerPackage: it.unitsPerPackage,
            subtotal: it.subtotal,
            totalRivas: it.totalRivas,
            totalSanJorge: it.totalSanJorge,
            totalIsla: it.totalIsla,
            gainRivas: it.gainRivas,
            gainSanJorge: it.gainSanJorge,
            gainIsla: it.gainIsla,
            unitPriceRivas: it.unitPriceRivas,
            unitPriceSanJorge: it.unitPriceSanJorge,
            unitPriceIsla: it.unitPriceIsla,
            inventoryDate: dateStr,
          };

          // it.id = id del producto en products_candies
          await updateDoc(doc(db, "products_candies", it.id), productUpdate);

          // Buscar inventario asociado a este producto y pedido
          const invSnap = await getDocs(
            query(
              collection(db, "inventory_candies"),
              where("orderId", "==", editingOrderId),
              where("productId", "==", it.id)
            )
          );

          const newTotalUnits = it.packages * it.unitsPerPackage;

          for (const invDoc of invSnap.docs) {
            const data = invDoc.data() as any;
            const oldTotalUnits = Number(data.totalUnits ?? 0);
            const oldQuantity = Number(data.quantity ?? oldTotalUnits);
            const oldRemaining = Number(data.remaining ?? oldTotalUnits);

            const deltaUnits = newTotalUnits - oldTotalUnits;
            const newQuantity = Math.max(0, oldQuantity + deltaUnits);
            const newRemaining = Math.max(0, oldRemaining + deltaUnits);

            const unitsPerPackageLocal =
              Number(data.unitsPerPackage || it.unitsPerPackage || 1) || 1;
            const newRemainingPackages = Math.round(
              newRemaining / unitsPerPackageLocal
            );

            await updateDoc(doc(db, "inventory_candies", invDoc.id), {
              productName: it.name.trim(),
              category: it.category,
              quantity: newQuantity,
              remaining: newRemaining,
              packages: newRemainingPackages,
              remainingPackages: newRemainingPackages,
              unitsPerPackage: it.unitsPerPackage,
              totalUnits: newTotalUnits,
              providerPrice: it.providerPrice,
              subtotal: it.subtotal,
              totalRivas: it.totalRivas,
              totalSanJorge: it.totalSanJorge,
              totalIsla: it.totalIsla,
              gainRivas: it.gainRivas,
              gainSanJorge: it.gainSanJorge,
              gainIsla: it.gainIsla,
              unitPriceRivas: it.unitPriceRivas,
              unitPriceSanJorge: it.unitPriceSanJorge,
              unitPriceIsla: it.unitPriceIsla,
              date: dateStr,
            });
          }
        }

        // Refrescar resumen en la tabla de pedidos
        setOrders((prev) =>
          prev.map((o) =>
            o.id === editingOrderId
              ? {
                  ...o,
                  name: orderName || `Pedido ${editingOrderId}`,
                  date: dateStr,
                  totalPackages: summary.totalPackages,
                  subtotal: summary.subtotal,
                  totalRivas: summary.totalRivas,
                  totalSanJorge: summary.totalSanJorge,
                  totalIsla: summary.totalIsla,
                  marginRivas: marginR,
                  marginSanJorge: marginSJ,
                  marginIsla: marginI,
                }
              : o
          )
        );

        setMsg("✅ Pedido general actualizado (productos e inventario).");
      } else {
        // crear nuevo pedido
        const header = {
          name: orderName || `Pedido ${todayStr}`,
          date: dateStr,
          totalPackages: summary.totalPackages,
          subtotal: summary.subtotal,
          totalRivas: summary.totalRivas,
          totalSanJorge: summary.totalSanJorge,
          totalIsla: summary.totalIsla,
          marginRivas: marginR,
          marginSanJorge: marginSJ,
          marginIsla: marginI,
          createdAt: Timestamp.now(),
        };

        const orderRef = await addDoc(
          collection(db, "candy_main_orders"),
          header
        );
        const orderId = orderRef.id;

        // por cada item: crear producto + inventario, marcando orderId
        for (const it of orderItems) {
          const productDoc = {
            name: it.name,
            category: it.category,
            providerPrice: it.providerPrice,
            packages: it.packages,
            unitsPerPackage: it.unitsPerPackage,
            subtotal: it.subtotal,
            totalRivas: it.totalRivas,
            totalSanJorge: it.totalSanJorge,
            totalIsla: it.totalIsla,
            gainRivas: it.gainRivas,
            gainSanJorge: it.gainSanJorge,
            gainIsla: it.gainIsla,
            unitPriceRivas: it.unitPriceRivas,
            unitPriceSanJorge: it.unitPriceSanJorge,
            unitPriceIsla: it.unitPriceIsla,
            inventoryDate: dateStr,
            createdAt: Timestamp.now(),
            orderId,
          };

          const prodRef = await addDoc(
            collection(db, "products_candies"),
            productDoc
          );

          if (it.packages > 0) {
            const totalUnits = it.packages * it.unitsPerPackage;

            await addDoc(collection(db, "inventory_candies"), {
              productId: prodRef.id,
              productName: it.name,
              category: it.category,
              measurement: "unidad",
              quantity: totalUnits,
              remaining: totalUnits,
              packages: it.packages,
              remainingPackages: it.packages,
              unitsPerPackage: it.unitsPerPackage,
              totalUnits,
              providerPrice: it.providerPrice,
              subtotal: it.subtotal,
              totalRivas: it.totalRivas,
              totalSanJorge: it.totalSanJorge,
              totalIsla: it.totalIsla,
              gainRivas: it.gainRivas,
              gainSanJorge: it.gainSanJorge,
              gainIsla: it.gainIsla,
              unitPriceRivas: it.unitPriceRivas,
              unitPriceSanJorge: it.unitPriceSanJorge,
              unitPriceIsla: it.unitPriceIsla,
              date: dateStr,
              createdAt: Timestamp.now(),
              status: "PENDIENTE",
              orderId,
            });
          }
        }

        setOrders((prev) => [
          {
            id: orderId,
            name: header.name,
            date: header.date,
            totalPackages: header.totalPackages,
            subtotal: header.subtotal,
            totalRivas: header.totalRivas,
            totalSanJorge: header.totalSanJorge,
            totalIsla: header.totalIsla,
            marginRivas: header.marginRivas,
            marginSanJorge: header.marginSanJorge,
            marginIsla: header.marginIsla,
            createdAt: header.createdAt,
          },
          ...prev,
        ]);

        setMsg("✅ Pedido general creado y registrado en inventario.");
      }

      resetOrderForm();
      setOpenOrderModal(false);
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar pedido general.");
    }
  };

  // ====== ABRIR PEDIDO PARA VER / EDITAR ======
  const openOrderForEdit = async (order: CandyOrderSummaryRow) => {
    try {
      setLoading(true);
      setEditingOrderId(order.id);
      setOrderName(order.name);
      setOrderDate(order.date);
      setMarginRivas(String(order.marginRivas ?? 20));
      setMarginSanJorge(String(order.marginSanJorge ?? 15));
      setMarginIsla(String(order.marginIsla ?? 30));

      // Inventario de este pedido para saber paquetes restantes por producto
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
          id: d.id, // importante: aquí usamos el id del producto
          name: x.name ?? "",
          category: (x.category as CandyCategory) ?? "Caramelo",
          providerPrice: Number(x.providerPrice ?? 0),
          packages: Number(x.packages ?? 0),
          unitsPerPackage: Number(x.unitsPerPackage ?? 0),
          subtotal: Number(x.subtotal ?? 0),
          totalRivas: Number(x.totalRivas ?? 0),
          totalSanJorge: Number(x.totalSanJorge ?? 0),
          totalIsla: Number(x.totalIsla ?? 0),
          gainRivas: Number(x.gainRivas ?? 0),
          gainSanJorge: Number(x.gainSanJorge ?? 0),
          gainIsla: Number(x.gainIsla ?? 0),
          unitPriceRivas: Number(x.unitPriceRivas ?? 0),
          unitPriceSanJorge: Number(x.unitPriceSanJorge ?? 0),
          unitPriceIsla: Number(x.unitPriceIsla ?? 0),
          remainingPackages: remainingByProduct[d.id] ?? x.packages ?? 0,
        });
      });
      setOrderItems(items);
      setOpenOrderModal(true);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al abrir pedido general.");
    } finally {
      setLoading(false);
    }
  };

  // ====== ELIMINAR PEDIDO GENERAL (Y SUS PRODUCTOS/INVENTARIOS) ======
  const handleDeleteOrder = async (order: CandyOrderSummaryRow) => {
    const ok = confirm(
      `¿Eliminar el pedido "${order.name}" y todo su inventario asociado?`
    );
    if (!ok) return;
    setMsg("");

    try {
      // borrar productos ligados al pedido
      const prodSnap = await getDocs(
        query(
          collection(db, "products_candies"),
          where("orderId", "==", order.id)
        )
      );
      for (const d of prodSnap.docs) {
        await deleteDoc(doc(db, "products_candies", d.id));
      }

      // borrar inventarios ligados al pedido
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id)
        )
      );
      for (const d of invSnap.docs) {
        await deleteDoc(doc(db, "inventory_candies", d.id));
      }

      // borrar cabecera del pedido
      await deleteDoc(doc(db, "candy_main_orders", order.id));

      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setMsg("✅ Pedido general eliminado.");
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar pedido general.");
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Ordenes Maestras</h2>
        <div className="flex gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
          <button
            className="inline-flex items-center gap-2 bg-indigo-600 text-white px-3 py-2 rounded hover:bg-indigo-700"
            onClick={() => {
              resetOrderForm();
              setOpenOrderModal(true);
            }}
          >
            <span className="inline-block bg-indigo-700/40 rounded-full p-1">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                className="h-4 w-4"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  strokeWidth={2}
                  d="M12 4v16m8-8H4"
                />
              </svg>
            </span>
            Nueva Orden
          </button>
        </div>
      </div>

      {/* MODAL PEDIDO GENERAL */}
      {openOrderModal && (
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50">
          <div className="bg-white p-6 rounded shadow-lg w-full max-w-5xl max-h-[90vh] overflow-y-auto text-sm">
            <h3 className="text-xl font-bold mb-4">
              {editingOrderId
                ? "Editar Orden Maestra"
                : "Nueva Orden Maestra"}
            </h3>

            <form onSubmit={handleSaveOrder} className="space-y-4">
              {/* header de pedido */}
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="md:col-span-2">
                  <label className="block text-sm font-semibold">
                    Nombre de Orden
                  </label>
                  <input
                    className="w-full border p-2 rounded"
                    value={orderName}
                    onChange={(e) => setOrderName(e.target.value)}
                    placeholder="Ej: Pedido diciembre 01"
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    Fecha del pedido
                  </label>
                  <input
                    type="date"
                    className="w-full border p-2 rounded"
                    value={orderDate}
                    onChange={(e) => setOrderDate(e.target.value)}
                  />
                </div>

                {/* % de ganancia por sucursal */}
                <div>
                  <label className="block text-sm font-semibold">
                    % Ganancia Rivas
                  </label>
                  <input
                    type="number"
                    className="w-full border p-2 rounded"
                    value={marginRivas}
                    onChange={(e) => setMarginRivas(e.target.value)}
                    disabled={!!editingOrderId}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    % Ganancia San Jorge
                  </label>
                  <input
                    type="number"
                    className="w-full border p-2 rounded"
                    value={marginSanJorge}
                    onChange={(e) => setMarginSanJorge(e.target.value)}
                    disabled={!!editingOrderId}
                  />
                </div>
                <div>
                  <label className="block text-sm font-semibold">
                    % Ganancia Isla Ometepe
                  </label>
                  <input
                    type="number"
                    className="w-full border p-2 rounded"
                    value={marginIsla}
                    onChange={(e) => setMarginIsla(e.target.value)}
                    disabled={!!editingOrderId}
                  />
                </div>
              </div>

              {/* sección agregar productos al pedido (solo en nuevo) */}
              {!editingOrderId && (
                <div className="border rounded p-3 bg-gray-50">
                  <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                    <div>
                      <label className="block text-sm font-semibold">
                        Categoría
                      </label>
                      <select
                        className="w-full border p-2 rounded"
                        value={orderCategory}
                        onChange={(e) =>
                          setOrderCategory(e.target.value as CandyCategory)
                        }
                      >
                        {CANDY_CATEGORIES.map((c) => (
                          <option key={c} value={c}>
                            {c}
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="md:col-span-2">
                      <label className="block text-sm font-semibold">
                        Producto
                      </label>
                      <input
                        className="w-full border p-2 rounded"
                        value={orderProductName}
                        onChange={(e) => setOrderProductName(e.target.value)}
                        placeholder="Ej: Chicles menta"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">
                        Precio proveedor (paq)
                      </label>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        className="w-full border p-2 rounded"
                        value={orderProviderPrice}
                        onChange={(e) => setOrderProviderPrice(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">
                        Paquetes
                      </label>
                      <input
                        type="number"
                        min={0}
                        className="w-full border p-2 rounded"
                        value={orderPackages}
                        onChange={(e) => setOrderPackages(e.target.value)}
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-semibold">
                        Unidades por paquete
                      </label>
                      <input
                        type="number"
                        min={1}
                        className="w-full border p-2 rounded"
                        value={orderUnitsPerPackage}
                        onChange={(e) =>
                          setOrderUnitsPerPackage(e.target.value)
                        }
                      />
                    </div>
                  </div>
                  <div className="flex justify-end mt-3">
                    <button
                      type="button"
                      onClick={addItemToOrder}
                      className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Agregar producto al pedido
                    </button>
                  </div>
                </div>
              )}

              {/* tabla de productos del pedido */}
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
                      {!editingOrderId && (
                        <th className="p-2 border">Acciones</th>
                      )}
                    </tr>
                  </thead>
                  <tbody>
                    {orderItems.length === 0 ? (
                      <tr>
                        <td
                          colSpan={editingOrderId ? 13 : 14}
                          className="p-4 text-center text-gray-500"
                        >
                          No hay productos en este pedido.
                        </td>
                      </tr>
                    ) : (
                      orderItems.map((it) => (
                        <tr
                          key={it.id}
                          className="text-center whitespace-nowrap"
                        >
                          {/* Producto */}
                          <td className="p-2 border">
                            {editingOrderId ? (
                              <input
                                className="w-full border p-1 rounded"
                                value={it.name}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "name",
                                    e.target.value
                                  )
                                }
                              />
                            ) : (
                              it.name
                            )}
                          </td>

                          {/* Categoría */}
                          <td className="p-2 border">
                            {editingOrderId ? (
                              <select
                                className="w-full border p-1 rounded"
                                value={it.category}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "category",
                                    e.target.value
                                  )
                                }
                              >
                                {CANDY_CATEGORIES.map((c) => (
                                  <option key={c} value={c}>
                                    {c}
                                  </option>
                                ))}
                              </select>
                            ) : (
                              it.category
                            )}
                          </td>

                          {/* Paquetes */}
                          <td className="p-2 border">
                            {editingOrderId ? (
                              <input
                                type="number"
                                className="w-full border p-1 rounded text-right"
                                value={it.packages}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "packages",
                                    e.target.value
                                  )
                                }
                              />
                            ) : (
                              it.packages
                            )}
                          </td>

                          {/* Paquetes restantes (solo lectura) */}
                          <td className="p-2 border">
                            {it.remainingPackages ?? it.packages}
                          </td>

                          {/* Und x Paq */}
                          <td className="p-2 border">
                            {editingOrderId ? (
                              <input
                                type="number"
                                className="w-full border p-1 rounded text-right"
                                value={it.unitsPerPackage}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "unitsPerPackage",
                                    e.target.value
                                  )
                                }
                              />
                            ) : (
                              it.unitsPerPackage
                            )}
                          </td>

                          {/* P. proveedor */}
                          <td className="p-2 border">
                            {editingOrderId ? (
                              <input
                                type="number"
                                step="0.01"
                                className="w-full border p-1 rounded text-right"
                                value={it.providerPrice}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "providerPrice",
                                    e.target.value
                                  )
                                }
                              />
                            ) : (
                              it.providerPrice.toFixed(2)
                            )}
                          </td>

                          {/* Subtotal */}
                          <td className="p-2 border">
                            {it.subtotal.toFixed(2)}
                          </td>

                          {/* Totales */}
                          <td className="p-2 border">
                            {it.totalRivas.toFixed(2)}
                          </td>
                          <td className="p-2 border">
                            {it.totalSanJorge.toFixed(2)}
                          </td>
                          <td className="p-2 border">
                            {it.totalIsla.toFixed(2)}
                          </td>

                          {/* P. unidad */}
                          <td className="p-2 border">{it.unitPriceRivas}</td>
                          <td className="p-2 border">{it.unitPriceSanJorge}</td>
                          <td className="p-2 border">{it.unitPriceIsla}</td>

                          {!editingOrderId && (
                            <td className="p-2 border">
                              <button
                                type="button"
                                className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                                onClick={() => removeItemFromOrder(it.id)}
                              >
                                Quitar
                              </button>
                            </td>
                          )}
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              {/* resumen del pedido */}
              <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Paquetes totales del pedido
                  </div>
                  <div className="text-lg font-semibold">
                    {orderSummary.totalPackages}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Subtotal costo (proveedor)
                  </div>
                  <div className="text-lg font-semibold">
                    {orderSummary.subtotal.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total Rivas (pedido)
                  </div>
                  <div className="text-lg font-semibold">
                    {orderSummary.totalRivas.toFixed(2)}
                  </div>
                </div>
                <div className="p-3 border rounded bg-gray-50">
                  <div className="text-xs text-gray-600">
                    Total San Jorge / Isla
                  </div>
                  <div className="text-sm font-semibold">
                    SJ: {orderSummary.totalSanJorge.toFixed(2)}
                    <br />
                    Isla: {orderSummary.totalIsla.toFixed(2)}
                  </div>
                </div>
              </div>

              {/* botones */}
              <div className="flex justify-end gap-2 mt-4">
                <button
                  type="button"
                  onClick={resetOrderForm}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Limpiar pedido
                </button>
                <button
                  type="button"
                  onClick={() => {
                    resetOrderForm();
                    setOpenOrderModal(false);
                  }}
                  className="px-3 py-1 rounded bg-gray-200 hover:bg-gray-300"
                >
                  Cerrar
                </button>
                <button
                  type="submit"
                  className="px-3 py-1 rounded bg-blue-600 text-white hover:bg-blue-700"
                  disabled={orderItems.length === 0}
                >
                  Guardar pedido
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LISTADO DE PEDIDOS GENERALES */}
      <div className="bg-white p-2 rounded shadow border w-full overflow-x-auto mt-4">
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
            ) : orders.length === 0 ? (
              <tr>
                <td colSpan={12} className="p-4 text-center">
                  Sin pedidos generales.
                </td>
              </tr>
            ) : (
              orders.map((o) => {
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

                const agg = orderInventoryAgg[o.id];

                return (
                  <tr key={o.id} className="text-center whitespace-nowrap">
                    <td className="p-2 border">
                      {o.date ||
                        (o.createdAt?.toDate
                          ? o.createdAt.toDate().toISOString().slice(0, 10)
                          : "—")}
                    </td>
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
                      <div className="flex gap-1 justify-center">
                        <button
                          className="px-2 py-1 rounded bg-blue-600 text-white hover:bg-blue-700 text-xs"
                          onClick={() => openOrderForEdit(o)}
                        >
                          Ver / Editar
                        </button>
                        <button
                          className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                          onClick={() => handleDeleteOrder(o)}
                        >
                          Borrar
                        </button>
                      </div>
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
