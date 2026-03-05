// src/components/CierreVentas.tsx
import React, { useEffect, useRef, useState } from "react";
import { db } from "../../firebase";
import {
  collection,
  getDocs,
  addDoc,
  Timestamp,
  query,
  where,
  onSnapshot,
  writeBatch,
  doc,
  updateDoc,
} from "firebase/firestore";
import { format } from "date-fns";
import { hasRole } from "../../utils/roles";
import html2canvas from "html2canvas";
import jsPDF from "jspdf";
import { restoreSaleAndDelete } from "../../Services/inventory";
import RefreshButton from "../../components/common/RefreshButton";
import useManualRefresh from "../../hooks/useManualRefresh";
import { canAction } from "../../utils/access";

type FireTimestamp = { toDate?: () => Date } | undefined;

interface SaleDataRaw {
  id?: string;
  productName?: string;
  quantity?: number;
  amount?: number;
  amountCharged?: number;
  amountSuggested?: number;
  measurement?: string;
  type?: "CREDITO" | "CONTADO";
  date?: string;
  userEmail?: string;
  vendor?: string;
  clientName?: string;
  amountReceived?: number;
  change?: string | number;
  status?: "FLOTANTE" | "PROCESADA";
  timestamp?: FireTimestamp;
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
  items?: any[]; // ← importante para multi-ítems
}

interface SaleData {
  id: string;
  productName: string;
  quantity: number;
  amount: number;
  amountSuggested: number;
  date: string;
  userEmail: string;
  clientName: string;
  amountReceived: number;
  change: string;
  status: "FLOTANTE" | "PROCESADA";
  type: "CREDITO" | "CONTADO";
  measurement?: string;
  allocations?: {
    batchId: string;
    qty: number;
    unitCost: number;
    lineCost: number;
  }[];
  avgUnitCost?: number;
  cogsAmount?: number;
}

interface ClosureData {
  id: string;
  date: string;
  createdAt: any;
  products: { productName: string; quantity: number; amount: number }[];
  totalUnits: number;
  totalCharged: number;
  totalSuggested: number;
  totalDifference: number;
  salesV2?: any[];
  productSummary?: {
    productName: string;
    totalQuantity: number;
    totalAmount: number;
  }[];
  totalCOGS?: number;
  grossProfit?: number;
}

// helpers
const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;
const round3 = (n: number) => Math.round((Number(n) || 0) * 1000) / 1000;
const money = (n: unknown) => Number(n ?? 0).toFixed(2);
const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);

// Normaliza UNA venta en MÚLTIPLES filas si trae items[]
// const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
//   const date =
//     raw.date ??
//     (raw.timestamp?.toDate
//       ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
//       : "");
//   if (!date) return [];
//
//   const saleType: "CREDITO" | "CONTADO" = raw.type ?? "CONTADO";
//
//   if (Array.isArray(raw.items) && raw.items.length > 0) {
//     return raw.items.map((it, idx) => {
//       const qty = Number(it?.qty ?? 0);
//       const lineFinal =
//         Number(it?.lineFinal ?? 0) ||
//         Math.max(
//           0,
//           Number(it?.unitPrice || 0) * qty - Number(it?.discount || 0),
//         );
//       return {
//         id: `${id}#${idx}`,
//         productName: String(it?.productName ?? "(sin nombre)"),
//         quantity: qty,
//         amount: round2(lineFinal),
//         amountSuggested: Number(raw.amountSuggested ?? 0),
//         date,
//         userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
//         clientName: raw.clientName ?? "",
//         amountReceived: Number(raw.amountReceived ?? 0),
//         change: String(raw.change ?? "0"),
//         status: (raw.status as any) ?? "FLOTANTE",
//         type: saleType,
//         measurement: String(it?.measurement ?? raw.measurement ?? ""),
//         allocations: Array.isArray(it?.allocations)
//           ? it.allocations
//           : raw.allocations,
//         avgUnitCost: Number(it?.avgUnitCost ?? raw.avgUnitCost ?? 0),
//         cogsAmount: Number(it?.cogsAmount ?? 0),
//       };
//     });
//   }
//
//   return [
//     {
//       id,
//       productName: raw.productName ?? "(sin nombre)",
//       quantity: Number(raw.quantity ?? 0),
//       amount: Number(raw.amount ?? raw.amountCharged ?? 0),
//       amountSuggested: Number(raw.amountSuggested ?? 0),
//       date,
//       userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
//       clientName: raw.clientName ?? "",
//       amountReceived: Number(raw.amountReceived ?? 0),
//       change: String(raw.change ?? "0"),
//       status: (raw.status as any) ?? "FLOTANTE",
//       type: saleType,
//       measurement: String(raw.measurement ?? ""),
//       allocations: raw.allocations,
//       avgUnitCost: raw.avgUnitCost,
//       cogsAmount: raw.cogsAmount,
//     },
//   ];
// };

const normalizeMany = (raw: SaleDataRaw, id: string): SaleData[] => {
  const dateFromField = raw.date ? String(raw.date) : "";
  const dateFromTs = raw.timestamp?.toDate
    ? format(raw.timestamp.toDate()!, "yyyy-MM-dd")
    : "";

  // ✅ Si hay raw.date pero está desfasada vs timestamp, gana timestamp
  let date = dateFromField || dateFromTs;

  if (dateFromField && dateFromTs) {
    const a = new Date(dateFromField + "T00:00:00").getTime();
    const b = new Date(dateFromTs + "T00:00:00").getTime();
    const diffDays = Math.abs(a - b) / (1000 * 60 * 60 * 24);
    if (isFinite(diffDays) && diffDays > 30) {
      date = dateFromTs;
    }
  }

  if (!date) return [];

  const saleType: "CREDITO" | "CONTADO" = raw.type ?? "CONTADO";

  if (Array.isArray(raw.items) && raw.items.length > 0) {
    return raw.items.map((it, idx) => {
      const qty = Number(it?.qty ?? 0);
      const lineFinal =
        Number(it?.lineFinal ?? 0) ||
        Math.max(
          0,
          Number(it?.unitPrice || 0) * qty - Number(it?.discount || 0),
        );

      return {
        id: `${id}#${idx}`,
        productName: String(it?.productName ?? "(sin nombre)"),
        quantity: qty,
        amount: round2(lineFinal),
        amountSuggested: Number(raw.amountSuggested ?? 0),
        date,
        userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
        clientName: raw.clientName ?? "",
        amountReceived: Number(raw.amountReceived ?? 0),
        change: String(raw.change ?? "0"),
        status: (raw.status as any) ?? "FLOTANTE",
        type: saleType,
        measurement: String(it?.measurement ?? raw.measurement ?? ""),
        allocations: Array.isArray(it?.allocations)
          ? it.allocations
          : raw.allocations,
        avgUnitCost: Number(it?.avgUnitCost ?? raw.avgUnitCost ?? 0),
        cogsAmount: Number(it?.cogsAmount ?? 0),
      };
    });
  }

  return [
    {
      id,
      productName: raw.productName ?? "(sin nombre)",
      quantity: Number(raw.quantity ?? 0),
      amount: Number(raw.amount ?? raw.amountCharged ?? 0),
      amountSuggested: Number(raw.amountSuggested ?? 0),
      date,
      userEmail: raw.userEmail ?? raw.vendor ?? "(sin usuario)",
      clientName: raw.clientName ?? "",
      amountReceived: Number(raw.amountReceived ?? 0),
      change: String(raw.change ?? "0"),
      status: (raw.status as any) ?? "FLOTANTE",
      type: saleType,
      measurement: String(raw.measurement ?? ""),
      allocations: raw.allocations,
      avgUnitCost: raw.avgUnitCost,
      cogsAmount: raw.cogsAmount,
    },
  ];
};

export default function CierreVentas({
  role,
  roles,
}: {
  role?: string;
  roles?: string[];
}): React.ReactElement {
  const [salesV2, setSales] = useState<SaleData[]>([]);
  const [floatersExtra, setFloatersExtra] = useState<SaleData[]>([]);
  const [closure, setClosure] = useState<ClosureData | null>(null);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const [filter, setFilter] = useState<"ALL" | "FLOTANTE" | "PROCESADA">("ALL");
  const [operationFilter, setOperationFilter] = useState<
    "ALL" | "CREDITO" | "CONTADO"
  >("ALL");
  const [userNameByEmail, setUserNameByEmail] = useState<
    Record<string, string>
  >({});

  const [editing, setEditing] = useState<null | SaleData>(null);
  const [editQty, setEditQty] = useState<number>(0);
  const [editAmount, setEditAmount] = useState<number>(0);
  const [editClient, setEditClient] = useState<string>("");
  const [editPaid, setEditPaid] = useState<number>(0);
  const [editChange, setEditChange] = useState<string>("0");

  const today = format(new Date(), "yyyy-MM-dd");
  const [startDate, setStartDate] = useState<string>(today);
  const [endDate, setEndDate] = useState<string>(today);

  // ✅ NUEVOS: colapsables (todo nace colapsado)
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [ventasOpen, setVentasOpen] = useState(false);
  const [consolidadoOpen, setConsolidadoOpen] = useState(false);
  const [indicadoresOpen, setIndicadoresOpen] = useState(false);

  // ✅ NUEVO: filtro por producto
  const [productFilter, setProductFilter] = useState<string>("");

  // paginacion (tabla contado y credito)
  const PAGE_SIZE = 25;
  const [cashPage, setCashPage] = useState(1);
  const [creditPage, setCreditPage] = useState(1);
  const [pdfMode, setPdfMode] = useState(false);
  const [cashTableOpen, setCashTableOpen] = useState(true);
  const [creditTableOpen, setCreditTableOpen] = useState(true);

  const pdfRef = useRef<HTMLDivElement>(null);
  const { refreshKey, refresh } = useManualRefresh();

  //calcular roles
  const subject = roles && roles.length ? roles : role;
  const cierreVentas = canAction(subject, "bills", "cerrarVentas");

  const isAdmin = hasRole(subject, "admin");

  const SectionHeader = ({
    title,
    open,
    onToggle,
    right,
  }: {
    title: string;
    open: boolean;
    onToggle: () => void;
    right?: React.ReactNode;
  }) => {
    return (
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-4 py-3 rounded-xl border bg-gray-50 hover:bg-gray-100 active:bg-gray-200"
      >
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold truncate">{title}</span>
          {right ? (
            <span className="text-xs text-gray-600">{right}</span>
          ) : null}
        </div>
        <div className="shrink-0 text-lg font-bold leading-none">
          {open ? "−" : "+"}
        </div>
      </button>
    );
  };

  // Ventas por PERIODO
  useEffect(() => {
    if (!startDate || !endDate) return;

    setLoading(true);

    const q = query(
      collection(db, "salesV2"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
    );

    const unsub = onSnapshot(
      q,
      (snap) => {
        const rows: SaleData[] = [];
        snap.forEach((d) => {
          const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
          rows.push(...parts);
        });
        setSales(rows);
        setLoading(false);
      },
      (err) => {
        console.error("Error cargando ventas por periodo:", err);
        setSales([]);
        setLoading(false);
      },
    );

    return () => unsub();
  }, [startDate, endDate, refreshKey]);

  // FLOTANTE en el período
  useEffect(() => {
    if (!startDate || !endDate) return;

    const qFlo = query(
      collection(db, "salesV2"),
      where("status", "==", "FLOTANTE"),
      where("date", ">=", startDate),
      where("date", "<=", endDate),
    );

    const unsub = onSnapshot(qFlo, (snap) => {
      const rows: SaleData[] = [];
      snap.forEach((d) => {
        const parts = normalizeMany(d.data() as SaleDataRaw, d.id);
        rows.push(...parts);
      });
      setFloatersExtra(rows);
    });

    return () => unsub();
  }, [startDate, endDate, refreshKey]);

  // Cargar usuarios para mostrar nombre del vendedor
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDocs(collection(db, "users"));
        const map: Record<string, string> = {};
        snap.forEach((d) => {
          const u = d.data() as any;
          const email = String(u.email || "")
            .trim()
            .toLowerCase();
          const name = String(u.name || "").trim();
          if (email) map[email] = name || u.email || "";
        });
        setUserNameByEmail(map);
      } catch (e) {
        console.error("Error cargando usuarios:", e);
        setUserNameByEmail({});
      }
    })();
  }, []);

  const displaySeller = (email?: string) => {
    const key = String(email || "")
      .trim()
      .toLowerCase();
    return userNameByEmail[key] || email || "—";
  };

  // Cierre guardado (informativo)
  useEffect(() => {
    const fetchClosure = async () => {
      const q = query(
        collection(db, "daily_closures"),
        where("date", "==", today),
      );
      const snapshot = await getDocs(q);
      if (!snapshot.empty) {
        const d = snapshot.docs[0];
        setClosure({ id: d.id, ...d.data() } as ClosureData);
      } else {
        setClosure(null);
      }
    };
    fetchClosure();
  }, [today, refreshKey]);

  // Ventas visibles (con filtro por producto)
  const visibleSales = React.useMemo(() => {
    let base: SaleData[] = [];

    if (filter === "FLOTANTE") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) if (s.status === "FLOTANTE") map.set(s.id, s);
      base = Array.from(map.values());
    } else if (filter === "ALL") {
      const all = [...salesV2, ...floatersExtra];
      const map = new Map<string, SaleData>();
      for (const s of all) map.set(s.id, s);
      base = Array.from(map.values());
    } else {
      base = salesV2.filter((s) => s.status === "PROCESADA");
    }

    if (operationFilter !== "ALL") {
      base = base.filter((s) => s.type === operationFilter);
    }

    const pf = productFilter.trim().toLowerCase();
    if (pf) {
      const norm = (x: string) =>
        String(x || "")
          .toLowerCase()
          .normalize("NFD")
          .replace(/[\u0300-\u036f]/g, "");

      const pfNorm = norm(pf);
      base = base.filter((s) => norm(s.productName).includes(pfNorm));
    }

    return base;
  }, [filter, salesV2, floatersExtra, productFilter, operationFilter]);

  // Totales visibles
  const totalCharged = round2(
    visibleSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );
  const totalCOGSVisible = round2(
    visibleSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );
  const grossProfitVisible = round2(totalCharged - totalCOGSVisible);

  const isUnitMeasure = (m?: string) =>
    String(m || "")
      .trim()
      .toLowerCase() !== "lb";

  const cashSales = visibleSales.filter((s) => s.type === "CONTADO");
  const creditSales = visibleSales.filter((s) => s.type === "CREDITO");

  const cashTotalPages = Math.max(1, Math.ceil(cashSales.length / PAGE_SIZE));
  const creditTotalPages = Math.max(
    1,
    Math.ceil(creditSales.length / PAGE_SIZE),
  );

  const pagedCashSales = React.useMemo(() => {
    const start = (cashPage - 1) * PAGE_SIZE;
    return cashSales.slice(start, start + PAGE_SIZE);
  }, [cashSales, cashPage]);

  const pagedCreditSales = React.useMemo(() => {
    const start = (creditPage - 1) * PAGE_SIZE;
    return creditSales.slice(start, start + PAGE_SIZE);
  }, [creditSales, creditPage]);

  useEffect(() => {
    setCashPage(1);
    setCreditPage(1);
  }, [visibleSales]);

  useEffect(() => {
    setCashPage((p) => Math.min(p, cashTotalPages));
  }, [cashTotalPages]);

  useEffect(() => {
    setCreditPage((p) => Math.min(p, creditTotalPages));
  }, [creditTotalPages]);

  const showCashTable =
    operationFilter === "ALL" || operationFilter === "CONTADO";
  const showCreditTable =
    operationFilter === "ALL" || operationFilter === "CREDITO";

  const cashOpenEffective = pdfMode ? true : cashTableOpen;
  const creditOpenEffective = pdfMode ? true : creditTableOpen;

  const cashRowsForTable = pdfMode ? cashSales : pagedCashSales;
  const creditRowsForTable = pdfMode ? creditSales : pagedCreditSales;

  const totalUnitsCash = round3(
    cashSales
      .filter((s) => isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalLbsCash = round3(
    cashSales
      .filter((s) => !isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalUnitsCredit = round3(
    creditSales
      .filter((s) => isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );
  const totalLbsCredit = round3(
    creditSales
      .filter((s) => !isUnitMeasure(s.measurement))
      .reduce((sum, s) => sum + (s.quantity || 0), 0),
  );

  const totalSalesCash = round2(
    cashSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );
  const totalSalesCredit = round2(
    creditSales.reduce((sum, s) => sum + (s.amount || 0), 0),
  );

  const totalCOGSCash = round2(
    cashSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );
  const totalCOGSCredit = round2(
    creditSales.reduce((sum, s) => sum + Number(s.cogsAmount ?? 0), 0),
  );

  const grossProfitCash = round2(totalSalesCash - totalCOGSCash);
  const grossProfitCredit = round2(totalSalesCredit - totalCOGSCredit);

  const totalUnitsAll = round3(totalUnitsCash + totalUnitsCredit);
  const totalLbsAll = round3(totalLbsCash + totalLbsCredit);
  const totalSalesAll = round2(totalSalesCash + totalSalesCredit);

  // Consolidado por producto
  const productMap: Record<
    string,
    { totalQuantity: number; totalAmount: number }
  > = {};
  visibleSales.forEach((s) => {
    const key = s.productName || "(sin nombre)";
    if (!productMap[key])
      productMap[key] = { totalQuantity: 0, totalAmount: 0 };
    productMap[key].totalQuantity = round3(
      productMap[key].totalQuantity + (s.quantity || 0),
    );
    productMap[key].totalAmount = round2(
      productMap[key].totalAmount + (s.amount || 0),
    );
  });

  const productSummaryArray = Object.entries(productMap).map(
    ([productName, v]) => ({
      productName,
      totalQuantity: v.totalQuantity,
      totalAmount: v.totalAmount,
    }),
  );

  // Guardar cierre (misma lógica tuya)
  const handleSaveClosure = async () => {
    try {
      const candidatesVisible = visibleSales.filter(
        (s) => s.status === "FLOTANTE",
      );
      const toProcess =
        candidatesVisible.length > 0
          ? candidatesVisible
          : salesV2.filter((s) => s.status !== "PROCESADA");

      if (toProcess.length === 0) {
        setMessage("No hay ventas para procesar.");
        return;
      }

      const totals = {
        totalCharged: round2(
          toProcess.reduce((a, s) => a + (s.amount || 0), 0),
        ),
        totalSuggested: round2(
          toProcess.reduce((a, s) => a + (s.amountSuggested || 0), 0),
        ),
        totalUnits: round3(
          toProcess.reduce((a, s) => a + (s.quantity || 0), 0),
        ),
        totalCOGS: round2(
          toProcess.reduce((a, s) => a + Number(s.cogsAmount ?? 0), 0),
        ),
      };

      const diff = round2(totals.totalCharged - totals.totalSuggested);
      const grossProfit = round2(totals.totalCharged - totals.totalCOGS);

      const ref = await addDoc(collection(db, "daily_closures"), {
        date: today,
        createdAt: Timestamp.now(),
        periodStart: startDate,
        periodEnd: endDate,
        totalCharged: totals.totalCharged,
        totalSuggested: totals.totalSuggested,
        totalDifference: diff,
        totalUnits: totals.totalUnits,
        totalCOGS: totals.totalCOGS,
        grossProfit,
        products: toProcess.map((s) => ({
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
        })),
        salesV2: toProcess.map((s) => ({
          id: s.id,
          productName: s.productName,
          quantity: s.quantity,
          amount: s.amount,
          amountSuggested: s.amountSuggested,
          userEmail: s.userEmail,
          clientName: s.clientName,
          amountReceived: s.amountReceived,
          change: s.change,
          status: s.status,
          cogsAmount: s.cogsAmount ?? 0,
          avgUnitCost: s.avgUnitCost ?? null,
          allocations: s.allocations ?? [],
          date: s.date,
        })),
        productSummary: Object.entries(
          toProcess.reduce(
            (acc, s) => {
              const k = s.productName || "(sin nombre)";
              if (!acc[k]) acc[k] = { totalQuantity: 0, totalAmount: 0 };
              acc[k].totalQuantity = round3(
                acc[k].totalQuantity + (s.quantity || 0),
              );
              acc[k].totalAmount = round2(acc[k].totalAmount + (s.amount || 0));
              return acc;
            },
            {} as Record<
              string,
              { totalQuantity: number; totalAmount: number }
            >,
          ),
        ).map(([productName, v]) => ({
          productName,
          totalQuantity: v.totalQuantity,
          totalAmount: v.totalAmount,
        })),
      });

      const batch = writeBatch(db);
      toProcess.forEach((s) => {
        batch.update(doc(db, "salesV2", s.id.split("#")[0]), {
          status: "PROCESADA",
          closureId: ref.id,
          closureDate: today,
          date: s.date, // ✅ corrige el date malo
        });
      });
      await batch.commit();

      setMessage(`✅ Cierre guardado. Ventas procesadas: ${toProcess.length}.`);
    } catch (error) {
      console.error(error);
      setMessage("❌ Error al guardar el cierre.");
    }
  };

  const handleRevert = async (saleId: string) => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para revertir esta venta.");
      return;
    }
    if (
      !window.confirm("¿Revertir esta venta? Esta acción no se puede deshacer.")
    )
      return;

    try {
      await updateDoc(doc(db, "salesV2", saleId.split("#")[0]), {
        status: "FLOTANTE",
        closureId: null,
        closureDate: null,
      });
      setMessage("↩️ Venta revertida a FLOTANTE.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo revertir la venta.");
    }
  };

  const openEdit = (s: SaleData) => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para editar esta venta.");
      return;
    }
    setEditing(s);
    setEditQty(s.quantity);
    setEditAmount(s.amount);
    setEditClient(s.clientName);
    setEditPaid(s.amountReceived);
    setEditChange(s.change);
  };

  const saveEdit = async () => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para guardar cambios.");
      return;
    }
    if (!editing) return;

    try {
      await updateDoc(doc(db, "salesV2", editing.id.split("#")[0]), {
        quantity: editQty,
        amount: editAmount,
        amountCharged: editAmount,
        clientName: editClient,
        amountReceived: editPaid,
        change: editChange,
      });
      setEditing(null);
      setMessage("✅ Venta actualizada.");
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo actualizar la venta.");
    }
  };

  const deleteSale = async (saleId: string) => {
    if (!isAdmin) {
      setMessage("❌ No tienes permisos para eliminar esta venta.");
      return;
    }
    if (
      !window.confirm(
        "¿Eliminar esta venta? Se restaurará el stock en los lotes asignados.",
      )
    )
      return;

    try {
      const { restored } = await restoreSaleAndDelete(saleId.split("#")[0]);
      setMessage(
        `🗑️ Venta eliminada. Stock restaurado: ${Number(restored).toFixed(2)}.`,
      );
    } catch (e) {
      console.error(e);
      setMessage("❌ No se pudo eliminar la venta.");
    }
  };

  const handleDownloadPDF = async () => {
    if (!pdfRef.current) return;

    // ✅ fuerza modo PDF (muestra tabla desktop aunque estés en móvil)
    pdfRef.current.classList.add("force-pdf-colors");
    pdfRef.current.classList.add("pdf-print-mode");
    setPdfMode(true);

    try {
      const canvas = await html2canvas(pdfRef.current, {
        backgroundColor: "#ffffff",
      });
      const imgData = canvas.toDataURL("image/png");
      const pdf = new jsPDF();
      pdf.addImage(imgData, "PNG", 10, 10, 190, 0);
      pdf.save(`cierre_${today}.pdf`);
    } finally {
      pdfRef.current.classList.remove("pdf-print-mode");
      pdfRef.current.classList.remove("force-pdf-colors");
      setPdfMode(false);
    }
  };

  const renderProPager = (
    page: number,
    totalPages: number,
    onPage: (p: number) => void,
    totalItems: number,
  ) => {
    const pages: number[] = [];
    const maxBtns = 7;
    if (totalPages <= maxBtns) {
      for (let i = 1; i <= totalPages; i++) pages.push(i);
    } else {
      const left = Math.max(1, page - 2);
      const right = Math.min(totalPages, page + 2);
      pages.push(1);
      if (left > 2) pages.push(-1 as any);
      for (let i = left; i <= right; i++)
        if (i !== 1 && i !== totalPages) pages.push(i);
      if (right < totalPages - 1) pages.push(-2 as any);
      pages.push(totalPages);
    }

    return (
      <div className="flex flex-col sm:flex-row sm:items-center gap-2 justify-between mt-3">
        <div className="flex items-center gap-1 flex-wrap">
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={() => onPage(1)}
            disabled={page === 1}
          >
            « Primero
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={() => onPage(Math.max(1, page - 1))}
            disabled={page === 1}
          >
            ‹ Anterior
          </button>
          {pages.map((p, idx) =>
            typeof p === "number" ? (
              <button
                key={idx}
                className={`px-3 py-1 border rounded ${
                  p === page ? "bg-blue-600 text-white" : ""
                }`}
                onClick={() => onPage(p)}
              >
                {p}
              </button>
            ) : (
              <span key={idx} className="px-2">
                …
              </span>
            ),
          )}
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={() => onPage(Math.min(totalPages, page + 1))}
            disabled={page === totalPages}
          >
            Siguiente ›
          </button>
          <button
            className="px-2 py-1 border rounded disabled:opacity-50"
            onClick={() => onPage(totalPages)}
            disabled={page === totalPages}
          >
            Último »
          </button>
        </div>
        <div className="text-sm text-gray-600">
          Página {page} de {totalPages} • {totalItems} registro(s)
        </div>
      </div>
    );
  };

  const renderSalesTable = (rows: SaleData[]) => (
    <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
      <table className="min-w-full w-full text-sm">
        <thead className="bg-slate-100 sticky top-0 z-10">
          <tr className="text-[11px] uppercase tracking-wider text-slate-600">
            <th className="p-3 border-b text-left">Estado</th>
            <th className="p-3 border-b text-left">Fecha venta</th>
            <th className="p-3 border-b text-left">Tipo</th>
            <th className="p-3 border-b text-left">Producto</th>
            <th className="p-3 border-b text-right">Libras - Unidad</th>
            <th className="p-3 border-b text-right">Monto</th>
            <th className="p-3 border-b text-left">Vendedor</th>
            <th className="p-3 border-b text-right">Acciones</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((s) => (
            <tr
              key={s.id}
              className="text-center odd:bg-white even:bg-slate-50 hover:bg-amber-50/60 transition"
            >
              <td className="p-3 border-b text-left">
                <span
                  className={`px-2 py-0.5 rounded text-xs ${
                    s.status === "PROCESADA"
                      ? "bg-green-100 text-green-700"
                      : "bg-yellow-100 text-yellow-700"
                  }`}
                >
                  {s.status}
                </span>
              </td>
              <td className="p-3 border-b text-left">{s.date}</td>
              <td className="p-3 border-b text-left">
                {s.type === "CREDITO" ? "Crédito" : "Cash"}
              </td>
              <td className="p-3 border-b text-left">{s.productName}</td>
              <td className="p-3 border-b text-right">{qty3(s.quantity)}</td>
              <td className="p-3 border-b text-right">C${money(s.amount)}</td>
              <td className="p-3 border-b text-left">
                {displaySeller(s.userEmail)}
              </td>
              <td className="p-3 border-b text-right">
                {s.status === "FLOTANTE" ? (
                  <div className="flex gap-2 justify-end">
                    {isAdmin ? (
                      <>
                        <button
                          onClick={() => openEdit(s)}
                          className="text-xs bg-indigo-600 text-white px-2 py-1 rounded hover:bg-indigo-700"
                        >
                          Editar
                        </button>
                        <button
                          onClick={() => deleteSale(s.id)}
                          className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                        >
                          Eliminar
                        </button>
                      </>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </div>
                ) : s.status === "PROCESADA" ? (
                  <div className="flex gap-2 justify-end">
                    {isAdmin ? (
                      <button
                        onClick={() => handleRevert(s.id)}
                        className="text-xs bg-red-600 text-white px-2 py-1 rounded hover:bg-red-700"
                      >
                        Revertir
                      </button>
                    ) : (
                      <span className="text-gray-400 text-xs">—</span>
                    )}
                  </div>
                ) : (
                  <span className="text-gray-400 text-xs">No options</span>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={8} className="p-3 text-center text-gray-500">
                Sin ventas para mostrar.
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="max-w-7xl mx-auto bg-white p-6 rounded-2xl shadow-2xl">
      {/* ✅ CSS interno para alternar vista en PDF (compat con mobile cards) */}
      <style>{`
        .pdf-print-mode .pdf-desktop { display: block !important; }
        .pdf-print-mode .pdf-mobile  { display: none !important; }
      `}</style>

      <div className="flex items-start justify-between gap-3 mb-4">
        <h2 className="text-2xl font-bold">
          Cierre de Ventas - {startDate} → {endDate}
        </h2>

        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} />
        </div>
      </div>

      {/* ✅ FILTROS (colapsable, nace cerrado) */}
      <div className="mb-4">
        <SectionHeader
          title="Filtros"
          open={filtersOpen}
          onToggle={() => setFiltersOpen((v) => !v)}
          right={
            <span className="ml-1">
              {startDate} → {endDate}
              {filter !== "ALL" ? ` • ${filter}` : ""}
              {operationFilter !== "ALL"
                ? ` • ${operationFilter === "CREDITO" ? "Crédito" : "Cash"}`
                : ""}
              {productFilter.trim() ? ` • "${productFilter.trim()}"` : ""}
            </span>
          }
        />

        {filtersOpen && (
          <div className="mt-3 border rounded-xl p-3 bg-white">
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3">
              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Periodo desde</label>
                <input
                  type="date"
                  className="border rounded px-2 py-2 w-full"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Hasta</label>
                <input
                  type="date"
                  className="border rounded px-2 py-2 w-full"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Estado</label>
                <select
                  className="border rounded px-2 py-2 w-full"
                  value={filter}
                  onChange={(e) => setFilter(e.target.value as any)}
                >
                  <option value="ALL">Todas</option>
                  <option value="FLOTANTE">Venta Flotante</option>
                  <option value="PROCESADA">Venta Procesada</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Tipo Operación</label>
                <select
                  className="border rounded px-2 py-2 w-full"
                  value={operationFilter}
                  onChange={(e) => setOperationFilter(e.target.value as any)}
                >
                  <option value="ALL">Todos</option>
                  <option value="CREDITO">Crédito</option>
                  <option value="CONTADO">Cash</option>
                </select>
              </div>

              <div className="flex flex-col gap-1">
                <label className="text-xs text-gray-600">Producto</label>
                <input
                  type="text"
                  className="border rounded px-2 py-2 w-full"
                  placeholder="Buscar por producto..."
                  value={productFilter}
                  onChange={(e) => setProductFilter(e.target.value)}
                />
              </div>
            </div>
          </div>
        )}
      </div>

      {loading ? (
        <p>Cargando ventas...</p>
      ) : (
        <div ref={pdfRef}>
          {/* =========================
              DESKTOP / WEB -> TABLA (igual que antes)
              ========================= */}
          <div className="pdf-desktop hidden md:block">
            <div className="space-y-6">
              {showCashTable && (
                <div className="mt-8">
                  <div className="mb-6">
                    <SectionHeader
                      title="Indicadores financieros"
                      open={pdfMode ? true : indicadoresOpen}
                      onToggle={() => setIndicadoresOpen((v) => !v)}
                      right={
                        <span className="ml-1">
                          Totales • C${money(totalSalesAll)}
                        </span>
                      }
                    />

                    {(pdfMode || indicadoresOpen) && (
                      <div className="mt-3">
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                          {/* Card 1: Libras & Unidades (cash / credito) */}
                          <div className="p-4 rounded-lg border bg-blue-50 border-blue-200">
                            <div className="text-sm font-semibold text-blue-800">
                              Libras / Unidades
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras Cash
                                </div>
                                <div className="text-xl font-bold text-blue-800">
                                  {qty3(totalLbsCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras Credito
                                </div>
                                <div className="text-xl font-bold text-amber-800">
                                  {qty3(totalLbsCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades Cash
                                </div>
                                <div className="text-xl font-bold text-green-800">
                                  {qty3(totalUnitsCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades Credito
                                </div>
                                <div className="text-xl font-bold text-amber-800">
                                  {qty3(totalUnitsCredit)}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Card 2: Facturado / Vendido / Utilidad bruta */}
                          <div className="p-4 rounded-lg border bg-amber-50 border-amber-200">
                            <div className="text-sm font-semibold text-amber-800">
                              Facturado / Vendido / Utilidad
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Facturado Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-800">
                                  C${money(totalCOGSCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Facturado Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-800">
                                  C${money(totalCOGSCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Vendido Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-900">
                                  C${money(totalSalesCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Vendido Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-900">
                                  C${money(totalSalesCredit)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Utilidad bruta Cash
                                </div>
                                <div className="mt-1 text-sm font-semibold text-emerald-900">
                                  C${money(grossProfitCash)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Utilidad bruta Credito
                                </div>
                                <div className="mt-1 text-sm font-semibold text-amber-900">
                                  C${money(grossProfitCredit)}
                                </div>
                              </div>
                            </div>
                          </div>

                          {/* Card 3: Totales */}
                          <div className="p-4 rounded-lg border bg-indigo-50 border-indigo-200">
                            <div className="text-sm font-semibold text-indigo-800">
                              Totales
                            </div>
                            <div className="mt-3 grid grid-cols-2 gap-3">
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Total facturado (precio compra)
                                </div>
                                <div className="mt-1 text-xl font-bold text-emerald-900">
                                  C${money(totalCOGSVisible)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Ventas total (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-amber-900">
                                  C${money(totalSalesAll)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Libras totales (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-blue-800">
                                  {qty3(totalLbsAll)}
                                </div>
                              </div>
                              <div className="p-3 rounded bg-white border">
                                <div className="text-xs text-slate-600">
                                  Unidades totales (Cash + Crédito)
                                </div>
                                <div className="mt-1 text-xl font-bold text-green-800">
                                  {qty3(totalUnitsAll)}
                                </div>
                              </div>
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>

                  <div className="mt-4">
                    <SectionHeader
                      title="Consolidado por producto"
                      open={consolidadoOpen}
                      onToggle={() => setConsolidadoOpen((v) => !v)}
                      right={
                        <span className="ml-1">
                          {productSummaryArray.length}
                        </span>
                      }
                    />

                    {consolidadoOpen && (
                      <div className="mt-3">
                        <div className="rounded-xl overflow-x-auto border border-slate-200 shadow-sm">
                          <table className="min-w-full w-full text-sm">
                            <thead className="bg-slate-100 sticky top-0 z-10">
                              <tr className="text-[11px] uppercase tracking-wider text-slate-600">
                                <th className="p-3 border-b text-left">
                                  Producto
                                </th>
                                <th className="p-3 border-b text-right">
                                  Total libras/unidades
                                </th>
                                <th className="p-3 border-b text-right">
                                  Total dinero
                                </th>
                              </tr>
                            </thead>
                            <tbody>
                              {productSummaryArray.map((row) => (
                                <tr
                                  key={row.productName}
                                  className="text-center odd:bg-white even:bg-slate-50"
                                >
                                  <td className="p-3 border-b text-left">
                                    {row.productName}
                                  </td>
                                  <td className="p-3 border-b text-right">
                                    {qty3(row.totalQuantity)}
                                  </td>
                                  <td className="p-3 border-b text-right">
                                    C${money(row.totalAmount)}
                                  </td>
                                </tr>
                              ))}
                              {productSummaryArray.length > 0 && (
                                <tr className="text-center bg-slate-100/70">
                                  <td className="p-3 border-b text-left font-semibold">
                                    Totales
                                  </td>
                                  <td className="p-3 border-b text-right font-semibold">
                                    Lbs: {qty3(totalLbsAll)} • Und:{" "}
                                    {qty3(totalUnitsAll)}
                                  </td>
                                  <td className="p-3 border-b text-right font-semibold">
                                    C${money(totalSalesAll)}
                                  </td>
                                </tr>
                              )}
                              {productSummaryArray.length === 0 && (
                                <tr>
                                  <td
                                    colSpan={3}
                                    className="p-3 text-center text-gray-500"
                                  >
                                    Sin datos para consolidar.
                                  </td>
                                </tr>
                              )}
                            </tbody>
                          </table>
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="mt-6 flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold text-slate-700">
                      Contado
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-slate-500">
                        {cashSales.length} registro(s)
                      </div>
                      <button
                        type="button"
                        onClick={() => setCashTableOpen((v) => !v)}
                        className={`text-xs px-3 py-1.5 rounded border font-semibold transition ${
                          cashOpenEffective
                            ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
                            : "bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700"
                        }`}
                      >
                        {cashOpenEffective ? "Cerrar" : "Ver"}
                      </button>
                    </div>
                  </div>
                  {cashOpenEffective && (
                    <>
                      {renderSalesTable(cashRowsForTable)}
                      {!pdfMode &&
                        renderProPager(
                          cashPage,
                          cashTotalPages,
                          setCashPage,
                          cashSales.length,
                        )}
                    </>
                  )}
                </div>
              )}

              {showCreditTable && (
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <div className="text-sm font-semibold text-slate-700">
                      Crédito
                    </div>
                    <div className="flex items-center gap-2">
                      <div className="text-xs text-slate-500">
                        {creditSales.length} registro(s)
                      </div>
                      <button
                        type="button"
                        onClick={() => setCreditTableOpen((v) => !v)}
                        className={`text-xs px-3 py-1.5 rounded border font-semibold transition ${
                          creditOpenEffective
                            ? "bg-rose-600 text-white border-rose-600 hover:bg-rose-700"
                            : "bg-amber-500 text-white border-amber-500 hover:bg-amber-600"
                        }`}
                      >
                        {creditOpenEffective ? "Cerrar" : "Ver"}
                      </button>
                    </div>
                  </div>
                  {creditOpenEffective && (
                    <>
                      {renderSalesTable(creditRowsForTable)}
                      {!pdfMode &&
                        renderProPager(
                          creditPage,
                          creditTotalPages,
                          setCreditPage,
                          creditSales.length,
                        )}
                    </>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* =========================
              MOBILE / PWA -> CONTENEDOR "VENTAS" COLAPSADO
              ========================= */}
          <div className="pdf-mobile md:hidden mb-4">
            <SectionHeader
              title="Ventas"
              open={ventasOpen}
              onToggle={() => setVentasOpen((v) => !v)}
              right={
                <span className="ml-1">
                  {visibleSales.length} • C${money(totalCharged)}
                </span>
              }
            />

            {ventasOpen && (
              <div className="mt-3 space-y-3">
                {visibleSales.map((s) => (
                  <details
                    key={s.id}
                    className="border rounded-xl bg-white shadow-sm"
                  >
                    <summary className="px-4 py-3 flex justify-between items-center cursor-pointer">
                      <div className="min-w-0">
                        <div className="font-semibold truncate">
                          {s.productName}
                        </div>
                        <div className="text-xs text-gray-500">{s.date}</div>
                      </div>

                      <div className="text-right shrink-0 ml-3">
                        <div className="font-bold">C${money(s.amount)}</div>
                        <span
                          className={`text-xs px-2 py-0.5 rounded ${
                            s.status === "PROCESADA"
                              ? "bg-green-100 text-green-700"
                              : "bg-yellow-100 text-yellow-700"
                          }`}
                        >
                          {s.status}
                        </span>
                      </div>
                    </summary>

                    <div className="px-4 pb-4 pt-2 text-sm space-y-2">
                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Cantidad</span>
                        <strong>{qty3(s.quantity)}</strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Tipo</span>
                        <strong>
                          {s.type === "CREDITO" ? "Crédito" : "Cash"}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Vendedor</span>
                        <strong className="text-right break-all">
                          {displaySeller(s.userEmail)}
                        </strong>
                      </div>

                      <div className="flex justify-between gap-3">
                        <span className="text-gray-600">Cliente</span>
                        <strong className="text-right break-all">
                          {s.clientName || "—"}
                        </strong>
                      </div>

                      <div className="pt-2">
                        {s.status === "FLOTANTE" ? (
                          <div className="flex gap-2">
                            {isAdmin ? (
                              <>
                                <button
                                  onClick={() => openEdit(s)}
                                  className="flex-1 text-xs bg-indigo-600 text-white py-2 rounded hover:bg-indigo-700"
                                >
                                  Editar
                                </button>
                                <button
                                  onClick={() => deleteSale(s.id)}
                                  className="flex-1 text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                                >
                                  Eliminar
                                </button>
                              </>
                            ) : (
                              <div className="text-gray-400 text-xs w-full text-center">
                                —
                              </div>
                            )}
                          </div>
                        ) : s.status === "PROCESADA" ? (
                          <div className="flex gap-2">
                            {isAdmin ? (
                              <button
                                onClick={() => handleRevert(s.id)}
                                className="w-full text-xs bg-red-600 text-white py-2 rounded hover:bg-red-700"
                              >
                                Revertir
                              </button>
                            ) : (
                              <div className="text-gray-400 text-xs w-full text-center">
                                —
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="text-gray-400 text-xs w-full text-center">
                            No options
                          </div>
                        )}
                      </div>
                    </div>
                  </details>
                ))}

                {visibleSales.length === 0 && (
                  <div className="text-center text-gray-500 text-sm py-6">
                    Sin ventas para mostrar.
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-2 mt-4">
        <button
          disabled={!cierreVentas}
          onClick={handleSaveClosure}
          className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
        >
          Cerrar ventas del día
        </button>

        <button
          onClick={handleDownloadPDF}
          className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
        >
          Descargar PDF
        </button>
      </div>

      {message && <p className="mt-2 text-sm">{message}</p>}

      {/* Panel de edición */}
      {editing && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-4 space-y-3">
            <h4 className="font-semibold text-lg">Editar venta</h4>
            <div className="text-sm text-gray-500">
              {editing.productName} • {displaySeller(editing.userEmail)}
            </div>

            <label className="text-sm">Cantidad</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editQty}
              onChange={(e) => setEditQty(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Monto cobrado</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editAmount}
              onChange={(e) => setEditAmount(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Cliente</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editClient}
              onChange={(e) => setEditClient(e.target.value)}
            />

            <label className="text-sm">Paga con</label>
            <input
              type="number"
              step="0.01"
              className="w-full border rounded px-2 py-1"
              value={editPaid}
              onChange={(e) => setEditPaid(parseFloat(e.target.value || "0"))}
            />

            <label className="text-sm">Vuelto</label>
            <input
              type="text"
              className="w-full border rounded px-2 py-1"
              value={editChange}
              onChange={(e) => setEditChange(e.target.value)}
            />

            <div className="flex gap-2 justify-end pt-2">
              <button
                onClick={() => setEditing(null)}
                className="px-3 py-1 border rounded"
              >
                Cancelar
              </button>
              <button
                onClick={saveEdit}
                className="px-3 py-1 rounded text-white bg-indigo-600 hover:bg-indigo-700"
              >
                Guardar cambios
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
