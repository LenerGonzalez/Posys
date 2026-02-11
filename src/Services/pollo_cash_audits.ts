// src/Services/pollo_cash_audits.ts
import {
  addDoc,
  collection,
  deleteDoc,
  doc,
  getDocs,
  orderBy,
  query,
  Timestamp,
  where,
  DocumentData,
} from "firebase/firestore";
import { db } from "../firebase";

export type PolloCashAudit = {
  id: string;

  createdAt: any; // Timestamp
  createdByUid: string;
  createdByName: string;

  contadorUid: string;
  contadorName: string;

  entregadoPor: string; // quien entrega
  recibidoPor: string; // quien recibe (campo obligatorio en tu spec "Entregado a" pero aclarado)

  rangeFrom: string; // yyyy-MM-dd
  rangeTo: string; // yyyy-MM-dd

  ventasCash: number;
  abonos: number;
  ingresosExtra: number;
  debitos: number;

  subTotal: number;
  totalEntregado: number;

  comment?: string;
};

const COL = "pollo_cash_audits";

export async function createPolloCashAudit(
  payload: Omit<PolloCashAudit, "id">,
) {
  const ref = await addDoc(collection(db, COL), {
    ...payload,
    createdAt: payload.createdAt ?? Timestamp.now(),
  });
  return ref.id;
}

export async function listPolloCashAudits(params?: {
  createdFrom?: Date; // filtro por createdAt
  createdTo?: Date; // inclusive-ish
}) {
  const colRef = collection(db, COL);

  const q = (() => {
    if (params?.createdFrom && params?.createdTo) {
      // Firestore: Timestamp bounds
      const fromTs = Timestamp.fromDate(params.createdFrom);
      const toTs = Timestamp.fromDate(params.createdTo);
      return query(
        colRef,
        where("createdAt", ">=", fromTs),
        where("createdAt", "<=", toTs),
        orderBy("createdAt", "desc"),
      );
    }
    return query(colRef, orderBy("createdAt", "desc"));
  })();

  const snap = await getDocs(q);
  const rows: PolloCashAudit[] = snap.docs.map((d) => {
    const data = d.data() as DocumentData;
    return {
      id: d.id,
      createdAt: data.createdAt,
      createdByUid: data.createdByUid || "",
      createdByName: data.createdByName || "",
      contadorUid: data.contadorUid || "",
      contadorName: data.contadorName || "",
      entregadoPor: data.entregadoPor || "",
      recibidoPor: data.recibidoPor || "",
      rangeFrom: data.rangeFrom || "",
      rangeTo: data.rangeTo || "",
      ventasCash: Number(data.ventasCash || 0),
      abonos: Number(data.abonos || 0),
      ingresosExtra: Number(data.ingresosExtra || 0),
      debitos: Number(data.debitos || 0),
      subTotal: Number(data.subTotal || 0),
      totalEntregado: Number(data.totalEntregado || 0),
      comment: data.comment || "",
    };
  });

  return rows;
}

export async function deletePolloCashAudit(id: string) {
  await deleteDoc(doc(db, COL, id));
}
