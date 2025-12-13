import * as XLSX from "xlsx";
import {
  collection,
  getDocs,
  query,
  where,
  writeBatch,
  doc,
} from "firebase/firestore";
import { db } from "../firebase";

type ImportRow = {
  name: string;
  category: string;
  providerPrice: number;
  unitsPerPackage: number;
  sku?: string;
};

const norm = (s: string) =>
  String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[^\w\s-]/g, "");

function buildKey(r: ImportRow) {
  if (r.sku && String(r.sku).trim()) return `sku:${String(r.sku).trim()}`;
  return `key:${norm(r.category)}__${norm(r.name)}`;
}

export function parseFileToRows(file: File): Promise<ImportRow[]> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("No se pudo leer el archivo."));
    reader.onload = () => {
      const data = new Uint8Array(reader.result as ArrayBuffer);
      const wb = XLSX.read(data, { type: "array" });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const json = XLSX.utils.sheet_to_json<Record<string, any>>(ws, {
        defval: "",
      });

      const rows: ImportRow[] = json.map((r) => ({
        sku: String(r.sku || r.SKU || "").trim() || undefined,
        name: String(r.name || r.Nombre || "").trim(),
        category: String(r.category || r.Categoria || "").trim(),
        providerPrice: Number(
          r.providerPrice || r.Precio || r["Precio proveedor"] || 0
        ),
        unitsPerPackage: Number(
          r.unitsPerPackage || r["Und x Paq"] || r.Unidades || 1
        ),
      }));

      resolve(rows);
    };
    reader.readAsArrayBuffer(file);
  });
}

export async function upsertCandyProducts(rows: ImportRow[]) {
  // 1) Validación
  const cleaned = rows
    .map((r) => ({
      ...r,
      providerPrice: Number.isFinite(r.providerPrice) ? r.providerPrice : 0,
      unitsPerPackage: Math.max(1, Math.floor(Number(r.unitsPerPackage || 1))),
    }))
    .filter((r) => r.name && r.category);

  if (!cleaned.length) throw new Error("No hay filas válidas para importar.");

  // 2) Traer catálogo actual para mapear existentes
  const snap = await getDocs(collection(db, "products_candies"));
  const existingByKey: Record<string, { id: string }> = {};

  snap.forEach((d) => {
    const x = d.data() as any;
    const key =
      (x.sku ? `sku:${String(x.sku).trim()}` : "") ||
      `key:${norm(x.category)}__${norm(x.name)}`;
    existingByKey[key] = { id: d.id };
  });

  // 3) Batch write (500 ops máximo por batch)
  let batch = writeBatch(db);
  let ops = 0;

  const commit = async () => {
    if (ops === 0) return;
    await batch.commit();
    batch = writeBatch(db);
    ops = 0;
  };

  for (const r of cleaned) {
    const key = buildKey(r);
    const existing = existingByKey[key];

    if (existing) {
      batch.update(doc(db, "products_candies", existing.id), {
        name: r.name,
        category: r.category,
        providerPrice: r.providerPrice,
        unitsPerPackage: r.unitsPerPackage,
        ...(r.sku ? { sku: String(r.sku).trim() } : {}),
      });
    } else {
      const ref = doc(collection(db, "products_candies"));
      batch.set(ref, {
        name: r.name,
        category: r.category,
        providerPrice: r.providerPrice,
        unitsPerPackage: r.unitsPerPackage,
        ...(r.sku ? { sku: String(r.sku).trim() } : {}),
        createdAt: new Date(),
      });
      existingByKey[key] = { id: ref.id };
    }

    ops++;
    if (ops >= 450) await commit(); // margen seguro
  }

  await commit();
  return { imported: cleaned.length };
}
