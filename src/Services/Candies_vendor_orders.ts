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
    orderBy("createdAt", "asc")
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

type MasterAllocation = {
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
 * ✅ FUNCIÓN QUE VOS VAS A LLAMAR DESDE EL COMPONENTE (BLINDADA)
 *
 * Borra un doc de inventory_candies_sellers y devuelve paquetes a:
 * 1) inventory_candies (POR batchId real)
 * 2) candy_main_orders.items[].remainingPackages (POR masterOrderId real)
 */
export async function deleteVendorCandyOrderAndRestore(
  vendorInventoryId: string
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
    v.masterAllocations || v.allocations || v.allocationsByBatch
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
      doc(db, "inventory_candies", a.batchId)
    );

    const masterOrderIds = Object.keys(packsByMasterOrder);
    const orderRefs = masterOrderIds.map((id) =>
      doc(db, "candy_main_orders", id)
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
        floor(a.unitsPerPackage || data.unitsPerPackage || 1)
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

    // exponer total al scope externo
    restoredPackagesTotal = restoredPackagesTotalLocal;
  });

  return { restoredPackages: restoredPackagesTotal, mode: "blind" as const };
}
