// src/Services/allocateFIFO.ts
import {
  collection,
  doc,
  getDocs,
  query,
  runTransaction,
  where,
  type Firestore,
} from "firebase/firestore";

export interface Allocation {
  batchId: string;
  qty: number;
  unitCost: number;
  lineCost: number;
}

export interface AllocationResult {
  allocations: Allocation[];
  avgUnitCost: number; // costo promedio unitario ponderado
  cogsAmount: number; // costo total de la venta (sum(lineCost))
}

/**
 * Asigna stock por FIFO (lotes más antiguos primero) para un producto
 * y descuenta de `remaining` en cada lote dentro de una transacción.
 *
 * NOTA: En tu BD actual la colección se llama `inventory_batches`
 * y el costo unitario es `purchasePrice`. Aquí se consulta por productName
 * (para mantener compatibilidad con tu llamada actual) y se ordena en
 * memoria por `date` asc (y luego por `createdAt` si existe) para FIFO.
 */
export default async function allocateFIFOAndUpdateBatches(
  db: Firestore,
  productName: string,
  quantityNeeded: number,
  allowNegative = false
): Promise<AllocationResult> {
  if (quantityNeeded <= 0) {
    return { allocations: [], avgUnitCost: 0, cogsAmount: 0 };
  }

  // Colección y campos que realmente existen en tu app:
  // - collection: inventory_batches
  // - fields: productName, remaining, quantity, purchasePrice, date, createdAt
  const colRef = collection(db, "inventory_batches");
  const q = query(colRef, where("productName", "==", productName));

  const snap = await getDocs(q);

  // Preparamos los refs en FIFO puro:
  // 1) Orden por date asc (yyyy-MM-dd en tu app)
  // 2) Empate por createdAt asc (si existe)
  const docsSorted = snap.docs
    .map((d) => ({ id: d.id, data: d.data() as any }))
    .sort((a, b) => {
      const da = (a.data.date ?? "") as string;
      const dbs = (b.data.date ?? "") as string;
      if (da !== dbs) return da < dbs ? -1 : 1;

      const ca = a.data.createdAt?.seconds ?? 0;
      const cb = b.data.createdAt?.seconds ?? 0;
      return ca - cb;
    });

  const batchRefs = docsSorted.map((d) => doc(db, "inventory_batches", d.id));

  return runTransaction(db, async (tx) => {
    let need = Number(quantityNeeded);
    const allocations: Allocation[] = [];

    for (const ref of batchRefs) {
      if (need <= 0) break;

      const ds = await tx.get(ref);
      if (!ds.exists()) continue;

      const data = ds.data() as any;

      // remaining con fallback a quantity (por si algún lote viejo no lo tiene)
      const qty = Number(data.quantity ?? 0);
      const rem = Number(data.remaining ?? qty ?? 0);

      // costo unitario real en tus lotes
      const cost = Number(data.purchasePrice ?? 0);

      if (rem <= 0) continue;

      const take = Math.min(rem, need);
      const newRemaining = Number((rem - take).toFixed(2));

      // Descuenta del lote
      tx.update(ref, { remaining: newRemaining });

      allocations.push({
        batchId: ref.id,
        qty: take,
        unitCost: cost,
        lineCost: Number((take * cost).toFixed(2)),
      });

      need = Number((need - take).toFixed(2));
    }

    if (need > 0 && !allowNegative) {
      // La transacción se aborta lanzando error
      throw new Error(
        `Stock insuficiente para "${productName}". Faltan ${need} unidades.`
      );
    }

    const cogsAmount = Number(
      allocations.reduce((acc, x) => acc + x.lineCost, 0).toFixed(2)
    );
    const qtySum = allocations.reduce((acc, x) => acc + x.qty, 0);
    const avgUnitCost =
      qtySum > 0 ? Number((cogsAmount / qtySum).toFixed(4)) : 0;

    return { allocations, avgUnitCost, cogsAmount };
  });
}
