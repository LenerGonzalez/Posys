import { db } from "../firebase";
import {
  doc,
  runTransaction,
  collection,
  Timestamp,
  addDoc,
} from "firebase/firestore";

type TransferArgs = {
  fromVendorOrderId: string; // doc id inventory_candies_sellers (origen)
  toVendorOrderId: string; // doc id inventory_candies_sellers (destino)
  packages: number;
  userEmail?: string;
  comment?: string;
};

export async function transferVendorPackages({
  fromVendorOrderId,
  toVendorOrderId,
  packages,
  userEmail = "",
  comment = "",
}: TransferArgs) {
  const qty = Number(packages || 0);
  if (!(qty > 0)) throw new Error("Cantidad inválida");

  const fromRef = doc(db, "inventory_candies_sellers", fromVendorOrderId);
  const toRef = doc(db, "inventory_candies_sellers", toVendorOrderId);

  await runTransaction(db, async (tx) => {
    const fromSnap = await tx.get(fromRef);
    const toSnap = await tx.get(toRef);

    if (!fromSnap.exists()) throw new Error("Orden origen no existe");
    if (!toSnap.exists()) throw new Error("Orden destino no existe");

    const from = fromSnap.data() as any;
    const to = toSnap.data() as any;

    // Validaciones de compatibilidad (recomendado)
    const fromProductId = String(from.productId || "");
    const toProductId = String(to.productId || "");
    if (fromProductId && toProductId && fromProductId !== toProductId) {
      throw new Error("No se puede trasladar entre productos distintos");
    }

    const fromUPP = Number(from.unitsPerPackage || 0);
    const toUPP = Number(to.unitsPerPackage || 0);
    if (fromUPP && toUPP && fromUPP !== toUPP) {
      throw new Error("unitsPerPackage no coincide");
    }

    const upp = fromUPP || toUPP || 0;
    const unitsMoved = upp > 0 ? qty * upp : 0;

    const fromRem = Number(from.remainingPackages ?? 0);
    if (fromRem < qty) throw new Error("Origen no tiene suficientes paquetes");

    // ✅ mover EXISTENCIA (remaining)
    tx.update(fromRef, {
      remainingPackages: fromRem - qty,
      ...(upp > 0
        ? { remainingUnits: Number(from.remainingUnits ?? 0) - unitsMoved }
        : {}),
    });

    tx.update(toRef, {
      remainingPackages: Number(to.remainingPackages ?? 0) + qty,
      ...(upp > 0
        ? { remainingUnits: Number(to.remainingUnits ?? 0) + unitsMoved }
        : {}),
    });

    // registro (audit)
    const auditRef = doc(collection(db, "inventory_transfers_candies"));
    tx.set(auditRef, {
      fromVendorOrderId,
      toVendorOrderId,
      fromSellerId: from.sellerId || "",
      fromSellerName: from.sellerName || "",
      toSellerId: to.sellerId || "",
      toSellerName: to.sellerName || "",
      productId: fromProductId || toProductId || "",
      productName: from.productName || to.productName || "",
      packagesMoved: qty,
      unitsMoved,
      comment,
      createdBy: userEmail,
      createdAt: Timestamp.now(),
      date: new Date().toISOString().slice(0, 10),
    });
  });
}
