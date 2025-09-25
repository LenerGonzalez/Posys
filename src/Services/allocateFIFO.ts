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
 * y descuenta de `remaining` en cascada hasta cubrir toda la venta.
 *
 * ✅ Todas las lecturas se hacen ANTES de cualquier escritura (requisito de Firestore).
 * ✅ Si la cantidad sobrepasa un lote viejo, sigue consumiendo de los siguientes.
 * ✅ Devuelve allocations detallando de qué lote salió cada cantidad.
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

  // 1) Buscar lotes de este producto
  const colRef = collection(db, "inventory_batches");
  const q = query(colRef, where("productName", "==", productName));
  const snap = await getDocs(q);

  // 2) Ordenar por fecha asc (más viejo primero) y desempate por createdAt
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

    // 🔵 PRIMERA PASADA: leer todos los lotes
    const batchSnaps = await Promise.all(batchRefs.map((ref) => tx.get(ref)));

    // 🔵 SEGUNDA PASADA: procesar y hacer updates
    for (let i = 0; i < batchRefs.length && need > 0; i++) {
      const ref = batchRefs[i];
      const ds = batchSnaps[i];
      if (!ds.exists()) continue;

      const data = ds.data() as any;

      // remaining con fallback a quantity
      const qty = Number(data.quantity ?? 0);
      const rem = Number(data.remaining ?? qty ?? 0);
      const cost = Number(data.purchasePrice ?? 0);

      if (rem <= 0) continue;

      // Tomar lo que se pueda de este lote
      const take = Math.min(rem, need);
      const newRemaining = Number((rem - take).toFixed(3));

      tx.update(ref, { remaining: newRemaining });

      allocations.push({
        batchId: ref.id,
        qty: take,
        unitCost: cost,
        lineCost: Number((take * cost).toFixed(2)),
      });

      need = Number((need - take).toFixed(3));
    }

    if (need > 0 && !allowNegative) {
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
