// src/Services/allocateFIFO.ts
import {
  collection,
  doc,
  getDocs,
  orderBy,
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
 * Requiere un índice compuesto en Firestore para la colección `inventoryBatches`:
 *   Campos: productName (ASC), createdAt (ASC)
 *   (Si decides filtrar remaining > 0, añade remaining (ASC) antes de createdAt
 *    y respeta ese orden en el query con orderBy("remaining"), orderBy("createdAt")).
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

  // 🔹 Consulta indexada: FIFO por fecha de creación
  const q = query(
    collection(db, "inventoryBatches"),
    where("productName", "==", productName),
    // Si habilitas este filtro, recuerda crear índice: productName ASC, remaining ASC, createdAt ASC
    // where("remaining", ">", 0),
    orderBy("createdAt", "asc")
  );

  const snap = await getDocs(q);
  const batchRefs = snap.docs.map((d) => doc(db, "inventoryBatches", d.id));

  return runTransaction(db, async (tx) => {
    let need = Number(quantityNeeded);
    const allocations: Allocation[] = [];

    for (const ref of batchRefs) {
      if (need <= 0) break;

      const ds = await tx.get(ref);
      if (!ds.exists()) continue;

      const data = ds.data() as any;
      const qty = Number(data.quantity ?? 0);
      const rem = Number(data.remaining ?? qty); // fallback si aún no existe remaining
      const cost = Number(data.costPrice ?? 0);

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
      // Al estar en transacción, no se aplican cambios si lanzamos error
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
