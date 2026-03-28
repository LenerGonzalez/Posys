/**
 * Propaga cambios de products_candies (nombre, categoría, precio proveedor, und/paq)
 * a current_prices, pedidos posibles, órdenes maestras, inventarios, ventas (sales_candies),
 * facturas guardadas (invoicesCandies) e inventory_*.
 */
import { db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";

const CANDY_POSSIBLE_ORDERS = "candy_possible_orders";

const MAX_MARGIN_PERCENT = 99.999;

function safeInt(v: any): number {
  return Math.max(0, Math.floor(Number(v) || 0));
}

function roundToInt(n: number): number {
  return Math.round(n || 0);
}

function deriveMarginPercentFromSubtotalAndTotal(
  subtotal: number,
  total: number,
): number {
  if (!Number.isFinite(total) || total <= 0) return 0;
  return Math.min(Math.max((1 - subtotal / total) * 100, 0), MAX_MARGIN_PERCENT);
}

/** Misma lógica que OrdenMaestra: precios de venta fijos por paquete + SJ por margen. */
function calcTotalsFromFixedPackageSalePrices(
  providerPriceNum: number,
  packagesNum: number,
  marginSanJorgePct: number,
  unitPriceRivasPerPkg: number,
  unitPriceIslaPerPkg: number,
) {
  const subtotalCalc = providerPriceNum * packagesNum;
  const limit = MAX_MARGIN_PERCENT;
  const mSJ = Math.min(Math.max(marginSanJorgePct, 0), limit) / 100;

  const totalR = unitPriceRivasPerPkg * packagesNum;
  const totalI = unitPriceIslaPerPkg * packagesNum;
  const totalSJ =
    packagesNum > 0 && mSJ < 1 ? subtotalCalc / (1 - mSJ) : subtotalCalc;

  const gainR = totalR - subtotalCalc;
  const gainSJ = totalSJ - subtotalCalc;
  const gainIO = totalI - subtotalCalc;

  const unitR = packagesNum > 0 ? roundToInt(totalR / packagesNum) : 0;
  const unitSJ = packagesNum > 0 ? roundToInt(totalSJ / packagesNum) : 0;
  const unitIO = packagesNum > 0 ? roundToInt(totalI / packagesNum) : 0;

  const marginR = deriveMarginPercentFromSubtotalAndTotal(
    subtotalCalc,
    totalR,
  );
  const marginIsla = deriveMarginPercentFromSubtotalAndTotal(
    subtotalCalc,
    totalI,
  );

  return {
    subtotal: subtotalCalc,
    totalRivas: totalR,
    totalSanJorge: totalSJ,
    totalIsla: totalI,
    gainRivas: gainR,
    gainSanJorge: gainSJ,
    gainIsla: gainIO,
    unitPriceRivas: unitR,
    unitPriceSanJorge: unitSJ,
    unitPriceIsla: unitIO,
    marginRivas: marginR,
    marginIsla: marginIsla,
  };
}

export type CatalogSyncFields = {
  name: string;
  category: string;
  providerPrice: number;
  unitsPerPackage: number;
};

function itemProductId(it: Record<string, any>): string {
  return String(it?.id ?? it?.productId ?? "").trim();
}

function catalogFieldsToItemPatch(fields: CatalogSyncFields) {
  const { name, category, providerPrice, unitsPerPackage } = fields;
  return {
    productName: name,
    name,
    category,
    providerPrice,
    providerPricePerPackage: providerPrice,
    unitsPerPackage,
  };
}

/** Actualiza ventas: items[], item suelto o campos raíz legacy con productId. */
function patchSalesDocData(
  data: Record<string, any>,
  pid: string,
  fields: CatalogSyncFields,
): Record<string, any> | null {
  const patch = catalogFieldsToItemPatch(fields);

  if (Array.isArray(data.items) && data.items.length > 0) {
    let changed = false;
    const next = data.items.map((it: any) => {
      if (itemProductId(it) !== pid) return it;
      changed = true;
      return { ...it, ...patch };
    });
    if (!changed) return null;
    return { items: next };
  }

  if (data.item && typeof data.item === "object") {
    if (itemProductId(data.item as Record<string, any>) !== pid) return null;
    return { item: { ...data.item, ...patch } };
  }

  if (String(data.productId || "").trim() === pid) {
    return { ...patch, productName: fields.name };
  }

  return null;
}

/** Líneas de factura guardada: solo nombre y und/paq (sin recalcular montos). */
function patchInvoiceDocData(
  data: Record<string, any>,
  pid: string,
  fields: CatalogSyncFields,
): Record<string, any> | null {
  const txs: any[] = Array.isArray(data.transactions) ? data.transactions : [];
  let changed = false;
  const next = txs.map((t: any) => {
    if (String(t?.productId || "").trim() !== pid) return t;
    changed = true;
    return {
      ...t,
      productName: fields.name,
      unitsPerPackage: fields.unitsPerPackage,
    };
  });
  if (!changed) return null;
  return { transactions: next };
}

export async function syncCatalogProductDependents(
  productId: string,
  fields: CatalogSyncFields,
): Promise<void> {
  const pid = String(productId || "").trim();
  if (!pid) return;

  const name = String(fields.name || "").trim();
  const category = String(fields.category || "").trim();
  const providerPrice = Math.max(0, Number(fields.providerPrice) || 0);
  const unitsPerPackage = Math.max(1, Math.floor(Number(fields.unitsPerPackage) || 1));

  let syncedPackagePriceIsla: number | null = null;

  // --- current_prices ---
  try {
    const priceRef = doc(db, "current_prices", pid);
    const priceSnap = await getDoc(priceRef);
    if (priceSnap.exists()) {
      const data = priceSnap.data() as Record<string, any>;
      const oldU = Math.max(
        1,
        Math.floor(
          Number(data.unitsPerPackage ?? data.unitsPerPack ?? 1) || 1,
        ),
      );
      let pkgI = Number(data.packagePriceIsla ?? NaN);
      let pkgR = Number(data.packagePriceRivas ?? NaN);
      if (!Number.isFinite(pkgI)) {
        const x = Number(data.unitPriceIsla ?? NaN);
        pkgI = Number.isFinite(x) ? x * oldU : 0;
      }
      if (!Number.isFinite(pkgR)) {
        const x = Number(data.unitPriceRivas ?? NaN);
        pkgR = Number.isFinite(x) ? x * oldU : 0;
      }
      const u = unitsPerPackage;
      await updateDoc(priceRef, {
        productName: name,
        category,
        unitsPerPackage: u,
        packagePriceIsla: pkgI,
        packagePriceRivas: pkgR,
        unitPriceIsla: u > 0 ? pkgI / u : 0,
        unitPriceRivas: u > 0 ? pkgR / u : 0,
        marginIsla: deriveMarginPercentFromSubtotalAndTotal(providerPrice, pkgI),
        marginRivas: deriveMarginPercentFromSubtotalAndTotal(providerPrice, pkgR),
      });
      syncedPackagePriceIsla = Number.isFinite(pkgI) ? pkgI : null;
    }
  } catch (e) {
    console.error("[syncCatalog] current_prices", e);
  }

  // --- candy_possible_orders (pedidos en borrador; alinea con Precio Isla paq. si hay current_prices) ---
  try {
    const poSnap = await getDocs(collection(db, CANDY_POSSIBLE_ORDERS));
    for (const d of poSnap.docs) {
      const data = d.data() as Record<string, any>;
      const items: any[] = Array.isArray(data.items) ? data.items : [];
      let changed = false;
      const nextItems = items.map((it) => {
        if (String(it?.productId || "").trim() !== pid) return it;
        changed = true;
        const qty = Math.max(0, Number(it.qtyPackages || 0));
        const priceIsla =
          syncedPackagePriceIsla != null &&
          Number.isFinite(syncedPackagePriceIsla)
            ? syncedPackagePriceIsla
            : Number(it.priceIsla || 0);
        const subtotal = qty * priceIsla;
        return {
          ...it,
          productName: name,
          category,
          unitsPerPackage,
          providerPrice,
          priceIsla,
          subtotal,
        };
      });
      if (!changed) continue;
      const packagesTotal = nextItems.reduce(
        (a, it) => a + Math.max(0, Number(it.qtyPackages || 0)),
        0,
      );
      const total = nextItems.reduce(
        (a, it) => a + Number(it.subtotal || 0),
        0,
      );
      await updateDoc(d.ref, {
        items: nextItems,
        packagesTotal,
        total,
        productsCount: nextItems.length,
      });
    }
  } catch (e) {
    console.error("[syncCatalog] candy_possible_orders", e);
  }

  // --- candy_main_orders (ítems con este productId) ---
  try {
    const ordersSnap = await getDocs(collection(db, "candy_main_orders"));
    for (const d of ordersSnap.docs) {
      const data = d.data() as Record<string, any>;
      const items: any[] = Array.isArray(data.items) ? data.items : [];
      let changed = false;
      const nextItems = items.map((it) => {
        if (itemProductId(it) !== pid) return it;
        changed = true;
        const packagesNum = safeInt(it.packages ?? 0);
        const merged = {
          ...it,
          name,
          category,
          providerPrice,
          unitsPerPackage,
        };
        const vals = calcTotalsFromFixedPackageSalePrices(
          providerPrice,
          packagesNum,
          Number(it.marginSanJorge ?? 0),
          Number(it.unitPriceRivas ?? 0),
          Number(it.unitPriceIsla ?? 0),
        );
        return { ...merged, ...vals };
      });
      if (changed) {
        await updateDoc(d.ref, { items: nextItems });
      }
    }
  } catch (e) {
    console.error("[syncCatalog] candy_main_orders", e);
  }

  // --- inventory_candies ---
  try {
    const invQ = query(
      collection(db, "inventory_candies"),
      where("productId", "==", pid),
    );
    const invSnap = await getDocs(invQ);
    for (const d of invSnap.docs) {
      const x = d.data() as Record<string, any>;
      const packages = Math.max(0, Math.floor(Number(x.packages || 0)));
      const remPk = Math.max(
        0,
        Math.floor(
          Number(
            x.remainingPackages ?? x.packages ?? 0,
          ),
        ),
      );
      const upp = unitsPerPackage;
      const totalUnits = packages * upp;
      const remainingUnits = remPk * upp;
      await updateDoc(d.ref, {
        productName: name,
        category,
        providerPrice,
        unitsPerPackage: upp,
        quantity: totalUnits,
        remaining: remainingUnits,
        totalUnits,
      });
    }
  } catch (e) {
    console.error("[syncCatalog] inventory_candies", e);
  }

  // --- inventory_candies_sellers (órdenes vendedor) ---
  try {
    const sellQ = query(
      collection(db, "inventory_candies_sellers"),
      where("productId", "==", pid),
    );
    const sellSnap = await getDocs(sellQ);
    for (const d of sellSnap.docs) {
      const x = d.data() as Record<string, any>;
      const packs = Math.max(0, Math.floor(Number(x.packages ?? 0)));
      const remPk = Math.max(
        0,
        Math.floor(
          Number(x.remainingPackages ?? x.packages ?? 0),
        ),
      );
      const upp = unitsPerPackage;
      const totalUnits = packs * upp;
      const remainingUnits = remPk * upp;
      await updateDoc(d.ref, {
        productName: name,
        category,
        providerPrice,
        unitsPerPackage: upp,
        totalUnits,
        remainingUnits,
      });
    }
  } catch (e) {
    console.error("[syncCatalog] inventory_candies_sellers", e);
  }

  // --- sales_candies (Cierre ventas, transacciones, estado cuenta, dashboard, consolidado, clientes) ---
  try {
    const salesSnap = await getDocs(collection(db, "sales_candies"));
    let batch = writeBatch(db);
    let batchOps = 0;
    for (const d of salesSnap.docs) {
      const patch = patchSalesDocData(d.data() as Record<string, any>, pid, fields);
      if (!patch) continue;
      batch.update(d.ref, patch);
      batchOps++;
      if (batchOps >= 400) {
        await batch.commit();
        batch = writeBatch(db);
        batchOps = 0;
      }
    }
    if (batchOps > 0) await batch.commit();
  } catch (e) {
    console.error("[syncCatalog] sales_candies", e);
  }

  // --- invoicesCandies (líneas embebidas; no recalcula totales de la factura) ---
  try {
    const invSnap = await getDocs(collection(db, "invoicesCandies"));
    for (const d of invSnap.docs) {
      const patch = patchInvoiceDocData(
        d.data() as Record<string, any>,
        pid,
        fields,
      );
      if (!patch) continue;
      await updateDoc(d.ref, patch);
    }
  } catch (e) {
    console.error("[syncCatalog] invoicesCandies", e);
  }
}
