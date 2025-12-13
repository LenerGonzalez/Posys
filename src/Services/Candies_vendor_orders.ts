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
 */
async function restoreToInventoryCandies(params: {
  orderId: string;
  productId: string;
  packagesToReturn: number;
}) {
  const { orderId, productId } = params;
  let packs = floor(params.packagesToReturn);
  if (!orderId || !productId || packs <= 0) return;

  // Traemos lotes del mismo pedido + producto
  const qInv = query(
    collection(db, "inventory_candies"),
    where("orderId", "==", orderId),
    where("productId", "==", productId),
    orderBy("createdAt", "asc")
  );
  const snap = await getDocs(qInv);

  // Si no hay lotes, no hay dónde devolver (schema roto o data inconsistente)
  if (snap.empty) return;

  // Preparamos refs
  const refs = snap.docs.map((d) => d.ref);

  await runTransaction(db, async (tx) => {
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    for (let i = 0; i < refs.length && packs > 0; i++) {
      const s = snaps[i];
      if (!s.exists()) continue;
      const x = s.data() as any;

      const upp = getUnitsPerPackage(x);

      // ✅ Devolver TODOS los packs aquí (normalmente un solo lote por producto/pedido)
      const addUnits = packs * upp;

      const currentRemainingUnits = floor(x.remaining ?? 0);
      const newRemainingUnits = currentRemainingUnits + addUnits;

      const newRemainingPackages = Math.floor(newRemainingUnits / upp);

      tx.update(refs[i], {
        remaining: newRemainingUnits,
        remainingPackages: newRemainingPackages,
        // mantenemos packages alineado con remainingPackages (tu schema lo hace así)
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

/**
 * ✅ FUNCIÓN QUE VOS VAS A LLAMAR DESDE EL COMPONENTE
 *
 * Borra un doc de inventory_candies_sellers y devuelve paquetes a:
 * 1) inventory_candies (misma orden maestra)
 * 2) candy_main_orders.items[].remainingPackages
 */
export async function deleteVendorCandyOrderAndRestore(
  vendorInventoryId: string
) {
  if (!vendorInventoryId) throw new Error("vendorInventoryId requerido");

  const vendorRef = doc(db, "inventory_candies_sellers", vendorInventoryId);
  const vendorSnap = await getDoc(vendorRef);

  if (!vendorSnap.exists()) throw new Error("No existe la orden del vendedor");

  const v = vendorSnap.data() as any;

  const orderId = String(v.orderId || "");
  const productId = String(v.productId || "");
  const packages = floor(v.packages || v.remainingPackages || 0);

  if (!orderId) throw new Error("La orden del vendedor no tiene orderId");
  if (!productId) throw new Error("La orden del vendedor no tiene productId");
  if (packages <= 0) {
    // Si está en 0 igual la borramos, pero no devolvemos nada
    await runTransaction(db, async (tx) => {
      tx.delete(vendorRef);
    });
    return { restoredPackages: 0 };
  }

  // ✅ 1) devolver a inventory_candies (del mismo pedido)
  await restoreToInventoryCandies({
    orderId,
    productId,
    packagesToReturn: packages,
  });

  // ✅ 2) devolver a candy_main_orders.items[]
  await restoreToCandyMainOrder({
    orderId,
    productId,
    packagesToReturn: packages,
  });

  // ✅ 3) borrar doc del vendedor
  await runTransaction(db, async (tx) => {
    tx.delete(vendorRef);
  });

  return { restoredPackages: packages };
}
