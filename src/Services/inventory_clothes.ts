// src/services/inventory_clothes.ts
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
 * - Si la venta tiene `allocations`, devuelve exactamente esas unidades por lote.
 * - Si NO tiene `allocations` (ventas viejas), hace un fallback: repone FIFO
 *   respetando cuánto se usó en cada lote (quantity - remaining).
 * - Cumple regla de Firestore (lecturas antes de escrituras).
 * - NO toca CxC (ar_movements): mantené tu lógica actual para borrar esos docs aparte.
 */
export async function restoreSaleAndDeleteClothes(saleId: string) {
  const saleRef = doc(db, "sales_clothes", saleId);
  const saleSnap = await getDoc(saleRef);
  if (!saleSnap.exists()) throw new Error("La venta no existe.");

  const sale = saleSnap.data() as any;

  // Datos base de la venta
  const item = sale.item || {};
  const productId: string = String(item.productId || sale.productId || "");
  const qtyTotal: number = Math.max(
    0,
    Math.floor(Number(item.qty ?? sale.quantity ?? 0))
  );

  // Intentar allocations guardadas en la venta
  const allocationsInSale: ClothesAllocation[] = Array.isArray(sale.allocations)
    ? sale.allocations.map((a: any) => ({
        batchId: String(a.batchId),
        qty: Math.max(0, Math.floor(Number(a.qty || a.quantity || 0))),
      }))
    : [];

  // Si no hay productId o qty, simplemente borrar la venta (no podemos restaurar)
  if (!productId || qtyTotal <= 0) {
    await runTransaction(db, async (tx) => {
      tx.delete(saleRef);
    });
    return { restored: 0 };
  }

  // Camino A: tenemos allocations exactas → devolver a cada lote esas unidades
  if (allocationsInSale.length > 0) {
    await runTransaction(db, async (tx) => {
      // 🔎 Leer primero
      const refs = allocationsInSale.map((a) =>
        doc(db, "inventory_clothes_batches", a.batchId)
      );
      const snaps = await Promise.all(refs.map((r) => tx.get(r)));

      // ✍️ Actualizar remaining por cada allocation
      for (let i = 0; i < refs.length; i++) {
        const ref = refs[i];
        const snap = snaps[i];
        if (!snap.exists()) continue;

        const data = snap.data() as any;
        const rem = Math.max(0, Math.floor(Number(data.remaining || 0)));
        const qty = Math.max(0, Math.floor(Number(allocationsInSale[i].qty)));
        const newRem = rem + qty;

        tx.update(ref, { remaining: newRem });
      }

      // Borrar venta
      tx.delete(saleRef);
    });

    const restored = allocationsInSale.reduce((s, a) => s + a.qty, 0);
    return { restored };
  }

  // Camino B: venta vieja sin allocations → fallback (repone por FIFO en función de "usado")
  // Traer lotes del producto
  const qB = query(
    collection(db, "inventory_clothes_batches"),
    where("productId", "==", productId)
  );
  const snap = await getDocs(qB);

  // Construir filas con quantity/remaining y ordenar FIFO
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

  // Calcular cuánto se "usó" en cada lote (quantity - remaining) y devolver ahí primero
  const plan: Array<{ id: string; addBack: number }> = [];
  let toReturn = qtyTotal;

  for (const lot of lots) {
    if (toReturn <= 0) break;
    const used = Math.max(0, lot.quantity - lot.remaining);
    if (used <= 0) continue;

    const addBack = Math.min(used, toReturn);
    plan.push({ id: lot.id, addBack });
    toReturn -= addBack;
  }

  // Si aún falta por devolver (caso raro), repártelo FIFO simplemente aumentando remaining
  for (const lot of lots) {
    if (toReturn <= 0) break;
    const addBack = Math.min(toReturn, qtyTotal); // cualquier resto
    plan.push({ id: lot.id, addBack });
    toReturn -= addBack;
  }

  await runTransaction(db, async (tx) => {
    // 🔎 Lecturas primero
    const refs = plan.map((p) => doc(db, "inventory_clothes_batches", p.id));
    const snaps2 = await Promise.all(refs.map((r) => tx.get(r)));

    // ✍️ Escrituras
    for (let i = 0; i < refs.length; i++) {
      const ref = refs[i];
      const snap2 = snaps2[i];
      if (!snap2.exists()) continue;

      const data = snap2.data() as any;
      const rem = Math.max(0, Math.floor(Number(data.remaining || 0)));
      const addBack = Math.max(0, Math.floor(Number(plan[i].addBack)));
      tx.update(ref, { remaining: rem + addBack });
    }

    // Borrar la venta
    tx.delete(saleRef);
  });

  const restored = plan.reduce((s, p) => s + p.addBack, 0);
  return { restored };
}
