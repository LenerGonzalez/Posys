// services/stock.ts
import { collection, getDocs, orderBy, query, where } from "firebase/firestore";
import { db } from "../firebase";

export async function getDisponibleByProductId(productId: string) {
  const q = query(
    collection(db, "inventory_batches"),
    where("productId", "==", productId),
    orderBy("date", "asc") // opcional aquí, útil para consumo
  );
  const snap = await getDocs(q);
  let total = 0;
  snap.forEach((d) => (total += Number((d.data() as any).remaining || 0)));
  return Math.max(0, Math.floor(total * 100) / 100);
}
