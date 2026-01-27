// src/Services/inventory_candies.ts
import { db } from "../firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

/** Estructura de allocation para dulces (unidades enteras, inventario general) */
export interface CandyAllocation {
  batchId: string;
  qty: number; // unidades consumidas de ese lote
  batchDate?: string; // opcional, informativo
  productName?: string; // opcional, informativo
}

/**
 * Helper: obtiene la cantidad TOTAL de unidades del lote
 * usando los campos que realmente usas en dulces.
 */
function getBaseUnitsFromDoc(data: any): number {
  const unitsPerPackage = Math.max(
    1,
    Math.floor(Number(data.unitsPerPackage || 1)),
  );
  const totalUnits = Number(data.totalUnits || 0);
  const quantity = Number(data.quantity || 0);
  const packages = Number(data.packages || 0);

  // 1) Si hay totalUnits, lo usamos
  if (totalUnits > 0) return Math.floor(totalUnits);

  // 2) Si hay quantity, lo usamos
  if (quantity > 0) return Math.floor(quantity);

  // 3) Si hay packages, calculamos
  if (packages > 0) return Math.floor(packages * unitsPerPackage);

  // 4) Fallback
  return 0;
}

/**
 * Helper: obtiene las unidades restantes reales de un lote
 * priorizando `remaining`, si no, usando baseUnits.
 */
function getRemainingUnitsFromDoc(data: any): number {
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.floor(remainingField);
  }
  // Si no hay remaining, usamos todas las unidades base
  return getBaseUnitsFromDoc(data);
}

const toInt = (v: any) => Math.max(0, Math.floor(Number(v ?? 0)));
export function getInitialPacksFromDoc(x: any) {
  // ✅ en inventory_candies el “inicial” es packages
  return toInt(
    x.packages ??
      x.totalPackages ??
      x.packs ??
      x.packagesInitial ??
      x.initialPackages ??
      0,
  );
}

/** Packs iniciales “reales” del lote */
// function getInitialPacksFromDoc(data: any): number {
//   const unitsPerPackage = Math.max(
//     1,
//     Math.floor(Number(data.unitsPerPackage || 1))
//   );
//   const totalUnits = getBaseUnitsFromDoc(data);
//   if (totalUnits > 0 && unitsPerPackage > 0) {
//     return Math.floor(totalUnits / unitsPerPackage);
//   }
//   return Math.max(0, Math.floor(Number(data.packages || 0)));
// }

/** Packs restantes “reales” del lote */
// function getRemainingPacksFromDoc(data: any): number {
//   if (
//     typeof data.remainingPackages === "number" &&
//     isFinite(data.remainingPackages)
//   ) {
//     return Math.max(0, Math.floor(Number(data.remainingPackages)));
//   }
//   const unitsPerPackage = Math.max(
//     1,
//     Math.floor(Number(data.unitsPerPackage || 1))
//   );
//   const remUnits = getRemainingUnitsFromDoc(data);
//   return Math.max(0, Math.floor(remUnits / unitsPerPackage));
// }

export function getRemainingPacksFromDoc(x: any) {
  // ✅ en inventory_candies el restante correcto es remainingPackages
  return toInt(
    x.remainingPackages ??
      x.remainingPacks ??
      x.packsRemaining ??
      x.packagesRemaining ??
      x.remaining_packages ??
      0,
  );
}

/* -------------------------------------------------------------------------- */
/*  SYNC ORDEN MAESTRA (candy_main_orders)                                    */
/* -------------------------------------------------------------------------- */

/**
 * Busca doc de candy_main_orders por:
 * 1) id == orderId
 * 2) where("orderId","==",orderId)
 */
async function resolveCandyMainOrderRef(orderId: string) {
  const directRef = doc(db, "candy_main_orders", orderId);
  const directSnap = await getDoc(directRef);
  if (directSnap.exists()) return directRef;

  const q = query(
    collection(db, "candy_main_orders"),
    where("orderId", "==", orderId),
  );
  const s = await getDocs(q);
  if (!s.empty) return doc(db, "candy_main_orders", s.docs[0].id);

  return null;
}

/**
 * Recalcula TODA la orden maestra a partir de los lotes reales de inventory_candies con ese orderId.
 * - Agrupa por productId.
 * - Suma paquetes iniciales y restantes.
 * - Suma subtotal/total/gain por ítem usando los valores guardados por lote.
 * - Recalcula totales generales de la orden.
 */
export async function syncCandyMainOrderFromInventory(orderId: string) {
  if (!orderId) return;

  const orderRef = await resolveCandyMainOrderRef(orderId);
  if (!orderRef) return; // si no existe orden maestra, no hacemos nada

  // Traer TODOS los lotes de esa orden
  const qB = query(
    collection(db, "inventory_candies"),
    where("orderId", "==", orderId),
  );
  const snap = await getDocs(qB);

  // Si no hay lotes, dejamos la orden con items vacíos / totales en 0 (o no tocamos si preferís)
  const byProduct = new Map<
    string,
    {
      productId: string;
      name: string;
      category: string;
      unitsPerPackage: number;
      providerPrice: number; // referencia (último)
      marginRivas?: number;
      marginSanJorge?: number;
      marginIsla?: number;

      packages: number;
      remainingPackages: number;

      subtotal: number;
      totalRivas: number;
      totalSanJorge: number;
      totalIsla: number;

      unitPriceRivas: number;
      unitPriceSanJorge: number;
      unitPriceIsla: number;

      gainRivas: number;
      gainSanJorge: number;
      gainIsla: number;
    }
  >();

  snap.forEach((d) => {
    const x = d.data() as any;

    const productId = String(x.productId || "");
    if (!productId) return;

    const packsInitial = getInitialPacksFromDoc(x);
    const packsRemaining = getRemainingPacksFromDoc(x);

    const unitsPerPackage = Math.max(
      1,
      Math.floor(Number(x.unitsPerPackage || 1)),
    );

    const providerPrice = Number(x.providerPrice || 0);
    const unitPriceRivas = Number(x.unitPriceRivas || 0);
    const unitPriceSanJorge = Number(x.unitPriceSanJorge || 0);
    const unitPriceIsla = Number(x.unitPriceIsla || 0);

    const subtotalLot = providerPrice * packsInitial;
    const totalRivasLot = unitPriceRivas * packsInitial;
    const totalSanJorgeLot = unitPriceSanJorge * packsInitial;
    const totalIslaLot = unitPriceIsla * packsInitial;

    const gainRivasLot = totalRivasLot - subtotalLot;
    const gainSanJorgeLot = totalSanJorgeLot - subtotalLot;
    const gainIslaLot = totalIslaLot - subtotalLot;

    if (!byProduct.has(productId)) {
      byProduct.set(productId, {
        productId,
        name: String(x.productName || ""),
        category: String(x.category || ""),
        unitsPerPackage,

        providerPrice, // referencia (último lote que pase)
        marginRivas:
          typeof x.marginRivas === "number" ? Number(x.marginRivas) : undefined,
        marginSanJorge:
          typeof x.marginSanJorge === "number"
            ? Number(x.marginSanJorge)
            : undefined,
        marginIsla:
          typeof x.marginIsla === "number" ? Number(x.marginIsla) : undefined,

        packages: 0,
        remainingPackages: 0,

        subtotal: 0,
        totalRivas: 0,
        totalSanJorge: 0,
        totalIsla: 0,

        unitPriceRivas: unitPriceRivas || 0,
        unitPriceSanJorge: unitPriceSanJorge || 0,
        unitPriceIsla: unitPriceIsla || 0,

        gainRivas: 0,
        gainSanJorge: 0,
        gainIsla: 0,
      });
    }

    const acc = byProduct.get(productId)!;

    // paquetes
    acc.packages += packsInitial;
    acc.remainingPackages += packsRemaining;

    // totales reales (por lote)
    acc.subtotal += subtotalLot;
    acc.totalRivas += totalRivasLot;
    acc.totalSanJorge += totalSanJorgeLot;
    acc.totalIsla += totalIslaLot;

    acc.gainRivas += gainRivasLot;
    acc.gainSanJorge += gainSanJorgeLot;
    acc.gainIsla += gainIslaLot;

    // “último” (referencia visual)
    acc.providerPrice = providerPrice;
    acc.unitPriceRivas = unitPriceRivas || acc.unitPriceRivas;
    acc.unitPriceSanJorge = unitPriceSanJorge || acc.unitPriceSanJorge;
    acc.unitPriceIsla = unitPriceIsla || acc.unitPriceIsla;
    acc.unitsPerPackage = unitsPerPackage || acc.unitsPerPackage;
    acc.name = String(x.productName || acc.name);
    acc.category = String(x.category || acc.category);
  });

  const items = Array.from(byProduct.values()).map((p) => ({
    id: p.productId, // en tu schema items[] usás id(productId)
    name: p.name,
    category: p.category,
    providerPrice: p.providerPrice,
    unitsPerPackage: p.unitsPerPackage,
    packages: p.packages,
    remainingPackages: p.remainingPackages,

    // si vos guardás márgenes en la orden maestra:
    marginRivas: p.marginRivas ?? undefined,
    marginSanJorge: p.marginSanJorge ?? undefined,
    marginIsla: p.marginIsla ?? undefined,

    subtotal: p.subtotal,
    totalRivas: p.totalRivas,
    totalSanJorge: p.totalSanJorge,
    totalIsla: p.totalIsla,

    unitPriceRivas: p.unitPriceRivas,
    unitPriceSanJorge: p.unitPriceSanJorge,
    unitPriceIsla: p.unitPriceIsla,

    gainRivas: p.gainRivas,
    gainSanJorge: p.gainSanJorge,
    gainIsla: p.gainIsla,
  }));

  const totalPackages = items.reduce(
    (a, it: any) => a + Number(it.packages || 0),
    0,
  );

  await updateDoc(orderRef, {
    totalPackages,
    items,
  });
}

/** Crea un lote (entrada) en inventory_candies
 *  quantity = unidades ingresadas (no paquetes)
 */
export async function newCandyBatch(payload: {
  productId: string;
  productName: string;
  quantity: number; // unidades ingresadas
  salePrice: number; // precio de venta unitario (referencial)
  date: string; // yyyy-MM-dd
  notes?: string;
}) {
  const baseUnits = Math.max(0, Math.floor(Number(payload.quantity || 0)));
  const data = {
    ...payload,
    quantity: baseUnits,
    totalUnits: baseUnits,
    remaining: baseUnits,
    createdAt: Timestamp.now(),
  };
  return addDoc(collection(db, "inventory_candies"), data);
}

/** Obtiene stock (total y desglose por lote con remaining>0) en UNIDADES */
export async function getCandyStockByProduct(productId: string) {
  const q = query(
    collection(db, "inventory_candies"),
    where("productId", "==", productId),
    where("remaining", ">", 0),
  );
  const snap = await getDocs(q);
  let total = 0;
  const batches: Array<{ id: string; date: string; remaining: number }> = [];
  snap.forEach((d) => {
    const b = d.data() as any;
    const rem = getRemainingUnitsFromDoc(b);
    if (rem <= 0) return;
    total += rem;
    batches.push({ id: d.id, date: String(b.date || ""), remaining: rem });
  });

  // FIFO lo resolvés manualmente con sort al consumir, así que acá no forzamos orderBy
  batches.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  return { total, batches };
}

/**
 * FIFO en cascada para DULCES (inventario general).
 *
 * ✅ Soporta VENTA POR PAQUETES/BOLSAS:
 *  - quantityPacks = cantidad vendida en paquetes/bolsas.
 *  - Usa unitsPerPackage de los lotes para convertir a UNIDADES.
 *
 * 🔁 Compatibilidad:
 *  - Si NO se envía quantityPacks, usa quantity (unidades) como antes.
 *
 * Devuelve allocations por lote en UNIDADES.
 */
export async function allocateSaleFIFOCandy(params: {
  productId: string;
  /** cantidad en paquetes/bolsas (preferido) */
  quantityPacks?: number;
  /** LEGACY: cantidad en unidades (si no pasás quantityPacks) */
  quantity?: number;
  saleDate: string; // yyyy-MM-dd
  saleId?: string; // opcional: para registrar allocations en colección
}) {
  const { productId, saleDate, saleId } = params;

  const packsRaw = params.quantityPacks;
  const unitsRaw = params.quantity;

  if (!productId) {
    throw new Error(
      "Parámetros inválidos para allocateSaleFIFOCandy (sin producto)",
    );
  }

  const qB = query(
    collection(db, "inventory_candies"),
    where("productId", "==", productId),
  );
  const snap = await getDocs(qB);

  if (snap.empty) {
    throw new Error("No hay inventario para este producto.");
  }

  // Orden FIFO por fecha asc y desempate por createdAt
  const docsSorted = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as any }))
    .sort((a, b) => {
      const da = String(a.data.date || "");
      const dbs = String(b.data.date || "");
      if (da !== dbs) return da < dbs ? -1 : 1;
      const ca = a.data.createdAt?.seconds ?? 0;
      const cb = b.data.createdAt?.seconds ?? 0;
      return ca - cb;
    });

  // Calculamos unitsPerPackage "estándar" para el producto
  let unitsPerPackage = 0;
  for (const d of docsSorted) {
    const upp = Number(d.data.unitsPerPackage ?? 0);
    if (upp > 0) {
      unitsPerPackage = upp;
      break;
    }
  }
  // Fallback: intentar inferirlo (totalUnits / packages)
  if (!unitsPerPackage) {
    for (const d of docsSorted) {
      const x = d.data as any;
      const totalUnits = Number(x.totalUnits ?? 0);
      const packs = Number(x.packages ?? 0);
      if (totalUnits > 0 && packs > 0) {
        unitsPerPackage = totalUnits / packs;
        break;
      }
    }
  }
  if (!unitsPerPackage) unitsPerPackage = 1;

  // 2) Determinar UNIDADES necesarias
  let needTotalUnits: number;

  if (packsRaw != null && !Number.isNaN(Number(packsRaw))) {
    const packs = Math.max(0, Math.floor(Number(packsRaw)));
    if (packs <= 0)
      throw new Error("La cantidad en paquetes debe ser mayor que cero.");
    needTotalUnits = packs * unitsPerPackage;
  } else {
    const qUnits = Math.max(0, Math.floor(Number(unitsRaw || 0)));
    if (qUnits <= 0) throw new Error("La cantidad debe ser mayor que cero.");
    needTotalUnits = qUnits;
  }

  const refs = docsSorted.map((d) => doc(db, "inventory_candies", d.id));
  const allocations: CandyAllocation[] = [];

  await runTransaction(db, async (tx) => {
    // Lecturas primero
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    let need = needTotalUnits;

    for (let i = 0; i < refs.length && need > 0; i++) {
      const ref = refs[i];
      const ds = snaps[i];
      if (!ds.exists()) continue;

      const data = ds.data() as any;

      const currentRem = getRemainingUnitsFromDoc(data);
      if (currentRem <= 0) continue;

      const take = Math.min(currentRem, need);
      const newRem = Math.max(0, currentRem - take);

      const unitsPerPackageLocal = Math.max(
        1,
        Math.floor(Number(data.unitsPerPackage || 1)),
      );
      const newRemainingPackages = Math.floor(newRem / unitsPerPackageLocal);

      tx.update(ref, {
        remaining: newRem,
        remainingPackages: newRemainingPackages,
        // compat: mantenemos packages alineado con remainingPackages
        packages: newRemainingPackages,
      });

      allocations.push({
        batchId: ref.id,
        qty: take,
        batchDate: String(data.date || ""),
        productName: String(data.productName || ""),
      });

      need -= take;
    }

    if (need > 0) {
      const missingPacks = Math.ceil(need / unitsPerPackage);
      throw new Error(
        `Inventario insuficiente. Faltan aproximadamente ${missingPacks} paquetes.`,
      );
    }

    // (Opcional) Registrar allocations por lote
    if (saleId) {
      for (const a of allocations) {
        await addDoc(collection(db, "batch_candies_allocations"), {
          saleId,
          saleDate,
          productId,
          productName: a.productName ?? "",
          batchId: a.batchId,
          batchDate: a.batchDate ?? "",
          quantity: a.qty, // UNIDADES
          createdAt: Timestamp.now(),
        });
      }
    }
  });

  return { allocations };
}

/* -------------------------------------------------------------------------- */
/*  RESTAURAR VENTA                                                           */
/* -------------------------------------------------------------------------- */

function extractSellerAllocationsFromSale(sale: any): {
  allocations: {
    inventorySellerId: string;
    units: number;
  }[];
} | null {
  const src = sale?.allocationsByItem;
  if (!src) return null;

  const result: { inventorySellerId: string; units: number }[] = [];

  if (Array.isArray(src)) {
    for (const entry of src) {
      const arr = Array.isArray(entry?.allocations) ? entry.allocations : [];
      for (const a of arr) {
        const invId = String(a.inventorySellerId || "");
        const units = Math.max(
          0,
          Math.floor(Number(a.units ?? a.qty ?? a.quantity ?? 0)),
        );
        if (!invId || units <= 0) continue;
        result.push({ inventorySellerId: invId, units });
      }
    }
  } else if (typeof src === "object") {
    for (const key of Object.keys(src)) {
      const entry = src[key];
      const arr = Array.isArray(entry?.allocations) ? entry.allocations : [];
      for (const a of arr) {
        const invId = String(a.inventorySellerId || "");
        const units = Math.max(
          0,
          Math.floor(Number(a.units ?? a.qty ?? a.quantity ?? 0)),
        );
        if (!invId || units <= 0) continue;
        result.push({ inventorySellerId: invId, units });
      }
    }
  }

  if (!result.length) return null;
  return { allocations: result };
}

export async function restoreSaleAndDeleteCandy(saleId: string) {
  const baseId = saleId.split("#")[0];
  const saleRef = doc(db, "sales_candies", baseId);
  const saleSnap = await getDoc(saleRef);
  if (!saleSnap.exists()) throw new Error("La venta no existe.");

  const sale = saleSnap.data() as any;

  // 1) Restaurar pedido vendedor (nuevo POS)
  const sellerAlloc = extractSellerAllocationsFromSale(sale);

  if (sellerAlloc && sellerAlloc.allocations.length > 0) {
    let restoredUnits = 0;

    await runTransaction(db, async (tx) => {
      const grouped: Record<string, number> = {};
      for (const a of sellerAlloc.allocations) {
        const id = a.inventorySellerId;
        const units = Math.max(0, Math.floor(Number(a.units || 0)));
        if (!id || units <= 0) continue;
        grouped[id] = (grouped[id] || 0) + units;
        restoredUnits += units;
      }

      const ids = Object.keys(grouped);
      const refs = ids.map((id) => doc(db, "inventory_candies_sellers", id));
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));

      for (let i = 0; i < refs.length; i++) {
        const snap = snaps[i];
        if (!snap.exists()) continue;
        const data = snap.data() as any;

        const currentUnits = Number(data.remainingUnits ?? data.remaining ?? 0);
        const addBack = Math.max(
          0,
          Math.floor(Number(grouped[refs[i].id] || 0)),
        );
        const newUnits = currentUnits + addBack;

        const unitsPerPackage = Math.max(
          1,
          Math.floor(Number(data.unitsPerPackage || 1)),
        );
        const newRemainingPackages = Math.floor(newUnits / unitsPerPackage);

        tx.update(refs[i], {
          remainingUnits: newUnits,
          remainingPackages: newRemainingPackages,
        });
      }

      tx.delete(saleRef);
    });

    return { restored: restoredUnits };
  }

  // 2) Legacy: restaurar inventory_candies
  const items: Array<{
    productId: string;
    productName?: string;
    qty: number;
    allocations?: CandyAllocation[];
  }> = [];

  if (Array.isArray(sale.items) && sale.items.length > 0) {
    const mapAlloc: Record<string, CandyAllocation[]> = {};

    if (sale.allocationsByItem && typeof sale.allocationsByItem === "object") {
      for (const key of Object.keys(sale.allocationsByItem)) {
        const entry = sale.allocationsByItem[key];
        const pId = String(entry?.productId || key || "");
        if (!pId) continue;
        const arr = Array.isArray(entry?.allocations) ? entry.allocations : [];
        mapAlloc[pId] = arr.map((a: any) => ({
          batchId: String(a.batchId),
          qty: Math.max(0, Math.floor(Number(a.qty || a.quantity || 0))),
        }));
      }
    }

    if (Array.isArray(sale.allocationsByItem)) {
      for (const e of sale.allocationsByItem) {
        const pId = String(e?.productId || "");
        if (!pId) continue;
        const arr = Array.isArray(e?.allocations) ? e.allocations : [];
        mapAlloc[pId] = arr.map((a: any) => ({
          batchId: String(a.batchId),
          qty: Math.max(0, Math.floor(Number(a.qty || a.quantity || 0))),
        }));
      }
    }

    for (const it of sale.items) {
      const productId = String(it?.productId || "");
      if (!productId) continue;
      const qty = Math.max(0, Math.floor(Number(it?.qty || it?.quantity || 0)));

      const allocsFromItem = Array.isArray(it?.allocations)
        ? it.allocations.map((a: any) => ({
            batchId: String(a.batchId),
            qty: Math.max(0, Math.floor(Number(a.qty || a.quantity || 0))),
          }))
        : mapAlloc[productId] || [];

      items.push({
        productId,
        productName: String(it?.productName || ""),
        qty,
        allocations: allocsFromItem.length ? allocsFromItem : undefined,
      });
    }
  } else {
    const item = sale.item || {};
    const productId: string = String(item.productId || sale.productId || "");
    const qtyTotal: number = Math.max(
      0,
      Math.floor(Number(item.qty ?? sale.quantity ?? 0)),
    );
    const allocationsInSale: CandyAllocation[] = Array.isArray(sale.allocations)
      ? sale.allocations.map((a: any) => ({
          batchId: String(a.batchId),
          qty: Math.max(0, Math.floor(Number(a.qty || a.quantity || 0))),
        }))
      : [];

    if (productId && qtyTotal > 0) {
      items.push({
        productId,
        productName: String(item.productName || sale.productName || ""),
        qty: qtyTotal,
        allocations: allocationsInSale.length ? allocationsInSale : undefined,
      });
    }
  }

  if (items.length === 0) {
    await runTransaction(db, async (tx) => {
      tx.delete(saleRef);
    });
    return { restored: 0 };
  }

  const allHaveAllocations = items.every(
    (it) => Array.isArray(it.allocations) && it.allocations.length > 0,
  );

  if (allHaveAllocations) {
    let restored = 0;

    await runTransaction(db, async (tx) => {
      const refsToUpdate: Array<{ ref: any; addBack: number }> = [];
      for (const it of items) {
        for (const a of it.allocations || []) {
          const addBack = Math.max(0, Math.floor(Number(a.qty || 0)));
          restored += addBack;
          refsToUpdate.push({
            ref: doc(db, "inventory_candies", a.batchId),
            addBack,
          });
        }
      }

      const snaps = await Promise.all(refsToUpdate.map((x) => tx.get(x.ref)));

      for (let i = 0; i < refsToUpdate.length; i++) {
        const snap = snaps[i];
        if (!snap.exists()) continue;
        const data = snap.data() as any;
        const rem = getRemainingUnitsFromDoc(data);
        const addBack = Math.max(
          0,
          Math.floor(Number(refsToUpdate[i].addBack || 0)),
        );

        const newRem = rem + addBack;
        const unitsPerPackage = Math.max(
          1,
          Math.floor(Number(data.unitsPerPackage || 1)),
        );
        const newRemainingPackages = Math.floor(newRem / unitsPerPackage);

        tx.update(refsToUpdate[i].ref, {
          remaining: newRem,
          remainingPackages: newRemainingPackages,
          packages: newRemainingPackages,
        });
      }

      tx.delete(saleRef);
    });

    return { restored };
  }

  let restoredFallback = 0;

  await runTransaction(db, async (tx) => {
    const byProduct: Record<
      string,
      Array<{ id: string; date: string; baseUnits: number; remaining: number }>
    > = {};

    for (const it of items) {
      if (!it.productId || it.qty <= 0) continue;

      const qB = query(
        collection(db, "inventory_candies"),
        where("productId", "==", it.productId),
      );
      const snap = await getDocs(qB);
      const lots = snap.docs
        .map((d) => {
          const x = d.data() as any;
          const baseUnits = getBaseUnitsFromDoc(x);
          const remaining = getRemainingUnitsFromDoc(x);
          return { id: d.id, date: String(x.date || ""), baseUnits, remaining };
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      byProduct[it.productId] = lots;
    }

    const planUpdates: Array<{ id: string; addBack: number }> = [];

    for (const it of items) {
      if (!it.productId || it.qty <= 0) continue;

      if (Array.isArray(it.allocations) && it.allocations.length > 0) {
        for (const a of it.allocations) {
          const addBack = Math.max(0, Math.floor(Number(a.qty || 0)));
          restoredFallback += addBack;
          planUpdates.push({ id: a.batchId, addBack });
        }
        continue;
      }

      const lots = byProduct[it.productId] || [];
      let toReturn = it.qty;

      for (const lot of lots) {
        if (toReturn <= 0) break;
        const used = Math.max(0, lot.baseUnits - lot.remaining);
        if (used <= 0) continue;
        const addBack = Math.min(used, toReturn);
        planUpdates.push({ id: lot.id, addBack });
        restoredFallback += addBack;
        toReturn -= addBack;
      }

      for (const lot of lots) {
        if (toReturn <= 0) break;
        const addBack = Math.min(toReturn, it.qty);
        planUpdates.push({ id: lot.id, addBack });
        restoredFallback += addBack;
        toReturn -= addBack;
      }
    }

    const grouped: Record<string, number> = {};
    for (const p of planUpdates) {
      grouped[p.id] =
        (grouped[p.id] || 0) + Math.max(0, Math.floor(Number(p.addBack || 0)));
    }

    const refs = Object.keys(grouped).map((id) =>
      doc(db, "inventory_candies", id),
    );
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    for (let i = 0; i < refs.length; i++) {
      const snap = snaps[i];
      if (!snap.exists()) continue;
      const data = snap.data() as any;
      const rem = getRemainingUnitsFromDoc(data);
      const addBack = Math.max(0, Math.floor(Number(grouped[refs[i].id] || 0)));

      const newRem = rem + addBack;
      const unitsPerPackage = Math.max(
        1,
        Math.floor(Number(data.unitsPerPackage || 1)),
      );
      const newRemainingPackages = Math.floor(newRem / unitsPerPackage);

      tx.update(refs[i], {
        remaining: newRem,
        remainingPackages: newRemainingPackages,
        packages: newRemainingPackages,
      });
    }

    tx.delete(saleRef);
  });

  return { restored: restoredFallback };
}

/**
 * 🔁 Alias para compatibilidad:
 * CierreVentasDulces importa `restoreCandySaleAndDelete`,
 * así que lo exponemos como wrapper del nombre nuevo.
 */
export async function restoreCandySaleAndDelete(saleId: string) {
  return restoreSaleAndDeleteCandy(saleId);
}
