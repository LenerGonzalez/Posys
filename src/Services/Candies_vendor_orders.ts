// src/Services/candies_vendor_orders.ts
import { db } from "../firebase";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  query,
  runTransaction,
  where,
  orderBy,
  Timestamp,
} from "firebase/firestore";

const floor = (n: any) => Math.max(0, Math.floor(Number(n || 0)));

function getUnitsPerPackage(x: any) {
  return Math.max(1, floor(x.unitsPerPackage || 1));
}

function getRemainingUnitsFromDoc(data: any): number {
  const remainingField = Number(data.remaining);
  if (Number.isFinite(remainingField) && remainingField > 0) {
    return Math.floor(remainingField);
  }

  const upp = getUnitsPerPackage(data);
  const totalUnits = Number(data.totalUnits || 0);
  const quantity = Number(data.quantity || 0);
  const packages = Number(data.packages || 0);

  if (totalUnits > 0) return Math.floor(totalUnits);
  if (quantity > 0) return Math.floor(quantity);
  if (packages > 0) return Math.floor(packages * upp);
  return 0;
}

/**
 * ✅ Devuelve paquetes a inventory_candies SOLO dentro del orderId de esa orden maestra.
 * - Suma UNIDADES y recalcula remainingPackages.
 * - Reparte el retorno FIFO por createdAt (para que sea estable).
 *
 * (LEGACY: se usa solo si NO hay masterAllocations guardadas)
 */
async function restoreToInventoryCandies(params: {
  orderId: string;
  productId: string;
  packagesToReturn: number;
}) {
  const { orderId, productId } = params;
  let packs = floor(params.packagesToReturn);
  if (!orderId || !productId || packs <= 0) return;

  const qInv = query(
    collection(db, "inventory_candies"),
    where("orderId", "==", orderId),
    where("productId", "==", productId),
    orderBy("createdAt", "asc"),
  );
  const snap = await getDocs(qInv);

  if (snap.empty) return;

  const refs = snap.docs.map((d) => d.ref);

  await runTransaction(db, async (tx) => {
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    for (let i = 0; i < refs.length && packs > 0; i++) {
      const s = snaps[i];
      if (!s.exists()) continue;
      const x = s.data() as any;

      const upp = getUnitsPerPackage(x);
      const addUnits = packs * upp;

      const currentRemainingUnits = floor(x.remaining ?? 0);
      const newRemainingUnits = currentRemainingUnits + addUnits;

      const newRemainingPackages = Math.floor(newRemainingUnits / upp);

      tx.update(refs[i], {
        remaining: newRemainingUnits,
        remainingPackages: newRemainingPackages,
        packages: newRemainingPackages,
        updatedAt: Timestamp.now(),
      });

      packs = 0;
    }
  });
}

/**
 * ✅ Devuelve paquetes al item correcto dentro de candy_main_orders/{orderId}.
 * - Incrementa items[].remainingPackages donde item.id === productId
 *
 * (LEGACY: se usa solo si NO hay masterAllocations guardadas)
 */
async function restoreToCandyMainOrder(params: {
  orderId: string;
  productId: string;
  packagesToReturn: number;
}) {
  const { orderId, productId } = params;
  const packs = floor(params.packagesToReturn);
  if (!orderId || !productId || packs <= 0) return;

  const orderRef = doc(db, "candy_main_orders", orderId);

  await runTransaction(db, async (tx) => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists()) return;

    const data = orderSnap.data() as any;
    const items = Array.isArray(data.items) ? data.items : [];

    let changed = false;

    const newItems = items.map((it: any) => {
      if (String(it?.id || "") !== String(productId)) return it;

      changed = true;
      return {
        ...it,
        remainingPackages: floor(it.remainingPackages) + packs,
      };
    });

    if (changed) {
      tx.update(orderRef, {
        items: newItems,
        updatedAt: Timestamp.now(),
      });
    }
  });
}

/* -------------------------------------------------------------------------- */
/*  ✅ BLINDADO: RESTORE POR batchId + masterOrderId                            */
/* -------------------------------------------------------------------------- */

export type MasterAllocation = {
  batchId: string; // doc id en inventory_candies
  masterOrderId: string; // x.orderId del lote (candy_main_orders id)
  units: number; // unidades asignadas desde ese lote
  unitsPerPackage: number; // para convertir a packs
};

function normalizeAllocations(raw: any): MasterAllocation[] {
  if (!Array.isArray(raw)) return [];
  const out: MasterAllocation[] = [];
  for (const a of raw) {
    const batchId = String(a?.batchId || "");
    const masterOrderId = String(a?.masterOrderId || a?.orderId || "");
    const units = floor(a?.units ?? a?.qty ?? a?.quantity ?? 0);
    const upp = Math.max(1, floor(a?.unitsPerPackage || 1));
    if (!batchId || !masterOrderId || units <= 0) continue;
    out.push({ batchId, masterOrderId, units, unitsPerPackage: upp });
  }
  return out;
}

function packsFromUnits(units: number, upp: number) {
  const u = floor(units);
  const p = Math.max(1, floor(upp));
  return Math.floor(u / p);
}

/**
 * ✅ Asigna paquetes a un vendedor descontando:
 * 1) inventory_candies (remaining/remainingPackages)
 * 2) candy_main_orders.items[].remainingPackages
 * y devuelve masterAllocations para guardar en el doc del vendedor.
 */
export async function allocateVendorCandyPacks(params: {
  productId: string;
  packagesToAllocate: number;
}): Promise<{ allocations: MasterAllocation[] }> {
  const productId = String(params.productId || "");
  let packsNeeded = floor(params.packagesToAllocate);

  if (!productId || packsNeeded <= 0) return { allocations: [] };

  const qInv = query(
    collection(db, "inventory_candies"),
    where("productId", "==", productId),
  );
  const snap = await getDocs(qInv);

  if (snap.empty) {
    throw new Error("No hay inventario para este producto.");
  }

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

  const refs = docsSorted.map((d) => doc(db, "inventory_candies", d.id));
  const allocations: MasterAllocation[] = [];

  await runTransaction(db, async (tx) => {
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    const plannedUpdates: {
      ref: ReturnType<typeof doc>;
      newRemUnits: number;
      newRemPacks: number;
    }[] = [];

    let need = packsNeeded;

    for (let i = 0; i < refs.length && need > 0; i++) {
      const ref = refs[i];
      const ds = snaps[i];
      if (!ds.exists()) continue;

      const data = ds.data() as any;
      const upp = getUnitsPerPackage(data);
      const currentRemUnits = getRemainingUnitsFromDoc(data);
      if (currentRemUnits <= 0) continue;

      const currentRemPacks = Math.floor(currentRemUnits / upp);
      if (currentRemPacks <= 0) continue;

      const takePacks = Math.min(currentRemPacks, need);
      const unitsTaken = takePacks * upp;
      const newRemUnits = Math.max(0, currentRemUnits - unitsTaken);
      const newRemPacks = Math.floor(newRemUnits / upp);

      const masterOrderId = String(data.orderId || "");
      if (!masterOrderId) {
        throw new Error("Lote sin orderId (orden maestra).");
      }

      allocations.push({
        batchId: ref.id,
        masterOrderId,
        units: unitsTaken,
        unitsPerPackage: upp,
      });

      plannedUpdates.push({ ref, newRemUnits, newRemPacks });
      need -= takePacks;
    }

    if (need > 0) {
      throw new Error(`Inventario insuficiente. Faltan ${need} paquetes.`);
    }

    const packsByOrder: Record<string, number> = {};
    for (const a of allocations) {
      const packs = packsFromUnits(a.units, a.unitsPerPackage);
      packsByOrder[a.masterOrderId] =
        (packsByOrder[a.masterOrderId] || 0) + packs;
    }

    const orderIds = Object.keys(packsByOrder);
    const orderRefs = orderIds.map((id) => doc(db, "candy_main_orders", id));
    const orderSnaps = await Promise.all(orderRefs.map((r) => tx.get(r)));

    for (let i = 0; i < plannedUpdates.length; i++) {
      const u = plannedUpdates[i];
      tx.update(u.ref, {
        remaining: u.newRemUnits,
        remainingPackages: u.newRemPacks,
        packages: u.newRemPacks,
        updatedAt: Timestamp.now(),
      });
    }

    for (let i = 0; i < orderRefs.length; i++) {
      const orderSnap = orderSnaps[i];
      if (!orderSnap.exists()) {
        throw new Error("Orden maestra no existe.");
      }
      const data = orderSnap.data() as any;
      const items = Array.isArray(data.items) ? data.items : [];

      const packsToTake = floor(packsByOrder[orderIds[i]] || 0);
      if (packsToTake <= 0) continue;

      let changed = false;
      const newItems = items.map((it: any) => {
        if (String(it?.id || "") !== productId) return it;
        const current = floor(it.remainingPackages);
        if (current < packsToTake) {
          throw new Error("Orden maestra sin paquetes suficientes.");
        }
        changed = true;
        return {
          ...it,
          remainingPackages: current - packsToTake,
        };
      });

      if (changed) {
        tx.update(orderRefs[i], {
          items: newItems,
          updatedAt: Timestamp.now(),
        });
      }
    }
  });

  return { allocations };
}

/**
 * ✅ Toma N paquetes desde masterAllocations (con precisión por batchId),
 * devolviéndolos a:
 *  1) inventory_candies/{batchId} (remaining/remainingPackages)
 *  2) candy_main_orders/{masterOrderId}.items[].remainingPackages (id === productId)
 * y además:
 *  3) actualiza el doc del vendedor reduciendo masterAllocations (para no duplicar futuras devoluciones)
 *
 * 🔥 Esta es la que vas a usar para EDITAR cuando delta < 0 (restar paquetes).
 */
export async function restoreVendorCandyPacks(params: {
  vendorInventoryId: string; // doc id inventory_candies_sellers
  packagesToReturn: number; // packs a devolver
}) {
  const vendorInventoryId = String(params.vendorInventoryId || "");
  let packsToReturn = floor(params.packagesToReturn);

  if (!vendorInventoryId) throw new Error("vendorInventoryId requerido");
  if (packsToReturn <= 0) return { restoredPackages: 0, mode: "noop" as const };

  const vendorRef = doc(db, "inventory_candies_sellers", vendorInventoryId);

  // ⚠️ Leemos fuera para decidir modo. (la consistencia fuerte la asegura la transacción)
  const vendorSnap = await getDoc(vendorRef);
  if (!vendorSnap.exists()) throw new Error("No existe la orden del vendedor");

  const v = vendorSnap.data() as any;

  const productId = String(v.productId || "");
  if (!productId) throw new Error("La orden del vendedor no tiene productId");

  const allocs = normalizeAllocations(
    v.masterAllocations || v.allocations || v.allocationsByBatch,
  );

  // =========================
  // LEGACY (sin allocations)
  // =========================
  if (!allocs.length) {
    const orderIdLegacy = String(v.orderId || "");
    if (!orderIdLegacy)
      throw new Error("La orden del vendedor no tiene orderId");

    await restoreToInventoryCandies({
      orderId: orderIdLegacy,
      productId,
      packagesToReturn: packsToReturn,
    });

    await restoreToCandyMainOrder({
      orderId: orderIdLegacy,
      productId,
      packagesToReturn: packsToReturn,
    });

    return { restoredPackages: packsToReturn, mode: "legacy" as const };
  }

  // =========================
  // BLINDADO (con allocations)
  // =========================
  let restoredPackagesTotal = 0;

  await runTransaction(db, async (tx) => {
    const snap = await tx.get(vendorRef);
    if (!snap.exists()) throw new Error("No existe la orden del vendedor");

    const dataVendor = snap.data() as any;
    const productIdTx = String(dataVendor.productId || "");
    if (!productIdTx) throw new Error("Doc vendedor sin productId");

    // Re-normalizamos dentro de TX (por si cambió)
    let currentAllocs = normalizeAllocations(
      dataVendor.masterAllocations ||
        dataVendor.allocations ||
        dataVendor.allocationsByBatch,
    );

    if (!currentAllocs.length) {
      // si alguien borró allocations entre el getDoc y la tx, caemos a error
      throw new Error(
        "No hay masterAllocations guardadas en este doc (no se puede restaurar blindado).",
      );
    }

    // 1) Elegimos CUÁLES allocations vamos a devolver (consumimos desde el FINAL)
    //    (el orden no afecta la suma, pero es consistente)
    const used: MasterAllocation[] = [];
    let remainingNeed = packsToReturn;

    for (let i = currentAllocs.length - 1; i >= 0 && remainingNeed > 0; i--) {
      const a = currentAllocs[i];
      const upp = Math.max(1, floor(a.unitsPerPackage || 1));

      // packs disponibles en esta allocation
      const packsAvail = packsFromUnits(a.units, upp);
      if (packsAvail <= 0) continue;

      const takePacks = Math.min(packsAvail, remainingNeed);
      const takeUnits = takePacks * upp;

      used.push({
        batchId: a.batchId,
        masterOrderId: a.masterOrderId,
        units: takeUnits,
        unitsPerPackage: upp,
      });

      remainingNeed -= takePacks;
    }

    const restoredNow = packsToReturn - remainingNeed;
    if (restoredNow <= 0) {
      // No hay de dónde devolver (allocations no cubren)
      return;
    }

    restoredPackagesTotal = restoredNow;

    // 2) ✅ TODAS LAS LECTURAS PRIMERO
    const batchRefs = used.map((a) => doc(db, "inventory_candies", a.batchId));

    // packs a devolver por masterOrderId (para candy_main_orders)
    const packsByMasterOrder: Record<string, number> = {};
    for (const a of used) {
      const packs = packsFromUnits(a.units, a.unitsPerPackage);
      if (packs > 0) {
        packsByMasterOrder[a.masterOrderId] =
          (packsByMasterOrder[a.masterOrderId] || 0) + packs;
      }
    }

    const masterOrderIds = Object.keys(packsByMasterOrder);
    const orderRefs = masterOrderIds.map((id) =>
      doc(db, "candy_main_orders", id),
    );

    const [batchSnaps, orderSnaps] = await Promise.all([
      Promise.all(batchRefs.map((r) => tx.get(r))),
      Promise.all(orderRefs.map((r) => tx.get(r))),
    ]);

    // 3) ✅ ESCRITURAS: inventory_candies (por batchId real)
    for (let i = 0; i < used.length; i++) {
      const a = used[i];
      const bs = batchSnaps[i];
      if (!bs.exists()) continue;

      const inv = bs.data() as any;

      const upp = Math.max(
        1,
        floor(a.unitsPerPackage || inv.unitsPerPackage || 1),
      );
      const addUnits = floor(a.units);

      const currentRemainingUnits = floor(inv.remaining ?? 0);
      const newRemainingUnits = currentRemainingUnits + addUnits;
      const newRemainingPackages = Math.floor(newRemainingUnits / upp);

      tx.update(batchRefs[i], {
        remaining: newRemainingUnits,
        remainingPackages: newRemainingPackages,
        packages: newRemainingPackages,
        updatedAt: Timestamp.now(),
      });
    }

    // 4) ✅ ESCRITURAS: candy_main_orders por masterOrderId (items[].remainingPackages)
    for (let i = 0; i < orderRefs.length; i++) {
      const os = orderSnaps[i];
      if (!os.exists()) continue;

      const masterOrderId = orderRefs[i].id;
      const packsReturn = floor(packsByMasterOrder[masterOrderId] || 0);
      if (packsReturn <= 0) continue;

      const od = os.data() as any;
      const items = Array.isArray(od.items) ? od.items : [];

      let changed = false;

      const newItems = items.map((it: any) => {
        if (String(it?.id || "") !== String(productIdTx)) return it;
        changed = true;
        return {
          ...it,
          remainingPackages: floor(it.remainingPackages) + packsReturn,
        };
      });

      if (changed) {
        tx.update(orderRefs[i], {
          items: newItems,
          updatedAt: Timestamp.now(),
        });
      }
    }

    // 5) ✅ Limpieza: reducir masterAllocations del vendedor (quitando lo devuelto)
    //    Estrategia: restamos unidades por batchId+masterOrderId hasta agotar.
    const toSubtractMap = new Map<string, number>(); // key -> units to subtract
    for (const a of used) {
      const key = `${a.batchId}__${a.masterOrderId}__${a.unitsPerPackage}`;
      toSubtractMap.set(key, (toSubtractMap.get(key) || 0) + floor(a.units));
    }

    const newAllocs: MasterAllocation[] = [];
    for (const a of currentAllocs) {
      const upp = Math.max(1, floor(a.unitsPerPackage || 1));
      const key = `${a.batchId}__${a.masterOrderId}__${upp}`;
      const sub = floor(toSubtractMap.get(key) || 0);

      if (sub <= 0) {
        newAllocs.push(a);
        continue;
      }

      const curUnits = floor(a.units);
      const leftUnits = curUnits - sub;

      if (leftUnits > 0) {
        newAllocs.push({ ...a, units: leftUnits, unitsPerPackage: upp });
      }

      // ya consumimos todo lo que podíamos de este allocation
      toSubtractMap.delete(key);
    }

    tx.update(vendorRef, {
      masterAllocations: newAllocs,
      updatedAt: Timestamp.now(),
    });
  });

  return { restoredPackages: restoredPackagesTotal, mode: "blind" as const };
}

/**
 * ✅ FUNCIÓN QUE VOS YA USÁS (BLINDADA)
 *
 * Borra un doc de inventory_candies_sellers y devuelve paquetes a:
 * 1) inventory_candies (POR batchId real)
 * 2) candy_main_orders.items[].remainingPackages (POR masterOrderId real)
 */
export async function deleteVendorCandyOrderAndRestore(
  vendorInventoryId: string,
) {
  if (!vendorInventoryId) throw new Error("vendorInventoryId requerido");

  const vendorRef = doc(db, "inventory_candies_sellers", vendorInventoryId);
  const vendorSnap = await getDoc(vendorRef);

  if (!vendorSnap.exists()) throw new Error("No existe la orden del vendedor");

  const v = vendorSnap.data() as any;

  const productId = String(v.productId || "");
  const packagesLegacy = floor(v.packages || v.remainingPackages || 0);

  // ✅ Nuevo (blindado): allocations reales por lote
  const allocs = normalizeAllocations(
    v.masterAllocations || v.allocations || v.allocationsByBatch,
  );

  // Si no hay allocations guardadas, caemos al LEGACY
  if (!allocs.length) {
    const orderIdLegacy = String(v.orderId || "");

    if (!orderIdLegacy)
      throw new Error("La orden del vendedor no tiene orderId");
    if (!productId) throw new Error("La orden del vendedor no tiene productId");

    if (packagesLegacy <= 0) {
      await runTransaction(db, async (tx) => {
        tx.delete(vendorRef);
      });
      return { restoredPackages: 0, mode: "legacy" as const };
    }

    await restoreToInventoryCandies({
      orderId: orderIdLegacy,
      productId,
      packagesToReturn: packagesLegacy,
    });

    await restoreToCandyMainOrder({
      orderId: orderIdLegacy,
      productId,
      packagesToReturn: packagesLegacy,
    });

    await runTransaction(db, async (tx) => {
      tx.delete(vendorRef);
    });

    return { restoredPackages: packagesLegacy, mode: "legacy" as const };
  }

  // ✅ BLINDADO: restauramos por batchId, y sumamos packs por masterOrderId
  let restoredPackagesTotal = 0;

  await runTransaction(db, async (tx) => {
    // 0) Pre-calcular packs por masterOrderId (SIN leer ni escribir)
    const packsByMasterOrder: Record<string, number> = {};
    for (const a of allocs) {
      const upp = Math.max(1, floor(a.unitsPerPackage || 1));
      const addUnits = floor(a.units);
      const packs = packsFromUnits(addUnits, upp);
      if (packs > 0) {
        packsByMasterOrder[a.masterOrderId] =
          (packsByMasterOrder[a.masterOrderId] || 0) + packs;
      }
    }

    // 1) ✅ TODAS LAS LECTURAS PRIMERO
    const batchRefs = allocs.map((a) =>
      doc(db, "inventory_candies", a.batchId),
    );

    const masterOrderIds = Object.keys(packsByMasterOrder);
    const orderRefs = masterOrderIds.map((id) =>
      doc(db, "candy_main_orders", id),
    );

    const [batchSnaps, orderSnaps] = await Promise.all([
      Promise.all(batchRefs.map((r) => tx.get(r))),
      Promise.all(orderRefs.map((r) => tx.get(r))),
    ]);

    // 2) ✅ ESCRITURAS: inventory_candies (por batchId)
    let restoredPackagesTotalLocal = 0;

    for (let i = 0; i < allocs.length; i++) {
      const a = allocs[i];
      const s = batchSnaps[i];
      if (!s.exists()) continue;

      const data = s.data() as any;

      const upp = Math.max(
        1,
        floor(a.unitsPerPackage || data.unitsPerPackage || 1),
      );
      const addUnits = floor(a.units);

      const currentRemainingUnits = floor(data.remaining ?? 0);
      const newRemainingUnits = currentRemainingUnits + addUnits;
      const newRemainingPackages = Math.floor(newRemainingUnits / upp);

      tx.update(batchRefs[i], {
        remaining: newRemainingUnits,
        remainingPackages: newRemainingPackages,
        packages: newRemainingPackages,
        updatedAt: Timestamp.now(),
      });

      const packs = packsFromUnits(addUnits, upp);
      if (packs > 0) restoredPackagesTotalLocal += packs;
    }

    // 3) ✅ ESCRITURAS: candy_main_orders por masterOrderId (items[].remainingPackages)
    for (let i = 0; i < orderRefs.length; i++) {
      const os = orderSnaps[i];
      if (!os.exists()) continue;

      const masterOrderId = orderRefs[i].id;
      const packsToReturn = floor(packsByMasterOrder[masterOrderId] || 0);
      if (packsToReturn <= 0) continue;

      const od = os.data() as any;
      const items = Array.isArray(od.items) ? od.items : [];

      let changed = false;

      const newItems = items.map((it: any) => {
        if (String(it?.id || "") !== String(productId)) return it;
        changed = true;
        return {
          ...it,
          remainingPackages: floor(it.remainingPackages) + packsToReturn,
        };
      });

      if (changed) {
        tx.update(orderRefs[i], {
          items: newItems,
          updatedAt: Timestamp.now(),
        });
      }
    }

    // 4) ✅ borrar doc del vendedor al final
    tx.delete(vendorRef);

    restoredPackagesTotal = restoredPackagesTotalLocal;
  });

  return { restoredPackages: restoredPackagesTotal, mode: "blind" as const };
}
