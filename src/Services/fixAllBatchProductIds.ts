// src/Services/fixAllBatchProductIds.ts
import {
  collection,
  getDocs,
  updateDoc,
  doc as fsDoc,
} from "firebase/firestore";
import { db } from "../firebase";

type FixSummary = {
  checked: number; // lotes revisados
  fixed: number; // lotes corregidos (se actualizó productId)
  alreadyOk: number; // ya estaban bien
  missingName: number; // lotes sin productName
  withoutMatch: number; // no se encontró un product con ese nombre
  details: Array<{
    batchId: string;
    productName: string;
    oldProductId?: string;
    newProductId?: string;
    status: "fixed" | "alreadyOk" | "missingName" | "withoutMatch";
  }>;
};

function normalizeName(s: string | undefined | null) {
  return (s || "").trim().toLowerCase();
}

/**
 * Recorre todos los products y arma un mapa name -> productId
 */
async function buildNameToProductIdMap() {
  const productsSnap = await getDocs(collection(db, "products"));
  const map = new Map<string, string>();

  productsSnap.forEach((d) => {
    const p = d.data() as any;
    const nm = normalizeName(p.name ?? p.productName);
    if (nm) map.set(nm, d.id);
  });

  return map;
}

/**
 * Corrige TODOS los documentos de inventory_batches cuyo productId no coincida
 * con el producto (según el name/productName). Usa el nombre como fuente de verdad.
 *
 * @param dryRun Si es true, NO escribe en Firestore (solo simula). Por defecto false.
 */
export async function fixAllBatchProductIds(
  dryRun = false
): Promise<FixSummary> {
  const nameToId = await buildNameToProductIdMap();
  const batchesSnap = await getDocs(collection(db, "inventory_batches"));

  const summary: FixSummary = {
    checked: 0,
    fixed: 0,
    alreadyOk: 0,
    missingName: 0,
    withoutMatch: 0,
    details: [],
  };

  for (const d of batchesSnap.docs) {
    summary.checked++;
    const b = d.data() as any;
    const name = normalizeName(b.productName);

    if (!name) {
      summary.missingName++;
      summary.details.push({
        batchId: d.id,
        productName: b.productName ?? "",
        oldProductId: b.productId,
        status: "missingName",
      });
      continue;
    }

    const shouldBeId = nameToId.get(name);
    if (!shouldBeId) {
      summary.withoutMatch++;
      summary.details.push({
        batchId: d.id,
        productName: b.productName ?? "",
        oldProductId: b.productId,
        status: "withoutMatch",
      });
      continue;
    }

    if (b.productId === shouldBeId) {
      summary.alreadyOk++;
      summary.details.push({
        batchId: d.id,
        productName: b.productName ?? "",
        oldProductId: b.productId,
        newProductId: shouldBeId,
        status: "alreadyOk",
      });
      continue;
    }

    // Necesita corrección
    if (!dryRun) {
      await updateDoc(fsDoc(db, "inventory_batches", d.id), {
        productId: shouldBeId,
      });
    }
    summary.fixed++;
    summary.details.push({
      batchId: d.id,
      productName: b.productName ?? "",
      oldProductId: b.productId,
      newProductId: shouldBeId,
      status: "fixed",
    });
  }

  // Logs útiles en consola
  console.group("[fixAllBatchProductIds] Resultado");
  console.log("checked:", summary.checked);
  console.log("fixed:", summary.fixed);
  console.log("alreadyOk:", summary.alreadyOk);
  console.log("missingName:", summary.missingName);
  console.log("withoutMatch:", summary.withoutMatch);
  console.groupEnd();

  return summary;
}

/**
 * Helper opcional: corrige SOLO lotes de un producto por nombre.
 */
export async function fixBatchesByProductName(
  productName: string,
  dryRun = false
) {
  const nameNorm = normalizeName(productName);
  const nameToId = await buildNameToProductIdMap();
  const shouldBeId = nameToId.get(nameNorm);

  if (!shouldBeId) {
    throw new Error(
      `No existe un producto activo con nombre "${productName}".`
    );
  }

  const batchesSnap = await getDocs(collection(db, "inventory_batches"));
  let fixed = 0;

  for (const d of batchesSnap.docs) {
    const b = d.data() as any;
    if (
      normalizeName(b.productName) === nameNorm &&
      b.productId !== shouldBeId
    ) {
      if (!dryRun) {
        await updateDoc(fsDoc(db, "inventory_batches", d.id), {
          productId: shouldBeId,
        });
      }
      fixed++;
    }
  }

  console.log(
    `[fixBatchesByProductName] "${productName}" fixed: ${fixed} lote(s)`
  );
  return fixed;
}
