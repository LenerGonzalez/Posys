import React, { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import {
  addDoc,
  collection,
  serverTimestamp,
  getDoc,
  doc as fsDoc,
  type DocumentSnapshot,
} from "firebase/firestore";
import { format } from "date-fns";
import { db, auth } from "../../firebase";
import allocateFIFOAndUpdateBatches from "../../Services/allocateFIFO";
import RefreshButton from "../common/RefreshButton";
import MobileHtmlSelect from "../common/MobileHtmlSelect";
import {
  POLLO_SELECT_COMPACT_DESKTOP_CLASS,
  POLLO_SELECT_COMPACT_MOBILE_CLASS,
  POLLO_SELECT_DESKTOP_CLASS,
  POLLO_SELECT_MOBILE_BUTTON_CLASS,
} from "../common/polloSelectStyles";
import Toast from "../common/Toast";
import useManualRefresh from "../../hooks/useManualRefresh";
import Button from "../common/Button";
import PolloChip, { type PolloChipVariant } from "../common/PolloChip";
import SlideOverDrawer from "../common/SlideOverDrawer";
import { DrawerDetailDlCard } from "../common/DrawerContentCards";
import * as XLSX from "xlsx";
import {
  fetchGlobalInventoryKpisPollo_debug,
  fetchInventoryProductOptionsPollo,
  fetchProductEvolutionPollo,
  type InvMove,
  type ProductOption,
  type ProductKpis,
} from "../../Services/inventory_evolution_pollo";

function tipoMoveChipVariant(t: string): PolloChipVariant {
  switch (t) {
    case "INGRESO":
      return "emerald";
    case "VENTA_CASH":
      return "amber";
    case "VENTA_CREDITO":
      return "violet";
    case "MERMA":
    case "ROBO":
      return "rose";
    default:
      return "neutral";
  }
}

type KpiTone =
  | "slate"
  | "sky"
  | "amber"
  | "violet"
  | "emerald"
  | "rose"
  | "indigo";

const KPI_TONE: Record<KpiTone, string> = {
  slate: "border-slate-200 bg-slate-50/90",
  sky: "border-sky-200 bg-sky-50/90",
  amber: "border-amber-200 bg-amber-50/90",
  violet: "border-violet-200 bg-violet-50/90",
  emerald: "border-emerald-200 bg-emerald-50/90",
  rose: "border-rose-200 bg-rose-50/90",
  indigo: "border-indigo-200 bg-indigo-50/90",
};

function KpiCard({
  title,
  value,
  tone,
}: {
  title: string;
  value: string;
  tone: KpiTone;
}) {
  return (
    <div className={`border rounded-2xl p-3 shadow-sm ${KPI_TONE[tone]}`}>
      <div className="text-xs text-gray-600 font-medium">{title}</div>
      <div className="text-2xl font-bold text-gray-900 tabular-nums">{value}</div>
    </div>
  );
}

const qty3 = (n: unknown) => Number(n ?? 0).toFixed(3);
const today = () => format(new Date(), "yyyy-MM-dd");

function batchesHrefForMermaAdj(
  adjId: string | undefined,
  productId: string | undefined,
  detailById: Record<
    string,
    | {
        fifoAllocations: { batchId: string }[];
      }
    | { error: string }
  >,
  fallback: string,
): string {
  if (!adjId?.trim() || !productId?.trim()) return fallback;
  const det = detailById[adjId];
  if (!det || "error" in det || !det.fifoAllocations?.[0]?.batchId)
    return fallback;
  return `../batches?productId=${encodeURIComponent(productId.trim())}&focusBatchId=${encodeURIComponent(det.fifoAllocations[0].batchId)}`;
}

type AdjFifoParsed =
  | {
      fifoAllocations: {
        batchId: string;
        qty: number;
        unitCost: number;
        lineCost: number;
      }[];
      cogsAmount: number;
      avgUnitCost: number;
    }
  | { error: string };

function parseAdjustmentDocumentSnap(snap: DocumentSnapshot): AdjFifoParsed {
  if (!snap.exists()) {
    return { error: "No se encontró el ajuste en inventario." };
  }
  const d = snap.data() as Record<string, unknown>;
  const raw = Array.isArray(d.fifoAllocations)
    ? (d.fifoAllocations as unknown[])
    : [];
  const fifoAllocations = raw.map((x) => {
    const row = x as Record<string, unknown>;
    return {
      batchId: String(row.batchId ?? ""),
      qty: Number(row.qty ?? 0),
      unitCost: Number(row.unitCost ?? 0),
      lineCost: Number(row.lineCost ?? 0),
    };
  });
  return {
    fifoAllocations,
    cogsAmount: Number(d.cogsAmount ?? 0),
    avgUnitCost: Number(d.avgUnitCost ?? 0),
  };
}

type AdjType = "MERMA" | "ROBO";

export default function EvolutivoInventarioPollo({
  role,
  roles,
}: {
  role?: string;
  roles?: string[];
}): React.ReactElement {
  const [from, setFrom] = useState(today());
  const [to, setTo] = useState(today());

  const [loading, setLoading] = useState(true);

  // Productos (solo stock > 0, lo trae el service o lo reforzamos)
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [selectedKey, setSelectedKey] = useState<string>("");

  /** Texto para filtrar la lista del select de producto (no sustituye al valor elegido). */
  const [productFilterQuery, setProductFilterQuery] = useState("");

  const selected = useMemo(
    () => products.find((p) => p.key === selectedKey) || null,
    [products, selectedKey],
  );

  // KPIs globales
  const [global, setGlobal] = useState({
    incomingLbs: 0,
    incomingUnits: 0,
    remainingLbs: 0,
    remainingUnits: 0,
  });

  // Evolutivo
  const [moves, setMoves] = useState<InvMove[]>([]);
  const [productKpis, setProductKpis] = useState<ProductKpis>({
    incoming: 0,
    soldCash: 0,
    soldCredit: 0,
    remaining: 0,
    measurement: "unidad",
  });

  // mapa saleId -> unit price calculado para el producto seleccionado
  const [salePrices, setSalePrices] = useState<Record<string, number>>({});

  // Manual movement form
  const [adjDate, setAdjDate] = useState(today());
  const [adjType, setAdjType] = useState<AdjType>("MERMA");
  const [adjSaving, setAdjSaving] = useState(false);
  const [adjQty, setAdjQty] = useState<number>(0);
  const [adjDesc, setAdjDesc] = useState("");
  const [adjModalOpen, setAdjModalOpen] = useState(false);

  const { refreshKey, refresh } = useManualRefresh();
  const [typeFilter, setTypeFilter] = useState<string>("ALL");
  const [priceFilter, setPriceFilter] = useState<string>("ALL");
  const [toastMsg, setToastMsg] = useState("");

  const [ingresoBatchId, setIngresoBatchId] = useState<string | null>(null);
  const [ingresoBatchRow, setIngresoBatchRow] = useState<Record<
    string,
    unknown
  > | null>(null);
  const [ingresoBatchLoading, setIngresoBatchLoading] = useState(false);

  /** MERMA/ROBO: drawer con detalle fifoAllocations / cogsAmount */
  const [mermaDrawerAdjId, setMermaDrawerAdjId] = useState<string | null>(null);
  const [adjBatchMetaById, setAdjBatchMetaById] = useState<
    Record<
      string,
      { orderName: string; productName: string; date: string }
    >
  >({});
  const [adjFifoDetailById, setAdjFifoDetailById] = useState<
    Record<
      string,
      | {
          fifoAllocations: {
            batchId: string;
            qty: number;
            unitCost: number;
            lineCost: number;
          }[];
          cogsAmount: number;
          avgUnitCost: number;
        }
      | { error: string }
    >
  >({});
  const [adjFifoLoadingId, setAdjFifoLoadingId] = useState<string | null>(null);

  // =========================
  // 1) Cargar productos
  // =========================
  useEffect(() => {
    (async () => {
      try {
        const opts = await fetchInventoryProductOptionsPollo();

        // refuerzo: solo stock > 0
        const withStock = (opts || []).filter(
          (p: any) => Number((p as any).remaining || 0) > 0,
        );

        setProducts(withStock);

        // si el seleccionado ya no existe, limpia
        if (selectedKey && !withStock.some((o) => o.key === selectedKey)) {
          setSelectedKey("");
          setProductFilterQuery("");
        }
      } catch (e) {
        console.error("Error products inventory:", e);
        setProducts([]);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  // =========================
  // 2) KPIs globales
  // =========================
  useEffect(() => {
    (async () => {
      try {
        const g = await fetchGlobalInventoryKpisPollo_debug(from, to);
        setGlobal(g);
      } catch (e) {
        console.error("Error global kpis:", e);
        setGlobal({
          incomingLbs: 0,
          incomingUnits: 0,
          remainingLbs: 0,
          remainingUnits: 0,
        });
      }
    })();
  }, [from, to, refreshKey]);

  // =========================
  // 3) Evolutivo por producto
  // =========================
  useEffect(() => {
    (async () => {
      setLoading(true);
      try {
        if (!selected) {
          setMoves([]);
          setProductKpis({
            incoming: 0,
            soldCash: 0,
            soldCredit: 0,
            remaining: 0,
            measurement: "unidad",
          });
          setLoading(false);
          return;
        }

        // 🔥 CLAVE: pasar productId (tu service debe usarlo para inventory_batches)
        const res = await fetchProductEvolutionPollo({
          from,
          to,
          productKey: selected.key,
          productId: (selected as any).productId, // requerido
          productName: selected.productName,
          measurement: selected.measurement,
        });

        setMoves(res.moves);
        setProductKpis(res.productKpis);

        // precargar precios desde salesV2 para ventas en el rango
        try {
          const saleIds = Array.from(
            new Set(
              (res.moves || [])
                .filter((m: any) => (m.type || "").startsWith("VENTA") && m.ref)
                .map((m: any) => String(m.ref)),
            ),
          );

          const pricesMap: Record<string, number> = {};

          for (const sid of saleIds) {
            try {
              const sRef = fsDoc(db, "salesV2", sid);
              const sSnap = await getDoc(sRef);
              if (!sSnap.exists()) continue;
              const s = sSnap.data() as any;

              // Intentar extraer precio del item correspondiente
              let unitPrice: number | null = null;
              const selName = (selected?.productName || "").toLowerCase();
              const selId = (selected as any)?.productId || "";

              if (Array.isArray(s.items) && s.items.length > 0) {
                for (const it of s.items) {
                  const itPid = String(it.productId ?? "").trim();
                  const itName = String(it.productName ?? "").toLowerCase();
                  if (
                    (selId && itPid && itPid === selId) ||
                    itName === selName
                  ) {
                    unitPrice = Number(
                      it.unitPrice ?? it.price ?? it.regularPrice ?? 0,
                    );
                    break;
                  }
                }
              }

              // esquema simple: usar amount/quantity
              if (
                (unitPrice === null || unitPrice === 0) &&
                s.quantity &&
                s.amount
              ) {
                const q = Number(s.quantity || 0);
                const a = Number(s.amount || s.amountCharged || 0);
                if (q > 0 && a) unitPrice = Number((a / q).toFixed(2));
              }

              if (unitPrice === null) unitPrice = 0;
              pricesMap[sid] = unitPrice;
            } catch (e) {
              // ignore per-sale errors
            }
          }

          setSalePrices(pricesMap);
        } catch (e) {
          // noop
        }

        try {
          const mermaIds = Array.from(
            new Set(
              (res.moves || [])
                .filter(
                  (m) =>
                    (m.type === "MERMA" || m.type === "ROBO") && m.ref,
                )
                .map((m) => String(m.ref)),
            ),
          );
          if (mermaIds.length) {
            const entries = await Promise.all(
              mermaIds.map(async (aid) => {
                try {
                  const snap = await getDoc(
                    fsDoc(db, "inventory_adjustments_pollo", aid),
                  );
                  return [aid, parseAdjustmentDocumentSnap(snap)] as const;
                } catch {
                  return [
                    aid,
                    { error: "No se pudo cargar el detalle FIFO." },
                  ] as const;
                }
              }),
            );
            const adjPartial: Record<string, AdjFifoParsed> =
              Object.fromEntries(entries);
            setAdjFifoDetailById((prev) => ({ ...prev, ...adjPartial }));
          }
        } catch {
          /* noop */
        }
      } catch (e) {
        console.error("Error product evolution:", e);
        setMoves([]);
        setProductKpis({
          incoming: 0,
          soldCash: 0,
          soldCredit: 0,
          remaining: 0,
          measurement: selected?.measurement || "unidad",
        });
      } finally {
        setLoading(false);
      }
    })();
  }, [from, to, selectedKey, refreshKey, selected]);

  const unitLabel = selected?.measurement === "lb" ? "Lbs" : "Unidades";

  const soldCashPlusCredit = useMemo(() => {
    const a = Number(productKpis.soldCash ?? 0);
    const b = Number(productKpis.soldCredit ?? 0);
    return Number((a + b).toFixed(3));
  }, [productKpis.soldCash, productKpis.soldCredit]);

  useEffect(() => {
    if (!ingresoBatchId) {
      setIngresoBatchRow(null);
      setIngresoBatchLoading(false);
      return;
    }
    let cancelled = false;
    setIngresoBatchLoading(true);
    setIngresoBatchRow(null);
    (async () => {
      try {
        const snap = await getDoc(fsDoc(db, "inventory_batches", ingresoBatchId));
        if (cancelled) return;
        setIngresoBatchRow(snap.exists() ? snap.data() : null);
      } catch {
        if (!cancelled) setIngresoBatchRow(null);
      } finally {
        if (!cancelled) setIngresoBatchLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ingresoBatchId]);

  useEffect(() => {
    if (!mermaDrawerAdjId) return;
    const id = mermaDrawerAdjId;
    if (adjFifoDetailById[id] !== undefined) return;

    let cancelled = false;
    setAdjFifoLoadingId(id);
    (async () => {
      try {
        const snap = await getDoc(
          fsDoc(db, "inventory_adjustments_pollo", id),
        );
        if (cancelled) return;
        const parsed = parseAdjustmentDocumentSnap(snap);
        setAdjFifoDetailById((prev) => ({ ...prev, [id]: parsed }));
      } catch {
        if (!cancelled) {
          setAdjFifoDetailById((prev) => ({
            ...prev,
            [id]: { error: "No se pudo cargar el detalle FIFO." },
          }));
        }
      } finally {
        if (!cancelled) setAdjFifoLoadingId(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaDrawerAdjId, adjFifoDetailById]);

  useEffect(() => {
    if (!mermaDrawerAdjId) return;
    const det = adjFifoDetailById[mermaDrawerAdjId];
    if (!det || "error" in det) return;
    const ids = [
      ...new Set(
        det.fifoAllocations.map((a) => a.batchId).filter(Boolean),
      ),
    ];
    let cancelled = false;
    (async () => {
      const next: Record<
        string,
        { orderName: string; productName: string; date: string }
      > = {};
      for (const bid of ids) {
        if (cancelled) return;
        try {
          const s = await getDoc(fsDoc(db, "inventory_batches", bid));
          if (!s.exists()) {
            next[bid] = { orderName: "—", productName: "—", date: "—" };
            continue;
          }
          const d = s.data() as Record<string, unknown>;
          next[bid] = {
            orderName: String(d.orderName ?? "").trim() || "—",
            productName: String(d.productName ?? "").trim() || "—",
            date: String(d.date ?? "").trim() || "—",
          };
        } catch {
          next[bid] = { orderName: "—", productName: "—", date: "—" };
        }
      }
      if (!cancelled) {
        setAdjBatchMetaById((prev) => ({ ...prev, ...next }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [mermaDrawerAdjId, adjFifoDetailById]);

  // Balance corrido (para la tabla del rango)
  const movesWithBalance = useMemo(() => {
    // si el service nos devolvió openingBalance, iniciamos desde ahí
    let bal = 0;
    const opening = (moves && (moves as any).openingBalance) || 0;
    // Nota: el service ahora retorna openingBalance en el response; en caso de que no esté,
    // usamos 0 para mantener comportamiento previo.
    bal = opening || 0;
    return (moves || []).map((m) => {
      bal = bal + Number(m.qtyIn || 0) - Number(m.qtyOut || 0);
      return { ...m, balance: bal };
    });
  }, [moves]);

  // (no price highlighting) — prices will be shown as currency in UI
  // filtered moves by Tipo y Precio
  const filteredMoves = useMemo(() => {
    if (!movesWithBalance || movesWithBalance.length === 0)
      return [] as typeof movesWithBalance;
    if (typeFilter === "ALL") return movesWithBalance;
    return movesWithBalance.filter((mm) => (mm.type || "") === typeFilter);
  }, [movesWithBalance, typeFilter]);

  const availablePrices = useMemo(() => {
    const s = new Set<string>();
    for (const m of filteredMoves) {
      const priceNum = Number(
        salePrices[String((m as any).ref || "")] ??
          (m as any).price ??
          (m as any).unitPrice ??
          0,
      );
      s.add(`C$ ${priceNum.toFixed(2)}`);
    }
    return Array.from(s).sort(
      (a, b) =>
        Number(b.replace(/[^0-9.-]+/g, "")) -
        Number(a.replace(/[^0-9.-]+/g, "")),
    );
  }, [filteredMoves, salePrices]);

  const typeFilterSelectOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      { value: "INGRESO", label: "INGRESO" },
      { value: "VENTA_CASH", label: "VENTA_CASH" },
      { value: "VENTA_CREDITO", label: "VENTA_CREDITO" },
      { value: "MERMA", label: "MERMA" },
      { value: "ROBO", label: "ROBO" },
    ],
    [],
  );

  const priceFilterSelectOptions = useMemo(
    () => [
      { value: "ALL", label: "Todos" },
      ...availablePrices.map((p) => ({ value: p, label: p })),
    ],
    [availablePrices],
  );

  const adjTypeSelectOptions = useMemo(
    () => [
      { value: "MERMA", label: "Merma por peso" },
      { value: "ROBO", label: "Pérdida/Robo" },
    ],
    [],
  );

  const displayedMoves = useMemo(() => {
    if (!filteredMoves || filteredMoves.length === 0)
      return [] as typeof filteredMoves;
    if (!priceFilter || priceFilter === "ALL") return filteredMoves;
    return filteredMoves.filter((m) => {
      const priceNum = Number(
        salePrices[String((m as any).ref || "")] ??
          (m as any).price ??
          (m as any).unitPrice ??
          0,
      );
      return `C$ ${priceNum.toFixed(2)}` === priceFilter;
    });
  }, [filteredMoves, priceFilter, salePrices]);

  const handleExportExcel = () => {
    const rows = (displayedMoves || []).map((m) => {
      const price = Number(
        salePrices[String(m.ref || "")] ??
          (m as any).price ??
          (m as any).unitPrice ??
          0,
      );
      const total = price * Number(m.qtyOut || 0);
      return {
        Fecha: m.date || "",
        Tipo: m.type || "",
        Descripción: m.description || "",
        Ref: m.ref || "",
        Entrada: Number(m.qtyIn || 0),
        Salida: Number(m.qtyOut || 0),
        Precio: `C$ ${price.toFixed(2)}`,
        Monto: `C$ ${total.toFixed(2)}`,
        Balance: Number((m as any).balance || 0),
      };
    });

    const ws = XLSX.utils.json_to_sheet(rows, {
      header: [
        "Fecha",
        "Tipo",
        "Descripción",
        "Ref",
        "Entrada",
        "Salida",
        "Precio",
        "Monto",
        "Balance",
      ],
    });
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Movimientos");

    const out = XLSX.write(wb, { type: "array", bookType: "xlsx" });
    const blob = new Blob([out], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (selected?.productName || "evolutivo").replace(
      /[^a-z0-9]/gi,
      "_",
    );
    a.download = `${safeName}_movimientos_${from}_${to}.xlsx`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ================
  // Dropdown helpers
  // ================
  const norm = (s: string) =>
    String(s || "")
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .trim();

  const filteredProductSelectOptions = useMemo(() => {
    const q = norm(productFilterQuery);
    const rows = products
      .filter((p: any) => {
        if (selectedKey && p.key === selectedKey) return true;
        if (!q) return true;
        const name = norm(p.productName || "");
        const key = norm(p.key || "");
        return name.includes(q) || key.includes(q);
      })
      .map((p: any) => ({
        value: p.key,
        label: `${p.productName} — ${
          p.measurement === "lb" ? "Lbs" : "Unid"
        } · stock ${qty3((p as any).remaining)}`,
      }));
    return [
      { value: "", label: "— Elegir producto —" },
      ...rows,
    ];
  }, [products, productFilterQuery, selectedKey]);

  const inventoryBatchesHref = useMemo(() => {
    const pid = selected?.productId?.trim();
    return pid
      ? `../batches?productId=${encodeURIComponent(pid)}`
      : "../batches";
  }, [selected]);

  const mermaDrawerTitle = useMemo(() => {
    if (!mermaDrawerAdjId) return "";
    const mm = (moves || []).find((x) => x.ref === mermaDrawerAdjId);
    return mm
      ? `${mm.type} · ${mm.date}`
      : "Merma / pérdida";
  }, [mermaDrawerAdjId, moves]);

  const mermaDrawerBatchesHref = useMemo(() => {
    const pid = selected?.productId?.trim();
    if (!pid || !mermaDrawerAdjId) return inventoryBatchesHref;
    const det = adjFifoDetailById[mermaDrawerAdjId];
    if (!det || "error" in det || !det.fifoAllocations.length) {
      return `../batches?productId=${encodeURIComponent(pid)}`;
    }
    const bid = det.fifoAllocations[0].batchId;
    return `../batches?productId=${encodeURIComponent(pid)}&focusBatchId=${encodeURIComponent(bid)}`;
  }, [
    selected,
    mermaDrawerAdjId,
    adjFifoDetailById,
    inventoryBatchesHref,
  ]);

  // =========================
  // Guardar ajuste: descuenta lotes por FIFO (igual que venta) + registro
  // =========================
  const saveAdjustment = async (): Promise<boolean> => {
    if (!selected) {
      setToastMsg("⚠️ Seleccioná un producto primero.");
      return false;
    }

    const q = Number(adjQty || 0);
    if (q <= 0) {
      setToastMsg("⚠️ Ingresá una cantidad mayor a 0.");
      return false;
    }
    if (!adjDate) {
      setToastMsg("⚠️ Seleccioná fecha.");
      return false;
    }

    const user = auth.currentUser;
    setAdjSaving(true);
    try {
      const alloc = await allocateFIFOAndUpdateBatches(
        db,
        selected.productName,
        q,
        false,
      );

      await addDoc(collection(db, "inventory_adjustments_pollo"), {
        date: adjDate,
        type: adjType,
        qty: q,
        productKey: selected.key,
        productId: (selected as any).productId ?? null,
        productName: selected.productName,
        measurement: selected.measurement,
        description: adjDesc?.trim() || null,
        createdAt: serverTimestamp(),
        createdBy: user ? { uid: user.uid, email: user.email ?? null } : null,
        periodFrom: from,
        periodTo: to,
        fifoAllocations: alloc.allocations,
        cogsAmount: alloc.cogsAmount,
        avgUnitCost: alloc.avgUnitCost,
      });

      setAdjQty(0);
      setAdjDesc("");
      refresh();
      setToastMsg(
        `✅ Merma aplicada. Valor a costo retirado: C$ ${Number(alloc.cogsAmount || 0).toFixed(2)} (ver lotes en Inventario).`,
      );
      return true;
    } catch (e) {
      const msg =
        e instanceof Error
          ? e.message
          : "No se pudo aplicar el ajuste (¿stock insuficiente?).";
      setToastMsg(`❌ ${msg}`);
      return false;
    } finally {
      setAdjSaving(false);
    }
  };

  return (
    <div className="max-w-7xl mx-auto bg-white p-4 sm:p-6 rounded-2xl shadow-2xl">
      <div className="flex items-center justify-between mb-3 gap-2">
        <h2 className="text-xl sm:text-2xl font-bold">
          Evolutivo Inventario (Pollo)
        </h2>
        <div className="flex items-center gap-2">
          <RefreshButton onClick={refresh} loading={loading} />
        </div>
      </div>

      {/* rango */}
      {/* Mobile: fecha dentro de card */}
      <div className="sm:hidden mb-3">
        <div className="border rounded-2xl p-3 bg-white">
          <div className="text-xs text-gray-500 mb-2">Rango de fechas</div>
          <div className="grid grid-cols-1 gap-2">
            <div>
              <label className="block text-sm text-gray-600 mb-1">Desde</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={from}
                onChange={(e) => setFrom(e.target.value)}
              />
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">Hasta</label>
              <input
                type="date"
                className="border rounded px-3 py-2 w-full"
                value={to}
                onChange={(e) => setTo(e.target.value)}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Desktop */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 gap-2 mb-3">
        <div>
          <label className="block text-sm text-gray-600 mb-1">Desde</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={from}
            onChange={(e) => setFrom(e.target.value)}
          />
        </div>
        <div>
          <label className="block text-sm text-gray-600 mb-1">Hasta</label>
          <input
            type="date"
            className="border rounded px-3 py-2 w-full"
            value={to}
            onChange={(e) => setTo(e.target.value)}
          />
        </div>
      </div>

      {/* KPIs globales */}
      {/* Mobile: KPIs inside a card */}
      <div className="sm:hidden mb-4">
        <div className="border rounded-2xl p-3 bg-white space-y-2">
          <div className="text-xs text-gray-500">KPIs</div>
          <div className="grid grid-cols-2 gap-2">
            <KpiCard
              tone="sky"
              title="Ingresado (Lbs)"
              value={qty3(global.incomingLbs)}
            />
            <KpiCard
              tone="slate"
              title="Ingresado (Unid)"
              value={qty3(global.incomingUnits)}
            />
            <KpiCard
              tone="emerald"
              title="Existente (Lbs)"
              value={qty3(global.remainingLbs)}
            />
            <KpiCard
              tone="violet"
              title="Existente (Unid)"
              value={qty3(global.remainingUnits)}
            />
          </div>
        </div>
      </div>

      {/* Desktop KPIs */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 mb-4">
        <KpiCard
          tone="sky"
          title="Ingresado (Lbs) en rango"
          value={qty3(global.incomingLbs)}
        />
        <KpiCard
          tone="slate"
          title="Ingresado (Unidades) en rango"
          value={qty3(global.incomingUnits)}
        />
        <KpiCard
          tone="emerald"
          title="Existente (Lbs) general"
          value={qty3(global.remainingLbs)}
        />
        <KpiCard
          tone="violet"
          title="Existente (Unidades) general"
          value={qty3(global.remainingUnits)}
        />
      </div>

      {/* selector obligatorio */}
      {/* Mobile: producto + filtros + tabla inside a card */}
      <div className="sm:hidden mb-4">
        <div className="border rounded-2xl p-2 bg-white space-y-2">
          <div className="space-y-2">
            <div className="text-xs text-gray-500 mb-1">
              Producto (solo con stock)
            </div>
            <input
              className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-full min-w-0 shadow-sm"
              placeholder="Buscar para filtrar lista…"
              value={productFilterQuery}
              onChange={(e) => setProductFilterQuery(e.target.value)}
            />
            <div className="flex items-start gap-2">
              <div className="flex-1 min-w-0">
                <MobileHtmlSelect
                  value={selectedKey}
                  onChange={(v) => {
                    setSelectedKey(v);
                    setProductFilterQuery("");
                  }}
                  options={filteredProductSelectOptions}
                  sheetTitle="Producto"
                  triggerIcon="menu"
                  selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                  buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                />
              </div>
              {selectedKey ? (
                <Button
                  type="button"
                  aria-label="Limpiar producto"
                  title="Limpiar producto"
                  onClick={() => {
                    setSelectedKey("");
                    setProductFilterQuery("");
                  }}
                  variant="secondary"
                  size="sm"
                  className="!rounded-xl shrink-0 flex items-center justify-center !px-2 !py-2 hover:!bg-gray-200"
                >
                  <span>🧹</span>
                </Button>
              ) : null}
            </div>

            {selected ? (
              <>
                <div className="mt-2 border rounded p-2">
                  <div className="text-xs text-gray-500">Seleccionado</div>
                  <div className="font-semibold">{selected.productName}</div>
                  <div className="text-xs text-gray-500">
                    Medida:{" "}
                    <b>{selected.measurement === "lb" ? "Lbs" : "Unidades"}</b>{" "}
                    • Stock: <b>{qty3((selected as any).remaining)}</b>
                  </div>
                </div>

                {/* Product KPIs (mobile) */}
                <div className="mt-3 grid grid-cols-2 gap-2">
                  <KpiCard
                    tone="sky"
                    title={`${unitLabel} ingresadas (rango)`}
                    value={qty3(productKpis.incoming)}
                  />
                  <KpiCard
                    tone="amber"
                    title={`${unitLabel} vendidas Cash`}
                    value={qty3(productKpis.soldCash)}
                  />
                  <KpiCard
                    tone="violet"
                    title={`${unitLabel} vendidas Crédito`}
                    value={qty3(productKpis.soldCredit)}
                  />
                  <KpiCard
                    tone="indigo"
                    title={`${unitLabel} vendidas (cash + crédito)`}
                    value={qty3(soldCashPlusCredit)}
                  />
                  <div className="col-span-2">
                    <KpiCard
                      tone="emerald"
                      title={`${unitLabel} existentes`}
                      value={qty3(productKpis.remaining)}
                    />
                  </div>
                </div>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2">
            <Button
              type="button"
              onClick={() => setAdjModalOpen(true)}
              variant="primary"
              className="!rounded-lg text-sm sm:text-base"
            >
              Crear Movimiento
            </Button>
            <Button
              type="button"
              onClick={handleExportExcel}
              variant="primary"
              className="!bg-green-600 hover:!bg-green-700 !text-white !rounded-lg text-sm sm:text-base"
            >
              Exportar Excel
            </Button>
          </div>

          <div className="grid grid-cols-2 gap-2 w-full items-end">
            <MobileHtmlSelect
              label="Tipo"
              value={typeFilter}
              onChange={setTypeFilter}
              options={typeFilterSelectOptions}
              sheetTitle="Filtrar por tipo"
              triggerIcon="menu"
              selectClassName={POLLO_SELECT_DESKTOP_CLASS}
              buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
            />
            <MobileHtmlSelect
              label="Precio"
              value={priceFilter}
              onChange={setPriceFilter}
              options={priceFilterSelectOptions}
              sheetTitle="Filtrar por precio"
              triggerIcon="menu"
              selectClassName={POLLO_SELECT_DESKTOP_CLASS}
              buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
            />
          </div>

          {/* Mobile: listado como cards */}
          <div className="space-y-2">
            {displayedMoves && displayedMoves.length === 0 ? (
              <div className="text-sm text-gray-500">
                No hay movimientos en el rango para este producto.
              </div>
            ) : (
              (displayedMoves || []).map((m, idx) => {
                const price = Number(
                  salePrices[String((m as any).ref || "")] ??
                    (m as any).price ??
                    (m as any).unitPrice ??
                    0,
                );
                const total = price * Number(m.qtyOut || 0);
                const openIngreso =
                  m.type === "INGRESO" && m.ref
                    ? () => setIngresoBatchId(String(m.ref))
                    : undefined;
                const openMerma =
                  (m.type === "MERMA" || m.type === "ROBO") && m.ref
                    ? () => setMermaDrawerAdjId(String(m.ref))
                    : undefined;
                const cardInteractive = !!(openIngreso || openMerma);
                const handleCardActivate = () => {
                  if (openIngreso) openIngreso();
                  else if (openMerma) openMerma();
                };
                return (
                  <div
                    key={`${m.ref || idx}-${m.date}`}
                    role={cardInteractive ? "button" : undefined}
                    tabIndex={cardInteractive ? 0 : undefined}
                    onClick={cardInteractive ? handleCardActivate : undefined}
                    onKeyDown={
                      cardInteractive
                        ? (e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              handleCardActivate();
                            }
                          }
                        : undefined
                    }
                    className={`border rounded p-2 bg-white text-sm ${
                      openIngreso
                        ? "cursor-pointer hover:border-sky-300 hover:bg-sky-50/40"
                        : openMerma
                          ? "cursor-pointer hover:border-rose-200 hover:bg-rose-50/30"
                          : ""
                    }`}
                  >
                    <div className="flex justify-between items-start gap-2">
                      <div className="text-[11px] text-gray-500">{m.date}</div>
                      <PolloChip variant={tipoMoveChipVariant(String(m.type))}>
                        {m.type}
                      </PolloChip>
                    </div>
                    <div className="mt-1 text-sm text-gray-700">
                      {m.description}
                    </div>
                    <div className="mt-1 grid grid-cols-3 gap-1 text-sm">
                      <div>
                        <div className="text-[11px] text-gray-500">Entrada</div>
                        <div className="font-medium">{qty3(m.qtyIn)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-500">Salida</div>
                        <div className="font-medium">{qty3(m.qtyOut)}</div>
                      </div>
                      <div>
                        <div className="text-[11px] text-gray-500">Balance</div>
                        <div className="font-medium">
                          {qty3((m as any).balance)}
                        </div>
                      </div>
                    </div>
                    <div className="mt-1 flex justify-between items-center text-sm">
                      <div className="font-semibold text-black">
                        Precio: C$ {price.toFixed(2)}
                      </div>
                      <div className="font-semibold text-black">
                        Monto: C$ {total.toFixed(2)}
                      </div>
                    </div>
                    {(m.type === "MERMA" || m.type === "ROBO") &&
                    selected &&
                    m.ref ? (
                      <div
                        className="mt-2 space-y-2"
                        onClick={(e) => e.stopPropagation()}
                      >
                        <p className="text-[11px] text-rose-700/90">
                          Tocá la tarjeta para ver el detalle FIFO (drawer).
                        </p>
                        <Link
                          to={batchesHrefForMermaAdj(
                            String(m.ref),
                            (selected as { productId?: string }).productId,
                            adjFifoDetailById,
                            inventoryBatchesHref,
                          )}
                          className="inline-flex items-center rounded-full border border-green-600 bg-green-50 px-2.5 py-1 text-[10px] font-bold uppercase tracking-wide text-green-800 hover:bg-green-100"
                        >
                          Ver lotes (inventario)
                        </Link>
                      </div>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>
        </div>
      </div>

      {/* Desktop: producto + resumen */}
      <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 gap-4 mb-4">
        <div className="space-y-2 min-w-0">
          <label className="block text-sm text-gray-600 mb-1">
            Producto (solo con stock)
          </label>
          <input
            className="border border-slate-200 rounded-xl px-3 py-2 text-sm w-full min-w-0 shadow-sm"
            placeholder="Buscar para filtrar lista…"
            value={productFilterQuery}
            onChange={(e) => setProductFilterQuery(e.target.value)}
          />
          <div className="flex items-start gap-2">
            <div className="flex-1 min-w-0">
              <MobileHtmlSelect
                value={selectedKey}
                onChange={(v) => {
                  setSelectedKey(v);
                  setProductFilterQuery("");
                }}
                options={filteredProductSelectOptions}
                sheetTitle="Producto"
                triggerIcon="menu"
                selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
              />
            </div>
            {selectedKey ? (
              <Button
                type="button"
                aria-label="Limpiar producto"
                title="Limpiar producto"
                onClick={() => {
                  setSelectedKey("");
                  setProductFilterQuery("");
                }}
                variant="secondary"
                size="sm"
                className="!rounded-xl shrink-0 !px-3 !py-2"
              >
                Limpiar
              </Button>
            ) : null}
          </div>

          {!selectedKey ? (
            <div className="mt-1 text-xs text-red-600">
              Debés seleccionar un producto para ver el evolutivo.
            </div>
          ) : null}
        </div>

        <div className="text-sm text-gray-700 flex items-end">
          {selected ? (
            <Button
              type="button"
              onClick={() => {
                setSelectedKey("");
                setProductFilterQuery("");
              }}
              variant="outline"
              className="w-full !rounded-xl bg-white p-3 text-left !justify-start font-normal"
            >
              <div className="text-xs text-gray-500">
                Seleccionado (clic para limpiar)
              </div>
              <div className="font-semibold">{selected.productName}</div>
              <div className="text-xs text-gray-500">
                Medida:{" "}
                <b>{selected.measurement === "lb" ? "Lbs" : "Unidades"}</b> •
                Stock actual: <b>{qty3((selected as any).remaining)}</b>
              </div>
            </Button>
          ) : (
            <div className="w-full text-gray-500">
              Para ver el evolutivo tenés que seleccionar un producto.
            </div>
          )}
        </div>
      </div>

      {/* KPIs por producto */}
      {selected && (
        <div className="hidden sm:grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 mb-4">
          <KpiCard
            tone="sky"
            title={`${unitLabel} ingresadas (rango)`}
            value={qty3(productKpis.incoming)}
          />
          <KpiCard
            tone="amber"
            title={`${unitLabel} vendidas Cash (rango)`}
            value={qty3(productKpis.soldCash)}
          />
          <KpiCard
            tone="violet"
            title={`${unitLabel} vendidas Crédito (rango)`}
            value={qty3(productKpis.soldCredit)}
          />
          <KpiCard
            tone="indigo"
            title={`${unitLabel} vendidas (cash + crédito)`}
            value={qty3(soldCashPlusCredit)}
          />
          <KpiCard
            tone="emerald"
            title={`${unitLabel} existentes (stock actual)`}
            value={qty3(productKpis.remaining)}
          />
        </div>
      )}

      {/* movimientos manuales (botón + modal) */}
      {selected && (
        <>
          <div className="mb-4 hidden sm:flex gap-2 items-center">
            <Button
              type="button"
              onClick={() => setAdjModalOpen(true)}
              variant="primary"
              className="!rounded-lg text-sm sm:text-base"
            >
              Crear Movimiento
            </Button>

            <Button
              type="button"
              onClick={handleExportExcel}
              variant="primary"
              className="!bg-green-600 hover:!bg-green-700 !text-white !rounded-lg text-sm sm:text-base"
            >
              Exportar Excel
            </Button>

            <div className="grid grid-cols-2 gap-2 ml-0 sm:ml-2 min-w-0 w-full max-w-md shrink-0">
              <MobileHtmlSelect
                label="Tipo"
                value={typeFilter}
                onChange={setTypeFilter}
                options={typeFilterSelectOptions}
                sheetTitle="Filtrar por tipo"
                triggerIcon="menu"
                selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} min-w-0 w-full`}
                buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} min-w-0 w-full`}
              />

              <MobileHtmlSelect
                label="Precio"
                value={priceFilter}
                onChange={setPriceFilter}
                options={priceFilterSelectOptions}
                sheetTitle="Filtrar por precio"
                triggerIcon="menu"
                selectClassName={`${POLLO_SELECT_COMPACT_DESKTOP_CLASS} min-w-0 w-full`}
                buttonClassName={`${POLLO_SELECT_COMPACT_MOBILE_CLASS} min-w-0 w-full`}
              />
            </div>
          </div>

          {adjModalOpen && (
            <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center">
              <div
                className="absolute inset-0 bg-black opacity-40"
                onClick={() => setAdjModalOpen(false)}
              />

              <div className="relative bg-white rounded-t-2xl sm:rounded-2xl p-3 sm:p-4 z-10 w-full max-w-2xl h-[85vh] sm:h-auto shadow-lg overflow-auto text-sm">
                <div className="font-semibold mb-3">Crear Movimiento</div>

                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Fecha
                    </label>
                    <input
                      type="date"
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjDate}
                      onChange={(e) => setAdjDate(e.target.value)}
                    />
                  </div>

                  <div>
                    <MobileHtmlSelect
                      label="Tipo"
                      value={adjType}
                      onChange={(v) => setAdjType(v as AdjType)}
                      options={adjTypeSelectOptions}
                      sheetTitle="Tipo de ajuste"
                      triggerIcon="menu"
                      selectClassName={POLLO_SELECT_DESKTOP_CLASS}
                      buttonClassName={POLLO_SELECT_MOBILE_BUTTON_CLASS}
                    />
                  </div>

                  <div>
                    <label className="block text-sm text-gray-600 mb-1">
                      Cantidad ({unitLabel})
                    </label>
                    <input
                      type="number"
                      step="0.001"
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjQty}
                      onChange={(e) => setAdjQty(Number(e.target.value || 0))}
                    />
                  </div>

                  <div className="flex items-end">
                    <Button
                      type="button"
                      disabled={adjSaving}
                      onClick={async () => {
                        const ok = await saveAdjustment();
                        if (ok) setAdjModalOpen(false);
                      }}
                      variant="primary"
                      className="w-full !rounded-lg text-sm"
                    >
                      {adjSaving ? "Aplicando…" : "Guardar"}
                    </Button>
                  </div>

                  <div className="sm:col-span-2 lg:col-span-4">
                    <label className="block text-sm text-gray-600 mb-1">
                      Descripción
                    </label>
                    <input
                      className="border rounded px-3 py-2 w-full text-sm"
                      value={adjDesc}
                      onChange={(e) => setAdjDesc(e.target.value)}
                      placeholder="Ej: se dañó por temperatura / pérdida en traslado..."
                    />
                  </div>
                </div>

                <p className="mt-3 text-xs text-slate-600 leading-relaxed">
                  Al guardar se <strong>descuenta el stock en los lotes</strong>{" "}
                  (mismo criterio FIFO que una venta). En Firestore queda el
                  detalle en <code className="text-[11px]">fifoAllocations</code>{" "}
                  y <strong>cogsAmount</strong> = valor a costo de lo que sacaste
                  (lo que habías facturado al proveedor y aún no vendías). No
                  genera ingreso en caja.
                </p>

                <div className="mt-4 flex justify-end">
                  <Button
                    type="button"
                    onClick={() => setAdjModalOpen(false)}
                    variant="outline"
                    size="sm"
                    className="!rounded-md sm:!px-4 sm:!py-2 text-sm hover:!bg-gray-50"
                  >
                    Cancelar
                  </Button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* listado evolutivo */}
      {/* Desktop table (hidden on mobile) */}
      <div className="hidden sm:block sm:overflow-x-auto">
        <table className="min-w-full border text-sm">
          <thead className="bg-gray-100">
            <tr>
              <th className="border p-2">Fecha</th>
              <th className="border p-2">Tipo</th>
              <th className="border p-2">Descripción</th>
              <th className="border p-2">Entrada (+)</th>
              <th className="border p-2">Salida (−)</th>
              <th className="border p-2">Precio</th>
              <th className="border p-2">Monto</th>
              <th className="border p-2">Balance (rango)</th>
              <th className="border p-2">Inventario</th>
            </tr>
          </thead>
          <tbody>
            {!selected ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  Seleccioná un producto para ver su evolutivo.
                </td>
              </tr>
            ) : loading ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  Cargando movimientos…
                </td>
              </tr>
            ) : displayedMoves.length === 0 ? (
              <tr>
                <td colSpan={9} className="p-4 text-center text-gray-500">
                  No hay movimientos en el rango para este producto.
                </td>
              </tr>
            ) : (
              displayedMoves.map((m, idx) => (
                <React.Fragment key={`${m.ref || idx}-${m.date}`}>
                  <tr
                    className={`text-center ${
                      m.type === "INGRESO" && m.ref
                        ? "cursor-pointer hover:bg-sky-50/80"
                        : (m.type === "MERMA" || m.type === "ROBO") && m.ref
                          ? "cursor-pointer hover:bg-rose-50/35"
                          : ""
                    }`}
                    onClick={() => {
                      if (m.type === "INGRESO" && m.ref)
                        setIngresoBatchId(String(m.ref));
                      else if (
                        (m.type === "MERMA" || m.type === "ROBO") &&
                        m.ref
                      )
                        setMermaDrawerAdjId(String(m.ref));
                    }}
                  >
                    <td className="border p-1">{m.date}</td>
                    <td className="border p-1">
                      <div className="flex justify-center">
                        <PolloChip
                          variant={tipoMoveChipVariant(String(m.type))}
                        >
                          {m.type}
                        </PolloChip>
                      </div>
                    </td>
                    <td className="border p-1 text-left">{m.description}</td>
                    <td className="border p-1">
                      <span
                        className={
                          Number(m.qtyIn || 0) > 0
                            ? "text-green-600 font-semibold"
                            : "text-black"
                        }
                      >
                        {qty3(m.qtyIn)}
                      </span>
                    </td>
                    <td className="border p-1">
                      <span
                        className={
                          Number(m.qtyOut || 0) > 0
                            ? "text-red-600 font-semibold"
                            : "text-black"
                        }
                      >
                        {qty3(m.qtyOut)}
                      </span>
                    </td>
                    <td className="border p-1 font-semibold text-black">
                      {`C$ ${Number(
                        salePrices[String(m.ref || "")] ??
                          (m as any).price ??
                          (m as any).unitPrice ??
                          0,
                      ).toFixed(2)}`}
                    </td>
                    <td className="border p-1 font-semibold text-black">
                      {`C$ ${(
                        Number(
                          salePrices[String(m.ref || "")] ??
                            (m as any).price ??
                            (m as any).unitPrice ??
                            0,
                        ) * Number(m.qtyOut || 0)
                      ).toFixed(2)}`}
                    </td>
                    <td className="border p-1 font-semibold">
                      {qty3((m as any).balance)}
                    </td>
                    <td
                      className="border p-1"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {(m.type === "MERMA" || m.type === "ROBO") && m.ref ? (
                        <Link
                          to={batchesHrefForMermaAdj(
                            String(m.ref),
                            selected?.productId,
                            adjFifoDetailById,
                            inventoryBatchesHref,
                          )}
                          onClick={(e) => e.stopPropagation()}
                          className="inline-flex items-center rounded-full border border-green-600 bg-green-50 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide text-green-800 hover:bg-green-100 whitespace-nowrap"
                        >
                          Lotes
                        </Link>
                      ) : (
                        "—"
                      )}
                    </td>
                  </tr>
                </React.Fragment>
              ))
            )}
          </tbody>
        </table>
      </div>

      {/* Mobile: already rendered above inside card (sm:hidden) */}
      <SlideOverDrawer
        open={ingresoBatchId !== null}
        onClose={() => {
          setIngresoBatchId(null);
          setIngresoBatchRow(null);
        }}
        title="Detalle de lote (ingreso)"
        subtitle={ingresoBatchId || undefined}
        titleId="status-inv-ingreso-lote-title"
        panelMaxWidthClassName="max-w-lg"
      >
        {ingresoBatchLoading ? (
          <p className="text-sm text-gray-500">Cargando…</p>
        ) : !ingresoBatchRow ? (
          <p className="text-sm text-gray-500">
            No se encontró el lote o no hay permisos.
          </p>
        ) : (
          <DrawerDetailDlCard
            title={String(ingresoBatchRow.productName ?? "Lote")}
            rows={[
              {
                label: "Fecha",
                value: String(
                  ingresoBatchRow.date ??
                    ingresoBatchRow.batchDate ??
                    "—",
                ),
              },
              {
                label: "Producto",
                value: String(ingresoBatchRow.productName ?? "—"),
              },
              {
                label: "Cantidad",
                value: qty3(ingresoBatchRow.quantity),
              },
              {
                label: "Precio costo",
                value: `C$ ${Number(ingresoBatchRow.purchasePrice ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums",
              },
              {
                label: "Facturado",
                value: `C$ ${Number(ingresoBatchRow.invoiceTotal ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums font-semibold",
              },
              {
                label: "Precio venta",
                value: `C$ ${Number(ingresoBatchRow.salePrice ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums",
              },
              {
                label: "Esperado",
                value: `C$ ${Number(ingresoBatchRow.expectedTotal ?? 0).toFixed(2)}`,
                ddClassName: "tabular-nums text-emerald-900 font-semibold",
              },
              {
                label: "Utilidad bruta",
                value: `C$ ${Number(
                  ingresoBatchRow.utilidadBruta != null &&
                    Number.isFinite(Number(ingresoBatchRow.utilidadBruta))
                    ? Number(ingresoBatchRow.utilidadBruta)
                    : Number(ingresoBatchRow.expectedTotal ?? 0) -
                        Number(ingresoBatchRow.invoiceTotal ?? 0),
                ).toFixed(2)}`,
                ddClassName:
                  "tabular-nums text-violet-900 font-semibold",
              },
            ]}
          />
        )}
      </SlideOverDrawer>

      <SlideOverDrawer
        open={mermaDrawerAdjId !== null}
        onClose={() => setMermaDrawerAdjId(null)}
        title={mermaDrawerTitle}
        subtitle={
          selected
            ? `${selected.productName} · ${unitLabel}`
            : undefined
        }
        titleId="status-inv-merma-drawer-title"
        panelMaxWidthClassName="max-w-2xl"
        footer={
          <div className="flex flex-col gap-2 sm:flex-row sm:justify-end w-full">
            <Link
              to={mermaDrawerBatchesHref}
              onClick={() => setMermaDrawerAdjId(null)}
              className="inline-flex justify-center items-center rounded-xl border border-green-600 bg-green-50 px-4 py-2.5 text-sm font-semibold text-green-800 hover:bg-green-100"
            >
              Ir al lote (inventario)
            </Link>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="rounded-xl shadow-none"
              onClick={() => setMermaDrawerAdjId(null)}
            >
              Cerrar
            </Button>
          </div>
        }
      >
        {!mermaDrawerAdjId ? null : adjFifoLoadingId === mermaDrawerAdjId ? (
          <p className="text-sm text-gray-600">Cargando detalle FIFO…</p>
        ) : (() => {
            const det = adjFifoDetailById[mermaDrawerAdjId];
            if (!det) {
              return (
                <p className="text-sm text-gray-500">Sin datos aún.</p>
              );
            }
            if ("error" in det) {
              return (
                <p className="text-sm text-rose-700">{det.error}</p>
              );
            }
            return (
              <div className="space-y-4">
                <p className="text-xs text-slate-600 leading-relaxed">
                  Cada fila usa el <strong>precio de compra del lote</strong>{" "}
                  (lo facturado al proveedor en ese ingreso), no un promedio del
                  producto.
                </p>
                <div className="rounded-xl border border-rose-100 bg-rose-50/60 p-3 text-sm">
                  <div className="font-semibold text-rose-900">
                    Facturado a costo (Σ cantidad × precio costo del lote)
                  </div>
                  <div className="text-lg font-bold tabular-nums text-rose-950 mt-1">
                    C$ {det.cogsAmount.toFixed(2)}
                  </div>
                  <p className="text-[11px] text-rose-800/80 mt-1">
                    Coincide con el valor retirado del inventario (COGS de esta
                    merma).
                  </p>
                </div>
                <div className="overflow-x-auto rounded-lg border border-rose-200/80 bg-white">
                  <table className="min-w-full text-xs sm:text-sm">
                    <thead className="bg-rose-100/80 text-left">
                      <tr>
                        <th className="p-2 font-semibold">Nombre de lote</th>
                        <th className="p-2 font-semibold">Fecha</th>
                        <th className="p-2 font-semibold font-mono text-[10px]">
                          Id
                        </th>
                        <th className="p-2 font-semibold text-right">
                          Cantidad
                        </th>
                        <th className="p-2 font-semibold text-right">
                          P. costo lote
                        </th>
                        <th className="p-2 font-semibold text-right">
                          Facturado
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {det.fifoAllocations.length === 0 ? (
                        <tr>
                          <td colSpan={6} className="p-2 text-gray-500">
                            Sin líneas en fifoAllocations.
                          </td>
                        </tr>
                      ) : (
                        det.fifoAllocations.map((row, i) => {
                          const meta = adjBatchMetaById[row.batchId];
                          const lotTitle = meta
                            ? `${meta.orderName} · ${meta.productName}`
                            : row.batchId;
                          return (
                            <tr
                              key={`${row.batchId}-${i}`}
                              className="border-t border-rose-100"
                            >
                              <td className="p-2 text-gray-900 max-w-[10rem]">
                                <span
                                  className="line-clamp-2"
                                  title={lotTitle}
                                >
                                  {lotTitle}
                                </span>
                              </td>
                              <td className="p-2 tabular-nums whitespace-nowrap">
                                {meta?.date ?? "—"}
                              </td>
                              <td
                                className="p-2 font-mono text-[10px] text-slate-600 max-w-[5rem] truncate"
                                title={row.batchId}
                              >
                                {row.batchId}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                {qty3(row.qty)}
                              </td>
                              <td className="p-2 text-right tabular-nums">
                                C$ {row.unitCost.toFixed(4)}
                              </td>
                              <td className="p-2 text-right tabular-nums font-medium">
                                C$ {row.lineCost.toFixed(2)}
                              </td>
                            </tr>
                          );
                        })
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            );
          })()}
      </SlideOverDrawer>

      {toastMsg && (
        <Toast message={toastMsg} onClose={() => setToastMsg("")} />
      )}
    </div>
  );
}
