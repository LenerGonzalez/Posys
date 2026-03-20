// src/components/Candies/TransactionsReportCandies.tsx
import React, { useEffect, useMemo, useState } from "react";
import * as XLSX from "xlsx";
import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../../firebase";
import { hasRole } from "../../utils/roles";
import { format } from "date-fns";
import { restoreSaleAndDeleteCandy } from "../../Services/inventory_candies";

type SaleType = "CONTADO" | "CREDITO";
const money = (n: number) => `C$ ${(Number(n) || 0).toFixed(2)}`;
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const normKey = (v: unknown) =>
  String(v ?? "")
    .trim()
    .toLowerCase();

interface Customer {
  id: string;
  name: string;
}

// === Nuevo: mismo seller que en consolidado de vendedores (dulces) ===
interface Seller {
  id: string;
  name: string;
  commissionPercent: number;
}

interface SaleDoc {
  id: string;
  date: string; // yyyy-MM-dd
  type: SaleType;
  total: number;

  // TOTAL de PAQUETES para UI
  quantity: number;
  productNames: string[];

  customerId?: string;
  customerName?: string;
  downPayment?: number;

  vendorId?: string;
  vendorName?: string;

  // ✅ NUEVO: si viene guardado en la venta, lo usamos para histórico
  vendorCommissionPercent?: number;
  vendorCommissionAmount?: number;
  // Suma de margenVendedor por ítems (cuando la venta tiene items[])
  commissionFromItems?: number;
  uvXpaq?: number;
}

// ----------------- Helpers de fecha / normalización -----------------
function ensureDate(x: any): string {
  if (x?.date) return x.date;
  if (x?.createdAt?.toDate) return format(x.createdAt.toDate(), "yyyy-MM-dd");
  return "";
}

/**
 * Normaliza una venta de "sales_candies" a SaleDoc
 * - Soporta ventas con items[] o estructura simple
 * - quantity en SaleDoc SIEMPRE serán PAQUETES para la UI
 */
function normalizeSale(d: any, id: string): SaleDoc | null {
  const date = ensureDate(d);
  if (!date) return null;

  let quantity = 0; // paquetes
  let total = 0;
  const itemsArray =
    Array.isArray(d.items) && d.items.length > 0
      ? d.items
      : d.item
        ? [d.item]
        : [];

  const productNames = itemsArray.length
    ? itemsArray
        .map((it: any) => String(it.productName || it.name || "").trim())
        .filter(Boolean)
    : d.productName
      ? [String(d.productName).trim()]
      : [];

  // Si la venta tiene items[] (multi-producto)
  let commissionFromItems = 0;
  if (itemsArray.length > 0) {
    // Paquetes: usamos campo packages, si no, qty/quantity (fallback)
    quantity = itemsArray.reduce(
      (acc: number, it: any) =>
        acc + (Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0),
      0,
    );
    total = Number(d.total ?? d.itemsTotal ?? 0) || 0;
    if (!total) {
      total = itemsArray.reduce(
        (acc: number, it: any) =>
          acc + (Number(it.total ?? it.lineFinal ?? 0) || 0),
        0,
      );
    }
    // Suma de margenVendedor por ítem (si existe)
    commissionFromItems = itemsArray.reduce(
      (acc: number, it: any) => acc + (Number(it.margenVendedor || 0) || 0),
      0,
    );
  } else {
    // Estructura legacy / simple
    quantity =
      Number(
        d.packagesTotal ?? d.quantity ?? d.item?.packages ?? d.item?.qty ?? 0,
      ) || 0;
    total = Number(d.total ?? d.item?.total ?? 0) || 0;
  }

  return {
    id,
    date,
    type: (d.type || "CONTADO") as SaleType,
    total,
    quantity,
    customerId: d.customerId || undefined,
    customerName: d.customerName || undefined,
    downPayment: Number(d.downPayment || 0),
    vendorId: d.vendorId || undefined,
    vendorName: d.vendorName || d.vendor || undefined,

    // ✅ HISTÓRICO desde la venta
    vendorCommissionPercent: Number(d.vendorCommissionPercent || 0) || 0,
    vendorCommissionAmount: Number(d.vendorCommissionAmount || 0) || 0,
    commissionFromItems: Number(commissionFromItems || 0) || 0,
    uvXpaq: Number.isFinite(Number(d.uvXpaq ?? d.uvxpaq ?? d.upaquete ?? NaN))
      ? Number(d.uvXpaq ?? d.uvxpaq ?? d.upaquete)
      : undefined,
    productNames,
  };
}

// ============ CUENTAS POR COBRAR (CxC) ============
async function deleteARMovesBySaleId(saleId: string) {
  const saleIdSafe = (saleId || "").trim();
  if (!saleIdSafe) return;
  const qMov = query(
    collection(db, "ar_movements"),
    where("ref.saleId", "==", saleIdSafe),
  );
  const snap = await getDocs(qMov);
  await Promise.all(
    snap.docs.map((d) => deleteDoc(doc(db, "ar_movements", d.id))),
  );
}

// ===== NUEVO: Props para restringir por vendedor / rol =====

type RoleProp =
  | ""
  | "admin"
  | "vendedor_pollo"
  | "vendedor_ropa"
  | "vendedor_dulces"
  | "supervisor_pollo"
  | "contador";

interface TransactionsReportCandiesProps {
  role?: RoleProp;
  sellerCandyId?: string;
  currentUserEmail?: string;
}

export default function TransactionsReportCandies({
  role = "",
  sellerCandyId = "",
  roles,
}: TransactionsReportCandiesProps & { roles?: string[] }) {
  const subject = roles && roles.length ? roles : role;
  const isAdmin = hasRole(subject, "admin");
  const isVendor = hasRole(subject, "vendedor_dulces");
  const canDelete = isAdmin;

  // NUEVO: ahora hay una columna extra (Comisión)
  const columnsCount = canDelete ? 8 : 7;

  // ===== Modal Detalle de Ítems =====
  const [itemsModalOpen, setItemsModalOpen] = useState(false);
  const [itemsModalLoading, setItemsModalLoading] = useState(false);
  const [itemsModalSaleId, setItemsModalSaleId] = useState<string | null>(null);
  const [itemsModalRows, setItemsModalRows] = useState<
    {
      productName: string;
      qty: number; // paquetes
      unitPrice: number; // precio por paquete
      discount?: number;
      total: number;
      commission?: number;
    }[]
  >([]);

  const openItemsModal = async (saleId: string) => {
    setItemsModalOpen(true);
    setItemsModalLoading(true);
    setItemsModalSaleId(saleId);
    setItemsModalRows([]);

    try {
      const docSnap = await getDoc(doc(db, "sales_candies", saleId));
      const data = docSnap.exists() ? (docSnap.data() as any) : null;
      if (!data) {
        setItemsModalRows([]);
        return;
      }

      const arr = Array.isArray(data?.items)
        ? data.items
        : data?.item
          ? [data.item]
          : [];

      const rows = arr.map((it: any) => {
        const productName = String(it.productName || "");
        const qty = Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0;
        const unitPrice = Number(it.unitPricePackage ?? it.unitPrice ?? 0) || 0;
        const discount = Number(it.discount || 0) || 0;
        const total = Number(it.total ?? it.lineFinal ?? 0) || 0;

        // Mostrar el valor del campo `uvXpaq` (uv por paquete) cuando exista;
        // si no existe, intentar lookup en `uvxpaqMap`; como último recurso usar margenVendedor
        let commission = 0;
        const uvFromItem = Number(it.uvXpaq ?? it.uvxpaq ?? it.upaquete ?? NaN);
        let uv: number | undefined = Number.isFinite(uvFromItem)
          ? uvFromItem
          : undefined;

        if (uv === undefined) {
          // prefer sale-level uvXpaq if sale was backfilled
          const saleUv = Number(
            data?.uvXpaq ?? data?.uvxpaq ?? data?.upaquete ?? NaN,
          );
          if (Number.isFinite(saleUv)) {
            uv = saleUv;
          } else {
            try {
              const vendedorId = String(
                data?.vendorId || data?.vendor || data?.vendorId || "",
              ).trim();
              const prodKey = normKey(
                it.productName || it.name || it.productId || "",
              );
              const mapForVendor = uvxpaqMap[vendedorId] || {};
              if (mapForVendor[prodKey] !== undefined)
                uv = Number(mapForVendor[prodKey]);
              else {
                const allKeys = Object.keys(mapForVendor);
                const match = allKeys.find(
                  (k) => k.replace(/\s+/g, "") === prodKey.replace(/\s+/g, ""),
                );
                if (match) uv = Number(mapForVendor[match]);
              }
            } catch (e) {
              uv = undefined;
            }
          }
        }

        if (uv !== undefined && Number.isFinite(uv)) {
          // mostramos UV x PAQ (uv por paquete * cantidad de paquetes)
          commission = round2(uv * qty);
        } else {
          const itemMargin = Number(it.margenVendedor ?? it.vendorGain ?? NaN);
          commission = Number.isFinite(itemMargin) ? round2(itemMargin) : 0;
        }

        return {
          productName,
          qty,
          unitPrice,
          discount,
          total,
          commission,
        };
      });

      setItemsModalRows(rows);
    } catch (e) {
      console.error(e);
    } finally {
      setItemsModalLoading(false);
    }
  };

  // --------- Estado principal ---------
  const [fromDate, setFromDate] = useState(format(new Date(), "yyyy-MM-01"));
  const [toDate, setToDate] = useState(format(new Date(), "yyyy-MM-dd"));

  const [customers, setCustomers] = useState<Customer[]>([]);
  const [sales, setSales] = useState<SaleDoc[]>([]);
  const [filterProduct, setFilterProduct] = useState<string>("");

  // NUEVO: vendedores con comisión (mismo esquema que consolidado)
  const [sellers, setSellers] = useState<Seller[]>([]);
  const [uvxpaqMap, setUvxpaqMap] = useState<
    Record<string, Record<string, number>>
  >({});

  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState("");

  // Filtros: Cliente y Tipo
  const [filterCustomerId, setFilterCustomerId] = useState<string>("");
  const [filterType, setFilterType] = useState<"" | SaleType>("");
  const [filterSellerId, setFilterSellerId] = useState<string>("");

  // kebab menú
  const [openMenuId, setOpenMenuId] = useState<string | null>(null);

  // paginación
  const PAGE_SIZE = 15;
  const [page, setPage] = useState(1);

  // UI: cards colapsables
  const [filtersCardOpen, setFiltersCardOpen] = useState(false);
  const [kpisCardOpen, setKpisCardOpen] = useState(false);
  const [cashCardOpen, setCashCardOpen] = useState(false);
  const [creditCardOpen, setCreditCardOpen] = useState(false);

  const customersById = useMemo(() => {
    const m: Record<string, string> = {};
    customers.forEach((c) => (m[c.id] = c.name));
    return m;
  }, [customers]);

  const sellersById = useMemo(() => {
    const m: Record<string, Seller> = {};
    sellers.forEach((v) => {
      m[v.id] = v;
    });
    return m;
  }, [sellers]);

  const productOptions = useMemo(() => {
    const set = new Set<string>();
    sales.forEach((s) => {
      (s.productNames || []).forEach((name) => set.add(name));
    });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [sales]);

  // Export: lista (sábana) de todos los productos vendidos en filteredSales
  const handleExportXLSXAllProducts = async () => {
    setLoading(true);
    setMsg("");
    try {
      const rows: any[] = [];
      for (const s of filteredSales) {
        try {
          const docSnap = await getDoc(doc(db, "sales_candies", s.id));
          const data = docSnap.exists() ? (docSnap.data() as any) : null;
          if (!data) continue;

          const arr = Array.isArray(data.items)
            ? data.items
            : data.item
              ? [data.item]
              : [];

          if (arr.length > 0) {
            for (const it of arr) {
              const itemMargin = Number(
                it.margenVendedor ?? it.vendorGain ?? NaN,
              );
              let itemCommission = 0;
              let origen = "calculado";
              if (Number.isFinite(itemMargin) && itemMargin !== 0) {
                itemCommission = round2(itemMargin);
                origen = "item";
              } else {
                // intentar uv desde item o lookup en mapa
                const uvFromItem = Number(
                  it.uvXpaq ?? it.uvxpaq ?? it.upaquete ?? NaN,
                );
                let uv: number | undefined = Number.isFinite(uvFromItem)
                  ? uvFromItem
                  : undefined;
                if (uv === undefined) {
                  // prefer sale-level uv if backfilled
                  const saleUv = Number(
                    data?.uvXpaq ?? data?.uvxpaq ?? data?.upaquete ?? NaN,
                  );
                  if (Number.isFinite(saleUv)) {
                    uv = saleUv;
                  } else {
                    try {
                      const vendedorId = String(s.vendorId || "").trim();
                      const prodKey = normKey(
                        it.productName || it.name || it.productId || "",
                      );
                      const mapForVendor = uvxpaqMap[vendedorId] || {};
                      if (mapForVendor[prodKey] !== undefined)
                        uv = Number(mapForVendor[prodKey]);
                      else {
                        const allKeys = Object.keys(mapForVendor);
                        const match = allKeys.find(
                          (k) =>
                            k.replace(/\s+/g, "") ===
                            prodKey.replace(/\s+/g, ""),
                        );
                        if (match) uv = Number(mapForVendor[match]);
                      }
                    } catch (e) {
                      uv = undefined;
                    }
                  }
                }

                const qty =
                  Number(it.packages ?? it.qty ?? it.quantity ?? 0) || 0;
                // mostrar UV x PAQ (uv por paquete * cantidad de paquetes)
                if (uv !== undefined && Number.isFinite(uv)) {
                  itemCommission = round2(uv * qty);
                  origen = "calculado";
                } else {
                  // fallback to item margin
                  const itemMargin = Number(
                    it.margenVendedor ?? it.vendorGain ?? NaN,
                  );
                  itemCommission = Number.isFinite(itemMargin)
                    ? round2(itemMargin)
                    : 0;
                  origen = itemCommission > 0 ? "item" : "calculado";
                }
              }

              rows.push({
                Fecha: s.date,
                Venta: s.id,
                Tipo: s.type,
                Cliente: s.customerName || "",
                Vendedor: s.vendorName || "",
                Producto: it.productName || it.name || "",
                Paquetes: Number(it.packages ?? it.qty ?? it.quantity ?? 0),
                Precio: Number(it.unitPricePackage ?? it.unitPrice ?? 0),
                Descuento: Number(it.discount || 0),
                Monto: Number(it.total ?? it.lineFinal ?? 0),
                Comision: itemCommission,
                OrigenComision: origen,
              });
            }
          } else {
            const saleCommission = getCommissionAmount(s);
            const saleOrigen =
              (s as any).commissionFromItems > 0
                ? "items"
                : Number(s.vendorCommissionAmount || 0) > 0
                  ? "venta"
                  : "calculado";
            rows.push({
              Fecha: s.date,
              Venta: s.id,
              Tipo: s.type,
              Cliente: s.customerName || "",
              Vendedor: s.vendorName || "",
              Producto:
                s.productNames && s.productNames[0] ? s.productNames[0] : "",
              Paquetes: s.quantity,
              Precio: s.total,
              Descuento: 0,
              Monto: s.total,
              Comision: saleCommission,
              OrigenComision: saleOrigen,
            });
          }
        } catch (e) {
          console.error("Error leyendo venta", s.id, e);
        }
      }

      const ws = XLSX.utils.json_to_sheet(rows);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Productos");
      const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
      const blob = new Blob([wbout], { type: "application/octet-stream" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `ventas_productos_${fromDate}_a_${toDate}.xlsx`;
      a.click();
      URL.revokeObjectURL(url);
      setMsg(`✅ Exportado ${rows.length} fila(s)`);
    } catch (e) {
      console.error(e);
      setMsg("❌ Error exportando a Excel");
    } finally {
      setLoading(false);
    }
  };

  // Backfill ventas en rango (por mes). Actualiza uvXpaq/uvxpaq/upaquete en ventas e ítems.
  const handleBackfillMonth = async () => {
    if (
      !window.confirm(
        `¿Actualizar ventas viejas con campos nuevos desde las órdenes de vendedor (${fromDate} a ${toDate})? Esto modificará documentos en Firestore.`,
      )
    )
      return;
    setLoading(true);
    setMsg("");
    try {
      const q = query(
        collection(db, "sales_candies"),
        where("date", ">=", fromDate),
        where("date", "<=", toDate),
      );
      const snap = await getDocs(q);
      if (snap.empty) {
        setMsg("No hay ventas en el rango.");
        return;
      }

      let batch = writeBatch(db);
      let ops = 0;
      let updated = 0;

      for (const d of snap.docs) {
        const data = d.data() as any;
        const id = d.id;
        const items = Array.isArray(data.items)
          ? data.items
          : data.item
            ? [data.item]
            : [];
        const vendorId = String(data.vendorId || data.vendor || "").trim();
        const upd: any = {};

        // Actualizar cada producto vendido usando for...of
        const newItems = [];
        for (const it of items) {
          const productId = String(it.productId || "").trim();
          let sellerDoc: any = null;
          try {
            const qSeller = query(
              collection(db, "inventory_candies_sellers"),
              where("sellerId", "==", vendorId),
              where("productId", "==", productId),
            );
            const sellerSnap = await getDocs(qSeller);
            if (!sellerSnap.empty) {
              sellerDoc = sellerSnap.docs[0].data();
            }
          } catch (e) {
            sellerDoc = null;
          }
          if (sellerDoc) {
            newItems.push({
              ...it,
              uInvestor: sellerDoc.uInvestor,
              uNeta: sellerDoc.uNeta,
              uNetaPorPaquete: sellerDoc.uNetaPorPaquete,
              uVendor: sellerDoc.uVendor,
              upaquete: sellerDoc.upaquete,
              uvXpaq: sellerDoc.uvXpaq,
              vendorMarginPercent: sellerDoc.vendorMarginPercent,
            });
          } else {
            newItems.push(it);
          }
        }

        if (newItems.length > 0) {
          upd.items = newItems;
        }

        if (Object.keys(upd).length > 0) {
          batch.update(doc(db, "sales_candies", id), upd);
          ops++;
          updated++;
          if (ops >= 400) {
            await batch.commit();
            batch = writeBatch(db);
            ops = 0;
          }
        }
      }

      if (ops > 0) await batch.commit();
      setMsg(
        `✅ Backfilled ${updated} venta(s) actualizadas con campos nuevos`,
      );
    } catch (e) {
      console.error(e);
      setMsg("❌ Error durante backfill");
    } finally {
      setLoading(false);
    }
  };

  const UVXPAQ_CUTOFF_DATE = "2026-02-25";

  const getUvXpaqForSale = (
    s: SaleDoc | undefined,
    productName?: string,
    productId?: string,
  ): number => {
    if (!s) return 0;
    const key = normKey(
      productName || (s.productNames && s.productNames[0]) || "",
    );
    const candidates = [s.vendorId || "", sellerCandyId || ""].filter(Boolean);
    const isHistoric = String(s.date || "") <= UVXPAQ_CUTOFF_DATE;

    if (isHistoric) {
      for (const cid of candidates) {
        const vmap = uvxpaqMap[cid || ""];
        const val = vmap ? vmap[key] : undefined;
        if (val !== undefined && val !== null) return round2(Number(val || 0));
      }
    } else {
      const explicit = Number((s as any).uvXpaq ?? NaN);
      if (Number.isFinite(explicit)) return round2(Number(explicit || 0));
    }

    const qty = Math.max(1, Number(s.quantity || 0));
    const uVend = Number((s as any).commissionFromItems || 0);
    return uVend > 0 ? round2(uVend / qty) : 0;
  };

  // Comisión reportada: preferir suma por ítems (commissionFromItems),
  // sino calcular como UV por paquete * cantidad usando uvxpaq fallback
  const getCommissionAmount = (s: SaleDoc): number => {
    const itemsCommission = Number((s as any).commissionFromItems || 0);
    if (itemsCommission > 0) return round2(itemsCommission);

    const uv = getUvXpaqForSale(s);
    const qty = Math.max(0, Number(s.quantity || 0));
    return round2(uv * qty);
  };

  // Carga inicial y recarga al cambiar rango de fechas
  useEffect(() => {
    (async () => {
      setLoading(true);
      setMsg("");
      try {
        // clientes (dulces)
        const cSnap = await getDocs(collection(db, "customers_candies"));
        const cList: Customer[] = [];
        cSnap.forEach((d) =>
          cList.push({ id: d.id, name: (d.data() as any).name || "" }),
        );
        setCustomers(cList);

        // vendedores (dulces) con comisión (fallback si no viene en venta)
        const vSnap = await getDocs(collection(db, "sellers_candies"));
        const vList: Seller[] = [];
        vSnap.forEach((d) => {
          const data = d.data() as any;
          vList.push({
            id: d.id,
            name: data.name || "",
            commissionPercent: Number(data.commissionPercent || 0),
          });
        });
        setSellers(vList);

        // build uvxpaq map for sellers (fallback like in CierreVentasDulces)
        try {
          const vendorIds = vList.map((v) => v.id).filter(Boolean);
          const map: Record<string, Record<string, number>> = {};
          if (vendorIds.length > 0) {
            const chunk = (arr: string[], size = 10) => {
              const out: string[][] = [];
              for (let i = 0; i < arr.length; i += size)
                out.push(arr.slice(i, i + size));
              return out;
            };
            const chunks = chunk(vendorIds, 10);
            for (const c of chunks) {
              const q = query(
                collection(db, "inventory_candies_sellers"),
                where("sellerId", "in", c),
              );
              const snap = await getDocs(q);
              snap.forEach((d) => {
                const x = d.data() as any;
                const sid = String(x.sellerId || "").trim();
                if (!sid) return;
                map[sid] = map[sid] || {};
                const pname = String(
                  x.productName || x.productName?.toString() || "",
                );
                const key = pname ? normKey(pname) : String(x.productId || "");
                const explicit = Number(
                  x.uvXpaq ?? x.uvxpaq ?? x.uVxPaq ?? NaN,
                );
                let val = NaN as number;
                if (Number.isFinite(explicit)) val = explicit;
                else {
                  const gross = Number(x.grossProfit ?? x.gainVendor ?? 0);
                  const packs = Math.max(1, Number(x.packages ?? 0));
                  val = packs > 0 ? gross / packs : 0;
                }
                map[sid][key] = Number(val || 0);
              });
            }
          }
          setUvxpaqMap(map);
        } catch (e) {
          setUvxpaqMap({});
        }

        // ventas (dulces)
        const sSnap = await getDocs(
          query(collection(db, "sales_candies"), orderBy("createdAt", "desc")),
        );
        const list: SaleDoc[] = [];
        sSnap.forEach((d) => {
          const x = normalizeSale(d.data(), d.id);
          if (!x) return;
          if (x.date >= fromDate && x.date <= toDate) list.push(x);
        });
        setSales(list.sort((a, b) => b.date.localeCompare(a.date)));
        setPage(1);
      } catch (e) {
        console.error(e);
        setMsg("❌ Error cargando transacciones.");
      } finally {
        setLoading(false);
      }
    })();
  }, [fromDate, toDate]);

  // === Filtros de tabla (cliente / tipo / vendedor) ===
  const filteredSales = useMemo(() => {
    return sales.filter((s) => {
      // Filtro por vendedor cuando es vendedor de dulces
      if (isVendor) {
        if (!sellerCandyId) return false;
        if (!s.vendorId || s.vendorId !== sellerCandyId) return false;
      }
      // Filtro por vendedor desde el selector (admin/visor)
      if (filterSellerId) {
        if (!s.vendorId || s.vendorId !== filterSellerId) return false;
      }
      if (filterCustomerId) {
        if (s.customerId !== filterCustomerId) return false;
      }
      if (filterType) {
        if (s.type !== filterType) return false;
      }
      if (filterProduct) {
        if (!s.productNames || !s.productNames.includes(filterProduct))
          return false;
      }
      return true;
    });
  }, [
    sales,
    filterCustomerId,
    filterType,
    filterProduct,
    filterSellerId,
    isVendor,
    sellerCandyId,
  ]);

  // KPIs sobre resultado filtrado (cantidad = paquetes)
  const kpis = useMemo(() => {
    let packsCash = 0,
      packsCredito = 0,
      montoCash = 0,
      montoCredito = 0,
      comisionCash = 0,
      comisionCredito = 0;
    for (const s of filteredSales) {
      if (s.type === "CONTADO") {
        packsCash += s.quantity;
        montoCash += s.total;
        comisionCash += getCommissionAmount(s);
      } else {
        packsCredito += s.quantity;
        montoCredito += s.total;
        comisionCredito += getCommissionAmount(s);
      }
    }
    return {
      packsCash,
      packsCredito,
      montoCash,
      montoCredito,
      comisionCash,
      comisionCredito,
    };
  }, [filteredSales]);

  // page slices
  const totalPages = Math.max(1, Math.ceil(filteredSales.length / PAGE_SIZE));
  const paged = useMemo(() => {
    const start = (page - 1) * PAGE_SIZE;
    return filteredSales.slice(start, start + PAGE_SIZE);
  }, [filteredSales, page]);

  const cashPaged = useMemo(
    () => paged.filter((s) => s.type === "CONTADO"),
    [paged],
  );
  const creditPaged = useMemo(
    () => paged.filter((s) => s.type === "CREDITO"),
    [paged],
  );

  // venta actual del modal (para mostrar comisión en el detalle)
  const modalSale = useMemo(
    () =>
      itemsModalSaleId
        ? sales.find((s) => s.id === itemsModalSaleId) || null
        : null,
    [itemsModalSaleId, sales],
  );

  // --------- Eliminar venta ---------
  const confirmDelete = async (s: SaleDoc) => {
    if (!canDelete) return;

    setOpenMenuId(null);
    if (
      !window.confirm(
        "¿Eliminar esta venta de dulces? Se restaurará el inventario asociado.",
      )
    )
      return;
    try {
      setLoading(true);
      const baseSaleId = s.id.split("#")[0];
      await restoreSaleAndDeleteCandy(baseSaleId);
      await deleteARMovesBySaleId(baseSaleId);

      setSales((prev) => prev.filter((x) => x.id !== s.id));
      setMsg("✅ Venta eliminada y saldo del cliente ajustado");
    } catch (e) {
      console.error(e);
      setMsg("❌ No se pudo eliminar la venta.");
    } finally {
      setLoading(false);
    }
  };

  // --------- Exportar PDF (usa ventas filtradas) ---------
  const handleExportPDF = () => {
    const title = `Ventas del dia — ${fromDate} a ${toDate}`;
    const esc = (s: string) =>
      (s || "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

    const rows = filteredSales
      .map((s) => {
        const name =
          s.customerName ||
          (s.customerId ? customersById[s.customerId] : "") ||
          "Nombre cliente";
        return `<tr>
          <td>${s.date}</td>
          <td>${esc(name)}</td>
          <td>${s.type === "CREDITO" ? "Crédito" : "Cash"}</td>
          <td style="text-align:right">${s.quantity}</td>
          <td style="text-align:right">${money(s.total)}</td>
        </tr>`;
      })
      .join("");

    const html = `<!doctype html><html><head><meta charset="utf-8" />
    <title>${esc(title)}</title>
    <style>
      *{font-family:Arial, sans-serif} h1{margin:0 0 8px}
      .muted{color:#555;font-size:12px;margin-bottom:12px}
      .kpis{display:grid;grid-template-columns:repeat(2,max-content);gap:8px 28px;margin:10px 0 14px}
      table{width:100%;border-collapse:collapse;font-size:12px}
      th,td{border:1px solid #ddd;padding:6px}
      th{background:#f5f5f5;text-align:left}
      @media print{@page{size:A4;margin:12mm}}
    </style></head><body>
      <h1>${esc(title)}</h1>
      <div class="kpis">
        <div><b>Paquetes Cash:</b> ${kpis.packsCash}</div>
        <div><b>Paquetes Crédito:</b> ${kpis.packsCredito}</div>
        <div><b>Monto Cash:</b> ${money(kpis.montoCash)}</div>
        <div><b>Monto Crédito:</b> ${money(kpis.montoCredito)}</div>
      </div>
      <table><thead><tr>
        <th>Fecha</th><th>Cliente</th><th>Tipo</th><th>Paquetes</th><th>Monto</th>
      </tr></thead><tbody>
      ${
        rows ||
        `<tr><td colspan="5" style="text-align:center">Sin transacciones</td></tr>`
      }
      </tbody></table>
      <script>window.print()</script>
    </body></html>`;

    const w = window.open("", "_blank");
    if (!w) return;
    w.document.open();
    w.document.write(html);
    w.document.close();
  };

  // --------- Paginador ---------
  const goFirst = () => setPage(1);
  const goPrev = () => setPage((p) => Math.max(1, p - 1));
  const goNext = () => setPage((p) => Math.min(totalPages, p + 1));
  const goLast = () => setPage(totalPages);

  const renderPager = () => {
    const pages: number[] = [];
    const maxBtns = 7;
    if (totalPages <= maxBtns) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      const left = Math.max(1, page - 2);
      const right = Math.min(totalPages, page + 2);
      pages.push(1);
      if (left > 2) pages.push(-1 as any);
      for (let i = left; i <= right; i++)
        if (i !== 1 && i !== totalPages) pages.push(i);
      if (right < totalPages - 1) pages.push(-2 as any);
      pages.push(totalPages);
    }

    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mt-3">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            className="px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
            onClick={goFirst}
            disabled={page === 1}
          >
            « Primero
          </button>
          <button
            className="px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
            onClick={goPrev}
            disabled={page === 1}
          >
            ‹ Anterior
          </button>
          {pages.map((p, idx) =>
            typeof p === "number" ? (
              <button
                key={idx}
                className={`px-3 py-1 rounded-md text-xs font-semibold border border-slate-200 ${
                  p === page ? "bg-blue-600 text-white border-blue-600" : ""
                }`}
                onClick={() => setPage(p)}
              >
                {p}
              </button>
            ) : (
              <span key={idx} className="px-2">
                …
              </span>
            ),
          )}
          <button
            className="px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
            onClick={goNext}
            disabled={page === totalPages}
          >
            Siguiente ›
          </button>
          <button
            className="px-2 py-1 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50 disabled:opacity-50"
            onClick={goLast}
            disabled={page === totalPages}
          >
            Último »
          </button>
        </div>
        <div className="text-sm text-slate-600">
          Página {page} de {totalPages} • {filteredSales.length} transacción(es)
        </div>
      </div>
    );
  };

  // ----------------- Render principal -----------------
  return (
    <div className="max-w-6xl mx-auto">
      <h2 className="text-xl font-bold mb-3">Ventas del dia</h2>

      {/* Filtros (colapsables) */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setFiltersCardOpen((prev) => !prev)}
          aria-expanded={filtersCardOpen}
        >
          <span>Filtros</span>
          <span
            className={`transition-transform ${filtersCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {filtersCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-3 items-end text-sm">
              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Desde
                </label>
                <input
                  type="date"
                  className="border rounded-md px-3 py-2 w-full"
                  value={fromDate}
                  onChange={(e) => {
                    setFromDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Hasta
                </label>
                <input
                  type="date"
                  className="border rounded-md px-3 py-2 w-full"
                  value={toDate}
                  onChange={(e) => {
                    setToDate(e.target.value);
                    setPage(1);
                  }}
                />
              </div>

              <div className="sm:col-span-2 lg:col-span-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Cliente (credito)
                </label>
                <select
                  className="border rounded-md px-3 py-2 w-full"
                  value={filterCustomerId}
                  onChange={(e) => {
                    setFilterCustomerId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  {customers.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="sm:col-span-2 lg:col-span-2">
                <label className="block text-xs font-semibold text-slate-700">
                  Vendedor
                </label>
                <select
                  className="border rounded-md px-3 py-2 w-full"
                  value={filterSellerId}
                  onChange={(e) => {
                    setFilterSellerId(e.target.value);
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  {sellers.map((v) => (
                    <option key={v.id} value={v.id}>
                      {v.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Tipo
                </label>
                <select
                  className="border rounded-md px-3 py-2 w-full"
                  value={filterType}
                  onChange={(e) => {
                    setFilterType(e.target.value as "" | SaleType);
                    setPage(1);
                  }}
                >
                  <option value="">Todos</option>
                  <option value="CONTADO">Cash</option>
                  <option value="CREDITO">Crédito</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700">
                  Producto
                </label>
                <select
                  className="border rounded-md px-3 py-2 w-full"
                  value={filterProduct}
                  onChange={(e) => {
                    setFilterProduct(e.target.value);
                    setPage(1);
                  }}
                  disabled={productOptions.length === 0}
                >
                  <option value="">Todos</option>
                  {productOptions.map((name) => (
                    <option key={name} value={name}>
                      {name}
                    </option>
                  ))}
                </select>
              </div>

              {isAdmin && (
                <>
                  <button
                    className="sm:col-span-2 lg:col-span-1 px-3 py-2 rounded-md text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 w-full"
                    onClick={handleExportPDF}
                  >
                    Exportar PDF
                  </button>
                  <button
                    className="sm:col-span-2 lg:col-span-1 px-3 py-2 rounded-md text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 w-full"
                    onClick={handleExportXLSXAllProducts}
                  >
                    Exportar Excel (Sábana)
                  </button>
                  <button
                    className="sm:col-span-2 lg:col-span-1 px-3 py-2 rounded-md text-xs font-semibold bg-yellow-500 text-white hover:bg-yellow-600 w-full"
                    onClick={() => handleBackfillMonth()}
                    title="Rellenar uvXpaq/upaquete en ventas del rango"
                  >
                    Backfill mes
                  </button>
                </>
              )}
            </div>
          </div>
        )}
      </div>

      {/* KPIs (colapsables) */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm mb-4">
        <button
          type="button"
          className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
          onClick={() => setKpisCardOpen((prev) => !prev)}
          aria-expanded={kpisCardOpen}
        >
          <span>Indicadores</span>
          <span
            className={`transition-transform ${kpisCardOpen ? "rotate-180" : ""}`}
          >
            ▼
          </span>
        </button>
        {kpisCardOpen && (
          <div className="p-4 border-t">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="p-3 border rounded-lg bg-slate-50">
                <div className="text-xs text-slate-600">Paquetes</div>
                <div className="text-xl font-semibold">
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-600">Cash</span>
                    <span>{kpis.packsCash}</span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-sm text-slate-600">Crédito</span>
                    <span>{kpis.packsCredito}</span>
                  </div>
                </div>
              </div>

              <div className="p-3 border rounded-lg bg-emerald-50 border-emerald-200">
                <div className="text-xs text-emerald-700">Monto</div>
                <div className="text-xl font-semibold">
                  <div className="flex justify-between">
                    <span className="text-sm text-emerald-700">Cash</span>
                    <span>{money(kpis.montoCash)}</span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-sm text-amber-700">Crédito</span>
                    <span>{money(kpis.montoCredito)}</span>
                  </div>
                </div>
              </div>

              <div className="p-3 border rounded-lg bg-slate-50">
                <div className="text-xs text-slate-600">Comisión</div>
                <div className="text-xl font-semibold">
                  <div className="flex justify-between">
                    <span className="text-sm text-slate-600">Cash</span>
                    <span>{money(kpis.comisionCash)}</span>
                  </div>
                  <div className="flex justify-between mt-1">
                    <span className="text-sm text-slate-600">Crédito</span>
                    <span>{money(kpis.comisionCredito)}</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* ===== MOBILE: Cards expandibles (sin perder datos) ===== */}
      <div className="block md:hidden space-y-3">
        {loading ? (
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            Cargando…
          </div>
        ) : paged.length === 0 ? (
          <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
            Sin transacciones en el rango.
          </div>
        ) : (
          <>
            <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                onClick={() => setCashCardOpen((prev) => !prev)}
                aria-expanded={cashCardOpen}
              >
                <span>Cash</span>
                <span
                  className={`transition-transform ${cashCardOpen ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
              </button>
              {cashCardOpen && (
                <div className="p-3 border-t space-y-3">
                  {cashPaged.length === 0 ? (
                    <div className="text-sm text-slate-500">
                      Sin transacciones cash.
                    </div>
                  ) : (
                    cashPaged.map((s) => {
                      const name =
                        s.customerName ||
                        (s.customerId ? customersById[s.customerId] : "") ||
                        "Nombre cliente";
                      const commissionAmount = getCommissionAmount(s);

                      return (
                        <div
                          key={s.id}
                          className="bg-white border border-slate-200 rounded-xl shadow-sm"
                        >
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-semibold truncate">
                                    {name}
                                  </div>
                                  <div className="text-xs text-slate-600 shrink-0">
                                    {s.date}
                                  </div>
                                </div>

                                <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                                  <span className="px-2 py-1 rounded-full border bg-emerald-50 border-emerald-200 text-emerald-700">
                                    Cash
                                  </span>

                                  <span className="text-slate-700">
                                    <b>Paquetes:</b>{" "}
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        openItemsModal(s.id);
                                      }}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>

                                  <span className="text-slate-700">
                                    <b>Monto:</b> {money(s.total)}
                                  </span>
                                </div>
                              </div>

                              <div className="text-slate-500 mt-1">
                                <span className="inline-block transition-transform group-open:rotate-180">
                                  ▼
                                </span>
                              </div>
                            </summary>

                            <div className="px-3 pb-3 pt-0 text-sm">
                              <div className="grid grid-cols-1 gap-2 border-t pt-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Cliente
                                  </span>
                                  <span className="font-medium text-right">
                                    {name}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Fecha</span>
                                  <span className="font-medium">{s.date}</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Tipo</span>
                                  <span className="font-medium">Cash</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Paquetes
                                  </span>
                                  <span className="font-medium">
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={() => openItemsModal(s.id)}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Monto</span>
                                  <span className="font-semibold">
                                    {money(s.total)}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Comision
                                  </span>
                                  <span className="font-medium">
                                    {commissionAmount > 0
                                      ? money(commissionAmount)
                                      : "—"}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Vendedor
                                  </span>
                                  <span className="font-medium">
                                    {s.vendorName || "—"}
                                  </span>
                                </div>

                                {canDelete && (
                                  <div className="pt-2 flex items-center justify-end gap-2">
                                    <button
                                      className="px-3 py-2 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50"
                                      onClick={() =>
                                        setOpenMenuId((prev) =>
                                          prev === s.id ? null : s.id,
                                        )
                                      }
                                    >
                                      ⋮ Acciones
                                    </button>

                                    {openMenuId === s.id && (
                                      <button
                                        className="px-3 py-2 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700"
                                        onClick={() => confirmDelete(s)}
                                      >
                                        Eliminar
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>

            <div className="bg-white border border-slate-200 rounded-xl shadow-sm">
              <button
                type="button"
                className="w-full flex items-center justify-between px-4 py-3 text-left text-sm font-semibold"
                onClick={() => setCreditCardOpen((prev) => !prev)}
                aria-expanded={creditCardOpen}
              >
                <span>Crédito</span>
                <span
                  className={`transition-transform ${creditCardOpen ? "rotate-180" : ""}`}
                >
                  ▼
                </span>
              </button>
              {creditCardOpen && (
                <div className="p-3 border-t space-y-3">
                  {creditPaged.length === 0 ? (
                    <div className="text-sm text-slate-500">
                      Sin transacciones crédito.
                    </div>
                  ) : (
                    creditPaged.map((s) => {
                      const name =
                        s.customerName ||
                        (s.customerId ? customersById[s.customerId] : "") ||
                        "Nombre cliente";
                      const commissionAmount = getCommissionAmount(s);

                      return (
                        <div
                          key={s.id}
                          className="bg-white border border-slate-200 rounded-xl shadow-sm"
                        >
                          <details className="group">
                            <summary className="list-none cursor-pointer p-3 flex items-start gap-3">
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center justify-between gap-2">
                                  <div className="font-semibold truncate">
                                    {name}
                                  </div>
                                  <div className="text-xs text-slate-600 shrink-0">
                                    {s.date}
                                  </div>
                                </div>

                                <div className="mt-1 flex items-center gap-2 flex-wrap text-xs">
                                  <span className="px-2 py-1 rounded-full border bg-amber-50 border-amber-200 text-amber-700">
                                    Crédito
                                  </span>

                                  <span className="text-slate-700">
                                    <b>Paquetes:</b>{" "}
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        openItemsModal(s.id);
                                      }}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>

                                  <span className="text-slate-700">
                                    <b>Monto:</b> {money(s.total)}
                                  </span>
                                </div>
                              </div>

                              <div className="text-slate-500 mt-1">
                                <span className="inline-block transition-transform group-open:rotate-180">
                                  ▼
                                </span>
                              </div>
                            </summary>

                            <div className="px-3 pb-3 pt-0 text-sm">
                              <div className="grid grid-cols-1 gap-2 border-t pt-3">
                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Cliente
                                  </span>
                                  <span className="font-medium text-right">
                                    {name}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Fecha</span>
                                  <span className="font-medium">{s.date}</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Tipo</span>
                                  <span className="font-medium">Crédito</span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Paquetes
                                  </span>
                                  <span className="font-medium">
                                    <button
                                      type="button"
                                      className="underline text-blue-600"
                                      onClick={() => openItemsModal(s.id)}
                                      title="Ver detalle"
                                    >
                                      {s.quantity}
                                    </button>
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">Monto</span>
                                  <span className="font-semibold">
                                    {money(s.total)}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Comision
                                  </span>
                                  <span className="font-medium">
                                    {commissionAmount > 0
                                      ? money(commissionAmount)
                                      : "—"}
                                  </span>
                                </div>

                                <div className="flex items-center justify-between">
                                  <span className="text-slate-600">
                                    Vendedor
                                  </span>
                                  <span className="font-medium">
                                    {s.vendorName || "—"}
                                  </span>
                                </div>

                                {canDelete && (
                                  <div className="pt-2 flex items-center justify-end gap-2">
                                    <button
                                      className="px-3 py-2 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50"
                                      onClick={() =>
                                        setOpenMenuId((prev) =>
                                          prev === s.id ? null : s.id,
                                        )
                                      }
                                    >
                                      ⋮ Acciones
                                    </button>

                                    {openMenuId === s.id && (
                                      <button
                                        className="px-3 py-2 rounded-md text-xs font-semibold bg-red-600 text-white hover:bg-red-700"
                                        onClick={() => confirmDelete(s)}
                                      >
                                        Eliminar
                                      </button>
                                    )}
                                  </div>
                                )}
                              </div>
                            </div>
                          </details>
                        </div>
                      );
                    })
                  )}
                </div>
              )}
            </div>
          </>
        )}

        <div className="bg-white p-3 rounded-xl shadow-sm border border-slate-200">
          {renderPager()}
        </div>
      </div>

      {/* ===== DESKTOP: Tabla original ===== */}
      <div className="hidden md:block bg-white rounded-xl shadow-sm border border-slate-200 w-full overflow-x-auto">
        <table className="min-w-full w-full text-sm">
          <thead className="bg-slate-100 sticky top-0 z-10">
            <tr className="text-[11px] uppercase tracking-wider text-slate-600">
              <th className="p-3 border-b text-left">Fecha</th>
              <th className="p-3 border-b text-left">Cliente</th>
              <th className="p-3 border-b text-left">Tipo</th>
              <th className="p-3 border-b text-right">Paquetes</th>
              <th className="p-3 border-b text-right">Monto</th>
              <th className="p-3 border-b text-right">Comision</th>
              <th className="p-3 border-b text-left">Vendedor</th>
              {canDelete && (
                <th className="p-3 border-b text-right">Acciones</th>
              )}
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td className="p-4 text-center" colSpan={columnsCount}>
                  Cargando…
                </td>
              </tr>
            ) : paged.length === 0 ? (
              <tr>
                <td className="p-4 text-center" colSpan={columnsCount}>
                  Sin transacciones en el rango.
                </td>
              </tr>
            ) : (
              paged.map((s) => {
                const name =
                  s.customerName ||
                  (s.customerId ? customersById[s.customerId] : "") ||
                  "Nombre cliente";
                const commissionAmount = getCommissionAmount(s);

                return (
                  <tr key={s.id} className="odd:bg-white even:bg-slate-50">
                    <td className="p-3 border-b text-left">{s.date}</td>
                    <td className="p-3 border-b text-left">{name}</td>
                    <td className="p-3 border-b text-left">
                      {s.type === "CREDITO" ? "Crédito" : "Cash"}
                    </td>
                    <td className="p-3 border-b text-right">
                      <button
                        type="button"
                        className="underline text-blue-600 hover:text-blue-800"
                        title="Ver detalle de productos de esta venta"
                        onClick={() => openItemsModal(s.id)}
                      >
                        {s.quantity}
                      </button>
                    </td>
                    <td className="p-3 border-b text-right">
                      {money(s.total)}
                    </td>
                    <td className="p-3 border-b text-right">
                      {commissionAmount > 0 ? money(commissionAmount) : "—"}
                    </td>
                    <td className="p-3 border-b text-left">
                      {s.vendorName || "—"}
                    </td>

                    {canDelete && (
                      <td className="p-3 border-b relative text-right">
                        <button
                          className="px-3 py-1.5 rounded-md text-xs font-semibold border border-slate-200 hover:bg-slate-50"
                          onClick={() =>
                            setOpenMenuId((prev) =>
                              prev === s.id ? null : s.id,
                            )
                          }
                          title="Acciones"
                        >
                          ⋮
                        </button>
                        {openMenuId === s.id && (
                          <div className="absolute right-2 mt-1 w-32 bg-white border border-slate-200 rounded-md shadow z-10 text-left">
                            <button
                              className="block w-full text-left px-3 py-2 hover:bg-slate-50 text-red-600 text-xs font-semibold"
                              onClick={() => confirmDelete(s)}
                            >
                              Eliminar
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })
            )}
          </tbody>
        </table>

        {/* Paginación */}
        {renderPager()}
      </div>

      {msg && <p className="mt-2 text-sm">{msg}</p>}

      {/* Modal: Detalle de piezas de la venta */}
      {itemsModalOpen && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-[60]">
          <div className="bg-white rounded-2xl shadow-xl border border-slate-200 w-[98%] max-w-5xl p-6 max-h-[90vh] overflow-auto md:max-h-none md:overflow-visible">
            <div className="flex items-center justify-between mb-2">
              <div>
                <h3 className="text-lg font-bold">
                  Productos/paquetes vendidos{" "}
                  {itemsModalSaleId ? `— #${itemsModalSaleId}` : ""}
                </h3>

                {modalSale && (
                  <div className="text-sm text-slate-700 mt-1">
                    Fecha de venta:{" "}
                    <span className="font-semibold">{modalSale.date}</span>
                  </div>
                )}

                {modalSale && (
                  <div className="text-sm text-slate-700 mt-1">
                    Comisión de vendedor:{" "}
                    <span className="font-semibold">
                      {getCommissionAmount(modalSale) > 0
                        ? money(getCommissionAmount(modalSale))
                        : "—"}
                    </span>
                  </div>
                )}
              </div>

              <button
                className="px-3 py-1 rounded-md text-xs font-semibold bg-slate-200 text-slate-700 hover:bg-slate-300"
                onClick={() => setItemsModalOpen(false)}
              >
                Cerrar
              </button>
            </div>

            <div className="bg-white rounded-xl border border-slate-200 overflow-x-auto overflow-y-auto max-h-[60vh] md:max-h-none">
              <table className="min-w-full text-sm">
                <thead className="bg-slate-100 sticky top-0 z-10">
                  <tr className="text-[11px] uppercase tracking-wider text-slate-600">
                    <th className="p-3 border-b text-left">Producto</th>
                    <th className="p-3 border-b text-right">Paquetes</th>
                    <th className="p-3 border-b text-right">Precio</th>
                    <th className="p-3 border-b text-right">Descuento</th>
                    <th className="p-3 border-b text-right">Monto</th>
                    <th className="p-3 border-b text-right">Comision</th>
                  </tr>
                </thead>
                <tbody>
                  {itemsModalLoading ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
                        Cargando…
                      </td>
                    </tr>
                  ) : itemsModalRows.length === 0 ? (
                    <tr>
                      <td colSpan={6} className="p-4 text-center">
                        Sin ítems en esta venta.
                      </td>
                    </tr>
                  ) : (
                    itemsModalRows.map((it, idx) => (
                      <tr key={idx} className="odd:bg-white even:bg-slate-50">
                        <td className="p-3 border-b text-left">
                          {it.productName}
                        </td>
                        <td className="p-3 border-b text-right">{it.qty}</td>
                        <td className="p-3 border-b text-right">
                          {money(it.unitPrice)}
                        </td>
                        <td className="p-3 border-b text-right">
                          {money(it.discount || 0)}
                        </td>
                        <td className="p-3 border-b text-right">
                          {money(it.total)}
                        </td>
                        <td className="p-3 border-b text-right">
                          {money(it.commission || 0)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
