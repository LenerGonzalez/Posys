// src/Services/inventory_clothes.ts
import { db } from "../firebase";
import {
  addDoc,
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  runTransaction,
  Timestamp,
  updateDoc,
  where,
} from "firebase/firestore";

/** Estructura de allocation para ropa (unidades enteras) */
export interface ClothesAllocation {
  batchId: string;
  qty: number; // unidades consumidas de ese lote
  batchDate?: string; // opcional, informativo
  productName?: string; // opcional, informativo
}

/** Crea un lote (entrada) en inventory_clothes_batches */
export async function newClothesBatch(payload: {
  productId: string;
  productName: string;
  quantity: number; // unidades ingresadas
  salePrice: number; // precio de venta unitario (referencial)
  date: string; // yyyy-MM-dd
  notes?: string;
}) {
  const data = {
    ...payload,
    remaining: Math.max(0, Math.floor(Number(payload.quantity || 0))),
    createdAt: Timestamp.now(),
  };
  return addDoc(collection(db, "inventory_clothes_batches"), data);
}

/** Obtiene stock (total y desglose por lote con remaining>0) */
export async function getClothesStockByProduct(productId: string) {
  const q = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId),
    where("remaining", ">", 0),
    orderBy("date", "asc")
  );
  const snap = await getDocs(q);
  let total = 0;
  const batches: Array<{ id: string; date: string; remaining: number }> = [];
  snap.forEach((d) => {
    const b = d.data() as any;
    const rem = Math.max(0, Math.floor(Number(b.remaining || 0)));
    total += rem;
    batches.push({ id: d.id, date: String(b.date || ""), remaining: rem });
  });
  return { total, batches };
}

/**
 * FIFO en cascada para ROPA: descuenta unidades enteras de los lotes más viejos.
 * - Cumple regla de Firestore: primero LEE TODO, luego ESCRIBE.
 * - Devuelve allocations por lote.
 * - Si pasás saleId, opcionalmente crea documentos en "batch_clothes_allocations".
 */
export async function allocateSaleFIFOClothes(params: {
  productId: string;
  quantity: number; // unidades (entero)
  saleDate: string; // yyyy-MM-dd
  saleId?: string; // opcional: para registrar allocations en colección
}) {
  const { productId, quantity, saleDate, saleId } = params;

  const needTotal = Math.max(0, Math.floor(Number(quantity || 0)));
  if (!productId || needTotal <= 0) {
    throw new Error("Parámetros inválidos para allocateSaleFIFOClothes");
  }

  // Traer lotes del producto (no filtramos remaining aquí para permitir fallback a quantity si falta el campo)
  const qB = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(qB);

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

  const refs = docsSorted.map((d) =>
    doc(db, "inventory_clothes_batches", d.id)
  );

  const allocations: ClothesAllocation[] = [];

  await runTransaction(db, async (tx) => {
    // 🔎 Lecturas primero
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    // ✍️ Escrituras después
    let need = needTotal;

    for (let i = 0; i < refs.length && need > 0; i++) {
      const ref = refs[i];
      const ds = snaps[i];
      if (!ds.exists()) continue;

      const data = ds.data() as any;
      const qty = Math.max(0, Math.floor(Number(data.quantity || 0)));
      const currentRem = Number.isFinite(Number(data.remaining))
        ? Math.max(0, Math.floor(Number(data.remaining || 0)))
        : qty; // fallback si el lote es antiguo y no tenía remaining

      if (currentRem <= 0) continue;

      const take = Math.min(currentRem, need);
      const newRem = Math.max(0, currentRem - take);

      tx.update(ref, { remaining: newRem });

      allocations.push({
        batchId: ref.id,
        qty: take,
        batchDate: String(data.date || ""),
        productName: String(data.productName || ""),
      });

      need -= take;
    }

    if (need > 0) {
      // No permitir negativos
      throw new Error(`Inventario insuficiente. Faltan ${need} unidades.`);
    }

    // (Opcional) Registrar allocations por lote a nivel "bitácora" si hay saleId
    if (saleId) {
      for (const a of allocations) {
        await addDoc(collection(db, "batch_clothes_allocations"), {
          saleId,
          saleDate,
          productId,
          productName: a.productName ?? "",
          batchId: a.batchId,
          batchDate: a.batchDate ?? "",
          quantity: a.qty,
          createdAt: Timestamp.now(),
        });
      }
    }
  });

  return { allocations };
}

/**
 * Restaura inventario para una venta de ROPA y elimina la venta.
 * - Soporta venta de 1 ítem (legacy) y venta con múltiples ítems (`items[]`).
 * - Si la venta tiene `allocations` / `allocationsByItem` / `items[i].allocations`,
 *   devuelve exactamente esas unidades por lote.
 * - Si NO tiene allocations (ventas viejas), hace fallback FIFO por producto:
 *   repone según (quantity - remaining) de cada lote y, si falta, reparte FIFO.
 * - Cumple regla de Firestore (lecturas antes de escrituras).
 * - NO toca CxC (ar_movements): borrá esos docs aparte.
 */
export async function restoreSaleAndDeleteClothes(saleId: string) {
  const saleRef = doc(db, "sales_clothes", saleId);
  const saleSnap = await getDoc(saleRef);
  if (!saleSnap.exists()) throw new Error("La venta no existe.");

  const sale = saleSnap.data() as any;

  // Normalizamos posibles estructuras de la venta
  const items: Array<{
    productId: string;
    productName?: string;
    qty: number;
    allocations?: ClothesAllocation[];
  }> = [];

  // Nuevo: venta multi-ítem (items[])
  if (Array.isArray(sale.items) && sale.items.length > 0) {
    // allocationsByItem puede venir como objeto { [productId]: { productId, allocations } } o arreglo
    const mapAlloc: Record<string, ClothesAllocation[]> = {};

    // Caso objeto (como guarda tu POS)
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

    // Caso arreglo
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

      // preferimos allocations dentro del item; si no, buscamos por productId en allocationsByItem
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
    // Legacy: un solo item
    const item = sale.item || {};
    const productId: string = String(item.productId || sale.productId || "");
    const qtyTotal: number = Math.max(
      0,
      Math.floor(Number(item.qty ?? sale.quantity ?? 0))
    );
    const allocationsInSale: ClothesAllocation[] = Array.isArray(
      sale.allocations
    )
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
    // No hay nada que restaurar; eliminar la venta
    await runTransaction(db, async (tx) => {
      tx.delete(saleRef);
    });
    return { restored: 0 };
  }

  // --- Camino A: todas las líneas tienen allocations → reversa exacta por lote ---
  const allHaveAllocations = items.every(
    (it) => Array.isArray(it.allocations) && it.allocations.length > 0
  );

  if (allHaveAllocations) {
    await runTransaction(db, async (tx) => {
      // Construimos refs a tocar
      const refs: Array<{ ref: any; addBack: number }> = [];
      for (const it of items) {
        for (const a of it.allocations || []) {
          refs.push({
            ref: doc(db, "inventory_clothes_batches", a.batchId),
            addBack: Math.max(0, Math.floor(Number(a.qty || 0))),
          });
        }
      }

      // Lecturas
      const snaps = await Promise.all(refs.map((x) => tx.get(x.ref)));

      // Escrituras
      for (let i = 0; i < refs.length; i++) {
        const snap = snaps[i];
        if (!snap.exists()) continue;
        const data = snap.data() as any;
        const rem = Math.max(0, Math.floor(Number(data.remaining || 0)));
        tx.update(refs[i].ref, { remaining: rem + refs[i].addBack });
      }

      // Borrar la venta al final
      tx.delete(saleRef);
    });

    const restored = items.reduce(
      (s, it) => s + (it.allocations || []).reduce((x, a) => x + a.qty, 0),
      0
    );
    return { restored };
  }

  // --- Camino B: falta allocations en al menos una línea → fallback FIFO por producto ---
  await runTransaction(db, async (tx) => {
    // Pre-leer lotes por producto
    const byProduct: Record<
      string,
      Array<{ id: string; date: string; quantity: number; remaining: number }>
    > = {};

    for (const it of items) {
      if (!it.productId || it.qty <= 0) continue;

      const qB = query(
        collection(db, "inventory_clothes_batches"),
        where("productId", "==", it.productId)
      );
      const snap = await getDocs(qB);
      const lots = snap.docs
        .map((d) => {
          const x = d.data() as any;
          const quantity = Math.max(0, Math.floor(Number(x.quantity || 0)));
          const remaining = Number.isFinite(Number(x.remaining))
            ? Math.max(0, Math.floor(Number(x.remaining || 0)))
            : quantity;
          return {
            id: d.id,
            date: String(x.date || ""),
            quantity,
            remaining,
          };
        })
        .sort((a, b) => a.date.localeCompare(b.date));
      byProduct[it.productId] = lots;
    }

    // Construir plan de updates (pueden repetirse lotes)
    const planUpdates: Array<{ id: string; addBack: number }> = [];

    for (const it of items) {
      if (!it.productId || it.qty <= 0) continue;

      if (Array.isArray(it.allocations) && it.allocations.length > 0) {
        for (const a of it.allocations) {
          planUpdates.push({
            id: a.batchId,
            addBack: Math.max(0, Math.floor(Number(a.qty || 0))),
          });
        }
        continue;
      }

      // Fallback FIFO: primero donde hubo consumo (quantity - remaining)
      const lots = byProduct[it.productId] || [];
      let toReturn = it.qty;

      for (const lot of lots) {
        if (toReturn <= 0) break;
        const used = Math.max(0, lot.quantity - lot.remaining);
        if (used <= 0) continue;
        const addBack = Math.min(used, toReturn);
        planUpdates.push({ id: lot.id, addBack });
        toReturn -= addBack;
      }

      // Si sobra, repartir FIFO
      for (const lot of lots) {
        if (toReturn <= 0) break;
        const addBack = Math.min(toReturn, it.qty);
        planUpdates.push({ id: lot.id, addBack });
        toReturn -= addBack;
      }
    }

    // Agrupar por lote
    const grouped: Record<string, number> = {};
    for (const p of planUpdates) {
      grouped[p.id] =
        (grouped[p.id] || 0) + Math.max(0, Math.floor(Number(p.addBack || 0)));
    }

    // Lecturas
    const refs = Object.keys(grouped).map((id) =>
      doc(db, "inventory_clothes_batches", id)
    );
    const snaps = await Promise.all(refs.map((r) => tx.get(r)));

    // Escrituras
    for (let i = 0; i < refs.length; i++) {
      const snap = snaps[i];
      if (!snap.exists()) continue;
      const data = snap.data() as any;
      const rem = Math.max(0, Math.floor(Number(data.remaining || 0)));
      const addBack = Math.max(0, Math.floor(Number(grouped[refs[i].id] || 0)));
      tx.update(refs[i], { remaining: rem + addBack });
    }

    // Borrar la venta
    tx.delete(saleRef);
  });

  const restored = items.reduce((s, it) => s + it.qty, 0);
  return { restored };
}
