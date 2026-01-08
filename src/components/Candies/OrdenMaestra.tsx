import React, { useEffect, useMemo, useState } from "react";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  updateDoc,
  where,
  deleteDoc,
  writeBatch,
} from "firebase/firestore";
import { db } from "../../firebase";
import RefreshButton from "../common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";

function roundToInt(value: number): number {
  if (!isFinite(value)) return 0;
  return Math.round(value);
}

// ✅ Ahora category es string (porque viene de Firestore, y puede traer nuevas)
type CatalogCandyProduct = {
  id: string; // doc id en products_candies (CATÁLOGO)
  name: string;
  category: string;
  providerPrice: number; // precio base en catálogo (por paquete)
  unitsPerPackage: number; // und x paquete base en catálogo
};

interface CandyOrderItem {
  id: string; // productId (catalog)
  name: string;
  category: string;

  providerPrice: number; // tomado de catálogo
  packages: number;
  unitsPerPackage: number;

  marginRivas: number;
  marginSanJorge: number;
  marginIsla: number;

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

type CandyMainOrderDoc = {
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
  items: CandyOrderItem[];
};

// Helpers consistentes con inventory_candies.ts / InventoryCandyBatches
function safeInt(n: any): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.floor(x);
}

function getBaseUnitsFromInvDoc(data: any): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = safeInt(data.totalUnits || 0);
  const quantity = safeInt(data.quantity || 0);
  const packages = safeInt(data.packages || 0);

  if (totalUnits > 0) return totalUnits;
  if (quantity > 0) return quantity;
  if (packages > 0) return packages * unitsPerPackage;
  return 0;
}

function getRemainingUnitsFromInvDoc(data: any): number {
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.floor(remainingField);
  }
  return getBaseUnitsFromInvDoc(data);
}

function getRemainingPackagesFromInvDoc(data: any): number {
  const rp = Number(data.remainingPackages);
  if (Number.isFinite(rp)) return Math.max(0, Math.floor(rp));

  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const remainingUnits = getRemainingUnitsFromInvDoc(data);
  return Math.max(0, Math.floor(remainingUnits / unitsPerPackage));
}

function getInitialPackagesFromInvDoc(data: any): number {
  const unitsPerPackage = Math.max(1, safeInt(data.unitsPerPackage || 1));
  const totalUnits = getBaseUnitsFromInvDoc(data);
  return Math.max(0, Math.floor(totalUnits / unitsPerPackage));
}

type MobileTab = "DATOS" | "AGREGAR" | "ITEMS" | "TOTALES";

export default function CandyMainOrders() {
  const { refreshKey, refresh } = useManualRefresh();
  const [msg, setMsg] = useState("");
  const [loading, setLoading] = useState(true);

  // ====== CATÁLOGO (products_candies) ======
  const [catalog, setCatalog] = useState<CatalogCandyProduct[]>([]);
  const [catalogLoading, setCatalogLoading] = useState(false);

  // listado de pedidos
  const [orders, setOrders] = useState<CandyOrderSummaryRow[]>([]);
  // agregados de paquetes por pedido
  const [orderInventoryAgg, setOrderInventoryAgg] = useState<
    Record<string, OrderInventoryAgg>
  >({});

  // modal pedido
  const [openOrderModal, setOpenOrderModal] = useState(false);
  const [editingOrderId, setEditingOrderId] = useState<string | null>(null);

  const [orderName, setOrderName] = useState<string>("");
  const [orderDate, setOrderDate] = useState<string>("");

  // % de ganancia por sucursal
  const [marginRivas, setMarginRivas] = useState<string>("20");
  const [marginSanJorge, setMarginSanJorge] = useState<string>("15");
  const [marginIsla, setMarginIsla] = useState<string>("30");

  // items del pedido
  const [orderItems, setOrderItems] = useState<CandyOrderItem[]>([]);

  // ✅ categoría seleccionada viene del catálogo, no de array quemado
  const [orderCategory, setOrderCategory] = useState<string>("");

  // ahora se selecciona producto del CATÁLOGO
  const [orderProductId, setOrderProductId] = useState<string>("");

  // auto-llenados desde catálogo (solo lectura)
  const [orderProviderPrice, setOrderProviderPrice] = useState<string>("");
  const [orderUnitsPerPackage, setOrderUnitsPerPackage] = useState<string>("1");
  const [orderPackages, setOrderPackages] = useState<string>("0");

  // ===== Tabs (solo móvil) =====
  const [mobileTab, setMobileTab] = useState<MobileTab>("DATOS");

  // ==== categorías dinámicas desde catálogo ====
  const catalogCategories = useMemo(() => {
    const set = new Set<string>();
    for (const p of catalog) {
      const c = String(p.category || "").trim();
      if (c) set.add(c);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b, "es"));
  }, [catalog]);

  // si todavía no hay category elegida, escoger la primera disponible
  useEffect(() => {
    if (!orderCategory && catalogCategories.length > 0) {
      setOrderCategory(catalogCategories[0]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [catalogCategories]);

  // ==== cálculos de un item en base a márgenes ====
  const calcOrderItemValues = (
    providerPriceNum: number,
    packagesNum: number,
    margins: { marginR: number; marginSJ: number; marginIsla: number }
  ) => {
    const subtotalCalc = providerPriceNum * packagesNum;

    const mR = Math.min(Math.max(margins.marginR, 0), 99.9) / 100;
    const mSJ = Math.min(Math.max(margins.marginSJ, 0), 99.9) / 100;
    const mIsla = Math.min(Math.max(margins.marginIsla, 0), 99.9) / 100;

    // Respeto tu lógica: total = subtotal / (1 - margen)
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

  const resetOrderForm = () => {
    setEditingOrderId(null);
    setOrderName("");
    setOrderDate("");
    setOrderItems([]);

    // ✅ category ahora se recalcula con el catálogo
    setOrderCategory(catalogCategories[0] || "");
    setOrderProductId("");
    setOrderProviderPrice("");
    setOrderPackages("0");
    setOrderUnitsPerPackage("1");

    setMarginRivas("20");
    setMarginSanJorge("15");
    setMarginIsla("30");

    setMobileTab("DATOS");
  };

  // ===== Cargar catálogo =====
  const loadCatalog = async () => {
    setCatalogLoading(true);
    try {
      const snap = await getDocs(
        query(collection(db, "products_candies"), orderBy("createdAt", "desc"))
      );
      const list: CatalogCandyProduct[] = [];
      snap.forEach((d) => {
        const x = d.data() as any;
        list.push({
          id: d.id,
          name: String(x.name ?? "").trim(),
          category: String(x.category ?? "").trim() || "Caramelo",
          providerPrice: Number(x.providerPrice ?? 0),
          unitsPerPackage: Number(x.unitsPerPackage ?? 1),
        });
      });
      setCatalog(list);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error cargando catálogo de dulces.");
    } finally {
      setCatalogLoading(false);
    }
  };

  useEffect(() => {
    loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // productos disponibles para categoría seleccionada (nuevo pedido)
  const catalogByCategory = useMemo(() => {
    const list =
      orderCategory.trim().length > 0
        ? catalog.filter((p) => p.category === orderCategory)
        : catalog;

    return list.sort((a, b) => a.name.localeCompare(b.name, "es"));
  }, [catalog, orderCategory]);

  // al seleccionar producto, auto-llenar datos
  useEffect(() => {
    if (!orderProductId) {
      setOrderProviderPrice("");
      setOrderUnitsPerPackage("1");
      return;
    }
    const p = catalog.find((x) => x.id === orderProductId);
    if (!p) return;
    setOrderProviderPrice(String(p.providerPrice ?? 0));
    setOrderUnitsPerPackage(String(p.unitsPerPackage ?? 1));
  }, [orderProductId, catalog]);

  const addItemToOrder = () => {
    setMsg("");

    if (!orderProductId) {
      setMsg("Selecciona un producto del catálogo.");
      return;
    }

    const catProd = catalog.find((x) => x.id === orderProductId);
    if (!catProd) {
      setMsg("Producto de catálogo no encontrado (refresca).");
      return;
    }

    const providerPriceNum = Number(catProd.providerPrice || 0);
    const packagesNum = safeInt(orderPackages || 0);
    const unitsNum = safeInt(catProd.unitsPerPackage || 0);

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

    const mR = Number(marginRivas || 0);
    const mSJ = Number(marginSanJorge || 0);
    const mI = Number(marginIsla || 0);

    // si ya existe ese producto en la orden, sumamos paquetes
    const existing = orderItems.find((it) => it.id === catProd.id);
    if (existing) {
      setOrderItems((prev) =>
        prev.map((it) => {
          if (it.id !== catProd.id) return it;
          const newPackages = safeInt(it.packages || 0) + packagesNum;

          const newVals = calcOrderItemValues(providerPriceNum, newPackages, {
            marginR: Number(it.marginRivas || mR),
            marginSJ: Number(it.marginSanJorge || mSJ),
            marginIsla: Number(it.marginIsla || mI),
          });

          return {
            ...it,
            providerPrice: providerPriceNum,
            unitsPerPackage: unitsNum,
            packages: newPackages,
            remainingPackages:
              safeInt(it.remainingPackages ?? it.packages) + packagesNum,
            ...newVals,
          };
        })
      );
    } else {
      const vals = calcOrderItemValues(providerPriceNum, packagesNum, {
        marginR: mR,
        marginSJ: mSJ,
        marginIsla: mI,
      });

      const newItem: CandyOrderItem = {
        id: catProd.id,
        name: catProd.name,
        category: catProd.category,

        providerPrice: providerPriceNum,
        packages: packagesNum,
        unitsPerPackage: unitsNum,

        marginRivas: mR,
        marginSanJorge: mSJ,
        marginIsla: mI,

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

        remainingPackages: packagesNum,
      };

      setOrderItems((prev) => [...prev, newItem]);
    }

    setOrderProductId("");
    setOrderPackages("0");

    // ✅ UX móvil: después de agregar, ir a items
    setMobileTab("ITEMS");
  };

  const removeItemFromOrder = (id: string) => {
    setOrderItems((prev) => prev.filter((it) => it.id !== id));
  };

  const orderSummary = useMemo(() => {
    const totalPackages = orderItems.reduce(
      (acc, it) => acc + safeInt(it.packages),
      0
    );
    const subtotal = orderItems.reduce(
      (acc, it) => acc + Number(it.subtotal || 0),
      0
    );
    const totalRivas = orderItems.reduce(
      (acc, it) => acc + Number(it.totalRivas || 0),
      0
    );
    const totalSanJorge = orderItems.reduce(
      (acc, it) => acc + Number(it.totalSanJorge || 0),
      0
    );
    const totalIsla = orderItems.reduce(
      (acc, it) => acc + Number(it.totalIsla || 0),
      0
    );

    return { totalPackages, subtotal, totalRivas, totalSanJorge, totalIsla };
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

        if (field === "packages") updated.packages = safeInt(value || 0);
        if (field === "unitsPerPackage")
          updated.unitsPerPackage = safeInt(value || 0);
        if (field === "marginRivas") updated.marginRivas = Number(value || 0);
        if (field === "marginSanJorge")
          updated.marginSanJorge = Number(value || 0);
        if (field === "marginIsla") updated.marginIsla = Number(value || 0);

        if (
          field === "packages" ||
          field === "marginRivas" ||
          field === "marginSanJorge" ||
          field === "marginIsla"
        ) {
          const vals = calcOrderItemValues(
            updated.providerPrice,
            updated.packages,
            {
              marginR: Number(updated.marginRivas || 0),
              marginSJ: Number(updated.marginSanJorge || 0),
              marginIsla: Number(updated.marginIsla || 0),
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

        // agregados por orden desde inventory_candies (consistente)
        const invSnap = await getDocs(collection(db, "inventory_candies"));
        const agg: Record<string, OrderInventoryAgg> = {};

        invSnap.forEach((d) => {
          const x = d.data() as any;
          const orderId = x.orderId as string | undefined;
          if (!orderId) return;

          const totalPackages = getInitialPackagesFromInvDoc(x);
          const remainingPackages = getRemainingPackagesFromInvDoc(x);

          if (!agg[orderId]) {
            agg[orderId] = { orderId, totalPackages: 0, remainingPackages: 0 };
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
          setMsg(`Los paquetes deben ser mayor que 0 (producto: ${it.name}).`);
          return;
        }
        if (it.unitsPerPackage <= 0) {
          setMsg(
            `Las unidades por paquete deben ser mayor que 0 (producto: ${it.name}).`
          );
          return;
        }
      }

      const header: Omit<CandyMainOrderDoc, "createdAt"> & {
        createdAt?: Timestamp;
      } = {
        name: orderName || `Pedido ${dateStr}`,
        date: dateStr,
        totalPackages: summary.totalPackages,
        subtotal: summary.subtotal,
        totalRivas: summary.totalRivas,
        totalSanJorge: summary.totalSanJorge,
        totalIsla: summary.totalIsla,
        marginRivas: marginR,
        marginSanJorge: marginSJ,
        marginIsla: marginI,
        items: orderItems,
      };

      if (editingOrderId) {
        // actualizar pedido
        await updateDoc(doc(db, "candy_main_orders", editingOrderId), {
          ...header,
        });

        // upsert inventario por (orderId, productId)
        for (const it of orderItems) {
          const invSnap = await getDocs(
            query(
              collection(db, "inventory_candies"),
              where("orderId", "==", editingOrderId),
              where("productId", "==", it.id)
            )
          );

          const totalUnitsNew =
            safeInt(it.packages) * safeInt(it.unitsPerPackage);
          const unitsPerPackageLocal = Math.max(
            1,
            safeInt(it.unitsPerPackage || 1)
          );

          if (invSnap.empty) {
            await addDoc(collection(db, "inventory_candies"), {
              productId: it.id,
              productName: it.name,
              category: it.category,
              measurement: "unidad",

              quantity: totalUnitsNew,
              remaining: totalUnitsNew,
              packages: safeInt(it.packages),
              remainingPackages: safeInt(it.packages),
              unitsPerPackage: unitsPerPackageLocal,
              totalUnits: totalUnitsNew,

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
              orderId: editingOrderId,
            });
          } else {
            for (const invDoc of invSnap.docs) {
              const data = invDoc.data() as any;

              const oldTotalUnits = safeInt(data.totalUnits ?? 0);
              const oldRemaining = safeInt(data.remaining ?? oldTotalUnits);

              const deltaUnits = totalUnitsNew - oldTotalUnits;
              const newRemaining = Math.max(0, oldRemaining + deltaUnits);

              const newRemainingPackages = Math.max(
                0,
                Math.floor(newRemaining / unitsPerPackageLocal)
              );

              await updateDoc(doc(db, "inventory_candies", invDoc.id), {
                productName: it.name,
                category: it.category,

                unitsPerPackage: unitsPerPackageLocal,
                totalUnits: totalUnitsNew,
                quantity: totalUnitsNew,
                remaining: newRemaining,

                packages: safeInt(it.packages),
                remainingPackages: newRemainingPackages,

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
        }

        // eliminar inventarios de productos que ya no estén en la orden
        const invAll = await getDocs(
          query(
            collection(db, "inventory_candies"),
            where("orderId", "==", editingOrderId)
          )
        );
        const itemIds = new Set(orderItems.map((x) => x.id));
        for (const invDoc of invAll.docs) {
          const x = invDoc.data() as any;
          const pid = String(x.productId || "");
          if (pid && !itemIds.has(pid)) {
            await deleteDoc(doc(db, "inventory_candies", invDoc.id));
          }
        }

        setOrders((prev) =>
          prev.map((o) =>
            o.id === editingOrderId
              ? {
                  ...o,
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
                }
              : o
          )
        );

        setMsg("✅ Orden maestra actualizada (pedido + inventario).");
      } else {
        const orderRef = await addDoc(collection(db, "candy_main_orders"), {
          ...header,
          createdAt: Timestamp.now(),
        } as CandyMainOrderDoc);

        const orderId = orderRef.id;

        const batch = writeBatch(db);

        for (const it of orderItems) {
          const unitsPerPackageLocal = Math.max(
            1,
            safeInt(it.unitsPerPackage || 1)
          );
          const totalUnits = safeInt(it.packages) * unitsPerPackageLocal;

          const invRef = doc(collection(db, "inventory_candies"));
          batch.set(invRef, {
            productId: it.id,
            productName: it.name,
            category: it.category,
            measurement: "unidad",

            quantity: totalUnits,
            remaining: totalUnits,
            packages: safeInt(it.packages),
            remainingPackages: safeInt(it.packages),
            unitsPerPackage: unitsPerPackageLocal,
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

        await batch.commit();

        setMsg("✅ Orden maestra creada y registrada en inventario.");
      }

      resetOrderForm();
      setOpenOrderModal(false);
      refresh();
    } catch (err) {
      console.error(err);
      setMsg("❌ Error al guardar orden maestra.");
    }
  };

  // ====== ABRIR PEDIDO PARA VER / EDITAR ======
  const openOrderForEdit = async (order: CandyOrderSummaryRow) => {
    try {
      setLoading(true);
      setMsg("");

      setEditingOrderId(order.id);
      setOrderName(order.name);
      setOrderDate(order.date);
      setMarginRivas(String(order.marginRivas ?? 20));
      setMarginSanJorge(String(order.marginSanJorge ?? 15));
      setMarginIsla(String(order.marginIsla ?? 30));

      // ✅ tab inicial
      setMobileTab("DATOS");

      // ✅ getDoc directo
      const orderDocRef = doc(db, "candy_main_orders", order.id);
      const orderSnap = await getDoc(orderDocRef);
      if (!orderSnap.exists()) {
        setMsg("❌ No se encontró la orden.");
        return;
      }
      const orderData = orderSnap.data() as any;

      const itemsFromDoc: CandyOrderItem[] = Array.isArray(orderData.items)
        ? (orderData.items as CandyOrderItem[])
        : [];

      // inventario para paquetes restantes por producto
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id)
        )
      );

      const remainingByProduct: Record<string, number> = {};
      invSnap.forEach((d) => {
        const x = d.data() as any;
        const productId = String(x.productId || "");
        if (!productId) return;

        const remainingPackages = getRemainingPackagesFromInvDoc(x);
        remainingByProduct[productId] =
          (remainingByProduct[productId] || 0) + remainingPackages;
      });

      // normalizar contra catálogo
      const normalized = itemsFromDoc.map((it) => {
        const cat = catalog.find((c) => c.id === it.id);

        const providerPrice = Number(
          cat?.providerPrice ?? it.providerPrice ?? 0
        );
        const unitsPerPackage = Math.max(
          1,
          safeInt(cat?.unitsPerPackage ?? it.unitsPerPackage ?? 1)
        );

        const vals = calcOrderItemValues(
          providerPrice,
          safeInt(it.packages || 0),
          {
            marginR: Number(it.marginRivas || 0),
            marginSJ: Number(it.marginSanJorge || 0),
            marginIsla: Number(it.marginIsla || 0),
          }
        );

        return {
          ...it,
          name: String(cat?.name ?? it.name ?? ""),
          category: String(cat?.category ?? it.category ?? "Caramelo"),
          providerPrice,
          unitsPerPackage,
          remainingPackages:
            remainingByProduct[it.id] ??
            it.remainingPackages ??
            it.packages ??
            0,
          ...vals,
        };
      });

      setOrderItems(normalized);
      setOpenOrderModal(true);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al abrir orden maestra.");
    } finally {
      setLoading(false);
    }
  };

  // ====== ELIMINAR PEDIDO GENERAL (Y SU INVENTARIO) ======
  const handleDeleteOrder = async (order: CandyOrderSummaryRow) => {
    const ok = confirm(
      `¿Eliminar la orden "${order.name}" y todo su inventario asociado?`
    );
    if (!ok) return;
    setMsg("");

    try {
      const invSnap = await getDocs(
        query(
          collection(db, "inventory_candies"),
          where("orderId", "==", order.id)
        )
      );
      for (const d of invSnap.docs) {
        await deleteDoc(doc(db, "inventory_candies", d.id));
      }

      await deleteDoc(doc(db, "candy_main_orders", order.id));

      setOrders((prev) => prev.filter((o) => o.id !== order.id));
      setMsg("✅ Orden maestra eliminada.");
      refresh();
    } catch (e) {
      console.error(e);
      setMsg("❌ Error al eliminar orden maestra.");
    }
  };

  return (
    <div className="max-w-7xl mx-auto">
      {/* <div className="flex items-center justify-between mb-3">
        <h2 className="text-2xl font-bold">Ordenes Maestras</h2>
        <div className="flex gap-2">
          <RefreshButton
            onClick={refresh}
            loading={loading || catalogLoading}
          />
          <button
            className="inline-flex items-center gap-2 bg-indigo-600 text-white px-3 py-2 rounded hover:bg-indigo-700"
            onClick={() => {
              resetOrderForm();
              setMobileTab("DATOS");
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
      </div> */}
      <div className="mb-3">
        {/* Título */}
        <div className="flex items-center justify-between">
          <h2 className="text-2xl font-bold">Ordenes Maestras</h2>
        </div>

        {/* ✅ Acciones mobile-first (homologado) */}
        <div className="mt-3 grid grid-cols-1 sm:grid-cols-2 gap-2">
          {/* Refrescar */}
          <div className="w-full">
            <RefreshButton
              onClick={refresh}
              loading={loading || catalogLoading}
            />
          </div>

          {/* Nueva Orden */}
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
        <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-3">
          <div className="bg-white p-4 md:p-6 rounded shadow-lg w-full max-w-5xl max-h-[90vh] overflow-y-auto text-sm">
            {/* Header */}
            <div className="sticky top-0 bg-white z-20 pb-3 border-b">
              <div className="flex items-center gap-3">
                <h3 className="text-lg md:text-xl font-bold">
                  {editingOrderId
                    ? "Editar Orden Maestra"
                    : "Nueva Orden Maestra"}
                </h3>

                <div className="ml-auto flex gap-2">
                  <button
                    type="button"
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                    onClick={() => {
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                  >
                    Cerrar
                  </button>
                </div>
              </div>

              {/* Tabs (solo móvil) */}
              <div className="md:hidden mt-3">
                <div className="grid grid-cols-4 gap-2">
                  <button
                    type="button"
                    onClick={() => setMobileTab("DATOS")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "DATOS"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Datos
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("AGREGAR")}
                    disabled={!!editingOrderId}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      editingOrderId
                        ? "bg-gray-100 text-gray-400 border-gray-200"
                        : mobileTab === "AGREGAR"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                    title={
                      editingOrderId ? "En edición no se agregan productos" : ""
                    }
                  >
                    Agregar
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("ITEMS")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "ITEMS"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Items ({orderItems.length})
                  </button>

                  <button
                    type="button"
                    onClick={() => setMobileTab("TOTALES")}
                    className={`px-2 py-2 rounded text-xs font-semibold border ${
                      mobileTab === "TOTALES"
                        ? "bg-blue-600 text-white border-blue-600"
                        : "bg-white text-gray-700 border-gray-200"
                    }`}
                  >
                    Totales
                  </button>
                </div>
              </div>
            </div>

            <form onSubmit={handleSaveOrder} className="space-y-4 pt-4">
              {/* ===== DATOS ===== */}
              <div
                className={`${
                  mobileTab === "DATOS" ? "block" : "hidden"
                } md:block`}
              >
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
              </div>

              {/* ===== AGREGAR (solo nuevo) ===== */}
              {!editingOrderId && (
                <div
                  className={`${
                    mobileTab === "AGREGAR" ? "block" : "hidden"
                  } md:block`}
                >
                  <div className="border rounded p-3 bg-gray-50">
                    <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
                      <div>
                        <label className="block text-sm font-semibold">
                          Categoría (dinámica)
                        </label>
                        <select
                          className="w-full border p-2 rounded"
                          value={orderCategory}
                          onChange={(e) => {
                            setOrderCategory(e.target.value);
                            setOrderProductId("");
                          }}
                          disabled={catalogLoading}
                        >
                          {catalogCategories.length === 0 ? (
                            <option value="">
                              {catalogLoading
                                ? "Cargando..."
                                : "No hay categorías en catálogo"}
                            </option>
                          ) : (
                            catalogCategories.map((c) => (
                              <option key={c} value={c}>
                                {c}
                              </option>
                            ))
                          )}
                        </select>
                      </div>

                      <div className="md:col-span-2">
                        <label className="block text-sm font-semibold">
                          Producto (catálogo)
                        </label>
                        <select
                          className="w-full border p-2 rounded"
                          value={orderProductId}
                          onChange={(e) => setOrderProductId(e.target.value)}
                        >
                          <option value="">
                            {catalogLoading
                              ? "Cargando catálogo..."
                              : "Selecciona producto"}
                          </option>
                          {catalogByCategory.map((p) => (
                            <option key={p.id} value={p.id}>
                              {p.name}
                            </option>
                          ))}
                        </select>
                      </div>

                      <div>
                        <label className="block text-sm font-semibold">
                          Precio proveedor (paq)
                        </label>
                        <input
                          type="number"
                          className="w-full border p-2 rounded bg-gray-100"
                          value={orderProviderPrice}
                          readOnly
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
                          className="w-full border p-2 rounded bg-gray-100"
                          value={orderUnitsPerPackage}
                          readOnly
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
                </div>
              )}

              {/* ===== ITEMS ===== */}
              <div
                className={`${
                  mobileTab === "ITEMS" ? "block" : "hidden"
                } md:block`}
              >
                {/* MÓVIL: Cards */}
                <div className="md:hidden space-y-3">
                  {orderItems.length === 0 ? (
                    <div className="p-4 border rounded bg-gray-50 text-gray-600">
                      No hay productos en esta orden.
                    </div>
                  ) : (
                    orderItems.map((it) => (
                      <div
                        key={it.id}
                        className="border rounded-xl p-3 shadow-sm"
                      >
                        <div className="flex items-start gap-2">
                          <div className="flex-1">
                            <div className="font-semibold text-base leading-tight">
                              {it.name}
                            </div>
                            <div className="text-xs text-gray-500">
                              {it.category}
                            </div>
                          </div>

                          {!editingOrderId && (
                            <button
                              type="button"
                              className="px-2 py-1 rounded bg-red-600 text-white hover:bg-red-700 text-xs"
                              onClick={() => removeItemFromOrder(it.id)}
                            >
                              Quitar
                            </button>
                          )}
                        </div>

                        <div className="grid grid-cols-2 gap-2 mt-3">
                          <div>
                            <label className="text-xs text-gray-600">
                              Paquetes
                            </label>
                            <input
                              type="number"
                              className="w-full border p-2 rounded text-right"
                              value={it.packages}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "packages",
                                  e.target.value
                                )
                              }
                            />
                          </div>

                          <div>
                            <label className="text-xs text-gray-600">
                              Restantes
                            </label>
                            <input
                              className="w-full border p-2 rounded text-right bg-gray-100"
                              value={it.remainingPackages ?? it.packages}
                              readOnly
                            />
                          </div>

                          <div>
                            <label className="text-xs text-gray-600">
                              Und x Paq
                            </label>
                            <input
                              type="number"
                              className="w-full border p-2 rounded text-right"
                              value={it.unitsPerPackage}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "unitsPerPackage",
                                  e.target.value
                                )
                              }
                            />
                          </div>

                          <div>
                            <label className="text-xs text-gray-600">
                              P. proveedor
                            </label>
                            <input
                              className="w-full border p-2 rounded text-right bg-gray-100"
                              value={Number(it.providerPrice || 0).toFixed(2)}
                              readOnly
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mt-3">
                          <div>
                            <label className="text-xs text-gray-600">
                              % Rivas
                            </label>
                            <input
                              type="number"
                              className="w-full border p-2 rounded text-right"
                              value={it.marginRivas ?? 0}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "marginRivas",
                                  e.target.value
                                )
                              }
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">
                              % SJ
                            </label>
                            <input
                              type="number"
                              className="w-full border p-2 rounded text-right"
                              value={it.marginSanJorge ?? 0}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "marginSanJorge",
                                  e.target.value
                                )
                              }
                            />
                          </div>
                          <div>
                            <label className="text-xs text-gray-600">
                              % Isla
                            </label>
                            <input
                              type="number"
                              className="w-full border p-2 rounded text-right"
                              value={it.marginIsla ?? 0}
                              onChange={(e) =>
                                handleItemFieldChange(
                                  it.id,
                                  "marginIsla",
                                  e.target.value
                                )
                              }
                            />
                          </div>
                        </div>

                        <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                          <div className="p-2 rounded bg-gray-50 border">
                            <div className="text-xs text-gray-600">
                              Subtotal
                            </div>
                            <div className="font-semibold">
                              {Number(it.subtotal || 0).toFixed(2)}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-gray-50 border">
                            <div className="text-xs text-gray-600">
                              Total Rivas
                            </div>
                            <div className="font-semibold">
                              {Number(it.totalRivas || 0).toFixed(2)}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-gray-50 border">
                            <div className="text-xs text-gray-600">
                              Total SJ
                            </div>
                            <div className="font-semibold">
                              {Number(it.totalSanJorge || 0).toFixed(2)}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-gray-50 border">
                            <div className="text-xs text-gray-600">
                              Total Isla
                            </div>
                            <div className="font-semibold">
                              {Number(it.totalIsla || 0).toFixed(2)}
                            </div>
                          </div>
                        </div>

                        <div className="grid grid-cols-3 gap-2 mt-3 text-xs">
                          <div className="p-2 rounded bg-blue-50 border">
                            <div className="text-gray-600">P. unidad Rivas</div>
                            <div className="font-semibold">
                              {it.unitPriceRivas}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-blue-50 border">
                            <div className="text-gray-600">P. unidad SJ</div>
                            <div className="font-semibold">
                              {it.unitPriceSanJorge}
                            </div>
                          </div>
                          <div className="p-2 rounded bg-blue-50 border">
                            <div className="text-gray-600">P. unidad Isla</div>
                            <div className="font-semibold">
                              {it.unitPriceIsla}
                            </div>
                          </div>
                        </div>
                      </div>
                    ))
                  )}
                </div>

                {/* DESKTOP: tu tabla original */}
                <div className="hidden md:block bg-white rounded border overflow-x-auto">
                  <table className="min-w-[1100px] text-xs md:text-sm">
                    <thead className="bg-gray-100">
                      <tr className="whitespace-nowrap">
                        <th className="p-2 border">Producto</th>
                        <th className="p-2 border">Categoría</th>
                        <th className="p-2 border">Paquetes</th>
                        <th className="p-2 border">Paquetes restantes</th>
                        <th className="p-2 border">Und x Paq</th>
                        <th className="p-2 border">P. proveedor (paq)</th>

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

                        {!editingOrderId && (
                          <th className="p-2 border">Acciones</th>
                        )}
                      </tr>
                    </thead>

                    <tbody>
                      {orderItems.length === 0 ? (
                        <tr>
                          <td
                            colSpan={editingOrderId ? 16 : 17}
                            className="p-4 text-center text-gray-500"
                          >
                            No hay productos en esta orden.
                          </td>
                        </tr>
                      ) : (
                        orderItems.map((it) => (
                          <tr
                            key={it.id}
                            className="text-center whitespace-nowrap"
                          >
                            <td className="p-2 border text-left">{it.name}</td>
                            <td className="p-2 border">{it.category}</td>

                            <td className="p-2 border">
                              <input
                                type="number"
                                className="w-24 border p-1 rounded text-right"
                                value={it.packages}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "packages",
                                    e.target.value
                                  )
                                }
                              />
                            </td>

                            <td className="p-2 border">
                              {it.remainingPackages ?? it.packages}
                            </td>

                            <td className="p-2 border">
                              <input
                                type="number"
                                className="w-20 border p-1 rounded text-right"
                                value={it.unitsPerPackage}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "unitsPerPackage",
                                    e.target.value
                                  )
                                }
                              />
                            </td>

                            <td className="p-2 border">
                              {Number(it.providerPrice || 0).toFixed(2)}
                            </td>

                            <td className="p-2 border">
                              <input
                                type="number"
                                className="w-20 border p-1 rounded text-right"
                                value={it.marginRivas ?? 0}
                                onChange={(e) =>
                                  handleItemFieldChange(
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
                                className="w-20 border p-1 rounded text-right"
                                value={it.marginSanJorge ?? 0}
                                onChange={(e) =>
                                  handleItemFieldChange(
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
                                className="w-20 border p-1 rounded text-right"
                                value={it.marginIsla ?? 0}
                                onChange={(e) =>
                                  handleItemFieldChange(
                                    it.id,
                                    "marginIsla",
                                    e.target.value
                                  )
                                }
                              />
                            </td>

                            <td className="p-2 border">
                              {Number(it.subtotal || 0).toFixed(2)}
                            </td>
                            <td className="p-2 border">
                              {Number(it.totalRivas || 0).toFixed(2)}
                            </td>
                            <td className="p-2 border">
                              {Number(it.totalSanJorge || 0).toFixed(2)}
                            </td>
                            <td className="p-2 border">
                              {Number(it.totalIsla || 0).toFixed(2)}
                            </td>

                            <td className="p-2 border">{it.unitPriceRivas}</td>
                            <td className="p-2 border">
                              {it.unitPriceSanJorge}
                            </td>
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
              </div>

              {/* ===== TOTALES ===== */}
              <div
                className={`${
                  mobileTab === "TOTALES" ? "block" : "hidden"
                } md:block`}
              >
                <div className="grid grid-cols-1 md:grid-cols-4 gap-3 mt-3">
                  <div className="p-3 border rounded bg-gray-50">
                    <div className="text-xs text-gray-600">
                      Paquetes totales de la orden
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
                      Total Rivas (orden)
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
              </div>

              {/* ===== Botonera sticky (móvil) / normal (md+) ===== */}
              <div className="sticky bottom-0 bg-white pt-3 mt-4 border-t">
                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={resetOrderForm}
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  >
                    Limpiar orden
                  </button>

                  <button
                    type="button"
                    onClick={() => {
                      resetOrderForm();
                      setOpenOrderModal(false);
                    }}
                    className="px-3 py-2 rounded bg-gray-200 hover:bg-gray-300"
                  >
                    Cerrar
                  </button>

                  <button
                    type="submit"
                    className="px-3 py-2 rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-60"
                    disabled={orderItems.length === 0}
                  >
                    Guardar orden
                  </button>
                </div>

                {/* Atajo móvil */}
                <div className="md:hidden mt-2">
                  <button
                    type="button"
                    className="w-full px-3 py-2 rounded bg-gray-100 hover:bg-gray-200 text-sm"
                    onClick={() => {
                      if (mobileTab === "DATOS" && !editingOrderId)
                        setMobileTab("AGREGAR");
                      else if (mobileTab === "DATOS") setMobileTab("ITEMS");
                      else if (mobileTab === "AGREGAR") setMobileTab("ITEMS");
                      else if (mobileTab === "ITEMS") setMobileTab("TOTALES");
                      else setMobileTab("DATOS");
                    }}
                  >
                    Siguiente
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* LISTADO */}
      <div className="mt-4">
        {/* ✅ MÓVIL: Cards (sin scroll horizontal) */}
        <div className="md:hidden space-y-3">
          {loading ? (
            <div className="p-4 border rounded bg-white text-center">
              Cargando…
            </div>
          ) : orders.length === 0 ? (
            <div className="p-4 border rounded bg-white text-center">
              Sin ordenes maestras.
            </div>
          ) : (
            orders.map((o) => {
              const agg = orderInventoryAgg[o.id];
              const fecha =
                o.date ||
                (o.createdAt?.toDate
                  ? o.createdAt.toDate().toISOString().slice(0, 10)
                  : "—");

              const precioProveedor =
                o.totalPackages > 0
                  ? (o.subtotal / o.totalPackages).toFixed(2)
                  : "0.00";

              return (
                <div
                  key={o.id}
                  className="border rounded-xl p-3 bg-white shadow-sm"
                >
                  <div className="flex items-start gap-3">
                    <div className="flex-1">
                      <div className="text-xs text-gray-500">{fecha}</div>
                      <div className="font-semibold text-base leading-tight">
                        {o.name}
                      </div>
                    </div>

                    <div className="flex gap-2">
                      <button
                        className="px-3 py-2 rounded bg-blue-600 text-white text-xs"
                        onClick={() => openOrderForEdit(o)}
                      >
                        Ver
                      </button>
                      <button
                        className="px-3 py-2 rounded bg-red-600 text-white text-xs"
                        onClick={() => handleDeleteOrder(o)}
                      >
                        Borrar
                      </button>
                    </div>
                  </div>

                  <div className="grid grid-cols-2 gap-2 mt-3 text-sm">
                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Paquetes</div>
                      <div className="font-semibold">{o.totalPackages}</div>
                    </div>

                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Restantes</div>
                      <div className="font-semibold">
                        {agg ? agg.remainingPackages : 0}
                      </div>
                    </div>

                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">P. Proveedor</div>
                      <div className="font-semibold">{precioProveedor}</div>
                    </div>

                    <div className="p-2 rounded bg-gray-50 border">
                      <div className="text-xs text-gray-600">Subtotal</div>
                      <div className="font-semibold">
                        {o.subtotal.toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="grid grid-cols-3 gap-2 mt-2 text-xs">
                    <div className="p-2 rounded bg-blue-50 border">
                      <div className="text-gray-600">Total Rivas</div>
                      <div className="font-semibold">
                        {o.totalRivas.toFixed(2)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-blue-50 border">
                      <div className="text-gray-600">Total SJ</div>
                      <div className="font-semibold">
                        {o.totalSanJorge.toFixed(2)}
                      </div>
                    </div>
                    <div className="p-2 rounded bg-blue-50 border">
                      <div className="text-gray-600">Total Isla</div>
                      <div className="font-semibold">
                        {o.totalIsla.toFixed(2)}
                      </div>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {/* ✅ DESKTOP: tu tabla igual (con scroll si hace falta) */}
        <div className="hidden md:block bg-white p-2 rounded shadow border w-full overflow-x-auto">
          <table className="min-w-[900px] text-xs md:text-sm">
            <thead className="bg-gray-100">
              <tr className="whitespace-nowrap">
                <th className="p-2 border">Fecha</th>
                <th className="p-2 border">Nombre</th>
                <th className="p-2 border">Paquetes totales</th>
                <th className="p-2 border">Paquetes restantes</th>
                <th className="p-2 border">Precio Proveedor</th>
                <th className="p-2 border">Subtotal</th>
                <th className="p-2 border">Total Rivas</th>
                <th className="p-2 border">Total San Jorge</th>
                <th className="p-2 border">Total Isla</th>
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
                    Sin ordenes maestras.
                  </td>
                </tr>
              ) : (
                orders.map((o) => {
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
                      <td className="p-2 border">
                        {o.totalPackages > 0
                          ? (o.subtotal / o.totalPackages).toFixed(2)
                          : "0.00"}
                      </td>
                      <td className="p-2 border">{o.subtotal.toFixed(2)}</td>

                      <td className="p-2 border">{o.totalRivas.toFixed(2)}</td>
                      <td className="p-2 border">
                        {o.totalSanJorge.toFixed(2)}
                      </td>
                      <td className="p-2 border">{o.totalIsla.toFixed(2)}</td>

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
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}
    </div>
  );
}
