import {
  collection,
  doc,
  getDocs,
  query,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import { db } from "../firebase";

const CHUNK = 400;

function upperOrUndef(s: string | undefined): string | undefined {
  if (s == null) return undefined;
  const t = String(s).trim();
  return t ? t.toUpperCase() : "";
}

/**
 * Propaga nombre / categoría / unidad de medida a documentos que denormalizan el producto.
 * No modifica montos, cantidades ni IDs de venta; solo etiquetas de texto.
 */
export async function propagatePolloProductDisplayFields(
  productId: string,
  fields: {
    name?: string;
    category?: string;
    measurement?: string;
  },
): Promise<{ batches: number; salesUpdated: number }> {
  if (!productId) throw new Error("productId requerido");

  let batches = 0;
  let salesUpdated = 0;

  // --- inventory_batches ---
  const qb = query(
    collection(db, "inventory_batches"),
    where("productId", "==", productId),
  );
  const snapB = await getDocs(qb);
  let batch = writeBatch(db);
  let ops = 0;

  for (const d of snapB.docs) {
    const upd: Record<string, unknown> = {};
    if (fields.name != null) upd.productName = fields.name;
    if (fields.category != null) upd.category = upperOrUndef(fields.category) ?? "";
    if (fields.measurement != null) {
      upd.unit = fields.measurement;
    }
    if (Object.keys(upd).length === 0) continue;
    batch.update(doc(db, "inventory_batches", d.id), upd);
    ops++;
    batches++;
    if (ops >= CHUNK) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  // --- salesV2: items[].productName donde items[].productId coincide ---
  const snapS = await getDocs(collection(db, "salesV2"));
  batch = writeBatch(db);
  ops = 0;

  for (const d of snapS.docs) {
    const data = d.data() as Record<string, unknown>;
    const items = Array.isArray(data.items) ? (data.items as any[]) : [];
    if (items.length === 0) continue;

    let changed = false;
    const newItems = items.map((it) => {
      const pid = String(it?.productId ?? "").trim();
      if (pid !== productId) return it;
      const next = { ...it };
      if (fields.name != null && next.productName !== fields.name) {
        next.productName = fields.name;
        changed = true;
      }
      return next;
    });

    if (changed) {
      batch.update(doc(db, "salesV2", d.id), { items: newItems });
      ops++;
      salesUpdated++;
      if (ops >= CHUNK) {
        await batch.commit();
        batch = writeBatch(db);
        ops = 0;
      }
    }
  }
  if (ops > 0) await batch.commit();

  // --- batch_allocations (opcional: solo nombre legible) ---
  const qa = query(
    collection(db, "batch_allocations"),
    where("productId", "==", productId),
  );
  const snapA = await getDocs(qa);
  batch = writeBatch(db);
  ops = 0;
  for (const d of snapA.docs) {
    if (fields.name == null) continue;
    batch.update(doc(db, "batch_allocations", d.id), {
      productName: fields.name,
    });
    ops++;
    if (ops >= CHUNK) {
      await batch.commit();
      batch = writeBatch(db);
      ops = 0;
    }
  }
  if (ops > 0) await batch.commit();

  return { batches, salesUpdated };
}
