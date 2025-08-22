// src/services/inventory.ts
import { db } from "../firebase";
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
  runTransaction,
} from "firebase/firestore";
import { format } from "date-fns";

/** Crea un lote (entrada mensual) en inventory_batches */
export async function newBatch(payload: {
  productId: string;
  productName: string;
  category: string;
  unit: string; // "lb" / "unidad"
  quantity: number; // ingresadas
  purchasePrice: number; // costo unitario
  salePrice: number; // precio venta unitario
  invoiceTotal?: number; // total factura (opcional)
  date: string; // yyyy-MM-dd
  supplier?: string;
  notes?: string;
}) {
  const data = {
    ...payload,
    remaining: payload.quantity,
    status: "PENDIENTE" as "PENDIENTE" | "PAGADO",
    createdAt: Timestamp.now(),
  };
  return addDoc(collection(db, "inventory_batches"), data);
}

/** Marca un lote como pagado */
export async function markBatchAsPaid(batchId: string, paidAmount?: number) {
  await updateDoc(doc(db, "inventory_batches", batchId), {
    status: "PAGADO",
    paidAmount: paidAmount ?? null,
    paidAt: Timestamp.now(),
  });
}

/** Obtiene stock por producto (total y desglose por lote abierto) */
export async function getStockByProduct(productId: string) {
  const q = query(
    collection(db, "inventory_batches"),
    where("productId", "==", productId),
    where("remaining", ">", 0),
    orderBy("date", "asc")
  );
  const snap = await getDocs(q);
  let total = 0;
  const batches: Array<{ id: string; date: string; remaining: number }> = [];
  snap.forEach((d) => {
    const b = d.data() as any;
    const rem = Number(b.remaining ?? 0);
    total += rem;
    batches.push({ id: d.id, date: b.date, remaining: rem });
  });
  return { total, batches };
}

/** Asigna venta a lotes (FIFO) y descuenta remaining. Crea batch_allocations. */
export async function allocateSaleFIFO(
  productId: string,
  saleId: string,
  saleDate: string, // yyyy-MM-dd
  quantity: number,
  amountChargedPerUnit?: number // opcional, si quieres guardar monto por unidad
) {
  if (!productId || !saleId || !saleDate || !quantity || quantity <= 0) {
    throw new Error("Parámetros inválidos para allocateSaleFIFO");
  }

  // Lotes abiertos (remaining > 0) por fecha asc
  const q = query(
    collection(db, "inventory_batches"),
    where("productId", "==", productId),
    where("remaining", ">", 0),
    orderBy("date", "asc")
  );
  const snap = await getDocs(q);
  if (snap.empty) throw new Error("No hay lotes con stock disponible.");

  const batchIds = snap.docs.map((d) => d.id);
  const pendingAllocations: {
    saleId: string;
    saleDate: string;
    productId: string;
    productName: string;
    batchId: string;
    batchDate: string;
    quantity: number;
    amountCharged?: number;
  }[] = [];

  // Transacción: actualizar remaining por lote
  await runTransaction(db, async (tx) => {
    let toConsume = quantity;

    for (const batchId of batchIds) {
      if (toConsume <= 0) break;

      const batchRef = doc(db, "inventory_batches", batchId);
      const batchSnap = await tx.get(batchRef);
      if (!batchSnap.exists()) continue;

      const batch = batchSnap.data() as any;
      const rem = Number(batch.remaining ?? 0);
      if (rem <= 0) continue;

      const take = Math.min(rem, toConsume);

      tx.update(batchRef, { remaining: rem - take });

      pendingAllocations.push({
        saleId,
        saleDate,
        productId,
        productName: batch.productName ?? "(sin nombre)",
        batchId,
        batchDate: batch.date,
        quantity: take,
        amountCharged:
          amountChargedPerUnit && take
            ? Number((amountChargedPerUnit * take).toFixed(2))
            : undefined,
      });

      toConsume -= take;
    }

    if (toConsume > 0) {
      throw new Error("Stock insuficiente en lotes para cubrir la venta.");
    }
  });

  // Crear allocations (ya fuera del tx)
  for (const alloc of pendingAllocations) {
    await addDoc(collection(db, "batch_allocations"), {
      ...alloc,
      createdAt: Timestamp.now(),
    });
  }
}

/** Ver a qué lotes se asignó una venta */
export async function getAllocationsForSale(saleId: string) {
  const q = query(
    collection(db, "batch_allocations"),
    where("saleId", "==", saleId)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() } as any));
}

/** Sumarios de allocations por lote en un rango de fechas (para Liquidaciones) */
export async function allocationsByBatchInRange(from: string, to: string) {
  const q = query(
    collection(db, "batch_allocations"),
    where("saleDate", ">=", from),
    where("saleDate", "<=", to)
  );
  const snap = await getDocs(q);
  const map: Record<
    string,
    {
      batchId: string;
      batchDate: string;
      productName: string;
      quantity: number;
      amountCharged: number;
    }
  > = {};
  snap.forEach((d) => {
    const a = d.data() as any;
    const key = a.batchId;
    if (!map[key]) {
      map[key] = {
        batchId: a.batchId,
        batchDate: a.batchDate,
        productName: a.productName,
        quantity: 0,
        amountCharged: 0,
      };
    }
    map[key].quantity += Number(a.quantity || 0);
    map[key].amountCharged += Number(a.amountCharged || 0);
  });
  return Object.values(map);
}

// Restaura el stock de los lotes consumidos por una venta (usando salesV2.allocations)
// y luego elimina la venta. Si no hay allocations, solo elimina la venta.
export async function restoreSaleAndDelete(saleId: string) {
  // 1) lee la venta
  const saleRef = doc(db, "salesV2", saleId);
  const saleSnap = await getDoc(saleRef);
  if (!saleSnap.exists()) {
    throw new Error("La venta no existe.");
  }
  const sale = saleSnap.data() as any;
  const allocations: Array<{ batchId: string; qty: number }> = Array.isArray(
    sale.allocations
  )
    ? sale.allocations
    : [];

  // 2) si tenía allocations, devolver cantidades a los lotes en una transacción
  await runTransaction(db, async (tx) => {
    if (allocations.length > 0) {
      for (const a of allocations) {
        if (!a?.batchId || !a?.qty) continue;
        const batchRef = doc(db, "inventory_batches", a.batchId);
        const batchSnap = await tx.get(batchRef);
        if (!batchSnap.exists()) continue;

        const rem = Number((batchSnap.data() as any).remaining ?? 0);
        const newRem = Number((rem + Number(a.qty || 0)).toFixed(2));
        tx.update(batchRef, { remaining: newRem });
      }
    }
    // 3) borra la venta
    tx.delete(saleRef);
  });

  return {
    restored: allocations.reduce((s, a) => s + (Number(a.qty) || 0), 0),
  };
}
